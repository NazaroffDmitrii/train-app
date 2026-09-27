/*
 * bridge.js — мост между локальным DATA (app.js, localStorage) и облаком
 * (db.js → Supabase). Формат строк см. supabase-setup.sql §1, СПЕКА-
 * модернизация.md §5.
 *
 * ОСОЗНАННЫЙ ПОДХОД: не переписывать 40+ мест в app.js на async DB.* —
 * рендер-код, экраны, обработчики событий НЕ ТРОГАЮТСЯ вообще. DATA остаётся
 * полностью синхронным, как раньше; этот файл, загружаясь ПОСЛЕ app.js,
 * оборачивает снаружи десяток ключевых setter'ов DATA, чтобы каждая мутация
 * тихо, в фоне, зеркалилась в Supabase. Весь риск перехода сосредоточен в
 * этом одном файле. Тренировки сначала попадают в синхронный write-ahead
 * журнал, затем в локальную историю и durable-очередь IndexedDB.
 *
 * Пуш — через durable-очередь outbox.js: каждое изменение кладётся в
 * персистентный журнал (IndexedDB) и флашится в облако при наличии сети.
 * Оффлайн/ошибка сети → изменение не теряется, уходит при реконнекте или на
 * следующем старте. Журнал удаляется только после подтверждения записи в
 * IndexedDB; сбой между двумя хранилищами не теряет задание на отправку.
 */
"use strict";

