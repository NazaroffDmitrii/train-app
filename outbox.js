/*
 * outbox.js — durable-очередь несинхронизированных изменений (Фаза 4, спека §5–6).
 *
 * Проблема, которую решает: bridge.js раньше пушил в облако fire-and-forget —
 * при оффлайне или сетевой ошибке изменение терялось для облака (оставалось
 * только локально в localStorage). Теперь каждое изменение сперва кладётся в
 * этот персистентный (IndexedDB) журнал, затем идёт попытка флаша. Оффлайн →
 * запись ждёт в очереди и уходит при появлении сети (событие online) или при
 * следующем старте. Приложение закрыли до флаша — очередь переживает
 * перезапуск (она в IndexedDB).
 *
 * Дедупликация по ключу (opId): последняя запись по одной сущности вытесняет
 * прежнюю. Ключи:
 *   wk:<workoutId>  — сохранение/удаление одной тренировки (last-write-wins:
 *                     повторная правка до флаша схлопывается; delete поверх
 *                     save и наоборот — побеждает последнее действие);
 *   ud:<userId>     — блоб user_data профиля (упражнения/шаблоны/категории).
 * Всё построено на upsert по id (workout.id — клиентский), поэтому повторный
 * флаш после реконнекта не плодит дубли.
 */
"use strict";

