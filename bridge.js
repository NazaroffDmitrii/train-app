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
 * этом одном файле — если тут баг, локальные данные (localStorage) всё равно
 * не страдают, потому что оригинальная запись всегда выполняется первой.
 *
 * Пуш — через durable-очередь outbox.js: каждое изменение кладётся в
 * персистентный журнал (IndexedDB) и флашится в облако при наличии сети.
 * Оффлайн/ошибка сети → изменение не теряется, уходит при реконнекте или на
 * следующем старте. Локальная запись (localStorage) всегда происходит ПЕРВОЙ —
 * local-first не нарушается, а outbox гарантирует, что облако рано или поздно
 * догонит локальное состояние.
 */
"use strict";

const Bridge = (() => {
  let authProfileId = null; // profiles.id того, кто РЕАЛЬНО залогинен (автор правок)

  const HISTORY_PULL_PAGE = 200;
  // Кап пагинации при hydrate — просто защита от зацикливания/бага, а не
  // реалистичный предел использования (даже тренировка каждый день десять лет
  // подряд — это ~3650 записей).
  const HISTORY_PULL_CAP = 5000;
  const PUSH_DEBOUNCE_MS = 400;

  async function ensureAuthProfileId() {
    if (authProfileId) return authProfileId;
    if (!Auth.isSignedIn()) return null;
    const p = await DB.myProfile();
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
    saveOwnMuscles:        DATA.saveOwnMuscles.bind(DATA),
    saveHiddenMuscleIds:   DATA.saveHiddenMuscleIds.bind(DATA),
    saveOwnMovements:      DATA.saveOwnMovements.bind(DATA),
    saveHiddenMovementIds: DATA.saveHiddenMovementIds.bind(DATA),
  };

  /* ----- debounced push «мелкого» состояния (упражнения/шаблоны/категории) -----
     Один блоб на профиль (user_data) — компаунд-операции (напр. renameCategory
     трогает и категории, и упражнения разом) дают несколько вызовов подряд;
     debounce схлопывает их в один запрос вместо нескольких. */
  const _udTimers = new Map();
  function scheduleUserDataPush(userId) {
    if (!Auth.isSignedIn()) return;
    // ВАЖНО: кладём правку в durable-очередь СРАЗУ (не через debounce). Раньше
    // enqueue тоже стоял за setTimeout(400ms) — и если приложение
    // перезагружалось/закрывалось в это окно (в т.ч. само, при обновлении SW),
    // правка не попадала в Outbox вообще и жила только в localStorage, а
    // следующий hydrate её стирал. Теперь состояние фиксируется мгновенно;
    // debounce остаётся только на СЕТЕВОЙ флаш — схлопнуть пачку правок в один
    // запрос. Дедуп по ключу ud:<userId> (outbox.js) — каждый вызов просто
    // перезаписывает блоб последним полным снимком локального состояния.
    Outbox.enqueueUserData(userId, {
      own_exercises:   DATA.getOwnExercises(userId),
      hidden_ids:      DATA.getHiddenIds(userId),
      categories:      DATA.getAllCategories(userId),
      category_colors: DATA.getCategoryColors(userId),
      exercise_order:  DATA.getExerciseOrder(userId),
      templates:       DATA.getTemplates(userId),
      // Личный оверлей справочника (мышцы/движения): own + hidden.
      own_muscles:         DATA.getOwnMuscles(userId),
      hidden_muscle_ids:   DATA.getHiddenMuscleIds(userId),
      own_movements:       DATA.getOwnMovements(userId),
      hidden_movement_ids: DATA.getHiddenMovementIds(userId),
    });
    clearTimeout(_udTimers.get(userId));
    _udTimers.set(userId, setTimeout(() => {
      _udTimers.delete(userId);
      Outbox.flush();
    }, PUSH_DEBOUNCE_MS));
  }

  ["saveOwnExercises", "saveHiddenIds", "saveAllCategories", "saveCategoryColors", "saveExerciseOrder", "saveTemplates",
   "saveOwnMuscles", "saveHiddenMuscleIds", "saveOwnMovements", "saveHiddenMovementIds"]
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
  function queueWorkout(userId, workout) {
    if (!Auth.isSignedIn()) return;
    if (workout.createdBy) {
      // Автор уже известен (застемплен выше или пришёл из облака при более
      // раннем hydrate) — используем его, а не текущую сессию, иначе повторная
      // правка чужой записи переписала бы created_by на редактирующего.
      Outbox.enqueueWorkout(localToRow(userId, workout.createdBy, workout)).then(() => Outbox.flush());
      return;
    }
    ensureAuthProfileId().then(createdBy => {
      if (!createdBy) return;
      Outbox.enqueueWorkout(localToRow(userId, createdBy, workout)).then(() => Outbox.flush());
    });
  }

  DATA.saveWorkout = function (userId, workout) {
    stampLocalCreatedBy(workout);
    const ok = _orig.saveWorkout(userId, workout);
    if (ok) queueWorkout(userId, workout);   // локальная запись первой; пуш — durable
    return ok;
  };
  DATA.updateWorkout = function (userId, workout) {
    stampLocalCreatedBy(workout);
    _orig.updateWorkout(userId, workout);
    queueWorkout(userId, workout);
  };
  DATA.deleteWorkout = function (userId, workoutId) {
    _orig.deleteWorkout(userId, workoutId);
    if (Auth.isSignedIn()) Outbox.enqueueDeleteWorkout(workoutId).then(() => Outbox.flush());
  };
  // Массовая перезапись истории — редкие случаи (undo-восстановление после
  // удаления; переименование/привязка тренировок к шаблону — см. app.js
  // linkWorkoutToTemplate/renameTemplateWorkouts). Кладём каждую тренировку
  // отдельной записью в outbox (ключ wk:<id> — дедуп с индивидуальными
  // правками), потом один флаш.
  DATA.saveWorkoutHistory = function (userId, list) {
    _orig.saveWorkoutHistory(userId, list);
    if (Auth.isSignedIn() && list.length) {
      ensureAuthProfileId().then(fallbackCreatedBy => {
        if (!fallbackCreatedBy) return;
        // Каждый элемент сохраняет СВОЕГО автора, если он уже известен (см.
        // stampLocalCreatedBy/queueWorkout) — иначе, как запасной вариант,
        // автором становится текущая сессия.
        Promise.all(list.map(w => Outbox.enqueueWorkout(localToRow(userId, w.createdBy || fallbackCreatedBy, w))))
          .then(() => Outbox.flush());
      });
    }
  };

  /* ----- hydrate: подтянуть из облака в локальный DATA при входе/переключении
     профиля. Заменяет локальный кэш содержимым облака (не сливает) — облако
     полагается источником истины после входа. ----- */
  async function hydrate(userId) {
    if (!Auth.isSignedIn()) return;
    await ensureAuthProfileId();

    // История — постранично, но БЕЗ урезания: секции статистики/рекордов/
    // стриков в app.js (раздел 9) синхронно считают по ПОЛНОЙ истории.
    // Настоящий ленивый хот-кэш с ограниченным окном — Фаза 4.
    let all = [];
    let before;
    for (let i = 0; i < HISTORY_PULL_CAP / HISTORY_PULL_PAGE; i++) {
      const page = await DB.listWorkouts(userId, { limit: HISTORY_PULL_PAGE, before });
      if (!page.length) break;
      all = all.concat(page);
      if (page.length < HISTORY_PULL_PAGE) break;
      before = page[page.length - 1].performed_at;
    }
    if (all.length) {
      _orig.saveWorkoutHistory(userId, all.map(rowToLocal));
      DATA.recomputeRecords(userId);
    }

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

    // ЗАЩИТА ОТ ОТКАТА: если в очереди ещё висит несинхронизированный блоб
    // user_data этого профиля (ud:<userId>) — значит ЛОКАЛЬНОЕ состояние новее
    // облака (правка не успела/не смогла уйти). В этом случае НЕ перезатираем
    // локальные упражнения/шаблоны/группы/категории облачной (устаревшей)
    // копией — иначе теряются именно те правки, что ждут отправки. Пусть их
    // сначала дошлёт flush; на следующем hydrate облако уже будет актуальным.
    // Именно отсутствие этой проверки приводило к «внезапному» откату шаблонов,
    // группировки и правок и к «осиротевшим» упражнениям в истории.
    const localUserDataAhead = await Outbox.has("ud:" + userId);
    const ud = localUserDataAhead ? null : await DB.getUserData(userId);
    if (ud) {
      if (Array.isArray(ud.own_exercises)) _orig.saveOwnExercises(userId, ud.own_exercises);
      if (Array.isArray(ud.hidden_ids))    _orig.saveHiddenIds(userId, ud.hidden_ids);
      if (Array.isArray(ud.categories) && ud.categories.length) _orig.saveAllCategories(userId, ud.categories);
      if (ud.category_colors)              _orig.saveCategoryColors(userId, ud.category_colors);
      if (ud.exercise_order !== undefined) _orig.saveExerciseOrder(userId, ud.exercise_order);
      if (Array.isArray(ud.templates))     _orig.saveTemplates(userId, ud.templates);
      // Личный оверлей справочника (мышцы/движения).
      if (Array.isArray(ud.own_muscles))         _orig.saveOwnMuscles(userId, ud.own_muscles);
      if (Array.isArray(ud.hidden_muscle_ids))   _orig.saveHiddenMuscleIds(userId, ud.hidden_muscle_ids);
      if (Array.isArray(ud.own_movements))       _orig.saveOwnMovements(userId, ud.own_movements);
      if (Array.isArray(ud.hidden_movement_ids)) _orig.saveHiddenMovementIds(userId, ud.hidden_movement_ids);
    }
    if (ud || localUserDataAhead) {
      // Личные упражнения полные (из облака ИЛИ уже локально) — не даём seed
      // заново плодить дубликаты дефолтного набора (см. ensureExercisesSeeded).
      DATA.markExercisesSeeded(userId);
    }
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
    hydrate, reset, ensureAuthProfileId, evictOtherProfiles,
    get authProfileId() { return authProfileId; },
  };
})();