const Bridge = (() => {
  const bridgeOwner = Auth.userId();
  let authProfileId = null; // profiles.id того, кто РЕАЛЬНО залогинен (автор правок)

  const PUSH_DEBOUNCE_MS = 400;

  async function ensureAuthProfileId() {
    if (authProfileId) return authProfileId;
    if (!Auth.isSignedIn()) return null;
    const owner = Auth.userId?.();
    const p = await DB.myProfile();
    if (Auth.userId?.() !== owner) return null;
    authProfileId = p?.id || null;
    // Флаг администратора общего справочника (правит Атлас на стороне всех).
    if (DATA.setAdmin) DATA.setAdmin(!!(p && p.is_admin));
    return authProfileId;
  }
  function reset() { authProfileId = null; if (DATA.setAdmin) DATA.setAdmin(false); } // на signOut, чтобы не утёк в следующую сессию на этом же устройстве

  /* ----- локальный объект тренировки ⇄ строка DB ----- */
  // data хранит ВСЁ тело локального объекта, кроме id/type/startedAt/createdBy
  // (они — отдельные колонки) — round-trip 1:1, никакой трансляции полей.
  // createdBy прокидывается в локальный объект (не только в БД), чтобы app.js
  // мог показать пометку «заполнено тренером», когда createdBy отличается от
  // текущего просматриваемого профиля (см. historyItemHtml/openDetailScreen).
  function localToRow(userId, createdBy, workout) {
    const { id, type, startedAt, createdBy: _drop, ...data } = workout;
    return {
      id, user_id: userId, created_by: createdBy,
      type: type || "strength",
      performed_at: new Date(startedAt).toISOString(),
      data,
    };
  }
  function rowToLocal(row) {
    return {
      id: row.id, type: row.type, startedAt: new Date(row.performed_at).getTime(),
      createdBy: row.created_by,
      ...(row.data || {}),
    };
  }

  /* ----- оригинальные (не обёрнутые) setter'ы DATA — ими пользуется сам мост,
     чтобы hydrate не запускал бесполезный пуш только что подтянутых данных
     обратно в облако ----- */
  const _orig = {
    saveWorkout:        DATA.saveWorkout.bind(DATA),
    updateWorkout:      DATA.updateWorkout.bind(DATA),
    deleteWorkout:       DATA.deleteWorkout.bind(DATA),
    saveWorkoutHistory: DATA.saveWorkoutHistory.bind(DATA),
    saveOwnExercises:   DATA.saveOwnExercises.bind(DATA),
    saveHiddenIds:      DATA.saveHiddenIds.bind(DATA),
    saveAllCategories:  DATA.saveAllCategories.bind(DATA),
    saveCategoryColors: DATA.saveCategoryColors.bind(DATA),
    saveExerciseOrder:  DATA.saveExerciseOrder.bind(DATA),
    saveTemplates:      DATA.saveTemplates.bind(DATA),
    saveExerciseGroups: DATA.saveExerciseGroups.bind(DATA),
    saveOwnMuscles:        DATA.saveOwnMuscles.bind(DATA),
    saveHiddenMuscleIds:   DATA.saveHiddenMuscleIds.bind(DATA),
    saveOwnMovements:      DATA.saveOwnMovements.bind(DATA),
    saveHiddenMovementIds: DATA.saveHiddenMovementIds.bind(DATA),
  };

  // Оригинальные (не обёрнутые) setter'ы «мелкого» состояния — движок синка
  // (syncengine.js) пишет ими локальные списки при восстановлении из облака,
  // ЧТОБЫ rebuild не запускал повторный push только что подтянутого. Также
  // сюда должны идти внутренние seed'ы (см. фаза 5), чтобы дефолты не утекали
  // в облако как «правки пользователя».
  window.__origSetters = {
    saveOwnExercises:   _orig.saveOwnExercises,
    saveTemplates:      _orig.saveTemplates,
    saveExerciseGroups: _orig.saveExerciseGroups,
    saveAllCategories:  _orig.saveAllCategories,
    saveCategoryColors: _orig.saveCategoryColors,
    saveExerciseOrder:  _orig.saveExerciseOrder,
    saveHiddenIds:      _orig.saveHiddenIds,
    saveOwnMuscles:        _orig.saveOwnMuscles,
    saveHiddenMuscleIds:   _orig.saveHiddenMuscleIds,
    saveOwnMovements:      _orig.saveOwnMovements,
    saveHiddenMovementIds: _orig.saveHiddenMovementIds,
  };

  /* ----- push «мелкого» состояния через пер-сущностный движок -----
     Любая правка мелкого состояния фиксируется СРАЗУ в durable-очередь
     (SyncEngine.diffAndEnqueue сравнивает с «тенью» и ставит только реально
     изменившиеся строки + надгробия), а сетевой флаш схлопывается debounce'ом.
     Пер-сущностность — ключевое: правки РАЗНОГО на разных устройствах больше не
     затирают друг друга (в отличие от прежнего блоба user_data, где «последний
     победил» целиком). */
  const _udTimers = new Map();
  function scheduleUserDataPush(userId) {
    if (!Auth.isSignedIn()) return;
    const enqueued = SyncEngine.diffAndEnqueue(userId); // Promise: IndexedDB уже подтвердил запись
    clearTimeout(_udTimers.get(userId));
    _udTimers.set(userId, setTimeout(() => {
      _udTimers.delete(userId);
      enqueued.then(() => Outbox.flush()).catch(e => {
        console.warn("Bridge: не удалось поставить изменение в очередь", e);
        if (typeof updateOnlineStatus === "function") updateOnlineStatus();
      });
    }, PUSH_DEBOUNCE_MS));
  }

  ["saveOwnExercises", "saveHiddenIds", "saveAllCategories", "saveCategoryColors", "saveExerciseOrder", "saveTemplates",
   "saveExerciseGroups", "saveOwnMuscles", "saveHiddenMuscleIds", "saveOwnMovements", "saveHiddenMovementIds"]
    .forEach(name => {
      DATA[name] = function (userId, ...rest) {
        const r = _orig[name](userId, ...rest);
        scheduleUserDataPush(userId);
        return r;
      };
    });

  /* ----- пуш тренировок (через durable outbox) ----- */
  // Проставляет createdBy В ЛОКАЛЬНЫЙ объект (не только в облачную строку),
  // best-effort, синхронно — если authProfileId уже закэширован (обычно так:
  // Bridge.hydrate резолвит его при входе в профиль ДО того, как экран
  // становится интерактивным). Даёт пометке «заполнено тренером» появиться
  // сразу в этой же сессии, не дожидаясь следующего hydrate/reload. Если поле
  // уже было выставлено раньше (правка чужой записи) — НЕ трогаем: автор
  // должен оставаться тем, кто создал запись первым, а не тем, кто её правит.
  function stampLocalCreatedBy(workout) {
    if (authProfileId && workout.createdBy === undefined) workout.createdBy = authProfileId;
  }
  function journal(userId, changes) {
    if (Auth.userId() !== bridgeOwner || Auth.contextChanged?.()) throw Error('Аккаунт изменился. Перезагрузите приложение.');
    WorkoutSafety.record(Auth.userId(), userId, changes);
  }
  function scheduleWorkouts() {
    Outbox.flush().catch(error => {
      console.warn('Workout journal: отправка отложена', error);
      if (typeof showToast === 'function') showToast('Тренировка сохранена на устройстве. Отправка отложена: ' + error.message);
    });
  }
  // Called inside Outbox's cross-tab flush lock, including after a restart.
  async function replayWorkoutJournal() {
    const owner = Auth.userId();
    if (owner !== bridgeOwner || Auth.contextChanged?.()) throw Error('Аккаунт изменился.');
    if (!WorkoutSafety.entries(owner).length) return;
    const author = await ensureAuthProfileId();
    if (!author || Auth.userId() !== owner) throw Error('Не удалось подтвердить автора тренировки.');
    const entries = WorkoutSafety.entries(owner).sort((a, b) => a.createdAt - b.createdAt);
    const histories = new Map();
    // Apply all journal changes synchronously before the first enqueue await.
    // Otherwise replay of an older batch could undo an edit made during IDB I/O.
    for (const entry of entries) {
      if (!histories.has(entry.userId)) histories.set(entry.userId, new Map(DATA.getWorkoutHistory(entry.userId).map(w => [w.id, w])));
      const history = histories.get(entry.userId);
      for (const change of entry.changes) {
        if (change.deleted) history.delete(change.id);
        else history.set(change.workout.id, change.workout);
      }
    }
    for (const [userId, history] of histories) {
      if (!_orig.saveWorkoutHistory(userId, [...history.values()])) throw Error('Не удалось восстановить локальную историю.');
    }
    for (const entry of entries) {
      for (const change of entry.changes) {
        if (Auth.userId() !== owner || Auth.contextChanged?.()) throw Error('Аккаунт изменился.');
        if (change.deleted) await Outbox.enqueueDeleteWorkout(entry.userId, change.id);
        else await Outbox.enqueueWorkout(localToRow(entry.userId, change.workout.createdBy || author, change.workout), owner);
      }
      WorkoutSafety.acknowledge(entry);
    }
  }

  DATA.saveWorkout = function (userId, workout) {
    stampLocalCreatedBy(workout);
    try { journal(userId, [{ workout }]); }
    catch (error) { console.warn('Workout journal', error); return false; }
    const ok = _orig.saveWorkout(userId, workout);
    scheduleWorkouts();
    return ok;
  };
  DATA.updateWorkout = function (userId, workout) {
    stampLocalCreatedBy(workout);
    journal(userId, [{ workout }]);
    _orig.updateWorkout(userId, workout);
    scheduleWorkouts();
  };
  DATA.deleteWorkout = function (userId, workoutId) {
    journal(userId, [{ deleted: true, id: workoutId }]);
    _orig.deleteWorkout(userId, workoutId);
    scheduleWorkouts();
  };
  // Массовая перезапись истории — редкие случаи (undo-восстановление после
  // удаления; переименование/привязка тренировок к шаблону — см. app.js
  // linkWorkoutToTemplate/renameTemplateWorkouts). Кладём каждую тренировку
  // отдельной записью в outbox (ключ wk:<id> — дедуп с индивидуальными
  // правками), потом один флаш.
  DATA.saveWorkoutHistory = function (userId, list) {
    journal(userId, list.map(workout => ({ workout })));
    const ok = _orig.saveWorkoutHistory(userId, list);
    scheduleWorkouts();
    return ok;
  };

  /* ----- hydrate: подтянуть из облака в локальный DATA при входе/переключении
     профиля. История/рекорды/Атлас — как раньше; «мелкое» состояние
     (упражнения/шаблоны/группы/категории/оверлей/порядок) теперь идёт через
     пер-сущностный движок (SyncEngine.hydrateSmallState) со слиянием по строкам,
     а не «облако затирает локальное». ----- */
  async function hydrate(userId) {
    if (!Auth.isSignedIn()) return;
    const owner = Auth.userId();
    await Outbox.flush();
    await ensureAuthProfileId();
    const historyRaw = () => localStorage.getItem(`train_history_${userId}`);
    const before = historyRaw();
    const localBefore = DATA.getWorkoutHistory(userId);
    const initialPending = await Outbox.all();
    const assertUnchanged = () => {
      if (Auth.userId() !== owner || Auth.contextChanged?.() || historyRaw() !== before || WorkoutSafety.entries(owner, userId).length) {
        throw Error('Во время загрузки появились локальные изменения. Они сохранены; повторите синхронизацию.');
      }
    };
    // История — постранично, но БЕЗ урезания: секции статистики/рекордов/
    // стриков в app.js (раздел 9) синхронно считают по ПОЛНОЙ истории.
    // Настоящий ленивый хот-кэш с ограниченным окном — Фаза 4.
    const all = await DB.pullEntities('workouts', userId);
    // Queue read failures abort the pull. Apply pending operations from both
    // sides of the request, and preserve records missing from the response.
    const pending = await Outbox.all();
    assertUnchanged();
    // Until the server has versioned tombstones, absence is NOT deletion.
    // Keep local-only records; never automatically publish them back.
    const rowsById = new Map(localBefore.map(w => [w.id, localToRow(userId, w.createdBy || authProfileId, w)]));
    all.forEach(row => rowsById.set(row.id, row));
    // Include operations present before the request, even if acknowledged
    // while that request was in flight. Fresh revisions take precedence.
    [...initialPending, ...pending].forEach(op => {
      if (op.owner !== owner) return;
      if (op.type === "saveWorkout" && op.args?.user_id === userId) {
        rowsById.set(op.args.id, op.args);
      } else if (
        op.type === "deleteWorkout" &&
        (!op.args?.userId || op.args.userId === userId)
      ) {
        // Отсутствующий userId поддерживает операции, поставленные старой
        // версией приложения до добавления профиля в аргументы удаления.
        rowsById.delete(op.args.id);
      }
    });
    const localHistory = [...rowsById.values()]
      .sort((a, b) => new Date(b.performed_at) - new Date(a.performed_at))
      .map(rowToLocal);
    if (JSON.stringify(localBefore) !== JSON.stringify(localHistory)) {
      await WorkoutSafety.backup(owner, userId, localBefore);
      assertUnchanged();
      if (!_orig.saveWorkoutHistory(userId, localHistory)) throw Error('Недостаточно места для обновления истории.');
    }
    DATA.recomputeRecords(userId);

    // Общий справочник Атласа (мышцы/движения/группы/связи/упражнения) из
    // реляционных таблиц. Подменяет локальный ATLAS (кэш + оффлайн-фолбэк на
    // atlas-seed.js). Не критичен для входа — ошибку глотаем (останется кэш/сид).
    // Если содержимое изменилось (админ правил базу с другого устройства) —
    // просим приложение перерисовать открытый экран.
    try {
      const rows = await DB.getAtlas();
      if (rows && Array.isArray(rows.muscles) && rows.muscles.length) {
        const changed = DATA.setAtlasFromRows(rows);
        if (changed && typeof window.onAtlasUpdated === "function") window.onAtlasUpdated();
      }
    } catch (e) { console.warn("Bridge.hydrate: atlas", e); }

    // «Мелкое» состояние — через пер-сущностный движок: слияние по строкам с
    // облаком (или первичное перенятие при миграции устройства). Ошибку не
    // глотаем молча — пробрасываем наверх, чтобы bootAuthAware показал тост
    // (честный статус: пользователь ДОЛЖЕН знать, если синк не прошёл).
    const res = await SyncEngine.hydrateSmallState(userId);
    // Локальные списки после слияния полные — не даём seed плодить дубликаты
    // дефолтного набора (см. DATA.ensureExercisesSeeded). Кроме случая, когда
    // облако ещё не опубликовано (awaiting-publish) — там ничего не меняли.
    if (res.mode === "merge" || res.mode === "adopted") DATA.markExercisesSeeded(userId);
    return res;
  }

  /* ----- ограничение локального следа -----
     Решает исходную боль: тренер, просматривая многих клиентов, иначе копил бы
     ВСЕ их истории в localStorage (лимит ~5 МБ) до переполнения. При входе в
     профиль keepId выкидываем из localStorage ТЯЖЁЛЫЕ ключи всех ОСТАЛЬНЫХ
     облачных (uuid) профилей — история и рекорды растут без предела. При
     возврате в такой профиль hydrate() тянет их из облака заново.

     Безопасность:
       • Не трогаем keepId (активный профиль — ему нужна полная история для
         синхронной статистики в app.js).
       • Не трогаем легаси-профили (id не uuid, напр. dima/natela): их данные
         могли ещё не мигрировать в облако — потеря была бы невосстановима.
       • Мелкие ключи (own_exercises/templates/categories/active) НЕ выкидываем:
         они ограничены и не растут с годами; active — незавершённая тренировка
         клиента, её терять нельзя.
       • Тренировки, ещё не ушедшие в облако, лежат в outbox (IndexedDB) — их
         eviction localStorage не затрагивает. */
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function evictOtherProfiles(keepId) {
    const heavyPrefixes = ["train_history_", "train_records_"];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      const pref = heavyPrefixes.find(p => k.startsWith(p));
      if (!pref) continue;
      const id = k.slice(pref.length);
      if (id === keepId || !UUID_RE.test(id)) continue; // активный или легаси — не трогаем
      try { localStorage.removeItem(k); i--; } catch {}
    }
  }

  return {
    hydrate, reset, ensureAuthProfileId, evictOtherProfiles, replayWorkoutJournal,
    get authProfileId() { return authProfileId; },
  };
})();

/* ----- авто-синхронизация при появлении сети -----
   Требование: синк сам срабатывает на «открытие + сеть + после правок».
   «После правок» — scheduleUserDataPush (debounced flush). «Открытие» —
   bootAuthAware → Bridge.hydrate. «Сеть» — здесь: при событии online делаем
   ПОЛНЫЙ синк (push+pull) текущего профиля, чтобы подтянуть и чужие изменения.
   Только для уже мигрировавшего профиля — иначе не пушим (гейт миграции). */
window.addEventListener("online", () => {
  try {
    const uid = DATA.getCurrentUser && DATA.getCurrentUser();
    if (uid && typeof Auth !== "undefined" && Auth.isSignedIn() && SyncEngine.isMigrated(uid)) {
      SyncEngine.sync(uid);
    }
  } catch (e) { console.warn("online sync", e); }
});