const Outbox = (() => {
  const DB_NAME = "train-outbox";
  const STORE = "ops";
  let _dbPromise = null;

  function openDb() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "opId" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _dbPromise;
  }

  function tx(mode, fn) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let result;
      Promise.resolve(fn(store)).then(r => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  function reqToPromise(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

  async function put(op) {
    op.createdAt = op.createdAt || Date.now();
    await tx("readwrite", store => store.put(op));
  }
  async function all() {
    const rows = await tx("readonly", store => reqToPromise(store.getAll()));
    return (rows || []).sort((a, b) => a.createdAt - b.createdAt);
  }
  async function remove(opId) { await tx("readwrite", store => store.delete(opId)); }
  async function count() {
    try { return await tx("readonly", store => reqToPromise(store.count())); }
    catch { return 0; }
  }
  // Есть ли в очереди операция с таким ключом. Нужно hydrate (bridge.js), чтобы
  // не затирать локальное состояние облаком, пока локальная правка ещё не ушла
  // (напр. незасинканный ud:<userId> означает «локальный user_data новее облака»).
  async function has(opId) {
    try { return !!(await tx("readonly", store => reqToPromise(store.get(opId)))); }
    catch { return false; }
  }

  /* ----- публичные enqueue ----- */
  function enqueueWorkout(row)      { return put({ opId: "wk:" + row.id, type: "saveWorkout", args: row }); }
  function enqueueDeleteWorkout(id) { return put({ opId: "wk:" + id, type: "deleteWorkout", args: { id } }); }
  function enqueueUserData(userId, patch) { return put({ opId: "ud:" + userId, type: "saveUserData", args: { userId, patch } }); }
  // Пер-сущностная операция (supabase-relational.sql): одна строка одной
  // таблицы. Ключ ent:<table>:<key> — дедуп по конкретной сущности (последняя
  // правка/надгробие вытесняет прежнее до флаша). key уникален в рамках профиля
  // (его формирует SyncEngine: обычно userId|id, для категорий userId|name и т.п.).
  function enqueueEntity(table, key, row) {
    return put({ opId: "ent:" + table + ":" + key, type: "saveEntity", args: { table, row } });
  }

  async function apply(op) {
    switch (op.type) {
      case "saveWorkout":   return DB.saveWorkout(op.args);
      case "deleteWorkout": return DB.deleteWorkout(op.args.id);
      case "saveUserData":  return DB.saveUserData(op.args.userId, op.args.patch);
      case "saveEntity":    return DB.pushEntities(op.args.table, [op.args.row]);
      default: throw new Error("Outbox: неизвестный тип операции " + op.type);
    }
  }

  // Сколько раз пытаемся протолкнуть одну операцию, прежде чем счесть её
  // «ядовитой» (битые данные / RLS-отказ — то, что не исправится повтором) и
  // отправить в карантин. Карантинная операция остаётся в очереди (её видно и
  // можно разобрать вручную), но БОЛЬШЕ НЕ пробуется и — главное — НЕ блокирует
  // остальные. Историческая причина: раньше цикл делал break на первой ошибке,
  // и одна застрявшая тренировка навсегда стопорила блоб user_data
  // (шаблоны/упражнения/группы) за собой — из-за этого при hydrate локальные
  // правки откатывались устаревшим облаком.
  const MAX_ATTEMPTS = 6;

  let _flushing = false;
  let _lastError = null;   // текст последней ошибки операции — для честного статуса
  async function flush() {
    if (_flushing) return { skipped: "in-flight" };
    if (!navigator.onLine) return { skipped: "offline" };
    if (typeof Auth === "undefined" || !Auth.isSignedIn()) return { skipped: "no-session" };
    _flushing = true;
    let sent = 0, failed = 0, blocked = 0;
    try {
      const ops = await all();
      for (const op of ops) {
        if (op.blocked) { blocked++; continue; }   // карантин — не трогаем, но и не теряем
        try { await apply(op); await remove(op.opId); sent++; }
        catch (e) {
          failed++;
          _lastError = e?.message || String(e);
          // Оффлайн/сессия отвалилась ПОСРЕДИ флаша — это среда, а не вина
          // операции: выходим без штрафа, весь хвост попробуем в следующий раз.
          if (!navigator.onLine || (typeof Auth !== "undefined" && !Auth.isSignedIn())) break;
          // Онлайн, но операция всё равно не прошла — вероятно «ядовитая».
          // НЕ прерываем очередь (иначе она заблокирует user_data за собой):
          // считаем попытки, по исчерпании — карантин. Операцию НЕ удаляем.
          op.attempts = (op.attempts || 0) + 1;
          if (op.attempts >= MAX_ATTEMPTS) op.blocked = true;
          try { await put(op); } catch {}
          console.warn("Outbox: операция не прошла", op.opId, "попытка", op.attempts, op.blocked ? "(карантин)" : "", e);
          // сознательно продолжаем со следующей операцией
        }
      }
      if (failed === 0) _lastError = null;   // весь проход чистый — сбрасываем ошибку
    } finally {
      _flushing = false;
    }
    if (typeof updateOnlineStatus === "function") { try { updateOnlineStatus(); } catch {} }
    return { sent, failed, blocked };
  }

  // Честный статус очереди для индикатора: сколько всего ждёт отправки, сколько
  // из них в карантине (застряли — нужно внимание), текст последней ошибки.
  async function stats() {
    try {
      const ops = await all();
      const blocked = ops.filter(o => o.blocked).length;
      return { pending: ops.length, blocked, lastError: _lastError };
    } catch { return { pending: 0, blocked: 0, lastError: _lastError }; }
  }

  // Флаш при появлении сети (в дополнение к обработчику в app.js — тот дёргает
  // старую no-op SyncQueue.flush).
  window.addEventListener("online", () => { flush(); });

  return { enqueueWorkout, enqueueDeleteWorkout, enqueueUserData, enqueueEntity, flush, count, all, has, stats };
})();

/* ---- индикатор синхронизации ----
 * ПЕРЕОПРЕДЕЛЯЕТ updateOnlineStatus() из app.js (та function-декларация,
 * замена работает без правок app.js — тот же приём, что в auth-ui.js).
 *
 * Старая версия читала SyncQueue.size() → isDirty-флаг в localStorage,
 * который выставляли десятки разбросанных по app.js SyncQueue.push(...) и
 * сбрасывали только внутри удалённых кнопок «В облако»/«Из облака» (см.
 * cleanup п.1). После их удаления флаг залипал навсегда → жёлтый «Есть
 * несинхронизированные изменения» горел даже при пустой очереди. Настоящий
 * источник истины теперь — количество операций в Outbox.
 */
function _syncTimeAgo(ts) {
  if (!ts) return "";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "только что";
  const m = Math.round(s / 60);
  if (m < 60) return m + " мин назад";
  const h = Math.round(m / 60);
  if (h < 24) return h + " ч назад";
  return Math.round(h / 24) + " дн назад";
}

// Честный индикатор: показывает РЕАЛЬНОЕ состояние синхронизации, а не только
// «отправляем». Источник — SyncEngine.status() (очередь + карантин + ошибка +
// флаг миграции + время последней успешной синхронизации).
function updateOnlineStatus() {
  const uid = (typeof DATA !== "undefined" && DATA.getCurrentUser) ? DATA.getCurrentUser() : null;
  if (typeof SyncEngine === "undefined") return; // ещё не загружен — придёт следующий вызов
  SyncEngine.status(uid).then(st => {
    // Точка: красная — нужно внимание (offline/error/blocked), жёлтая — в работе
    // (pending/awaiting), без класса — синхронизировано.
    statusDot.classList.toggle("offline", st.state === "offline");
    statusDot.classList.toggle("error", st.state === "error" || st.state === "blocked");
    statusDot.classList.toggle("pending", st.state === "pending" || st.state === "awaiting");

    let text;
    switch (st.state) {
      case "offline":
        text = st.pending > 0 ? `Нет сети — ${st.pending} изм. ждут отправки` : "Нет сети — данные сохраняются локально";
        break;
      case "blocked":
        text = `⚠ Часть изменений не отправляется (${st.blocked}) — откройте настройки и повторите синхронизацию`;
        break;
      case "error":
        text = "⚠ Ошибка синхронизации" + (st.lastError ? ": " + String(st.lastError).slice(0, 80) : "") + " — повторяем…";
        break;
      case "pending":
        text = "Отправляем изменения…";
        break;
      case "awaiting":
        text = "Ожидается первичная синхронизация с облаком";
        break;
      default: // synced
        text = st.lastSyncedAt ? "Синхронизировано · " + _syncTimeAgo(st.lastSyncedAt) : "Синхронизировано";
    }
    statusText.textContent = text;
  }).catch(() => {});
}
