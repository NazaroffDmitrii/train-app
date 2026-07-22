/*
 * syncengine.js — пер-сущностная синхронизация (Фаза 3 модернизации).
 *
 * Заменяет прежнюю модель «один блоб user_data, последний победил» на слияние
 * ПО СТРОКЕ (supabase-relational.sql). Каждый локальный список DATA
 * (упражнения/шаблоны/группы/категории/скрытые/оверлей/порядок) отображается на
 * свою таблицу-сущность. Правки разного больше не затирают друг друга: победа
 * определяется серверным updated_at по каждой строке; удаление едет надгробием
 * (deleted=true) и не воскресает.
 *
 * Двусторонний обмен:
 *   PUSH  — diffAndEnqueue(): сравнить текущее локальное состояние с «тенью»
 *           (shadow — что уже отражено в облаке), поставить в durable-очередь
 *           (outbox.js) ТОЛЬКО изменившиеся строки и надгробия для исчезнувших.
 *           Отправка — Outbox.flush() (устойчива к оффлайну/битым операциям).
 *   PULL  — applyPull(): затянуть строки, изменённые с прошлой синхронизации
 *           (водяной знак cursor), слить в локальные списки (пришедшая строка
 *           новее — она и побеждает; надгробие — удаляет), сдвинуть cursor.
 *
 * Источник истины во время работы — локальный DATA (local-first). В облако
 * уходит и по кнопке, и автоматически (открытие/сеть/после правок). Никаких
 * молчаливых потерь: очередь durable, ошибки видны в статусе (Outbox.stats()).
 *
 * Важно: НЕ трогает workouts — те уже пер-строчные (bridge.js/DB.saveWorkout).
 * Здесь — только «мелкое» состояние, что раньше жило в блобе user_data.
 */
"use strict";

