"use strict";

function escHtml(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

Storage.configure({
  enabled:   CONFIG.ENABLED,
  accessKey: CONFIG.ACCESS_KEY,
  // Мастер-ключ НЕ подставляем из ACCESS_KEY: иначе ограниченный Access Key,
  // положенный в ACCESS_KEY, молча трактовался бы как мастер-ключ (X-Master-Key),
  // и сценарий «в деплой кладём только ограниченный ключ» не заработал бы. Если
  // MASTER_KEY пуст, storage.js шлёт X-Access-Key (см. authHeaders/createAuthHeaders).
  masterKey: CONFIG.MASTER_KEY || "",
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
      return true;
    },
    deleteCategory(userId, name) {
      const list = this.getAllCategories(userId).filter(c => c !== name);
      this.saveAllCategories(userId, list);
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
    addExercise(userId, { name, cat, type, emoji }) {
      const list = this.getOwnExercises(userId);
      const ex = {
        id: `e_own_${userId}_${Date.now()}`,
        name: name.trim(),
        cat: cat || "Другое",
        type: type === "run" ? "run" : "strength",
        owner: userId,
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
      this.saveOwnExercises(userId, list);
      return ex;
    },

    // Удаление: только своё личное. Общее упражнение нельзя удалить — только скрыть у себя (раздел 3, 4).
    deleteOwnExercise(userId, exerciseId) {
      const list = this.getOwnExercises(userId);
      this.saveOwnExercises(userId, list.filter(e => e.id !== exerciseId));
    },

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
    getWorkoutHistory(userId) { return ls(`train_history_${userId}`, []); },
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
        ex.sets.filter(s => s.done && s.weight > 0 && s.reps > 0).forEach(s => {
          if (!recs[ex.exerciseId]) recs[ex.exerciseId] = { maxWeight: 0, repsAtMaxWeight: 0, maxReps: 0, weightAtMaxReps: 0 };
          const r = recs[ex.exerciseId];
          if (s.weight > r.maxWeight || (s.weight === r.maxWeight && s.reps > r.repsAtMaxWeight)) {
            r.maxWeight = s.weight; r.repsAtMaxWeight = s.reps;
          }
          if (s.reps > r.maxReps || (s.reps === r.maxReps && s.weight > r.weightAtMaxReps)) {
            r.maxReps = s.reps; r.weightAtMaxReps = s.weight;
          }
        });
      });
      lsSet(`train_records_${userId}`, recs);
    },
    getExerciseRecord(userId, exerciseId) {
      return (ls(`train_records_${userId}`, {}))[exerciseId] || null;
    },

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
      const workout = {
        id: `w_${Date.now()}`,
        type: "strength",
        name: tpl.name,
        startedAt: Date.now(),
        exercises: tpl.exercises.map(ex => ({
          exerciseId: ex.exerciseId,
          sets: ex.sets.length
            ? ex.sets.map(s => ({ weight: s.weight, reps: s.reps, rpe: 0, done: false }))
            : [{ weight: 0, reps: 0, rpe: 0, done: false }],
        })),
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

const rpeBackdrop = $("rpe-backdrop");
const rpeGrid     = $("rpe-grid");
const rpeHint     = $("rpe-hint");

const toastEl = $("toast");

/* ==========================================================================
   Toast
   ========================================================================== */
let toastTimer = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
}
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

function pluralChanges(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "изменение";
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "изменения";
  return "изменений";
}

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
      ? `Нет сети — ${pending} ${pluralChanges(pending)} ждут синхронизации`
      : "Нет сети — данные сохраняются локально";
  } else if (syncError) {
    statusText.textContent = `Ошибка синхронизации: ${syncError}`;
  } else if (pending > 0) {
    statusText.textContent = "Синхронизация…";
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
const SCREENS = { profile: screenProfile, menu: screenMenu, workout: screenWorkout, run: screenRun, exercises: screenExercises, history: $("screen-history"), detail: $("screen-detail"), stats: $("screen-stats"), statChart: $("screen-stat-chart"), templates: $("screen-templates"), templateDetail: $("screen-template-detail") };

function goToScreen(name, opts = {}) {
  Object.values(SCREENS).forEach(s => s.classList.remove("active"));
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
      goToScreen("menu");
      // Гидратация в фоне — переход на главный экран не ждёт сеть (раздел 8:
      // local-first). Если что-то подтянулось, тихо обновляем уже открытое меню.
      Sync.hydrateUser(user.id).then(() => {
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

const HISTORY_SVG_STRENGTH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="9.5" width="3" height="5" rx="1"/><rect x="19" y="9.5" width="3" height="5" rx="1"/><rect x="6" y="7.5" width="2.6" height="9" rx="1"/><rect x="15.4" y="7.5" width="2.6" height="9" rx="1"/><line x1="8.6" y1="12" x2="15.4" y2="12"/></svg>`;
const HISTORY_SVG_RUN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="14.5" cy="5.5" r="1.6"/><path d="M9.5 8.5l2.5 1.5 1 3.5-3 2.5M14.5 7l2.5 4.5-3 1.5"/><path d="M6 20l2.5-4"/></svg>`;

// Разметка одной карточки тренировки — общая для превью-шторки и экрана «История».
function historyItemHtml(w) {
  const isRun = w.type === "run";
  const meta = isRun
    ? [w.distance ? `${w.distance} км` : null, w.pace ? `${w.pace} мин/км` : null].filter(Boolean).join(" · ")
    : (() => {
        const sets = (w.exercises || []).reduce((n, ex) => n + ex.sets.filter(s => s.done).length, 0);
        const vol  = (w.exercises || []).reduce((v, ex) => v + ex.sets.filter(s => s.done).reduce((sv, s) => sv + (s.weight || 0) * (s.reps || 0), 0), 0);
        return [sets ? `${sets} подх` : null, vol ? `${vol} кг` : null].filter(Boolean).join(" · ");
      })();
  const duration = w.durationSec ? formatDuration(w.durationSec) : "";

  return `
    <div class="history-item" data-id="${w.id}">
      <span class="history-item-icon${isRun ? " run" : ""}">${isRun ? HISTORY_SVG_RUN : HISTORY_SVG_STRENGTH}</span>
      <span class="history-item-body">
        <span class="history-item-label">${escHtml(w.name || (isRun ? "Пробежка" : "Силовая"))}</span>
        <span class="history-item-meta">${meta || "—"}</span>
      </span>
      <span class="history-item-right">
        <span class="history-item-date">${fmtDate(w.startedAt)}</span>
        ${duration ? `<span class="history-item-dur">${duration}</span>` : ""}
      </span>
    </div>`;
}

// Сколько последних тренировок показываем в шторке-превью. Остальные — на
// отдельном экране «История» по кнопке «Вся история».
const HISTORY_PREVIEW_LIMIT = 5;

function renderHistory(userId) {
  const history = DATA.getWorkoutHistory(userId);
  historyCount.textContent = history.length;

  if (!history.length) {
    historyBody.innerHTML = `<p class="empty-state">Тренировок пока нет — начни первую, и она появится здесь.</p>`;
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

function renderHistoryScreen() {
  const userId = DATA.getCurrentUser();
  const all = DATA.getWorkoutHistory(userId);

  // Тип-фильтр: счётчики считаем в пределах выбранного периода.
  const inPeriod = all.filter(w => historyPeriodMatch(w, _historyPeriod));
  const filters = [["all", "Все"], ["strength", "Силовые"], ["run", "Пробежки"]];
  const tabsEl = $("history-filter-tabs");
  tabsEl.innerHTML = filters.map(([key, label]) => {
    const count = inPeriod.filter(w => historyTypeMatch(w, key)).length;
    return `<button class="ex-cat-tab${_historyFilter === key ? " active" : ""}" data-filter="${key}">${label} ${count}</button>`;
  }).join("");
  tabsEl.querySelectorAll(".ex-cat-tab").forEach(btn => {
    btn.addEventListener("click", () => { _historyFilter = btn.dataset.filter; renderHistoryScreen(); });
  });

  // Период-фильтр.
  const periodEl = $("history-period-tabs");
  periodEl.innerHTML = HISTORY_PERIODS.map(([key, label]) =>
    `<button class="ex-cat-tab${_historyPeriod === key ? " active" : ""}" data-period="${key}">${label}</button>`
  ).join("");
  periodEl.querySelectorAll(".ex-cat-tab").forEach(btn => {
    btn.addEventListener("click", () => { _historyPeriod = btn.dataset.period; renderHistoryScreen(); });
  });

  const list = all.filter(w => historyTypeMatch(w, _historyFilter) && historyPeriodMatch(w, _historyPeriod));

  const listEl = $("history-screen-list");
  if (!list.length) {
    listEl.innerHTML = `<p class="empty-state" style="padding:24px 6px">Тренировок по выбранным фильтрам нет.</p>`;
    return;
  }
  listEl.innerHTML = list.map(historyItemHtml).join("");
  listEl.querySelectorAll(".history-item").forEach(el => {
    el.addEventListener("click", () => {
      const w = all.find(x => x.id === el.dataset.id);
      if (w) openDetailScreen(w, "history");
    });
  });
}

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
    if (action === "settings")  { openModal(settingsModalBackdrop); return; }
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
$("refresh-data-btn").addEventListener("click", () => {
  const userId = DATA.getCurrentUser();
  closeModal(settingsModalBackdrop);
  showToast("Синхронизируем данные…");
  SyncQueue.flush();
  Promise.resolve(userId ? SyncQueue.hydrateUser(userId) : null)
    .then(() => {
      if (screenMenu.classList.contains("active")) refreshMenu();
      updateOnlineStatus();
      showToast(SyncQueue.lastError() ? "Синхронизация не удалась" : "Данные обновлены");
    });
  if ("serviceWorker" in navigator) navigator.serviceWorker.getRegistrations().then(r => r.forEach(x => x.update()));
});
$("switch-user-btn").addEventListener("click", () => {
  closeModal(settingsModalBackdrop);
  DATA.clearCurrentUser();
  goToScreen("profile");
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
  saveWorkoutState();
  stopWorkoutTimer(); // секундомер на кнопке меню сам покажет время активной тренировки
  goToScreen("menu");
});
$("workout-name-input").addEventListener("input", () => saveWorkoutState());

$("finish-workout-btn").addEventListener("click", finishWorkout);

function finishWorkout() {
  if (!_workout) return;
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
  DATA.clearActiveWorkout(userId);
  stopWorkoutTimer();
  _workout = null;
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

function renderExerciseList() {
  const scroll = $("workout-scroll");
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
    const exDef = visible.find(e => e.id === ex.exerciseId) || { name: ex.exerciseId };
    const rec = DATA.getExerciseRecord(userId, ex.exerciseId);
    const lastWorkout = findLast(ex.exerciseId);
    const lastExData  = lastWorkout ? lastWorkout.exercises.find(e => e.exerciseId === ex.exerciseId) : null;
    const lastSets    = lastExData  ? lastExData.sets.filter(s => s.done && (s.weight || s.reps)) : [];

    // PR строка — только рекорд веса (рекорд повторов убран, п.11)
    let prHtml = "";
    if (rec && rec.maxWeight > 0) {
      const b1 = `${rec.maxWeight} кг × ${rec.repsAtMaxWeight}`;
      prHtml = `<div class="ex-block-pr">
        <span class="ex-block-pr-badge">${b1}</span>
      </div>`;
    }

    // Прошлая тренировка
    let prevHtml = "";
    if (lastSets.length) {
      const setsStr = lastSets.map(s => `<span class="ex-block-prev-set">${s.weight} × ${s.reps}</span>`).join("");
      prevHtml = `<div class="ex-block-prev">
        <div class="ex-block-prev-label">Прошлый раз · ${fmtDate(lastWorkout.startedAt)}</div>
        <div class="ex-block-prev-sets">${setsStr}</div>
      </div>`;
    }

    const block = document.createElement("div");
    block.className = "ex-block";

    const canUp   = idx > 0;
    const canDown = idx < _workout.exercises.length - 1;

    block.innerHTML = `
      <div class="ex-block-header">
        <span class="ex-block-name" title="${escHtml(exDef.name)}">${escHtml(exDef.name)}</span>
        <div class="ex-reorder">
          <button class="ex-reorder-btn" data-dir="up" ${canUp ? "" : "disabled"} title="Переместить вверх">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>
          </button>
          <button class="ex-reorder-btn" data-dir="down" ${canDown ? "" : "disabled"} title="Переместить вниз">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
          </button>
        </div>
        <button class="ex-remove-btn" title="Удалить упражнение">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      ${prHtml}
      ${prevHtml}
      <div class="sets-table">
        <div class="sets-header"><span>#</span><span>Вес</span><span>Повт</span><span>RPE</span><span></span></div>
        <div class="sets-body"></div>
      </div>
      <textarea class="set-note-input" placeholder="Заметка к тренировке…" rows="2">${ex.note || ""}</textarea>
      <div class="sets-actions">
        <button class="btn-chip add-set-btn" style="flex:1">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Подход
        </button>
        <button class="set-note-btn ${ex.note ? "has-note" : ""}" title="Заметка">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L13 14l-4 1 1-4 6.5-6.5z"/></svg>
        </button>
      </div>
    `;

    // Render sets
    renderSetsInBlock(block, ex, lastWorkout);

    // Reorder — переставляем один узел на месте, без полного ре-рендера.
    // Индекс берём живым (indexOf по ссылке на ex), т.к. захваченный idx
    // устаревает после первой же перестановки.
    block.querySelectorAll(".ex-reorder-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const arr = _workout.exercises;
        const i = arr.indexOf(ex);
        const dir = btn.dataset.dir === "up" ? -1 : 1;
        const j = i + dir;
        if (i < 0 || j < 0 || j >= arr.length) return;
        [arr[i], arr[j]] = [arr[j], arr[i]];
        if (dir === -1) block.parentNode.insertBefore(block, block.previousElementSibling);
        else            block.parentNode.insertBefore(block.nextElementSibling, block);
        saveWorkoutState();
        refreshReorderButtons();
        updateSummaryBar();
      });
    });

    // Remove — удаляем один узел, без перетряхивания всего списка.
    block.querySelector(".ex-remove-btn").addEventListener("click", () => {
      const i = _workout.exercises.indexOf(ex);
      if (i !== -1) _workout.exercises.splice(i, 1);
      block.remove();
      saveWorkoutState();
      refreshReorderButtons();
      updateSummaryBar();
    });

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
      const visible = noteInput.classList.toggle("visible");
      if (visible) { noteInput.focus(); }
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
    const row = document.createElement("div");
    row.className = "set-row";
    row.innerHTML = `
      <span class="set-num">${sIdx + 1}</span>
      <div class="set-field"><input type="number" inputmode="decimal" placeholder="${prev ? prev.weight : "кг"}" value="${set.weight || ""}" step="0.5" ${prev ? 'class="has-prev"' : ""}></div>
      <div class="set-field"><input type="number" inputmode="numeric" placeholder="${prev ? prev.reps : "повт"}" value="${set.reps || ""}" ${prev ? 'class="has-prev"' : ""}></div>
      <button class="rpe-btn ${set.rpe ? "has-rpe" : ""}">${set.rpe || "—"}</button>
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
      saveWorkoutState();
      renderSetsInBlock(block, ex, lastWorkout);
      updateSummaryBar();
    });

    tbody.appendChild(row);
  });
}

function updateSummaryBar() {
  const exs = (_workout && _workout.exercises) || [];
  const doneSets = exs.reduce((n, ex) => n + ex.sets.filter(s => s.done).length, 0);
  const volume   = exs.reduce((v, ex) => v + ex.sets.filter(s => s.done).reduce((sv, s) => sv + (s.weight || 0) * (s.reps || 0), 0), 0);
  $("sum-exercises").textContent = exs.length;
  $("sum-sets").textContent = doneSets;
  $("sum-volume").textContent = volume;
}

/* — Добавить упражнение — */
[$("add-ex-btn"), $("add-ex-header-btn")].forEach(btn => {
  btn.addEventListener("click", () => openExercisePicker(addExerciseToWorkout));
});

let _pickerOnSelect = addExerciseToWorkout;

function openExercisePicker(onSelect) {
  _pickerOnSelect = onSelect || addExerciseToWorkout;
  pickerSearch.value = "";
  renderPickerList("");
  pickerBackdrop.classList.add("open");
  setTimeout(() => pickerSearch.focus(), 300);
}
function closeExercisePicker() { pickerBackdrop.classList.remove("open"); }
pickerBackdrop.addEventListener("click", e => { if (e.target === pickerBackdrop) closeExercisePicker(); });
pickerSearch.addEventListener("input", () => renderPickerList(pickerSearch.value));

function renderPickerList(query) {
  const q = query.trim().toLowerCase();
  const all = DATA.getVisibleExercises(DATA.getCurrentUser());
  const filtered = q ? all.filter(e => e.name.toLowerCase().includes(q) || e.cat.toLowerCase().includes(q)) : all;

  // Group by category
  const groups = {};
  filtered.forEach(e => { if (!groups[e.cat]) groups[e.cat] = []; groups[e.cat].push(e); });

  if (!filtered.length) {
    pickerList.innerHTML = `<p style="padding:24px 16px;color:var(--text-tertiary);font-size:14px">Ничего не найдено</p>`;
    return;
  }

  pickerList.innerHTML = Object.entries(groups).map(([cat, exs]) => `
    <div class="picker-section-label">${escHtml(cat)}</div>
    ${exs.map(e => `
      <div class="picker-item" data-id="${escHtml(e.id)}">
        <div><div class="picker-item-name">${escHtml(e.name)}</div></div>
      </div>
    `).join("")}
  `).join("");

  pickerList.querySelectorAll(".picker-item").forEach(item => {
    item.addEventListener("click", () => {
      _pickerOnSelect(item.dataset.id);
      closeExercisePicker();
    });
  });
}

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
  _workout.exercises.push({ exerciseId, sets });
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

function initRunScreen({ resume = false } = {}) {
  const userId = DATA.getCurrentUser();
  _run = DATA.getActiveWorkout(userId);

  // Clear fields
  ["run-duration", "run-distance", "run-cadence", "run-hr"].forEach(id => { $(id).value = ""; });
  $("run-pace").textContent = "—";

  if (resume && _run) {
    if (_run.distance)  $("run-distance").value = _run.distance;
    if (_run.duration)  $("run-duration").value = _run.duration;
    if (_run.cadence)   $("run-cadence").value  = _run.cadence;
    if (_run.heartRate) $("run-hr").value        = _run.heartRate;
    updatePace();
  }
}

function updatePace() {
  const distVal = parseFloat($("run-distance").value);
  const timeStr = $("run-duration").value.trim();
  if (!distVal || !timeStr) { $("run-pace").textContent = "—"; return; }

  // parse h:mm:ss or mm:ss
  const parts = timeStr.split(":").map(Number);
  let totalSec = 0;
  if (parts.length === 3)      totalSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) totalSec = parts[0] * 60 + parts[1];
  else                         totalSec = parts[0];

  if (!totalSec || !distVal) { $("run-pace").textContent = "—"; return; }

  const paceSec = totalSec / distVal;
  const m = Math.floor(paceSec / 60);
  const s = Math.round(paceSec % 60);
  $("run-pace").textContent = `${m}:${String(s).padStart(2, "0")}`;
}

["run-duration", "run-distance"].forEach(id => $(id).addEventListener("input", updatePace));

$("run-back-btn").addEventListener("click", () => {
  saveRunState();
  goToScreen("menu");
});

function saveRunState() {
  if (!_run) return;
  _run.distance  = parseFloat($("run-distance").value) || null;
  _run.duration  = $("run-duration").value || null;
  _run.cadence   = parseInt($("run-cadence").value) || null;
  _run.heartRate = parseInt($("run-hr").value) || null;
  _run.pace      = $("run-pace").textContent !== "—" ? $("run-pace").textContent : null;
  carryRemoteBinId(_run, DATA.getCurrentUser());
  DATA.saveActiveWorkout(DATA.getCurrentUser(), _run);
  SyncQueue.push("run:update", { workoutId: _run.id });
}

$("run-save-btn").addEventListener("click", () => {
  const dist = parseFloat($("run-distance").value);
  const dur  = $("run-duration").value.trim();
  if (!dist || !dur) { showToast("Заполни время и дистанцию"); return; }

  saveRunState();
  const userId = DATA.getCurrentUser();
  _run.finishedAt = Date.now();
  _run.durationSec = parseDurationToSec(dur);

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
let _exercisesEditMode = false; // режим редактирования списка: показывать кнопки действий (п.9)

function setExercisesEditMode(on) {
  _exercisesEditMode = !!on;
  exercisesScroll.classList.toggle("editing", _exercisesEditMode);
  const btn = $("exercises-edit-btn");
  if (btn) {
    btn.classList.toggle("active", _exercisesEditMode);
    btn.title = _exercisesEditMode ? "Готово" : "Редактировать список";
  }
}

function initExercisesScreen() {
  exercisesSearch.value = "";
  _exercisesCatFilter = "all";
  _exercisesShowHidden = false;
  setExercisesEditMode(false); // каждый заход — чистый список без кнопок
  const userId = DATA.getCurrentUser();
  if (DATA.ensureExercisesSeeded(userId)) SyncQueue.push("exercise:create", {});
  renderExercisesList("");
}

$("exercises-back-btn").addEventListener("click", () => goToScreen("menu"));
exercisesSearch.addEventListener("input", () => renderExercisesList(exercisesSearch.value));
$("ex-cat-manage-btn").addEventListener("click", () => openCategoryManager());
$("exercises-edit-btn").addEventListener("click", () => setExercisesEditMode(!_exercisesEditMode));

function renderCatTabs(userId, presentCats) {
  const tabsEl = $("ex-cat-tabs");
  // Показываем встроенные + кастомные категории пользователя, а также любые
  // cat-значения, реально встречающиеся в видимом списке (на случай старых
  // данных с произвольной строкой категории).
  const cats = Array.from(new Set([...DATA.getAllCategories(userId), ...presentCats]));
  const tabs = ["all", ...cats];
  tabsEl.innerHTML = tabs.map(c => `
    <button class="ex-cat-tab ${_exercisesCatFilter === c ? "active" : ""}" data-cat="${escHtml(c)}">${c === "all" ? "Все" : escHtml(c)}</button>
  `).join("");
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
  const otherUser = DATA.USERS.find(u => u.id !== userId);

  renderCatTabs(userId, Array.from(new Set(allExs.map(e => e.cat))));

  const filtered = allExs.filter(e =>
    (!q || e.name.toLowerCase().includes(q) || e.cat.toLowerCase().includes(q))
    && (_exercisesCatFilter === "all" || e.cat === _exercisesCatFilter)
  );

  if (!filtered.length) {
    exercisesScroll.innerHTML = `<p class="empty-state">Ничего не найдено</p>`;
    return;
  }

  const SVG_EDIT  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
  const SVG_DEL   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  const SVG_SHARE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`;

  exercisesScroll.innerHTML = filtered.map(ex => `
    <div class="ex-row" data-id="${escHtml(ex.id)}">
      <span class="ex-row-body">
        <span class="ex-row-name">${escHtml(ex.name)}</span>
        <span class="ex-row-meta"><span>${escHtml(ex.cat)}</span></span>
      </span>
      <span class="ex-row-actions">
        ${otherUser ? `<button class="ex-row-action-btn" data-act="share" title="Поделиться с ${escHtml(otherUser.name)}">${SVG_SHARE}</button>` : ""}
        <button class="ex-row-action-btn" data-act="edit" title="Редактировать">${SVG_EDIT}</button>
        <button class="ex-row-action-btn danger" data-act="delete" title="Удалить">${SVG_DEL}</button>
      </span>
    </div>`).join("");

  exercisesScroll.querySelectorAll(".ex-row").forEach(row => {
    const id = row.dataset.id;
    row.querySelectorAll(".ex-row-action-btn").forEach(b => {
      if (b.dataset.act === "edit") {
        b.addEventListener("click", () => openExerciseForm(id));
      }
      if (b.dataset.act === "delete") {
        b.addEventListener("click", () => {
          const ex = allExs.find(e => e.id === id);
          openConfirmModal({
            title: "Удалить упражнение?",
            message: `Вы точно хотите удалить это упражнение${ex ? ` — «${ex.name}»` : ""}? Отменить нельзя.`,
            confirmLabel: "Удалить",
            onConfirm: () => {
              DATA.deleteOwnExercise(userId, id);
              SyncQueue.push("exercise:delete", { id });
              showToast("Упражнение удалено");
              renderExercisesList(exercisesSearch.value);
            },
          });
        });
      }
      if (b.dataset.act === "share" && otherUser) {
        b.addEventListener("click", async () => {
          b.disabled = true;
          const result = await SyncQueue.shareExercise(id, userId, otherUser.id);
          b.disabled = false;
          if (result === "shared")    showToast(`Упражнение передано ${otherUser.name}`);
          if (result === "duplicate") showToast(`У ${otherUser.name} уже есть такое упражнение`);
          if (result === "not_found") showToast("Упражнение не найдено");
        });
      }
    });
  });
}

/* — Управление категориями: все категории редактируются и удаляются (п.5) — */
function openCategoryManager() {
  const userId = DATA.getCurrentUser();
  const existing = $("cat-manager-backdrop");
  if (existing) existing.remove();

  const backdrop = document.createElement("div");
  backdrop.id = "cat-manager-backdrop";
  backdrop.className = "modal-backdrop open";

  function render() {
    const cats = DATA.getAllCategories(userId);
    backdrop.innerHTML = `
      <div class="modal modal-form">
        <h2 class="modal-title">Категории</h2>
        ${cats.length ? cats.map(c => `
          <div style="display:flex;gap:8px;align-items:center;">
            <input class="ex-form-input cat-rename-input" data-old="${escHtml(c)}" value="${escHtml(c)}" style="flex:1;">
            <button class="ex-row-action-btn danger cat-delete-btn" data-cat="${escHtml(c)}" title="Удалить">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        `).join("") : `<p style="font-size:13px;color:var(--text-tertiary);">Категорий пока нет — добавь первую.</p>`}
        <div style="display:flex;gap:8px;align-items:center;">
          <input class="ex-form-input" id="cat-new-input" placeholder="Новая категория" style="flex:1;">
          <button class="ex-row-action-btn" id="cat-add-btn" title="Добавить">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
        </div>
        <div class="modal-form-actions">
          <button class="btn-chip primary" id="cat-manager-close" style="flex:1;">Готово</button>
        </div>
      </div>
    `;

    backdrop.querySelectorAll(".cat-rename-input").forEach(inp => {
      inp.addEventListener("change", () => {
        const old = inp.dataset.old;
        const next = inp.value.trim();
        if (next && next !== old) {
          DATA.renameCategory(userId, old, next);
          renderExercisesList(exercisesSearch.value);
        }
        render();
      });
    });
    backdrop.querySelectorAll(".cat-delete-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const cat = btn.dataset.cat;
        openConfirmModal({
          title: "Удалить категорию?",
          message: `Категория «${cat}» будет удалена. Упражнения из неё перейдут в «Другое».`,
          confirmLabel: "Удалить",
          onConfirm: () => {
            DATA.deleteCategory(userId, cat);
            renderExercisesList(exercisesSearch.value);
            render();
          },
        });
      });
    });
    $("cat-add-btn").addEventListener("click", () => {
      const inp = $("cat-new-input");
      const v = inp.value.trim();
      if (!v) return;
      DATA.addCategory(userId, v);
      renderExercisesList(exercisesSearch.value);
      render();
    });
    $("cat-manager-close").addEventListener("click", () => backdrop.remove());
    backdrop.addEventListener("click", e => { if (e.target === backdrop) backdrop.remove(); });
  }

  document.body.appendChild(backdrop);
  render();
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
  } else {
    exerciseFormTitle.textContent = "Новое упражнение";
    exerciseFormName.value = "";
    exerciseFormTypeGroup.querySelectorAll(".ex-form-chip").forEach(c => c.classList.toggle("selected", c.dataset.type === "strength"));
    buildCategoryChips("Ноги");
  }

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

  if (_editingExerciseId) {
    DATA.updateOwnExercise(userId, _editingExerciseId, { name, type, cat });
    SyncQueue.push("exercise:update", { id: _editingExerciseId });
    showToast("Упражнение обновлено");
  } else {
    DATA.addExercise(userId, { name, type, cat });
    SyncQueue.push("exercise:create", { name });
    showToast("Упражнение добавлено");
  }

  closeModal(exerciseFormBackdrop);
  renderExercisesList(exercisesSearch.value);
});

