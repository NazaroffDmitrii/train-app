/*
 * sync.js — синхронизация в стиле Anki (snapshot-модель).
 *
 * Модель (осознанная замена прежней фоновой авто-синхронизации):
 *
 *   • Источник истины во время работы — ВСЕГДА это устройство (локальный DATA /
 *     localStorage). Приложение никогда само не лезет в сеть «подсмотреть» и не
 *     накатывает чужие данные молча. Это и даёт «бесшовность»: состояние меняется
 *     только когда ты сам нажал кнопку.
 *
 *   • Всё состояние пользователя хранится ОДНИМ снапшотом в одном бине
 *     (user_<id>): личные упражнения, скрытые, рекорды, шаблоны, категории и их
 *     цвета, порядок упражнений, ВСЯ история тренировок и активная тренировка.
 *     У снапшота есть монотонная version и deviceId автора.
 *
 *   • Две явные операции (кнопки в настройках):
 *       upload  («Синхронизировать»)     — выгрузить локальное состояние в облако,
 *                                           version++. После — облако = это устройство.
 *       download («Проверить обновления») — затянуть облако и ПОЛНОСТЬЮ заменить им
 *                                           локальное состояние.
 *
 *   • Конфликт (обе стороны менялись с последней синхронизации) НЕ сливается
 *     молча — пользователю показывается выбор «оставить это устройство» (upload)
 *     или «взять из облака» (download). Точно как в Anki.
 *
 * Защита от потери данных строится на версиях, а не на эвристиках:
 *   - upload отказывается затирать облако, если оно новее нашей последней
 *     синхронизации (remote.version > syncedVersion) — пока пользователь явно не
 *     подтвердит force.
 *   - download отказывается затирать локальные правки, если они есть (dirty) —
 *     пока пользователь явно не подтвердит force.
 *
 * Если JSONBin не настроен (config.js: ENABLED=false) — всё тихо no-op,
 * приложение работает как обычное local-only PWA.
 *
 * Прежняя схема (бин на тренировку, workoutIndex, rev/dirty-эвристики, фоновый
 * debounce-пуш) удалена. Старые бины тренировок остаются на сервере как мусор,
 * но больше не читаются; миграция (mergeLegacyIntoLocal) один раз собирает из них
 * полную локальную историю перед первым upload.
 */

