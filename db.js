/*
 * db.js — реляционный data-layer поверх PostgREST (Фаза 1/2 модернизации,
 * см. СПЕКА-модернизация.md и supabase-setup.sql).
 *
 * Каждый запрос идёт с JWT ТЕКУЩЕГО пользователя
 * (Auth.ensureFreshSession()) — именно он
 * определяет auth.uid() на сервере и то, что RLS разрешит увидеть/изменить.
 * apikey остаётся анонимным (обязателен PostgREST-у), Authorization — уже
 * пользовательский Bearer-токен, не анонимный.
 */

const DB = (() => {
  const REQUEST_TIMEOUT_MS = 15_000;
  function restUrl(path) { return `${CONFIG.SUPABASE_URL}/rest/v1/${path}`; }

  // navigator.onLine показывает лишь наличие сети, но не доступность Supabase
  // (особенно заметно без VPN). Ограничиваем каждый запрос реальным таймаутом,
  // чтобы синхронизация не могла навсегда остаться в состоянии «выполняется».
  async function request(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (e) {
      if (controller.signal.aborted) {
        throw new Error("Сервер не ответил за 15 секунд");
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function authHeaders(extra, expectedAccount) {
    const session = await Auth.ensureFreshSession();
    if (!session) throw new Error("DB: нет активной сессии — нужен вход");
    if (expectedAccount && (session.user?.id !== expectedAccount || Auth.userId() !== expectedAccount)) {
      const error = new Error("DB: аккаунт изменился, отправка остановлена");
      error.code = "ACCOUNT_CHANGED";
      throw error;
    }
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
  async function select(table, query = "", expectedAccount) {
    const res = await request(restUrl(`${table}${query ? `?${query}` : ""}`), {
      method: "GET",
      headers: await authHeaders(undefined, expectedAccount),
      cache: "no-store",
    });
    if (!res.ok) await throwHttpError(res, `DB.select(${table})`);
    return res.json();
  }

  // Prefer: merge-duplicates => upsert по primary key/unique constraint.
  async function upsert(table, rows, { onConflict, expectedAccount } = {}) {
    const res = await request(
      restUrl(`${table}${onConflict ? `?on_conflict=${onConflict}` : ""}`),
      {
        method: "POST",
        headers: await authHeaders({
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=representation",
        }, expectedAccount),
        body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
      }
    );
    if (!res.ok) await throwHttpError(res, `DB.upsert(${table})`);
    return res.json();
  }

  async function patch(table, query, fields) {
    const res = await request(restUrl(`${table}?${query}`), {
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

  async function remove(table, query, { expectedAccount } = {}) {
    const res = await request(restUrl(`${table}?${query}`), {
      method: "DELETE",
      headers: await authHeaders(undefined, expectedAccount),
    });
    if (!res.ok && res.status !== 404) await throwHttpError(res, `DB.remove(${table})`);
  }

  async function rpc(fn, args = {}, expectedAccount) {
    const res = await request(restUrl(`rpc/${fn}`), {
      method: "POST",
      headers: await authHeaders({ "Content-Type": "application/json" }, expectedAccount),
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
  // профиль. Белый список здесь — дополнительная защита от случайной отправки
  // системных полей; серверные права на колонки остаются обязательной защитой.
  const PROFILE_EDITABLE_FIELDS = new Set(["name", "last_name", "age", "weight", "height"]);
  async function updateProfile(profileId, fields) {
    const safeFields = Object.fromEntries(
      Object.entries(fields || {}).filter(([key]) => PROFILE_EDITABLE_FIELDS.has(key))
    );
    if (!Object.keys(safeFields).length) throw new Error("DB.updateProfile: нет разрешённых полей для сохранения");
    const rows = await patch("profiles", `id=eq.${enc(profileId)}`, safeFields);
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
  async function claimInvite(code, expectedAccount = Auth.userId()) {
    const result=await rpc("claim_invite", { invite_code: code }, expectedAccount);
    // The deployed SQL contract returns void. Confirm the resulting profile
    // with the same account instead of rejecting a successfully applied invite.
    if (result === null) {
      const rows = await select("profiles", `auth_id=eq.${enc(expectedAccount)}&select=id,auth_id`, expectedAccount);
      if (Auth.userId() !== expectedAccount) throw Error("Аккаунт изменился после применения приглашения");
      if (rows.length !== 1 || rows[0].auth_id !== expectedAccount || !rows[0].id) {
        throw Error("Сервер не подтвердил профиль приглашения");
      }
      return rows[0].id;
    }
    if(typeof result!=="string"||!result)throw Error("Сервер не подтвердил профиль приглашения");
    return result;
  }

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
  async function saveWorkout(row, { expectedAccount } = {}) {
    const rows = await upsert("workouts", row, { onConflict: "id", expectedAccount });
    return rows?.[0] || row;
  }
  // Массовый upsert — для редких операций над всей историей разом (undo,
  // переименование тренировок, привязанных к шаблону; см. bridge.js).
  async function saveWorkouts(rows) {
    if (!rows.length) return [];
    return upsert("workouts", rows, { onConflict: "id" });
  }
  async function deleteWorkout(id, options) { return remove("workouts", `id=eq.${enc(id)}`, options); }

  // ---- «мелкое» состояние пользователя (упражнения/шаблоны/категории) ------
  // Один блоб на профиль — ровно как в localStorage: DATA всегда читает и
  // пишет эти вещи целым массивом/объектом, построчный CRUD тут не нужен и не
  // растёт по годам (в отличие от workouts). См. таблицу user_data.
  async function getUserData(userId) {
    const rows = await select("user_data", `user_id=eq.${enc(userId)}&select=*`);
    return rows?.[0] || null;
  }
  async function saveUserData(userId, patch, { expectedAccount } = {}) {
    const rows = await upsert(
      "user_data",
      { user_id: userId, ...patch, updated_at: new Date().toISOString() },
      { onConflict: "user_id", expectedAccount }
    );
    return rows?.[0] || patch;
  }

  // ---- пер-сущностное «мелкое» состояние (supabase-relational.sql) ---------
  // Каждая сущность — своя строка со своим updated_at и надгробием (deleted).
  // Ключ конфликта для upsert зависит от таблицы (составной PK). updated_at
  // проставляет СЕРВЕР (триггер) — сюда его не шлём.
  const ENTITY_CONFLICT = {
    user_exercises:       "user_id,id",
    user_templates:       "user_id,id",
    user_exercise_groups: "user_id,id",
    user_categories:      "user_id,name",
    user_hidden:          "user_id,kind,ref_id",
    user_muscles:         "user_id,id",
    user_movements:       "user_id,id",
    user_ordering:        "user_id",
  };

  // Полное чтение небольших справочников, включая надгробия. updated_at не
  // является commit-курсором: поздний COMMIT может иметь старое время.
  // Страницы идут по неизменяемому PK, а не по позиции/времени. Старый третий
  // аргумент намеренно игнорируется, чтобы восстановить пропущенные записи.
  async function pullEntities(table, userId) {
    if (table !== "workouts" && !Object.hasOwn(ENTITY_CONFLICT, table)) throw new Error("DB.pullEntities: неизвестная таблица " + table);
    const keys = (table === "workouts" ? "user_id,id" : ENTITY_CONFLICT[table]).split(",").filter(k => k !== "user_id");
    const order = (keys.length ? keys : ["user_id"]).map(k => `${k}.asc`).join(",");
    const quote = value => '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    const rows = [], seen = new Set();
    let last = null;
    // Ограничение защищает от бесконечного потока новых записей/ошибки API.
    for (let page = 0; page < 1000; page++) {
      let q = `user_id=eq.${enc(userId)}&select=*&order=${order}&limit=500`;
      if (last) {
        const terms = keys.map((key, i) => {
          const predicates = keys.slice(0, i).map(k => `${k}.eq.${quote(last[k])}`);
          predicates.push(`${key}.gt.${quote(last[key])}`);
          return predicates.length === 1 ? predicates[0] : `and(${predicates.join(",")})`;
        });
        q += `&or=${enc(`(${terms.join(",")})`)}`;
      }
      const batch = await select(table, q);
      if (!Array.isArray(batch)) throw new Error(`DB.pullEntities(${table}): неверный ответ`);
      if (!batch.length) return rows;
      for (const row of batch) {
        if (row.user_id !== userId || keys.some(k => row[k] == null)) throw new Error(`DB.pullEntities(${table}): неверный ключ строки`);
        const key = JSON.stringify(keys.map(k => row[k]));
        if (seen.has(key)) throw new Error(`DB.pullEntities(${table}): повтор страницы`);
        seen.add(key);
        rows.push(row);
      }
      if (!keys.length) return rows;
      last = batch[batch.length - 1];
      // Даже короткая страница не означает конец: лимит сервера может быть
      // меньше запрошенных 500. Завершаем только по пустому ответу.
    }
    throw new Error(`DB.pullEntities(${table}): слишком много страниц, повторите синхронизацию`);
  }

  // Пачечный upsert строк-сущностей. Идемпотентно по составному ключу —
  // повторная отправка после реконнекта не плодит дубли. Возвращает строки с
  // серверным updated_at (нужно клиенту, чтобы обновить локальный водяной знак).
  async function pushEntities(table, rows, { expectedAccount } = {}) {
    if (!Array.isArray(rows) || !rows.length) return [];
    const onConflict = ENTITY_CONFLICT[table];
    if (!onConflict) throw new Error("DB.pushEntities: неизвестная таблица " + table);
    return upsert(table, rows, { onConflict, expectedAccount });
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

  // Transactional server RPC deletes Auth + profile, never profile-only fallback.
  // Requires the separately reviewed delete-own-account.sql deployment patch.
  async function deleteMyAccount(profileId, expectedAccount = Auth.userId()) {
    if(!profileId||!expectedAccount)throw Error("Не подтверждена цель удаления");
    const result=await rpc("delete_my_account",{expected_profile:profileId},expectedAccount);
    if(result?.deleted!==true||result.auth_id!==expectedAccount||result.profile_id!==profileId)throw Error("Сервер не подтвердил полное удаление аккаунта");
    return result;
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
  async function deleteManagedClient(profileId, expectedAccount = Auth.userId()) {
    if(!profileId||!expectedAccount)throw Error("Не подтверждена цель удаления");
    const res = await request(restUrl(`profiles?id=eq.${enc(profileId)}`), {
      method: "DELETE",
      headers: await authHeaders({ Prefer: "return=representation" }, expectedAccount),
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
    pullEntities, pushEntities,
    exerciseRecords, deleteMyAccount, deleteManagedClient,
    getAtlas,
    saveAtlasGroups, saveAtlasMuscles, saveAtlasMovements, saveAtlasLinks, saveAtlasExercises,
    deleteAtlasGroup, deleteAtlasMuscle, deleteAtlasMovement, deleteAtlasLink, deleteAtlasExercise,
    deleteAtlasLinksByMuscle, deleteAtlasLinksByMovement,
  };
})();
