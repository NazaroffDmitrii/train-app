"use strict";

function escHtml(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

Storage.configure({
  enabled: CONFIG.ENABLED,
  baseUrl: CONFIG.SUPABASE_URL,
  apiKey:  CONFIG.SUPABASE_KEY,
});

/* ==========================================================================
   DATA — адаптер (localStorage-заглушка).
   Структура намеренно спроектирована под будущую замену на IndexedDB +
   JSONBin-очередь (спецификация, раздел 8): имена методов не изменятся.
   ========================================================================== */

const DATA = (() => {
  const USERS = [
    { id: "dima",   name: "Dima",   avatarClass: "dima",   initial: "D" },
    { id: "natela", name: "Natela", avatarClass: "natela", initial: "N" },
  ];

  // Библиотека упражнений — общий пул.
  // owner: null = общее (видно всем, можно скрыть у себя, нельзя удалить — только скрыть).
  // type: "strength" | "run" — на будущее для фильтрации (раздел 4 спеки).
  const DEFAULT_EXERCISES = [
    { id: "e_squat",      name: "Приседания со штангой",     cat: "Ноги",   type: "strength", owner: null },
    { id: "e_deadlift",   name: "Становая тяга",             cat: "Спина",  type: "strength", owner: null },
    { id: "e_bench",      name: "Жим лёжа",                  cat: "Грудь",  type: "strength", owner: null },
    { id: "e_ohp",        name: "Жим стоя",                  cat: "Плечи",  type: "strength", owner: null },
    { id: "e_row",        name: "Тяга штанги в наклоне",     cat: "Спина",  type: "strength", owner: null },
    { id: "e_pullup",     name: "Подтягивания",              cat: "Спина",  type: "strength", owner: null },
    { id: "e_dip",        name: "Отжимания на брусьях",      cat: "Грудь",  type: "strength", owner: null },
    { id: "e_curl",       name: "Сгибание на бицепс",        cat: "Руки",   type: "strength", owner: null },
    { id: "e_tricep",     name: "Разгибание на трицепс",     cat: "Руки",   type: "strength", owner: null },
    { id: "e_lunge",      name: "Выпады",                    cat: "Ноги",   type: "strength", owner: null },
    { id: "e_rdl",        name: "Румынская тяга",            cat: "Ноги",   type: "strength", owner: null },
    { id: "e_press_inc",  name: "Жим гантелей на наклонной", cat: "Грудь", type: "strength", owner: null },
    { id: "e_fly",        name: "Разводка гантелей",         cat: "Грудь",  type: "strength", owner: null },
    { id: "e_lat",        name: "Тяга блока сверху",         cat: "Спина",  type: "strength", owner: null },
    { id: "e_calf",       name: "Подъём на носки",           cat: "Ноги",   type: "strength", owner: null },
    { id: "e_plank",      name: "Планка",                    cat: "Кор",    type: "strength", owner: null },
    { id: "e_crunch",     name: "Скручивания",               cat: "Кор",    type: "strength", owner: null },
    { id: "e_run",        name: "Бег",                       cat: "Кардио", type: "run",      owner: null },
  ];

  const EXERCISE_CATEGORIES = ["Ноги", "Спина", "Грудь", "Плечи", "Руки", "Кор", "Кардио", "Другое"];

  // Палитра цветных меток категорий. Пользователь выбирает цвет вручную (см.
  // setCategoryColor); пока он не выбран, цвет берётся из палитры по индексу
  // категории в общем списке — так список выглядит цветным сразу, без правок.
  // HSL → #hex (h в градусах, s/l в долях 0..1).
  function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    const f = n => {
      const k = (n + h * 12) % 12;
      const a = s * Math.min(l, 1 - l);
      const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(255 * c).toString(16).padStart(2, "0");
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  }

  // Цвет категории по её позиции в списке. Вместо радуги/фиксированного списка —
  // плавный ход оттенка внутри «фиолетовой» полосы (индиго → фиолетовый →
  // магента и обратно) при постоянной насыщенности/светлоте. Считается формулой,
  // поэтому новые категории продолжают ту же плавную тенденцию, а существующие
  // не перекрашиваются. «Пинг-понг» по краям полосы — чтобы не было резкого
  // скачка оттенка при переходе через границу.
  const CAT_HUE_LO = 224, CAT_HUE_HI = 292;  // границы «фиолетового» семейства
  const CAT_HUE_STEP = 12;                    // шаг оттенка на одну категорию
  function categoryColor(idx) {
    if (!(idx >= 0)) idx = 0;
    const span = CAT_HUE_HI - CAT_HUE_LO;
    const pos = (idx * CAT_HUE_STEP) % (2 * span);
    const hue = pos <= span ? CAT_HUE_LO + pos : CAT_HUE_HI - (pos - span);
    return hslToHex(hue, 0.78, 0.72);
  }

  const RPE_LABELS = {
    1: "Совсем легко",   2: "Очень легко",   3: "Легко",
    4: "Умеренно",       5: "Средне",        6: "Чуть тяжело",
    7: "Тяжело",         8: "Очень тяжело",  9: "Почти отказ",
    10: "Отказ",
  };

  // In-memory кэш разобранного localStorage: геттеры DATA дёргаются в циклах
  // рендера десятки раз за кадр, и каждый JSON.parse заметно стоил на длинной
  // истории. Все записи идут через lsSet/lsRemove, поэтому кэш не расходится с
  // localStorage. Дефолт (когда ключа нет) НЕ кэшируем — это часто общая
  // константа (DEFAULT_EXERCISES), её нельзя отдавать как мутируемую копию.
  // Рабочие мышцы упражнения делятся на 4 роли. Храним как объект строк
  // (через запятую). Поле раздела показываем в деталях только если оно
  // заполнено (см. рендер деталей). Порядок ролей фиксирован — MUSCLE_ROLES.
  function normMuscles(m) {
    m = m || {};
    return {
      agonists:     (m.agonists     || "").trim(),
      synergists:   (m.synergists   || "").trim(),
      stabilizers:  (m.stabilizers  || "").trim(),
      distributors: (m.distributors || "").trim(),
    };
  }
  // Пошаговая техника — массив непустых строк.
  function normSteps(steps) {
    if (!Array.isArray(steps)) return [];
    return steps.map(s => (s || "").trim()).filter(Boolean);
  }

  const _cache = new Map();
  function ls(key, fallback = null) {
    if (_cache.has(key)) return _cache.get(key);
    try {
      const r = localStorage.getItem(key);
      if (r === null) return fallback;
      const v = JSON.parse(r);
      _cache.set(key, v);
      return v;
    } catch { return fallback; }
  }
  // true — записано, false — не удалось (например, переполнено хранилище).
  // Вызывающий код, для которого потеря данных критична (завершение тренировки),
  // обязан проверять результат и не делать необратимых шагов при false.
  function lsSet(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
      _cache.set(key, val);
      return true;
    } catch (e) {
      if (e instanceof DOMException) document.dispatchEvent(new CustomEvent("storage-full"));
      return false;
    }
  }
  function lsRemove(key) {
    try { localStorage.removeItem(key); } catch {}
    _cache.delete(key);
  }

  return {
    USERS,
    DEFAULT_EXERCISES,
    EXERCISE_CATEGORIES,
    categoryColor,
    RPE_LABELS,

    // Общий пул (без личных и без учёта скрытия) — низкоуровневый доступ
    getExercises() {
      return ls("train_exercises", DEFAULT_EXERCISES);
    },
    saveExercises(list) { lsSet("train_exercises", list); },

    // Личные упражнения пользователя
    getOwnExercises(userId) { return ls(`train_own_exercises_${userId}`, []); },
    saveOwnExercises(userId, list) { lsSet(`train_own_exercises_${userId}`, list); },

    // Категории упражнений — личный, полностью редактируемый пользователем
    // список (п.5: цель — настроить приложение целиком под себя, включая
    // встроенные категории). При первом обращении список инициализируется
    // встроенным набором плюс ранее добавленные кастомные категории из старого
    // формата, дальше живёт как обычный массив. Настройка локальная и не
    // синхронизируется между профилями — у каждого своя база упражнений,
    // поэтому расхождений между Димой и Нателой не возникает.
    getAllCategories(userId) {
      const key = `train_categories_${userId}`;
      const stored = ls(key, null);
      if (Array.isArray(stored)) return stored;
      const legacyCustom = ls(`train_custom_categories_${userId}`, []);
      const init = [...EXERCISE_CATEGORIES, ...legacyCustom.filter(c => !EXERCISE_CATEGORIES.includes(c))];
      lsSet(key, init);
      return init;
    },
    saveAllCategories(userId, list) { lsSet(`train_categories_${userId}`, list); },

    // Цвета меток категорий — личная карта { имя: "#hex" }. Если цвет не задан,
    // getCategoryColor отдаёт дефолт из палитры по позиции категории в списке.
    getCategoryColors(userId) { return ls(`train_category_colors_${userId}`, {}); },
    // Перезаписать карту цветов целиком — нужно слою синхронизации (snapshot).
    saveCategoryColors(userId, map) { lsSet(`train_category_colors_${userId}`, map || {}); },
    getCategoryColor(userId, name) {
      const map = this.getCategoryColors(userId);
      if (map[name]) return map[name];
      const idx = this.getAllCategories(userId).indexOf(name);
      return categoryColor(idx);
    },
    setCategoryColor(userId, name, color) {
      const map = { ...this.getCategoryColors(userId), [name]: color };
      lsSet(`train_category_colors_${userId}`, map);
    },

    addCategory(userId, name) {
      name = (name || "").trim();
      if (!name) return null;
      const list = this.getAllCategories(userId);
      if (!list.includes(name)) { list.push(name); this.saveAllCategories(userId, list); }
      return name;
    },
    renameCategory(userId, oldName, newName) {
      newName = (newName || "").trim();
      if (!newName || newName === oldName) return false;
      const list = this.getAllCategories(userId);
      const idx = list.indexOf(oldName);
      if (idx === -1) return false;
      // Если такое имя уже есть — сливаем (убираем дубликат), иначе переименовываем.
      if (list.includes(newName)) list.splice(idx, 1);
      else list[idx] = newName;
      this.saveAllCategories(userId, list);
      const own = this.getOwnExercises(userId);
      own.forEach(e => { if (e.cat === oldName) e.cat = newName; });
      this.saveOwnExercises(userId, own);
      // Переносим цвет метки на новое имя (если у старого он был задан явно).
      const colors = this.getCategoryColors(userId);
      if (colors[oldName] && !colors[newName]) {
        colors[newName] = colors[oldName];
        delete colors[oldName];
        lsSet(`train_category_colors_${userId}`, colors);
      }
      return true;
    },
    deleteCategory(userId, name) {
      const list = this.getAllCategories(userId).filter(c => c !== name);
      this.saveAllCategories(userId, list);
      const colors = this.getCategoryColors(userId);
      if (colors[name]) { delete colors[name]; lsSet(`train_category_colors_${userId}`, colors); }
      // Упражнения из удалённой категории переносим в существующий фолбэк,
      // чтобы они не выпали из фильтров.
      const fallback = list.includes("Другое") ? "Другое" : (list[0] || "Другое");
      const own = this.getOwnExercises(userId);
      own.forEach(e => { if (e.cat === name) e.cat = fallback; });
      this.saveOwnExercises(userId, own);
      return true;
    },

    // ID общих упражнений, скрытых конкретным пользователем
    getHiddenIds(userId) { return ls(`train_hidden_${userId}`, []); },
    saveHiddenIds(userId, list) { lsSet(`train_hidden_${userId}`, list); },

    // Полный список упражнений пользователя — стартовый набор + добавленные им.
    getVisibleExercises(userId) {
      this.ensureExercisesSeeded(userId);
      return this.getOwnExercises(userId);
    },

    // Скопировать стартовый набор в личный список пользователя, если ещё не сделано.
    // Запускается один раз при первом открытии экрана упражнений после перехода на
    // архитектуру «у каждого своя база».
    ensureExercisesSeeded(userId) {
      if (ls(`train_exercises_seeded_${userId}`)) return false;
      const own = this.getOwnExercises(userId);
      const existingNames = new Set(own.map(e => e.name.toLowerCase()));
      const toAdd = DEFAULT_EXERCISES
        .filter(e => !existingNames.has(e.name.toLowerCase()))
        .map(e => ({ ...e, owner: userId }));
      if (toAdd.length) this.saveOwnExercises(userId, [...toAdd, ...own]);
      lsSet(`train_exercises_seeded_${userId}`, true);
      return true; // первый запуск — нужно запушить в remote
    },

    // Пометить набор упражнений как уже засеянный — вызывается слоем синхронизации
    // после применения снапшота из облака: личные упражнения там полные, и
    // повторный seed дефолтов только создал бы дубликаты.
    markExercisesSeeded(userId) { lsSet(`train_exercises_seeded_${userId}`, true); },

    // Поделиться упражнением с другим пользователем — копия по значению,
    // независимая от оригинала. Возвращает 'shared' | 'duplicate' | 'not_found'.
    shareExercise(exerciseId, fromUserId, toUserId) {
      this.ensureExercisesSeeded(fromUserId);
      const ex = this.getOwnExercises(fromUserId).find(e => e.id === exerciseId);
      if (!ex) return "not_found";
      this.ensureExercisesSeeded(toUserId);
      const toList = this.getOwnExercises(toUserId);
      const nameLow = ex.name.toLowerCase().trim();
      if (toList.some(e => e.name.toLowerCase().trim() === nameLow)) return "duplicate";
      const copy = { ...ex, id: `e_own_${toUserId}_${Date.now()}`, owner: toUserId };
      this.saveOwnExercises(toUserId, [...toList, copy]);
      return "shared";
    },

    // Добавить новое упражнение. owner=null недоступно из UI пользователя —
    // личные всегда создаются с owner=userId (раздел 4: "добавить свои уникальные").
    addExercise(userId, { name, cat, type, emoji, media, muscles, steps, tip }) {
      const list = this.getOwnExercises(userId);
      const ex = {
        id: `e_own_${userId}_${Date.now()}`,
        name: name.trim(),
        cat: cat || "Другое",
        type: type === "run" ? "run" : "strength",
        owner: userId,
        media: (media || "").trim(),
        muscles: normMuscles(muscles),
        steps: normSteps(steps),
        tip: (tip || "").trim(),
      };
      list.push(ex);
      this.saveOwnExercises(userId, list);
      return ex;
    },

    // Редактирование: только своих личных упражнений (общие — общий CRUD, не в этой версии).
    updateOwnExercise(userId, exerciseId, patch) {
      const list = this.getOwnExercises(userId);
      const ex = list.find(e => e.id === exerciseId);
      if (!ex) return null;
      if (patch.name !== undefined) ex.name = patch.name.trim();
      if (patch.cat !== undefined) ex.cat = patch.cat;
      if (patch.type !== undefined) ex.type = patch.type;
      if (patch.emoji !== undefined) ex.emoji = patch.emoji;
      if (patch.media !== undefined) ex.media = (patch.media || "").trim();
      if (patch.muscles !== undefined) ex.muscles = normMuscles(patch.muscles);
      if (patch.steps !== undefined) ex.steps = normSteps(patch.steps);
      if (patch.tip !== undefined) ex.tip = (patch.tip || "").trim();
      this.saveOwnExercises(userId, list);
      return ex;
    },

    // Удаление: только своё личное. Общее упражнение нельзя удалить — только скрыть у себя (раздел 3, 4).
    deleteOwnExercise(userId, exerciseId) {
      const list = this.getOwnExercises(userId);
      this.saveOwnExercises(userId, list.filter(e => e.id !== exerciseId));
    },

    getExerciseOrder(userId) { return ls(`train_ex_order_${userId}`, null); },
    saveExerciseOrder(userId, ids) { lsSet(`train_ex_order_${userId}`, ids); },

    // Скрыть/показать общее упражнение у конкретного пользователя (не удаляет у других — раздел 3).
    hideExercise(userId, exerciseId) {
      const hidden = this.getHiddenIds(userId);
      if (!hidden.includes(exerciseId)) hidden.push(exerciseId);
      this.saveHiddenIds(userId, hidden);
    },
    unhideExercise(userId, exerciseId) {
      this.saveHiddenIds(userId, this.getHiddenIds(userId).filter(id => id !== exerciseId));
    },
    isHidden(userId, exerciseId) {
      return this.getHiddenIds(userId).includes(exerciseId);
    },

    getCurrentUser() { return ls("train_current_user"); },
    setCurrentUser(id) { lsSet("train_current_user", id); },
    clearCurrentUser() { lsRemove("train_current_user"); },

    // Активная тренировка — хранится целиком, переживает навигацию
    getActiveWorkout(userId) { return ls(`train_active_${userId}`); },
    saveActiveWorkout(userId, workout) { lsSet(`train_active_${userId}`, workout); },
    clearActiveWorkout(userId) { lsRemove(`train_active_${userId}`); },

    startWorkout(userId, type) {
      const workout = {
        id: `w_${Date.now()}`,
        type,
        name: type === "run" ? "Пробежка" : "Силовая тренировка",
        startedAt: Date.now(),
        exercises: [],
      };
      lsSet(`train_active_${userId}`, workout);
      return workout;
    },

    // История тренировок
    // Всегда отдаём копию, отсортированную от новых к старым (по дате начала) —
    // порядок отображения гарантирован везде, где читают историю.
    getWorkoutHistory(userId) { return [...ls(`train_history_${userId}`, [])].sort((a, b) => b.startedAt - a.startedAt); },
    // Перезаписать историю целиком — для отката удаления (undo).
    saveWorkoutHistory(userId, list) { return lsSet(`train_history_${userId}`, list); },
    // Возвращает true/false — записалось ли. Вызывающий (doFinishWorkout)
    // обязан не очищать активную тренировку, если сюда вернулся false.
    saveWorkout(userId, workout) {
      const history = ls(`train_history_${userId}`, []);
      history.unshift(workout); // новые сверху
      return lsSet(`train_history_${userId}`, history);
    },

    // Точечно обновить уже существующую тренировку (активную или в истории) —
    // используется sync.js, чтобы проставить id удалённого bin'а после его
    // создания, не трогая остальную структуру (раздел 8 спецификации).
    updateWorkoutInPlace(userId, workout) {
      const active = this.getActiveWorkout(userId);
      if (active && active.id === workout.id) { this.saveActiveWorkout(userId, workout); return; }
      const history = ls(`train_history_${userId}`, []);
      const idx = history.findIndex(w => w.id === workout.id);
      if (idx !== -1) { history[idx] = workout; lsSet(`train_history_${userId}`, history); }
    },

    // Лёгкий индекс тренировок — id + ссылка на удалённый bin + сводка для
    // списка истории. Раздел 8: «отдельный бин на каждую тренировку» —
    // индекс нужен, чтобы знать, какие бины вообще существуют, не вычитывая
    // содержимое каждой тренировки целиком.
    getWorkoutIndex(userId) { return ls(`train_workout_index_${userId}`, []); },
    saveWorkoutIndex(userId, list) { lsSet(`train_workout_index_${userId}`, list); },
    deleteWorkout(userId, workoutId) {
      const history = ls(`train_history_${userId}`, []);
      lsSet(`train_history_${userId}`, history.filter(w => w.id !== workoutId));
      const index = this.getWorkoutIndex(userId);
      this.saveWorkoutIndex(userId, index.filter(e => e.id !== workoutId));
    },

    updateWorkout(userId, workout) {
      const history = ls(`train_history_${userId}`, []);
      const idx = history.findIndex(w => w.id === workout.id);
      if (idx !== -1) { history[idx] = workout; lsSet(`train_history_${userId}`, history); }
      const index = this.getWorkoutIndex(userId);
      const idxI = index.findIndex(e => e.id === workout.id);
      if (idxI !== -1) {
        index[idxI].name = workout.name;
        if (workout.durationSec != null) index[idxI].durationSec = workout.durationSec;
        this.saveWorkoutIndex(userId, index);
      }
    },

    // Рекорды по упражнению для пользователя
    getRecords(userId) { return ls(`train_records_${userId}`, {}); },
    saveRecords(userId, recs) { lsSet(`train_records_${userId}`, recs); },
    updateRecords(userId, workout) {
      if (workout.type !== "strength") return;
      const recs = ls(`train_records_${userId}`, {});
      (workout.exercises || []).forEach(ex => {
        const exVol = ex.sets.filter(s => s.done).reduce((a, s) => a + (s.weight || 0) * (s.reps || 0), 0);
        ex.sets.filter(s => s.done && s.weight > 0 && s.reps > 0).forEach(s => {
          if (!recs[ex.exerciseId]) recs[ex.exerciseId] = { maxWeight: 0, repsAtMaxWeight: 0, maxReps: 0, weightAtMaxReps: 0, maxVolume: 0 };
          const r = recs[ex.exerciseId];
          if (s.weight > r.maxWeight || (s.weight === r.maxWeight && s.reps > r.repsAtMaxWeight)) {
            r.maxWeight = s.weight; r.repsAtMaxWeight = s.reps;
          }
          if (s.reps > r.maxReps || (s.reps === r.maxReps && s.weight > r.weightAtMaxReps)) {
            r.maxReps = s.reps; r.weightAtMaxReps = s.weight;
          }
        });
        if (recs[ex.exerciseId]) recs[ex.exerciseId].maxVolume = Math.max(recs[ex.exerciseId].maxVolume || 0, exVol);
      });
      lsSet(`train_records_${userId}`, recs);
    },
    getExerciseRecord(userId, exerciseId) {
      return (ls(`train_records_${userId}`, {}))[exerciseId] || null;
    },
    // Полный пересчёт рекордов из истории — после удаления/правки тренировки,
    // иначе рекорд от удалённой тренировки висел бы вечно (updateRecords только
    // повышает максимумы). Вызывать ТОЛЬКО когда локальная история полная
    // (Sync.missingWorkoutCount === 0): иначе можно занизить настоящий рекорд из
    // ещё не подтянутой старой тренировки. Гейт — на стороне вызова.
    recomputeRecords(userId) {
      const recs = {};
      this.getWorkoutHistory(userId).forEach(w => {
        if (w.type !== "strength") return;
        (w.exercises || []).forEach(ex => {
          const exVol = ex.sets.filter(s => s.done).reduce((a, s) => a + (s.weight || 0) * (s.reps || 0), 0);
          ex.sets.filter(s => s.done && s.weight > 0 && s.reps > 0).forEach(s => {
            if (!recs[ex.exerciseId]) recs[ex.exerciseId] = { maxWeight: 0, repsAtMaxWeight: 0, maxReps: 0, weightAtMaxReps: 0, maxVolume: 0 };
            const r = recs[ex.exerciseId];
            if (s.weight > r.maxWeight || (s.weight === r.maxWeight && s.reps > r.repsAtMaxWeight)) { r.maxWeight = s.weight; r.repsAtMaxWeight = s.reps; }
            if (s.reps > r.maxReps || (s.reps === r.maxReps && s.weight > r.weightAtMaxReps)) { r.maxReps = s.reps; r.weightAtMaxReps = s.weight; }
          });
          if (recs[ex.exerciseId]) recs[ex.exerciseId].maxVolume = Math.max(recs[ex.exerciseId].maxVolume || 0, exVol);
        });
      });
      this.saveRecords(userId, recs);
      return recs;
    },

    // Дефолт таймера отдыха — девайс-настройка, запоминается между тренировками.
    getRestDefault() { const v = ls("train_rest_default", 90); return (typeof v === "number" && v > 0) ? v : 90; },
    setRestDefault(sec) { lsSet("train_rest_default", sec); },

    // Последняя тренировка, в которой встречалось данное упражнение
    getLastWorkoutForExercise(userId, exerciseId) {
      const history = this.getWorkoutHistory(userId);
      return history.find(w => w.type === "strength" && (w.exercises || []).some(e => e.exerciseId === exerciseId)) || null;
    },

    // Прогресс рабочего веса по упражнению во времени (раздел 9.2: график по тапу на упражнение).
    // За значение тренировки берётся лучший выполненный подход (макс. вес, при равенстве — больше повторов).
    getExerciseProgress(userId, exerciseId) {
      const history = this.getWorkoutHistory(userId)
        .filter(w => w.type === "strength" && (w.exercises || []).some(e => e.exerciseId === exerciseId));
      const points = history.map(w => {
        const block = w.exercises.find(e => e.exerciseId === exerciseId);
        const doneSets = block.sets.filter(s => s.done && s.weight > 0 && s.reps > 0);
        if (!doneSets.length) return null;
        const top = doneSets.reduce((a, b) => (b.weight > a.weight || (b.weight === a.weight && b.reps > a.reps)) ? b : a);
        return { date: w.startedAt, weight: top.weight, reps: top.reps };
      }).filter(Boolean);
      points.sort((a, b) => a.date - b.date);
      return points;
    },

    // Упражнения, по которым есть хотя бы один рекорд — для списка в статистике (раздел 9.2).
    getExercisesWithRecords(userId) {
      const recs = this.getRecords(userId);
      const visible = this.getVisibleExercises(userId);
      return Object.keys(recs).map(id => {
        const ex = visible.find(e => e.id === id) || { id, name: id };
        return { id: ex.id, name: ex.name, record: recs[id] };
      });
    },

    // Прогресс пробежек во времени: дистанция и темп (раздел 9.2).
    getRunProgress(userId) {
      const history = this.getWorkoutHistory(userId).filter(w => w.type === "run" && w.distance);
      const points = history.map(w => ({
        date: w.startedAt,
        distance: w.distance,
        paceSec: w.pace ? paceStrToSec(w.pace) : null,
      }));
      points.sort((a, b) => a.date - b.date);
      return points;
    },

    // Сводные рекорды по бегу: суммарно + лучшая дистанция + лучший темп.
    getRunSummary(userId) {
      const points = this.getRunProgress(userId);
      if (!points.length) return null;
      const totalDistance = points.reduce((s, p) => s + p.distance, 0);
      const bestDistancePoint = points.reduce((a, b) => (b.distance > a.distance ? b : a));
      const paced = points.filter(p => p.paceSec);
      const fastestPacePoint = paced.length ? paced.reduce((a, b) => (b.paceSec < a.paceSec ? b : a)) : null;
      return {
        totalRuns: points.length,
        totalDistance,
        bestDistance: bestDistancePoint.distance,
        fastestPaceSec: fastestPacePoint ? fastestPacePoint.paceSec : null,
      };
    },

    isOnline() { return navigator.onLine; },

    /* ===== Шаблоны тренировок (раздел 5 спецификации) =====
       Личные у каждого пользователя. Создаются из завершённой тренировки,
       редактируются после создания. «Поделиться» = независимая копия
       у другого пользователя — дальнейшие правки одной не влияют на другую. */

    getTemplates(userId) { return ls(`train_templates_${userId}`, []); },
    saveTemplates(userId, list) { lsSet(`train_templates_${userId}`, list); },
    getTemplate(userId, templateId) {
      return this.getTemplates(userId).find(t => t.id === templateId) || null;
    },

    // Создать шаблон из завершённой силовой тренировки — состав упражнений
    // и вес/повторы выполненных подходов как целевые ориентиры на будущее.
    createTemplateFromWorkout(userId, workout, name) {
      const list = this.getTemplates(userId);
      const tpl = {
        id: `t_${Date.now()}`,
        name: (name || "").trim() || workout.name || "Новый шаблон",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        exercises: (workout.exercises || []).map(ex => ({
          exerciseId: ex.exerciseId,
          sets: ex.sets.filter(s => s.done).map(s => ({ weight: s.weight, reps: s.reps })),
        })),
      };
      list.unshift(tpl);
      this.saveTemplates(userId, list);
      return tpl;
    },

    // Создать пустой шаблон с нуля (п.7) — состав упражнений добавляется потом
    // на экране редактирования шаблона.
    createBlankTemplate(userId, name) {
      const list = this.getTemplates(userId);
      const tpl = {
        id: `t_${Date.now()}`,
        name: (name || "").trim() || "Новый шаблон",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        exercises: [],
      };
      list.unshift(tpl);
      this.saveTemplates(userId, list);
      return tpl;
    },

    renameTemplate(userId, templateId, name) {
      const list = this.getTemplates(userId);
      const tpl = list.find(t => t.id === templateId);
      if (!tpl) return null;
      tpl.name = name.trim() || tpl.name;
      tpl.updatedAt = Date.now();
      this.saveTemplates(userId, list);
      return tpl;
    },

    // Состав шаблона можно редактировать после создания (раздел 5).
    updateTemplateExercises(userId, templateId, exercisesList) {
      const list = this.getTemplates(userId);
      const tpl = list.find(t => t.id === templateId);
      if (!tpl) return null;
      tpl.exercises = exercisesList;
      tpl.updatedAt = Date.now();
      this.saveTemplates(userId, list);
      return tpl;
    },

    deleteTemplate(userId, templateId) {
      this.saveTemplates(userId, this.getTemplates(userId).filter(t => t.id !== templateId));
    },

    // Привязать тренировку из истории к шаблону (для «посл.» и среднего времени)
    // и, по желанию, переименовать её под имя шаблона. Возвращает true, если нашли.
    linkWorkoutToTemplate(userId, workoutId, templateId, name) {
      const hist = this.getWorkoutHistory(userId);
      const w = hist.find(x => x.id === workoutId);
      if (!w) return false;
      w.templateId = templateId;
      if (name) w.name = name;
      this.saveWorkoutHistory(userId, hist);
      return true;
    },

    // Переименовать все тренировки, привязанные к шаблону, под его новое имя.
    // Возвращает id изменённых тренировок (чтобы вызвать синк по каждой).
    renameTemplateWorkouts(userId, templateId, name) {
      const hist = this.getWorkoutHistory(userId);
      const changed = [];
      hist.forEach(w => { if (w.templateId === templateId && w.name !== name) { w.name = name; changed.push(w.id); } });
      if (changed.length) this.saveWorkoutHistory(userId, hist);
      return changed;
    },

    // «Поделиться» = создание независимой копии у другого пользователя (раздел 5).
    shareTemplate(templateId, fromUserId, toUserId) {
      const tpl = this.getTemplate(fromUserId, templateId);
      if (!tpl) return null;
      const copy = {
        id: `t_${Date.now()}`,
        name: tpl.name,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        exercises: tpl.exercises.map(ex => ({ exerciseId: ex.exerciseId, sets: ex.sets.map(s => ({ ...s })) })),
      };
      const list = this.getTemplates(toUserId);
      list.unshift(copy);
      this.saveTemplates(toUserId, list);
      return copy;
    },

    // Начать тренировку из шаблона — состав переносится, подходы ещё не выполнены.
    // Возвращает null, если уже есть активная тренировка (нельзя начать поверх неё).
    startWorkoutFromTemplate(userId, templateId) {
      if (this.getActiveWorkout(userId)) return null;
      const tpl = this.getTemplate(userId, templateId);
      if (!tpl) return null;
      const exNameById = new Map(this.getVisibleExercises(userId).map(e => [e.id, e.name]));
      const workout = {
        id: `w_${Date.now()}`,
        type: "strength",
        templateId: tpl.id,                  // связь с шаблоном — для среднего времени и «посл.»
        name: tpl.name,
        startedAt: Date.now(),
        // Шаблон задаёт только состав. Количество подходов и теневые
        // (placeholder) значения берём из прошлой тренировки с этим
        // упражнением — ровно как при ручном добавлении (addExerciseToWorkout),
        // чтобы старт из шаблона ничем не отличался от обычного старта.
        exercises: tpl.exercises.map(ex => {
          const lastW = this.getLastWorkoutForExercise(userId, ex.exerciseId);
          const lastEx = lastW ? lastW.exercises.find(e => e.exerciseId === ex.exerciseId) : null;
          const lastSets = lastEx ? lastEx.sets.filter(s => s.done && (s.weight || s.reps)) : [];
          const sets = lastSets.length > 1
            ? lastSets.map(() => ({ weight: 0, reps: 0, rpe: 0, done: false }))
            : [{ weight: 0, reps: 0, rpe: 0, done: false }];
          return {
            exerciseId: ex.exerciseId,
            name: exNameById.get(ex.exerciseId), // снимок имени — устойчивость к потере справочника
            sets,
          };
        }),
      };
      this.saveActiveWorkout(userId, workout);
      return workout;
    },
  };
})();