/* ==========================================================================
   Screen: detail view (просмотр тренировки из истории)
   ========================================================================== */
let _detailReturnScreen = "menu";
function openDetailScreen(workout, returnScreen = "menu") {
  _detailReturnScreen = returnScreen;
  const isRun = workout.type === "run";

  const iconEl = $("detail-screen-icon");
  iconEl.className = "detail-screen-icon" + (isRun ? " run" : "");
  iconEl.innerHTML = isRun
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="14.5" cy="5.5" r="1.6"/><path d="M9.5 8.5l2.5 1.5 1 3.5-3 2.5M14.5 7l2.5 4.5-3 1.5"/><path d="M6 20l2.5-4"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="9.5" width="3" height="5" rx="1"/><rect x="19" y="9.5" width="3" height="5" rx="1"/><rect x="6" y="7.5" width="2.6" height="9" rx="1"/><rect x="15.4" y="7.5" width="2.6" height="9" rx="1"/><line x1="8.6" y1="12" x2="15.4" y2="12"/></svg>`;

  $("detail-screen-title").textContent = workout.name || (isRun ? "Пробежка" : "Силовая");
  $("detail-screen-meta").textContent = `${fmtDate(workout.startedAt)}${workout.durationSec ? "  ·  " + formatDuration(workout.durationSec) : ""}`;

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
    const exercises = DATA.getVisibleExercises(DATA.getCurrentUser());
    const totalSets = (workout.exercises || []).reduce((n, ex) => n + ex.sets.filter(s => s.done).length, 0);
    const volume    = (workout.exercises || []).reduce((v, ex) => v + ex.sets.filter(s => s.done).reduce((sv, s) => sv + (s.weight || 0) * (s.reps || 0), 0), 0);

    body.innerHTML = `
      <div class="detail-stats">
        <div class="detail-stat"><div class="detail-stat-num">${(workout.exercises || []).length}</div><div class="detail-stat-label">Упражнений</div></div>
        <div class="detail-stat"><div class="detail-stat-num">${totalSets}</div><div class="detail-stat-label">Подходов</div></div>
        <div class="detail-stat"><div class="detail-stat-num">${volume}</div><div class="detail-stat-label">Кг объём</div></div>
        ${workout.durationSec ? `<div class="detail-stat"><div class="detail-stat-num">${formatDuration(workout.durationSec)}</div><div class="detail-stat-label">Длительность</div></div>` : ""}
      </div>
      ${(workout.exercises || []).map(ex => {
        const exDef = exercises.find(e => e.id === ex.exerciseId) || { name: ex.exerciseId };
        const doneSets = ex.sets.filter(s => s.done);
        return `<div class="detail-ex">
          <div class="detail-ex-name">${escHtml(exDef.name)}</div>
          ${doneSets.map((s, i) => `
            <div class="detail-set-row">
              <span class="detail-set-num">${i + 1}</span>
              <span class="detail-set-val">${s.weight} кг × ${s.reps} повт</span>
              ${s.rpe ? `<span class="detail-set-rpe">RPE ${s.rpe}</span>` : ""}
            </div>`).join("")}
          ${!doneSets.length ? `<div style="padding:8px 14px;color:var(--text-tertiary);font-size:13px">Нет выполненных подходов</div>` : ""}
        </div>`;
      }).join("")}
      <button class="btn-chip btn-full" id="save-as-template-btn" style="margin-top:4px">Сохранить как шаблон</button>
    `;

    $("save-as-template-btn").addEventListener("click", () => openSaveAsTemplateModal(workout));
  }

  goToScreen("detail");

  $("detail-delete-btn").onclick = () => {
    if (!confirm("Удалить эту тренировку? Отменить нельзя.")) return;
    const userId = DATA.getCurrentUser();
    DATA.deleteWorkout(userId, workout.id);
    SyncQueue.push("workout:delete", {});
    renderHistory(userId);
    goToScreen("menu");
    showToast("Тренировка удалена");
  };

  $("detail-edit-btn").onclick = () => openDetailEditMode(workout);
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
      const exRows = (draft.exercises || []).map((ex, exIdx) => {
        const def = exDefs.find(e => e.id === ex.exerciseId) || { name: ex.exerciseId };
        const doneSets = ex.sets.map((s, si) => ({ ...s, _si: si })).filter(s => s.done);
        return `<div class="detail-ex">
          <div class="detail-ex-name">${escHtml(def.name)}</div>
          ${doneSets.map((s, i) => `
            <div class="de-set-row" data-ex="${exIdx}" data-si="${s._si}" style="display:flex;align-items:center;gap:8px;padding:6px 14px">
              <span class="detail-set-num">${i + 1}</span>
              <input class="de-weight" type="number" step="0.5" value="${s.weight || 0}" style="width:56px;padding:4px 6px;border-radius:6px;border:1px solid var(--border-subtle);background:var(--panel-raised);color:var(--text-primary);font-size:13px;text-align:center">
              <span style="color:var(--text-tertiary);font-size:13px">кг ×</span>
              <input class="de-reps" type="number" value="${s.reps || 0}" style="width:44px;padding:4px 6px;border-radius:6px;border:1px solid var(--border-subtle);background:var(--panel-raised);color:var(--text-primary);font-size:13px;text-align:center">
              <span style="color:var(--text-tertiary);font-size:13px">повт</span>
              <button class="ex-row-action-btn danger de-del-set" data-ex="${exIdx}" data-si="${s._si}" title="Удалить подход" style="margin-left:auto;flex:none">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>`).join("")}
          ${!doneSets.length ? `<div style="padding:6px 14px;color:var(--text-tertiary);font-size:13px">Нет выполненных подходов</div>` : ""}
        </div>`;
      }).join("");

      body.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:4px;padding-bottom:80px">
          <div style="margin-bottom:8px">
            <input class="ex-form-input" id="de-name" value="${escHtml(draft.name || "")}" placeholder="Название тренировки">
          </div>
          ${exRows}
          <div style="display:flex;gap:8px;margin-top:8px">
            <button class="btn-chip" id="de-cancel" style="flex:1">Отмена</button>
            <button class="btn-chip primary" id="de-save" style="flex:1">Сохранить</button>
          </div>
        </div>`;

      body.querySelectorAll(".de-del-set").forEach(btn => {
        btn.addEventListener("click", () => {
          draft.exercises[+btn.dataset.ex].sets[+btn.dataset.si].done = false;
          renderEdit();
        });
      });

      $("de-save").addEventListener("click", () => {
        draft.name = $("de-name").value.trim() || draft.name;
        body.querySelectorAll(".de-set-row").forEach(row => {
          const exIdx = +row.dataset.ex, si = +row.dataset.si;
          draft.exercises[exIdx].sets[si].weight = parseFloat(row.querySelector(".de-weight").value) || 0;
          draft.exercises[exIdx].sets[si].reps   = parseInt(row.querySelector(".de-reps").value)   || 0;
        });
        saveEditedWorkout(draft, userId);
      });
      $("de-cancel").addEventListener("click", () => openDetailScreen(workout, _detailReturnScreen));
    }
  }

  renderEdit();
}

