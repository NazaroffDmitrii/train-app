const BACKUP_FIELDS = ["active", "history", "workout_index", "records", "own_exercises", "templates", "exercise_groups", "categories", "custom_categories", "category_colors", "own_muscles", "own_movements", "hidden", "hidden_muscles", "hidden_movements", "ex_order", "ref_order_muscle", "ref_order_movement"];
const IMPORT_MAX_BYTES = 10 * 1024 * 1024;

function validateImportSection(field, value) {
  const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const id = v => typeof v === "string" && v.trim().length > 0 && v.length <= 512 && !["__proto__","prototype","constructor"].includes(v);
  const fail = () => { throw new Error("Некорректные записи раздела: " + field); };
  const number = (v, min = -Infinity) => typeof v === "number" && Number.isFinite(v) && v >= min;
  const strings = v => Array.isArray(v) && v.every(item => typeof item === "string");
  const link = v => {
    if (v == null || v === "") return true;
    if (typeof v !== "string" || !/^https?:\/\//i.test(v) || /[\s<>"'\\]/.test(v)) return false;
    try { const url = new URL(v); return !!url.hostname && !url.username && !url.password; } catch { return false; }
  };
  const validateExercises = exercises => {
    if (!Array.isArray(exercises)) fail();
    for (const exercise of exercises) {
      if (!object(exercise) || !id(exercise.exerciseId) || !Array.isArray(exercise.sets)) fail();
      if (exercise.supersetId != null && !id(exercise.supersetId)) fail();
      for (const set of exercise.sets) {
        if (!object(set)) fail();
        if (set.weight != null && !number(set.weight)) fail(); // Assistance weights may be negative.
        if (set.reps != null && (!number(set.reps, 0) || !Number.isInteger(set.reps))) fail();
        if (set.rpe != null && (!number(set.rpe, 0) || set.rpe > 10)) fail();
        for (const key of ["done", "warmup", "dropSet"]) if (set[key] != null && typeof set[key] !== "boolean") fail();
      }
    }
  };
  if (field === "records") {
    for (const [exerciseId, record] of Object.entries(value)) {
      if (!id(exerciseId) || !object(record)) fail();
      for (const key of ["maxWeight", "weightAtMaxReps"]) if (record[key] != null && !number(record[key])) fail();
      for (const key of ["repsAtMaxWeight", "maxReps"]) {
        if (record[key] != null && (!number(record[key], 0) || !Number.isInteger(record[key]))) fail();
      }
      if (record.maxVolume != null && !number(record.maxVolume, 0)) fail();
    }
  }
  if (field === "category_colors") {
    for (const [name, color] of Object.entries(value)) {
      if (!id(name) || typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) fail();
    }
  }
  if (["categories", "custom_categories", "hidden", "hidden_muscles", "hidden_movements", "ex_order", "ref_order_muscle", "ref_order_movement"].includes(field)) {
    if (!value.every(id) || new Set(value).size !== value.length) fail();
  }
  if (["history", "workout_index", "own_exercises", "templates", "exercise_groups", "own_muscles", "own_movements"].includes(field)) {
    if (!value.every(v => object(v) && id(v.id)) || new Set(value.map(v => v.id)).size !== value.length) fail();
  }
  if (["own_exercises", "templates", "exercise_groups", "own_muscles", "own_movements"].includes(field)) {
    if (!value.every(v => typeof v.name === "string" && v.name.trim() && v.name.length <= 1000)) fail();
  }
  if (field === "templates") {
    for (const template of value) {
      validateExercises(template.exercises);
      for (const key of ["createdAt", "updatedAt"]) if (template[key] != null && !number(template[key], 0)) fail();
    }
  }
  if (field === "own_exercises") {
    for (const exercise of value) {
      if (exercise.type != null && !["run", "strength"].includes(exercise.type)) fail();
      for (const key of ["cat", "media", "tip"]) if (exercise[key] != null && typeof exercise[key] !== "string") fail();
      if (exercise.groupId != null && !id(exercise.groupId)) fail();
      if (exercise.steps != null && (!Array.isArray(exercise.steps) || !exercise.steps.every(step => typeof step === "string"))) fail();
      if (exercise.muscles != null && (!object(exercise.muscles) || !Object.values(exercise.muscles).every(role => typeof role === "string"))) fail();
      if (!link(exercise.media)) fail();
      if (exercise.atlas != null) {
        const atlas = exercise.atlas;
        if (!object(atlas)) fail();
        for (const key of ["movementGroup", "equipment", "level", "technique", "differences", "extra", "contraindications"]) {
          if (atlas[key] != null && typeof atlas[key] !== "string") fail();
        }
        for (const key of ["loadTypes", "categories", "mistakes"]) if (atlas[key] != null && !strings(atlas[key])) fail();
        for (const key of ["target", "synergist", "stabilizer"]) {
          if (atlas[key] != null && (!Array.isArray(atlas[key]) || !atlas[key].every(role => object(role) && id(role.muscle) && (role.bundle == null || typeof role.bundle === "string")))) fail();
        }
        if (!link(atlas.referenceUrl)) fail();
      }
    }
  }
  if (["own_muscles", "own_movements"].includes(field)) {
    for (const entry of value) {
      for (const key of ["group", "type"]) if (entry[key] != null && typeof entry[key] !== "string") fail();
      if (entry.visible != null && typeof entry.visible !== "boolean") fail();
      for (const key of ["bundles", "movements", "muscles"]) if (entry[key] != null && !strings(entry[key])) fail();
    }
  }
  if (field === "active" || field === "history") {
    for (const workout of field === "active" ? (value ? [value] : []) : value) {
      if (!id(workout.id) || !["run", "strength"].includes(workout.type) || !Number.isFinite(workout.startedAt) || workout.startedAt < 0) fail();
      for (const key of ["durationSec", "distance", "heartRate", "cadence", "finishedAt"]) {
        if (workout[key] != null && (typeof workout[key] !== "number" || !Number.isFinite(workout[key]) || workout[key] < 0)) fail();
      }
      if (workout.fieldDrafts != null) {
        if (!object(workout.fieldDrafts)) fail();
        for (const [type, draft] of Object.entries(workout.fieldDrafts)) {
          if (!["easy", "long", "hard"].includes(type)) fail();
          if (draft === null) continue;
          if (!object(draft)) fail();
          for (const [key, raw] of Object.entries(draft)) {
            if (!["h", "m", "s", "distance", "cadence", "hr"].includes(key) || typeof raw !== "string" || raw.length > 100) fail();
          }
        }
      }
      if (workout.exercises != null) {
        validateExercises(workout.exercises);
      }
    }
  }
}

// Preparation only: never write imported keys into the live profile here.
function prepareUserImport(text, userId) {
  if (!userId) throw new Error("Сначала выберите профиль");
  if (typeof text !== "string" || text.length > IMPORT_MAX_BYTES) throw new Error("Файл слишком большой (максимум 10 МБ)");
  const payload = JSON.parse(text);
  if (payload?.app !== "train." || payload.version !== 2 || payload.user !== userId) {
    throw new Error("Нужна копия train. версии 2 именно выбранного профиля");
  }
  if (!payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) throw new Error("Некорректный раздел данных");
  const allowed = new Set(BACKUP_FIELDS.map(field => `train_${field}_${userId}`));
  const keys = Object.keys(payload.data);
  if (!keys.length || keys.some(key => !allowed.has(key))) throw new Error("Копия содержит неизвестные, служебные ключи или данные другого профиля");
  const inspect = (value, depth = 0) => {
    if (depth > 30) throw new Error("Слишком сложная структура копии");
    if (!value || typeof value !== "object") return;
    for (const key of Object.keys(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Недопустимое поле в копии");
      inspect(value[key], depth + 1);
    }
  };
  for (const key of keys) {
    const raw = payload.data[key];
    if (typeof raw !== "string") throw new Error("Значения копии должны быть JSON-строками");
    const value = JSON.parse(raw);
    const field = BACKUP_FIELDS.find(field => key === `train_${field}_${userId}`);
    if (["records", "category_colors"].includes(field)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Ожидался словарь: " + field);
    } else if (field === "active") {
      if (value !== null && (typeof value !== "object" || Array.isArray(value) || typeof value.id !== "string")) throw new Error("Некорректная активная тренировка");
    } else if (!Array.isArray(value)) throw new Error("Ожидался список: " + field);
    inspect(value);
    validateImportSection(field, value);
  }
  return { app: "train-import-candidate", version: 1, user: userId, data: payload.data, preparedAt: new Date().toISOString() };
}

function stageUserImport(candidate, userId) {
  if (!userId || candidate.user !== userId) throw new Error("Профиль изменился — выберите файл заново");
  // Revalidate at commit; a staged candidate is not a trusted restoration plan.
  const verified = prepareUserImport(JSON.stringify({app:"train.",version:2,user:userId,data:candidate.data}), userId);
  const key = "train_import_candidate";
  if (localStorage.getItem(key) !== null) throw new Error("Уже есть подготовленная копия. Она сохранена; новый файл не заменил её");
  localStorage.setItem(key, JSON.stringify(verified));
  return verified;
}

function readStagedImport(userId) {
  const raw = localStorage.getItem("train_import_candidate");
  if (raw === null) return null;
  const candidate = JSON.parse(raw);
  if (candidate?.app !== "train-import-candidate" || candidate.version !== 1) throw new Error("Неизвестный формат подготовленной копии");
  const verified = prepareUserImport(JSON.stringify({app:"train.",version:2,user:candidate.user,data:candidate.data}), userId);
  return { raw, candidate: verified };
}

function cancelStagedImport(raw, userId) {
  const current = readStagedImport(userId);
  if (!current || current.raw !== raw) throw new Error("Подготовленная копия изменилась. Откройте её заново");
  localStorage.removeItem("train_import_candidate");
  if (localStorage.getItem("train_import_candidate") !== null) throw new Error("Не удалось убрать подготовленную копию");
}

function planStagedImport(candidate, userId, baseExerciseIds = []) {
  const verified = prepareUserImport(JSON.stringify({app:"train.",version:2,user:candidate.user,data:candidate.data}), userId);
  const sections = [], effective = {}, snapshot = {};
  for (const field of BACKUP_FIELDS) {
    const key = `train_${field}_${userId}`;
    const raw = localStorage.getItem(key);
    snapshot[key] = raw;
    const incoming = Object.hasOwn(verified.data, key);
    const selected = incoming ? verified.data[key] : raw;
    try { effective[field] = selected === null ? null : JSON.parse(selected); }
    catch { throw new Error("Повреждены текущие данные раздела «" + field + "». План не построен"); }
    if (incoming) sections.push({field, changed:raw !== verified.data[key], beforeExists:raw !== null,
      count:Array.isArray(effective[field]) ? effective[field].length : effective[field] === null ? 0 : Object.keys(effective[field]).length});
  }
  const list = field => {
    const value = effective[field];
    if (value === null) return [];
    if (!Array.isArray(value) || value.some(item => !item || typeof item !== "object")) throw new Error("Некорректный текущий раздел: " + field);
    return value;
  };
  const exercises = list("own_exercises");
  const known = new Set([...baseExerciseIds, ...exercises.map(ex => ex.id)]);
  const groups = new Set(list("exercise_groups").map(group => group.id));
  const warnings = new Set();
  const reference = (exerciseId, source) => {
    if (!known.has(exerciseId)) warnings.add(source + ": не найдено упражнение «" + String(exerciseId).slice(0,120) + "»");
  };
  for (const exercise of exercises) if (exercise.groupId && !groups.has(exercise.groupId)) warnings.add("У упражнения «" + exercise.id + "» не найдена группа");
  const history = list("history"), templates = list("templates");
  for (const [label, entries] of [["История",history],["Шаблоны",templates],["Активная тренировка",effective.active ? [effective.active] : []]]) {
    for (const entry of entries) {
      if (entry.exercises != null && !Array.isArray(entry.exercises)) throw new Error("Некорректный список упражнений: " + label);
      for (const exercise of entry.exercises || []) reference(exercise?.exerciseId, label);
    }
  }
  const historyIds = new Set(history.map(workout=>workout.id));
  for (const entry of list("workout_index")) if (!historyIds.has(entry.id)) warnings.add("Индекс: отсутствует полная тренировка «" + entry.id + "»");
  if (effective.active && historyIds.has(effective.active.id)) warnings.add("Активная тренировка уже присутствует в истории");
  // A preview, not an authorization or atomic snapshot. Rebuild under the eventual restore lock.
  return {user:userId, sections, warnings:[...warnings], snapshot};
}