/* ==========================================================================
   DOM refs
   ========================================================================== */
const $ = id => document.getElementById(id);

// Тактильная отдача (Vibration API). Поддерживается не везде (например, не
// в Safari/iOS — там просто молча ничего не произойдёт, это нормально).
function haptic(ms = 12) {
  if (navigator.vibrate) { try { navigator.vibrate(ms); } catch {} }
}

const screenProfile  = $("screen-profile");
const screenMenu     = $("screen-menu");
const screenWorkout  = $("screen-workout");
const screenRun      = $("screen-run");
const screenExercises = $("screen-exercises");

const profileList  = $("profile-list");
const statusDot    = $("status-dot");
const statusText   = $("status-text");

const startBtn      = $("start-btn");

/* ── Анимация центральной кнопки ── */
(function initStartBtn() {
  const canvas   = $("start-orbit-canvas");
  const timer    = $("start-timer");
  const ring1    = $("start-pulse-ring-1");
  const ring2    = $("start-pulse-ring-2");
  if (!canvas || !timer || !ring1 || !ring2) return;

  const ctx = canvas.getContext("2d");
  let orbitAngle = 0;
  const N_DOTS = 9;

  // Анимации кнопки нужны только когда меню реально на экране и вкладка видна.
  // Иначе (открыт экран тренировки/статистики/свёрнуто приложение) циклы зря
  // жгли бы CPU/GPU и батарею, перерисовывая невидимую кнопку на 60 Гц.
  const menuActive = () => !document.hidden && screenMenu.classList.contains("active");

  // Размер буфера canvas = пиксели кнопки × DPR, иначе на Retina орбита мылит.
  // Через setTransform рисуем дальше в CSS-координатах (как будто DPR = 1).
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = startBtn.offsetWidth  * dpr;
    canvas.height = startBtn.offsetHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);

  // Орбита
  function drawOrbit() {
    if (!menuActive()) { requestAnimationFrame(drawOrbit); return; }
    const W = startBtn.offsetWidth, H = startBtn.offsetHeight; // CSS-пиксели (ctx уже масштабирован)
    const cx = W/2, cy = H/2;
    // Точки идут по самому контуру кнопки (её рамка — на r≈W/2), а не по
    // окружности глубоко внутри (п.3). Небольшой отступ 2.5px — чтобы точка
    // целиком оставалась в пределах круглого канваса и не срезалась краем.
    const rx = W/2 - 2.5, ry = H/2 - 2.5;
    ctx.clearRect(0, 0, W, H);
    orbitAngle += 0.004;
    const isActive = startBtn.classList.contains("active-workout");
    const baseColor = isActive ? "52,211,153" : "124,108,230";
    for (let i = 0; i < N_DOTS; i++) {
      const a = orbitAngle + (i / N_DOTS) * Math.PI * 2;
      const x = cx + Math.cos(a) * rx;
      const y = cy + Math.sin(a) * ry;
      const opacity = 0.2 + 0.8 * (i / N_DOTS);
      const size    = i % 3 === 0 ? 4.5 : 3;
      ctx.beginPath();
      ctx.arc(x, y, size / 2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${baseColor},${opacity.toFixed(2)})`;
      ctx.fill();
    }
    requestAnimationFrame(drawOrbit);
  }

  // Пульсация колец
  function setupPulse(r1, r2, getColor) {
    let t = 0;
    function tick() {
      if (!menuActive()) { requestAnimationFrame(tick); return; }
      t += 0.016;
      const ease = p => 1 - Math.pow(1 - p, 3);
      const p1 = (t % 2) / 2, p2 = ((t + 1) % 2) / 2;
      // Кольцо стартует ровно на контуре кнопки (scale 1.0) и расходится
      // наружу, угасая — пульсация «от края», а не из глубины кнопки (п.3).
      r1.style.transform = `translate(-50%,-50%) scale(${(1 + 0.45 * ease(p1)).toFixed(3)})`;
      r1.style.opacity   = (0.5 * (1 - ease(p1))).toFixed(3);
      r2.style.transform = `translate(-50%,-50%) scale(${(1 + 0.45 * ease(p2)).toFixed(3)})`;
      r2.style.opacity   = (0.5 * (1 - ease(p2))).toFixed(3);
      requestAnimationFrame(tick);
    }
    // Центрирование колец задано в CSS (.start-pulse-ring) — здесь его больше
    // не дублируем инлайн-стилями, иначе offset считается дважды и кольца
    // съезжают от кнопки (см. CSS-комментарий рядом с .start-pulse-ring).
    tick();
  }

  // Дыхание двоеточия в покое
  let idlePhase = 0;
  function breatheIdle() {
    if (menuActive()) {
      const colon = $("start-colon-idle");
      if (colon) {
        idlePhase += 0.022;
        colon.style.opacity = (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(idlePhase))).toFixed(2);
      }
    }
    requestAnimationFrame(breatheIdle);
  }

  // Обновление таймера на кнопке. Раньше крутился на requestAnimationFrame
  // (60 Гц) с полной пересборкой innerHTML каждый кадр — ради текста, который
  // меняется раз в секунду. Теперь лёгкий setInterval(500мс) и DOM трогаем
  // только когда видимое значение реально изменилось (см. ключ key).
  let _startBtnInt = null;
  function stopStartBtnTimer() { if (_startBtnInt) { clearInterval(_startBtnInt); _startBtnInt = null; } }
  function updateStartBtn(activeWorkout) {
    const isActive = !!activeWorkout;
    startBtn.classList.toggle("active-workout", isActive);

    if (!isActive) {
      stopStartBtnTimer();
      timer.innerHTML = `<div class="start-colon" id="start-colon-idle"><div class="start-colon-dot"></div><div class="start-colon-dot"></div></div>`;
      startBtn.classList.remove("long-workout");
      return;
    }

    // Активная тренировка — таймер
    const startTs = activeWorkout.startTimestamp || activeWorkout.startedAt || Date.now();
    let lastKey = "";

    function renderTimer() {
      if (!menuActive()) return; // меню не видно — DOM не трогаем, интервал продолжит тикать
      const elapsed = Math.floor((Date.now() - startTs) / 1000);
      const h  = Math.floor(elapsed / 3600);
      const m  = Math.floor((elapsed % 3600) / 60);
      const s  = elapsed % 60;
      const mm = String(m).padStart(2, "0");
      const ss = String(s).padStart(2, "0");
      const isLong = h > 0;
      const blink = Math.floor(Date.now() / 1000) % 2 === 0;

      const key = `${isLong ? h + ":" : ""}${mm}:${ss}:${blink}`;
      if (key === lastKey) return; // ничего видимого не изменилось
      lastKey = key;

      startBtn.classList.toggle("long-workout", isLong);
      const op = blink ? "1" : "0.22";
      const colon = `<div class="start-colon"><div class="start-colon-dot" style="opacity:${op}"></div><div class="start-colon-dot" style="opacity:${op}"></div></div>`;
      timer.innerHTML = isLong
        ? `<span class="start-timer-num">${h}</span>${colon}<span class="start-timer-num">${mm}</span>${colon}<span class="start-timer-num">${ss}</span>`
        : `<span class="start-timer-num">${mm}</span>${colon}<span class="start-timer-num">${ss}</span>`;
    }

    stopStartBtnTimer();
    renderTimer();
    _startBtnInt = setInterval(renderTimer, 500);
  }

  // Запускаем
  setupPulse(ring1, ring2, () => startBtn.classList.contains("active-workout")
    ? "rgba(52,211,153,OPACITY)" : "rgba(124,108,230,OPACITY)");
  drawOrbit();
  breatheIdle();

  // Экспортируем updateStartBtn в глобальный скоуп чтобы refreshMenu мог вызвать
  window.updateStartBtn = updateStartBtn;
})();
const sheet         = $("history-sheet");
const sheetDragArea = $("sheet-drag-area");
const historyCount  = $("history-count");
const historyBody   = $("history-body");

const typeModalBackdrop     = $("type-modal-backdrop");
const settingsModalBackdrop = $("settings-modal-backdrop");

const pickerBackdrop = $("picker-backdrop");
const pickerSearch   = $("picker-search");
const pickerList     = $("picker-list");
const pickerTabs     = $("picker-tabs");

const rpeBackdrop = $("rpe-backdrop");
const rpeGrid     = $("rpe-grid");
const rpeHint     = $("rpe-hint");

const toastEl = $("toast");

/* ==========================================================================
   Toast
   ========================================================================== */
let toastTimer = null;
function showToast(msg) {
  clearTimeout(toastTimer);
  toastEl.classList.remove("actionable");
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
}

// Кликабельный тост с действием — для отмены удалений и для предложения
// обновиться. onAction вызывается максимум один раз. duration<=0 — не прячем
// автоматически (висит, пока не нажмут).
function showActionToast(msg, actionLabel, onAction, duration = 5000) {
  clearTimeout(toastTimer);
  toastEl.innerHTML = "";
  const text = document.createElement("span");
  text.className = "toast-text";
  text.textContent = msg;
  const btn = document.createElement("button");
  btn.className = "toast-undo-btn";
  btn.textContent = actionLabel;
  let used = false;
  btn.addEventListener("click", () => {
    if (used) return;
    used = true;
    toastEl.classList.remove("show", "actionable");
    try { onAction(); } catch (e) { console.warn("Toast action failed", e); }
  });
  toastEl.append(text, btn);
  toastEl.classList.add("show", "actionable");
  if (duration > 0) toastTimer = setTimeout(() => toastEl.classList.remove("show", "actionable"), duration);
}
// Для откатываемых удалений.
function showUndoToast(msg, onUndo) { showActionToast(msg, "Отменить", onUndo, 5000); }
document.addEventListener("storage-full", () => showToast("Хранилище заполнено — удали старые тренировки"));

/* ==========================================================================
   Sync queue (раздел 8 спецификации)

   Реальная реализация — в sync.js (Sync), который умеет настоящую отправку
   в JSONBin через storage.js. SyncQueue — алиас на него же: так все вызовы
   SyncQueue.push(...), расставленные по экранам ниже, продолжают работать
   без изменений, независимо от того, что стоит за ними — стаб или реальная
   синхронизация. Если JSONBin не настроен (config.js: ENABLED=false),
   Sync.push() просто ничего не делает — приложение работает локально, как раньше.
   ========================================================================== */
const SyncQueue = Sync;

/* ==========================================================================
   Online status
   ========================================================================== */
function updateOnlineStatus() {
  const online = navigator.onLine;
  const pending = SyncQueue.size();
  const syncError = typeof SyncQueue.lastError === "function" ? SyncQueue.lastError() : null;

  statusDot.classList.toggle("offline", !online);
  statusDot.classList.toggle("pending", online && pending > 0 && !syncError);
  statusDot.classList.toggle("error", online && !!syncError);

  if (!online) {
    statusText.textContent = pending > 0
      ? "Нет сети — есть несинхронизированные изменения"
      : "Нет сети — данные сохраняются локально";
  } else if (syncError) {
    statusText.textContent = `Ошибка синхронизации: ${syncError}`;
  } else if (pending > 0) {
    statusText.textContent = "Есть несинхронизированные изменения";
  } else {
    statusText.textContent = "Работаем онлайн";
  }
}
window.addEventListener("online",  () => { updateOnlineStatus(); SyncQueue.flush(); });
window.addEventListener("offline", updateOnlineStatus);

// Сворачивание приложения / уход со страницы — пробуем дослать всё
// несинхронизированное прямо сейчас, не дожидаясь обычной задержки
// (раздел 6.1: активная тренировка должна переживать переключение приложений).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") SyncQueue.flush();
});
window.addEventListener("pagehide", () => SyncQueue.flush());

/* ==========================================================================
   Screen switching
   ========================================================================== */
const SCREENS = { profile: screenProfile, menu: screenMenu, workout: screenWorkout, run: screenRun, exercises: screenExercises, exerciseDetail: $("screen-exercise-detail"), history: $("screen-history"), detail: $("screen-detail"), stats: $("screen-stats"), statChart: $("screen-stat-chart"), templates: $("screen-templates") };

function goToScreen(name, opts = {}) {
  Object.values(SCREENS).forEach(s => s && s.classList.remove("active"));
  const target = SCREENS[name];
  if (!target) return;
  target.classList.add("active");

  if (name === "profile")  { renderProfiles(); }
  if (name === "menu")     { refreshMenu(); }
  if (name === "workout")  { initWorkoutScreen(opts); }
  if (name === "run")      { initRunScreen(opts); }
  if (name === "exercises") { initExercisesScreen(); }
  if (name === "history")  { initHistoryScreen(); }
  if (name === "stats")    { initStatsScreen(); }
  if (name === "templates") { initTemplatesScreen(); }
}

// Гигиена на каждый вход в профиль — и при явном выборе на экране профилей,
// и при автоматическом восстановлении сессии в init() (обычный случай:
// приложение уже открыто под этим пользователем). Оба напоминания — только
// чтение localStorage, без сети; показываем не больше одного тоста за раз,
// синхронизация приоритетнее (риск больше — расхождение между устройствами).
// Раньше показывала напоминания «давно не синхронизировался» / «давно не
// экспортировал» — обе убраны (первая устарела вместе со старым sync, вторая
// убрана по просьбе пользователя, мешала больше, чем помогала). Оставлена
// как пустой хук: вызывается из нескольких мест при входе в профиль
// (app.js legacy-путь + auth-ui.js), трогать вызовы не стали, чтобы не
// плодить лишний риск ради нулевого поведенческого изменения.
function onProfileEnter(userId) {}

/* ==========================================================================
   Screen 1: profile
   ========================================================================== */
function renderProfiles() {
  profileList.innerHTML = "";
  DATA.USERS.forEach(user => {
    const card = document.createElement("button");
    card.className = "profile-card";
    card.innerHTML = `
      <span class="avatar ${user.avatarClass}">${user.initial}</span>
      <span class="profile-info">
        <span class="profile-name">${user.name}</span>
      </span>
      <span class="profile-chevron"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span>
    `;
    card.addEventListener("click", () => {
      DATA.setCurrentUser(user.id);
      _menuHydrating = Storage.isEnabled() && navigator.onLine;
      goToScreen("menu");
      onProfileEnter(user.id);
      // Гидратация в фоне — переход на главный экран не ждёт сеть (раздел 8:
      // local-first). Если что-то подтянулось, тихо обновляем уже открытое меню.
      Sync.hydrateUser(user.id).then(() => {
        _menuHydrating = false;
        if (screenMenu.classList.contains("active")) refreshMenu();
      });
    });
    profileList.appendChild(card);
  });
}

/* ==========================================================================
   Screen 2: main menu
   ========================================================================== */
function refreshMenu() {
  const userId = DATA.getCurrentUser();
  if (!userId) return;
  const user = DATA.USERS.find(u => u.id === userId);
  if (user) {
    const av = $("profile-chip-avatar");
    av.textContent = user.initial;
    av.className = `avatar profile-chip-avatar ${user.avatarClass}`;
    $("profile-chip-name").textContent = user.name;
  }
  const active = DATA.getActiveWorkout(userId);
  startBtn.classList.toggle("active-workout", !!active);
  updateStartBtn(active);
  renderHistory(userId);
}

$("profile-chip").addEventListener("click", () => {
  DATA.clearCurrentUser();
  goToScreen("profile");
});

const HISTORY_SVG_DEL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>`;

function pluralSets(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "подход";
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "подхода";
  return "подходов";
}

// Разметка одной карточки тренировки — общая для превью-шторки и экрана «История».
function historyItemHtml(w) {
  const isRun = w.type === "run";
  const meta = isRun
    ? [w.distance ? `${w.distance} км` : null, w.pace ? `${w.pace} мин/км` : null].filter(Boolean).join(" · ")
    : (() => {
        const exCnt = (w.exercises || []).filter(ex => ex.sets.some(s => s.done)).length;
        const sets  = (w.exercises || []).reduce((n, ex) => n + ex.sets.filter(s => s.done).length, 0);
        return [exCnt ? `${exCnt} ${pluralExercises(exCnt)}` : null, sets ? `${sets} ${pluralSets(sets)}` : null].filter(Boolean).join(" · ");
      })();
  const duration = w.durationSec ? formatDuration(w.durationSec) : "";
  // Заполнено не тем, чей это профиль (тренер внёс за клиента) — см. bridge.js
  // (createdBy прокидывается из облака 1:1 в локальный объект тренировки).
  // _migrated — исключение: перенесённые из старой localStorage-модели записи
  // (см. migrate.js) технически получают created_by = того, кто нажал
  // «Перенести», а не того, кто реально вносил тренировку в старой системе —
  // это было неизвестно уже тогда, бейдж на них честно не показываем.
  const filledByTrainer = w.createdBy && w.createdBy !== DATA.getCurrentUser() && !w._migrated;

  return `
    <div class="history-item-wrap" data-id="${w.id}">
      <div class="history-item-delete">${HISTORY_SVG_DEL} Удалить</div>
      <div class="history-item history-item--${isRun ? "run" : "strength"}" data-id="${w.id}">
        <span class="history-item-body">
          <span class="history-item-label">${escHtml(w.name || (isRun ? "Пробежка" : "Силовая"))}</span>
          <span class="history-item-meta">${meta || "—"}${filledByTrainer ? ' <span class="history-item-trainer-tag">· внесено тренером</span>' : ""}</span>
        </span>
        <span class="history-item-right">
          <span class="history-item-date">${fmtDate(w.startedAt)}</span>
          ${duration ? `<span class="history-item-dur">${duration}</span>` : ""}
        </span>
      </div>
    </div>`;
}

// Удаление тренировки с возможностью отката (та же логика, что у кнопки удаления
// в детальном экране) — переиспользуется свайпом по карточке истории. rerender —
// колбэк перерисовки текущего списка (шторка или экран «История»).
function deleteWorkoutWithUndo(workout, rerender) {
  const userId = DATA.getCurrentUser();
  // Снимки для отката.
  const histSnap = [...DATA.getWorkoutHistory(userId)];
  const idxSnap  = [...DATA.getWorkoutIndex(userId)];
  const recSnap  = JSON.parse(JSON.stringify(DATA.getRecords(userId)));
  const binId = workout._remoteBinId; // удалим и сам бин на JSONBin (если не отменят)
  DATA.deleteWorkout(userId, workout.id);

  // Пересчёт рекордов только при полной локальной истории (см. detail-delete-btn).
  const recsRecomputed = Sync.missingWorkoutCount(userId) === 0;
  if (recsRecomputed) DATA.recomputeRecords(userId);

  SyncQueue.push("workout:delete", {});
  if (recsRecomputed) SyncQueue.push("user:update", {});
  rerender(userId);

  let undone = false;
  const purgeTimer = setTimeout(() => {
    if (!undone && binId) Storage.deleteBin(binId).catch(e => console.warn("deleteBin failed", e));
  }, 6000);

  showUndoToast("Тренировка удалена", () => {
    undone = true;
    clearTimeout(purgeTimer);
    DATA.saveWorkoutHistory(userId, histSnap);
    DATA.saveWorkoutIndex(userId, idxSnap);
    if (recsRecomputed) { DATA.saveRecords(userId, recSnap); SyncQueue.push("user:update", {}); }
    SyncQueue.push("workout:delete", {}); // повторно зальёт восстановленный индекс
    rerender(userId);
    showToast("Восстановлено");
  });
}

// Свайп влево по карточке истории → раскрыть зону «Удалить»; за порогом отпускания
// тренировка удаляется (с откатом), иначе карточка возвращается. Вертикаль отдаём
// скроллу. Аналогично свайпу строки упражнения (wireExRowSwipe).
function wireHistoryItemSwipe(wrap, rerender) {
  const row = wrap.querySelector(".history-item");
  if (!row) return;
  const wId = wrap.dataset.id;
  let sx = 0, sy = 0, dx = 0, active = false, decided = false, horiz = false, didSwipe = false;
  const MAX = 116, DEL = 84;

  row.addEventListener("pointerdown", e => {
    sx = e.clientX; sy = e.clientY; dx = 0;
    active = true; decided = false; horiz = false; didSwipe = false;
    row.style.transition = "";
  });
  row.addEventListener("pointermove", e => {
    if (!active) return;
    const mx = e.clientX - sx, my = e.clientY - sy;
    if (!decided) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      decided = true;
      horiz = mx < 0 && Math.abs(mx) > Math.abs(my);
      if (!horiz) { active = false; return; }
      wrap.classList.add("swiping");
      try { row.setPointerCapture(e.pointerId); } catch {}
    }
    if (!horiz) return;
    dx = Math.max(-MAX, Math.min(0, mx));
    if (dx < -4) didSwipe = true;
    row.style.transform = `translateX(${dx}px)`;
    wrap.classList.toggle("will-delete", dx <= -DEL);
  });
  // Пока идёт горизонтальный свайп-удаление — глушим нативный вертикальный скролл,
  // чтобы карточка не «ездила» вверх-вниз во время удаления (п.2).
  row.addEventListener("touchmove", e => {
    if (!active) return;
    const t = e.touches[0]; if (!t) return;
    const mx = t.clientX - sx, my = t.clientY - sy;
    if (horiz || (Math.abs(mx) >= 8 && mx < 0 && Math.abs(mx) > Math.abs(my))) {
      if (e.cancelable) e.preventDefault();
    }
  }, { passive: false });
  const settle = () => {
    if (!active) return;
    active = false;
    if (!horiz) return;
    if (dx <= -DEL) {
      row.style.transition = "transform 0.16s ease";
      row.style.transform = "translateX(-110%)";
      wrap.style.height = wrap.offsetHeight + "px";
      requestAnimationFrame(() => {
        wrap.style.transition = "height 0.18s ease, opacity 0.18s ease";
        wrap.style.height = "0"; wrap.style.opacity = "0";
      });
      setTimeout(() => {
        const w = DATA.getWorkoutHistory(DATA.getCurrentUser()).find(x => x.id === wId);
        if (w) deleteWorkoutWithUndo(w, rerender);
        else rerender(DATA.getCurrentUser());
      }, 200);
    } else {
      row.style.transition = "transform 0.18s ease";
      row.style.transform = "";
      wrap.classList.remove("will-delete");
      setTimeout(() => wrap.classList.remove("swiping"), 200);
    }
  };
  row.addEventListener("pointerup", settle);
  row.addEventListener("pointercancel", settle);
  row.addEventListener("click", e => {
    if (didSwipe) { e.stopPropagation(); e.preventDefault(); didSwipe = false; }
  }, true);
}

// Сколько последних тренировок показываем в шторке-превью. Остальные — на
// отдельном экране «История» по кнопке «Вся история».
const HISTORY_PREVIEW_LIMIT = 5;

// true, пока идёт первичная гидратация при заходе на меню. Нужно, чтобы при
// пустой локальной истории (свежее устройство / чищеный кэш / последняя
// тренировка была на другом устройстве) показать скелетон-карточку вместо
// схлопнутой пустой шторки — иначе превью «подгружается» и ломает дизайн
// (шторка стоит внизу пустая, потом прыгает вверх, когда данные приехали).
let _menuHydrating = false;

// Карточка-заглушка той же высоты, что реальная, — держит «пик» шторки на месте.
function historySkeletonHtml() {
  const card = `
    <div class="history-item history-item--skeleton">
      <span class="history-item-body">
        <span class="sk-line sk-line-label"></span>
        <span class="sk-line sk-line-meta"></span>
      </span>
      <span class="history-item-right"><span class="sk-line sk-line-date"></span></span>
    </div>`;
  return card.repeat(3);
}

function renderHistory(userId) {
  const history = DATA.getWorkoutHistory(userId);
  historyCount.textContent = history.length;

  if (!history.length) {
    // Пока тянем данные — скелетон (держит дизайн шторки); иначе честная пустота.
    historyBody.innerHTML = _menuHydrating
      ? historySkeletonHtml()
      : `<p class="empty-state">Тренировок пока нет — начни первую, и она появится здесь.</p>`;
    repositionCollapsedSheet();
    return;
  }

  const preview = history.slice(0, HISTORY_PREVIEW_LIMIT);
  historyBody.innerHTML =
    preview.map(historyItemHtml).join("") +
    `<button class="history-all-btn" id="history-all-btn">
       Вся история<span class="history-all-count">${history.length}</span>
       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
     </button>`;

  historyBody.querySelectorAll(".history-item").forEach(el => {
    el.addEventListener("click", () => {
      if (!sheet.classList.contains("expanded")) {
        window.settleSheet(true);
        return;
      }
      const w = DATA.getWorkoutHistory(userId).find(x => x.id === el.dataset.id);
      if (w) openDetailScreen(w);
    });
  });
  historyBody.querySelectorAll(".history-item-wrap").forEach(wrap =>
    wireHistoryItemSwipe(wrap, () => renderHistory(DATA.getCurrentUser())));

  const allBtn = $("history-all-btn");
  if (allBtn) allBtn.addEventListener("click", () => {
    if (!sheet.classList.contains("expanded")) { window.settleSheet(true); return; }
    goToScreen("history");
  });

  repositionCollapsedSheet();
}

/* ==========================================================================
   Экран: полная история тренировок (с фильтром по типу)
   ========================================================================== */
let _historyFilter = "all";
let _historyPeriod = "all";

// Период → сколько дней назад от «сейчас» считаем границей (null = всё время).
const HISTORY_PERIODS = [
  ["all",   "Всё время", null],
  ["week",  "Неделя",    7],
  ["month", "Месяц",     30],
  ["year",  "Год",       365],
];

function historyTypeMatch(w, key) {
  if (key === "all") return true;
  return key === "run" ? w.type === "run" : w.type !== "run";
}
function historyPeriodMatch(w, key) {
  const period = HISTORY_PERIODS.find(p => p[0] === key);
  if (!period || period[2] == null) return true;
  return w.startedAt >= Date.now() - period[2] * 86400000;
}

function initHistoryScreen() {
  _historyFilter = "all";
  _historyPeriod = "all";
  renderHistoryScreen();
}

// Названия месяцев для заголовков-разделителей («ИЮНЬ 2026»).
const HISTORY_MONTHS_RU = ["ЯНВАРЬ", "ФЕВРАЛЬ", "МАРТ", "АПРЕЛЬ", "МАЙ", "ИЮНЬ", "ИЮЛЬ", "АВГУСТ", "СЕНТЯБРЬ", "ОКТЯБРЬ", "НОЯБРЬ", "ДЕКАБРЬ"];
function historyMonthLabel(ts) {
  const d = new Date(ts);
  return `${HISTORY_MONTHS_RU[d.getMonth()]} ${d.getFullYear()}`;
}

// Сборка одного фильтра-дропдауна (Все ▾ / период ▾) в контейнере container.
function buildHistoryDropdown(container, options, currentKey, onSelect) {
  const cur = options.find(o => o.key === currentKey) || options[0];
  container.classList.add("history-dd");
  container.innerHTML = `
    <button class="history-dd-btn" type="button">
      <span class="history-dd-label">${cur.label}</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div class="history-dd-menu">
      ${options.map(o => `<button class="history-dd-opt${o.key === currentKey ? " active" : ""}" data-key="${o.key}" type="button">
        <span>${o.label}</span>${o.count != null ? `<span class="history-dd-count">${o.count}</span>` : ""}
      </button>`).join("")}
    </div>`;
  container.querySelector(".history-dd-btn").addEventListener("click", e => {
    e.stopPropagation();
    const wasOpen = container.classList.contains("open");
    document.querySelectorAll(".history-dd.open").forEach(d => d.classList.remove("open"));
    if (!wasOpen) container.classList.add("open");
  });
  container.querySelectorAll(".history-dd-opt").forEach(opt => {
    opt.addEventListener("click", e => {
      e.stopPropagation();
      container.classList.remove("open");
      onSelect(opt.dataset.key);
    });
  });
}

// Глобально закрываем открытые дропдауны по клику вне их.
if (!window._historyDdCloserBound) {
  window._historyDdCloserBound = true;
  document.addEventListener("click", () => {
    document.querySelectorAll(".history-dd.open").forEach(d => d.classList.remove("open"));
  });
}

function renderHistoryScreen() {
  const userId = DATA.getCurrentUser();
  const all = DATA.getWorkoutHistory(userId);

  // Фильтр по типу — дропдаун «Все ▾» (счётчики в пределах выбранного периода).
  const inPeriod = all.filter(w => historyPeriodMatch(w, _historyPeriod));
  const typeOpts = [["all", "Все"], ["strength", "Силовые"], ["run", "Пробежки"]].map(([key, label]) =>
    ({ key, label, count: inPeriod.filter(w => historyTypeMatch(w, key)).length }));
  buildHistoryDropdown($("history-type-dd"), typeOpts, _historyFilter, key => {
    _historyFilter = key; renderHistoryScreen();
  });

  // Фильтр по периоду — дропдаун «Месяц ▾».
  const periodOpts = HISTORY_PERIODS.map(([key, label]) => ({ key, label }));
  buildHistoryDropdown($("history-period-dd"), periodOpts, _historyPeriod, key => {
    _historyPeriod = key; renderHistoryScreen();
  });

  const list = all.filter(w => historyTypeMatch(w, _historyFilter) && historyPeriodMatch(w, _historyPeriod));

  // Хвост истории, который есть в индексе на JSONBin, но ещё не подтянут локально
  // (старше лимита гидратации). Кнопка догружает следующую пачку по запросу.
  const missing = (Sync.missingWorkoutCount && navigator.onLine) ? Sync.missingWorkoutCount(userId) : 0;
  const moreBtnHtml = missing > 0
    ? `<button class="history-all-btn" id="history-load-more">Загрузить ещё<span class="history-all-count">${missing}</span></button>`
    : "";

  const listEl = $("history-screen-list");
  if (!list.length) {
    listEl.innerHTML = `<p class="empty-state" style="padding:24px 6px">Тренировок по выбранным фильтрам нет.</p>` + moreBtnHtml;
  } else {
    // Группируем по месяцам — список уже отсортирован «новые сверху».
    let html = "", curMonthKey = null;
    list.forEach(w => {
      const d = new Date(w.startedAt);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (key !== curMonthKey) {
        curMonthKey = key;
        html += `<div class="history-month">${historyMonthLabel(w.startedAt)}</div>`;
      }
      html += historyItemHtml(w);
    });
    listEl.innerHTML = html + moreBtnHtml;
    listEl.querySelectorAll(".history-item").forEach(el => {
      el.addEventListener("click", () => {
        const w = all.find(x => x.id === el.dataset.id);
        if (w) openDetailScreen(w, "history");
      });
    });
    listEl.querySelectorAll(".history-item-wrap").forEach(wrap =>
      wireHistoryItemSwipe(wrap, () => renderHistoryScreen()));
  }

  const moreBtn = $("history-load-more");
  if (moreBtn) moreBtn.addEventListener("click", () => {
    moreBtn.disabled = true;
    moreBtn.textContent = "Загрузка…";
    Sync.loadMoreWorkouts(userId)
      .then(n => { showToast(n > 0 ? `Загружено ещё: ${n}` : "Больше нет данных"); renderHistoryScreen(); })
      .catch(() => { showToast("Не удалось загрузить"); renderHistoryScreen(); });
  });
}

// Шторка сохраняет своё (развёрнутое) состояние сама — клик по «назад» больше
// не схлопывает её (см. document click-обработчик в setupSheetDrag).
$("history-back-btn").addEventListener("click", () => goToScreen("menu"));


/* ==========================================================================
   Start button
   ========================================================================== */
startBtn.addEventListener("click", () => {
  const userId = DATA.getCurrentUser();
  const active = DATA.getActiveWorkout(userId);
  if (active) {
    goToScreen(active.type === "run" ? "run" : "workout", { resume: true });
    return;
  }
  openModal(typeModalBackdrop);
});

document.querySelectorAll(".modal-option[data-type]").forEach(btn => {
  btn.addEventListener("click", () => {
    const userId = DATA.getCurrentUser();
    const type = btn.dataset.type;
    DATA.startWorkout(userId, type);
    closeModal(typeModalBackdrop);
    goToScreen(type === "run" ? "run" : "workout");
  });
});

$("modal-cancel").addEventListener("click", () => closeModal(typeModalBackdrop));

/* ==========================================================================
   Pill nav
   ========================================================================== */
document.querySelectorAll(".pill").forEach(pill => {
  pill.addEventListener("click", () => {
    const action = pill.dataset.action;
    if (action === "settings")  {
      openModal(settingsModalBackdrop);
      return;
    }
    if (action === "exercises") { goToScreen("exercises"); return; }
    if (action === "stats")     { goToScreen("stats"); return; }
    if (action === "templates") { goToScreen("templates"); return; }
    showToast(`Раздел «${pill.querySelector(".pill-label").textContent}» — скоро`);
  });
});

/* ==========================================================================
   Settings modal
   ========================================================================== */
$("settings-close").addEventListener("click", () => closeModal(settingsModalBackdrop));

/* ==========================================================================
   Облачная синхронизация теперь автоматическая и построчная (bridge.js →
   db.js → Supabase, реляционная модель). Прежняя ручная Anki-схема (кнопки
   «В облако»/«Из облака», snapshot-блоб в таблице snapshots, разрешение
   конфликтов выбором) удалена из UI: авто-Bridge пишет каждое изменение сам,
   а ручной download старым блобом мог бы затереть свежие данные. Локальный
   файловый экспорт/импорт ниже сохранён как независимая страховка.
   ========================================================================== */

$("switch-user-btn").addEventListener("click", () => {
  closeModal(settingsModalBackdrop);
  DATA.clearCurrentUser();
  goToScreen("profile");
});

/* — Экспорт / импорт данных (для каждого профиля отдельно) —
   Бэкап ОДНОГО пользователя: все ключи train_*_<userId> (история, упражнения,
   шаблоны, рекорды, категории, активная тренировка). Общие/девайсные ключи
   (train_exercises, train_current_user, train_sync_dirty) в персональный бэкап
   не входят. Страховка на случай потери JSONBin или очистки localStorage. */
const BACKUP_PREFIX = "train_";

// Ключи данных конкретного пользователя — оканчиваются на "_<userId>".
// ID профилей ("dima"/"natela") не являются суффиксами друг друга, поэтому
// endsWith однозначно разделяет их.
function userDataKeys(userId) {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(BACKUP_PREFIX) && k.endsWith("_" + userId)) keys.push(k);
  }
  return keys;
}

