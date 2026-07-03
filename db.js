/*
 * db.js — реляционный data-layer поверх PostgREST (Фаза 1/2 модернизации,
 * см. СПЕКА-модернизация.md и supabase-setup.sql).
 *
 * В отличие от storage.js (снапшот-блоб, авторизуется анонимным ключом — RLS
 * там ни при чём, т.к. таблица snapshots ей не покрыта), здесь каждый запрос
 * идёт с JWT ТЕКУЩЕГО пользователя (Auth.ensureFreshSession()) — именно он
 * определяет auth.uid() на сервере и то, что RLS разрешит увидеть/изменить.
 * apikey остаётся анонимным (обязателен PostgREST-у), Authorization — уже
 * пользовательский Bearer-токен, не анонимный.
 *
 * Этот файл НЕ заменяет storage.js/sync.js прямо сейчас — они продолжают
 * обслуживать старую snapshot-модель, пока идёт постепенный переход
 * (см. план миграции, раздел 7 спеки). db.js встаёт рядом.
 */

const DB = (() => {
  function restUrl(path) { return `${CONFIG.SUPABASE_URL}/rest/v1/${path}`; }

  async function authHeaders(extra) {
    const session = await Auth.ensureFreshSession();
    if (!session) throw new Error("DB: нет активной сессии — нужен вход");
    return {
      apikey: CONFIG.SUPABASE_KEY,
      Authorization: `Bearer ${session.access_token}`,
      ...extra,
    };
  }

  async function throwHttpError(res, where) {
    let message = "";
    try { message = (await res.json())?.message || ""; }
    catch { try { message = await res.text(); } catch {} }
    throw new Error(`${where}: HTTP ${res.status}${message ? ` — ${message}` : ""}`);
  }

  // ---- низкоуровневые примитивы ------------------------------------------
  async function select(table, query = "") {
    const res = await fetch(restUrl(`${table}${query ? `?${query}` : ""}`), {
      method: "GET",
      headers: await authHeaders(),
      cache: "no-store",
    });
    if (!res.ok) await throwHttpError(res, `DB.select(${table})`);
    return res.json();
  }

  // Prefer: merge-duplicates => upsert по primary key/unique constraint.
  async function upsert(table, rows, { onConflict } = {}) {
    const res = await fetch(
      restUrl(`${table}${onConflict ? `?on_conflict=${onConflict}` : ""}`),
      {
        method: "POST",
        headers: await authHeaders({
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=representation",
        }),
        body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
      }
    );
    if (!res.ok) await throwHttpError(res, `DB.upsert(${table})`);
    return res.json();
  }

  async function patch(table, query, fields) {
    const res = await fetch(restUrl(`${table}?${query}`), {
      method: "PATCH",
      headers: await authHeaders({
        "Content-Type": "application/json",
        Prefer: "return=representation",
      }),
      body: JSON.stringify(fields),
    });
    if (!res.ok) await throwHttpError(res, `DB.patch(${table})`);
    return res.json();
  }

  async function remove(table, query) {
    const res = await fetch(restUrl(`${table}?${query}`), {
      method: "DELETE",
      headers: await authHeaders(),
    });
    if (!res.ok && res.status !== 404) await throwHttpError(res, `DB.remove(${table})`);
  }

  async function rpc(fn, args = {}) {
    const res = await fetch(restUrl(`rpc/${fn}`), {
      method: "POST",
      headers: await authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(args),
    });
    if (!res.ok) await throwHttpError(res, `DB.rpc(${fn})`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  const enc = encodeURIComponent;

  // ---- профиль и тренер/клиент --------------------------------------------
  // "Мой" профиль — строка profiles с auth_id текущей сессии.
  async function myProfile() {
    const uid = Auth.userId();
    if (!uid) return null;
    const rows = await select("profiles", `auth_id=eq.${enc(uid)}&select=*`);
    return rows?.[0] || null;
  }

  // Профиль по id (свой или клиента — RLS пустит только к разрешённым).
  async function getProfile(profileId) {
    const rows = await select("profiles", `id=eq.${enc(profileId)}&select=*`);
    return rows?.[0] || null;
  }

  // Клиенты тренера вместе с их профилями (PostgREST embed через FK).
  async function myClients() {
    const rows = await select(
      "trainer_clients",
      `select=status,client:profiles!trainer_clients_client_id_fkey(id,name,auth_id,created_at)&status=eq.active`
    );
    return rows.map(r => ({ ...r.client, status: r.status }));
  }

  async function createManagedClient(name) { return rpc("create_managed_client", { client_name: name }); }
  async function createInvite(claimProfileId, ttlDays) {
    return rpc("create_invite", { claim: claimProfileId || null, ttl_days: ttlDays ?? 14 });
  }
  async function claimInvite(code) { return rpc("claim_invite", { invite_code: code }); }

  // ---- тренировки ----------------------------------------------------------
  // Форма workout — 1:1 с локальным объектом DATA (см. bridge.js):
  //   { id, user_id, created_by, type, performed_at, data: {name, exercises, ...} }
  // id — ЛОКАЛЬНЫЙ идентификатор ("w_<Date.now()>"), не uuid — поэтому upsert
  // по нему идемпотентен: повторная отправка после реконнекта не плодит дубли.
  //
  // limit/before — постраничная подгрузка истории (раздел 1 спеки: не тянуть
  // всё разом). before — ISO-дата performed_at, для "загрузить ещё старее".
  async function listWorkouts(userId, { limit = 30, before } = {}) {
    let q = `user_id=eq.${enc(userId)}&select=*&order=performed_at.desc&limit=${limit}`;
    if (before) q += `&performed_at=lt.${enc(before)}`;
    return select("workouts", q);
  }
  async function getWorkout(id) {
    const rows = await select("workouts", `id=eq.${enc(id)}&select=*`);
    return rows?.[0] || null;
  }
  async function saveWorkout(row) {
    const rows = await upsert("workouts", row, { onConflict: "id" });
    return rows?.[0] || row;
  }
  // Массовый upsert — для редких операций над всей историей разом (undo,
  // переименование тренировок, привязанных к шаблону; см. bridge.js).
  async function saveWorkouts(rows) {
    if (!rows.length) return [];
    return upsert("workouts", rows, { onConflict: "id" });
  }
  async function deleteWorkout(id) { return remove("workouts", `id=eq.${enc(id)}`); }

  // ---- «мелкое» состояние пользователя (упражнения/шаблоны/категории) ------
  // Один блоб на профиль — ровно как в localStorage: DATA всегда читает и
  // пишет эти вещи целым массивом/объектом, построчный CRUD тут не нужен и не
  // растёт по годам (в отличие от workouts). См. таблицу user_data.
  async function getUserData(userId) {
    const rows = await select("user_data", `user_id=eq.${enc(userId)}&select=*`);
    return rows?.[0] || null;
  }
  async function saveUserData(userId, patch) {
    const rows = await upsert(
      "user_data",
      { user_id: userId, ...patch, updated_at: new Date().toISOString() },
      { onConflict: "user_id" }
    );
    return rows?.[0] || patch;
  }

  // ---- рекорды (серверная истина — представление exercise_records) --------
  async function exerciseRecords(userId) {
    return select("exercise_records", `user_id=eq.${enc(userId)}&select=*`);
  }

  // Удалить СВОЙ профиль (self-service). RLS profiles_delete разрешает удалить
  // только строку с id = current_profile_id() — чужой/управляемый профиль
  // отсюда не удалить. Каскадом (FK on delete cascade) уходят workouts,
  // user_data, trainer_clients этого профиля. Если это профиль тренера,
  // который вносил тренировки СВОИМ клиентам (workouts.created_by), Postgres
  // откажет с ошибкой внешнего ключа — намеренно, это защита от случайного
  // "осиротения" чужой истории, а не то, что стоит обходить здесь.
  async function deleteMyAccount() {
    const me = await myProfile();
    if (!me) throw new Error("Нет профиля для удаления");
    return remove("profiles", `id=eq.${enc(me.id)}`);
  }

  return {
    myProfile, getProfile, myClients, createManagedClient, createInvite, claimInvite,
    listWorkouts, getWorkout, saveWorkout, saveWorkouts, deleteWorkout,
    getUserData, saveUserData,
    exerciseRecords, deleteMyAccount,
  };
})();