const SyncEngine = (() => {
  const CURSOR_KEY = uid => `train_sync_cursor_${uid}`;   // ISO-водяной знак пула
  const SHADOW_KEY = uid => `train_sync_shadow_${uid}`;   // { table: { key: hash } }
  const SYNCED_AT  = uid => `train_last_synced_at_${uid}`;
  const MIGRATED   = uid => `train_relational_migrated_${uid}`; // устройство перешло на пер-сущностную модель

  /* ----- утилиты ----- */
  // Канонический вид: ключи объектов отсортированы на ВСЕХ уровнях (иначе разный
  // порядок ключей в jsonb/локальном объекте дал бы разный отпечаток).
  function canonical(v) {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
      return out;
    }
    return v;
  }
  // Детерминированный отпечаток строки, ЧУВСТВИТЕЛЬНЫЙ к вложенным полям (data).
  // Прежняя версия через массив-replacer вырезала вложенные ключи — правки
  // внутри упражнения/шаблона не детектировались и не уходили в облако.
  function stableHash(row) {
    return JSON.stringify(canonical(row));
  }
  function omit(obj, keys) {
    const out = {}; for (const k in obj) if (!keys.includes(k)) out[k] = obj[k]; return out;
  }
  function loadShadow(uid) { try { return JSON.parse(localStorage.getItem(SHADOW_KEY(uid))) || {}; } catch { return {}; } }
  function saveShadow(uid, s) { try { localStorage.setItem(SHADOW_KEY(uid), JSON.stringify(s)); } catch {} }
  function getCursor(uid) { return localStorage.getItem(CURSOR_KEY(uid)) || ""; }
  function setCursor(uid, iso) { if (iso) { try { localStorage.setItem(CURSOR_KEY(uid), iso); } catch {} } }
  function markSyncedNow(uid) { try { localStorage.setItem(SYNCED_AT(uid), String(Date.now())); } catch {} }
  function lastSyncedAt(uid) { const v = Number(localStorage.getItem(SYNCED_AT(uid))); return v > 0 ? v : null; }
  // Сбросить локальный слепок синхронизации — следующий diff сочтёт всё новым
  // (после импорта/починки/публикации). Cursor тоже, чтобы пул пришёл заново.
  function resetShadow(uid) { try { localStorage.removeItem(SHADOW_KEY(uid)); localStorage.removeItem(CURSOR_KEY(uid)); } catch {} }

  /* ----- дескрипторы: как список DATA ⇄ строки таблицы -----
     Каждый дескриптор умеет:
       collect(uid) -> строки в ФОРМЕ БД (то, что кладём в облако);
       key(row)     -> идентификатор строки в рамках таблицы;
       rebuild(uid, rows) -> собрать локальные списки DATA из НЕудалённых строк;
       tombstone(uid, key) -> минимальная строка-надгробие по ключу.
     ФОРМА БД и локальная форма согласованы: collect и rebuild — обратны друг
     другу, а пришедшие из облака строки имеют ту же форму, что и collect. */
  function bySortPos(a, b) { return (a.position ?? 0) - (b.position ?? 0); }

  const DESCRIPTORS = [
    {
      table: "user_exercises",
      collect: uid => DATA.getOwnExercises(uid).map((ex, i) => ({ user_id: uid, id: ex.id, data: omit(ex, ["id"]), position: i, deleted: false })),
      key: r => r.id,
      rebuild: (uid, rows) => DATA_saveOwn(uid, "saveOwnExercises", rows.filter(r => !r.deleted).sort(bySortPos).map(r => ({ id: r.id, ...(r.data || {}) }))),
      tombstone: (uid, id) => ({ user_id: uid, id, deleted: true }),
    },
    {
      table: "user_templates",
      collect: uid => DATA.getTemplates(uid).map((t, i) => ({ user_id: uid, id: t.id, data: omit(t, ["id"]), position: i, deleted: false })),
      key: r => r.id,
      rebuild: (uid, rows) => DATA_saveOwn(uid, "saveTemplates", rows.filter(r => !r.deleted).sort(bySortPos).map(r => ({ id: r.id, ...(r.data || {}) }))),
      tombstone: (uid, id) => ({ user_id: uid, id, deleted: true }),
    },
    {
      table: "user_exercise_groups",
      collect: uid => DATA.getExerciseGroups(uid).map((g, i) => ({ user_id: uid, id: g.id, data: omit(g, ["id"]), position: i, deleted: false })),
      key: r => r.id,
      rebuild: (uid, rows) => DATA_saveOwn(uid, "saveExerciseGroups", rows.filter(r => !r.deleted).sort(bySortPos).map(r => ({ id: r.id, ...(r.data || {}) }))),
      tombstone: (uid, id) => ({ user_id: uid, id, deleted: true }),
    },
    {
      table: "user_categories",
      collect: uid => {
        const colors = DATA.getCategoryColors(uid) || {};
        return DATA.getAllCategories(uid).map((name, i) => ({ user_id: uid, name, color: colors[name] ?? null, position: i, deleted: false }));
      },
      key: r => r.name,
      rebuild: (uid, rows) => {
        const live = rows.filter(r => !r.deleted).sort(bySortPos);
        DATA_saveOwn(uid, "saveAllCategories", live.map(r => r.name));
        const colors = {}; live.forEach(r => { if (r.color) colors[r.name] = r.color; });
        DATA_saveOwn(uid, "saveCategoryColors", colors);
      },
      tombstone: (uid, name) => ({ user_id: uid, name, deleted: true }),
    },
    {
      table: "user_muscles",
      collect: uid => DATA.getOwnMuscles(uid).map((m, i) => ({ user_id: uid, id: m.id, data: omit(m, ["id"]), position: i, deleted: false })),
      key: r => r.id,
      rebuild: (uid, rows) => DATA_saveOwn(uid, "saveOwnMuscles", rows.filter(r => !r.deleted).sort(bySortPos).map(r => ({ id: r.id, ...(r.data || {}) }))),
      tombstone: (uid, id) => ({ user_id: uid, id, deleted: true }),
    },
    {
      table: "user_movements",
      collect: uid => DATA.getOwnMovements(uid).map((m, i) => ({ user_id: uid, id: m.id, data: omit(m, ["id"]), position: i, deleted: false })),
      key: r => r.id,
      rebuild: (uid, rows) => DATA_saveOwn(uid, "saveOwnMovements", rows.filter(r => !r.deleted).sort(bySortPos).map(r => ({ id: r.id, ...(r.data || {}) }))),
      tombstone: (uid, id) => ({ user_id: uid, id, deleted: true }),
    },
    {
      // Скрытые базовые сущности всех трёх видов — одна таблица user_hidden.
      table: "user_hidden",
      collect: uid => [
        ...DATA.getHiddenIds(uid).map(ref => ({ user_id: uid, kind: "exercise", ref_id: ref, deleted: false })),
        ...DATA.getHiddenMuscleIds(uid).map(ref => ({ user_id: uid, kind: "muscle", ref_id: ref, deleted: false })),
        ...DATA.getHiddenMovementIds(uid).map(ref => ({ user_id: uid, kind: "movement", ref_id: ref, deleted: false })),
      ],
      key: r => r.kind + ":" + r.ref_id,
      rebuild: (uid, rows) => {
        const live = rows.filter(r => !r.deleted);
        DATA_saveOwn(uid, "saveHiddenIds",         live.filter(r => r.kind === "exercise").map(r => r.ref_id));
        DATA_saveOwn(uid, "saveHiddenMuscleIds",   live.filter(r => r.kind === "muscle").map(r => r.ref_id));
        DATA_saveOwn(uid, "saveHiddenMovementIds", live.filter(r => r.kind === "movement").map(r => r.ref_id));
      },
      tombstone: (uid, key) => { const [kind, ...rest] = key.split(":"); return { user_id: uid, kind, ref_id: rest.join(":"), deleted: true }; },
    },
    {
      // Порядок общего списка — единственная строка на профиль (без надгробий).
      table: "user_ordering",
      collect: uid => { const o = DATA.getExerciseOrder(uid); return o == null ? [] : [{ user_id: uid, ordered_ids: o }]; },
      key: () => "ordering",
      rebuild: (uid, rows) => { if (rows.length && rows[0].ordered_ids !== undefined) DATA_saveOwn(uid, "saveExerciseOrder", rows[0].ordered_ids); },
      tombstone: null, // единственная строка — не удаляем
    },
  ];
  const DESC_BY_TABLE = new Map(DESCRIPTORS.map(d => [d.table, d]));

  // Писать в локальный DATA НАПРЯМУЮ через оригинальный (не обёрнутый мостом)
  // setter — чтобы восстановление из облака не запускало новый push обратно.
  // Bridge регистрирует эти оригиналы в window.__origSetters (см. bridge.js).
  function DATA_saveOwn(uid, setterName, value) {
    const orig = (window.__origSetters && window.__origSetters[setterName]) || DATA[setterName].bind(DATA);
    orig(uid, value);
  }

  function isMigrated(uid) { return !!localStorage.getItem(MIGRATED(uid)); }

  /* ----- PUSH: локальные изменения → очередь ----- */
  // Возвращает число поставленных операций. Идемпотентно: неизменившиеся строки
  // не ставятся повторно (сверка с тенью). Тень = слепок того, что уже в облаке
  // (или уже поставлено в очередь) — обновляется здесь же.
  //
  // ГЕЙТ МИГРАЦИИ (фаза 5, защита от утечки сидов): пока устройство не
  // мигрировало (не переняло облако и не опубликовало явно через publishAll) —
  // НЕ пушим ничего. Иначе локально засеянные дефолты (категории-витрины и т.п.)
  // или устаревшее состояние уехали бы в облако как «правки пользователя» и, в
  // частности, воскресили бы удалённое. force=true — только для publishAll.
  function diffAndEnqueue(uid, { force = false } = {}) {
    if (!uid) return 0;
    if (!force && !isMigrated(uid)) return 0;
    const shadow = loadShadow(uid);
    let queued = 0;
    for (const d of DESCRIPTORS) {
      const rows = d.collect(uid);
      const cur = new Map(rows.map(r => [String(d.key(r)), r]));
      const prev = shadow[d.table] || {};
      const next = {};
      // upsert новых/изменившихся
      for (const [k, r] of cur) {
        const h = stableHash(r);
        next[k] = h;
        if (prev[k] !== h) { Outbox.enqueueEntity(d.table, uid + "|" + k, r); queued++; }
      }
      // надгробия для исчезнувших
      if (d.tombstone) {
        for (const k of Object.keys(prev)) {
          if (!cur.has(k)) { Outbox.enqueueEntity(d.table, uid + "|" + k, d.tombstone(uid, k)); queued++; }
        }
      }
      shadow[d.table] = next; // тень = текущее локальное (исчезнувшие ключи выпали)
    }
    saveShadow(uid, shadow);
    return queued;
  }

  /* ----- PULL: облако → локальные списки (слияние по строкам) -----
     authoritative=true — «жёсткое перенятие»: локальное состояние ПОЛНОСТЬЮ
     замещается облачным (используется только при первичной миграции устройства,
     чтобы не тащить наверх местный мусор). В обычном режиме (false) — слияние:
     локальное сохраняется, пришедшие строки новее cursor побеждают по ключу. */
  async function applyPull(uid, { authoritative = false } = {}) {
    if (!uid) return;
    const cursor = authoritative ? "" : getCursor(uid);   // authoritative тянет всё
    let maxTs = getCursor(uid);
    const shadow = loadShadow(uid);
    for (const d of DESCRIPTORS) {
      let incoming;
      try { incoming = await DB.pullEntities(d.table, uid, cursor); }
      catch (e) { throw new Error(`pull ${d.table}: ${e.message || e}`); }
      if (!authoritative && !incoming.length) continue;
      for (const r of incoming) { if (r.updated_at && r.updated_at > maxTs) maxTs = r.updated_at; }

      // Слияние: старт от локального. Авторитетно: старт от пустого (облако-only).
      const cur = authoritative ? new Map() : new Map(d.collect(uid).map(r => [String(d.key(r)), r]));
      for (const pr of incoming) {
        const k = String(d.key(pr));
        if (pr.deleted) cur.delete(k);
        else cur.set(k, normalizeRow(d, pr));
      }
      const merged = [...cur.values()];
      d.rebuild(uid, merged);
      // Тень = слитое локальное состояние (чтобы не пушить обратно только что
      // подтянутое). Пересобираем из свежесобранного локального.
      const shRows = d.collect(uid);
      const sh = {}; shRows.forEach(r => { sh[String(d.key(r))] = stableHash(r); });
      shadow[d.table] = sh;
    }
    saveShadow(uid, shadow);
    setCursor(uid, maxTs);
  }

  // Пришедшая из БД строка несёт служебные поля (updated_at и т.п.) — приводим
  // к той же форме, что даёт collect (иначе хэши тени не сойдутся).
  function normalizeRow(d, pr) {
    if (d.table === "user_categories") return { user_id: pr.user_id, name: pr.name, color: pr.color ?? null, position: pr.position ?? 0, deleted: false };
    if (d.table === "user_hidden")     return { user_id: pr.user_id, kind: pr.kind, ref_id: pr.ref_id, deleted: false };
    if (d.table === "user_ordering")   return { user_id: pr.user_id, ordered_ids: pr.ordered_ids };
    return { user_id: pr.user_id, id: pr.id, data: pr.data || {}, position: pr.position ?? 0, deleted: false };
  }

  /* ----- оркестрация ----- */
  let _syncing = false;

  // Полная синхронизация: сначала протолкнуть локальные правки (чтобы облако
  // стало актуальным), затем слить чужие изменения. Возвращает статус.
  async function sync(uid, { silent = false } = {}) {
    if (!uid) return { status: "no-user" };
    if (typeof Auth === "undefined" || !Auth.isSignedIn()) return { status: "no-session" };
    if (!navigator.onLine) return { status: "offline" };
    if (_syncing) return { status: "in-flight" };
    _syncing = true;
    try {
      diffAndEnqueue(uid);
      const res = await Outbox.flush();
      await applyPull(uid);
      markSyncedNow(uid);
      if (!silent && typeof updateOnlineStatus === "function") { try { updateOnlineStatus(); } catch {} }
      return { status: "ok", flushed: res };
    } catch (e) {
      return { status: "error", error: e?.message || String(e) };
    } finally {
      _syncing = false;
    }
  }

  // Только протолкнуть локальные правки (после правки — без полного пула).
  async function pushOnly(uid) {
    if (!uid) return;
    diffAndEnqueue(uid);
    return Outbox.flush();
  }

  /* ----- миграция на пер-сущностную модель + гидратация мелкого состояния -----
     Вызывается из Bridge.hydrate при входе/открытии. Правило БЕЗОПАСНОСТИ: ни
     одно устройство не становится источником истины САМО. Логика:
       • уже мигрировали → обычное слияние (applyPull);
       • ещё нет, но в облаке уже есть данные → ЖЁСТКО перенять облако
         (authoritative) и пометить мигрированным. Местный (возможно устаревший)
         мусор наверх не уходит;
       • ещё нет и облако ПУСТО → не делаем НИЧЕГО (ждём, пока «хорошее»
         устройство опубликует данные через publishAll). Локальное не трогаем,
         флаг не ставим — при следующем открытии, когда облако наполнится,
         устройство перенимет его. Так плохое устройство не может случайно
         засеять облако.
     Возвращает { mode } для honest-статуса/логов. */
  async function hydrateSmallState(uid) {
    if (!uid) return { mode: "no-user" };
    if (typeof Auth === "undefined" || !Auth.isSignedIn()) return { mode: "no-session" };
    if (localStorage.getItem(MIGRATED(uid))) {
      await applyPull(uid);
      return { mode: "merge" };
    }
    const hasCloud = await cloudHasData(uid);
    if (hasCloud) {
      await applyPull(uid, { authoritative: true });   // перенять облако целиком
      localStorage.setItem(MIGRATED(uid), "1");
      return { mode: "adopted" };
    }
    return { mode: "awaiting-publish" };   // облако пусто — ждём publishAll
  }

  // Есть ли у профиля хоть какие-то пер-сущностные данные в облаке.
  async function cloudHasData(uid) {
    for (const d of DESCRIPTORS) {
      try {
        const rows = await DB.pullEntities(d.table, uid, "");
        if (rows.length) return true;
      } catch (e) { throw new Error(`probe ${d.table}: ${e.message || e}`); }
    }
    return false;
  }

  // ЯВНАЯ публикация: сделать ЭТО устройство источником истины — залить всё
  // локальное мелкое состояние в облако (первичное наполнение реляционных
  // таблиц). Запускать ТОЛЬКО на заведомо «хорошем» устройстве. После неё
  // остальные устройства при открытии перенимут облако (adopted).
  async function publishAll(uid) {
    if (!uid) return { status: "no-user" };
    if (typeof Auth === "undefined" || !Auth.isSignedIn()) return { status: "no-session" };
    if (!navigator.onLine) return { status: "offline" };
    try {
      resetShadow(uid);                        // считать всё локальное новым
      const queued = diffAndEnqueue(uid, { force: true }); // публикуем намеренно, до флага миграции
      const res = await Outbox.flush();
      localStorage.setItem(MIGRATED(uid), "1");
      await applyPull(uid);                    // подтянуть свои же записи → выставить cursor
      markSyncedNow(uid);
      if (typeof updateOnlineStatus === "function") { try { updateOnlineStatus(); } catch {} }
      return { status: "ok", queued, flushed: res };
    } catch (e) {
      return { status: "error", error: e?.message || String(e) };
    }
  }

  // Честный статус для индикатора.
  async function status(uid) {
    const s = await Outbox.stats();
    let state;
    if (!navigator.onLine) state = "offline";
    else if (s.blocked > 0) state = "blocked";                 // застряло — нужно внимание
    else if (s.lastError && s.pending > 0) state = "error";
    else if (s.pending > 0) state = "pending";
    else if (uid && !isMigrated(uid)) state = "awaiting";      // ждём первичной публикации/перенятия
    else state = "synced";
    return { state, pending: s.pending, blocked: s.blocked, lastError: s.lastError, lastSyncedAt: lastSyncedAt(uid) };
  }

  return {
    sync, pushOnly, applyPull, diffAndEnqueue, status, lastSyncedAt,
    hydrateSmallState, publishAll, cloudHasData, resetShadow, isMigrated,
    _descriptors: DESCRIPTORS,
  };
})();