// Общая логика скачивания файла — единственный вход, кнопка в настройках.
// Раньше сюда же вело мягкое напоминание «давно не экспортировал» — убрано
// по просьбе пользователя (мешало больше, чем помогало); знать, есть ли
// расхождение с облаком, теперь можно по индикатору синхронизации в шапке.
function exportUserData(userId) {
  const data = {};
  userDataKeys(userId).forEach(k => data[k] = localStorage.getItem(k));
  const payload = { app: "train.", version: 2, user: userId, exportedAt: new Date().toISOString(), data };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  a.href = url;
  a.download = `train-${userId}-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$("export-data-btn").addEventListener("click", () => {
  const userId = DATA.getCurrentUser();
  if (!userId) { showToast("Сначала выбери профиль"); return; }
  exportUserData(userId);
  closeModal(settingsModalBackdrop);
  showToast("Копия данных сохранена");
});

$("import-data-btn").addEventListener("click", () => $("import-data-input").click());

$("import-data-input").addEventListener("change", e => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ""; // позволяем повторно выбрать тот же файл
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try { parsed = JSON.parse(reader.result); }
    catch { showToast("Не удалось прочитать файл"); return; }
    const data = parsed && parsed.data;
    const keys = data && typeof data === "object" ? Object.keys(data).filter(k => k.startsWith(BACKUP_PREFIX)) : [];
    if (!keys.length) { showToast("В файле нет данных train."); return; }
    // Какие профили затрагивает файл (по суффиксу ключей) — заменяем только их,
    // данные других профилей на устройстве не трогаем.
    const affected = DATA.USERS.filter(u => keys.some(k => k.endsWith("_" + u.id)));
    const who = affected.length ? affected.map(u => u.name).join(", ") : "профиля";
    openConfirmModal({
      title: "Импортировать данные?",
      message: `Заменит данные ${who} на этом устройстве (${keys.length} ключей). Другие профили не тронутся.`,
      confirmLabel: "Импортировать",
      onConfirm: () => {
        try {
          const ids = affected.map(u => u.id);
          const toRemove = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(BACKUP_PREFIX) && ids.some(id => k.endsWith("_" + id))) toRemove.push(k);
          }
          toRemove.forEach(k => localStorage.removeItem(k));
          keys.forEach(k => localStorage.setItem(k, data[k]));
        } catch { showToast("Импорт не удался — возможно, переполнено хранилище"); return; }
        // Перезагружаем, чтобы DATA-кэш и экраны переинициализировались с чистого листа.
        location.reload();
      },
    });
  };
  reader.onerror = () => showToast("Не удалось прочитать файл");
  reader.readAsText(file);
});

/* ==========================================================================
   Modal helpers
   ========================================================================== */
function openModal(backdrop)  { backdrop.classList.add("open"); }
function closeModal(backdrop) { backdrop.classList.remove("open"); }
document.querySelectorAll(".modal-backdrop").forEach(b => {
  b.addEventListener("click", e => { if (e.target === b) closeModal(b); });
});

/* ==========================================================================
   Доступность оверлеев: Escape закрывает, Tab держит фокус внутри (#8).
   Единый обработчик на все оверлеи — статические и создаваемые на лету.
   ========================================================================== */
function topmostOverlay() {
  const list = document.querySelectorAll(
    ".modal-backdrop.open, .picker-backdrop.open, .bottom-sheet-backdrop.open, .stats-picker-backdrop.open"
  );
  return list.length ? list[list.length - 1] : null;
}
document.addEventListener("keydown", e => {
  const overlay = topmostOverlay();
  if (!overlay) return;

  if (e.key === "Escape") {
    e.preventDefault();
    // Все оверлеи закрываются по клику в подложку (e.target === backdrop) —
    // переиспользуем это, имитируя такой клик.
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return;
  }

  if (e.key === "Tab") {
    const focusables = Array.from(overlay.querySelectorAll(
      'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'
    )).filter(el => !el.disabled && el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (!overlay.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

/* ==========================================================================
   Bottom sheet drag (история)
   ========================================================================== */
(function setupSheetDrag() {
  let startY = 0, currentTranslate = 0, collapsedTranslate = 0, dragging = false, isTap = true;
  let history = [];

  function getCollapsedTranslate() {
    const sheetH = sheet.getBoundingClientRect().height;
    const dragH  = sheetDragArea.getBoundingClientRect().height;
    const firstItem = historyBody.querySelector(".history-item");
    if (!firstItem) return sheetH - dragH;
    // Показываем ровно: шапка + первая карточка + её 10px margin-bottom.
    return sheetH - dragH - 4 - firstItem.getBoundingClientRect().height - 10;
  }
  function onStart(clientY) {
    dragging = true; isTap = true; startY = clientY;
    collapsedTranslate = getCollapsedTranslate();
    currentTranslate = sheet.classList.contains("expanded") ? 0 : collapsedTranslate;
    history = [{ y: clientY, t: performance.now() }];
    sheet.classList.add("dragging");
  }
  function onMove(clientY) {
    if (!dragging) return;
    const delta = clientY - startY;
    if (Math.abs(delta) > 6) isTap = false;
    history.push({ y: clientY, t: performance.now() });
    if (history.length > 5) history.shift();
    const next = Math.max(0, Math.min(collapsedTranslate, currentTranslate + delta));
    sheet.style.transform = `translateY(${next}px)`;
  }
  function getVelocity() {
    if (history.length < 2) return 0;
    const f = history[0], l = history[history.length - 1], dt = l.t - f.t;
    return dt <= 0 ? 0 : (l.y - f.y) / dt;
  }
  function settle(expand) {
    sheet.classList.toggle("expanded", expand);
    sheet.classList.remove("dragging");
    sheet.classList.remove("no-anim"); // жест пользователя — всегда с анимацией
    // Блокируем клики в body на время анимации — иначе iOS отправляет
    // синтетический click через ~350мс и он попадает в карточку истории,
    // которая успела съехать под палец пока шторка анимировалась.
    historyBody.style.pointerEvents = "none";
    requestAnimationFrame(() => {
      if (expand) {
        // CSS .expanded { transform: translateY(0) } справится сам
        sheet.style.transform = "";
      } else {
        // Явно ставим JS-рассчитанную позицию свёрнутой шторки.
        sheet.style.transform = `translateY(${getCollapsedTranslate()}px)`;
      }
      setTimeout(() => { historyBody.style.pointerEvents = ""; }, 400);
    });
  }
  function onEnd(clientY) {
    if (!dragging) return;
    dragging = false;
    if (isTap) { settle(!sheet.classList.contains("expanded")); return; }
    const delta = clientY - startY;
    const traveled = currentTranslate + delta;
    const vel = getVelocity();
    const expand = vel < -0.45 ? true : vel > 0.45 ? false : traveled < collapsedTranslate * 0.72;
    settle(expand);
  }

  sheetDragArea.addEventListener("touchstart",  e => onStart(e.touches[0].clientY),        { passive: true });
  sheetDragArea.addEventListener("touchmove",   e => onMove(e.touches[0].clientY),         { passive: true });
  sheetDragArea.addEventListener("touchend",    e => onEnd(e.changedTouches[0].clientY));
  sheetDragArea.addEventListener("touchcancel", e => onEnd(e.changedTouches[0].clientY));
  sheetDragArea.addEventListener("mousedown",   e => { onStart(e.clientY); e.preventDefault(); });
  window.addEventListener("mousemove", e => onMove(e.clientY));
  window.addEventListener("mouseup",   e => onEnd(e.clientY));

  // Содержимое свёрнутой шапки шторки теперь переменной высоты (превью
  // последней тренировки добавляет строку), поэтому точку «свёрнуто» больше
  // нельзя зашивать фиксированным числом в CSS — пересчитываем её реальным
  // измерением каждый раз, когда меняется контент шапки (новая тренировка,
  // ресайз окна), если шторку сейчас никто не тащит и она не раскрыта.
  function reposition() {
    if (dragging || sheet.classList.contains("expanded")) return;
    const collapsed = getCollapsedTranslate();
    // Программный пересчёт — это коррекция позиции, а не жест пользователя:
    // ставим её мгновенно, без transition, иначе при заходе на экран и при
    // поздней догрузке последней тренировки шторка заметно «выезжает» (п.6).
    sheet.classList.add("no-anim");
    sheet.style.transform = `translateY(${collapsed}px)`;
    // Высота видимой шапки шторки (peek) → в CSS-переменную, чтобы по ней
    // центрировалась главная кнопка (п.2).
    const peek = Math.round(sheet.getBoundingClientRect().height - collapsed);
    screenMenu.style.setProperty("--sheet-peek", peek + "px");
    void sheet.offsetHeight; // фиксируем кадр до повторного включения анимации
    requestAnimationFrame(() => sheet.classList.remove("no-anim"));
  }
  window.addEventListener("resize", reposition);
  // На старте PWA на iOS высота dvh «плавает» первые кадры — из-за этого
  // свёрнутая шторка вставала не на место и снизу вылезал зазор. Добиваем
  // пересчётом после полной загрузки, возврата из фона и осадки viewport.
  window.addEventListener("load", () => { reposition(); requestAnimationFrame(reposition); });
  window.addEventListener("pageshow", reposition);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", reposition);
  setTimeout(reposition, 250);
  setTimeout(reposition, 600);
  window.repositionCollapsedSheet = reposition;
  window.settleSheet = settle;

  // Тап в свободную область экрана выше шторки (хедер, кнопка «начать»)
  // должен сворачивать её — раньше это работало только драгом или тапом по
  // самой шапке шторки.
  document.addEventListener("click", e => {
    if (!screenMenu.classList.contains("active")) return;
    if (!sheet.classList.contains("expanded")) return;
    // Только клики ВНУТРИ экрана меню (хедер, кнопка «начать») сворачивают
    // шторку. Иначе клик по кнопке «назад» на под-экране всплывает сюда уже
    // после goToScreen("menu") и схлопывает только что открытую шторку (п.3).
    if (!screenMenu.contains(e.target)) return;
    if (sheet.contains(e.target)) return;
    settle(false);
  });
})();

/* ==========================================================================
   Screen 3: Workout
   ========================================================================== */
let _workout = null;      // текущая активная тренировка (объект)
let _timerInt = null;     // setInterval handle секундомера тренировки

function stopWorkoutTimer() {
  if (_timerInt) { clearInterval(_timerInt); _timerInt = null; }
}

function initWorkoutScreen({ resume = false } = {}) {
  const userId = DATA.getCurrentUser();
  _workout = DATA.getActiveWorkout(userId);
  if (!_workout) return;

  $("workout-name-input").value = _workout.name || "Силовая тренировка";
  endRest(false);            // отдых не переживает навигацию — прячем пилюлю
  startWorkoutTimer();
  renderExerciseList();
  updateSummaryBar();
}

/* — Таймер на timestamp (спецификация 6.1) —
   Значение меняется раз в секунду, поэтому крутим лёгкий setInterval, а не
   requestAnimationFrame на 60 Гц, и трогаем DOM только когда строка изменилась. */
function startWorkoutTimer() {
  stopWorkoutTimer();
  const timerEl = $("workout-timer");
  let last = "";

  function tick() {
    if (!_workout) { stopWorkoutTimer(); return; }
    if (!screenWorkout.classList.contains("active")) return; // экран не виден — пропускаем
    const txt = formatDuration(Math.floor((Date.now() - _workout.startedAt) / 1000));
    if (txt !== last) { timerEl.textContent = txt; last = txt; }
  }
  tick();
  _timerInt = setInterval(tick, 500);
}

/* — Таймер отдыха между подходами —
   Запускается после отметки подхода «выполнено». Считает обратный отсчёт от
   90 c (можно крутить ±15), а фактически отдохнутое суммируется в
   _workout.restSec — общее время отдыха за тренировку (видно при завершении и
   в детальном просмотре). */
let _restInt = null;
let _restStartTs = 0;
let _restDurationSec = 90;     // подхватывается из DATA.getRestDefault() при старте
let _restNotifAsked = false;

// Сигнал окончания отдыха. На iOS Vibration API нет (navigator.vibrate
// отсутствует) — поэтому основной сигнал это звук (Web Audio). AudioContext
// создаём/возобновляем в обработчике тапа (жест пользователя), иначе iOS не
// даст воспроизвести звук.
let _audioCtx = null;
function ensureAudio() {
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === "suspended") _audioCtx.resume();
  } catch {}
}
function playRestDoneSound() {
  if (!_audioCtx) return;
  try {
    const now = _audioCtx.currentTime;
    [880, 1175].forEach((freq, i) => {           // две короткие ноты
      const osc = _audioCtx.createOscillator();
      const gain = _audioCtx.createGain();
      osc.type = "sine"; osc.frequency.value = freq;
      const t = now + i * 0.18;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.connect(gain); gain.connect(_audioCtx.destination);
      osc.start(t); osc.stop(t + 0.18);
    });
  } catch {}
}
function notifyRestDone() {
  // Если приложение свёрнуто и есть разрешение — системное уведомление.
  if (document.hidden && "Notification" in window && Notification.permission === "granted") {
    try { new Notification("train.", { body: "Отдых окончен 💪", tag: "rest-done" }); } catch {}
  }
}

function restRemaining() {
  return Math.max(0, _restDurationSec - Math.floor((Date.now() - _restStartTs) / 1000));
}
function renderRest() { $("rest-time").textContent = formatDuration(restRemaining()); }

// Завершить отдых. commit=true — зачесть фактически отдохнутые секунды в total.
function endRest(commit) {
  if (_restInt) { clearInterval(_restInt); _restInt = null; }
  if (commit && _restStartTs && _workout) {
    const rested = Math.min(_restDurationSec, Math.floor((Date.now() - _restStartTs) / 1000));
    _workout.restSec = (_workout.restSec || 0) + rested;
    saveWorkoutState();
  }
  _restStartTs = 0;
  const timer = $("rest-timer");
  timer.hidden = true;
  timer.style.bottom = "";                              // сбросить вычисленную позицию
  $("workout-scroll").classList.remove("rest-active");  // вернуть обычный нижний отступ
}

// Высота нижней safe-area (home-indicator). env() из JS напрямую не прочитать —
// меряем зондом.
function getSafeBottom() {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:0;bottom:0;width:0;height:env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none;";
  document.body.appendChild(probe);
  const h = probe.getBoundingClientRect().height || 0;
  probe.remove();
  return h;
}

// Размещение пилюли отдыха:
//  • если все упражнения помещаются на экране — центрируем пилюлю в свободном
//    месте под последним блоком (зазор сверху = зазору снизу);
//  • если список длинный (есть прокрутка) — пилюля у низа, а под неё в прокрутке
//    резервируется место, чтобы «Добавить упражнение» можно было доскроллить
//    выше пилюли.
function positionRestTimer() {
  const timer = $("rest-timer");
  if (timer.hidden) return;
  const scroll = $("workout-scroll");
  const addBtn = scroll.querySelector(".add-ex-btn");
  const th = timer.getBoundingClientRect().height || 56;
  const safe = getSafeBottom();

  // Запас места под пилюлю при длинном списке: верхний зазор (20+safe) + высота
  // пилюли + нижний зазор (20+safe) − margin кнопки (16) = th + 24 + 2·safe.
  // Кладём готовое px-значение: умножение env() на число внутри calc Chrome
  // считает невалидным и сбрасывает всё правило (поэтому safe учитываем тут).
  scroll.style.setProperty("--rest-reserve", Math.round(th + 24 + 2 * safe) + "px");

  // помещается ли контент без прокрутки (считаем без зарезервированного отступа)
  scroll.classList.remove("rest-active");
  const fits = addBtn && scroll.scrollHeight <= scroll.clientHeight + 1;

  const screenH = window.innerHeight;
  const freeTop = addBtn ? addBtn.getBoundingClientRect().bottom : 0;
  const freeBottom = screenH - safe;

  if (fits && (freeBottom - freeTop) >= th + 40) {
    const center = (freeTop + freeBottom) / 2;          // центр свободного места
    timer.style.bottom = Math.max(20 + safe, screenH - (center + th / 2)) + "px";
  } else {
    timer.style.bottom = "";                            // CSS-дефолт: 20px + safe
    scroll.classList.add("rest-active");                // резерв места под пилюлю
  }
}

function startRest() {
  endRest(true);                  // если отдых уже шёл — зачесть его и начать заново
  ensureAudio();                  // в контексте тапа — чтобы звук потом сработал
  // Один раз (в жесте) спросим разрешение на уведомления — для сигнала, когда
  // приложение свёрнуто.
  if (!_restNotifAsked && "Notification" in window && Notification.permission === "default") {
    _restNotifAsked = true;
    try { Notification.requestPermission(); } catch {}
  }
  _restDurationSec = DATA.getRestDefault();   // запомненный пользователем дефолт
  _restStartTs = Date.now();
  $("rest-timer").hidden = false;
  positionRestTimer();            // центрирует пилюлю в свободном месте либо ставит у низа
  renderRest();
  _restInt = setInterval(() => {
    if (restRemaining() <= 0) { haptic(40); playRestDoneSound(); notifyRestDone(); endRest(true); return; }
    renderRest();
  }, 250);
}
// ± меняют и текущий отдых, и запомненный дефолт (на следующие тренировки).
$("rest-minus").addEventListener("click", () => {
  _restDurationSec = Math.max(15, _restDurationSec - 15);
  DATA.setRestDefault(_restDurationSec);
  if (restRemaining() <= 0) endRest(true); else renderRest();
});
$("rest-plus").addEventListener("click", () => {
  _restDurationSec += 15;
  DATA.setRestDefault(_restDurationSec);
  renderRest();
});
$("rest-skip").addEventListener("click", () => endRest(true));

// Изменение размеров вьюпорта (поворот, адресная строка, клавиатура) — если
// идёт отдых, пересчитать положение пилюли.
window.addEventListener("resize", () => { if (!$("rest-timer").hidden) positionRestTimer(); });
if (window.visualViewport) window.visualViewport.addEventListener("resize", () => { if (!$("rest-timer").hidden) positionRestTimer(); });

// Фоновая синхронизация (sync.js) пишет в ту же персистентную активную
// тренировку отдельно от экрана (создаёт удалённый bin и проставляет его id).
// Перед каждым сохранением подхватываем этот id в свою копию, если он уже
// появился, — иначе следующая запись с экрана его сотрёт, и при следующей
// попытке синхронизации создастся вторая, дублирующая запись в JSONBin.
function carryRemoteBinId(target, userId) {
  if (target._remoteBinId) return;
  const persisted = DATA.getActiveWorkout(userId);
  if (persisted && persisted.id === target.id && persisted._remoteBinId) {
    target._remoteBinId = persisted._remoteBinId;
  }
}

function saveWorkoutState() {
  if (!_workout) return;
  _workout.name = $("workout-name-input").value || "Силовая тренировка";
  carryRemoteBinId(_workout, DATA.getCurrentUser());
  DATA.saveActiveWorkout(DATA.getCurrentUser(), _workout);
  SyncQueue.push("workout:update", { workoutId: _workout.id });
}

/* — Кнопки шапки — */
$("workout-back-btn").addEventListener("click", () => {
  endRest(true);      // зачесть текущий отдых, прежде чем уйти с экрана
  saveWorkoutState();
  stopWorkoutTimer(); // секундомер на кнопке меню сам покажет время активной тренировки
  goToScreen("menu");
});
$("workout-name-input").addEventListener("input", () => saveWorkoutState());

$("finish-workout-btn").addEventListener("click", finishWorkout);

function finishWorkout() {
  if (!_workout) return;
  endRest(true); // зачесть текущий отдых в общий итог до показа сводки
  const exCount = (_workout.exercises || []).length;
  const doneSets = (_workout.exercises || []).reduce((n, ex) => n + ex.sets.filter(s => s.done).length, 0);

  // Пустая тренировка (ни одного упражнения или ни одного отмеченного
  // подхода) — почти наверняка случайное нажатие «Начать». Раньше тут
  // просто показывался тост и пользователь застревал без возможности уйти
  // иначе как драматично свернуть приложение. Теперь явно предлагаем либо
  // вернуться, либо удалить тренировку целиком.
  if (!exCount || !doneSets) { openEmptyWorkoutModal(); return; }

  openFinishConfirmModal(exCount, doneSets);
}

function doFinishWorkout() {
  const userId = DATA.getCurrentUser();
  _workout.name = $("workout-name-input").value || "Силовая тренировка";
  _workout.durationSec = Math.floor((Date.now() - _workout.startedAt) / 1000);
  _workout.finishedAt = Date.now();
  carryRemoteBinId(_workout, userId);

  // Сначала убеждаемся, что тренировка реально записана в историю, и только
  // потом очищаем активную. Иначе при переполнении localStorage история не
  // сохранится (lsSet вернёт false), а активная — сотрётся, и тренировка
  // пропадёт целиком при «успешном» на вид завершении.
  if (!DATA.saveWorkout(userId, _workout)) {
    showToast("Не удалось сохранить — освободи место (удали старые тренировки) и попробуй снова");
    return; // активную НЕ трогаем — данные целы, можно повторить
  }
  DATA.updateRecords(userId, _workout);
  DATA.clearActiveWorkout(userId);
  SyncQueue.push("workout:finish", { workoutId: _workout.id });
  stopWorkoutTimer();
  _workout = null;

  showToast("Тренировка сохранена");
  goToScreen("menu");
}

function discardActiveWorkout() {
  const userId = DATA.getCurrentUser();
  endRest(false);
  // Если за сессию успел создаться удалённый бин (добавляли подходы дольше
  // дебаунса) — убираем его, чтобы отменённые тренировки не копились на JSONBin.
  const binId = _workout && _workout._remoteBinId;
  if (binId) Storage.deleteBin(binId).catch(e => console.warn("deleteBin failed", e));
  DATA.clearActiveWorkout(userId);
  stopWorkoutTimer();
  _workout = null;
  // Снять указатель на активную тренировку в пользовательском бине.
  SyncQueue.push("user:update", {});
  showToast("Тренировка удалена");
  goToScreen("menu");
}

function openFinishConfirmModal(exCount, doneSets) {
  if (document.getElementById("finish-confirm-cancel")) return;
  const volume = (_workout.exercises || []).reduce((v, ex) =>
    v + ex.sets.filter(s => s.done).reduce((sv, s) => sv + (s.weight || 0) * (s.reps || 0), 0), 0);
  const durationSec = Math.floor((Date.now() - _workout.startedAt) / 1000);

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop open";
  backdrop.innerHTML = `
    <div class="modal modal-form">
      <h2 class="modal-title">Завершить тренировку?</h2>
      <div class="finish-summary">
        <div class="finish-summary-row"><span>Упражнений</span><b>${exCount}</b></div>
        <div class="finish-summary-row"><span>Подходов</span><b>${doneSets}</b></div>
        ${volume ? `<div class="finish-summary-row"><span>Тоннаж</span><b>${volume.toLocaleString("ru-RU")} кг</b></div>` : ""}
        <div class="finish-summary-row"><span>Время</span><b>${formatDuration(durationSec)}</b></div>
        ${_workout.restSec ? `<div class="finish-summary-row"><span>Отдых</span><b>${formatDuration(_workout.restSec)}</b></div>` : ""}
      </div>
      <div class="modal-form-actions">
        <button class="btn-chip" id="finish-confirm-cancel">Отмена</button>
        <button class="btn-chip primary" id="finish-confirm-ok">Завершить</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  $("finish-confirm-cancel").addEventListener("click", () => backdrop.remove());
  $("finish-confirm-ok").addEventListener("click", () => { backdrop.remove(); doFinishWorkout(); });
  backdrop.addEventListener("click", e => { if (e.target === backdrop) backdrop.remove(); });
}

function openEmptyWorkoutModal() {
  if (document.getElementById("empty-continue-btn")) return;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop open";
  backdrop.innerHTML = `
    <div class="modal modal-form">
      <h2 class="modal-title">Пустая тренировка</h2>
      <p style="font-size:14px;color:var(--text-secondary);margin:0;line-height:1.5;">
        Ни одного выполненного подхода — похоже на случайное нажатие «Начать».
        Можно удалить тренировку или вернуться и продолжить её.
      </p>
      <div class="modal-form-actions">
        <button class="btn-chip" id="empty-continue-btn">Продолжить</button>
        <button class="btn-chip danger" id="empty-discard-btn">Удалить</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  $("empty-continue-btn").addEventListener("click", () => backdrop.remove());
  $("empty-discard-btn").addEventListener("click", () => { backdrop.remove(); discardActiveWorkout(); });
  backdrop.addEventListener("click", e => { if (e.target === backdrop) backdrop.remove(); });
}

/* Универсальная модалка-подтверждение опасного действия (удаление и т.п.). */
function openConfirmModal({ title, message, confirmLabel = "Удалить", cancelLabel = "Отмена", danger = true, onConfirm }) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop open";
  backdrop.innerHTML = `
    <div class="modal modal-form">
      <h2 class="modal-title">${escHtml(title || "Подтвердите действие")}</h2>
      ${message ? `<p style="font-size:14px;color:var(--text-secondary);margin:0;line-height:1.5;">${escHtml(message)}</p>` : ""}
      <div class="modal-form-actions">
        <button class="btn-chip" data-act="cancel">${escHtml(cancelLabel)}</button>
        <button class="btn-chip ${danger ? "danger" : "primary"}" data-act="ok">${escHtml(confirmLabel)}</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  backdrop.style.zIndex = "30";
  const close = () => backdrop.remove();
  backdrop.querySelector('[data-act="cancel"]').addEventListener("click", close);
  backdrop.querySelector('[data-act="ok"]').addEventListener("click", () => { close(); onConfirm && onConfirm(); });
  backdrop.addEventListener("click", e => { if (e.target === backdrop) close(); });
}

/* — Список упражнений — */
// Привести disabled-состояние стрелок «вверх/вниз» в соответствие с текущим
// порядком блоков в DOM. Нужно после точечной перестановки/удаления, чтобы не
// перерисовывать весь список.
function refreshReorderButtons() {
  const blocks = $("workout-scroll").querySelectorAll(".ex-block");
  blocks.forEach((b, i) => {
    const up   = b.querySelector('.ex-reorder-btn[data-dir="up"]');
    const down = b.querySelector('.ex-reorder-btn[data-dir="down"]');
    if (up)   up.disabled   = (i === 0);
    if (down) down.disabled = (i === blocks.length - 1);
  });
}

/* ============================================================
   Режим перестановки упражнений «как ярлыки на iOS».
   Долгое нажатие на блок → джиггл + крестик удаления + перетаскивание
   вверх/вниз для смены порядка. Крестик → подтверждение → удаление.
   ============================================================ */
let _exEdit = false;       // активен ли режим редактирования списка
let _drag = null;          // активное перетаскивание: { block, ex, grabDy, ty, pointerY, raf }

function enterExEditMode() {
  if (_exEdit) return;
  _exEdit = true;
  $("workout-scroll").classList.add("ex-editing");
  if (!$("ex-edit-done")) {
    const btn = document.createElement("button");
    btn.id = "ex-edit-done";
    btn.className = "ex-edit-done";
    btn.textContent = "Готово";
    btn.addEventListener("click", exitExEditMode);
    document.getElementById("screen-workout").appendChild(btn);
  }
}
function exitExEditMode() {
  endDrag(false);
  if (!_exEdit) return;
  _exEdit = false;
  $("workout-scroll").classList.remove("ex-editing");
  const btn = $("ex-edit-done");
  if (btn) btn.remove();
}

/* — Перетаскивание блока: общая логика для touch и mouse —
   Ключ к стабильности (п.6): смещение блока считаем КАЖДЫЙ кадр от его текущего
   положения в потоке (rect.top − ty), а не накоплением startY. Поэтому после
   перестановки соседей и автоскролла блок остаётся ровно под пальцем и не
   образуется зазор. Блок остаётся в потоке (не absolute) — его слот и есть
   место будущей вставки, поэтому «дырки» не возникает. */
function reorderDuringDrag(pointerY) {
  const d = _drag; if (!d) return;
  const arr = _workout.exercises;
  const h = d.block.getBoundingClientRect().height;
  const center = (pointerY - d.grabDy) + h / 2;     // куда «целится» центр блока
  const prev = d.block.previousElementSibling;
  if (prev && prev.classList.contains("ex-block")) {
    const r = prev.getBoundingClientRect();
    if (center < r.top + r.height / 2) {
      const i = arr.indexOf(d.ex);
      if (i > 0) { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; d.block.parentNode.insertBefore(d.block, prev); }
      return;
    }
  }
  const next = d.block.nextElementSibling;
  if (next && next.classList.contains("ex-block")) {
    const r = next.getBoundingClientRect();
    if (center > r.top + r.height / 2) {
      const i = arr.indexOf(d.ex);
      if (i < arr.length - 1) { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; d.block.parentNode.insertBefore(next, d.block); }
      return;
    }
  }
}

