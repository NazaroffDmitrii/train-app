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

  /* ----- публичные enqueue ----- */
  function enqueueWorkout(row)      { return put({ opId: "wk:" + row.id, type: "saveWorkout", args: row }); }
  function enqueueDeleteWorkout(id) { return put({ opId: "wk:" + id, type: "deleteWorkout", args: { id } }); }
  function enqueueUserData(userId, patch) { return put({ opId: "ud:" + userId, type: "saveUserData", args: { userId, patch } }); }

  async function apply(op) {
    switch (op.type) {
      case "saveWorkout":   return DB.saveWorkout(op.args);
      case "deleteWorkout": return DB.deleteWorkout(op.args.id);
      case "saveUserData":  return DB.saveUserData(op.args.userId, op.args.patch);
      default: throw new Error("Outbox: неизвестный тип операции " + op.type);
    }
  }

  let _flushing = false;
  async function flush() {
    if (_flushing) return { skipped: "in-flight" };
    if (!navigator.onLine) return { skipped: "offline" };
    if (typeof Auth === "undefined" || !Auth.isSignedIn()) return { skipped: "no-session" };
    _flushing = true;
    let sent = 0, failed = 0;
    try {
      const ops = await all();
      for (const op of ops) {
        try { await apply(op); await remove(op.opId); sent++; }
        catch (e) {
          failed++;
          console.warn("Outbox: операция не прошла, оставляем в очереди", op.opId, e);
          // Прерываемся на первой ошибке: скорее всего сеть/сессия отвалились —
          // нет смысла долбить остальные, попробуем весь хвост в следующий флаш.
          break;
        }
      }
    } finally {
      _flushing = false;
    }
    if (typeof updateOnlineStatus === "function") { try { updateOnlineStatus(); } catch {} }
    return { sent, failed };
  }

  // Флаш при появлении сети (в дополнение к обработчику в app.js — тот дёргает
  // старую no-op SyncQueue.flush).
  window.addEventListener("online", () => { flush(); });

  return { enqueueWorkout, enqueueDeleteWorkout, enqueueUserData, flush, count, all };
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
function updateOnlineStatus() {
  const online = navigator.onLine;
  statusDot.classList.toggle("offline", !online);
  Outbox.count().then(pending => {
    statusDot.classList.toggle("pending", online && pending > 0);
    statusDot.classList.remove("error"); // старое error-состояние (snapshot-sync) не используется
    if (!online) {
      statusText.textContent = pending > 0
        ? "Нет сети — есть несинхронизированные изменения"
        : "Нет сети — данные сохраняются локально";
    } else if (pending > 0) {
      statusText.textContent = "Отправляем изменения…";
    } else {
      statusText.textContent = "Работаем онлайн";
    }
  }).catch(() => {});
}
