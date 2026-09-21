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
 * Дедупликация по ключу (opId): последняя запись по одной сущности В ОДНОМ
 * аккаунте вытесняет прежнюю. opId = JSON.stringify([authUserId, entityKey]).
 * Ниже указаны внутренние entityKey:
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
    }).catch(error => { _dbPromise = null; throw error; });
    return _dbPromise;
  }

  function tx(mode, fn) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let result;
      try {
        Promise.resolve(fn(store)).then(r => { result = r; }, error => {
          try { t.abort(); } catch {}
          reject(error);
        });
      } catch (error) {
        try { t.abort(); } catch {}
        reject(error);
      }
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  function reqToPromise(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

  function accountId() { return typeof Auth !== "undefined" ? Auth.userId?.() || null : null; }
  async function put(op, owner = accountId()) {
    if (!owner) throw new Error("Outbox: для постановки в очередь нужен аккаунт");
    op = { ...op, owner, opId: JSON.stringify([owner, op.opId]) };
    // Every user edit gets a new revision; retry bookkeeping must not call put().
    const revision = typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID() : `${Date.now()}-${Math.random()}-${++revisionCounter}`;
    await tx("readwrite", store => store.put({ ...op, revision, createdAt: op.createdAt || Date.now() }));
    if (_flushPromise) _flushAgain = true;
  }
  let revisionCounter = 0;
  async function all() {
    const rows = await tx("readonly", store => reqToPromise(store.getAll()));
    return (rows || []).filter(op => !op.recoveryArchive).sort((a, b) => a.createdAt - b.createdAt);
  }
  // Compare and acknowledge in ONE IndexedDB transaction. A late response for
  // an older revision may neither delete a new edit nor replace it with a retry.
  function settle(op, error, { penalize = true } = {}) {
    return tx("readwrite", store => new Promise((resolve, reject) => {
      const request = store.get(op.opId);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const current = request.result;
        // Legacy entries have no revision; a fresh edit always has one.
        if (!current || current.revision !== op.revision) { resolve(false); return; }
        if (error) {
          const attempts = (current.attempts || 0) + (penalize ? 1 : 0);
          store.put({ ...current, attempts, blocked: attempts >= MAX_ATTEMPTS,
            lastError: String(error?.message || error).slice(0, 500), lastErrorAt: Date.now() });
        } else store.delete(op.opId);
        resolve(true);
      };
    }));
  }
  async function count() {
    return (await all()).length;
  }
  // Есть ли в очереди операция с таким ключом. Нужно hydrate (bridge.js), чтобы
  // не затирать локальное состояние облаком, пока локальная правка ещё не ушла
  // (напр. незасинканный ud:<userId> означает «локальный user_data новее облака»).
  async function has(opId) {
    const op = await tx("readonly", store => reqToPromise(store.get(opId)));
    return !!op && !op.recoveryArchive;
  }

  /* ----- публичные enqueue ----- */
  function enqueueWorkout(row, owner) { return put({ opId: "wk:" + row.id, type: "saveWorkout", args: row }, owner); }
  function enqueueDeleteWorkout(userId, id) {
    return put({ opId: "wk:" + id, type: "deleteWorkout", args: { userId, id } });
  }
  function enqueueUserData(userId, patch) { return put({ opId: "ud:" + userId, type: "saveUserData", args: { userId, patch } }); }
  // Пер-сущностная операция (supabase-relational.sql): одна строка одной
  // таблицы. Ключ ent:<table>:<key> — дедуп по конкретной сущности (последняя
  // правка/надгробие вытесняет прежнее до флаша). key уникален в рамках профиля
  // (его формирует SyncEngine: обычно userId|id, для категорий userId|name и т.п.).
  function enqueueEntity(table, key, row) {
    return put({ opId: "ent:" + table + ":" + key, type: "saveEntity", args: { table, row } });
  }

  async function apply(op) {
    if (!op.owner || op.owner !== accountId()) throw new Error("Outbox: аккаунт изменился");
    const options = { expectedAccount: op.owner };
    switch (op.type) {
      case "saveWorkout":   return DB.saveWorkout(op.args, options);
      case "deleteWorkout": return DB.deleteWorkout(op.args.id, options);
      case "saveUserData":  return DB.saveUserData(op.args.userId, op.args.patch, options);
      case "saveEntity":    return DB.pushEntities(op.args.table, [op.args.row], options);
      default: throw new Error("Outbox: неизвестный тип операции " + op.type);
    }
  }

  function isTransientNetworkError(error) {
    const message = String(error?.message || error || "");
    return /сервер не ответил|failed to fetch|load failed|networkerror|network request failed|\bHTTP (408|425|429|5\d\d)\b/i.test(message);
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

  let _flushPromise = null;
  let _flushAgain = false;
  async function skippedResult(reason) {
    const current = await stats();
    return {
      skipped: reason,
      sent: 0,
      failed: 0,
      blocked: current.blocked,
      pending: current.pending,
      lastError: current.lastError,
      storageError: current.storageError,
      workoutSent: 0,
      workoutFailed: 0,
    };
  }
  async function runFlush() {
    if (typeof window !== "undefined" && window.TRAIN_RESTORE_MODE) return skippedResult("restore");
    if (!navigator.onLine) return skippedResult("offline");
    if (typeof Auth === "undefined" || !Auth.isSignedIn()) return skippedResult("no-session");
    const owner = accountId();
    if (!owner) return skippedResult("no-session");
    let sent = 0, failed = 0, blocked = 0;
    let workoutSent = 0, workoutFailed = 0;
    const attempted = new Set();
    // Drain fresh revisions arriving during this flush, but never hot-loop a
    // failed revision. Bound work if the user keeps editing continuously.
    let stop = false;
    for (let pass = 0; pass < 8 && !stop; pass++) {
      _flushAgain = false;
      const ops = (await all()).filter(op => op.owner === owner && !attempted.has(JSON.stringify([op.opId, op.revision])));
      if (!ops.length) break;
      for (const op of ops) {
      attempted.add(JSON.stringify([op.opId, op.revision]));
      if (op.blocked) { blocked++; continue; }   // карантин — не трогаем, но и не теряем
      const current = await tx("readonly", store => reqToPromise(store.get(op.opId)));
      if (!current || current.revision !== op.revision) continue;
      if (accountId() !== owner) { stop = true; break; }
      try {
        await apply(op);
        await settle(op);
        sent++;
        if (op.type === "saveWorkout" || op.type === "deleteWorkout") workoutSent++;
      }
      catch (e) {
        failed++;
        if (op.type === "saveWorkout" || op.type === "deleteWorkout") workoutFailed++;
        // Оффлайн/сессия отвалилась ПОСРЕДИ флаша — это среда, а не вина
        // операции: выходим без штрафа, весь хвост попробуем в следующий раз.
        if (!navigator.onLine || accountId() !== owner || e?.code === "ACCOUNT_CHANGED" || (typeof Auth !== "undefined" && !Auth.isSignedIn()) || isTransientNetworkError(e)) {
          await settle(op, e, { penalize: false });
          stop = true; break;
        }
        // Онлайн, но операция всё равно не прошла — вероятно «ядовитая».
        // НЕ прерываем очередь (иначе она заблокирует user_data за собой):
        // считаем попытки, по исчерпании — карантин. Операцию НЕ удаляем.
        await settle(op, e);
        console.warn("Outbox: операция не прошла", op.opId, e);
        // сознательно продолжаем со следующей операцией
      }
      }
    }
    const finalStats = await stats();
    if (finalStats.storageError) throw new Error(finalStats.lastError);
    if (typeof updateOnlineStatus === "function") { try { updateOnlineStatus(); } catch {} }
    const result = {
      sent,
      failed,
      blocked: finalStats.blocked,
      pending: finalStats.pending,
      held: finalStats.held,
      lastError: finalStats.lastError,
      workoutSent,
      workoutFailed,
    };
    // Автоматическая синхронизация обычно проходит без участия пользователя.
    // Для тренировок (самые ценные данные) сообщаем явный итог. Ручная кнопка
    // подавляет это событие и показывает свой более полный результат.
    if (workoutSent > 0 || workoutFailed > 0) {
      window.dispatchEvent(new CustomEvent("train-workout-sync-result", { detail: result }));
    }
    return result;
  }

  // Если несколько автотриггеров (online, открытие, ручная кнопка) приходят
  // одновременно, все ждут ОДИН реальный проход очереди. Раньше последующие
  // вызовы получали `in-flight` и могли ошибочно решить, что всё уже отправлено.
  function flush() {
    if (_flushPromise) return _flushPromise;
    // Serialize network writes across same-origin tabs where Web Locks exists.
    // IndexedDB transactions alone cannot order two concurrent HTTP requests.
    _flushPromise = (navigator.locks?.request
      ? navigator.locks.request("train-outbox-flush", runFlush)
      : runFlush()).finally(() => {
        _flushPromise = null;
        // A new edit near completion (or after the bounded drain) still needs
        // a pass even if its caller joined the old promise. Failures alone do
        // not set this flag, so a rejected operation cannot spin here.
        if (_flushAgain) {
          _flushAgain = false;
          setTimeout(() => { flush().catch(error => console.warn("Outbox: повторная отправка не удалась", error)); }, 0);
        }
      });
    return _flushPromise;
  }

  // Честный статус очереди для индикатора: сколько всего ждёт отправки, сколько
  // из них в карантине (застряли — нужно внимание), текст последней ошибки.
  async function stats(profileId) {
    try {
      const owner = accountId();
      const deviceOps = await all();
      if (owner !== accountId()) throw new Error("Аккаунт изменился; проверьте очередь заново");
      // Неизвестный профиль (в т.ч. legacy delete) нельзя безопасно исключить.
      const ops = profileId ? deviceOps.filter(op => !profileOf(op) || profileOf(op) === profileId) : deviceOps;
      const blocked = ops.filter(o => o.blocked).length;
      const held = ops.filter(o => !o.owner || o.owner !== accountId()).length;
      const latestFailure = ops.filter(o => o.owner === accountId() && o.lastError).sort((a, b) => (b.lastErrorAt || 0) - (a.lastErrorAt || 0))[0];
      return { pending: ops.length, blocked, held, otherPending: deviceOps.length - ops.length,
        lastError: latestFailure?.lastError || null, storageError: false };
    } catch (error) {
      return { pending: null, blocked: null, storageError: true,
        lastError: "Не удалось прочитать очередь устройства: " + String(error?.message || error).slice(0, 160) };
    }
  }

  function profileOf(op) {
    if (op.type === "saveWorkout") return op.args?.user_id;
    if (op.type === "saveEntity") return op.args?.row?.user_id;
    return op.args?.userId;
  }

  // Возвращаем только операции выбранного профиля текущего автора. Для чужих
  // и старых записей — лишь количество, без содержимого и текста ошибок.
  async function review(profileId) {
    const owner = accountId();
    if (!owner || !profileId) throw new Error("Выберите профиль и войдите в аккаунт");
    const ops = await all();
    if (accountId() !== owner) throw new Error("Аккаунт изменился. Откройте очередь заново.");
    return {
      owner,
      operations: ops.filter(op => op.owner === owner && profileOf(op) === profileId).map(op => ({
        opId: op.opId, revision: op.revision, type: op.type, blocked: !!op.blocked,
        attempts: op.attempts || 0, lastError: op.lastError || null,
      })),
      legacy: ops.filter(op => !op.owner).length,
      foreign: ops.filter(op => op.owner && op.owner !== owner).length,
      recoverable: ops.filter(op => !op.owner && profileOf(op) === profileId && legacyKey(op)).map(op => ({
        opId: op.opId, fingerprint: JSON.stringify(op), type: op.type,
        label: String(op.args?.data?.name || op.args?.row?.data?.name || op.args?.id || op.args?.row?.id || "Настройки").slice(0, 120),
      })),
    };
  }

  // Принимаем только распознаваемый старый формат и явно указанный профиль.
  // Удаление без userId и неизвестный формат требуют ручного разбора.
  function legacyKey(op) {
    if (!profileOf(op) || typeof profileOf(op) !== "string") return null;
    let key;
    if (op.type === "saveWorkout" && typeof op.args?.id === "string") key = "wk:" + op.args.id;
    else if (op.type === "deleteWorkout" && typeof op.args?.id === "string") key = "wk:" + op.args.id;
    else if (op.type === "saveUserData" && op.args?.patch && typeof op.args.patch === "object") key = "ud:" + op.args.userId;
    else if (op.type === "saveEntity") {
      const row = op.args?.row, table = op.args?.table;
      const keys = { user_exercises: "id", user_templates: "id", user_exercise_groups: "id", user_categories: "name", user_muscles: "id", user_movements: "id" };
      const ref = Object.hasOwn(keys, table) ? row?.[keys[table]] :
        table === "user_ordering" ? "ordering" : table === "user_hidden" && typeof row?.kind === "string" && typeof row?.ref_id === "string" ? row.kind + ":" + row.ref_id : null;
      if (typeof ref !== "string" || !ref) return null;
      key = `ent:${table}:${row.user_id}|${ref}`;
    }
    return key && op.opId === key ? key : null;
  }

  async function recoverLegacy(profileId, viewed, { expectedAccount, confirmed = false } = {}) {
    if (!confirmed || !expectedAccount || accountId() !== expectedAccount) throw new Error("Нужно подтверждение исходного аккаунта");
    return tx("readwrite", store => new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        if (accountId() !== expectedAccount) { reject(new Error("Аккаунт изменился")); return; }
        const rows = request.result || [], op = rows.find(r => r.opId === viewed.opId);
        if (!op || op.owner || op.recoveryArchive || profileOf(op) !== profileId || !legacyKey(op) || JSON.stringify(op) !== viewed.fingerprint) {
          reject(new Error("Запись изменилась или её профиль неизвестен. Откройте очередь заново.")); return;
        }
        const key = legacyKey(op), destination = JSON.stringify([expectedAccount, key]);
        if (rows.some(r => !r.recoveryArchive && r.owner && (r.opId === destination || r.opId === JSON.stringify([r.owner, key])))) {
          reject(new Error("Уже есть операция с владельцем и тем же ключом. Старая запись сохранена; автоматическая замена запрещена.")); return;
        }
        // Архив и новая операция записываются атомарно. Архив не отправляется
        // и не удаляется после успешного HTTP; доступен для локального экспорта.
        store.put({ ...op, recoveryArchive: true, recoveredBy: expectedAccount, recoveredAt: Date.now() });
        store.put({ ...op, opId: destination, owner: expectedAccount, attempts: 0, blocked: false,
          lastError: null, lastErrorAt: null, revision: `${Date.now()}-${Math.random()}-${++revisionCounter}` });
        resolve(true);
      };
    }));
  }

  async function recoveryBackups(profileId) {
    const owner = accountId();
    if (!owner) throw new Error("Нужен вход в аккаунт");
    const rows = await tx("readonly", store => reqToPromise(store.getAll()));
    if (accountId() !== owner) throw new Error("Аккаунт изменился");
    return rows.filter(op => op.recoveryArchive && op.recoveredBy === owner && profileOf(op) === profileId);
  }

  // Снять карантин только с просмотренных версий. Новая правка или новая
  // ошибка между открытием окна и кликом не должна быть затёрта старым UI.
  async function retryBlocked(profileId, versions, { expectedAccount } = {}) {
    if (!expectedAccount || accountId() !== expectedAccount) throw new Error("Аккаунт изменился. Откройте очередь заново.");
    const wanted = new Map(versions.map(v => [v.opId, v.revision]));
    return tx("readwrite", store => new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        if (accountId() !== expectedAccount) { reject(new Error("Аккаунт изменился. Откройте очередь заново.")); return; }
        let retried = 0;
        for (const op of request.result || []) {
          if (op.owner !== expectedAccount || profileOf(op) !== profileId || !op.blocked ||
              !wanted.has(op.opId) || wanted.get(op.opId) !== op.revision) continue;
          store.put({ ...op, attempts: 0, blocked: false, lastError: null, lastErrorAt: null,
            revision: `${Date.now()}-${Math.random()}-${++revisionCounter}` });
          retried++;
        }
        resolve(retried);
      };
    }));
  }

  // Флаш при появлении сети. Обработчик в app.js дополнительно обновляет UI.
  window.addEventListener("online", () => { flush().catch(error => {
    console.warn("Outbox: очередь недоступна", error);
    if (typeof updateOnlineStatus === "function") updateOnlineStatus();
  }); });

  async function restoreReceipt(id) {
    return tx("readonly", store => reqToPromise(store.get("restore:" + id)));
  }
  async function commitRestore(id, userId, owner, operations) {
    if (!window.TRAIN_RESTORE_MODE || accountId() !== owner) throw Error("Нет контекста восстановления");
    return tx("readwrite", store => new Promise((resolve,reject)=>{
      const request=store.getAll();request.onerror=()=>reject(request.error);
      request.onsuccess=()=>{
        try {
          if(accountId()!==owner)throw Error("Аккаунт изменился");
          const rows=request.result, receipt=rows.find(row=>row.opId==="restore:"+id);
          if(receipt){if(receipt.owner!==owner||receipt.userId!==userId)throw Error("Чужой пакет восстановления");resolve(receipt);return;}
          if(rows.some(row=>!row.recoveryArchive && (!profileOf(row)||profileOf(row)===userId)))throw Error("Сначала обработайте существующую очередь профиля");
          const ids=new Set();
          for(const op of operations){
            if(!["saveWorkout","deleteWorkout","saveEntity"].includes(op.type)||profileOf(op)!==userId||typeof op.opId!=="string"||ids.has(op.opId))throw Error("Некорректный пакет восстановления");
            ids.add(op.opId);
            store.put({...op,owner,opId:JSON.stringify([owner,op.opId]),revision:id+":"+op.opId,createdAt:Date.now()});
          }
          const marker={opId:"restore:"+id,owner,userId,recoveryArchive:true,restoreReceipt:true};
          store.put(marker);resolve(marker);
        }catch(error){try{store.transaction.abort();}catch{}reject(error);}
      };
    }));
  }
  return { enqueueWorkout, enqueueDeleteWorkout, enqueueUserData, enqueueEntity, flush, count, all, has, stats, review, retryBlocked, recoverLegacy, recoveryBackups, commitRestore, restoreReceipt };
})();