function dragMoveTo(pointerY) {
  const d = _drag; if (!d) return;
  d.pointerY = pointerY;
  reorderDuringDrag(pointerY);
  const rect = d.block.getBoundingClientRect();
  const naturalTop = rect.top - d.ty;               // положение в потоке без transform
  d.ty = (pointerY - d.grabDy) - naturalTop;
  d.block.style.transform = `translateY(${d.ty}px)`;
}

// Автоскролл, когда палец у верхней/нижней кромки списка во время перетаскивания.
function autoScrollTick() {
  const d = _drag; if (!d) return;
  const scroll = $("workout-scroll");
  const r = scroll.getBoundingClientRect();
  const edge = 72;
  let dy = 0;
  if (d.pointerY < r.top + edge)         dy = -Math.ceil((r.top + edge - d.pointerY) / 4);
  else if (d.pointerY > r.bottom - edge) dy =  Math.ceil((d.pointerY - (r.bottom - edge)) / 4);
  if (dy) {
    const before = scroll.scrollTop;
    scroll.scrollTop = before + Math.max(-16, Math.min(16, dy));
    if (scroll.scrollTop !== before) dragMoveTo(d.pointerY);   // держим блок под пальцем
  }
  d.raf = requestAnimationFrame(autoScrollTick);
}

function startDrag(block, ex, pointerY) {
  if (!_exEdit) enterExEditMode();
  const top = block.getBoundingClientRect().top;
  _drag = { block, ex, grabDy: pointerY - top, ty: 0, pointerY, raf: 0 };
  block.style.transition = "none";
  block.classList.add("dragging");
  haptic(18);
  _drag.raf = requestAnimationFrame(autoScrollTick);
}

function endDrag(commit) {
  const d = _drag; if (!d) return;
  _drag = null;
  if (d.raf) cancelAnimationFrame(d.raf);
  const block = d.block;
  block.style.transition = "transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1)";
  block.style.transform = "";
  block.classList.remove("dragging");
  setTimeout(() => { block.style.transition = ""; }, 200);
  if (commit) saveWorkoutState();
}

// Долгое нажатие → режим перестановки + сразу подхват блока тем же касанием
// (как иконки на iOS). До подхвата любой сдвиг >8px отменяет таймер и отдаётся
// нативному скроллу/свайпу строки; touchmove НЕ passive, но preventDefault
// зовём только когда уже тащим — поэтому в режиме можно и скроллить, и таскать.
function wireExBlockGestures(block, ex) {
  let holdTimer = null, sx = 0, sy = 0, engaged = false, moved = false;
  const delay = () => (_exEdit ? 160 : 430);
  const clearHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };
  const canStart = (target) => {
    if (target.closest(".ex-del-badge")) return false;     // крестик — отдаём клику
    // вне режима не мешаем вводу, кнопкам и свайпу подхода
    if (!_exEdit && target.closest("input, textarea, button, .set-row")) return false;
    return true;
  };
  const begin = (x, y, target) => {
    engaged = false; moved = false; sx = x; sy = y;
    if (!canStart(target)) return;
    clearHold();
    holdTimer = setTimeout(() => {
      holdTimer = null;
      if (moved) return;
      engaged = true;
      startDrag(block, ex, y);
    }, delay());
  };
  const move = (x, y, e) => {
    if (engaged) { if (e && e.cancelable) e.preventDefault(); dragMoveTo(y); return; }
    if (holdTimer && (Math.abs(x - sx) > 8 || Math.abs(y - sy) > 8)) { moved = true; clearHold(); }
  };
  const finish = () => { clearHold(); if (engaged) { engaged = false; endDrag(true); } };

  // touch — основной путь на телефоне
  block.addEventListener("touchstart", (e) => { const t = e.touches[0]; begin(t.clientX, t.clientY, e.target); }, { passive: true });
  block.addEventListener("touchmove",  (e) => { const t = e.touches[0]; if (t) move(t.clientX, t.clientY, e); }, { passive: false });
  block.addEventListener("touchend",   finish);
  block.addEventListener("touchcancel", finish);

  // mouse — для проверки на десктопе (скролл колесом не конфликтует)
  const onMouseMove = (e) => move(e.clientX, e.clientY, e);
  const onMouseUp   = () => { finish(); window.removeEventListener("mousemove", onMouseMove); window.removeEventListener("mouseup", onMouseUp); };
  block.addEventListener("mousedown", (e) => {
    if (!canStart(e.target)) return;
    begin(e.clientX, e.clientY, e.target);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  });
}

function renderExerciseList() {
  const scroll = $("workout-scroll");
  exitExEditMode();          // любой перерендер сбрасывает режим редактирования
  const addBtn = scroll.querySelector(".add-ex-btn");
  // Удаляем старые блоки
  scroll.querySelectorAll(".ex-block").forEach(el => el.remove());

  // Чтения из localStorage поднимаем из цикла: раньше getVisibleExercises и
  // getLastWorkoutForExercise дёргались на каждое упражнение (а внутри —
  // повторный парс всей истории). Теперь по одному разу на рендер.
  const userId  = DATA.getCurrentUser();
  const visible = DATA.getVisibleExercises(userId);
  const history = DATA.getWorkoutHistory(userId);
  const findLast = exId => history.find(w => w.type === "strength"
      && (w.exercises || []).some(e => e.exerciseId === exId)) || null;

  (_workout.exercises || []).forEach((ex, idx) => {
    // Имя берём из живого справочника; если упражнение пропало из личного
    // списка — из снимка имени в самом блоке (ex.name), и лишь в крайнем
    // случае показываем нейтральную заглушку вместо сырого e_own_… id.
    const exDef = visible.find(e => e.id === ex.exerciseId)
      || { name: ex.name || "Упражнение недоступно" };
    const rec = DATA.getExerciseRecord(userId, ex.exerciseId);
    const lastWorkout = findLast(ex.exerciseId);
    // «Прошлый раз» больше не выводим отдельной строкой — прошлые значения
    // показываются только подсказкой-тенью в пустых полях (см. renderSetsInBlock), п.4.

    // Рекорд веса — компактный бейдж в шапке (как в макете 03).
    let prChip = "";
    if (rec && rec.maxWeight > 0) {
      prChip = `<span class="ex-pr-chip" title="Рекорд: ${rec.maxWeight} кг × ${rec.repsAtMaxWeight}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 7.4H22l-6 4.6 2.3 7.4L12 17l-6.3 4.4L8 14 2 9.4h7.6z"/></svg>
        ${rec.maxWeight} кг
      </span>`;
    }

    const block = document.createElement("div");
    block.className = "ex-block";

    block.innerHTML = `
      <button class="ex-del-badge" title="Удалить упражнение" aria-label="Удалить упражнение">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      <div class="ex-block-header">
        <span class="ex-block-name" title="${escHtml(exDef.name)}">${escHtml(exDef.name)}</span>
        ${prChip}
      </div>
      <div class="ex-divider"></div>
      <div class="sets-table">
        <div class="sets-header"><span>#</span><span>Кг</span><span>Повт</span><span>RPE</span><span></span></div>
        <div class="sets-body"></div>
      </div>
      <textarea class="set-note-input" placeholder="Заметка к тренировке…" rows="2">${ex.note || ""}</textarea>
      <div class="sets-actions">
        <button class="btn-chip add-set-btn" style="flex:1">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Добавить подход
        </button>
        <button class="set-note-btn ${ex.note ? "has-note" : ""}" title="Заметка">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L13 14l-4 1 1-4 6.5-6.5z"/></svg>
        </button>
      </div>
    `;

    // Render sets
    renderSetsInBlock(block, ex, lastWorkout);

    // Удаление (крестик в режиме редактирования) — с подтверждением.
    block.querySelector(".ex-del-badge").addEventListener("click", (e) => {
      e.stopPropagation();
      openConfirmModal({
        title: "Удалить упражнение?",
        message: `«${exDef.name}» и все его подходы будут удалены из тренировки.`,
        confirmLabel: "Удалить",
        onConfirm: () => {
          const i = _workout.exercises.indexOf(ex);
          if (i !== -1) _workout.exercises.splice(i, 1);
          block.remove();
          saveWorkoutState();
          updateSummaryBar();
          if (!_workout.exercises.length) exitExEditMode();
        }
      });
    });

    // Зажатие (long-press) → режим перестановки; в нём блок тащится вверх/вниз.
    wireExBlockGestures(block, ex);

    // Add set
    block.querySelector(".add-set-btn").addEventListener("click", () => {
      haptic();
      // prefill from last set
      const last = ex.sets[ex.sets.length - 1];
      ex.sets.push({ weight: last ? last.weight : 0, reps: last ? last.reps : 0, rpe: 0, done: false });
      saveWorkoutState();
      renderSetsInBlock(block, ex, lastWorkout);
      updateSummaryBar();
    });

    // Note toggle
    const noteBtn   = block.querySelector(".set-note-btn");
    const noteInput = block.querySelector(".set-note-input");
    if (ex.note) noteInput.classList.add("visible");
    noteBtn.addEventListener("click", () => {
      // Не фокусируем поле автоматически — чтобы клавиатура не выскакивала,
      // когда пользователь просто хочет посмотреть уже записанную заметку (п.3).
      noteInput.classList.toggle("visible");
    });
    noteInput.addEventListener("input", () => {
      ex.note = noteInput.value;
      noteBtn.classList.toggle("has-note", !!ex.note);
      saveWorkoutState();
    });

    scroll.insertBefore(block, addBtn);
  });
}

// lastWorkout передаёт renderExerciseList (уже посчитан один раз на рендер);
// если не передан (одиночный вызов), считаем тут.
function renderSetsInBlock(block, ex, lastWorkout) {
  const tbody = block.querySelector(".sets-body");
  tbody.innerHTML = "";

  if (lastWorkout === undefined) {
    lastWorkout = DATA.getLastWorkoutForExercise(DATA.getCurrentUser(), ex.exerciseId);
  }
  const lastExData  = lastWorkout ? lastWorkout.exercises.find(e => e.exerciseId === ex.exerciseId) : null;
  const lastSets    = lastExData  ? lastExData.sets.filter(s => s.done) : [];

  ex.sets.forEach((set, sIdx) => {
    const prev = lastSets[sIdx];
    const wrap = document.createElement("div");
    wrap.className = "set-row-wrap";
    const del = document.createElement("div");
    del.className = "set-row-delete";
    del.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg><span>Удалить</span>`;
    const row = document.createElement("div");
    row.className = "set-row";
    row.innerHTML = `
      <span class="set-num">${sIdx + 1}</span>
      <div class="set-field"><input type="number" inputmode="decimal" placeholder="${prev ? prev.weight : "кг"}" value="${set.weight || ""}" step="0.5" ${prev ? 'class="has-prev"' : ""}></div>
      <div class="set-field"><input type="number" inputmode="numeric" placeholder="${prev ? prev.reps : "повт"}" value="${set.reps || ""}" ${prev ? 'class="has-prev"' : ""}></div>
      <button class="rpe-btn ${set.rpe ? "has-rpe" : ""}" aria-label="RPE — усилие подхода" title="RPE — усилие подхода">${set.rpe || "—"}</button>
      <button class="set-done-btn ${set.done ? "done" : ""}" title="Отметить выполненным">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </button>
    `;

    // Weight input
    const weightInput = row.querySelectorAll("input")[0];
    weightInput.addEventListener("change", () => {
      ex.sets[sIdx].weight = parseFloat(weightInput.value) || 0;
      saveWorkoutState(); updateSummaryBar();
    });

    // Reps input
    const repsInput = row.querySelectorAll("input")[1];
    repsInput.addEventListener("change", () => {
      ex.sets[sIdx].reps = parseInt(repsInput.value) || 0;
      saveWorkoutState(); updateSummaryBar();
    });

    // RPE button — индекс упражнения берём живым (блоки могут переставляться),
    // чтобы пикер писал RPE именно в это упражнение.
    row.querySelector(".rpe-btn").addEventListener("click", () => {
      openRpePicker(_workout.exercises.indexOf(ex), sIdx);
    });

    // Done toggle
    row.querySelector(".set-done-btn").addEventListener("click", () => {
      haptic();
      // Snag current input values before toggling
      ex.sets[sIdx].weight = parseFloat(weightInput.value) || 0;
      ex.sets[sIdx].reps   = parseInt(repsInput.value) || 0;
      ex.sets[sIdx].done   = !ex.sets[sIdx].done;
      if (ex.sets[sIdx].done) startRest(); // подход выполнен — пошёл отдых
      saveWorkoutState();
      renderSetsInBlock(block, ex, lastWorkout);
      updateSummaryBar();
    });

    // Свайп влево по строке → удалить подход (п.7). Удаляем по ссылке на объект
    // подхода: индексы после ре-рендера сдвигаются.
    wrap.appendChild(del);
    wrap.appendChild(row);
    wireSetRowSwipe(wrap, row, () => {
      const i = ex.sets.indexOf(set);
      if (i === -1) return;
      ex.sets.splice(i, 1);
      saveWorkoutState();
      renderSetsInBlock(block, ex, lastWorkout);
      updateSummaryBar();
      showToast("Подход удалён");
    });
    tbody.appendChild(wrap);
  });
}

// Горизонтальный свайп влево по строке подхода → раскрыть зону «Удалить»;
// за порогом отпускания подход удаляется, иначе строка возвращается. Вертикаль
// отдаём скроллу; в режиме перестановки свайп выключен. (п.7)
function wireSetRowSwipe(wrap, row, onDelete) {
  let sx = 0, sy = 0, dx = 0, active = false, decided = false, horiz = false, swiped = false;
  const MAX = 132, DEL = 92;
  row.addEventListener("pointerdown", (e) => {
    if (_exEdit) return;
    if (e.target.closest("input")) return;          // правка веса/повторов — не свайп
    sx = e.clientX; sy = e.clientY; dx = 0;
    active = true; decided = false; horiz = false; swiped = false;
    row.style.transition = "";
  });
  row.addEventListener("pointermove", (e) => {
    if (!active) return;
    const mx = e.clientX - sx, my = e.clientY - sy;
    if (!decided) {
      if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
      decided = true;
      // Только явный свайп ВЛЕВО; при любом намёке на вертикаль отдаём скроллу —
      // иначе при резком скролле мелькала красная зона удаления (п.1).
      horiz = mx < 0 && Math.abs(mx) > Math.abs(my);
      if (!horiz) { active = false; return; }
      wrap.classList.add("swiping");                 // показать подложку только сейчас
      row.style.willChange = "transform";
      try { row.setPointerCapture(e.pointerId); } catch {}
    }
    dx = Math.max(-MAX, Math.min(0, mx));            // тянем только влево
    if (dx < -4) swiped = true;
    row.style.transform = `translateX(${dx}px)`;
    wrap.classList.toggle("will-delete", dx <= -DEL);
  });
  // Во время горизонтального свайпа гасим вертикальный скролл (п.2).
  row.addEventListener("touchmove", (e) => {
    if (!active) return;
    const t = e.touches[0]; if (!t) return;
    const mx = t.clientX - sx, my = t.clientY - sy;
    if (horiz || (Math.abs(mx) >= 10 && mx < 0 && Math.abs(mx) > Math.abs(my))) {
      if (e.cancelable) e.preventDefault();
    }
  }, { passive: false });
  const settle = () => {
    if (!active) return;
    active = false;
    if (!horiz) return;
    if (dx <= -DEL) {
      row.style.transition = "transform 0.16s ease";
      row.style.transform = "translateX(-110%)";
      wrap.style.height = wrap.offsetHeight + "px";
      requestAnimationFrame(() => {
        wrap.style.transition = "height 0.16s ease, opacity 0.16s ease";
        wrap.style.height = "0"; wrap.style.opacity = "0";
      });
      setTimeout(onDelete, 180);
    } else {
      row.style.transition = "transform 0.18s ease";
      row.style.transform = "";
      wrap.classList.remove("will-delete");
      setTimeout(() => { wrap.classList.remove("swiping"); row.style.willChange = ""; }, 200);
    }
  };
  row.addEventListener("pointerup", settle);
  row.addEventListener("pointercancel", settle);
  // Если это был свайп — подавляем последующий клик, чтобы случайно не
  // переключить «выполнено»/RPE.
  row.addEventListener("click", (e) => {
    if (swiped) { e.stopPropagation(); e.preventDefault(); swiped = false; }
  }, true);
}

function updateSummaryBar() {
  const exs = (_workout && _workout.exercises) || [];
  const doneSets = exs.reduce((n, ex) => n + ex.sets.filter(s => s.done).length, 0);
  const volume   = exs.reduce((v, ex) => v + ex.sets.filter(s => s.done).reduce((sv, s) => sv + (s.weight || 0) * (s.reps || 0), 0), 0);
  $("sum-exercises").textContent = exs.length;
  $("sum-sets").textContent = doneSets;
  $("sum-volume").textContent = volume.toLocaleString("ru-RU"); // как в модалке завершения и статистике
  // Контент мог изменить высоту (добавили/удалили подход/упражнение) — если идёт
  // отдых, пересчитать положение пилюли.
  if (!$("rest-timer").hidden) positionRestTimer();
}

/* — Добавить упражнение — */
$("add-ex-btn").addEventListener("click", () => openExercisePicker(addExerciseToWorkout));

let _pickerOnSelect = addExerciseToWorkout;

let _pickerCat = "Все";   // активная вкладка-категория пикера

let _pickerSelectedId = null;

function openExercisePicker(onSelect, selectedId) {
  _pickerOnSelect = onSelect || addExerciseToWorkout;
  _pickerSelectedId = selectedId || null;
  _pickerCat = "Все";
  pickerSearch.value = "";
  renderPickerTabs();
  renderPickerList("");
  if (pickerList) pickerList.scrollTop = 0;
  pickerBackdrop.classList.add("open");
  // Без авто-фокуса на поиск: иначе клавиатура сразу перекрывает вкладки и
  // список. Поиск открывается по тапу пользователем (п.5).
}
function closeExercisePicker() { pickerBackdrop.classList.remove("open"); }
pickerBackdrop.addEventListener("click", e => { if (e.target === pickerBackdrop) closeExercisePicker(); });
pickerSearch.addEventListener("input", () => {
  // Активный поиск перекрывает фильтр по вкладке — возвращаем вкладку на «Все».
  if (pickerSearch.value.trim() && _pickerCat !== "Все") { _pickerCat = "Все"; renderPickerTabs(); }
  renderPickerList(pickerSearch.value);
});

// «Все» + реально присутствующие у пользователя категории, в порядке справочника.
function pickerCategories() {
  const present = new Set(DATA.getVisibleExercises(DATA.getCurrentUser()).map(e => e.cat));
  const ordered = (DATA.EXERCISE_CATEGORIES || []).filter(c => present.has(c));
  present.forEach(c => { if (!ordered.includes(c)) ordered.push(c); });   // вне справочника — в конец
  return ["Все", ...ordered];
}

function renderPickerTabs() {
  if (!pickerTabs) return;
  const userId = DATA.getCurrentUser();
  pickerTabs.innerHTML = pickerCategories().map(c => {
    const active = c === _pickerCat ? " active" : "";
    const color = c === "Все" ? "var(--accent)" : DATA.getCategoryColor(userId, c);
    return `<button class="picker-tab${active}" data-cat="${escHtml(c)}" style="--tab-color:${escHtml(color)}">${escHtml(c)}</button>`;
  }).join("");
  pickerTabs.querySelectorAll(".picker-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      _pickerCat = tab.dataset.cat;
      if (pickerSearch.value) pickerSearch.value = "";   // выбор вкладки сбрасывает поиск
      renderPickerTabs();
      renderPickerList("");
      pickerList.scrollTop = 0;
      tab.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
    });
  });
}

function renderPickerList(query) {
  const q = query.trim().toLowerCase();
  const all = DATA.getVisibleExercises(DATA.getCurrentUser());
  let filtered;
  if (q) {
    filtered = all.filter(e => e.name.toLowerCase().includes(q) || e.cat.toLowerCase().includes(q));
  } else if (_pickerCat && _pickerCat !== "Все") {
    filtered = all.filter(e => e.cat === _pickerCat);
  } else {
    filtered = all;
  }

  if (!filtered.length) {
    pickerList.innerHTML = `<p style="padding:24px 16px;color:var(--text-tertiary);font-size:14px">Ничего не найдено</p>`;
    return;
  }

  const userId = DATA.getCurrentUser();
  const SVG_CHECK = `<svg class="picker-item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="20 6 9 17 4 12"/></svg>`;
  const itemHtml = e => {
    const sel = e.id === _pickerSelectedId;
    const color = DATA.getCategoryColor(userId, e.cat);
    return `
    <div class="picker-item${sel ? " selected" : ""}" data-id="${escHtml(e.id)}" style="--cat-color:${escHtml(color)}">
      <span class="picker-item-name">${escHtml(e.name)}</span>
      ${sel ? SVG_CHECK : ""}
    </div>`;
  };

  if (!q && _pickerCat !== "Все") {
    // Конкретная категория — плоский список без повторного заголовка.
    pickerList.innerHTML = filtered.map(itemHtml).join("");
  } else {
    // «Все»/поиск — с разбивкой по категориям (заголовок с цветной точкой).
    const groups = {};
    filtered.forEach(e => { (groups[e.cat] = groups[e.cat] || []).push(e); });
    pickerList.innerHTML = Object.entries(groups).map(([cat, exs]) => {
      const color = DATA.getCategoryColor(userId, cat);
      return `<div class="picker-section-label"><span class="picker-section-dot" style="background:${escHtml(color)}"></span>${escHtml(cat)}<span class="picker-section-count">${exs.length}</span></div>${exs.map(itemHtml).join("")}`;
    }).join("");
  }

  pickerList.querySelectorAll(".picker-item").forEach(item => {
    item.addEventListener("click", () => {
      _pickerOnSelect(item.dataset.id);
      closeExercisePicker();
    });
  });
}

/* Закрытие шторки пикера свайпом вниз (п.4). Тянем сам лист вниз; если палец в
   списке — только когда он прокручен в самый верх, иначе это его прокрутка. */
(function setupPickerSwipe() {
  const sheet = pickerBackdrop.querySelector(".picker-sheet");
  if (!sheet) return;
  let startY = 0, startX = 0, dy = 0, active = false, decided = false, vert = false, onList = false;
  const down = (y, x, target) => {
    active = true; decided = false; vert = false; dy = 0; startY = y; startX = x;
    onList = !!(target.closest && target.closest(".picker-list"));
    sheet.style.transition = "none";
  };
  const moveTo = (y, x, e) => {
    if (!active) return;
    const d = y - startY;
    const dx = x - startX;
    if (!decided) {
      if (Math.abs(d) < 6 && Math.abs(dx) < 6) return;
      decided = true;
      const horiz = Math.abs(dx) > Math.abs(d);
      vert = !horiz && d > 0 && (!onList || pickerList.scrollTop <= 0);
      if (!vert) { active = false; sheet.style.transition = ""; return; }   // отдаём прокрутке
    }
    dy = Math.max(0, d);
    if (e && e.cancelable) e.preventDefault();
    sheet.style.transform = `translateY(${dy}px)`;
  };
  const up = () => {
    if (!active) return;
    active = false;
    sheet.style.transition = "";
    if (!vert) return;
    sheet.style.transform = "";              // снимаем inline → дальше рулит CSS
    if (dy > 110) closeExercisePicker();     // .open снимется → лист уезжает вниз
  };
  sheet.addEventListener("touchstart", e => down(e.touches[0].clientY, e.touches[0].clientX, e.target), { passive: true });
  sheet.addEventListener("touchmove",  e => { const t = e.touches[0]; if (t) moveTo(t.clientY, t.clientX, e); }, { passive: false });
  sheet.addEventListener("touchend", up);
  sheet.addEventListener("touchcancel", up);
  sheet.addEventListener("mousedown", e => {
    down(e.clientY, e.clientX, e.target);
    const mm = ev => moveTo(ev.clientY, ev.clientX, ev);
    const mu = () => { up(); window.removeEventListener("mousemove", mm); window.removeEventListener("mouseup", mu); };
    window.addEventListener("mousemove", mm);
    window.addEventListener("mouseup", mu);
  });
})();

function addExerciseToWorkout(exerciseId) {
  if (!_workout) return;
  // Префилл количеством подходов из прошлой тренировки делаем здесь, при
  // добавлении (а не в renderExerciseList — рендер не должен мутировать данные).
  const lastWorkout = DATA.getLastWorkoutForExercise(DATA.getCurrentUser(), exerciseId);
  const lastEx = lastWorkout ? lastWorkout.exercises.find(e => e.exerciseId === exerciseId) : null;
  const lastSets = lastEx ? lastEx.sets.filter(s => s.done && (s.weight || s.reps)) : [];
  const sets = lastSets.length > 1
    ? lastSets.map(() => ({ weight: 0, reps: 0, rpe: 0, done: false }))
    : [{ weight: 0, reps: 0, rpe: 0, done: false }];
  // Снимок имени кладём в сам блок тренировки: если позже упражнение
  // удалят/потеряют из личного списка (в т.ч. при гонке синхронизации),
  // тренировка всё равно покажет имя, а не сырой id (см. рендер ниже).
  const exName = DATA.getVisibleExercises(DATA.getCurrentUser()).find(e => e.id === exerciseId)?.name;
  _workout.exercises.push({ exerciseId, name: exName, sets });
  saveWorkoutState();
  renderExerciseList();
  updateSummaryBar();
  // Scroll to new block
  const scroll = $("workout-scroll");
  setTimeout(() => { scroll.scrollTop = scroll.scrollHeight; }, 50);
}

/* — RPE picker — */
let _rpeTarget = null; // { exIdx, sIdx }

function openRpePicker(exIdx, sIdx) {
  _rpeTarget = { exIdx, sIdx };
  const current = _workout.exercises[exIdx].sets[sIdx].rpe || 0;

  rpeGrid.innerHTML = [1,2,3,4,5,6,7,8,9,10].map(n => `
    <button class="rpe-option ${n === current ? "selected" : ""}" data-rpe="${n}">${n}</button>
  `).join("");
  rpeHint.textContent = current ? DATA.RPE_LABELS[current] : "";

  rpeGrid.querySelectorAll(".rpe-option").forEach(btn => {
    btn.addEventListener("click", () => {
      const val = parseInt(btn.dataset.rpe);
      _workout.exercises[_rpeTarget.exIdx].sets[_rpeTarget.sIdx].rpe = val;
      saveWorkoutState();
      rpeGrid.querySelectorAll(".rpe-option").forEach(b => b.classList.toggle("selected", parseInt(b.dataset.rpe) === val));
      rpeHint.textContent = DATA.RPE_LABELS[val];
      setTimeout(() => {
        rpeBackdrop.classList.remove("open");
        // Re-render only the affected block
        renderExerciseList();
      }, 280);
    });
    btn.addEventListener("mouseenter", () => { rpeHint.textContent = DATA.RPE_LABELS[parseInt(btn.dataset.rpe)]; });
    btn.addEventListener("mouseleave", () => { rpeHint.textContent = _rpeTarget ? DATA.RPE_LABELS[_workout.exercises[_rpeTarget.exIdx].sets[_rpeTarget.sIdx].rpe] || "" : ""; });
  });

  rpeBackdrop.classList.add("open");
}
rpeBackdrop.addEventListener("click", e => { if (e.target === rpeBackdrop) rpeBackdrop.classList.remove("open"); });

/* ==========================================================================
   Screen 4: Run
   ========================================================================== */
let _run = null;
let _runBests = {};
let _runPrev  = null;
// Per-tab field drafts — cleared on fresh start, persisted across tab switches
const _runTabData = { easy: null, long: null, hard: null };

const RUN_TYPE_NAMES = { easy: "Лёгкая пробежка", long: "Длинная пробежка", hard: "Тяжёлая пробежка" };

// --- Duration helpers (split HH:MM:SS) ---
function getRunDurSec() {
  const h = parseInt($("run-dur-h").value) || 0;
  const m = parseInt($("run-dur-m").value) || 0;
  const s = parseInt($("run-dur-s").value) || 0;
  return h * 3600 + m * 60 + s;
}
function getRunDurStr() {
  const h = parseInt($("run-dur-h").value) || 0;
  const m = parseInt($("run-dur-m").value) || 0;
  const s = parseInt($("run-dur-s").value) || 0;
  if (!h && !m && !s) return "";
  return `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}
function setRunDurFromStr(str) {
  if (!str) { $("run-dur-h").value = ""; $("run-dur-m").value = ""; $("run-dur-s").value = ""; return; }
  const parts = String(str).split(":").map(Number);
  if (parts.length === 3) {
    $("run-dur-h").value = String(parts[0]).padStart(2,"0");
    $("run-dur-m").value = String(parts[1]).padStart(2,"0");
    $("run-dur-s").value = String(parts[2]).padStart(2,"0");
  } else if (parts.length === 2) {
    $("run-dur-h").value = "00";
    $("run-dur-m").value = String(parts[0]).padStart(2,"0");
    $("run-dur-s").value = String(parts[1]).padStart(2,"0");
  }
}

// --- Best / prev helpers ---
function getRunBests(userId, runType) {
  const history = DATA.getWorkoutHistory(userId)
    .filter(w => w.type === "run" && w.runType === runType);
  if (!history.length) return {};
  let bestPaceSec = Infinity, bestDurSec = Infinity, bestDist = -Infinity, bestCad = -Infinity, bestHR = Infinity;
  history.forEach(w => {
    if (w.pace) { const ps = paceStrToSec(w.pace); if (ps > 0 && ps < bestPaceSec) bestPaceSec = ps; }
    if (w.durationSec && w.durationSec < bestDurSec) bestDurSec = w.durationSec;
    const d = parseFloat(w.distance); if (d > 0 && d > bestDist) bestDist = d;
    if (w.cadence && w.cadence > bestCad) bestCad = w.cadence;
    if (w.heartRate && w.heartRate < bestHR) bestHR = w.heartRate;
  });
  return {
    paceSec: bestPaceSec === Infinity ? null : bestPaceSec,
    durSec:  bestDurSec  === Infinity ? null : bestDurSec,
    dist:    bestDist    === -Infinity ? null : bestDist,
    cad:     bestCad     === -Infinity ? null : bestCad,
    hr:      bestHR      === Infinity  ? null : bestHR,
  };
}
function getPrevRunOfType(userId, runType) {
  return DATA.getWorkoutHistory(userId).find(w => w.type === "run" && w.runType === runType) || null;
}

// --- Active tab ---
function activeRunType() {
  return document.querySelector(".run-type-tab.active")?.dataset.type || "easy";
}

// --- Save / restore per-tab field values ---
function saveCurrentTabData() {
  const type = activeRunType();
  _runTabData[type] = {
    h: $("run-dur-h")?.value || "",
    m: $("run-dur-m")?.value || "",
    s: $("run-dur-s")?.value || "",
    distance: $("run-distance")?.value || "",
    cadence:  $("run-cadence")?.value  || "",
    hr:       $("run-hr")?.value       || "",
  };
}
function restoreTabData(type) {
  const d = _runTabData[type];
  const set = (id, v) => { const el = $(id); if (el) el.value = v || ""; };
  set("run-dur-h", d?.h); set("run-dur-m", d?.m); set("run-dur-s", d?.s);
  set("run-distance", d?.distance); set("run-cadence", d?.cadence); set("run-hr", d?.hr);
}

// --- Update pace (reads from split inputs) ---
function updatePace() {
  const distVal   = parseFloat($("run-distance").value);
  const totalSec  = getRunDurSec();
  const paceEl    = $("run-pace");
  const paceField = $("run-field-pace");
  if (!distVal || !totalSec) {
    if (_runPrev?.pace) {
      paceEl.textContent = _runPrev.pace;
      if (paceField) paceField.classList.add("pace-hint");
    } else {
      paceEl.textContent = "—";
      if (paceField) paceField.classList.remove("pace-hint");
    }
    updateRunHighlights();
    return;
  }
  const paceSec = totalSec / distVal;
  const m = Math.floor(paceSec / 60);
  const s = Math.round(paceSec % 60);
  paceEl.textContent = `${m}:${String(s).padStart(2, "0")}`;
  if (paceField) paceField.classList.remove("pace-hint");
  updateRunHighlights();
}

// --- Green cell highlighting ---
function updateRunHighlights() {
  const isPaceHint = $("run-field-pace")?.classList.contains("pace-hint");
  const curPaceTxt = isPaceHint ? null : $("run-pace")?.textContent;
  const curPaceSec = (curPaceTxt && curPaceTxt !== "—") ? paceStrToSec(curPaceTxt) : null;
  const curDist    = parseFloat($("run-distance")?.value);
  const curCad     = parseInt($("run-cadence")?.value)  || 0;
  const curHR      = parseInt($("run-hr")?.value)       || 0;

  const b = _runBests;  // all-time bests (gold)
  const p = _runPrev;   // previous run (green)

  const prevPaceSec = p?.pace      ? paceStrToSec(p.pace)     : null;
  const prevDist    = p?.distance  != null ? parseFloat(p.distance)  : null;
  const prevCad     = p?.cadence   != null ? parseInt(p.cadence)     : null;
  const prevHR      = p?.heartRate != null ? parseInt(p.heartRate)   : null;

  // Gold: strictly beat all-time record
  const paceNew = curPaceSec != null && b.paceSec != null && curPaceSec < b.paceSec;
  const distNew = curDist > 0 && b.dist != null && curDist > b.dist;
  const cadNew  = curCad  > 0 && b.cad  != null && curCad  > b.cad;
  const hrNew   = curHR   > 0 && b.hr   != null && curHR   < b.hr;

  // Green: beat previous run (only when not already gold)
  const pacePrev = !paceNew && curPaceSec != null && prevPaceSec != null && curPaceSec < prevPaceSec;
  const distPrev = !distNew && curDist > 0 && prevDist != null && curDist > prevDist;
  const cadPrev  = !cadNew  && curCad  > 0 && prevCad  != null && curCad  > prevCad;
  const hrPrev   = !hrNew   && curHR   > 0 && prevHR   != null && curHR   < prevHR;

  const mark    = (id, on) => { const el = $(id); if (el) el.classList.toggle("val-best",       on); };
  const markNew = (id, on) => { const el = $(id); if (el) el.classList.toggle("val-new-record", on); };

  mark("run-field-dur",  pacePrev);
  mark("run-field-dist", distPrev);
  mark("run-field-pace", pacePrev);
  mark("run-field-cad",  cadPrev);
  mark("run-field-hr",   hrPrev);

  markNew("run-field-dur",  paceNew);
  markNew("run-field-dist", distNew);
  markNew("run-field-pace", paceNew);
  markNew("run-field-cad",  cadNew);
  markNew("run-field-hr",   hrNew);

  // Resize inputs to content width when star is shown so ☆ sits tight next to the number
  const fitInput = (inputId, on) => {
    const el = $(inputId);
    if (!el) return;
    el.style.width = on ? Math.max(el.value.length, 2) + "ch" : "";
  };
  fitInput("run-distance", distNew);
  fitInput("run-cadence",  cadNew);
  fitInput("run-hr",       hrNew);
}

// --- Placeholder ghost values from prev run ---
function refreshRunContext() {
  const userId  = DATA.getCurrentUser();
  const runType = activeRunType();
  _runBests = getRunBests(userId, runType);
  _runPrev  = getPrevRunOfType(userId, runType);
  const p = _runPrev;

  // Set input placeholders to previous run values for this category
  if (p?.duration) {
    const parts = String(p.duration).split(":").map(Number);
    if (parts.length === 3) {
      const h = $("run-dur-h"); if (h) h.placeholder = String(parts[0]).padStart(2,"0");
      const m = $("run-dur-m"); if (m) m.placeholder = String(parts[1]).padStart(2,"0");
      const s = $("run-dur-s"); if (s) s.placeholder = String(parts[2]).padStart(2,"0");
    } else if (parts.length === 2) {
      const h = $("run-dur-h"); if (h) h.placeholder = "00";
      const m = $("run-dur-m"); if (m) m.placeholder = String(parts[0]).padStart(2,"0");
      const s = $("run-dur-s"); if (s) s.placeholder = String(parts[1]).padStart(2,"0");
    }
  } else {
    const h = $("run-dur-h"); if (h) h.placeholder = "00";
    const m = $("run-dur-m"); if (m) m.placeholder = "00";
    const s = $("run-dur-s"); if (s) s.placeholder = "00";
  }
  const distEl = $("run-distance"); if (distEl) distEl.placeholder = p?.distance  ? String(p.distance)  : "10.5";
  const cadEl  = $("run-cadence");  if (cadEl)  cadEl.placeholder  = p?.cadence   ? String(p.cadence)   : "170";
  const hrEl   = $("run-hr");       if (hrEl)   hrEl.placeholder   = p?.heartRate ? String(p.heartRate) : "152";

  // Best-record badges (gold star + value)
  const b = _runBests;
  const setBadge = (id, val) => { const el = $(id); if (el) el.textContent = val != null ? `☆ ${val}` : ""; };
  setBadge("run-best-dist", b.dist     != null ? `${b.dist} км` : null);
  setBadge("run-best-pace", b.paceSec  != null ? secToPaceStr(b.paceSec) : null);
  setBadge("run-best-cad",  b.cad      != null ? String(b.cad) : null);
  setBadge("run-best-hr",   b.hr       != null ? String(b.hr) : null);

  updatePace();
}

// --- Tab switching ---
document.querySelectorAll(".run-type-tab").forEach(btn => {
  btn.addEventListener("click", () => {
    if (btn.classList.contains("active")) return;
    saveCurrentTabData();                   // save current tab's fields
    document.querySelectorAll(".run-type-tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const newType = btn.dataset.type;
    if (_run) { _run.runType = newType; _run.name = RUN_TYPE_NAMES[newType] || "Пробежка"; }
    restoreTabData(newType);               // restore new tab's fields (empty if not visited)
    refreshRunContext();
  });
});

// --- Split time input: auto-advance & digit-only ---
(function setupTimeParts() {
  const ids = ["run-dur-h", "run-dur-m", "run-dur-s"];
  ids.forEach((id, i) => {
    const el = $(id);
    if (!el) return; // guard: old HTML cached by SW
    el.addEventListener("focus", () => el.select());
    el.addEventListener("input", () => {
      el.value = el.value.replace(/\D/g, "").slice(0, 2);
      if (el.value.length >= 2 && i < ids.length - 1) {
        const next = $(ids[i + 1]);
        if (next) { next.focus(); next.select(); }
      }
      updatePace();
    });
    el.addEventListener("keydown", e => {
      if (e.key === "Backspace" && el.value === "" && i > 0) {
        e.preventDefault();
        const prev = $(ids[i - 1]);
        if (prev) { prev.focus(); prev.setSelectionRange(prev.value.length, prev.value.length); }
      }
    });
  });
})();

$("run-distance").addEventListener("input", updatePace);
$("run-cadence").addEventListener("input", updateRunHighlights);
$("run-hr").addEventListener("input", updateRunHighlights);

function initRunScreen({ resume = false } = {}) {
  const userId = DATA.getCurrentUser();
  _run = DATA.getActiveWorkout(userId);

  if (!resume) {
    // Fresh start — clear all per-tab drafts
    _runTabData.easy = null; _runTabData.long = null; _runTabData.hard = null;
  }

  // Clear visible fields
  const clr = id => { const el = $(id); if (el) el.value = ""; };
  clr("run-dur-h"); clr("run-dur-m"); clr("run-dur-s");
  clr("run-distance"); clr("run-cadence"); clr("run-hr");
  const paceEl = $("run-pace"); if (paceEl) paceEl.textContent = "—";
  const paceField = $("run-field-pace"); if (paceField) paceField.classList.remove("pace-hint");

  // Set active tab from saved runType (default easy)
  const savedType = _run?.runType || "easy";
  document.querySelectorAll(".run-type-tab").forEach(b => b.classList.toggle("active", b.dataset.type === savedType));

  if (resume && _run) {
    if (_run.distance)  { const el = $("run-distance"); if (el) el.value = _run.distance; }
    if (_run.duration)  setRunDurFromStr(_run.duration);
    if (_run.cadence)   { const el = $("run-cadence");  if (el) el.value = _run.cadence; }
    if (_run.heartRate) { const el = $("run-hr");       if (el) el.value = _run.heartRate; }
    // Restore resumed tab data so switching away and back preserves values
    _runTabData[savedType] = {
      h: $("run-dur-h")?.value || "", m: $("run-dur-m")?.value || "", s: $("run-dur-s")?.value || "",
      distance: $("run-distance")?.value || "", cadence: $("run-cadence")?.value || "", hr: $("run-hr")?.value || "",
    };
  }

  refreshRunContext();
}

$("run-back-btn").addEventListener("click", () => {
  saveRunState();
  goToScreen("menu");
});

function saveRunState() {
  if (!_run) return;
  _run.runType   = activeRunType();
  _run.name      = RUN_TYPE_NAMES[_run.runType] || "Пробежка";
  _run.distance  = parseFloat($("run-distance").value) || null;
  _run.duration  = getRunDurStr() || null;
  _run.cadence   = parseInt($("run-cadence").value) || null;
  _run.heartRate = parseInt($("run-hr").value) || null;
  const _paceIsHint = $("run-field-pace")?.classList.contains("pace-hint");
  _run.pace      = (!_paceIsHint && $("run-pace").textContent !== "—") ? $("run-pace").textContent : null;
  carryRemoteBinId(_run, DATA.getCurrentUser());
  DATA.saveActiveWorkout(DATA.getCurrentUser(), _run);
  SyncQueue.push("run:update", { workoutId: _run.id });
}

function discardActiveRun() {
  const userId = DATA.getCurrentUser();
  const binId = _run?._remoteBinId;
  if (binId) Storage.deleteBin(binId).catch(e => console.warn("deleteBin failed", e));
  DATA.clearActiveWorkout(userId);
  SyncQueue.push("user:update", {});
  _run = null;
  showToast("Пробежка удалена");
  goToScreen("menu");
}

function openEmptyRunModal() {
  if (document.getElementById("empty-run-continue-btn")) return;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop open";
  backdrop.innerHTML = `
    <div class="modal modal-form">
      <h2 class="modal-title">Пустая пробежка</h2>
      <p style="font-size:14px;color:var(--text-secondary);margin:0;line-height:1.5;">
        Время и дистанция не заполнены — похоже на случайное нажатие. Можно вернуться и заполнить данные или удалить пробежку.
      </p>
      <div class="modal-form-actions">
        <button class="btn-chip" id="empty-run-continue-btn">Продолжить</button>
        <button class="btn-chip danger" id="empty-run-discard-btn">Удалить</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  document.getElementById("empty-run-continue-btn").addEventListener("click", () => backdrop.remove());
  document.getElementById("empty-run-discard-btn").addEventListener("click", () => { backdrop.remove(); discardActiveRun(); });
  backdrop.addEventListener("click", e => { if (e.target === backdrop) backdrop.remove(); });
}

$("run-save-btn").addEventListener("click", () => {
  const dist   = parseFloat($("run-distance").value);
  const durSec = getRunDurSec();
  if (!dist || !durSec) { openEmptyRunModal(); return; }

  saveRunState();
  const userId = DATA.getCurrentUser();
  _run.finishedAt  = Date.now();
  _run.durationSec = durSec;

  // Как и в силовой: не очищаем активную, пока запись в историю не подтверждена.
  if (!DATA.saveWorkout(userId, _run)) {
    showToast("Не удалось сохранить — освободи место (удали старые тренировки) и попробуй снова");
    return;
  }
  DATA.clearActiveWorkout(userId);
  SyncQueue.push("run:finish", { workoutId: _run.id });
  _run = null;
  showToast("Пробежка сохранена");
  goToScreen("menu");
});

/* ==========================================================================
   Screen 5: Exercises (раздел 4 спецификации)
   - видимый список = (общие − скрытые этим пользователем) + личные
   - CRUD доступен только для личных упражнений
   - общие можно только скрыть/показать у себя (не удалить — не трогает других)
   ========================================================================== */
const exercisesScroll = $("exercises-scroll");
const exercisesSearch = $("exercises-search");
const exerciseFormBackdrop = $("exercise-form-backdrop");
const exerciseFormTitle = $("exercise-form-title");
const exerciseFormName  = $("exercise-form-name");
const exerciseFormTypeGroup = $("exercise-form-type-group");
const exerciseFormCatGroup  = $("exercise-form-cat-group");

let _editingExerciseId = null; // null = создание нового; иначе id редактируемого личного упражнения
let _exercisesCatFilter = "all";
let _exercisesShowHidden = false;
let _exListEditMode = false;
let _exListDrag = null;

// Роли рабочих мышц — фиксированный порядок и подписи для деталей/формы.
const MUSCLE_ROLES = [
  { key: "agonists",     label: "Агонисты", primary: true },
  { key: "synergists",   label: "Синергисты" },
  { key: "stabilizers",  label: "Стабилизаторы" },
  { key: "distributors", label: "Распределители усилий" },
];

function initExercisesScreen() {
  exercisesSearch.value = "";
  _exercisesCatFilter = "all";
  _exercisesShowHidden = false;
  _exListEditMode = false;
  const doneBtn = $("exercises-done-btn"); if (doneBtn) doneBtn.classList.remove("visible");
  const addBtn  = $("exercises-add-btn");  if (addBtn)  addBtn.hidden  = false;
  const userId = DATA.getCurrentUser();
  if (DATA.ensureExercisesSeeded(userId)) SyncQueue.push("exercise:create", {});
  renderExercisesList("");
}

$("exercises-back-btn").addEventListener("click", () => { exitExListEditMode(); goToScreen("menu"); });
exercisesSearch.addEventListener("input", () => renderExercisesList(exercisesSearch.value));
$("ex-cat-manage-btn").addEventListener("click", () => openCategoryManager());

function renderCatTabs(userId, presentCats) {
  const tabsEl = $("ex-cat-tabs");
  const cats = Array.from(new Set([...DATA.getAllCategories(userId), ...presentCats]));
  const tabs = ["all", ...cats];
  tabsEl.innerHTML = tabs.map(c => {
    const active = _exercisesCatFilter === c ? " active" : "";
    if (c === "all") {
      // "Все" — обводка цветом accent (через CSS-переменную)
      return `<button class="ex-cat-tab${active}" data-cat="all" style="--tab-color:var(--accent)">Все</button>`;
    }
    const color = DATA.getCategoryColor(userId, c);
    return `<button class="ex-cat-tab${active}" data-cat="${escHtml(c)}" style="--tab-color:${escHtml(color)}">${escHtml(c)}</button>`;
  }).join("");
  tabsEl.querySelectorAll(".ex-cat-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      _exercisesCatFilter = btn.dataset.cat;
      renderExercisesList(exercisesSearch.value);
    });
  });
}