const Sync = (() => {
  const SCHEMA = "snapshot-v1";

  /* ----- ключи локального состояния синхронизации ----- */
  function syncedVerKey(userId) { return `train_synced_version_${userId}`; }
  function dirtyKey(userId)     { return `train_local_dirty_${userId}`; }
  function syncedAtKey(userId)  { return `train_last_synced_at_${userId}`; }
  const DEVICE_KEY = "train_device_id";

  function getSyncedVersion(userId) {
    const v = Number(localStorage.getItem(syncedVerKey(userId)));
    return Number.isFinite(v) ? v : 0;
  }
  function setSyncedVersion(userId, v) {
    try { localStorage.setItem(syncedVerKey(userId), String(v)); } catch {}
  }
  function isDirty(userId) {
    return localStorage.getItem(dirtyKey(userId)) === "1";
  }
  function setDirty(userId, on) {
    try {
      if (on) localStorage.setItem(dirtyKey(userId), "1");
      else localStorage.removeItem(dirtyKey(userId));
    } catch {}
  }
  function getLastSyncedAt(userId) {
    const v = Number(localStorage.getItem(syncedAtKey(userId)));
    return Number.isFinite(v) && v > 0 ? v : null;
  }
  function setLastSyncedAt(userId) {
    try { localStorage.setItem(syncedAtKey(userId), String(Date.now())); } catch {}
  }
  function deviceId() {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = "d_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      try { localStorage.setItem(DEVICE_KEY, id); } catch {}
    }
    return id;
  }

  let lastError = null;

  /* ----- бины ----- */
  function binIdForUser(userId)      { return CONFIG.BINS[`user_${userId}`]; }
  function binIdForTemplates(userId) { return CONFIG.BINS[`templates_${userId}`]; }
  function binIdForIndex(userId)     { return CONFIG.BINS[`workoutIndex_${userId}`]; }

  /* ----- снапшот ----- */
  function isSnapshot(obj) {
    return !!(obj && obj.schema === SCHEMA && obj.data && typeof obj.version === "number");
  }

  function stripLocal(workout) {
    if (!workout) return workout;
    const { _remoteBinId, ...rest } = workout;
    return rest;
  }

  function buildSnapshot(userId, version) {
    const active = DATA.getActiveWorkout(userId);
    return {
      schema: SCHEMA,
      version,
      deviceId: deviceId(),
      updatedAt: Date.now(),
      data: {
        own:            DATA.getOwnExercises(userId),
        hidden:         DATA.getHiddenIds(userId),
        records:        DATA.getRecords(userId),
        templates:      DATA.getTemplates(userId),
        categories:     DATA.getAllCategories(userId),
        categoryColors: DATA.getCategoryColors(userId),
        exerciseOrder:  DATA.getExerciseOrder(userId),
        history:        DATA.getWorkoutHistory(userId).map(stripLocal),
        active:         active ? stripLocal(active) : null,
      },
    };
  }

  // Накатить снапшот поверх локального состояния ЦЕЛИКОМ (download-семантика:
  // облако — авторитетная копия, локальное состояние замещается).
  function applySnapshot(userId, snapshot) {
    const d = snapshot.data || {};
    if (Array.isArray(d.own))            DATA.saveOwnExercises(userId, d.own);
    if (Array.isArray(d.hidden))         DATA.saveHiddenIds(userId, d.hidden);
    if (d.records)                       DATA.saveRecords(userId, d.records);
    if (Array.isArray(d.templates))      DATA.saveTemplates(userId, d.templates);
    if (Array.isArray(d.categories))     DATA.saveAllCategories(userId, d.categories);
    if (d.categoryColors)                DATA.saveCategoryColors(userId, d.categoryColors);
    if (d.exerciseOrder !== undefined)   DATA.saveExerciseOrder(userId, d.exerciseOrder);
    if (Array.isArray(d.history))        DATA.saveWorkoutHistory(userId, d.history);
    if (d.active) DATA.saveActiveWorkout(userId, d.active);
    else          DATA.clearActiveWorkout(userId);
    // Личные упражнения в снапшоте полные — не даём seed заново плодить дубликаты.
    DATA.markExercisesSeeded(userId);
  }

  async function readSnapshot(userId) {
    return await Storage.readBin(binIdForUser(userId));
  }
  async function writeSnapshot(userId, snapshot) {
    await Storage.updateBin(binIdForUser(userId), snapshot);
  }

  /* ----- разметка «есть локальные правки» ----- */
  // Публичная точка входа push(type, payload) сохранена ради всех вызовов
  // SyncQueue.push(...) по экранам: теперь действие просто помечает локальное
  // состояние изменённым (dirty), а не планирует фоновую отправку.
  function push(/* type, payload */) {
    if (!Storage.isEnabled()) return;
    const userId = DATA.getCurrentUser();
    if (!userId) return;
    setDirty(userId, true);
    notifyStatus();
  }

  function notifyStatus() {
    if (typeof updateOnlineStatus === "function") updateOnlineStatus();
  }

  /* ----- миграция со старой схемы (бин на тренировку + отдельные бины) ----- */
  function unionById(localArr, remoteArr) {
    const seen = new Set((localArr || []).map(x => x && x.id));
    const out = [...(localArr || [])];
    (remoteArr || []).forEach(x => { if (x && x.id && !seen.has(x.id)) { seen.add(x.id); out.push(x); } });
    return out;
  }

  // Один раз (когда syncedVersion === 0) собирает в локальный DATA всё, что
  // лежало в старых бинах, чтобы первый снапшот был полным независимо от того,
  // с какого устройства его выгружают. Только union (ничего не удаляет).
  async function mergeLegacyIntoLocal(userId) {
    // Личные упражнения / скрытые из старого user-бина.
    try {
      const legacy = await readSnapshot(userId);
      if (legacy && !isSnapshot(legacy)) {
        if (Array.isArray(legacy.own))    DATA.saveOwnExercises(userId, unionById(DATA.getOwnExercises(userId), legacy.own));
        if (Array.isArray(legacy.hidden)) {
          const merged = Array.from(new Set([...(DATA.getHiddenIds(userId) || []), ...legacy.hidden]));
          DATA.saveHiddenIds(userId, merged);
        }
      }
    } catch (e) { console.warn("Sync.migrate: user bin", e); }

    // Шаблоны из старого templates-бина.
    try {
      const tpl = await Storage.readBin(binIdForTemplates(userId));
      const list = Array.isArray(tpl) ? tpl : (tpl && Array.isArray(tpl.items)) ? tpl.items : null;
      if (list) DATA.saveTemplates(userId, unionById(DATA.getTemplates(userId), list));
    } catch (e) { console.warn("Sync.migrate: templates bin", e); }

    // История: индекс + бин на тренировку.
    try {
      const idx = await Storage.readBin(binIdForIndex(userId));
      const entries = Array.isArray(idx) ? idx : (idx && Array.isArray(idx.items)) ? idx.items : null;
      if (entries) {
        const localIds = new Set(DATA.getWorkoutHistory(userId).map(w => w.id));
        for (const e of entries) {
          if (!e || !e.binId || !e.finishedAt || localIds.has(e.id)) continue;
          try {
            const w = await Storage.readBin(e.binId);
            if (w) { DATA.saveWorkout(userId, stripLocal(w)); localIds.add(w.id); }
          } catch (err) { console.warn("Sync.migrate: workout bin", e.id, err); }
        }
        // История пополнилась — пересчитываем рекорды из полной локальной истории.
        DATA.recomputeRecords(userId);
      }
    } catch (e) { console.warn("Sync.migrate: index bin", e); }
  }

  /* ----- upload: «Синхронизировать» (выгрузить это устройство в облако) ----- */
  async function upload(userId, { force = false } = {}) {
    if (!Storage.isEnabled()) return { status: "disabled" };
    if (!navigator.onLine)    return { status: "offline" };
    lastError = null;
    try {
      const remote = await readSnapshot(userId);
      const remoteVersion = isSnapshot(remote) ? remote.version : 0;
      const syncedVersion = getSyncedVersion(userId);

      // Облако новее нашей последней синхронизации — менялось на другом
      // устройстве. Не затираем без явного подтверждения.
      if (!force && remoteVersion > syncedVersion) {
        return { status: "conflict", direction: "upload", remoteVersion, syncedVersion };
      }

      // Первый выгруз с этого устройства: подтянуть данные из старых бинов,
      // чтобы снапшот был полным (one-time миграция).
      if (syncedVersion === 0 && !isSnapshot(remote)) {
        await mergeLegacyIntoLocal(userId);
      }

      const newVersion = Math.max(remoteVersion, syncedVersion) + 1;
      await writeSnapshot(userId, buildSnapshot(userId, newVersion));
      setSyncedVersion(userId, newVersion);
      setDirty(userId, false);
      setLastSyncedAt(userId);
      notifyStatus();
      return { status: "ok", version: newVersion };
    } catch (e) {
      lastError = e?.message || String(e);
      notifyStatus();
      return { status: "error", error: lastError };
    }
  }

  /* ----- download: «Проверить обновления» (затянуть облако в это устройство) - */
  async function download(userId, { force = false } = {}) {
    if (!Storage.isEnabled()) return { status: "disabled" };
    if (!navigator.onLine)    return { status: "offline" };
    lastError = null;
    try {
      const remote = await readSnapshot(userId);
      if (!isSnapshot(remote)) return { status: "empty" }; // в облаке ещё нет снапшота

      const syncedVersion = getSyncedVersion(userId);
      if (remote.version <= syncedVersion && !force) {
        return { status: "up_to_date" };
      }

      // На устройстве есть несинхронизированные правки — не теряем их без спроса.
      if (!force && isDirty(userId)) {
        return { status: "conflict", direction: "download", remoteVersion: remote.version, syncedVersion };
      }

      applySnapshot(userId, remote);
      setSyncedVersion(userId, remote.version);
      setDirty(userId, false);
      setLastSyncedAt(userId);
      notifyStatus();
      return { status: "ok", version: remote.version };
    } catch (e) {
      lastError = e?.message || String(e);
      notifyStatus();
      return { status: "error", error: lastError };
    }
  }

  /* ----- «Поделиться» с другим пользователем ----- */
  // Записываем прямо в снапшот получателя: читаем его, добавляем элемент,
  // version++. Best-effort — рассчитано на то, что получатель в этот момент не
  // редактирует свой профиль (два доверенных пользователя, раздел 2 спеки).
  async function pushSharedItem(toUserId, mutate) {
    if (!Storage.isEnabled() || !navigator.onLine) return;
    try {
      const remote = await readSnapshot(toUserId);
      if (isSnapshot(remote)) {
        mutate(remote.data);
        remote.version = remote.version + 1;
        remote.deviceId = deviceId();
        remote.updatedAt = Date.now();
        await writeSnapshot(toUserId, remote);
        // Если получатель — текущий профиль на этом устройстве, держим synced
        // version в согласии, чтобы он потом не словил ложный конфликт.
        if (DATA.getCurrentUser() === toUserId) setSyncedVersion(toUserId, remote.version);
      }
    } catch (e) { console.warn("Sync.pushSharedItem failed", e); }
  }

  async function shareTemplate(templateId, fromUserId, toUserId) {
    const copy = DATA.shareTemplate(templateId, fromUserId, toUserId);
    if (copy) await pushSharedItem(toUserId, data => {
      if (Array.isArray(data.templates)) data.templates = unionById(data.templates, [copy]);
    });
    return copy;
  }

  async function shareExercise(exerciseId, fromUserId, toUserId) {
    const result = DATA.shareExercise(exerciseId, fromUserId, toUserId);
    if (result === "shared") {
      const added = DATA.getOwnExercises(toUserId);
      const copy = added[added.length - 1];
      await pushSharedItem(toUserId, data => {
        if (Array.isArray(data.own) && copy) data.own = unionById(data.own, [copy]);
      });
    }
    return result;
  }

  /* ----- статус для индикатора ----- */
  function pendingCount() {
    const userId = DATA.getCurrentUser();
    return userId && isDirty(userId) ? 1 : 0;
  }
  function getLastError() { return lastError; }

  /* ----- совместимость со старым API (вызовы из app.js) ----- */
  // В snapshot-модели вся история локальна после download — ленивой догрузки нет.
  function missingWorkoutCount() { return 0; }
  async function loadMoreWorkouts() { return 0; }
  // Авто-гидратации при входе больше нет (Anki-модель — только вручную).
  async function hydrateUser() { return; }
  // Фоновой отправки нет — flush больше ничего не шлёт, просто обновляет статус.
  function flush() { notifyStatus(); }

  return {
    push, flush, size: pendingCount, lastError: getLastError,
    upload, download, isDirty: () => { const u = DATA.getCurrentUser(); return !!(u && isDirty(u)); },
    syncedVersion: getSyncedVersion, lastSyncedAt: getLastSyncedAt,
    shareTemplate, shareExercise,
    hydrateUser, loadMoreWorkouts, missingWorkoutCount,
  };
})();