function saveEditedWorkout(workout, userId) {
  DATA.updateRecords(userId, workout);
  DATA.updateWorkout(userId, workout);
  SyncQueue.push("workout:edit", { workoutId: workout.id });
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
let _statsPeriod = "30d";          // "30d" | "all"
let _statsSelectedExId = null;      // ID выбранного упражнения
let _statsGraphMode = "weight";    // "weight" | "volume"

const DAY_MS = 86400000;

function statsPeriodStart() {
  return _statsPeriod === "all" ? 0 : Date.now() - 30 * DAY_MS;
}

function statsStartOfDay(ts) {
  const d = new Date(ts); d.setHours(0,0,0,0); return d.getTime();
}

// ── Серия (streak) ──
function computeStreak(workouts) {
  if (!workouts.length) return { current: 0, best: 0 };
  const daySet = new Set(workouts.map(w => statsStartOfDay(w.startedAt)));
  const days = Array.from(daySet).sort((a,b) => b - a);
  const todayStart = statsStartOfDay(Date.now());
  const yest = todayStart - DAY_MS;
  let current = 0;
  if (days[0] === todayStart || days[0] === yest) {
    for (let i = 0; i < days.length; i++) {
      if (days[i] === days[0] - i * DAY_MS) current++;
      else break;
    }
  }
  let best = 0, run = 1;
  for (let i = 1; i < days.length; i++) {
    if (days[i-1] - days[i] === DAY_MS) run++;
    else { if (run > best) best = run; run = 1; }
  }
  if (run > best) best = run;
  if (current > best) best = current;
  return { current, best };
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
  const { from, to } = statsCalendarRange(workouts);
  const dayMap = {};
  workouts.forEach(w => {
    const d = statsStartOfDay(w.startedAt);
    if (d < from || d > to) return;
    if (!dayMap[d]) dayMap[d] = { s: 0, r: 0 };
    if (w.type === "strength") dayMap[d].s++;
    else if (w.type === "run") dayMap[d].r++;
  });
  const weeks = [];
  let cur = from;
  const todayStart = statsStartOfDay(Date.now());
  while (cur <= to + 6*DAY_MS) {
    const week = [];
    for (let d = 0; d < 7; d++) week.push({ ts: cur + d*DAY_MS, ...(dayMap[cur + d*DAY_MS] || {s:0,r:0}) });
    weeks.push(week);
    cur += 7*DAY_MS;
  }
  // Метки месяцев
  let monthLabelsHtml = "";
  let lastMonth = -1;
  const monthPos = [];
  weeks.forEach((week, wi) => {
    const d = new Date(week[0].ts);
    if (d.getMonth() !== lastMonth) { monthPos.push({ wi, label: d.toLocaleString("ru-RU",{month:"short"}).replace(".","") }); lastMonth = d.getMonth(); }
  });
  const totalWeeks = weeks.length;
  let html = `<div class="s-cal-months" style="padding-left:20px;display:flex">`;
  monthPos.forEach(({wi, label}, i) => {
    const nextWi = i+1 < monthPos.length ? monthPos[i+1].wi : totalWeeks;
    const flex = nextWi - wi;
    html += `<span style="flex:${flex};font-size:9px;color:var(--text-tertiary);font-weight:600">${label}</span>`;
  });
  html += `</div><div style="display:flex;gap:3px">`;
  // Лейблы дней
  html += `<div style="display:flex;flex-direction:column;gap:2px;margin-right:3px;flex:none">`;
  ["пн","","ср","","пт","","вс"].forEach(l => {
    html += `<div style="font-size:8px;font-weight:600;color:var(--text-tertiary);height:11px;line-height:11px">${l}</div>`;
  });
  html += `</div><div style="display:flex;gap:2px;flex:1">`;
  weeks.forEach(week => {
    html += `<div style="display:flex;flex-direction:column;gap:2px;flex:1">`;
    week.forEach(day => {
      let cls = "s-cal-cell";
      if (day.ts > todayStart) { html += `<div class="${cls}" style="opacity:0"></div>`; return; }
      const total = day.s + day.r;
      let extra = "";
      if (total === 0) extra = "";
      else if (day.s > 0 && day.r > 0) {
        extra = " s-cal-both"; if (total >= 3) extra += " s-cal-hi";
      } else if (day.s > 0) {
        extra = " s-cal-strength"; if (day.s >= 2) extra += " s-cal-hi";
      } else {
        extra = " s-cal-run"; if (day.r >= 2) extra += " s-cal-hi";
      }
      html += `<div class="${cls}${extra}"></div>`;
    });
    html += `</div>`;
  });
  html += `</div></div>`;
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
  if (!_statsSelectedExId || !exWithHist.find(e=>e.id===_statsSelectedExId)) {
    _statsSelectedExId = exWithHist[0]?.id || null;
  }
  const allEx = DATA.getVisibleExercises(userId);
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

  // Прогресс за период
  const gpInPeriod = graphPoints.filter(p=>p.ts>=ps);
  let progressBadge = "";
  if (gpInPeriod.length>=2) {
    const pct = Math.round((gpInPeriod[gpInPeriod.length-1].maxWeight - gpInPeriod[0].maxWeight)/gpInPeriod[0].maxWeight*100);
    const cls = pct>0?"s-prog-up":pct<0?"s-prog-down":"s-prog-flat";
    const txt = pct>0?`+${pct}%`:pct<0?`${pct}%`:"без изменений";
    progressBadge = `<div class="s-prog-badge ${cls}">${txt} за период</div>`;
  }

  scroll.innerHTML = `
    <div class="s-period-seg">
      <button class="s-period-btn${_statsPeriod==="30d"?" active":""}" data-p="30d">30 дней</button>
      <button class="s-period-btn${_statsPeriod==="all"?" active":""}" data-p="all">Всё время</button>
    </div>

    <div class="s-section-label">Общая активность</div>
    <div class="s-cards-grid">
      <div class="s-card">
        <div class="s-card-val">${filtered.length}</div>
        <div class="s-card-label">тренировок</div>
      </div>
      <div class="s-card">
        <div class="s-card-val">🔥 ${streak.current}</div>
        <div class="s-card-label">дней серия</div>
        <div class="s-card-sub">рекорд: ${streak.best} дн</div>
      </div>
      <div class="s-card s-card-full">
        <div class="s-card-val">${durStr}</div>
        <div class="s-card-label">общее время тренировок</div>
      </div>
      <div class="s-card s-card-blue">
        <div class="s-type-label s-type-blue">Силовые</div>
        <div class="s-type-row"><span class="s-type-name">тренировок</span><span class="s-type-val">${strength.length}</span></div>
        <div class="s-type-row"><span class="s-type-name">тоннаж</span><span class="s-type-val">${volume.toLocaleString("ru-RU")} кг</span></div>
      </div>
      <div class="s-card s-card-green">
        <div class="s-type-label s-type-green">Бег</div>
        <div class="s-type-row"><span class="s-type-name">тренировок</span><span class="s-type-val">${runs.length}</span></div>
        <div class="s-type-row"><span class="s-type-name">дистанция</span><span class="s-type-val">${Math.round(totalDist*10)/10} км</span></div>
        <div class="s-type-row"><span class="s-type-name">ср. темп</span><span class="s-type-val">${paceStr(avgPaceSec)}</span></div>
        <div class="s-type-row"><span class="s-type-name">лучший темп</span><span class="s-type-val">${paceStr(bestPaceSec===Infinity?null:bestPaceSec)}</span></div>
      </div>
    </div>

    <div class="s-section-label">Активность</div>
    <div class="s-calendar">${renderStatsCalendar(workouts)}</div>

    <div class="s-section-label">Упражнение</div>
    ${_statsSelectedExId ? `
    <div class="s-ex-card">
      <div class="s-ex-header">
        <span class="s-ex-name">${escHtml(selEx?.name||_statsSelectedExId)}</span>
        <button class="s-ex-pick-btn" id="stats-ex-pick-btn">
          выбрать
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="11" height="11"><path d="M6 9l6 6 6-6"/></svg>
        </button>
      </div>
      <div class="s-ex-body">
        <div class="s-ex-recs">
          <div class="s-ex-rec" style="grid-column:1/-1">
            <div class="s-ex-rec-val">${selRec?`${selRec.maxWeight} кг × ${selRec.repsAtMaxWeight}`:"—"}</div>
            <div class="s-ex-rec-label">рекорд веса · всё время</div>
          </div>
        </div>
        <div class="s-graph-toggle">
          <button class="s-graph-btn${_statsGraphMode==="weight"?" active":""}" data-m="weight">Макс вес</button>
          <button class="s-graph-btn${_statsGraphMode==="volume"?" active":""}" data-m="volume">Тоннаж</button>
        </div>
        <div class="s-graph-wrap" id="s-graph-wrap">${renderStatsGraph(gpInPeriod, _statsGraphMode)}</div>
        ${progressBadge}
      </div>
    </div>
    ` : `<div class="s-empty">Проведи первую силовую тренировку</div>`}
  `;

  // График рисуется 1:1 в пикселях (без preserveAspectRatio="none"), поэтому
  // ему нужна реальная измеренная ширина карточки — её узнаём только после
  // вставки в DOM, и перерисовываем уже с точным числом.
  const graphWrap = $("s-graph-wrap");
  if (graphWrap) {
    const realW = Math.round(graphWrap.getBoundingClientRect().width);
    const realH = Math.round(graphWrap.getBoundingClientRect().height);
    if (realW > 0) graphWrap.innerHTML = renderStatsGraph(gpInPeriod, _statsGraphMode, realW, realH);
  }

  // Переключатель периода
  scroll.querySelectorAll(".s-period-btn").forEach(btn => {
    btn.addEventListener("click", () => { _statsPeriod = btn.dataset.p; initStatsScreen(); });
  });
  // Переключатель графика
  scroll.querySelectorAll(".s-graph-btn").forEach(btn => {
    btn.addEventListener("click", () => { _statsGraphMode = btn.dataset.m; initStatsScreen(); });
  });
  // Выбор упражнения
  const pickBtn = $("stats-ex-pick-btn");
  if (pickBtn) pickBtn.addEventListener("click", () => openStatsExPicker(exWithHist, allEx, userId));
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
  backdrop.addEventListener("click", e => { if(e.target===backdrop) { backdrop.classList.remove("open"); setTimeout(()=>backdrop.remove(),250); }});
}

$("stats-back-btn").addEventListener("click", () => goToScreen("menu"));

function openStatChartScreen(exerciseId) {
  const userId = DATA.getCurrentUser();
  const ex     = DATA.getVisibleExercises(userId).find(e => e.id === exerciseId) || { id: exerciseId, name: exerciseId };
  const rec    = DATA.getExerciseRecord(userId, exerciseId);
  const points = DATA.getExerciseProgress(userId, exerciseId);

  $("stat-chart-title").textContent = ex.name;
  $("stat-chart-meta").textContent  = `${points.length} ${pluralWorkouts(points.length)}`;

  const recordsHtml = rec ? `
    <div class="detail-stats">
      <div class="detail-stat" style="grid-column:1/-1"><div class="detail-stat-num">${rec.maxWeight} кг</div><div class="detail-stat-label">Макс. вес, × ${rec.repsAtMaxWeight}</div></div>
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
const templatesScroll  = $("templates-scroll");
const templateBlocksEl = $("template-blocks");
const nameModalBackdrop  = $("name-modal-backdrop");
const nameModalTitle     = $("name-modal-title");
const nameModalInput     = $("name-modal-input");
const nameModalConfirm   = $("name-modal-confirm");
const shareModalBackdrop = $("share-modal-backdrop");
const shareModalList     = $("share-modal-list");

let _templateId = null; // id шаблона, открытого на экране редактирования

function pluralExercises(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "упражнение";
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "упражнения";
  return "упражнений";
}

/* — Список шаблонов — */
function initTemplatesScreen() { renderTemplatesList(); }

function renderTemplatesList() {
  const userId = DATA.getCurrentUser();
  const list = DATA.getTemplates(userId);

  if (!list.length) {
    templatesScroll.innerHTML = `<p class="empty-state">Пока нет шаблонов. Создай свой кнопкой «+» сверху, или заверши силовую тренировку и сохрани её как шаблон из детального просмотра истории.</p>`;
    return;
  }

  templatesScroll.innerHTML = list.map(t => `
    <div class="ex-row tpl-row" data-id="${t.id}">
      <span class="ex-row-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="9.5" width="3" height="5" rx="1"/><rect x="19" y="9.5" width="3" height="5" rx="1"/><rect x="6" y="7.5" width="2.6" height="9" rx="1"/><rect x="15.4" y="7.5" width="2.6" height="9" rx="1"/><line x1="8.6" y1="12" x2="15.4" y2="12"/></svg>
      </span>
      <span class="ex-row-body">
        <span class="ex-row-name">${escHtml(t.name)}</span>
        <span class="tpl-row-meta">${t.exercises.length} ${pluralExercises(t.exercises.length)}</span>
      </span>
      <span class="profile-chevron"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span>
    </div>
  `).join("");

  templatesScroll.querySelectorAll(".tpl-row").forEach(row => {
    row.addEventListener("click", () => openTemplateDetail(row.dataset.id));
  });
}

$("templates-back-btn").addEventListener("click", () => goToScreen("menu"));

/* — Создание пользовательского шаблона с нуля (п.7) — */
$("templates-add-btn").addEventListener("click", () => {
  openNameModal({
    title: "Новый шаблон",
    placeholder: "Например, День спины",
    confirmLabel: "Создать",
    onConfirm: name => {
      const userId = DATA.getCurrentUser();
      const tpl = DATA.createBlankTemplate(userId, name);
      SyncQueue.push("template:create", { templateId: tpl.id });
      openTemplateDetail(tpl.id); // сразу открываем для добавления упражнений
    },
  });
});

/* — Экран шаблона: просмотр и редактирование состава — */
function openTemplateDetail(templateId) {
  _templateId = templateId;
  renderTemplateDetail();
  goToScreen("templateDetail");
}

function renderTemplateDetail() {
  const userId = DATA.getCurrentUser();
  const tpl = DATA.getTemplate(userId, _templateId);
  if (!tpl) { goToScreen("templates"); return; }

  $("template-detail-title").textContent = tpl.name;
  $("template-detail-meta").textContent = `${tpl.exercises.length} ${pluralExercises(tpl.exercises.length)}`;

  renderTemplateBlocks(tpl);
}

function persistTemplateExercises(tpl) {
  DATA.updateTemplateExercises(DATA.getCurrentUser(), tpl.id, tpl.exercises);
  SyncQueue.push("template:update", { templateId: tpl.id });
  $("template-detail-meta").textContent = `${tpl.exercises.length} ${pluralExercises(tpl.exercises.length)}`;
}

function renderTemplateBlocks(tpl) {
  if (!tpl.exercises.length) {
    templateBlocksEl.innerHTML = `<p class="empty-state">В шаблоне пока нет упражнений — добавь первое кнопкой ниже.</p>`;
    return;
  }

  const exercisesLib = DATA.getVisibleExercises(DATA.getCurrentUser());
  templateBlocksEl.innerHTML = "";

  tpl.exercises.forEach((ex, idx) => {
    const exDef = exercisesLib.find(e => e.id === ex.exerciseId) || { name: ex.exerciseId };
    const canUp = idx > 0, canDown = idx < tpl.exercises.length - 1;

    const block = document.createElement("div");
    block.className = "ex-block";
    block.innerHTML = `
      <div class="ex-block-header">
        <span class="ex-block-name" title="${escHtml(exDef.name)}">${escHtml(exDef.name)}</span>
        <div class="ex-reorder">
          <button class="ex-reorder-btn" data-dir="up" ${canUp ? "" : "disabled"} title="Переместить вверх">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>
          </button>
          <button class="ex-reorder-btn" data-dir="down" ${canDown ? "" : "disabled"} title="Переместить вниз">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
          </button>
        </div>
        <button class="ex-remove-btn" title="Удалить упражнение из шаблона">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="tpl-sets-table">
        <div class="tpl-sets-header"><span>#</span><span>Вес</span><span>Повт</span><span></span></div>
        <div class="tpl-sets-body"></div>
      </div>
      <div class="sets-actions">
        <button class="btn-chip tpl-add-set-btn" style="flex:1">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Подход
        </button>
      </div>
    `;

    renderTemplateSets(block, tpl, idx);

    block.querySelectorAll(".ex-reorder-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const dir = btn.dataset.dir === "up" ? -1 : 1;
        const arr = tpl.exercises;
        [arr[idx], arr[idx + dir]] = [arr[idx + dir], arr[idx]];
        persistTemplateExercises(tpl);
        renderTemplateBlocks(tpl);
      });
    });

    block.querySelector(".ex-remove-btn").addEventListener("click", () => {
      tpl.exercises.splice(idx, 1);
      persistTemplateExercises(tpl);
      renderTemplateBlocks(tpl);
    });

    block.querySelector(".tpl-add-set-btn").addEventListener("click", () => {
      const last = ex.sets[ex.sets.length - 1];
      ex.sets.push({ weight: last ? last.weight : 0, reps: last ? last.reps : 0 });
      persistTemplateExercises(tpl);
      renderTemplateSets(block, tpl, idx);
    });

    templateBlocksEl.appendChild(block);
  });
}

function renderTemplateSets(block, tpl, exIdx) {
  const ex = tpl.exercises[exIdx];
  if (!ex.sets.length) ex.sets.push({ weight: 0, reps: 0 }); // в блоке всегда хотя бы один подход

  const tbody = block.querySelector(".tpl-sets-body");
  tbody.innerHTML = "";

  ex.sets.forEach((set, sIdx) => {
    const row = document.createElement("div");
    row.className = "tpl-set-row";
    row.innerHTML = `
      <span class="set-num">${sIdx + 1}</span>
      <div class="set-field"><input type="number" inputmode="decimal" placeholder="кг" value="${set.weight || ""}" step="0.5"></div>
      <div class="set-field"><input type="number" inputmode="numeric" placeholder="повт" value="${set.reps || ""}"></div>
      <button class="tpl-set-remove" title="Удалить подход" ${ex.sets.length <= 1 ? "disabled" : ""}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    `;

    const weightInput = row.querySelectorAll("input")[0];
    weightInput.addEventListener("change", () => {
      ex.sets[sIdx].weight = parseFloat(weightInput.value) || 0;
      persistTemplateExercises(tpl);
    });

    const repsInput = row.querySelectorAll("input")[1];
    repsInput.addEventListener("change", () => {
      ex.sets[sIdx].reps = parseInt(repsInput.value) || 0;
      persistTemplateExercises(tpl);
    });

    row.querySelector(".tpl-set-remove").addEventListener("click", () => {
      if (ex.sets.length <= 1) return;
      ex.sets.splice(sIdx, 1);
      persistTemplateExercises(tpl);
      renderTemplateSets(block, tpl, exIdx);
    });

    tbody.appendChild(row);
  });
}

$("template-detail-back-btn").addEventListener("click", () => goToScreen("templates"));

$("template-add-ex-btn").addEventListener("click", () => {
  openExercisePicker(exerciseId => {
    const userId = DATA.getCurrentUser();
    const tpl = DATA.getTemplate(userId, _templateId);
    if (!tpl) return;
    tpl.exercises.push({ exerciseId, sets: [{ weight: 0, reps: 0 }] });
    persistTemplateExercises(tpl);
    renderTemplateBlocks(tpl);
  });
});

/* — Начать тренировку из шаблона — */
$("template-start-btn").addEventListener("click", () => {
  const userId = DATA.getCurrentUser();
  if (DATA.getActiveWorkout(userId)) {
    showToast("Сначала заверши текущую тренировку");
    goToScreen("workout");
    return;
  }
  const workout = DATA.startWorkoutFromTemplate(userId, _templateId);
  if (!workout) { showToast("Не удалось начать тренировку"); return; }
  goToScreen("workout");
});

/* — Переименование шаблона — */
$("template-rename-btn").addEventListener("click", () => {
  const userId = DATA.getCurrentUser();
  const tpl = DATA.getTemplate(userId, _templateId);
  if (!tpl) return;
  openNameModal({
    title: "Переименовать шаблон",
    placeholder: "Название шаблона",
    initialValue: tpl.name,
    confirmLabel: "Сохранить",
    onConfirm: value => {
      DATA.renameTemplate(userId, _templateId, value);
      SyncQueue.push("template:rename", { templateId: _templateId });
      renderTemplateDetail();
      showToast("Шаблон переименован");
    },
  });
});

/* — Удаление шаблона — */
$("template-delete-btn").addEventListener("click", () => {
  const userId = DATA.getCurrentUser();
  DATA.deleteTemplate(userId, _templateId);
  SyncQueue.push("template:delete", { templateId: _templateId });
  showToast("Шаблон удалён");
  goToScreen("templates");
});

/* — «Поделиться» = независимая копия у другого пользователя (раздел 5) — */
$("template-share-btn").addEventListener("click", () => {
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
      await Sync.shareTemplate(_templateId, userId, toUserId);
      showToast(`Шаблон скопирован для ${toUser ? toUser.name : "пользователя"}`);
    });
  });

  openModal(shareModalBackdrop);
});

$("share-modal-cancel").addEventListener("click", () => closeModal(shareModalBackdrop));

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
      const tpl = DATA.createTemplateFromWorkout(DATA.getCurrentUser(), workout, name);
      SyncQueue.push("template:create", { templateId: tpl.id });
      showToast("Шаблон сохранён");
    },
  });
}

/* ==========================================================================
   Utils
   ========================================================================== */
function formatDuration(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

function parseDurationToSec(str) {
  const parts = str.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function fmtDate(ts) {
  const d = new Date(ts);
  const day = String(d.getDate()).padStart(2,"0");
  const mon = String(d.getMonth() + 1).padStart(2,"0");
  return `${day}.${mon}.${d.getFullYear()}`;
}

// Темп хранится в тренировке строкой "м:сс" (раздел 7 спеки) — для графиков нужно число секунд и обратно.
function paceStrToSec(str) {
  const [m, s] = String(str).split(":").map(Number);
  return (m || 0) * 60 + (s || 0);
}
function secToPaceStr(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

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
          // Новая версия каркаса встала на смену уже работавшей — обновление тихое,
          // подхватится при следующем открытии. Сообщаем, если человек сейчас в приложении.
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
            showToast("Доступна новая версия — обновите вкладку");
          }
        });
      });
    }).catch(() => { /* нет SW — офлайн-режим работает только на уже загруженных данных, без кэша каркаса */ });
  });
}

/* ==========================================================================
   Init
   ========================================================================== */
function init() {
  SyncQueue.flush();
  updateOnlineStatus();
  const userId = DATA.getCurrentUser();
  if (userId) {
    goToScreen("menu");
    Sync.hydrateUser(userId).then(() => {
      if (screenMenu.classList.contains("active")) refreshMenu();
    });
  } else {
    goToScreen("profile");
  }
}
init();