function renderExercisesList(query) {
  const userId  = DATA.getCurrentUser();
  const q       = query.trim().toLowerCase();
  const allExs  = DATA.getVisibleExercises(userId); // seeded + personal, единый список

  renderCatTabs(userId, Array.from(new Set(allExs.map(e => e.cat))));

  const filtered = allExs.filter(e =>
    (!q || e.name.toLowerCase().includes(q) || e.cat.toLowerCase().includes(q))
    && (_exercisesCatFilter === "all" || e.cat === _exercisesCatFilter)
  );

  if (!filtered.length) {
    exercisesScroll.innerHTML = `<p class="empty-state">Ничего не найдено</p>`;
    return;
  }

  // Группировка по категориям. Порядок категорий — как в списке пользователя,
  // плюс любые «осиротевшие» (встречаются в упражнениях, но нет в списке).
  const catOrder = DATA.getAllCategories(userId);
  const groups = new Map(); // cat -> [ex]
  filtered.forEach(ex => {
    if (!groups.has(ex.cat)) groups.set(ex.cat, []);
    groups.get(ex.cat).push(ex);
  });
  const orderedCats = [
    ...catOrder.filter(c => groups.has(c)),
    ...[...groups.keys()].filter(c => !catOrder.includes(c)),
  ];

  const SVG_CHEVRON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>`;
  const SVG_DEL_EX = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>`;

  const isFiltered = _exercisesCatFilter !== "all";
  const customOrder = DATA.getExerciseOrder(userId);

  // Пустые категории показываем только на вкладке "Все" и без поиска (для drag-to-category)
  const emptyCats = (!isFiltered && !q) ? catOrder.filter(c => !groups.has(c)) : [];
  const allOrderedCats = [...orderedCats, ...emptyCats];

  if (_exListEditMode) exercisesScroll.classList.add("ex-list-editing");
  else exercisesScroll.classList.remove("ex-list-editing");

  exercisesScroll.innerHTML = allOrderedCats.map(cat => {
    const color = DATA.getCategoryColor(userId, cat);
    const catExs = groups.get(cat) || [];
    const isEmpty = catExs.length === 0;
    const accentStyle = ` style="border-left-color:${escHtml(color)};"`;
    const sorted = [...catExs].sort((a, b) => {
      if (customOrder) {
        const ia = customOrder.indexOf(a.id), ib = customOrder.indexOf(b.id);
        if (ia !== -1 || ib !== -1) {
          if (ia === -1) return 1;
          if (ib === -1) return -1;
          return ia - ib;
        }
      }
      return a.name.localeCompare(b.name, "ru");
    });
    const rows = sorted.map(ex => `
      <div class="ex-row-wrap" data-id="${escHtml(ex.id)}" data-cat="${escHtml(cat)}">
        <div class="ex-row-delete">${SVG_DEL_EX} Удалить</div>
        <div class="ex-row tappable" data-id="${escHtml(ex.id)}"${accentStyle}>
          <span class="ex-row-body">
            <span class="ex-row-name">${escHtml(ex.name)}</span>
          </span>
          <span class="ex-row-chevron">${SVG_CHEVRON}</span>
        </div>
      </div>`).join("");
    const header = isFiltered ? "" : `
      <div class="ex-group${isEmpty ? " ex-group-empty" : ""}" data-cat="${escHtml(cat)}">
        <span class="ex-group-dot" style="background:${escHtml(color)}"></span>
        <span class="ex-group-name">${escHtml(cat)}</span>
        ${!isEmpty ? `<span class="ex-group-count">${catExs.length}</span>` : ""}
      </div>`;
    return header + rows;
  }).join("");

  exercisesScroll.querySelectorAll(".ex-row").forEach(row => {
    row.addEventListener("click", () => {
      if (_exListEditMode) {
        startExNameEdit(row.closest(".ex-row-wrap"), row.dataset.id, userId);
        return;
      }
      openExerciseDetail(row.dataset.id);
    });
  });

  exercisesScroll.querySelectorAll(".ex-row-wrap").forEach(wrap => {
    wireExRowSwipe(wrap, userId);
    wireExRowGesture(wrap, userId);
  });
}

function startExNameEdit(wrap, exId, userId) {
  if (!wrap) return;
  const nameEl = wrap.querySelector(".ex-row-name");
  if (!nameEl || wrap.dataset.editing) return;
  wrap.dataset.editing = "1";

  const current = nameEl.textContent;
  const inp = document.createElement("input");
  inp.type = "text";
  inp.value = current;
  inp.className = "ex-row-name-input";
  nameEl.replaceWith(inp);
  inp.focus();
  inp.select();

  const commit = () => {
    if (!wrap.dataset.editing) return;
    delete wrap.dataset.editing;
    const next = inp.value.trim();
    if (next && next !== current) {
      DATA.updateOwnExercise(userId, exId, { name: next });
      SyncQueue.push("exercise:update", { id: exId });
    }
    const span = document.createElement("span");
    span.className = "ex-row-name";
    span.textContent = next || current;
    inp.replaceWith(span);
  };

  inp.addEventListener("blur", commit);
  inp.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); inp.blur(); }
    if (e.key === "Escape") { inp.value = current; inp.blur(); }
  });
  // Не даём нажатию на input запустить drag-hold
  inp.addEventListener("pointerdown", e => e.stopPropagation());
}

function wireExRowSwipe(wrap, userId) {
  const row = wrap.querySelector(".ex-row");
  if (!row) return;
  const exId = row.dataset.id;
  let sx = 0, sy = 0, dx = 0, active = false, decided = false, horiz = false, didSwipe = false;
  const MAX = 110, DEL = 80;

  row.addEventListener("pointerdown", e => {
    if (_exListEditMode) return;
    if (e.target.closest("button")) return;
    sx = e.clientX; sy = e.clientY; dx = 0;
    active = true; decided = false; horiz = false; didSwipe = false;
    row.style.transition = "";
  });
  row.addEventListener("pointermove", e => {
    if (!active) return;
    const mx = e.clientX - sx, my = e.clientY - sy;
    if (!decided) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      decided = true;
      horiz = mx < 0 && Math.abs(mx) > Math.abs(my);
      if (!horiz) { active = false; return; }
      wrap.classList.add("swiping");
      try { row.setPointerCapture(e.pointerId); } catch {}
    }
    if (!horiz) return;
    dx = Math.max(-MAX, Math.min(0, mx));
    if (dx < -4) didSwipe = true;
    row.style.transform = `translateX(${dx}px)`;
    wrap.classList.toggle("will-delete", dx <= -DEL);
  });
  // Во время горизонтального свайпа гасим вертикальный скролл (п.2).
  row.addEventListener("touchmove", e => {
    if (!active) return;
    const t = e.touches[0]; if (!t) return;
    const mx = t.clientX - sx, my = t.clientY - sy;
    if (horiz || (Math.abs(mx) >= 8 && mx < 0 && Math.abs(mx) > Math.abs(my))) {
      if (e.cancelable) e.preventDefault();
    }
  }, { passive: false });
  const settle = () => {
    if (!active) return;
    active = false;
    if (!horiz) return;
    if (dx <= -DEL) {
      row.style.transition = "transform 0.16s ease";
      row.style.transform = "translateX(-110%)";
      wrap.style.height = wrap.offsetHeight + "px";
      requestAnimationFrame(() => {
        wrap.style.transition = "height 0.18s ease, opacity 0.18s ease";
        wrap.style.height = "0"; wrap.style.opacity = "0";
      });
      setTimeout(() => {
        const allExs = DATA.getVisibleExercises(userId);
        const ex = allExs.find(e => e.id === exId);
        const exName = ex ? ex.name : exId;
        const snapshot = [...DATA.getOwnExercises(userId)];
        DATA.deleteOwnExercise(userId, exId);
        SyncQueue.push("exercise:delete", { id: exId });
        renderExercisesList(exercisesSearch.value);
        showUndoToast(`Упражнение «${exName}» удалено`, () => {
          DATA.saveOwnExercises(userId, snapshot);
          SyncQueue.push("exercise:create", {});
          renderExercisesList(exercisesSearch.value);
          showToast("Восстановлено");
        });
      }, 200);
    } else {
      row.style.transition = "transform 0.18s ease";
      row.style.transform = "";
      wrap.classList.remove("will-delete");
      setTimeout(() => wrap.classList.remove("swiping"), 200);
    }
  };
  row.addEventListener("pointerup", settle);
  row.addEventListener("pointercancel", settle);
  row.addEventListener("click", e => {
    if (didSwipe) { e.stopPropagation(); e.preventDefault(); didSwipe = false; }
  }, true);
}

function enterExListEditMode() {
  if (_exListEditMode) return;
  _exListEditMode = true;
  haptic(22);
  exercisesScroll.classList.add("ex-list-editing");
  const doneBtn = $("exercises-done-btn");
  const addBtn  = $("exercises-add-btn");
  if (doneBtn) doneBtn.classList.add("visible");
  if (addBtn)  addBtn.hidden = true;
}

function exitExListEditMode() {
  if (!_exListEditMode) return;
  _exListEditMode = false;
  exercisesScroll.classList.remove("ex-list-editing");
  const doneBtn = $("exercises-done-btn");
  const addBtn  = $("exercises-add-btn");
  if (doneBtn) doneBtn.classList.remove("visible");
  if (addBtn)  addBtn.hidden = false;
  saveExOrder();
}

function saveExOrder() {
  const ids = [...exercisesScroll.querySelectorAll(".ex-row-wrap[data-id]")].map(w => w.dataset.id);
  if (ids.length) DATA.saveExerciseOrder(DATA.getCurrentUser(), ids);
}

function wireExRowGesture(wrap, userId) {
  let holdTimer = null, sx = 0, sy = 0, moved = false, dragStarted = false;
  const DELAY = () => _exListEditMode ? 150 : 430;
  const clearHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };

  const begin = (x, y, target) => {
    if (target && target.closest("button")) return;
    moved = false; dragStarted = false; sx = x; sy = y;
    clearHold();
    holdTimer = setTimeout(() => {
      holdTimer = null;
      if (moved) return;
      if (!_exListEditMode) { enterExListEditMode(); return; }
      dragStarted = true;
      startExDrag(wrap, y);
    }, DELAY());
  };
  const move = (x, y, e) => {
    if (_exListDrag && _exListDrag.wrap === wrap) {
      if (e && e.cancelable) e.preventDefault();
      moveExDrag(y); return;
    }
    if (holdTimer && (Math.abs(x - sx) > 8 || Math.abs(y - sy) > 8)) { moved = true; clearHold(); }
  };
  const finish = () => {
    clearHold();
    if (_exListDrag && _exListDrag.wrap === wrap) endExDrag();
  };

  wrap.addEventListener("touchstart", e => { const t = e.touches[0]; begin(t.clientX, t.clientY, e.target); }, { passive: true });
  wrap.addEventListener("touchmove",  e => { const t = e.touches[0]; if (t) move(t.clientX, t.clientY, e); }, { passive: false });
  wrap.addEventListener("touchend",   finish);
  wrap.addEventListener("mousedown",  e => begin(e.clientX, e.clientY, e.target));
  wrap.addEventListener("mousemove",  e => { if (_exListDrag) move(e.clientX, e.clientY, null); });
  wrap.addEventListener("mouseup",    finish);
  wrap.addEventListener("click", e => {
    if (dragStarted) { e.stopPropagation(); dragStarted = false; }
  }, true);
}

function startExDrag(wrap, pointerY) {
  if (_exListDrag) return;
  const top = wrap.getBoundingClientRect().top;
  _exListDrag = { wrap, grabDy: pointerY - top, ty: 0 };
  wrap.style.transition = "none";
  wrap.classList.add("ex-dragging");
  haptic(18);
}

function moveExDrag(pointerY) {
  const d = _exListDrag; if (!d) return;
  const h = d.wrap.getBoundingClientRect().height;
  const center = (pointerY - d.grabDy) + h / 2;

  // Ищем позицию вставки: первый элемент (не сам drag), чей центр выше нашего
  let insertBeforeEl = null;
  for (const child of exercisesScroll.children) {
    if (child === d.wrap) continue;
    const r = child.getBoundingClientRect();
    if (r.top + r.height / 2 > center) { insertBeforeEl = child; break; }
  }

  const curNext = d.wrap.nextElementSibling;
  if (insertBeforeEl !== curNext && insertBeforeEl !== d.wrap) {
    exercisesScroll.insertBefore(d.wrap, insertBeforeEl); // null → в конец
  }

  const rect = d.wrap.getBoundingClientRect();
  const naturalTop = rect.top - d.ty;
  d.ty = (pointerY - d.grabDy) - naturalTop;
  d.wrap.style.transform = `translateY(${d.ty}px)`;
}

function _exDragGetCat(wrap) {
  // Ищем ближайший предшествующий .ex-group, чтобы понять категорию
  let el = wrap.previousElementSibling;
  while (el) {
    if (el.classList.contains("ex-group")) return el.dataset.cat || null;
    el = el.previousElementSibling;
  }
  return null;
}

function endExDrag() {
  const d = _exListDrag; if (!d) return;
  _exListDrag = null;
  d.wrap.style.transition = "transform 0.18s ease";
  d.wrap.style.transform = "";
  d.wrap.classList.remove("ex-dragging");
  setTimeout(() => { d.wrap.style.transition = ""; }, 200);

  // Обновляем категорию упражнения если оно переместилось в другую группу
  const userId = DATA.getCurrentUser();
  const exId = d.wrap.dataset.id;
  const newCat = _exDragGetCat(d.wrap);
  if (newCat && newCat !== d.wrap.dataset.cat) {
    DATA.updateOwnExercise(userId, exId, { cat: newCat });
    SyncQueue.push("exercise:update", { id: exId, cat: newCat });
    // Обновляем цвет акцента сразу без полного ре-рендера
    const color = DATA.getCategoryColor(userId, newCat);
    const row = d.wrap.querySelector(".ex-row");
    if (row) row.style.borderLeftColor = color;
    d.wrap.dataset.cat = newCat;
  }

  saveExOrder();
}

$("exercises-done-btn").addEventListener("click", exitExListEditMode);

/* — Экран деталей упражнения: медиа, рабочие мышцы, техника, действия — */
let _detailExerciseId = null;

function isHttpUrl(url) {
  return /^https?:\/\//i.test((url || "").trim());
}
function isImageUrl(url) {
  return isHttpUrl(url) && /\.(png|jpe?g|gif|webp|avif|svg)(\?.*)?$/i.test(url.trim());
}
function splitMuscles(str) {
  return (str || "").split(",").map(s => s.trim()).filter(Boolean);
}