/* ---- индикатор синхронизации ----
 * ПЕРЕОПРЕДЕЛЯЕТ updateOnlineStatus() из app.js (та function-декларация,
 * замена работает без правок app.js — тот же приём, что в auth-ui.js).
 *
 * Источник истины — количество операций в Outbox, а не флаги в localStorage.
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
    statusDot.classList.toggle("error", st.state === "error" || st.state === "blocked" || st.state === "held");
    statusDot.classList.toggle("pending", st.state === "pending" || st.state === "awaiting");

    let text;
    switch (st.state) {
      case "held":
        text = "⚠ В очереди есть записи другого аккаунта или старые записи без владельца. Они сохранены, но не отправляются.";
        break;
      case "offline":
        text = st.pending > 0 ? `Нет сети — ${st.pending} изм. ждут отправки` : "Нет сети — данные сохраняются локально";
        break;
      case "blocked":
        text = `⚠ Часть изменений не отправляется (${st.blocked}) — откройте «Настройки → Очередь отправки»`;
        break;
      case "error":
        if (st.storageError) {
          text = "⚠ Очередь устройства недоступна. Не очищайте данные приложения; повторите попытку.";
          break;
        }
        text = "⚠ Ошибка синхронизации" + (st.lastError ? ": " + String(st.lastError).slice(0, 80) : "") + " — повторяем…";
        break;
      case "pending":
        text = "Отправляем изменения…";
        break;
      case "awaiting":
        text = "Ожидается первичная синхронизация с облаком";
        break;
      default: // локальная очередь пуста; удалённые изменения узнаем при pull
        text = st.lastSyncedAt ? "Последняя синхронизация · " + _syncTimeAgo(st.lastSyncedAt) : "Локальных изменений нет";
    }
    statusText.textContent = text;
  }).catch(() => {
    statusDot.classList.add("error");
    statusDot.classList.remove("pending");
    statusText.textContent = "⚠ Не удалось проверить синхронизацию. Не очищайте данные приложения.";
  });
}
