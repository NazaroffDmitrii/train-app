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

  // Личные данные (Настройки → «Личные данные»). RLS та же, что и на весь
  // профиль (profiles_update: свой или клиента) — трогать роль/auth_id отсюда
  // не даём (fields — только name/last_name/age/weight/height, см. auth-ui.js).
  async function updateProfile(profileId, fields) {
    const rows = await patch("profiles", `id=eq.${enc(profileId)}`, fields);
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

  // Есть ли у меня (как у клиента) хотя бы одна активная связь с тренером —
  // нужно решить, показывать ли «Ввести код приглашения»: свежезарегистри-
  // рованному незалинкованному клиенту кнопка нужна, уже привязанному — уже
  // ничего не даст (см. auth-ui.js refreshEnterInviteButton).
  async function hasAnyTrainer(myProfileId) {
    const rows = await select("trainer_clients", `client_id=eq.${enc(myProfileId)}&status=eq.active&select=trainer_id&limit=1`);
    return rows.length > 0;
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

  // ---- справочник «Атлас» (общая база: RLS read=all, write=is_admin) --------
  // Пять таблиц читаются разом и склеиваются приложением в объект-справочник
  // (см. app.js: atlasRowsToSeed → DATA.setAtlas). Порядок — по position, его
  // правит администратор перетаскиванием. Личный оверлей пользователя
  // (own_*/hidden_* в user_data) сюда НЕ входит — он мержится на стороне app.js.
  async function getAtlas() {
    const [groups, muscles, movements, links, exercises] = await Promise.all([
      select("atlas_groups",           "select=*&order=position.asc"),
      select("atlas_muscles",          "select=*&order=position.asc"),
      select("atlas_movements",        "select=*&order=position.asc"),
      select("atlas_muscle_movements", "select=*"),
      select("atlas_exercises",        "select=*&order=position.asc"),
    ]);
    return { groups, muscles, movements, links, exercises };
  }

  // Запись справочника — пройдёт только у админа (RLS atlas_*_write = is_admin()).
  // Идемпотентный upsert по id; массовый вариант нужен для сохранения порядка
  // (перезапись колонки position у пачки строк разом).
  function saveAtlasGroups(rows)    { return upsert("atlas_groups",           rows, { onConflict: "id" }); }
  function saveAtlasMuscles(rows)   { return upsert("atlas_muscles",          rows, { onConflict: "id" }); }
  function saveAtlasMovements(rows) { return upsert("atlas_movements",        rows, { onConflict: "id" }); }
  function saveAtlasLinks(rows)     { return upsert("atlas_muscle_movements", rows, { onConflict: "id" }); }
  function saveAtlasExercises(rows) { return upsert("atlas_exercises",        rows, { onConflict: "id" }); }
  function deleteAtlasGroup(id)     { return remove("atlas_groups",           `id=eq.${enc(id)}`); }
  function deleteAtlasMuscle(id)    { return remove("atlas_muscles",          `id=eq.${enc(id)}`); }
  function deleteAtlasMovement(id)  { return remove("atlas_movements",        `id=eq.${enc(id)}`); }
  function deleteAtlasLink(id)      { return remove("atlas_muscle_movements", `id=eq.${enc(id)}`); }
  function deleteAtlasExercise(id)  { return remove("atlas_exercises",        `id=eq.${enc(id)}`); }
  // Удалить все связи мышцы/движения (перед их удалением или при перепривязке).
  function deleteAtlasLinksByMuscle(muscleId)     { return remove("atlas_muscle_movements", `muscle_id=eq.${enc(muscleId)}`); }
  function deleteAtlasLinksByMovement(movementId) { return remove("atlas_muscle_movements", `movement_id=eq.${enc(movementId)}`); }

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
    // return=representation + проверка непустого ответа — чтобы не показать
    // ложное «аккаунт удалён», если RLS/FK по какой-то причине не дали удалить
    // (RLS-блок в PostgREST не бросает ошибку сам по себе, см. deleteManagedClient).
    const res = await fetch(restUrl(`profiles?id=eq.${enc(me.id)}`), {
      method: "DELETE",
      headers: await authHeaders({ Prefer: "return=representation" }),
    });
    if (!res.ok) await throwHttpError(res, "DB.deleteMyAccount");
    const rows = await res.json().catch(() => []);
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error("не удалось удалить профиль (нет прав или он связан с чужими данными)");
    }
    return rows[0];
  }

  // Удалить УПРАВЛЯЕМОГО клиента (без логина) — RLS profiles_delete пропустит
  // только если это профиль с auth_id is null И я его тренер. Клиента с
  // собственным логином так не удалить — это защита.
  //
  // ВАЖНО: RLS-блокировка DELETE в PostgREST — это НЕ ошибка (возвращается
  // 204/пустой ответ, «удалено 0 строк»), поэтому обычный remove() решил бы,
  // что всё ок, хотя ничего не удалилось. Просим return=representation и
  // проверяем, что строка реально вернулась — иначе явно сообщаем о неудаче
  // (частый случай: не прогнан SQL-патч policy profiles_delete).
  async function deleteManagedClient(profileId) {
    const res = await fetch(restUrl(`profiles?id=eq.${enc(profileId)}`), {
      method: "DELETE",
      headers: await authHeaders({ Prefer: "return=representation" }),
    });
    if (!res.ok) await throwHttpError(res, "DB.deleteManagedClient");
    const rows = await res.json().catch(() => []);
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error("нет прав на удаление или профиль уже удалён (проверьте, применён ли SQL-патч policy profiles_delete)");
    }
    return rows[0];
  }

  return {
    myProfile, getProfile, updateProfile, myClients, hasAnyTrainer, createManagedClient, createInvite, claimInvite,
    listWorkouts, getWorkout, saveWorkout, saveWorkouts, deleteWorkout,
    getUserData, saveUserData,
    exerciseRecords, deleteMyAccount, deleteManagedClient,
    getAtlas,
    saveAtlasGroups, saveAtlasMuscles, saveAtlasMovements, saveAtlasLinks, saveAtlasExercises,
    deleteAtlasGroup, deleteAtlasMuscle, deleteAtlasMovement, deleteAtlasLink, deleteAtlasExercise,
    deleteAtlasLinksByMuscle, deleteAtlasLinksByMovement,
  };
})();