function openExerciseDetail(exerciseId) {
  const userId = DATA.getCurrentUser();
  const ex = DATA.getVisibleExercises(userId).find(e => e.id === exerciseId);
  if (!ex) return;
  _detailExerciseId = exerciseId;
  const otherUser = DATA.USERS.find(u => u.id !== userId);

  const color = DATA.getCategoryColor(userId, ex.cat);
  $("exd-title").textContent = ex.name;
  $("exd-meta").innerHTML =
    `<span class="exd-cat-dot" style="background:${escHtml(color)}"></span>${escHtml(ex.cat)}`;

  const media = (ex.media || "").trim();
  let mediaHtml = "";
  if (isImageUrl(media)) {
    mediaHtml = `<div class="exd-media"><img src="${escHtml(media)}" alt="${escHtml(ex.name)}" loading="lazy"></div>`;
  } else if (isHttpUrl(media)) {
    mediaHtml = `<a class="exd-video-btn" href="${escHtml(media)}" target="_blank" rel="noopener">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      Смотреть видео</a>`;
  }

  const muscles = ex.muscles || {};
  const rolesHtml = MUSCLE_ROLES
    .map(r => ({ ...r, items: splitMuscles(muscles[r.key]) }))
    .filter(r => r.items.length)
    .map(r => `
      <div class="exd-muscle-role">
        <div class="exd-muscle-role-name">${escHtml(r.label)}</div>
        <div class="exd-chips">${r.items.map(m => `<span class="exd-chip${r.primary ? " primary" : ""}">${escHtml(m)}</span>`).join("")}</div>
      </div>`).join("");
  const musclesSection = rolesHtml
    ? `<div class="exd-section-label">Рабочие мышцы</div>${rolesHtml}`
    : "";

  const steps = Array.isArray(ex.steps) ? ex.steps : [];
  const stepsSection = steps.length
    ? `<div class="exd-section-label">Техника</div>${steps.map((s, i) => `
        <div class="exd-step">
          <span class="exd-step-num">${i + 1}</span>
          <span class="exd-step-text">${escHtml(s)}</span>
        </div>`).join("")}`
    : "";

  const tip = (ex.tip || "").trim();
  const tipSection = tip
    ? `<div class="exd-tip"><span class="exd-tip-icon">💡</span><span><b>Совет.</b> ${escHtml(tip)}</span></div>`
    : "";

  const body = musclesSection + stepsSection + tipSection;
  $("exd-body").innerHTML = mediaHtml +
    (body || `<p class="exd-empty">Техника и мышцы пока не заполнены — нажми «Править», чтобы добавить.</p>`);

  // Кнопка «Поделиться» имеет смысл только если есть второй пользователь.
  const shareBtn = $("exd-share-btn");
  shareBtn.style.display = otherUser ? "" : "none";
  shareBtn.title = otherUser ? `Поделиться с ${otherUser.name}` : "Поделиться";

  $("exd-edit-btn").onclick = () => openExerciseForm(exerciseId);

  shareBtn.onclick = async () => {
    if (!otherUser) return;
    shareBtn.disabled = true;
    const result = await SyncQueue.shareExercise(exerciseId, userId, otherUser.id);
    shareBtn.disabled = false;
    if (result === "shared")    showToast(`Упражнение передано ${otherUser.name}`);
    if (result === "duplicate") showToast(`У ${otherUser.name} уже есть такое упражнение`);
    if (result === "not_found") showToast("Упражнение не найдено");
  };

  goToScreen("exerciseDetail");
}

$("exd-back-btn").addEventListener("click", () => goToScreen("exercises"));

