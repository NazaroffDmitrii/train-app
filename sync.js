/*
 * sync.js — слой синхронизации между DATA (локальные данные, localStorage)
 * и Storage (адаптер JSONBin, см. storage.js). Раздел 8 спецификации.
 *
 * DATA остаётся единственным источником истины для экранов приложения —
 * все экраны как читали/писали в DATA синхронно, так и продолжают, без
 * единой правки. Этот файл просто подглядывает за изменениями (через
 * SyncQueue.push, который уже был вызван из index.html на каждое действие)
 * и в фоне, с задержкой, отправляет актуальное состояние нужных бинов
 * в JSONBin — а при входе в профиль один раз подтягивает свежие данные
 * с сервера в локальный кэш, прежде чем экраны успеют их прочитать.
 *
 * Если JSONBin не настроен (config.js: ENABLED=false) — все функции здесь
 * тихо ничего не делают, приложение работает как обычное local-only PWA.
 *
 * Разбиение на бины (раздел 8, защита от конфликтов записи):
 *   exercises             — общий пул упражнений (сейчас фактически read-only,
 *                            UI не даёт его редактировать, только читает)
 *   user_<id>             — видимость + личные упражнения + рекорды + указатель
 *                            на активную тренировку конкретного пользователя
 *   templates_<id>        — шаблоны конкретного пользователя
 *   workoutIndex_<id>     — лёгкий список {id, binId, ...} тренировок пользователя
 *   (динамически)         — отдельный bin на каждую тренировку, id которого
 *                            попадает в workoutIndex_<id> после создания
 */