/* — Управление категориями v2: свайп-удаление, долгое нажатие = редактирование/перестановка — */
function openCategoryManager() {
  const userId = DATA.getCurrentUser();
  const existing = $("cat-manager-backdrop");
  if (existing) existing.remove();

  let catEditMode = false;
  let catDrag = null;

  const backdrop = document.createElement("div");
  backdrop.id = "cat-manager-backdrop";
  backdrop.className = "bottom-sheet-backdrop";
  // iOS: click не стреляет по non-interactive div без cursor:pointer
  backdrop.style.cursor = "pointer";

  function close() {
    backdrop.classList.remove("open");
    setTimeout(() => backdrop.remove(), 300);
  }
  backdrop.addEventListener("click", e => { if (e.target === backdrop) close(); });
  backdrop.addEventListener("touchend", e => {
    const t = e.changedTouches[0];
    const el = t && document.elementFromPoint(t.clientX, t.clientY);
    if (el && !el.closest(".bottom-sheet")) close();
  });

  const SVG_DEL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>`;

  function getListEl() { return backdrop.querySelector(".cat-sheet-list"); }

  function enterEditMode() {
    if (catEditMode) return;
    catEditMode = true;
    haptic(22);
    const list = getListEl();
    if (list) list.classList.add("cat-editing");
    const doneBtn = backdrop.querySelector(".cat-done-btn");
    if (doneBtn) doneBtn.hidden = false;
  }

  function exitEditMode() {
    if (!catEditMode) return;
    catEditMode = false;
    const list = getListEl();
    if (list) list.classList.remove("cat-editing");
    const doneBtn = backdrop.querySelector(".cat-done-btn");
    if (doneBtn) doneBtn.hidden = true;
  }

  function saveCatOrder() {
    const list = getListEl();
    if (!list) return;
    const newOrder = [...list.querySelectorAll(".cat-item-wrap[data-cat]")].map(w => w.dataset.cat);
    DATA.saveAllCategories(userId, newOrder);
    renderExercisesList(exercisesSearch.value);
  }

  function removeCategory(cat) {
    const catSnapshot = [...DATA.getAllCategories(userId)];
    const exSnapshot  = [...DATA.getOwnExercises(userId)];
    DATA.deleteCategory(userId, cat);
    renderExercisesList(exercisesSearch.value);
    render();
    showUndoToast(`Категория «${cat}» удалена`, () => {
      DATA.saveAllCategories(userId, catSnapshot);
      DATA.saveOwnExercises(userId, exSnapshot);
      renderExercisesList(exercisesSearch.value);
      render();
      showToast("Восстановлено");
    });
  }

  function openAddCatModal() {
    const addBd = document.createElement("div");
    addBd.className = "modal-backdrop open";
    addBd.innerHTML = `
      <div class="modal modal-form">
        <h2 class="modal-title">Новая категория</h2>
        <div class="ex-form-field">
          <input class="ex-form-input" id="cat-new-name-inp" type="text" placeholder="Например, Растяжка">
        </div>
        <div class="modal-form-actions">
          <button class="btn-chip" data-act="cancel">Отмена</button>
          <button class="btn-chip primary" data-act="ok">Сохранить</button>
        </div>
      </div>`;
    document.body.appendChild(addBd);
    addBd.style.zIndex = "30";
    const inp = addBd.querySelector("input");
    const closeMod = () => addBd.remove();
    const save = () => {
      const v = inp.value.trim();
      if (!v) return;
      DATA.addCategory(userId, v);
      renderExercisesList(exercisesSearch.value);
      render();
      closeMod();
    };
    addBd.querySelector('[data-act="cancel"]').addEventListener("click", closeMod);
    addBd.querySelector('[data-act="ok"]').addEventListener("click", save);
    inp.addEventListener("keydown", e => { if (e.key === "Enter") save(); });
    addBd.addEventListener("click", e => { if (e.target === addBd) closeMod(); });
    setTimeout(() => inp.focus(), 50);
  }

  function startCatRename(wrap, cat, nameEl) {
    const inp = document.createElement("input");
    inp.type = "text";
    inp.value = cat;
    inp.className = "cat-item-name";
    nameEl.replaceWith(inp);
    inp.focus(); inp.select();
    const commit = () => {
      const next = inp.value.trim();
      if (next && next !== cat) {
        DATA.renameCategory(userId, cat, next);
        renderExercisesList(exercisesSearch.value);
        wrap.dataset.cat = next;
        const catItem = wrap.querySelector(".cat-item");
        if (catItem) catItem.dataset.cat = next;
      }
      const span = document.createElement("span");
      span.className = "cat-item-name-text";
      span.title = next || cat;
      span.textContent = next || cat;
      inp.replaceWith(span);
      wireNameClick(wrap, next || cat, span);
    };
    inp.addEventListener("blur", commit);
    inp.addEventListener("keydown", e => { if (e.key === "Enter") inp.blur(); });
  }

  function wireNameClick(wrap, cat, nameEl) {
    nameEl.addEventListener("click", e => {
      if (!catEditMode) return;
      e.stopPropagation();
      startCatRename(wrap, cat, nameEl);
    });
  }

  function wireCatSwipe(wrap, item, cat) {
    let sx = 0, sy = 0, dx = 0, active = false, decided = false, horiz = false, swiped = false;
    const MAX = 100, DEL = 72;
    item.addEventListener("pointerdown", e => {
      if (e.target.closest("input")) return;
      sx = e.clientX; sy = e.clientY; dx = 0;
      active = true; decided = false; horiz = false; swiped = false;
      item.style.transition = "";
    });
    item.addEventListener("pointermove", e => {
      if (!active) return;
      const mx = e.clientX - sx, my = e.clientY - sy;
      if (!decided) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        decided = true;
        horiz = mx < 0 && Math.abs(mx) > Math.abs(my);
        if (!horiz) { active = false; return; }
        wrap.classList.add("swiping");
        try { item.setPointerCapture(e.pointerId); } catch {}
      }
      if (!horiz) return;
      dx = Math.max(-MAX, Math.min(0, mx));
      if (dx < -4) swiped = true;
      item.style.transform = `translateX(${dx}px)`;
      wrap.classList.toggle("will-delete", dx <= -DEL);
    });
    // Во время горизонтального свайпа гасим вертикальный скролл (п.2).
    item.addEventListener("touchmove", e => {
      if (!active) return;
      const t = e.touches[0]; if (!t) return;
      const mx = t.clientX - sx, my = t.clientY - sy;
      if (horiz || (Math.abs(mx) >= 8 && mx < 0 && Math.abs(mx) > Math.abs(my))) {
        if (e.cancelable) e.preventDefault();
      }
    }, { passive: false });
    const settle = () => {
      if (!active) return;
      active = false;
      if (!horiz) return;
      if (dx <= -DEL) {
        item.style.transition = "transform 0.16s ease";
        item.style.transform = "translateX(-110%)";
        wrap.style.height = wrap.offsetHeight + "px";
        requestAnimationFrame(() => {
          wrap.style.transition = "height 0.16s ease, opacity 0.16s ease";
          wrap.style.height = "0"; wrap.style.opacity = "0";
        });
        setTimeout(() => removeCategory(cat), 180);
      } else {
        item.style.transition = "transform 0.18s ease";
        item.style.transform = "";
        wrap.classList.remove("will-delete");
        setTimeout(() => wrap.classList.remove("swiping"), 200);
      }
    };
    item.addEventListener("pointerup", settle);
    item.addEventListener("pointercancel", settle);
    item.addEventListener("click", e => {
      if (swiped) { e.stopPropagation(); e.preventDefault(); swiped = false; }
    }, true);
  }

  function wireCatGesture(wrap, cat) {
    let holdTimer = null, sx = 0, sy = 0, moved = false, dragStarted = false;
    const DELAY = () => catEditMode ? 150 : 430;
    const clearHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };

    const begin = (x, y, target) => {
      if (target && target.closest("input")) return;
      moved = false; dragStarted = false; sx = x; sy = y;
      clearHold();
      holdTimer = setTimeout(() => {
        holdTimer = null;
        if (moved) return;
        if (!catEditMode) { enterEditMode(); return; }
        dragStarted = true;
        startCatDrag(wrap, cat, y);
      }, DELAY());
    };
    const move = (x, y, e) => {
      if (catDrag && catDrag.wrap === wrap) {
        if (e && e.cancelable) e.preventDefault();
        moveCatDrag(y); return;
      }
      if (holdTimer && (Math.abs(x - sx) > 8 || Math.abs(y - sy) > 8)) { moved = true; clearHold(); }
    };
    const finish = () => {
      clearHold();
      if (catDrag && catDrag.wrap === wrap) endCatDrag();
    };

    wrap.addEventListener("touchstart", e => { const t = e.touches[0]; begin(t.clientX, t.clientY, e.target); }, { passive: true });
    wrap.addEventListener("touchmove", e => { const t = e.touches[0]; if (t) move(t.clientX, t.clientY, e); }, { passive: false });
    wrap.addEventListener("touchend", finish);
    wrap.addEventListener("mousedown", e => begin(e.clientX, e.clientY, e.target));
    wrap.addEventListener("mousemove", e => { if (catDrag) move(e.clientX, e.clientY, null); });
    wrap.addEventListener("mouseup", finish);
    // Suppress click if drag happened
    wrap.addEventListener("click", e => {
      if (dragStarted) { e.stopPropagation(); dragStarted = false; }
    }, true);
  }

  function startCatDrag(wrap, cat, pointerY) {
    if (catDrag) return;
    const top = wrap.getBoundingClientRect().top;
    catDrag = { wrap, cat, grabDy: pointerY - top, ty: 0, pointerY };
    wrap.style.transition = "none";
    wrap.classList.add("dragging");
    haptic(18);
  }

  function moveCatDrag(pointerY) {
    const d = catDrag; if (!d) return;
    d.pointerY = pointerY;
    const list = getListEl(); if (!list) return;
    const h = d.wrap.getBoundingClientRect().height;
    const center = (pointerY - d.grabDy) + h / 2;
    const prev = d.wrap.previousElementSibling;
    if (prev && prev.classList.contains("cat-item-wrap")) {
      const r = prev.getBoundingClientRect();
      if (center < r.top + r.height / 2) { list.insertBefore(d.wrap, prev); }
    }
    const next = d.wrap.nextElementSibling;
    if (next && next.classList.contains("cat-item-wrap")) {
      const r = next.getBoundingClientRect();
      if (center > r.top + r.height / 2) { list.insertBefore(next, d.wrap); }
    }
    const rect = d.wrap.getBoundingClientRect();
    const naturalTop = rect.top - d.ty;
    d.ty = (pointerY - d.grabDy) - naturalTop;
    d.wrap.style.transform = `translateY(${d.ty}px)`;
  }

  function endCatDrag() {
    const d = catDrag; if (!d) return;
    catDrag = null;
    d.wrap.style.transition = "transform 0.18s ease";
    d.wrap.style.transform = "";
    d.wrap.classList.remove("dragging");
    setTimeout(() => { d.wrap.style.transition = ""; }, 200);
    saveCatOrder();
  }

  function render() {
    const cats = DATA.getAllCategories(userId);
    const counts = {};
    DATA.getVisibleExercises(userId).forEach(e => { counts[e.cat] = (counts[e.cat] || 0) + 1; });
    const editingClass = catEditMode ? " cat-editing" : "";

    backdrop.innerHTML = `
      <div class="bottom-sheet cat-sheet">
        <div class="bottom-sheet-handle"></div>
        <div class="cat-sheet-head">
          <span class="cat-sheet-title">Категории</span>
          <span class="cat-sheet-count">${cats.length} шт</span>
        </div>
        <div class="cat-sheet-list${editingClass}">
          ${cats.length ? cats.map(c => {
            const color = DATA.getCategoryColor(userId, c);
            return `
              <div class="cat-item-wrap" data-cat="${escHtml(c)}">
                <div class="cat-item-delete">${SVG_DEL} Удалить</div>
                <div class="cat-item" data-cat="${escHtml(c)}" style="--cat-color:${escHtml(color)}">
                  <span class="cat-item-name-text" title="${escHtml(c)}">${escHtml(c)}</span>
                  <span class="cat-item-count">${counts[c] || 0}</span>
                </div>
              </div>`;
          }).join("") : `<p class="exd-empty">Категорий пока нет.</p>`}
        </div>
        <button class="cat-done-btn"${catEditMode ? "" : " hidden"}>Готово</button>
        <button class="cat-item-add">+ Добавить новую категорию</button>
      </div>
    `;

    backdrop.querySelectorAll(".cat-item-wrap[data-cat]").forEach(wrap => {
      const cat = wrap.dataset.cat;
      const item = wrap.querySelector(".cat-item");
      const nameEl = wrap.querySelector(".cat-item-name-text");
      wireCatSwipe(wrap, item, cat);
      wireCatGesture(wrap, cat);
      wireNameClick(wrap, cat, nameEl);
    });

    const doneBtn = backdrop.querySelector(".cat-done-btn");
    if (doneBtn) doneBtn.addEventListener("click", () => { exitEditMode(); });

    const addBtn = backdrop.querySelector(".cat-item-add");
    if (addBtn) addBtn.addEventListener("click", openAddCatModal);

    const handle = backdrop.querySelector(".bottom-sheet-handle");
    if (handle) handle.addEventListener("click", close);
  }

  document.body.appendChild(backdrop);
  render();
  requestAnimationFrame(() => {
    backdrop.classList.add("open");
    // Свайп вниз по шторке → закрыть (аналог главной шторки истории)
    const sheetEl = backdrop.querySelector(".bottom-sheet");
    if (!sheetEl) return;
    let sy = 0, sdy = 0, sdragging = false;
    sheetEl.addEventListener("touchstart", e => {
      sy = e.touches[0].clientY; sdy = 0; sdragging = true;
      sheetEl.style.transition = "none";
    }, { passive: true });
    sheetEl.addEventListener("touchmove", e => {
      if (!sdragging) return;
      const list = sheetEl.querySelector(".cat-sheet-list");
      const dy = e.touches[0].clientY - sy;
      if (dy > 0 && (!list || list.scrollTop <= 0)) {
        sdy = dy;
        sheetEl.style.transform = `translateY(${dy}px)`;
      } else { sdy = 0; sheetEl.style.transform = ""; }
    }, { passive: true });
    const onSheetEnd = () => {
      if (!sdragging) return; sdragging = false;
      if (sdy > 80) {
        sheetEl.style.transition = "transform 0.22s ease";
        sheetEl.style.transform = `translateY(${sheetEl.offsetHeight}px)`;
        close();
      } else { sheetEl.style.transition = ""; sheetEl.style.transform = ""; }
    };
    sheetEl.addEventListener("touchend",   onSheetEnd);
    sheetEl.addEventListener("touchcancel", onSheetEnd);
  });
}

/* — Форма добавления / редактирования личного упражнения — */
$("exercises-add-btn").addEventListener("click", () => openExerciseForm(null));
$("exercise-form-cancel").addEventListener("click", () => closeModal(exerciseFormBackdrop));

function buildCategoryChips(selected) {
  const userId = DATA.getCurrentUser();
  exerciseFormCatGroup.innerHTML = DATA.getAllCategories(userId).map(cat => `
    <button class="ex-form-chip ${cat === selected ? "selected" : ""}" data-cat="${escHtml(cat)}">${escHtml(cat)}</button>
  `).join("");
  exerciseFormCatGroup.querySelectorAll(".ex-form-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      exerciseFormCatGroup.querySelectorAll(".ex-form-chip").forEach(c => c.classList.remove("selected"));
      chip.classList.add("selected");
    });
  });
}

const SVG_X_SMALL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

function renderFormSteps(steps) {
  const cont = $("exercise-form-steps");
  cont.innerHTML = (steps.length ? steps : [""]).map((s, i) => `
    <div class="ex-step-edit-row">
      <textarea class="ex-form-input" rows="2" placeholder="Шаг ${i + 1}">${escHtml(s)}</textarea>
      <button class="ex-step-del" type="button" title="Удалить шаг">${SVG_X_SMALL}</button>
    </div>`).join("");
  cont.querySelectorAll(".ex-step-del").forEach(btn => {
    btn.addEventListener("click", () => {
      const rows = cont.querySelectorAll(".ex-step-edit-row");
      if (rows.length <= 1) { btn.closest(".ex-step-edit-row").querySelector("textarea").value = ""; }
      else btn.closest(".ex-step-edit-row").remove();
    });
  });
}
function collectFormSteps() {
  return [...$("exercise-form-steps").querySelectorAll("textarea")].map(t => t.value.trim()).filter(Boolean);
}

$("exercise-form-add-step").addEventListener("click", () => {
  renderFormSteps([...collectFormSteps(), ""]);
  const tas = $("exercise-form-steps").querySelectorAll("textarea");
  tas[tas.length - 1]?.focus();
});

function openExerciseForm(exerciseId) {
  _editingExerciseId = exerciseId;
  const userId = DATA.getCurrentUser();

  if (exerciseId) {
    const ex = DATA.getVisibleExercises(userId).find(e => e.id === exerciseId);
    if (!ex) return;
    exerciseFormTitle.textContent = "Редактировать упражнение";
    exerciseFormName.value = ex.name;
    exerciseFormTypeGroup.querySelectorAll(".ex-form-chip").forEach(c => c.classList.toggle("selected", c.dataset.type === ex.type));
    buildCategoryChips(ex.cat);
    $("exercise-form-media").value = ex.media || "";
    const mus = ex.muscles || {};
    $("exercise-form-m-agonists").value     = mus.agonists || "";
    $("exercise-form-m-synergists").value   = mus.synergists || "";
    $("exercise-form-m-stabilizers").value  = mus.stabilizers || "";
    $("exercise-form-m-distributors").value = mus.distributors || "";
    $("exercise-form-tip").value = ex.tip || "";
    renderFormSteps(Array.isArray(ex.steps) ? ex.steps : []);
  } else {
    exerciseFormTitle.textContent = "Новое упражнение";
    exerciseFormName.value = "";
    exerciseFormTypeGroup.querySelectorAll(".ex-form-chip").forEach(c => c.classList.toggle("selected", c.dataset.type === "strength"));
    buildCategoryChips("Ноги");
    $("exercise-form-media").value = "";
    ["agonists", "synergists", "stabilizers", "distributors"].forEach(k => { $(`exercise-form-m-${k}`).value = ""; });
    $("exercise-form-tip").value = "";
    renderFormSteps([]);
  }

  exerciseFormBackdrop.querySelector(".modal").scrollTop = 0;
  openModal(exerciseFormBackdrop);
  setTimeout(() => exerciseFormName.focus(), 280);
}

exerciseFormTypeGroup.querySelectorAll(".ex-form-chip").forEach(chip => {
  chip.addEventListener("click", () => {
    exerciseFormTypeGroup.querySelectorAll(".ex-form-chip").forEach(c => c.classList.remove("selected"));
    chip.classList.add("selected");
  });
});

$("exercise-form-save").addEventListener("click", () => {
  const userId = DATA.getCurrentUser();
  const name = exerciseFormName.value.trim();
  if (!name) { showToast("Введи название упражнения"); return; }

  const type = exerciseFormTypeGroup.querySelector(".ex-form-chip.selected")?.dataset.type || "strength";
  const cat  = exerciseFormCatGroup.querySelector(".ex-form-chip.selected")?.dataset.cat || "Другое";
  const media = $("exercise-form-media").value;
  const muscles = {
    agonists:     $("exercise-form-m-agonists").value,
    synergists:   $("exercise-form-m-synergists").value,
    stabilizers:  $("exercise-form-m-stabilizers").value,
    distributors: $("exercise-form-m-distributors").value,
  };
  const steps = collectFormSteps();
  const tip = $("exercise-form-tip").value;

  let savedId = _editingExerciseId;
  if (_editingExerciseId) {
    DATA.updateOwnExercise(userId, _editingExerciseId, { name, type, cat, media, muscles, steps, tip });
    SyncQueue.push("exercise:update", { id: _editingExerciseId });
    showToast("Упражнение обновлено");
  } else {
    const ex = DATA.addExercise(userId, { name, type, cat, media, muscles, steps, tip });
    savedId = ex.id;
    SyncQueue.push("exercise:create", { name });
    showToast("Упражнение добавлено");
  }

  closeModal(exerciseFormBackdrop);
  renderExercisesList(exercisesSearch.value);
  // Если форму открыли с экрана деталей — возвращаемся туда с обновлёнными данными.
  if (savedId && SCREENS.exerciseDetail.classList.contains("active")) {
    openExerciseDetail(savedId);
  }
});

/* ==========================================================================
   Screen: detail view (просмотр тренировки из истории)
   ========================================================================== */
let _detailReturnScreen = "menu";
function openDetailScreen(workout, returnScreen = "menu") {
  _detailReturnScreen = returnScreen;
  const isRun = workout.type === "run";

  // Цвет шапки совпадает с цветом карточки в истории (фиолетовый / зелёный).
  const headerEl = $("detail-screen-icon").closest(".detail-screen-header");
  headerEl.className = "detail-screen-header detail-header--" + (isRun ? "run" : "strength");

  // Иконка гантели убрана — в шапке остаются только кнопки и текст.
  $("detail-screen-icon").style.display = "none";

  $("detail-screen-title").textContent = workout.name || (isRun ? "Пробежка" : "Силовая");
  const filledByTrainer = workout.createdBy && workout.createdBy !== DATA.getCurrentUser() && !workout._migrated;
  $("detail-screen-meta").textContent = fmtDate(workout.startedAt) + (filledByTrainer ? " · внесено тренером" : "");

  const body = $("detail-screen-body");

  if (isRun) {
    const stats = [
      workout.distance  ? { num: `${workout.distance} км`,  label: "Дистанция" } : null,
      workout.pace      ? { num: `${workout.pace} мин/км`,  label: "Темп"       } : null,
      workout.heartRate ? { num: `${workout.heartRate}`,     label: "Пульс ср."  } : null,
      workout.cadence   ? { num: `${workout.cadence}`,       label: "Каденс"     } : null,
    ].filter(Boolean);

    body.innerHTML = `
      <div class="detail-stats">${stats.map(s => `
        <div class="detail-stat">
          <div class="detail-stat-num">${s.num}</div>
          <div class="detail-stat-label">${s.label}</div>
        </div>`).join("")}
      </div>
    `;
  } else {
    const userId    = DATA.getCurrentUser();
    const exercises = DATA.getVisibleExercises(userId);
    const records   = DATA.getRecords(userId);
    const allEx     = workout.exercises || [];
    const totalSets = allEx.reduce((n, ex) => n + ex.sets.filter(s => s.done).length, 0);
    const totalVol  = allEx.reduce((v, ex) => v + ex.sets.reduce((a, s) => a + (s.done ? (s.weight || 0) * (s.reps || 0) : 0), 0), 0);

    // Длительность в компактном виде: до часа «52 мин», от часа «1:04 ч».
    const statTimeHTML = (sec) => {
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
      return h > 0
        ? `<span class="wd-stat-num">${h}:${String(m).padStart(2, "0")}</span> <span class="wd-stat-unit">ч</span>`
        : `<span class="wd-stat-num">${m}</span> <span class="wd-stat-unit">мин</span>`;
    };
    const dash = `<span class="wd-stat-num">—</span>`;
    // RPE-светофор: 0–6 — есть запас (зелёный), 7–8 — тяжело (оранжевый),
    // 9–10 — почти до отказа (красный). Оранжевый, а не янтарь, чтобы не
    // сливаться с золотом рекорда.
    const rpeClass = (v) => v >= 9 ? "hi" : v >= 7 ? "mid" : "lo";
    // Подход считается рекордным, если его вес×повторы совпадают с текущим
    // личным максимумом по весу для этого упражнения.
    const isPrSet = (rec, s) => !!rec && s.weight > 0 && s.weight === rec.maxWeight && s.reps === rec.repsAtMaxWeight;

    body.innerHTML = `
      <div class="wd-statgrid">
        <div class="wd-stat"><div class="wd-stat-val"><span class="wd-stat-num">${allEx.length}</span></div><div class="wd-stat-label">Упражнения</div></div>
        <div class="wd-stat"><div class="wd-stat-val"><span class="wd-stat-num">${totalSets}</span></div><div class="wd-stat-label">Подходы</div></div>
        <div class="wd-stat"><div class="wd-stat-val">${totalVol ? `<span class="wd-stat-num">${totalVol.toLocaleString("ru-RU")}</span> <span class="wd-stat-unit">кг</span>` : dash}</div><div class="wd-stat-label">Тоннаж</div></div>
        <div class="wd-stat"><div class="wd-stat-val">${workout.durationSec ? statTimeHTML(workout.durationSec) : dash}</div><div class="wd-stat-label">Время</div></div>
      </div>
      ${allEx.map(ex => {
        const exDef    = exercises.find(e => e.id === ex.exerciseId) || { name: ex.name || "Упражнение недоступно" };
        const doneSets = ex.sets.filter(s => s.done);
        const rec      = records[ex.exerciseId];
        const exVol    = doneSets.reduce((v, s) => v + (s.weight || 0) * (s.reps || 0), 0);
        const hasPr    = doneSets.some(s => isPrSet(rec, s));
        // Тоннаж-рекорд: максимальный объём за одну тренировку для упражнения.
        const volPr    = !!rec && exVol > 0 && exVol >= (rec.maxVolume || 0);
        const anyRpe   = doneSets.some(s => s.rpe);
        // Рекорд подсвечиваем только у ПЕРВОГО подхода с рекордным весом:
        // если следующие подходы повторяют тот же вес — это уже не рекорд.
        let prShown    = false;
        return `<div class="wd-ex">
          <div class="wd-ex-head">
            <span class="wd-ex-name">${escHtml(exDef.name)}</span>
            ${doneSets.length ? `<span class="wd-ex-meta${volPr ? " pr" : ""}">${exVol.toLocaleString("ru-RU")} кг</span>` : ""}
            ${hasPr ? `<span class="wd-ex-star" title="Личный рекорд">★</span>` : ""}
          </div>
          ${doneSets.length ? `
            <div class="wd-cols">
              <span class="wd-col-idx">#</span>
              <span class="wd-col">кг</span>
              <span class="wd-col">повт</span>
              ${anyRpe ? `<span class="wd-col wd-col-rpe">rpe</span>` : ""}
            </div>
            <div class="wd-sets">
              ${doneSets.map((s, i) => {
                const pr = !prShown && isPrSet(rec, s);
                if (pr) prShown = true;
                return `<div class="wd-set">
                  <span class="wd-set-num">${i + 1}</span>
                  <div class="wd-cell${pr ? " pr" : ""}">${pr ? "★ " : ""}${s.weight || "—"}</div>
                  <div class="wd-cell">${s.reps}</div>
                  ${anyRpe ? `<div class="wd-cell wd-rpe ${s.rpe ? rpeClass(s.rpe) : "none"}">${s.rpe || "—"}</div>` : ""}
                </div>`;
              }).join("")}
            </div>` : `<div class="wd-empty">Нет выполненных подходов</div>`}
        </div>`;
      }).join("")}
      <button class="wd-add-btn" id="save-as-template-btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Добавить в шаблоны
      </button>
    `;

    $("save-as-template-btn").addEventListener("click", () => openSaveAsTemplateModal(workout));
  }

  goToScreen("detail");

  // Удаление доступно из списка истории (свайп/долгое нажатие) — на экране
  // деталей оставляем только редактирование, чтобы не удалить случайно.
  // Повторный тап по карандашу в режиме редактирования = отмена без сохранения.
  $("detail-edit-btn").onclick = () => {
    const editBtn = $("detail-edit-btn");
    if (editBtn.dataset.editing === "1") {
      delete editBtn.dataset.editing;
      openDetailScreen(workout, _detailReturnScreen);
    } else {
      editBtn.dataset.editing = "1";
      openDetailEditMode(workout);
    }
  };
}

function openDetailEditMode(workout) {
  const userId = DATA.getCurrentUser();
  const isRun  = workout.type === "run";
  const exDefs = DATA.getVisibleExercises(userId);
  const draft  = JSON.parse(JSON.stringify(workout));

  function renderEdit() {
    const body = $("detail-screen-body");
    if (isRun) {
      body.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:12px;padding-bottom:24px">
          <label style="font-size:12px;font-weight:700;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:.08em">Название</label>
          <input class="ex-form-input" id="de-name" value="${escHtml(draft.name || "")}" placeholder="Название">
          <label style="font-size:12px;font-weight:700;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:.08em">Дистанция (км)</label>
          <input class="ex-form-input" id="de-dist" type="number" step="0.01" value="${draft.distance || ""}">
          <label style="font-size:12px;font-weight:700;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:.08em">Темп (мин/км)</label>
          <input class="ex-form-input" id="de-pace" value="${escHtml(draft.pace || "")}">
          <label style="font-size:12px;font-weight:700;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:.08em">Пульс ср.</label>
          <input class="ex-form-input" id="de-hr" type="number" value="${draft.heartRate || ""}">
          <label style="font-size:12px;font-weight:700;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:.08em">Каденс</label>
          <input class="ex-form-input" id="de-cad" type="number" value="${draft.cadence || ""}">
          <div style="display:flex;gap:8px;margin-top:4px">
            <button class="btn-chip" id="de-cancel" style="flex:1">Отмена</button>
            <button class="btn-chip primary" id="de-save" style="flex:1">Сохранить</button>
          </div>
        </div>`;
      $("de-save").addEventListener("click", () => {
        draft.name      = $("de-name").value.trim() || draft.name;
        draft.distance  = parseFloat($("de-dist").value) || null;
        draft.pace      = $("de-pace").value.trim() || null;
        draft.heartRate = parseInt($("de-hr").value) || null;
        draft.cadence   = parseInt($("de-cad").value) || null;
        saveEditedWorkout(draft, userId);
      });
      $("de-cancel").addEventListener("click", () => openDetailScreen(workout, _detailReturnScreen));
    } else {
      // Форма редактирования повторяет экран просмотра (крупные ячейки # кг повт
      // rpe), но без подсветки рекордов/RPE и без верхней сводки — так удобнее
      // править значения.
      const exRows = (draft.exercises || []).map((ex, exIdx) => {
        const known = exDefs.find(e => e.id === ex.exerciseId);
        const def = known || { name: ex.name || "Упражнение недоступно" };
        const doneSets = ex.sets.map((s, si) => ({ ...s, _si: si })).filter(s => s.done);
        return `<div class="wd-ex">
          <div class="wd-ex-head">
            <button class="de-ex-name${known ? "" : " missing"}" data-ex="${exIdx}">
              <span>${escHtml(def.name)}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
            </button>
          </div>
          ${doneSets.length ? `
            <div class="wd-cols">
              <span class="wd-col-idx">#</span>
              <span class="wd-col">кг</span>
              <span class="wd-col">повт</span>
              <span class="wd-col wd-col-rpe">rpe</span>
              <span class="wd-col-del"></span>
            </div>
            <div class="wd-sets">
              ${doneSets.map((s, i) => `
                <div class="wd-set de-set-row" data-ex="${exIdx}" data-si="${s._si}">
                  <span class="wd-set-num">${i + 1}</span>
                  <input class="wd-cell-input de-weight" type="number" inputmode="decimal" step="0.5" value="${s.weight || 0}">
                  <input class="wd-cell-input de-reps" type="number" inputmode="numeric" value="${s.reps || 0}">
                  <input class="wd-cell-input wd-rpe de-rpe" type="number" inputmode="numeric" min="0" max="10" value="${s.rpe || ""}" placeholder="—">
                  <button class="wd-del-set de-del-set" data-ex="${exIdx}" data-si="${s._si}" title="Удалить подход">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>`).join("")}
            </div>` : `<div class="wd-empty">Нет выполненных подходов</div>`}
        </div>`;
      }).join("");

      body.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:4px;padding-bottom:80px">
          <div style="margin-bottom:8px">
            <input class="ex-form-input" id="de-name" value="${escHtml(draft.name || "")}" placeholder="Название тренировки">
          </div>
          ${exRows}
          <div style="display:flex;gap:8px;margin-top:8px">
            <button class="btn-chip" id="de-cancel" style="flex:1;justify-content:center">Отмена</button>
            <button class="btn-chip primary" id="de-save" style="flex:1;justify-content:center">Сохранить</button>
          </div>
        </div>`;

      // Переносим текущие значения полей в draft, чтобы при перерисовке
      // (удаление подхода, смена упражнения) не потерять только что введённое.
      const syncDraft = () => {
        draft.name = $("de-name").value.trim() || draft.name;
        body.querySelectorAll(".de-set-row").forEach(row => {
          const exIdx = +row.dataset.ex, si = +row.dataset.si;
          draft.exercises[exIdx].sets[si].weight = parseFloat(row.querySelector(".de-weight").value) || 0;
          draft.exercises[exIdx].sets[si].reps   = parseInt(row.querySelector(".de-reps").value)   || 0;
          const rpeV = parseFloat(row.querySelector(".de-rpe").value);
          draft.exercises[exIdx].sets[si].rpe = (!isNaN(rpeV) && rpeV > 0) ? rpeV : null;
        });
      };

      body.querySelectorAll(".de-del-set").forEach(btn => {
        btn.addEventListener("click", () => {
          syncDraft();
          draft.exercises[+btn.dataset.ex].sets[+btn.dataset.si].done = false;
          renderEdit();
        });
      });

      // Тап по названию упражнения — открыть пикер и переназначить упражнение
      // (в т.ч. восстановить «Упражнение недоступно» на заново созданное).
      body.querySelectorAll(".de-ex-name").forEach(btn => {
        btn.addEventListener("click", () => {
          const exIdx = +btn.dataset.ex;
          syncDraft();
          openExercisePicker(newId => {
            draft.exercises[exIdx].exerciseId = newId;
            delete draft.exercises[exIdx].name; // стираем устаревший снимок имени
            renderEdit(); // пикер закрывается сам после выбора
          }, draft.exercises[exIdx].exerciseId);
        });
      });

      $("de-save").addEventListener("click", () => {
        syncDraft();
        saveEditedWorkout(draft, userId);
      });
      $("de-cancel").addEventListener("click", () => openDetailScreen(workout, _detailReturnScreen));
    }
  }

  renderEdit();
}

function saveEditedWorkout(workout, userId) {
  DATA.updateWorkout(userId, workout); // сначала записываем правку в историю
  // Если история полная — пересчитываем рекорды (правка веса вниз тоже должна
  // опускать рекорд). Иначе только повышаем (updateRecords), чтобы не занизить.
  if (Sync.missingWorkoutCount(userId) === 0) DATA.recomputeRecords(userId);
  else DATA.updateRecords(userId, workout);
  SyncQueue.push("workout:edit", { workoutId: workout.id });
  SyncQueue.push("user:update", {}); // рекорды могли измениться
  renderHistory(userId);
  openDetailScreen(workout, _detailReturnScreen);
  showToast("Тренировка сохранена");
}

$("detail-back-btn").addEventListener("click", () => goToScreen(_detailReturnScreen));

/* ==========================================================================
   Screen 6: Stats (раздел 9.2 спецификации)
   - вкладка «Силовые»: список упражнений с двумя рекордами, тап → график
     рабочего веса по тренировкам
   - вкладка «Бег»: сводка (пробежки/дистанция/рекорды) + графики прогресса
     по дистанции и темпу
   Тоннаж и расчётный 1ПМ сознательно не считаются (раздел 9.2 спеки).
   ========================================================================== */

let _statsTab = "strength"; // сохраняется между заходами на экран в рамках сессии

/* ── СТАТИСТИКА (новая версия по ТЗ) ── */

// Переменные состояния статистики
let _statsPeriod = "month";         // "week"|"month"|"3month"|"year"|"all"
let _statsTypeFilter = "all";       // "all"|"strength"|"run" — какой из трёх экранов
let _statsSelectedExId = null;      // ID выбранного упражнения
let _statsGraphMode = "weight";    // "weight" | "volume"

// Период для дропдауна статистики (ключи совпадают с statsPeriodStart).
const STATS_PERIODS = [
  ["all",    "Всё время"],
  ["week",   "Неделя"],
  ["month",  "Месяц"],
  ["3month", "3 месяца"],
  ["year",   "Год"],
];

// DAY_MS, statsStartOfDay, computeStreak — в lib.js (чистая логика, тестируется).

function statsPeriodStart() {
  if (_statsPeriod === "all")    return 0;
  if (_statsPeriod === "week")   return Date.now() - 7   * DAY_MS;
  if (_statsPeriod === "month")  return Date.now() - 30  * DAY_MS;
  if (_statsPeriod === "3month") return Date.now() - 90  * DAY_MS;
  if (_statsPeriod === "year")   return Date.now() - 365 * DAY_MS;
  return 0;
}

// ── Календарь: диапазон ──
function statsCalendarRange(workouts) {
  const MAX_WEEKS = 12;
  const todayStart = statsStartOfDay(Date.now());
  if (!workouts.length) return { from: todayStart - 4*7*DAY_MS, to: todayStart };
  // reduce, а не Math.min(...spread): spread большого массива упирается в лимит
  // аргументов стека (история может быть длинной).
  const firstDay = statsStartOfDay(workouts.reduce((m, w) => Math.min(m, w.startedAt), Infinity));
  const weeksElapsed = Math.ceil((todayStart - firstDay) / (7*DAY_MS));
  if (weeksElapsed <= MAX_WEEKS) {
    const d = new Date(firstDay);
    const dow = d.getDay(); const back = dow === 0 ? 6 : dow - 1;
    return { from: firstDay - back*DAY_MS, to: todayStart };
  }
  return { from: todayStart - MAX_WEEKS*7*DAY_MS, to: todayStart };
}

// ── Рендер календаря ──
function renderStatsCalendar(workouts) {
  const COUNT = 15;
  const todayStart = statsStartOfDay(Date.now());
  let html = `<div style="display:grid;grid-template-columns:repeat(${COUNT},1fr);gap:5px;">`;
  for (let i = COUNT - 1; i >= 0; i--) {
    const ts = todayStart - i * DAY_MS;
    const day = workouts.filter(w => statsStartOfDay(w.startedAt) === ts);
    const hasS = day.some(w => w.type === "strength");
    const hasR = day.some(w => w.type === "run");
    let bg = "rgba(255,255,255,0.05)";
    if (hasS && hasR) bg = "linear-gradient(135deg,#8a78f0 50%,#3fd6a0 50%)";
    else if (hasS) bg = "#8a78f0";
    else if (hasR) bg = "#3fd6a0";
    const opacity = (hasS || hasR) ? " opacity:0.85;" : "";
    html += `<div style="aspect-ratio:1;border-radius:3px;background:${bg};${opacity}"></div>`;
  }
  html += `</div>`;
  return html;
}

// ── Данные упражнений с историей ──
function statsExWithHistory(workouts) {
  const cnt = {};
  workouts.filter(w => w.type === "strength").forEach(w => {
    (w.exercises||[]).forEach(ex => { cnt[ex.exerciseId] = (cnt[ex.exerciseId]||0)+1; });
  });
  return Object.entries(cnt).sort((a,b)=>b[1]-a[1]).map(([id,count])=>({id,count}));
}

// ── График прогресса SVG ──
function renderStatsGraph(points, mode, containerW, containerH) {
  if (points.length < 2) return `<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:13px;color:var(--text-tertiary);font-style:italic">${points.length===0?"Нет данных за период":"Нужно минимум 2 тренировки"}</div>`;
  const vals = points.map(p => mode === "weight" ? p.maxWeight : p.volume);
  const minV = vals.reduce((a, b) => Math.min(a, b), Infinity);
  const maxV = vals.reduce((a, b) => Math.max(a, b), -Infinity);
  const minTs = points[0].ts, maxTs = points[points.length-1].ts;
  // W и H берутся из реальных измеренных размеров контейнера (см. вызов ниже),
  // чтобы 1 единица viewBox = 1 css-пиксель и график не растягивался/сплющивался
  // под форму карточки. H заметно увеличен — раньше было 80px, график выглядел
  // сжатым (п.10).
  const W = containerW || 280, H = containerH || 150, px = 16, py = 18;
  const gW=W-px*2, gH=H-py*2;
  const rangeV = maxV-minV||1, rangeTs = maxTs-minTs||1;
  const xOf = ts => px + (ts-minTs)/rangeTs*gW;
  const yOf = v  => py + gH - (v-minV)/rangeV*gH;
  const area = [
    `${xOf(points[0].ts).toFixed(1)},${H-py}`,
    ...points.map((p,i)=>`${xOf(p.ts).toFixed(1)},${yOf(vals[i]).toFixed(1)}`),
    `${xOf(points[points.length-1].ts).toFixed(1)},${H-py}`
  ].join(" ");
  const line = points.map((p,i)=>`${xOf(p.ts).toFixed(1)},${yOf(vals[i]).toFixed(1)}`).join(" ");
  const dots = points.map((p,i)=>`<circle cx="${xOf(p.ts).toFixed(1)}" cy="${yOf(vals[i]).toFixed(1)}" r="3.6" fill="var(--accent)"/>`).join("");
  // Метки месяцев — x зажат внутрь поля графика, чтобы text-anchor="middle"
  // не выталкивал часть подписи за пределы SVG (там она обрезалась рамкой
  // карточки с overflow:hidden — например «июнь» превращался в «юнь»/«люнь»).
  let monthsSeen = new Set(), monthLabels = "";
  points.forEach(p => {
    const d = new Date(p.ts), key = `${d.getFullYear()}-${d.getMonth()}`;
    if (!monthsSeen.has(key)) {
      monthsSeen.add(key);
      const lbl = d.toLocaleString("ru-RU",{month:"short"}).replace(".","");
      const lx = Math.min(Math.max(xOf(p.ts), 14), W-14);
      monthLabels += `<text x="${lx.toFixed(1)}" y="${H-4}" font-size="10.5" fill="rgba(255,255,255,0.3)" text-anchor="middle">${lbl}</text>`;
    }
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%">
    <polygon points="${area}" fill="rgba(124,108,230,0.07)"/>
    <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}${monthLabels}
  </svg>`;
}

// ── Главная функция ──
function initStatsScreen() {
  const userId = DATA.getCurrentUser();
  if (!userId) return;
  const workouts = DATA.getWorkoutHistory(userId) || [];
  const scroll = $("stats-scroll");
  if (!scroll) return;

  const ps = statsPeriodStart();
  const filtered = workouts.filter(w => w.startedAt >= ps);
  const strength = filtered.filter(w => w.type === "strength");
  const runs = filtered.filter(w => w.type === "run");

  // Тоннаж
  let volume = 0;
  strength.forEach(w => (w.exercises||[]).forEach(ex => (ex.sets||[]).filter(s=>s.done&&s.weight>0&&s.reps>0).forEach(s=>{ volume+=s.weight*s.reps; })));

  // Время
  let totalMs = 0;
  filtered.forEach(w => { if (w.finishedAt && w.startedAt) totalMs += w.finishedAt - w.startedAt; });
  const totalMin = Math.round(totalMs/60000);
  const durStr = totalMin < 60 ? `${totalMin} мин` : `${Math.floor(totalMin/60)} ч ${totalMin%60>0?totalMin%60+" мин":""}`.trim();

  // Серия
  const streak = computeStreak(workouts);

  // Бег
  let totalDist=0, paceSecs=[], bestPaceSec=Infinity;
  runs.forEach(w => {
    totalDist += parseFloat(w.distance)||0;
    if (w.pace) {
      const [m,s] = w.pace.split(":").map(Number);
      const ps2 = m*60+(s||0);
      paceSecs.push(ps2);
      if (ps2<bestPaceSec) bestPaceSec=ps2;
    }
  });
  const avgPaceSec = paceSecs.length ? Math.round(paceSecs.reduce((a,b)=>a+b,0)/paceSecs.length) : null;
  const paceStr = s => { if(s===null||s===Infinity) return "—"; return `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`; };

  // Упражнение
  const exWithHist = statsExWithHistory(workouts);
  const allEx = DATA.getVisibleExercises(userId);
  if (!_statsSelectedExId || !allEx.find(e=>e.id===_statsSelectedExId)) {
    _statsSelectedExId = exWithHist[0]?.id || null;
  }
  const selEx = allEx.find(e=>e.id===_statsSelectedExId);
  const selRec = _statsSelectedExId ? DATA.getExerciseRecord(userId, _statsSelectedExId) : null;

  // Данные для графика
  let graphPoints = [];
  if (_statsSelectedExId) {
    workouts.filter(w=>w.type==="strength").sort((a,b)=>a.startedAt-b.startedAt).forEach(w => {
      const ex = (w.exercises||[]).find(e=>e.exerciseId===_statsSelectedExId);
      if (!ex) return;
      const done = (ex.sets||[]).filter(s=>s.done&&s.weight>0&&s.reps>0);
      if (!done.length) return;
      graphPoints.push({ ts: w.startedAt, maxWeight: Math.max(...done.map(s=>s.weight)), volume: Math.round(done.reduce((a,s)=>a+s.weight*s.reps,0)) });
    });
  }

  // Прогресс за период — отдельной ячейкой под графиком
  const gpInPeriod = graphPoints.filter(p=>p.ts>=ps);
  let progTxt = "—", progValCls = "";
  if (gpInPeriod.length>=2 && gpInPeriod[0].maxWeight>0) {
    const pct = Math.round((gpInPeriod[gpInPeriod.length-1].maxWeight - gpInPeriod[0].maxWeight)/gpInPeriod[0].maxWeight*100);
    progTxt = pct>0?`+${pct}%`:`${pct}%`;
    progValCls = pct>0?" up":pct<0?" down":"";
  }

  // Время по типам (для карточек)
  let strengthMs = 0, runMs = 0;
  strength.forEach(w => { if (w.finishedAt && w.startedAt) strengthMs += w.finishedAt - w.startedAt; });
  runs.forEach(w => { if (w.finishedAt && w.startedAt) runMs += w.finishedAt - w.startedAt; });
  const _hrsStr = ms => { const h = ms / 3600000; return h < 1 ? `${Math.round(h * 60)} мин` : `${Math.round(h * 10) / 10} ч`; };
  const strengthHrs = strengthMs > 0 ? _hrsStr(strengthMs) : "—";
  const runHrs = runMs > 0 ? _hrsStr(runMs) : "—";
  const oneRM = selRec && typeof estimate1RM === "function" ? estimate1RM(selRec.maxWeight, selRec.repsAtMaxWeight) : 0;

  // Доп. метрики для детальных экранов (за выбранный период)
  let totalSets = 0, totalReps = 0, restSecTotal = 0;
  strength.forEach(w => (w.exercises||[]).forEach(ex => (ex.sets||[]).filter(s=>s.done&&s.reps>0).forEach(s=>{ totalSets++; totalReps += s.reps||0; })));
  strength.forEach(w => { restSecTotal += w.restSec || 0; });
  let longestRun = 0;
  runs.forEach(w => { const d = parseFloat(w.distance)||0; if (d>longestRun) longestRun = d; });
  const avgDistPerRun = runs.length ? totalDist/runs.length : 0;
  const km = v => `${Math.round(v*10)/10} км`;

  // Календарь активности фильтруем по выбранному типу.
  const calWorkouts = _statsTypeFilter === "strength" ? workouts.filter(w=>w.type==="strength")
    : _statsTypeFilter === "run" ? workouts.filter(w=>w.type==="run")
    : workouts;
  const calendarBlock = `<div class="s-section-label">Активность</div><div class="s-calendar">${renderStatsCalendar(calWorkouts)}</div>`;

  // Дропдауны фильтров (тип + период) — в шапке экрана, как в Истории.
  const typeOpts = [["all","Все"],["strength","Силовые"],["run","Бег"]].map(([key,label]) =>
    ({ key, label, count: key==="all"?filtered.length : key==="strength"?strength.length : runs.length }));
  buildHistoryDropdown($("stats-type-dd"), typeOpts, _statsTypeFilter, key => { _statsTypeFilter = key; initStatsScreen(); });
  buildHistoryDropdown($("stats-period-dd"), STATS_PERIODS.map(([key,label])=>({key,label})), _statsPeriod, key => { _statsPeriod = key; initStatsScreen(); });

  const tile = (val, label, cls="") => `<div class="s-ex-rec"><div class="s-ex-rec-val${cls}">${val}</div><div class="s-ex-rec-label">${label}</div></div>`;

  // Карточка прогресса по упражнению (только на экране силовых).
  const exerciseCardHtml = _statsSelectedExId ? `
    <div class="s-ex-card">
      <div class="s-ex-header">
        <div class="s-ex-name" style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(selEx?.name||_statsSelectedExId)}</div>
        <button class="s-ex-pick-btn" id="stats-ex-pick-btn" title="Изменить упражнение">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M6 9l6 6 6-6"/></svg>
        </button>
      </div>
      <div class="s-ex-body">
        <div class="s-chart-frame" id="s-graph-wrap">${renderStatsGraph(gpInPeriod, _statsGraphMode)}</div>
        <div class="s-ex-recs">
          ${tile(selRec ? `${selRec.maxWeight} кг` : "—", "макс. вес")}
          ${tile(oneRM ? `${oneRM} кг` : "—", "1ПМ расчёт")}
          <div class="s-ex-rec${progValCls === ' up' ? ' prog-up' : ''}">
            <div class="s-ex-rec-val${progValCls}">${progTxt}</div>
            <div class="s-ex-rec-label">прогресс</div>
          </div>
        </div>
      </div>
    </div>` : `<div class="s-empty">Проведи первую силовую тренировку</div>`;

  let html;
  if (_statsTypeFilter === "strength") {
    // ── Экран 2: силовые ──
    html = `
      <div class="s-card s-card-full s-card-blue">
        <div class="s-type-label s-type-blue">Силовые тренировки</div>
        <div class="s-divider"></div>
        <div class="s-tiles s-tiles-3">
          ${tile(strength.length, "Тренировки")}
          ${tile(strengthHrs, "Время")}
          ${tile(volume>0?`${volume.toLocaleString("ru-RU")} кг`:"—", "Тоннаж")}
        </div>
        <div class="s-tiles s-tiles-3">
          ${tile(totalSets||"—", "Подходы")}
          ${tile(totalReps||"—", "Повторы")}
          ${tile(restSecTotal>0?_hrsStr(restSecTotal*1000):"—", "Отдых")}
        </div>
      </div>
      ${calendarBlock}
      ${exerciseCardHtml}
    `;
  } else if (_statsTypeFilter === "run") {
    // ── Экран 3: бег ──
    html = `
      <div class="s-card s-card-full s-card-green">
        <div class="s-type-label s-type-green">Беговые тренировки</div>
        <div class="s-divider"></div>
        <div class="s-tiles s-tiles-3">
          ${tile(runs.length, "Пробежки")}
          ${tile(runHrs, "Время")}
          ${tile(totalDist>0?km(totalDist):"—", "Дистанция")}
        </div>
        <div class="s-tiles s-tiles-3">
          ${tile(paceStr(avgPaceSec), "Ср. темп")}
          ${tile(paceStr(bestPaceSec===Infinity?null:bestPaceSec), "Лучший темп")}
          ${tile(longestRun>0?km(longestRun):"—", "Макс. дист.")}
        </div>
      </div>
      ${calendarBlock}
      <div class="s-section-label">Средние за пробежку</div>
      <div class="s-card s-card-full">
        <div class="s-tiles s-tiles-2">
          ${tile(avgDistPerRun>0?km(avgDistPerRun):"—", "Дист./пробежку")}
          ${tile(runs.length?_hrsStr(runMs/runs.length):"—", "Время/пробежку")}
        </div>
      </div>
    `;
  } else {
    // ── Экран 1: все ──
    html = `
      <div class="s-cards-grid">
        <div class="s-card s-card-blue s-card-stat">
          <div class="s-type-label s-type-blue">Силовые</div>
          <div class="s-divider"></div>
          <div class="s-main-num">${strength.length}</div>
          <div class="s-main-sub">трен.</div>
          <div class="s-divider"></div>
          <div class="s-sub-stats">
            <div><div class="s-sub-val">${strengthHrs}</div><div class="s-sub-label">Время</div></div>
            <div><div class="s-sub-val">${volume > 0 ? `${volume.toLocaleString("ru-RU")} кг` : "—"}</div><div class="s-sub-label">Тоннаж</div></div>
          </div>
        </div>
        <div class="s-card s-card-green s-card-stat">
          <div class="s-type-label s-type-green">Бег</div>
          <div class="s-divider"></div>
          <div class="s-main-num">${runs.length}</div>
          <div class="s-main-sub">трен.</div>
          <div class="s-divider"></div>
          <div class="s-sub-stats">
            <div><div class="s-sub-val">${runHrs}</div><div class="s-sub-label">Время</div></div>
            <div><div class="s-sub-val">${totalDist > 0 ? km(totalDist) : "—"}</div><div class="s-sub-label">Дист.</div></div>
          </div>
        </div>
      </div>
      ${calendarBlock}
      <div class="s-card s-card-full">
        <div class="s-tiles s-tiles-2">
          ${tile(filtered.length, "Всего трен.")}
          ${tile(durStr || "—", "Общее время")}
          ${tile(streak.current ? `${streak.current} дн.` : "—", "Текущая серия")}
          ${tile(streak.best ? `${streak.best} дн.` : "—", "Лучшая серия")}
        </div>
      </div>
    `;
  }
  scroll.innerHTML = html;

  // График рисуется 1:1 в пикселях — перерисовываем с точными размерами после вставки в DOM.
  const graphWrap = $("s-graph-wrap");
  if (graphWrap) {
    const realW = Math.round(graphWrap.getBoundingClientRect().width);
    const realH = Math.round(graphWrap.getBoundingClientRect().height);
    if (realW > 0) graphWrap.innerHTML = renderStatsGraph(gpInPeriod, _statsGraphMode, realW, realH);
  }

  // Выбор упражнения — используем общий пикер с категориями и поиском
  const pickBtn = $("stats-ex-pick-btn");
  if (pickBtn) pickBtn.addEventListener("click", () => {
    openExercisePicker(id => { _statsSelectedExId = id; initStatsScreen(); }, _statsSelectedExId);
  });
}

function openStatsExPicker(exWithHist, allEx, userId) {
  const existing = $("stats-ex-picker");
  if (existing) existing.remove();

  const backdrop = document.createElement("div");
  backdrop.id = "stats-ex-picker";
  backdrop.className = "stats-picker-backdrop";

  const sheet = document.createElement("div");
  sheet.className = "stats-picker-sheet";
  sheet.innerHTML = `<div class="stats-picker-handle"></div><div class="stats-picker-title">Выбрать упражнение</div>`;

  const list = document.createElement("div");
  list.className = "stats-picker-list";
  exWithHist.forEach(({id, count}) => {
    const ex = allEx.find(e=>e.id===id);
    const name = ex?.name||id;
    const item = document.createElement("button");
    item.className = "stats-picker-item" + (id===_statsSelectedExId?" selected":"");
    item.innerHTML = `${escHtml(name)}<span class="stats-picker-item-count">${count}×</span>${id===_statsSelectedExId?`<svg class="stats-picker-item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`:""}`;
    item.addEventListener("click", () => { _statsSelectedExId=id; backdrop.remove(); initStatsScreen(); });
    list.appendChild(item);
  });
  sheet.appendChild(list);
  backdrop.appendChild(sheet);
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add("open"));

  const closeSheet = () => { backdrop.classList.remove("open"); setTimeout(() => backdrop.remove(), 250); };
  backdrop.addEventListener("click", e => { if (e.target === backdrop) closeSheet(); });

  // Свайп вниз по шторке — drag-to-dismiss
  let sy = 0, sdy = 0, sdragging = false;
  sheet.addEventListener("touchstart", e => {
    if (e.touches.length !== 1) return;
    sy = e.touches[0].clientY; sdy = 0; sdragging = true;
    sheet.style.transition = "none";
  }, { passive: true });
  sheet.addEventListener("touchmove", e => {
    if (!sdragging) return;
    const dy = e.touches[0].clientY - sy;
    if (dy > 0 && list.scrollTop <= 0) {
      sdy = dy;
      sheet.style.transform = `translateY(${dy}px)`;
    } else {
      sdy = 0;
      sheet.style.transform = "";
    }
  }, { passive: true });
  const onSheetEnd = () => {
    if (!sdragging) return;
    sdragging = false;
    if (sdy > 80) {
      sheet.style.transition = "transform 0.22s ease";
      sheet.style.transform = `translateY(${sheet.offsetHeight}px)`;
      closeSheet();
    } else {
      sheet.style.transition = "";
      sheet.style.transform = "";
    }
  };
  sheet.addEventListener("touchend", onSheetEnd);
  sheet.addEventListener("touchcancel", onSheetEnd);
}

$("stats-back-btn").addEventListener("click", () => goToScreen("menu"));

function openStatChartScreen(exerciseId) {
  const userId = DATA.getCurrentUser();
  const ex     = DATA.getVisibleExercises(userId).find(e => e.id === exerciseId) || { id: exerciseId, name: exerciseId };
  const rec    = DATA.getExerciseRecord(userId, exerciseId);
  const points = DATA.getExerciseProgress(userId, exerciseId);

  $("stat-chart-title").textContent = ex.name;
  $("stat-chart-meta").textContent  = `${points.length} ${pluralWorkouts(points.length)}`;

  const oneRM = rec ? estimate1RM(rec.maxWeight, rec.repsAtMaxWeight) : 0;
  const recordsHtml = rec ? `
    <div class="detail-stats">
      <div class="detail-stat"><div class="detail-stat-num">${rec.maxWeight} кг</div><div class="detail-stat-label">Макс. вес, × ${rec.repsAtMaxWeight}</div></div>
      ${oneRM ? `<div class="detail-stat"><div class="detail-stat-num">${oneRM} кг</div><div class="detail-stat-label">Оценка 1ПМ</div></div>` : ""}
    </div>` : "";

  const chartHtml = `
    <div class="stat-chart-block">
      <div class="stat-chart-title">Рабочий вес по тренировкам</div>
      <div class="stat-chart-wrap">${renderProgressChart(points.map(p => ({ x: p.date, y: p.weight })), { unit: "кг" })}</div>
    </div>`;

  const historyHtml = points.length ? `
    <div class="detail-ex">
      <div class="detail-ex-name">История</div>
      ${points.slice().reverse().map(p => `
        <div class="detail-set-row">
          <span class="stat-hist-date">${fmtDate(p.date)}</span>
          <span class="detail-set-val">${p.weight} кг × ${p.reps} повт</span>
        </div>`).join("")}
    </div>` : "";

  $("stat-chart-body").innerHTML = recordsHtml + chartHtml + historyHtml;
  goToScreen("statChart");
}

$("stat-chart-back-btn").addEventListener("click", () => goToScreen("stats"));

function pluralWorkouts(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "тренировка";
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "тренировки";
  return "тренировок";
}

// Лёгкий SVG-график без зависимостей: линия + точки + подписи первой/последней даты.
// points: [{x: timestamp, y: number}], отсортированы по x по возрастанию.
let _chartIdCounter = 0;
function renderProgressChart(points, opts = {}) {
  if (!points.length) return `<div class="stat-chart-empty">Пока нет данных</div>`;

  if (points.length === 1) {
    const val = opts.formatY ? opts.formatY(points[0].y) : `${points[0].y} ${opts.unit || ""}`.trim();
    return `<div class="stat-chart-empty">Пока одна тренировка: <b>${val}</b><br>график появится после второй</div>`;
  }

  const width = 600, height = 230; // выше прежнего (168) — график не такой сжатый (п.10)
  const padL = 12, padR = 12, padT = 16, padB = 28;
  const innerW = width - padL - padR, innerH = height - padT - padB;

  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  let minY = Math.min(...ys), maxY = Math.max(...ys);
  if (minY === maxY) { minY -= 1; maxY += 1; }
  const yPad = (maxY - minY) * 0.18;
  minY -= yPad; maxY += yPad;
  if (minY < 0) minY = 0; // дистанция/темп/вес не уходят в минус

  const xPos = x => (maxX === minX ? padL + innerW / 2 : padL + ((x - minX) / (maxX - minX)) * innerW);
  const yPos = y => padT + innerH - ((y - minY) / (maxY - minY)) * innerH;

  const linePts = points.map(p => `${xPos(p.x).toFixed(1)},${yPos(p.y).toFixed(1)}`).join(" ");
  const areaPts = `${padL},${(padT + innerH).toFixed(1)} ${linePts} ${(padL + innerW).toFixed(1)},${(padT + innerH).toFixed(1)}`;
  const dots = points.map(p => `<circle cx="${xPos(p.x).toFixed(1)}" cy="${yPos(p.y).toFixed(1)}" r="3.2" fill="currentColor"/>`).join("");

  const gradId = `chartGrad${_chartIdCounter++}`;
  const fmtShort = ts => { const d = new Date(ts); return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`; };

  return `
    <svg viewBox="0 0 ${width} ${height}" class="stat-chart-svg">
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="currentColor" stop-opacity="0.3"/>
          <stop offset="100%" stop-color="currentColor" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <polygon points="${areaPts}" fill="url(#${gradId})"/>
      <polyline points="${linePts}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      ${dots}
      <text x="${padL}" y="${height - 6}" font-size="10.5" fill="#5e5e6b">${fmtShort(minX)}</text>
      <text x="${padL + innerW}" y="${height - 6}" font-size="10.5" fill="#5e5e6b" text-anchor="end">${fmtShort(maxX)}</text>
    </svg>
  `;
}

/* ==========================================================================
   Screen 7: Templates (раздел 5 спецификации)
   - список личных шаблонов пользователя
   - редактор состава шаблона: упражнения + целевые вес/повторы по подходам
     (без RPE и отметки выполнения — это план, а не лог тренировки)
   - «Начать тренировку» — переносит состав в новую активную тренировку
   - «Поделиться» — независимая копия у другого пользователя
   ========================================================================== */
const templatesScroll = $("templates-scroll");

// Имена модалки ввода (создание/переименование) — модалка осталась общей.
const nameModalBackdrop  = $("name-modal-backdrop");
const nameModalTitle     = $("name-modal-title");
const nameModalInput     = $("name-modal-input");
const nameModalConfirm   = $("name-modal-confirm");

let _tplEditMode = false;  // глобальный режим правки: все карточки «дрожат»
let _tplDrag = null;       // активное перетаскивание ячейки упражнения внутри карточки

// Иконки карточек шаблона
const TPL_PLAY_SVG  = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z"/></svg>`;
const TPL_PLUS_SVG  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
const TPL_X_SVG     = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
const TPL_TRASH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>`;
const TPL_HANDLE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="8" x2="20" y2="8"/><line x1="4" y1="16" x2="20" y2="16"/></svg>`;
const TPL_SHARE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/></svg>`;

function pluralExercises(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "упражнение";
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "упражнения";
  return "упражнений";
}

function pluralDays(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "день";
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "дня";
  return "дней";
}

// «когда последний раз делали этот шаблон» — короткой строкой для меты карточки
function relPastText(ts) {
  if (!ts) return null;
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return "сегодня";
  if (days === 1) return "вчера";
  if (days < 7) return `${days} ${pluralDays(days)} назад`;
  const weeks = Math.floor(days / 7);
  if (weeks === 1) return "неделю назад";
  if (weeks < 4) return `${weeks} нед назад`;
  const months = Math.floor(days / 30);
  if (months <= 1) return "месяц назад";
  if (months < 12) return `${months} мес назад`;
  return "давно";
}

// Среднее время и дата последнего выполнения шаблона — по истории тренировок,
// связанных с этим шаблоном (workout.templateId). Если выполненных ещё нет —
// грубая оценка 12 минут на упражнение.
function templateUsage(tpl, history) {
  const runs = history.filter(w => w.templateId === tpl.id);
  const withDur = runs.filter(w => w.durationSec);
  let avgMin;
  if (withDur.length) {
    avgMin = Math.round(withDur.reduce((s, w) => s + w.durationSec, 0) / withDur.length / 60);
  } else {
    avgMin = tpl.exercises.length * 12;
  }
  let lastTs = null;
  runs.forEach(w => { const t = w.finishedAt || w.startedAt; if (t && (!lastTs || t > lastTs)) lastTs = t; });
  return { avgMin: Math.max(1, avgMin), lastTs };
}

function templateExName(ex, lib) {
  const def = lib.find(e => e.id === ex.exerciseId);
  return def ? def.name : (ex.name || "Упражнение");
}

/* — Единый экран шаблонов: список карточек + правка inline — */
function initTemplatesScreen() {
  _tplEditMode = false;
  const b = $("templates-done-btn"); if (b) b.classList.remove("visible");
  renderTemplatesList();
}

function tplCardHtml(t, history, lib) {
  const n = t.exercises.length;
  const { avgMin, lastTs } = templateUsage(t, history);
  const metaParts = [`${n} ${pluralExercises(n)}`];
  if (n) metaParts.push(`~${avgMin} мин`);
  const last = relPastText(lastTs);
  if (last) metaParts.push(`посл. ${last}`);
  const meta = metaParts.join(" · ");

  let body;
  if (_tplEditMode) {
    const cells = t.exercises.map((ex, i) => `
      <div class="tpl-ex-cell" data-idx="${i}">
        <span class="tpl-ex-handle">${TPL_HANDLE_SVG}</span>
        <span class="tpl-ex-name">${escHtml(templateExName(ex, lib))}</span>
        <button class="tpl-ex-remove" title="Убрать из шаблона">${TPL_X_SVG}</button>
      </div>`).join("");
    body = `
      <div class="tpl-ex-list">${cells}</div>
      <button class="tpl-ex-add">${TPL_PLUS_SVG}<span>Добавить упражнение</span></button>`;
  } else {
    const chips = n
      ? t.exercises.map(ex => `<span class="tpl-chip">${escHtml(templateExName(ex, lib))}</span>`).join("")
      : `<span class="tpl-chip tpl-chip--empty">Пока нет упражнений</span>`;
    body = `
      <div class="tpl-card-chips">${chips}</div>
      <button class="tpl-card-start"${n ? "" : " disabled"}>${TPL_PLAY_SVG}<span>Начать тренировку</span></button>`;
  }

  const titleCls = _tplEditMode ? "tpl-card-title tpl-card-title--edit" : "tpl-card-title";
  // Кнопка «Поделиться» — только в режиме правки, в правом верхнем углу карточки.
  const shareBtn = _tplEditMode
    ? `<button class="tpl-share-btn" title="Поделиться шаблоном">${TPL_SHARE_SVG}</button>`
    : "";
  return `
    <div class="tpl-card-wrap" data-id="${escHtml(t.id)}">
      <div class="tpl-card-delete">${TPL_TRASH_SVG}<span>Удалить</span></div>
      <div class="tpl-card tpl-card--strength" data-id="${escHtml(t.id)}">
        ${shareBtn}
        <div class="${titleCls}">${escHtml(t.name)}</div>
        <div class="tpl-card-meta">${escHtml(meta)}</div>
        ${body}
      </div>
    </div>`;
}

function tplAddBtnHtml() {
  return `<button class="tpl-add-new" id="tpl-add-new">${TPL_PLUS_SVG}<span>Добавить новый шаблон</span></button>`;
}

function renderTemplatesList() {
  const userId  = DATA.getCurrentUser();
  const list    = DATA.getTemplates(userId);
  const history = DATA.getWorkoutHistory(userId);
  const lib     = DATA.getVisibleExercises(userId);

  templatesScroll.classList.toggle("tpl-editing", _tplEditMode);

  const cards = list.map(t => tplCardHtml(t, history, lib)).join("");
  templatesScroll.innerHTML = `<div class="tpl-list">${cards}${tplAddBtnHtml()}</div>`;

  list.forEach(t => wireTplCard(t.id));
  const addBtn = $("tpl-add-new");
  if (addBtn) addBtn.addEventListener("click", createNewTemplate);
}

function enterTplEditMode() {
  if (_tplEditMode) return;
  _tplEditMode = true;
  haptic(22);
  renderTemplatesList();
  const b = $("templates-done-btn"); if (b) b.classList.add("visible");
}

function exitTplEditMode() {
  if (!_tplEditMode) return;
  _tplEditMode = false;
  renderTemplatesList();
  const b = $("templates-done-btn"); if (b) b.classList.remove("visible");
}

$("templates-back-btn").addEventListener("click", () => { exitTplEditMode(); goToScreen("menu"); });
$("templates-done-btn").addEventListener("click", exitTplEditMode);

/* — Создание нового шаблона: сразу открываем режим правки, чтобы добавить состав — */
function createNewTemplate() {
  openNameModal({
    title: "Новый шаблон",
    placeholder: "Например, День спины",
    confirmLabel: "Создать",
    onConfirm: name => {
      const userId = DATA.getCurrentUser();
      const tpl = DATA.createBlankTemplate(userId, name);
      SyncQueue.push("template:create", { templateId: tpl.id });
      _tplEditMode = true;
      renderTemplatesList();
      const b = $("templates-done-btn"); if (b) b.classList.add("visible");
      templatesScroll.scrollTop = 0;
    },
  });
}

/* — Старт тренировки из шаблона: состав выбран за нас, значения — теневые из
   прошлого раза (всё как при ручном старте и добавлении упражнений) — */
function tplStartWorkout(id) {
  const userId = DATA.getCurrentUser();
  if (DATA.getActiveWorkout(userId)) {
    showToast("Сначала заверши текущую тренировку");
    goToScreen("workout");
    return;
  }
  const workout = DATA.startWorkoutFromTemplate(userId, id);
  if (!workout) { showToast("Не удалось начать тренировку"); return; }
  goToScreen("workout");
}

function deleteTemplateWithUndo(id) {
  const userId = DATA.getCurrentUser();
  const snapshot = [...DATA.getTemplates(userId)];
  DATA.deleteTemplate(userId, id);
  SyncQueue.push("template:delete", { templateId: id });
  renderTemplatesList();
  showUndoToast("Шаблон удалён", () => {
    DATA.saveTemplates(userId, snapshot);
    SyncQueue.push("template:create", {}); // повторно зальёт список шаблонов
    renderTemplatesList();
    showToast("Восстановлено");
  });
}

/* — Переименование шаблона: инлайн-правка названия (как в списке упражнений) — */
function startTplRename(wrap, id) {
  const nameEl = wrap.querySelector(".tpl-card-title");
  if (!nameEl || wrap.dataset.renaming) return;
  wrap.dataset.renaming = "1";

  const current = nameEl.textContent;
  const inp = document.createElement("input");
  inp.type = "text";
  inp.value = current;
  inp.className = "tpl-title-input";
  nameEl.replaceWith(inp);
  inp.focus();
  inp.select();

  const commit = () => {
    if (!wrap.dataset.renaming) return;
    delete wrap.dataset.renaming;
    const next = inp.value.trim();
    if (next && next !== current) {
      const userId = DATA.getCurrentUser();
      DATA.renameTemplate(userId, id, next);
      SyncQueue.push("template:rename", { templateId: id });
      // Все тренировки по этому шаблону носят его имя (п.4).
      DATA.renameTemplateWorkouts(userId, id, next).forEach(wid =>
        SyncQueue.push("workout:edit", { workoutId: wid }));
    }
    const div = document.createElement("div");
    div.className = "tpl-card-title tpl-card-title--edit";
    div.textContent = next || current;
    inp.replaceWith(div);
    div.addEventListener("click", e => { e.stopPropagation(); startTplRename(wrap, id); });
  };

  inp.addEventListener("blur", commit);
  inp.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); inp.blur(); }
    if (e.key === "Escape") { inp.value = current; inp.blur(); }
  });
  inp.addEventListener("pointerdown", e => e.stopPropagation());
}

/* — Добавить упражнение в шаблон (кнопка в карточке) — */
function tplAddExercise(id) {
  openExercisePicker(exId => {
    const userId = DATA.getCurrentUser();
    const tpl = DATA.getTemplate(userId, id);
    if (!tpl) return;
    const name = DATA.getVisibleExercises(userId).find(e => e.id === exId)?.name;
    tpl.exercises.push({ exerciseId: exId, name });
    DATA.updateTemplateExercises(userId, id, tpl.exercises);
    SyncQueue.push("template:update", { templateId: id });
    renderTemplatesList();
  });
}

/* — Поделиться шаблоном = независимая копия у другого пользователя (раздел 5) — */
const shareModalBackdrop = $("share-modal-backdrop");
const shareModalList     = $("share-modal-list");

function tplShareTemplate(id) {
  const userId = DATA.getCurrentUser();
  const others = DATA.USERS.filter(u => u.id !== userId);
  if (!others.length) { showToast("Делиться не с кем"); return; }

  shareModalList.innerHTML = others.map(u => `
    <button class="modal-option" data-user="${u.id}">
      <span class="avatar sm ${u.avatarClass}">${u.initial}</span>
      <span>${u.name}</span>
    </button>
  `).join("");

  shareModalList.querySelectorAll(".modal-option").forEach(btn => {
    btn.addEventListener("click", async () => {
      const toUserId = btn.dataset.user;
      const toUser = others.find(u => u.id === toUserId);
      closeModal(shareModalBackdrop);
      await Sync.shareTemplate(id, userId, toUserId);
      showToast(`Шаблон скопирован для ${toUser ? toUser.name : "пользователя"}`);
    });
  });

  openModal(shareModalBackdrop);
}

$("share-modal-cancel").addEventListener("click", () => closeModal(shareModalBackdrop));

/* — Заменить упражнение (тап по ячейке в режиме правки) — */
function tplSwapExercise(id, idx) {
  const userId = DATA.getCurrentUser();
  const tpl = DATA.getTemplate(userId, id);
  if (!tpl || !tpl.exercises[idx]) return;
  openExercisePicker(newId => {
    const name = DATA.getVisibleExercises(userId).find(e => e.id === newId)?.name;
    tpl.exercises[idx] = { exerciseId: newId, name };
    DATA.updateTemplateExercises(userId, id, tpl.exercises);
    SyncQueue.push("template:update", { templateId: id });
    renderTemplatesList();
  }, tpl.exercises[idx].exerciseId);
}

/* — Привязка жестов и кнопок одной карточки — */
function wireTplCard(id) {
  const wrap = templatesScroll.querySelector(`.tpl-card-wrap[data-id="${id}"]`);
  if (!wrap) return;
  const card = wrap.querySelector(".tpl-card");

  if (_tplEditMode) {
    const title = wrap.querySelector(".tpl-card-title--edit");
    if (title) title.addEventListener("click", e => { e.stopPropagation(); startTplRename(wrap, id); });
    const shareBtn = wrap.querySelector(".tpl-share-btn");
    if (shareBtn) shareBtn.addEventListener("click", e => { e.stopPropagation(); tplShareTemplate(id); });
    const addEx = wrap.querySelector(".tpl-ex-add");
    if (addEx) addEx.addEventListener("click", e => { e.stopPropagation(); tplAddExercise(id); });
    wrap.querySelectorAll(".tpl-ex-cell").forEach(cell => wireTplExCell(cell, wrap, id));
  } else {
    const startBtn = wrap.querySelector(".tpl-card-start");
    if (startBtn) startBtn.addEventListener("click", e => { e.stopPropagation(); tplStartWorkout(id); });
    wireTplCardHold(wrap, card);
    wireTplCardSwipe(wrap, id);
  }
}

// Долгое нажатие по карточке (вне режима правки) → вход в режим правки.
function wireTplCardHold(wrap, card) {
  let holdTimer = null, sx = 0, sy = 0, moved = false;
  const clearHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };
  const begin = (x, y, target) => {
    if (target.closest("button, input")) return;
    moved = false; sx = x; sy = y; clearHold();
    holdTimer = setTimeout(() => { holdTimer = null; if (!moved) enterTplEditMode(); }, 430);
  };
  const move = (x, y) => { if (holdTimer && (Math.abs(x - sx) > 8 || Math.abs(y - sy) > 8)) { moved = true; clearHold(); } };
  const finish = () => clearHold();

  card.addEventListener("touchstart", e => { const t = e.touches[0]; begin(t.clientX, t.clientY, e.target); }, { passive: true });
  card.addEventListener("touchmove",  e => { const t = e.touches[0]; if (t) move(t.clientX, t.clientY); }, { passive: true });
  card.addEventListener("touchend",   finish);
  card.addEventListener("touchcancel", finish);
  card.addEventListener("mousedown", e => {
    begin(e.clientX, e.clientY, e.target);
    const mm = ev => move(ev.clientX, ev.clientY);
    const mu = () => { finish(); window.removeEventListener("mousemove", mm); window.removeEventListener("mouseup", mu); };
    window.addEventListener("mousemove", mm); window.addEventListener("mouseup", mu);
  });
}

// Свайп влево по карточке (вне режима правки) → удалить шаблон (с откатом).
function wireTplCardSwipe(wrap, id) {
  const row = wrap.querySelector(".tpl-card");
  if (!row) return;
  let sx = 0, sy = 0, dx = 0, active = false, decided = false, horiz = false, didSwipe = false;
  const MAX = 124, DEL = 86;

  row.addEventListener("pointerdown", e => {
    if (e.target.closest("button, input")) return;
    sx = e.clientX; sy = e.clientY; dx = 0;
    active = true; decided = false; horiz = false; didSwipe = false;
    row.style.transition = "";
  });
  row.addEventListener("pointermove", e => {
    if (!active) return;
    const mx = e.clientX - sx, my = e.clientY - sy;
    if (!decided) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      decided = true;
      horiz = mx < 0 && Math.abs(mx) > Math.abs(my);
      if (!horiz) { active = false; return; }
      wrap.classList.add("swiping");
      try { row.setPointerCapture(e.pointerId); } catch {}
    }
    if (!horiz) return;
    dx = Math.max(-MAX, Math.min(0, mx));
    if (dx < -4) didSwipe = true;
    row.style.transform = `translateX(${dx}px)`;
    wrap.classList.toggle("will-delete", dx <= -DEL);
  });
  row.addEventListener("touchmove", e => {
    if (!active) return;
    const t = e.touches[0]; if (!t) return;
    const mx = t.clientX - sx, my = t.clientY - sy;
    if (horiz || (Math.abs(mx) >= 8 && mx < 0 && Math.abs(mx) > Math.abs(my))) {
      if (e.cancelable) e.preventDefault();
    }
  }, { passive: false });
  const settle = () => {
    if (!active) return;
    active = false;
    if (!horiz) return;
    if (dx <= -DEL) {
      row.style.transition = "transform 0.16s ease";
      row.style.transform = "translateX(-110%)";
      wrap.style.height = wrap.offsetHeight + "px";
      requestAnimationFrame(() => {
        wrap.style.transition = "height 0.18s ease, opacity 0.18s ease";
        wrap.style.height = "0"; wrap.style.opacity = "0";
      });
      setTimeout(() => deleteTemplateWithUndo(id), 200);
    } else {
      row.style.transition = "transform 0.18s ease";
      row.style.transform = "";
      wrap.classList.remove("will-delete");
      setTimeout(() => wrap.classList.remove("swiping"), 200);
    }
  };
  row.addEventListener("pointerup", settle);
  row.addEventListener("pointercancel", settle);
  row.addEventListener("click", e => {
    if (didSwipe) { e.stopPropagation(); e.preventDefault(); didSwipe = false; }
  }, true);
}

// Ячейка упражнения в режиме правки: тап → замена, крестик → удалить, зажатие → перетащить.
function wireTplExCell(cell, wrap, id) {
  const listEl = wrap.querySelector(".tpl-ex-list");
  const removeBtn = cell.querySelector(".tpl-ex-remove");
  if (removeBtn) removeBtn.addEventListener("click", e => {
    e.stopPropagation();
    const userId = DATA.getCurrentUser();
    const tpl = DATA.getTemplate(userId, id);
    if (!tpl) return;
    const i = +cell.dataset.idx;
    tpl.exercises.splice(i, 1);
    DATA.updateTemplateExercises(userId, id, tpl.exercises);
    SyncQueue.push("template:update", { templateId: id });
    renderTemplatesList();
  });

  let holdTimer = null, sx = 0, sy = 0, moved = false, dragging = false;
  const clearHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };
  const begin = (x, y, target) => {
    if (target.closest(".tpl-ex-remove")) return;
    moved = false; dragging = false; sx = x; sy = y; clearHold();
    holdTimer = setTimeout(() => {
      holdTimer = null;
      if (moved) return;
      dragging = true;
      startTplExDrag(cell, listEl, y);
    }, 250);
  };
  const move = (x, y, e) => {
    if (dragging) { if (e && e.cancelable) e.preventDefault(); moveTplExDrag(y); return; }
    if (holdTimer && (Math.abs(x - sx) > 8 || Math.abs(y - sy) > 8)) { moved = true; clearHold(); }
  };
  const finish = () => {
    clearHold();
    if (dragging) { dragging = false; cell.dataset.justDragged = "1"; endTplExDrag(id); }
  };

  cell.addEventListener("touchstart", e => { const t = e.touches[0]; begin(t.clientX, t.clientY, e.target); }, { passive: true });
  cell.addEventListener("touchmove",  e => { const t = e.touches[0]; if (t) move(t.clientX, t.clientY, e); }, { passive: false });
  cell.addEventListener("touchend",   finish);
  cell.addEventListener("touchcancel", finish);
  cell.addEventListener("mousedown", e => {
    begin(e.clientX, e.clientY, e.target);
    const mm = ev => move(ev.clientX, ev.clientY, null);
    const mu = () => { finish(); window.removeEventListener("mousemove", mm); window.removeEventListener("mouseup", mu); };
    window.addEventListener("mousemove", mm); window.addEventListener("mouseup", mu);
  });
  cell.addEventListener("click", e => {
    if (e.target.closest(".tpl-ex-remove")) return;
    if (cell.dataset.justDragged) { delete cell.dataset.justDragged; e.stopPropagation(); return; }
    if (moved) return;
    e.stopPropagation();
    tplSwapExercise(id, +cell.dataset.idx);
  });
}

function startTplExDrag(cell, listEl, pointerY) {
  if (_tplDrag) return;
  const wrap = listEl.closest(".tpl-card-wrap");
  if (wrap) wrap.classList.add("dragging");      // пауза «дрожания» на время перетаскивания
  const top = cell.getBoundingClientRect().top;
  _tplDrag = { cell, listEl, wrap, grabDy: pointerY - top, ty: 0 };
  cell.style.transition = "none";
  cell.classList.add("tpl-ex-dragging");
  haptic(18);
}

function moveTplExDrag(pointerY) {
  const d = _tplDrag; if (!d) return;
  const h = d.cell.getBoundingClientRect().height;
  const center = (pointerY - d.grabDy) + h / 2;

  let insertBeforeEl = null;
  for (const child of d.listEl.children) {
    if (child === d.cell) continue;
    const r = child.getBoundingClientRect();
    if (r.top + r.height / 2 > center) { insertBeforeEl = child; break; }
  }
  const curNext = d.cell.nextElementSibling;
  if (insertBeforeEl !== curNext && insertBeforeEl !== d.cell) {
    d.listEl.insertBefore(d.cell, insertBeforeEl);
  }

  const rect = d.cell.getBoundingClientRect();
  const naturalTop = rect.top - d.ty;
  d.ty = (pointerY - d.grabDy) - naturalTop;
  d.cell.style.transform = `translateY(${d.ty}px)`;
}

function endTplExDrag(id) {
  const d = _tplDrag; if (!d) return;
  _tplDrag = null;
  d.cell.style.transition = "transform 0.18s ease";
  d.cell.style.transform = "";
  d.cell.classList.remove("tpl-ex-dragging");
  if (d.wrap) d.wrap.classList.remove("dragging");
  setTimeout(() => { d.cell.style.transition = ""; }, 200);

  const userId = DATA.getCurrentUser();
  const tpl = DATA.getTemplate(userId, id);
  if (!tpl) return;
  const cells = [...d.listEl.querySelectorAll(".tpl-ex-cell")];
  tpl.exercises = cells.map(c => tpl.exercises[+c.dataset.idx]);
  DATA.updateTemplateExercises(userId, id, tpl.exercises);
  SyncQueue.push("template:update", { templateId: id });
  // Переиндексируем data-idx на месте (без ре-рендера — иначе ложный tap по ячейке).
  cells.forEach((c, i) => { c.dataset.idx = i; });
}

/* — Универсальная модалка ввода имени: сохранение шаблона из тренировки / переименование — */
let _nameModalOnConfirm = null;

function openNameModal({ title, placeholder, initialValue, confirmLabel, onConfirm }) {
  nameModalTitle.textContent = title;
  nameModalInput.placeholder = placeholder || "";
  nameModalInput.value = initialValue || "";
  nameModalConfirm.textContent = confirmLabel || "Сохранить";
  _nameModalOnConfirm = onConfirm;
  openModal(nameModalBackdrop);
  setTimeout(() => nameModalInput.focus(), 300);
}

$("name-modal-cancel").addEventListener("click", () => closeModal(nameModalBackdrop));
nameModalConfirm.addEventListener("click", () => {
  const value = nameModalInput.value.trim();
  if (!value) { nameModalInput.focus(); return; }
  closeModal(nameModalBackdrop);
  if (_nameModalOnConfirm) _nameModalOnConfirm(value);
});

// Сохранить завершённую силовую тренировку как новый шаблон (раздел 5: «готовую тренировку можно сохранить как шаблон»)
function openSaveAsTemplateModal(workout) {
  openNameModal({
    title: "Сохранить как шаблон",
    placeholder: "Например, День спины",
    initialValue: workout.name || "",
    confirmLabel: "Сохранить",
    onConfirm: name => {
      const userId = DATA.getCurrentUser();
      const tpl = DATA.createTemplateFromWorkout(userId, workout, name);
      SyncQueue.push("template:create", { templateId: tpl.id });
      // Привязываем исходную тренировку к шаблону и переименовываем под него —
      // тогда в карточке шаблона видно дату/время этой тренировки (если она
      // последняя), а все тренировки по шаблону носят его имя (п.4).
      if (DATA.linkWorkoutToTemplate(userId, workout.id, tpl.id, tpl.name)) {
        SyncQueue.push("workout:edit", { workoutId: workout.id });
      }
      showToast("Шаблон сохранён");
    },
  });
}

/* ==========================================================================
   Utils
   ========================================================================== */
// formatDuration, parseDurationToSec, fmtDate, paceStrToSec, secToPaceStr —
// вынесены в lib.js (чистые форматтеры, покрыты тестами в tests.html).

/* ==========================================================================
   PWA: регистрация service worker — каркас приложения кэшируется и работает
   без сети (раздел 2, раздел 8 спецификации).
   ========================================================================== */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").then(reg => {
      reg.addEventListener("updatefound", () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener("statechange", () => {
          // Новая версия каркаса установлена поверх уже работавшей. Предлагаем
          // обновиться одним тапом (перезагрузка подтянет новый index.html/app.js
          // из свежего кэша). Тост висит, пока не нажмут — чтобы не пропал, если
          // человек сейчас в середине подхода.
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
            showActionToast("Доступна новая версия", "Обновить", () => location.reload(), 0);
          }
        });
      });
    }).catch(() => { /* нет SW — офлайн-режим работает только на уже загруженных данных, без кэша каркаса */ });
  });
}

/* ==========================================================================
   Свайп вправо от левого края = «Назад» (п.3)
   В коде такого жеста раньше не было нигде (то, что работало в Safari — нативный
   жест браузера, в standalone-PWA его нет). Делаем свой и вешаем на все экраны с
   кнопкой «Назад»: жест просто «нажимает» её, переиспользуя всю логику возврата.
   ========================================================================== */
(function setupEdgeSwipeBack() {
  const BACK = {
    "screen-workout":         "workout-back-btn",
    "screen-run":             "run-back-btn",
    "screen-exercises":       "exercises-back-btn",
    "screen-history":         "history-back-btn",
    "screen-stats":           "stats-back-btn",
    "screen-stat-chart":      "stat-chart-back-btn",
    "screen-templates":       "templates-back-btn",
    "screen-detail":          "detail-back-btn",
    "screen-exercise-detail": "exd-back-btn",
  };
  const EDGE = 26;          // зона старта у левого края, px
  const THRESHOLD = 0.32;   // доля ширины для срабатывания
  let screen = null, backId = null, startX = 0, startY = 0, dx = 0, active = false, decided = false, horiz = false;

  function activeScreen() {
    for (const id in BACK) {
      const el = document.getElementById(id);
      if (el && el.classList.contains("active")) return el;
    }
    return null;
  }
  function blocked() {
    if (typeof _exEdit !== "undefined" && _exEdit) return true;   // идёт перестановка
    if (typeof _tplDrag !== "undefined" && _tplDrag) return true; // тащим упражнение в шаблоне
    return !!document.querySelector(".modal-backdrop.open, .picker-backdrop.open, .bottom-sheet-backdrop.open, .stats-picker-backdrop.open, .settings-modal-backdrop.open");
  }
  function down(x, y) {
    active = false; decided = false; horiz = false; dx = 0; screen = null;
    if (x > EDGE || blocked()) return;
    const el = activeScreen();
    if (!el) return;
    screen = el; backId = BACK[el.id]; startX = x; startY = y; active = true;
  }
  function moveTo(x, y, e) {
    if (!active) return;
    const mx = x - startX, my = y - startY;
    if (!decided) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      decided = true;
      horiz = mx > Math.abs(my);          // вправо и преимущественно горизонтально
      if (!horiz) { active = false; return; }
      screen.style.transition = "none";
      screen.style.willChange = "transform";
    }
    dx = Math.max(0, mx);
    if (e && e.cancelable) e.preventDefault();
    screen.style.transform = `translateX(${dx}px)`;
  }
  function up() {
    if (!active) return;
    active = false;
    if (!horiz || !screen) { snapBack(); return; }
    const w = window.innerWidth || 400;
    if (dx > w * THRESHOLD) {
      const el = screen, id = backId; screen = null;
      el.style.transition = "transform 0.18s ease, opacity 0.18s ease";
      el.style.transform = `translateX(${w}px)`;
      el.style.opacity = "0";
      setTimeout(() => {
        const btn = document.getElementById(id); if (btn) btn.click();  // вернуться
        requestAnimationFrame(() => { el.style.transition = ""; el.style.transform = ""; el.style.opacity = ""; el.style.willChange = ""; });
      }, 180);
    } else {
      snapBack();
    }
  }
  function snapBack() {
    if (!screen) return;
    const el = screen; screen = null;
    el.style.transition = "transform 0.2s ease";
    el.style.transform = "";
    el.style.willChange = "";
    setTimeout(() => { el.style.transition = ""; }, 220);
  }

  // touchmove/end вешаем только после старта у края — чтобы не делать
  // document-touchmove не-passive на каждый скролл.
  const onMove = (e) => { const t = e.touches[0]; if (t) moveTo(t.clientX, t.clientY, e); };
  const onEnd  = () => { up(); document.removeEventListener("touchmove", onMove); document.removeEventListener("touchend", onEnd); document.removeEventListener("touchcancel", onEnd); };
  document.addEventListener("touchstart", (e) => {
    const t = e.touches[0]; down(t.clientX, t.clientY);
    if (active) {
      document.addEventListener("touchmove", onMove, { passive: false });
      document.addEventListener("touchend", onEnd, { passive: true });
      document.addEventListener("touchcancel", onEnd, { passive: true });
    }
  }, { passive: true });

  // mouse — для проверки на десктопе
  const onMM = (e) => moveTo(e.clientX, e.clientY, e);
  const onMU = () => { up(); window.removeEventListener("mousemove", onMM); window.removeEventListener("mouseup", onMU); };
  document.addEventListener("mousedown", (e) => {
    down(e.clientX, e.clientY);
    if (active) { window.addEventListener("mousemove", onMM); window.addEventListener("mouseup", onMU); }
  });
})();

/* ==========================================================================
   Init
   ========================================================================== */
function init() {
  SyncQueue.flush();
  updateOnlineStatus();
  const userId = DATA.getCurrentUser();
  if (userId) {
    // Скелетон показываем только когда реально есть что тянуть (онлайн + sync).
    _menuHydrating = Storage.isEnabled() && navigator.onLine;
    goToScreen("menu");
    onProfileEnter(userId);
    Sync.hydrateUser(userId).then(() => {
      _menuHydrating = false;
      if (screenMenu.classList.contains("active")) refreshMenu();
    });
  } else {
    goToScreen("profile");
  }
}
init();

// Пробуем заблокировать портретную ориентацию через API (работает на Android PWA/Chrome).
// На iOS не поддерживается — там фолбэк: CSS-оверлей #landscape-block.
if (screen.orientation && typeof screen.orientation.lock === "function") {
  screen.orientation.lock("portrait").catch(() => {});
}