const Sync = (() => {
  const DEBOUNCE_MS = 3000;       // обычные действия (новый подход и т.п.)
  const FAST_DEBOUNCE_MS = 600;   // значимые чекпоинты (завершение тренировки)
  const HYDRATE_WORKOUT_CAP = 25; // не вытягивать всю историю целиком за раз
  const DIRTY_KEY = "train_sync_dirty";

  // dirty переживает перезагрузку страницы — иначе при гидратации на новом
  // заходе нельзя отличить «локально пусто, потому что и не было правок» от
  // «есть неотправленные правки, их нельзя терять при pull» (см. hydrateUser).
  function loadDirty() {
    try { return new Set(JSON.parse(localStorage.getItem(DIRTY_KEY) || "[]")); }
    catch { return new Set(); }
  }
  function persistDirty() {
    try { localStorage.setItem(DIRTY_KEY, JSON.stringify(Array.from(dirty))); } catch {}
  }

  const dirty = loadDirty();
  const timers = new Map();
  let lastError = null;

  /* ----- вспомогательные ключи/бины ----- */
  function binIdForUser(userId)          { return CONFIG.BINS[`user_${userId}`]; }
  function binIdForTemplates(userId)     { return CONFIG.BINS[`templates_${userId}`]; }
  function binIdForWorkoutIndex(userId)  { return CONFIG.BINS[`workoutIndex_${userId}`]; }

  function splitScope(scope) {
    const i = scope.indexOf(":");
    return i === -1 ? [scope, null] : [scope.slice(0, i), scope.slice(i + 1)];
  }

  // Какие действия из index.html (см. вызовы SyncQueue.push) затрагивают какие бины.
  function scopesForAction(type, payload, currentUserId) {
    switch (type) {
      case "user:update":
        // Общая синхронизация пользовательского бина (видимость/упражнения/
        // рекорды/указатель активной тренировки) — например после отмены.
        return [`user:${currentUserId}`];
      case "workout:update":
      case "run:update":
        return [`workout:${payload.workoutId}`];
      case "workout:finish":
      case "run:finish":
        // Сам индекс отправляется как часть pushWorkout() ниже — после того,
        // как бин тренировки реально создан/обновлён, а не отдельным
        // параллельным таймером (иначе возможна гонка: индекс уезжает раньше,
        // чем тренировка получает finishedAt).
        return [`workout:${payload.workoutId}`, `user:${currentUserId}`];
      case "exercise:create":
      case "exercise:update":
      case "exercise:delete":
      case "exercise:visibility":
        // Все эти действия в текущей реализации — это «личные» упражнения
        // и видимость, которые живут в пользовательском бине, а не в общем пуле
        // (общий пул в UI сейчас не редактируется — см. комментарий выше).
        return [`user:${currentUserId}`];
      case "exercise:share":
        return [`user:${payload.toUserId}`];
      case "workout:delete":
        return [`workoutIndex:${currentUserId}`];
      case "workout:edit":
        return [`workout:${payload.workoutId}`, `workoutIndex:${currentUserId}`];
      case "template:update":
      case "template:rename":
      case "template:delete":
      case "template:create":
        return [`templates:${currentUserId}`];
      case "template:share":
        return [`templates:${payload.toUserId}`];
      default:
        return [];
    }
  }

  /* ----- отправка одного scope ----- */
  async function pushScope(scope) {
    const [kind, id] = splitScope(scope);

    if (kind === "exercises") {
      await Storage.updateBin(CONFIG.BINS.exercises, DATA.getExercises());
      return;
    }
    if (kind === "user") {
      await Storage.updateBin(binIdForUser(id), buildUserPayload(id));
      return;
    }
    if (kind === "templates") {
      await Storage.updateBin(binIdForTemplates(id), { items: DATA.getTemplates(id) });
      return;
    }
    if (kind === "workoutIndex") {
      await Storage.updateBin(binIdForWorkoutIndex(id), { items: DATA.getWorkoutIndex(id) });
      return;
    }
    if (kind === "workout") {
      await pushWorkout(id);
      return;
    }
  }

  function buildUserPayload(userId) {
    const active = DATA.getActiveWorkout(userId);
    return {
      hidden: DATA.getHiddenIds(userId),
      own: DATA.getOwnExercises(userId),
      records: DATA.getRecords(userId),
      activeWorkoutId: active ? active.id : null,
      activeWorkoutBinId: active ? (active._remoteBinId || null) : null,
    };
  }

  function findWorkoutById(userId, workoutId) {
    const active = DATA.getActiveWorkout(userId);
    if (active && active.id === workoutId) return active;
    return DATA.getWorkoutHistory(userId).find(w => w.id === workoutId) || null;
  }

  function summarizeWorkout(w) {
    return {
      id: w.id, binId: w._remoteBinId || null, type: w.type, name: w.name,
      startedAt: w.startedAt, finishedAt: w.finishedAt || null,
      durationSec: w.durationSec || null, distance: w.distance || null,
    };
  }

  function upsertWorkoutIndexLocal(userId, workout) {
    const list = DATA.getWorkoutIndex(userId);
    const idx = list.findIndex(e => e.id === workout.id);
    const entry = summarizeWorkout(workout);
    if (idx === -1) list.unshift(entry); else list[idx] = entry;
    DATA.saveWorkoutIndex(userId, list);
  }

  function stripLocalFields(workout) {
    const { _remoteBinId, ...rest } = workout;
    return rest;
  }

  // Создаёт bin тренировки при первой реальной записи («по мере записи
  // действий» — раздел 6.1), дальше просто обновляет тот же bin.
  async function pushWorkout(workoutId) {
    const userId = DATA.getCurrentUser();
    if (!userId) return;
    const workout = findWorkoutById(userId, workoutId);
    if (!workout) return; // тренировку успели удалить — отправлять нечего

    if (!workout._remoteBinId) {
      const binId = await Storage.createBin(stripLocalFields(workout), workout.name);
      workout._remoteBinId = binId;
      DATA.updateWorkoutInPlace(userId, workout);
    } else {
      await Storage.updateBin(workout._remoteBinId, stripLocalFields(workout));
    }

    upsertWorkoutIndexLocal(userId, workout); // локальный кэш — всегда, дёшево

    // В сам JSONBin индекс отправляем только на значимых чекпоинтах
    // (тренировка завершена), а не на каждую правку подхода — иначе расход
    // запросов растёт вдвое на каждое сохранение почти без пользы.
    if (workout.finishedAt) {
      // Помечаем индекс грязным ДО отправки: если iOS убьёт страницу между
      // созданием бина тренировки и отправкой индекса — следующий заход
      // подхватит workoutIndex:<userId> как самостоятельный retry.
      const indexScope = `workoutIndex:${userId}`;
      dirty.add(indexScope);
      persistDirty();
      await Storage.updateBin(binIdForWorkoutIndex(userId), { items: DATA.getWorkoutIndex(userId) });
      dirty.delete(indexScope);
      persistDirty();
    }
  }

  /* ----- отложенная отправка ----- */
  function scheduleFlush(scope, delay) {
    dirty.add(scope);
    persistDirty();
    if (timers.has(scope)) clearTimeout(timers.get(scope));
    timers.set(scope, setTimeout(() => flushScope(scope), delay));
  }

  async function flushScope(scope) {
    timers.delete(scope);
    if (!Storage.isEnabled() || !navigator.onLine) return; // останется dirty, попробуем позже
    try {
      await pushScope(scope);
      dirty.delete(scope);
      persistDirty();
      if (!dirty.size) lastError = null;
    } catch (e) {
      console.warn("Sync: не удалось отправить", scope, e);
      lastError = e?.message || String(e);
      // оставляем dirty — заберёт следующий flushAll()
    }
    notifyStatus();
  }

  // Используется при гидратации: отправить локальное состояние ПЕРЕД pull
  // нужно, только если оно реально не синхронизировано (scope всё ещё в
  // dirty). Если правок не было — пуш не делаем вообще, иначе на новом
  // устройстве с пустым локальным кэшем мы бы затёрли реальные данные на
  // сервере этой самой пустотой.
  async function pushIfDirty(scope) {
    if (!dirty.has(scope)) return;
    clearTimeout(timers.get(scope));
    timers.delete(scope);
    await flushScope(scope);
  }

  function flushAll() {
    if (!Storage.isEnabled() || !navigator.onLine) return;
    Array.from(dirty).forEach(scope => {
      clearTimeout(timers.get(scope));
      timers.delete(scope);
      flushScope(scope);
    });
  }

  function notifyStatus() {
    if (typeof updateOnlineStatus === "function") updateOnlineStatus();
  }

  // Публичная точка входа, вызывается из тех же мест index.html, что и раньше
  // (раздел 8: «каждое действие сразу кладётся в очередь на отправку»).
  function push(type, payload = {}) {
    if (!Storage.isEnabled()) return; // локальный режим — синхронизировать некуда
    const userId = DATA.getCurrentUser();
    const scopes = scopesForAction(type, payload, userId);
    const delay = type.endsWith(":finish") ? FAST_DEBOUNCE_MS : DEBOUNCE_MS;
    scopes.forEach(scope => scheduleFlush(scope, delay));
    notifyStatus();
  }

  function pendingCount() { return dirty.size; }
  function getLastError() { return lastError; }

  /* ----- подтягивание данных при входе в профиль ----- */
  async function hydrateUser(userId) {
    if (!Storage.isEnabled() || !navigator.onLine) return;
    lastError = null;
    notifyStatus();

    try {
      const exercises = await Storage.readBin(CONFIG.BINS.exercises);
      if (Array.isArray(exercises) && exercises.length) DATA.saveExercises(exercises);
    } catch (e) { console.warn("Sync: pull exercises failed", e); lastError = e?.message || String(e); }

    try {
      // Дошлём то, что не успели отправить с этого устройства, — но только
      // если правки реально есть (см. pushIfDirty). На новом устройстве с
      // пустым локальным кэшем push не делаем вообще: иначе эта пустота
      // затёрла бы настоящие данные на сервере раньше, чем мы успели бы их
      // прочитать.
      await pushIfDirty(`user:${userId}`);
      const remote = await Storage.readBin(binIdForUser(userId));
      if (remote) {
        if (Array.isArray(remote.hidden)) DATA.saveHiddenIds(userId, remote.hidden);
        if (Array.isArray(remote.own)) DATA.saveOwnExercises(userId, remote.own);
        if (remote.records) DATA.saveRecords(userId, remote.records);

        // Тренировка, начатая на другом устройстве и ещё не завершённая.
        const localActive = DATA.getActiveWorkout(userId);
        if (!localActive && remote.activeWorkoutId && remote.activeWorkoutBinId) {
          const remoteWorkout = await Storage.readBin(remote.activeWorkoutBinId);
          if (remoteWorkout) {
            remoteWorkout._remoteBinId = remote.activeWorkoutBinId;
            DATA.saveActiveWorkout(userId, remoteWorkout);
          }
        }
      }
    } catch (e) { console.warn("Sync: pull user failed", e); lastError = e?.message || String(e); }

    try {
      await pushIfDirty(`templates:${userId}`);
      const remoteTpl = await Storage.readBin(binIdForTemplates(userId));
      // JSONBin не принимает пустой массив — бин засеивается как {items:[]}.
      // Принимаем оба формата: старый (массив напрямую) и новый ({items:[]}).
      const tplList = Array.isArray(remoteTpl) ? remoteTpl
        : (remoteTpl && Array.isArray(remoteTpl.items)) ? remoteTpl.items : null;
      if (tplList) DATA.saveTemplates(userId, tplList);
    } catch (e) { console.warn("Sync: pull templates failed", e); lastError = e?.message || String(e); }

    try {
      await pushIfDirty(`workoutIndex:${userId}`);
      const remoteIndex = await Storage.readBin(binIdForWorkoutIndex(userId));
      const indexList = Array.isArray(remoteIndex) ? remoteIndex
        : (remoteIndex && Array.isArray(remoteIndex.items)) ? remoteIndex.items : null;
      if (indexList) {
        DATA.saveWorkoutIndex(userId, indexList);
        await hydrateMissingWorkouts(userId, indexList);
      }
    } catch (e) { console.warn("Sync: pull workout index failed", e); lastError = e?.message || String(e); }

    notifyStatus();
  }

  async function hydrateMissingWorkouts(userId, remoteIndex, cap = HYDRATE_WORKOUT_CAP) {
    const localIds = new Set(DATA.getWorkoutHistory(userId).map(w => w.id));
    const missing = remoteIndex.filter(e => e.binId && e.finishedAt && !localIds.has(e.id)).slice(0, cap);
    let fetched = 0;
    for (const entry of missing) {
      try {
        const w = await Storage.readBin(entry.binId);
        if (!w) continue;
        w._remoteBinId = entry.binId;
        DATA.saveWorkout(userId, w);
        fetched++;
      } catch (e) { console.warn("Sync: pull workout failed", entry.id, e); }
    }
    return fetched;
  }

  // Сколько тренировок есть в индексе, но ещё не подтянуто в локальную историю
  // (хвост старше лимита гидратации). Для кнопки «Загрузить ещё».
  function missingWorkoutCount(userId) {
    const localIds = new Set(DATA.getWorkoutHistory(userId).map(w => w.id));
    return DATA.getWorkoutIndex(userId).filter(e => e.binId && e.finishedAt && !localIds.has(e.id)).length;
  }

  // Догрузить следующую пачку старых тренировок по запросу (кнопка в истории).
  // Возвращает число реально подтянутых. Индекс уже целиком локален (его бин
  // маленький и тянется при входе), поэтому берём недостающие прямо из него.
  async function loadMoreWorkouts(userId, batch = HYDRATE_WORKOUT_CAP) {
    if (!Storage.isEnabled() || !navigator.onLine) return 0;
    return await hydrateMissingWorkouts(userId, DATA.getWorkoutIndex(userId), batch);
  }

  // «Поделиться» шаблоном пишет в бин ДРУГОГО пользователя — если просто
  // скопировать локально и тут же отправить, можно затереть его реальный
  // список шаблонов устаревшей локальной копией. Поэтому сначала подтягиваем
  // актуальный список получателя, и только потом добавляем в него копию.
  async function shareTemplate(templateId, fromUserId, toUserId) {
    if (Storage.isEnabled() && navigator.onLine) {
      try {
        const remoteList = await Storage.readBin(binIdForTemplates(toUserId));
        const tplArr = Array.isArray(remoteList) ? remoteList
          : (remoteList && Array.isArray(remoteList.items)) ? remoteList.items : null;
        if (tplArr) DATA.saveTemplates(toUserId, tplArr);
      } catch (e) { console.warn("Sync: pull recipient templates before share failed", e); }
    }
    const copy = DATA.shareTemplate(templateId, fromUserId, toUserId);
    push("template:share", { templateId, toUserId });
    return copy;
  }

  async function shareExercise(exerciseId, fromUserId, toUserId) {
    if (Storage.isEnabled() && navigator.onLine) {
      try {
        const remote = await Storage.readBin(binIdForUser(toUserId));
        if (remote && Array.isArray(remote.own)) DATA.saveOwnExercises(toUserId, remote.own);
      } catch (e) { console.warn("Sync: pull recipient exercises before share failed", e); }
    }
    const result = DATA.shareExercise(exerciseId, fromUserId, toUserId);
    if (result === "shared") push("exercise:share", { toUserId });
    return result;
  }

  return { push, flush: flushAll, size: pendingCount, lastError: getLastError, hydrateUser, shareTemplate, shareExercise, loadMoreWorkouts, missingWorkoutCount };
})();
