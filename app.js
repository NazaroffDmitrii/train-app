"use strict";

function escHtml(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Тоннаж одного подхода. Вес может быть отрицательным (упражнения с помощью —
// гравитрон и т.п., где меньшее по модулю число = меньше помощи = лучше
// результат): такой подход не должен УМЕНЬШАТЬ общий тоннаж тренировки —
// он просто не участвует в его сумме (вклад — 0, а не отрицательное число).
function setVolume(s) {
  return Math.max(0, (s.weight || 0) * (s.reps || 0));
}

// Учесть один выполненный подход в рекордах упражнения. maxWeight — старт с
// null ("рекорда ещё нет"), а не 0: для упражнений с помощью вес всегда
// отрицательный (гравитрон и т.п.), и с плавающим порогом 0 первый же подход
// никогда не стал бы рекордом (-40 не больше 0). Чем ближе к нулю — тем
// результат лучше, а раз -5 больше -40, обычное «максимум» уже работает
// правильно — не нужно отдельно инвертировать сравнение, только не
// заслонять его нулевым порогом по умолчанию.
function applySetToRecord(recs, exerciseId, s) {
  if (!recs[exerciseId]) recs[exerciseId] = { maxWeight: null, repsAtMaxWeight: 0, maxReps: 0, weightAtMaxReps: null, maxVolume: 0 };
  const r = recs[exerciseId];
  if (r.maxWeight === null || s.weight > r.maxWeight || (s.weight === r.maxWeight && s.reps > r.repsAtMaxWeight)) {
    r.maxWeight = s.weight; r.repsAtMaxWeight = s.reps;
  }
  if (s.reps > r.maxReps || (s.reps === r.maxReps && (r.weightAtMaxReps === null || s.weight > r.weightAtMaxReps))) {
    r.maxReps = s.reps; r.weightAtMaxReps = s.weight;
  }
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
  // === Биомех-база «Атлас» ===
  // Справочник (groups / categories(движения) / muscles / muscleCategoryLinks) +
  // 163 упражнения. ОБЩАЯ база: живёт в реляционных таблицах Supabase
  // (atlas_*), редактирует её только администратор (RLS is_admin). Приложение
  // читает её через DB.getAtlas → DATA.setAtlasFromRows и держит в локальном
  // кэше (train_atlas_cache) ради синхронного доступа и оффлайна; window.ATLAS_SEED
  // (atlas-seed.js) — фолбэк до первого входа. Личные правки/скрытие у обычных
  // пользователей — отдельный оверлей (own_*/hidden_*), snapshot не раздувается.
  const RAW_SEED = (window.ATLAS_SEED && typeof window.ATLAS_SEED === "object")
    ? window.ATLAS_SEED
    : { groups: [], categories: [], muscles: [], muscleCategoryLinks: [], exercises: [] };

  const ATLAS_CACHE_KEY = "train_atlas_cache";
  const _pad = (n, w) => String(n).padStart(w, "0");

  // Внутренняя форма справочника — как сид, но с СТАБИЛЬНЫМИ id у мышц/движений/
  // групп/связей (нужны для скрытия и правок). id детерминированы позицией и
  // совпадают со схемой миграции supabase-atlas.sql, поэтому оффлайн-сид и БД
  // ссылаются на одни и те же id.
  function seedToAtlas(s) {
    const gid = {}, mid = {}, vid = {};
    (s.groups || []).forEach((g, i) => { gid[g] = `ag${_pad(i + 1, 2)}`; });
    (s.muscles || []).forEach((m, i) => { mid[m.name] = `am${_pad(i + 1, 3)}`; });
    (s.categories || []).forEach((v, i) => { vid[v.name] = `av${_pad(i + 1, 3)}`; });
    return {
      groups: (s.groups || []).slice(),
      groupRows: (s.groups || []).map(g => ({ id: gid[g], name: g })),
      muscles: (s.muscles || []).map(m => ({ id: mid[m.name], name: m.name, group: m.group, visible: !!m.visible, bundles: m.bundles || [] })),
      categories: (s.categories || []).map(v => ({ id: vid[v.name], name: v.name, group: v.group, type: v.type || "База" })),
      muscleCategoryLinks: (s.muscleCategoryLinks || []).map((l, i) => ({ id: `al${_pad(i + 1, 3)}`, muscle: l.muscle, bundle: l.bundle || "", category: l.category })),
      exercises: (s.exercises || []).slice(),
    };
  }
  // Строки БД (5 таблиц из DB.getAtlas) → та же внутренняя форма (id — из БД).
  function rowsToAtlas(r) {
    const gName = new Map((r.groups || []).map(g => [g.id, g.name]));
    const mName = new Map((r.muscles || []).map(m => [m.id, m.name]));
    const vName = new Map((r.movements || []).map(v => [v.id, v.name]));
    return {
      groups: (r.groups || []).map(g => g.name),
      groupRows: (r.groups || []).map(g => ({ id: g.id, name: g.name })),
      muscles: (r.muscles || []).map(m => ({ id: m.id, name: m.name, group: gName.get(m.group_id) || "", visible: !!m.visible, bundles: Array.isArray(m.bundles) ? m.bundles : [] })),
      categories: (r.movements || []).map(v => ({ id: v.id, name: v.name, group: gName.get(v.group_id) || "", type: v.type || "База" })),
      muscleCategoryLinks: (r.links || []).map(l => ({ id: l.id, muscle: mName.get(l.muscle_id) || "", bundle: l.bundle || "", category: vName.get(l.movement_id) || "" })),
      exercises: (r.exercises || []).map(e => e.data),
    };
  }
  function _loadAtlasCache() {
    try { const v = JSON.parse(localStorage.getItem(ATLAS_CACHE_KEY)); return v && Array.isArray(v.muscles) ? v : null; }
    catch { return null; }
  }

  // Живой справочник. let — подменяется при загрузке из БД (setAtlas).
  let ATLAS = _loadAtlasCache() || seedToAtlas(RAW_SEED);

  // имя мышцы → её группа-витрина; производные пересобираются при подмене ATLAS.
  let _muscleGroup, DEFAULT_EXERCISES, ATLAS_BY_ID, EXERCISE_CATEGORIES;

  // Администратор (profiles.is_admin) может править ОБЩИЙ справочник. Выставляется
  // из bridge.js при входе (myProfile.is_admin). Обычный пользователь правит
  // только свой оверлей (own/hidden).
  let _isAdmin = false;

  // роль новой модели ({muscle,bundle}[]) → строка «Мышца (пучок), …» для легаси-рендера
  function _rolesToStr(arr) {
    return (arr || []).map(o => o.bundle ? `${o.muscle} (${o.bundle})` : o.muscle).join(", ");
  }
  // обратный разбор: «Мышца (Пучок), …» → [{muscle,bundle}] (для синхронизации правок в ex.atlas)
  function _strToRoles(str) {
    return (str || "").split(",").map(s => s.trim()).filter(Boolean).map(s => {
      const m = s.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
      return m ? { muscle: m[1].trim(), bundle: m[2].trim() } : { muscle: s, bundle: "" };
    });
  }
  // группы упражнения = группы его целевых мышц (уникальные, в порядке появления)
  function atlasExerciseGroups(ex) {
    const t = (ex.muscles && ex.muscles.target) || [];
    const seen = [];
    t.forEach(o => { const g = _muscleGroup.get(o.muscle); if (g && !seen.includes(g)) seen.push(g); });
    return seen;
  }
  // Карточка Атласа → объект упражнения приложения. Полная новая модель лежит в
  // ex.atlas; сверху — производные легаси-поля (cat/type/muscles-строки/steps),
  // чтобы существующие экраны работали до их переписывания под новую модель.
  function atlasToExercise(a) {
    const m = a.muscles || {};
    const groups = atlasExerciseGroups(a);
    return {
      id: a.id,
      name: a.name,
      cat: groups[0] || "Другое",
      groups,
      type: "strength",
      owner: null,
      atlas: {
        movementGroup: a.movementGroup || "",
        equipment: a.equipment || "",
        loadTypes: a.loadTypes || [],
        level: a.level || "",
        target: m.target || [],
        synergist: m.synergist || [],
        stabilizer: m.stabilizer || [],
        categories: a.categories || [],
        technique: a.technique || "",
        mistakes: a.mistakes || [],
        differences: a.differences || "",
        extra: a.extra || "",
        contraindications: a.contraindications || "",
        referenceUrl: a.referenceUrl || "",
      },
      // легаси-поля для существующих экранов (список/пикер/статистика/деталка):
      muscles: {
        agonists:     _rolesToStr(m.target),
        synergists:   _rolesToStr(m.synergist),
        stabilizers:  _rolesToStr(m.stabilizer),
        distributors: "",
      },
      steps: (a.technique || "").split("\n").map(s => s.trim()).filter(Boolean),
      media: "",
      tip: "",
    };
  }

  // Пересчитать легаси-поля упражнения (muscles-строки, steps, groups) из его
  // богатой модели ex.atlas — после правки полным редактором (#6). cat остаётся
  // тем, что задал пользователь (или производной, если не задан).
  function _deriveLegacyFromAtlas(ex) {
    const a = ex.atlas || {};
    ex.muscles = {
      agonists:     _rolesToStr(a.target),
      synergists:   _rolesToStr(a.synergist),
      stabilizers:  _rolesToStr(a.stabilizer),
      distributors: "",
    };
    ex.steps = (a.technique || "").split("\n").map(s => s.trim()).filter(Boolean);
    const groups = [];
    (a.target || []).forEach(o => { const g = _muscleGroup.get(o.muscle); if (g && !groups.includes(g)) groups.push(g); });
    ex.groups = groups;
  }

  // Пересобрать производные от ATLAS (после подмены справочника из БД). Порядок
  // важен: _muscleGroup нужна atlasToExercise (через atlasExerciseGroups).
  function rebuildAtlasDerived() {
    _muscleGroup = new Map(ATLAS.muscles.map(m => [m.name, m.group]));
    DEFAULT_EXERCISES = ATLAS.exercises.map(atlasToExercise);
    ATLAS_BY_ID = new Map(DEFAULT_EXERCISES.map(e => [e.id, e]));
    EXERCISE_CATEGORIES = ATLAS.groups.slice();
  }
  rebuildAtlasDerived();

  // id старых 18 дефолтов — при миграции их копии сносим из личного списка
  // (полная замена базы, см. решение пользователя). Личные e_own_* сохраняются.
  const OLD_DEFAULT_IDS = new Set([
    "e_squat","e_deadlift","e_bench","e_ohp","e_row","e_pullup","e_dip","e_curl",
    "e_tricep","e_lunge","e_rdl","e_press_inc","e_fly","e_lat","e_calf","e_plank",
    "e_crunch","e_run",
  ]);

  // «Категории» приложения = группы-витрины Атласа (аналог старых категорий).
  // EXERCISE_CATEGORIES пересобирается в rebuildAtlasDerived (выше).

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
    // Живые (пересобираются при подмене ATLAS из БД) — отдаём через геттеры,
    // иначе экспорт застыл бы на значении момента возврата объекта.
    get DEFAULT_EXERCISES() { return DEFAULT_EXERCISES; },
    get EXERCISE_CATEGORIES() { return EXERCISE_CATEGORIES; },
    categoryColor,
    RPE_LABELS,

    // === Справочник Атласа (для подвкладок Мышцы/Движения/Группы и конструктора) ===
    // Подменить справочник данными из БД (DB.getAtlas → строки 5 таблиц).
    // Возвращает true, если содержимое изменилось (для решения перерисовать).
    setAtlasFromRows(rows) { return this.setAtlas(rowsToAtlas(rows)); },
    setAtlas(atlasObj) {
      if (!atlasObj || !Array.isArray(atlasObj.muscles) || !atlasObj.muscles.length) return false;
      const json = JSON.stringify(atlasObj);
      const prev = (() => { try { return localStorage.getItem(ATLAS_CACHE_KEY); } catch { return null; } })();
      ATLAS = atlasObj;
      rebuildAtlasDerived();
      try { localStorage.setItem(ATLAS_CACHE_KEY, json); } catch {}
      return json !== prev;
    },
    atlasGroups() { return ATLAS.groups.slice(); },
    atlasGroupRows() { return (ATLAS.groupRows || ATLAS.groups.map(g => ({ id: g, name: g }))).slice(); },
    atlasMuscles() { return ATLAS.muscles; },
    atlasMovements() { return ATLAS.categories; },       // «основные движения» (База/Опция)
    atlasLinks() { return ATLAS.muscleCategoryLinks; },  // мышца ↔ движение
    atlasExerciseById(id) { return ATLAS_BY_ID.get(id) || null; },
    atlasMuscleGroup(name) { return _muscleGroup.get(name) || null; },
    atlasExerciseGroups,

    // --- админ общего справочника ---
    isAdmin() { return _isAdmin; },
    setAdmin(v) { _isAdmin = !!v; },

    // Локальная (оптимистичная) мутация общего справочника: клон → правка → коммит
    // (кэш + производные). Персист в БД — на стороне вызова (DB.saveAtlas*),
    // только у админа. atlasSnapshot отдаёт глубокую копию для правки.
    atlasSnapshot() { return JSON.parse(JSON.stringify(ATLAS)); },
    commitAtlas(atlasObj) {
      if (!atlasObj || !Array.isArray(atlasObj.muscles)) return;
      ATLAS = atlasObj;
      rebuildAtlasDerived();
      try { localStorage.setItem(ATLAS_CACHE_KEY, JSON.stringify(atlasObj)); } catch {}
    },

    // --- личный оверлей справочника (own + hidden) ---
    // own_* — приватные элементы пользователя (видит только он); hidden_* — id
    // общих элементов, скрытых у себя. Синхронизируются в user_data (bridge.js).
    getOwnMuscles(userId)        { return ls(`train_own_muscles_${userId}`, []); },
    saveOwnMuscles(userId, l)    { lsSet(`train_own_muscles_${userId}`, l); },
    getHiddenMuscleIds(userId)   { return ls(`train_hidden_muscles_${userId}`, []); },
    saveHiddenMuscleIds(userId, l){ lsSet(`train_hidden_muscles_${userId}`, l); },
    getOwnMovements(userId)      { return ls(`train_own_movements_${userId}`, []); },
    saveOwnMovements(userId, l)  { lsSet(`train_own_movements_${userId}`, l); },
    getHiddenMovementIds(userId) { return ls(`train_hidden_movements_${userId}`, []); },
    saveHiddenMovementIds(userId, l){ lsSet(`train_hidden_movements_${userId}`, l); },

    // Пользовательский порядок карточек справочника (как train_ex_order у
    // упражнений): плоский список id в нужном порядке, применяется внутри групп
    // при рендере. Локальный (перетаскивание — личная сортировка справочника).
    getRefOrder(userId, kind)      { return ls(`train_ref_order_${kind}_${userId}`, []); },
    saveRefOrder(userId, kind, ids){ lsSet(`train_ref_order_${kind}_${userId}`, ids); },

    // Список для UI справочника: (общие − скрытые) + личные.
    refMuscles(userId) {
      const hidden = new Set(this.getHiddenMuscleIds(userId));
      return [...ATLAS.muscles.filter(m => !hidden.has(m.id)), ...this.getOwnMuscles(userId)];
    },
    refMovements(userId) {
      const hidden = new Set(this.getHiddenMovementIds(userId));
      return [...ATLAS.categories.filter(m => !hidden.has(m.id)), ...this.getOwnMovements(userId)];
    },
    // Движения мышцы по имени: общие связи + inline-связи личных мышц/движений.
    refMovesByMuscle(userId) {
      const map = {};
      ATLAS.muscleCategoryLinks.forEach(l => { (map[l.muscle] = map[l.muscle] || new Set()).add(l.category); });
      this.getOwnMovements(userId).forEach(mv => (mv.muscles || []).forEach(mn => { (map[mn] = map[mn] || new Set()).add(mv.name); }));
      this.getOwnMuscles(userId).forEach(m => (m.movements || []).forEach(c => { (map[m.name] = map[m.name] || new Set()).add(c); }));
      return map;
    },
    refMusclesByMove(userId) {
      const map = {};
      ATLAS.muscleCategoryLinks.forEach(l => { (map[l.category] = map[l.category] || new Set()).add(l.muscle); });
      this.getOwnMuscles(userId).forEach(m => (m.movements || []).forEach(c => { (map[c] = map[c] || new Set()).add(m.name); }));
      this.getOwnMovements(userId).forEach(mv => (mv.muscles || []).forEach(mn => { (map[mv.name] = map[mv.name] || new Set()).add(mn); }));
      return map;
    },

    // Общий пул (без личных и без учёта скрытия) — низкоуровневый доступ
    getExercises() {
      return ls("train_exercises", DEFAULT_EXERCISES);
    },
    saveExercises(list) { lsSet("train_exercises", list); },

    // Личные упражнения пользователя
    getOwnExercises(userId) { return ls(`train_own_exercises_${userId}`, []); },
    saveOwnExercises(userId, list) { lsSet(`train_own_exercises_${userId}`, list); },

    // Группы упражнений (варианты одного движения: жим штанги/гантелей/в
    // тренажёре и т.п.) — личная сущность, [{id, name}]. Членство хранится
    // на самом упражнении (ex.groupId), а не списком id здесь — состав
    // группы вычисляется на лету (см. resolveDisplayItems), поэтому «роспуск»
    // группы при ≤1 видимом участнике не требует явной чистки реестра.
    getExerciseGroups(userId) { return ls(`train_exercise_groups_${userId}`, []); },
    saveExerciseGroups(userId, list) { lsSet(`train_exercise_groups_${userId}`, list); },

    // Назначить упражнению группу по имени (из формы редактирования): пусто —
    // убрать из группы; совпало с существующей (регистронезависимо) — влиться
    // в неё; иначе — завести новую запись в реестре.
    setExerciseGroupByName(userId, exerciseId, rawName) {
      const name = (rawName || "").trim();
      if (!name) { this.updateOwnExercise(userId, exerciseId, { groupId: null }); return null; }
      const list = this.getExerciseGroups(userId);
      const nameLow = name.toLowerCase();
      let group = list.find(g => g.name.toLowerCase() === nameLow);
      if (!group) {
        group = { id: `grp_${Date.now()}`, name };
        list.push(group);
        this.saveExerciseGroups(userId, list);
      }
      this.updateOwnExercise(userId, exerciseId, { groupId: group.id });
      return group;
    },

    // Создать НОВУЮ группу напрямую (drag-and-drop слияние двух упражнений,
    // см. performMerge) — в отличие от setExerciseGroupByName, не ищет
    // существующую группу по имени: два слияния подряд с одинаковой
    // заглушкой-названием ("Новая группа") не должны случайно схлопнуться
    // в одну и ту же группу — каждое слияние заводит свою запись.
    createExerciseGroup(userId, name, exerciseIds) {
      const list = this.getExerciseGroups(userId);
      const group = { id: `grp_${Date.now()}`, name: (name || "Новая группа").trim() || "Новая группа" };
      list.push(group);
      this.saveExerciseGroups(userId, list);
      exerciseIds.forEach(id => this.updateOwnExercise(userId, id, { groupId: group.id }));
      return group;
    },

    // Переименовать группу (инлайн-правка в режиме редактирования списка).
    renameExerciseGroup(userId, groupId, newName) {
      newName = (newName || "").trim();
      if (!newName) return false;
      const list = this.getExerciseGroups(userId);
      const g = list.find(x => x.id === groupId);
      if (!g) return false;
      g.name = newName;
      this.saveExerciseGroups(userId, list);
      return true;
    },

    // Распустить группу: снять groupId со всех участников (упражнения остаются,
    // просто перестают быть в группе) и убрать саму запись группы.
    deleteExerciseGroup(userId, groupId) {
      this.getVisibleExercises(userId)
        .filter(e => e.groupId === groupId)
        .forEach(e => this.updateOwnExercise(userId, e.id, { groupId: null }));
      const list = this.getExerciseGroups(userId).filter(g => g.id !== groupId);
      this.saveExerciseGroups(userId, list);
      return true;
    },

    // Схлопнуть упражнения в группы для отображения (общая точка для вкладки
    // «Упражнения» и пикера «Добавить упражнение» — списки рендерятся по-
    // разному, а эта логика — одна). exercises — уже отфильтрованный по
    // вкладке/категории список (или полный); query — строка поиска ("" —
    // без текстового фильтра). Если по имени группы ИЛИ имени любого её
    // участника есть совпадение — в результат идёт ОДИН элемент-группа со
    // ВСЕМИ участниками (не только совпавшими: пользователь ищет по одному
    // варианту, а видеть должен все). Группа с <2 видимых участников
    // деградирует до обычных строк (это и есть «авто-роспуск»).
    resolveDisplayItems(userId, exercises, query) {
      const q = (query || "").trim().toLowerCase();
      const matches = s => !q || (s || "").toLowerCase().includes(q);
      const groupsById = new Map(this.getExerciseGroups(userId).map(g => [g.id, g]));
      // Порядок вариантов внутри группы — из общего пользовательского порядка
      // (тот же список, что и для верхнего уровня: id участников лежат в нём
      // сразу после своего group:<id>, см. saveExOrder). Нет в порядке — по имени.
      const order = this.getExerciseOrder(userId);
      const memberSort = (a, b) => {
        if (order) {
          const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
          if (ia !== -1 || ib !== -1) { if (ia === -1) return 1; if (ib === -1) return -1; return ia - ib; }
        }
        return a.name.localeCompare(b.name, "ru");
      };
      // Состав каждой группы — по всему входному списку (а не только по
      // совпавшим с query), иначе при поиске в группу попали бы не все варианты.
      const membersByGroup = new Map();
      exercises.forEach(ex => {
        const g = ex.groupId && groupsById.get(ex.groupId);
        if (g) (membersByGroup.get(g.id) || membersByGroup.set(g.id, []).get(g.id)).push(ex);
      });
      // Один проход по исходному (уже отсортированному) списку — группа встаёт
      // на позицию своего первого участника, а не всегда в начало/конец.
      const emitted = new Set();
      const items = [];
      exercises.forEach(ex => {
        const g = ex.groupId && groupsById.get(ex.groupId);
        if (!g) { if (matches(ex.name) || matches(ex.cat)) items.push({ kind: "exercise", ex }); return; }
        if (emitted.has(g.id)) return;
        emitted.add(g.id);
        const members = membersByGroup.get(g.id);
        if (!(matches(g.name) || members.some(m => matches(m.name)))) return;
        if (members.length < 2) {
          members.forEach(m => { if (matches(m.name) || matches(g.name)) items.push({ kind: "exercise", ex: m }); });
          return;
        }
        items.push({ kind: "group", id: g.id, name: g.name, cat: members[0].cat, members: [...members].sort(memberSort) });
      });
      return items;
    },

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

    // Полный список упражнений пользователя = read-only база Атласа + личный
    // override-слой (copy-on-write). Правило слияния:
    //   • личное упражнение с id базового (exNNN) перекрывает базовое (это его правка);
    //   • скрытые id (getHiddenIds) выпадают и из базы, и из override;
    //   • чисто личные (e_own_*) добавляются сверху.
    // База в личный список НЕ копируется — snapshot синхронизации не раздувается.
    getVisibleExercises(userId) {
      this.ensureExercisesSeeded(userId);
      const own = this.getOwnExercises(userId);
      const ownIds = new Set(own.map(e => e.id));
      const hidden = new Set(this.getHiddenIds(userId));
      const base = DEFAULT_EXERCISES.filter(e => !ownIds.has(e.id) && !hidden.has(e.id));
      const ownVisible = own.filter(e => !hidden.has(e.id));
      return [...base, ...ownVisible];
    },

    // Разовая миграция на базу «Атлас»: сносит копии старых 18 дефолтов из личного
    // списка (полная замена базы). Личные упражнения (e_own_*) и правки атласа
    // сохраняются. Ничего не копирует — база отдаётся merge'ом (см. getVisibleExercises).
    ensureExercisesSeeded(userId) {
      if (ls(`train_atlas_migrated_${userId}`)) return false;
      const own = this.getOwnExercises(userId);
      const kept = own.filter(e => !OLD_DEFAULT_IDS.has(e.id));
      if (kept.length !== own.length) this.saveOwnExercises(userId, kept);
      // Категории → 8 групп-витрин Атласа. Старые (Спина/Кор/Кардио…) больше не
      // совпадают с ex.cat новой базы; сохраняем лишь кастомные, добавленные юзером.
      const OLD_CATS = ["Ноги", "Спина", "Грудь", "Плечи", "Руки", "Кор", "Кардио", "Другое"];
      const curCats = ls(`train_categories_${userId}`, null);
      if (Array.isArray(curCats)) {
        const custom = curCats.filter(c => !OLD_CATS.includes(c) && !ATLAS.groups.includes(c));
        lsSet(`train_categories_${userId}`, [...ATLAS.groups, ...custom]);
      }
      lsSet(`train_atlas_migrated_${userId}`, true);
      lsSet(`train_exercises_seeded_${userId}`, true);
      return false; // база больше не копируется — push в remote не нужен
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
    addExercise(userId, { name, cat, type, emoji, media, muscles, steps, tip, atlas, groupId }) {
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
        groupId: groupId || null,
      };
      // Полный редактор (#6) передаёт богатую модель — легаси-поля выводим из неё.
      if (atlas) { ex.atlas = atlas; _deriveLegacyFromAtlas(ex); }
      list.push(ex);
      this.saveOwnExercises(userId, list);
      return ex;
    },

    // Редактирование. Личное правится на месте; базовое (атлас) правится через
    // copy-on-write — создаётся личная копия с тем же id, которая перекрывает базу
    // при слиянии (getVisibleExercises). Так синхронизируется только правка, не вся база.
    updateOwnExercise(userId, exerciseId, patch) {
      const list = this.getOwnExercises(userId);
      let ex = list.find(e => e.id === exerciseId);
      if (!ex) {
        const base = ATLAS_BY_ID.get(exerciseId);
        if (!base) return null;
        ex = JSON.parse(JSON.stringify(base)); // глубокая копия, чтобы не мутировать общий сид
        ex.owner = userId;
        list.push(ex);
      }
      if (patch.name !== undefined) ex.name = patch.name.trim();
      if (patch.cat !== undefined) ex.cat = patch.cat;
      if (patch.type !== undefined) ex.type = patch.type;
      if (patch.emoji !== undefined) ex.emoji = patch.emoji;
      if (patch.media !== undefined) ex.media = (patch.media || "").trim();
      if (patch.muscles !== undefined) ex.muscles = normMuscles(patch.muscles);
      if (patch.steps !== undefined) ex.steps = normSteps(patch.steps);
      if (patch.tip !== undefined) ex.tip = (patch.tip || "").trim();
      if (patch.groupId !== undefined) ex.groupId = patch.groupId || null;
      // Полный редактор (#6): patch.atlas — богатая модель целиком. Мержим в
      // ex.atlas и выводим легаси-поля из неё (muscles-строки/steps/groups).
      if (patch.atlas !== undefined) {
        ex.atlas = Object.assign(ex.atlas || {}, patch.atlas);
        _deriveLegacyFromAtlas(ex);
      } else if (ex.atlas) {
        // Старый путь (правка отдельных легаси-полей) — отражаем в ex.atlas.
        if (patch.muscles !== undefined) {
          ex.atlas.target     = _strToRoles(patch.muscles.agonists);
          ex.atlas.synergist  = _strToRoles(patch.muscles.synergists);
          ex.atlas.stabilizer = _strToRoles(patch.muscles.stabilizers);
        }
        if (patch.steps !== undefined) ex.atlas.technique = normSteps(patch.steps).join("\n");
      }
      this.saveOwnExercises(userId, list);
      return ex;
    },

    // Удаление из списка пользователя. Чисто личное (e_own_*) удаляется совсем.
    // Базовое (атлас) удалить нельзя — его скрываем у этого пользователя; заодно
    // убираем его override из личного списка, если был. Восстановление — через undo
    // (снимок own + hidden, см. обработчик свайпа).
    deleteOwnExercise(userId, exerciseId) {
      const list = this.getOwnExercises(userId);
      const filtered = list.filter(e => e.id !== exerciseId);
      if (filtered.length !== list.length) this.saveOwnExercises(userId, filtered);
      if (ATLAS_BY_ID.has(exerciseId)) this.hideExercise(userId, exerciseId);
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
        const exVol = ex.sets.filter(s => s.done).reduce((a, s) => a + setVolume(s), 0);
        // Дроп-сет (s.dropSet) — не самостоятельная попытка на свежих силах, а
        // облегчённое продолжение предыдущего подхода, поэтому в рекорды
        // (макс. вес/повторы) не идёт; в тоннаж выше — идёт, это честная работа.
        ex.sets.filter(s => s.done && s.reps > 0 && !s.dropSet).forEach(s => applySetToRecord(recs, ex.exerciseId, s));
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
          const exVol = ex.sets.filter(s => s.done).reduce((a, s) => a + setVolume(s), 0);
          // Дроп-сет (s.dropSet) — не самостоятельная попытка на свежих силах, а
        // облегчённое продолжение предыдущего подхода, поэтому в рекорды
        // (макс. вес/повторы) не идёт; в тоннаж выше — идёт, это честная работа.
        ex.sets.filter(s => s.done && s.reps > 0 && !s.dropSet).forEach(s => applySetToRecord(recs, ex.exerciseId, s));
          if (recs[ex.exerciseId]) recs[ex.exerciseId].maxVolume = Math.max(recs[ex.exerciseId].maxVolume || 0, exVol);
        });
      });
      this.saveRecords(userId, recs);
      return recs;
    },

    // Перепривязать «осиротевшее» упражнение (id из истории/шаблонов, которого
    // больше нет в базе — напр. старые дефолты после перехода на «Атлас») к
    // упражнению из новой базы. Переписывает историю и шаблоны, обновляет снимок
    // имени, пересчитывает рекорды — после этого статистика считается под newId.
    remapExercise(userId, oldId, newId) {
      if (!oldId || !newId || oldId === newId) return 0;
      const newEx = this.getVisibleExercises(userId).find(e => e.id === newId);
      const newName = newEx ? newEx.name : null;
      let changed = 0;
      const hist = this.getWorkoutHistory(userId);
      hist.forEach(w => (w.exercises || []).forEach(ex => {
        if (ex.exerciseId === oldId) { ex.exerciseId = newId; if (newName) ex.name = newName; changed++; }
      }));
      if (changed) { this.saveWorkoutHistory(userId, hist); this.recomputeRecords(userId); }
      const tpls = this.getTemplates(userId);
      let tplChanged = 0;
      tpls.forEach(t => (t.exercises || []).forEach(ex => {
        if (ex.exerciseId === oldId) { ex.exerciseId = newId; tplChanged++; }
      }));
      if (tplChanged) this.saveTemplates(userId, tpls);
      return changed + tplChanged;
    },

    // Список «осиротевших» упражнений (встречаются в истории, но нет в базе) —
    // для перепривязки. Имя берём из снимка в истории (ex.name).
    getOrphanExercises(userId) {
      const known = new Set(this.getVisibleExercises(userId).map(e => e.id));
      const orphans = {};
      this.getWorkoutHistory(userId).forEach(w => {
        if (w.type !== "strength") return;
        (w.exercises || []).forEach(ex => {
          if (known.has(ex.exerciseId)) return;
          const o = orphans[ex.exerciseId] || (orphans[ex.exerciseId] = { id: ex.exerciseId, name: ex.name || ex.exerciseId, count: 0 });
          if (ex.name && o.name === ex.exerciseId) o.name = ex.name;
          o.count++;
        });
      });
      return Object.values(orphans).sort((a, b) => b.count - a.count);
    },

    // Дефолт таймера отдыха — девайс-настройка, запоминается между тренировками.
    getRestDefault() { const v = ls("train_rest_default", 90); return (typeof v === "number" && v > 0) ? v : 90; },
    setRestDefault(sec) { lsSet("train_rest_default", sec); },

    // Последняя тренировка, в которой встречалось данное упражнение
    getLastWorkoutForExercise(userId, exerciseId) {
      const history = this.getWorkoutHistory(userId);
      return history.find(w => w.type === "strength" && (w.exercises || []).some(e => e.exerciseId === exerciseId)) || null;
    },
    // Соседняя силовая тренировка с этим упражнением относительно момента refTs:
    // dir="prev" — ближайшая раньше, dir="next" — ближайшая позже. Для перехода
    // по истории конкретного упражнения из экрана деталей. История отсортирована
    // по убыванию startedAt.
    adjacentWorkoutForExercise(userId, exerciseId, refTs, dir) {
      const hist = this.getWorkoutHistory(userId)
        .filter(w => w.type === "strength" && (w.exercises || []).some(e => e.exerciseId === exerciseId));
      if (dir === "prev") return hist.find(w => w.startedAt < refTs) || null;
      // next: ближайшая ПОЗЖЕ — среди отсортированных по убыванию это последняя
      // из тех, чей startedAt всё ещё больше refTs.
      let cand = null;
      for (const w of hist) { if (w.startedAt > refTs) cand = w; else break; }
      return cand;
    },

    // Прогресс рабочего веса по упражнению во времени (раздел 9.2: график по тапу на упражнение).
    // За значение тренировки берётся лучший выполненный подход (макс. вес, при равенстве — больше повторов).
    getExerciseProgress(userId, exerciseId) {
      const history = this.getWorkoutHistory(userId)
        .filter(w => w.type === "strength" && (w.exercises || []).some(e => e.exerciseId === exerciseId));
      const points = history.map(w => {
        const block = w.exercises.find(e => e.exerciseId === exerciseId);
        // Вес не фильтруем по > 0: для упражнений с помощью (гравитрон и т.п.)
        // он отрицательный, и график прогресса иначе всегда был бы пустым.
        const doneSets = block.sets.filter(s => s.done && s.reps > 0);
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
          supersetId: ex.supersetId || null,   // связки суперсета переносим в шаблон
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
        exercises: tpl.exercises.map(ex => ({ exerciseId: ex.exerciseId, supersetId: ex.supersetId || null, sets: ex.sets.map(s => ({ ...s })) })),
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
            supersetId: ex.supersetId || null,   // связки суперсета из шаблона
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
  const timer    = $("start-timer");
  const ring1    = $("start-pulse-ring-1");
  const ring2    = $("start-pulse-ring-2");
  if (!timer || !ring1 || !ring2) return;

  // Анимации кнопки нужны только когда меню реально на экране и вкладка видна.
  // Иначе (открыт экран тренировки/статистики/свёрнуто приложение) циклы зря
  // жгли бы CPU/GPU и батарею. Неоновая вращающаяся рамка — чистый CSS (см.
  // .start-neon-ring), поэтому в JS остаются только пульсация колец, дыхание
  // двоеточия и таймер.
  const menuActive = () => !document.hidden && screenMenu.classList.contains("active");

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

      // После часа секунды не показываем — формат становится Ч:ММ (тот же вид
      // «две цифры через двоеточие», что и ММ:СС до часа), поэтому и размер
      // остаётся обычным, без разросшихся цифр.
      const key = isLong ? `${h}:${mm}:${blink}` : `${mm}:${ss}:${blink}`;
      if (key === lastKey) return; // ничего видимого не изменилось
      lastKey = key;

      const op = blink ? "1" : "0.22";
      const colon = `<div class="start-colon"><div class="start-colon-dot" style="opacity:${op}"></div><div class="start-colon-dot" style="opacity:${op}"></div></div>`;
      timer.innerHTML = isLong
        ? `<span class="start-timer-num">${h}</span>${colon}<span class="start-timer-num">${mm}</span>`
        : `<span class="start-timer-num">${mm}</span>${colon}<span class="start-timer-num">${ss}</span>`;
    }

    stopStartBtnTimer();
    renderTimer();
    _startBtnInt = setInterval(renderTimer, 500);
  }

  // Запускаем
  setupPulse(ring1, ring2, () => startBtn.classList.contains("active-workout")
    ? "rgba(52,211,153,OPACITY)" : "rgba(124,108,230,OPACITY)");
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

// Закрыть любую зависшую форму редактирования (упражнение/мышца/движение —
// см. .ref-form-backdrop) сразу, не дожидаясь следующего goToScreen. На iOS
// PWA страница не перезагружается при сворачивании — она замирает как есть
// и потом просто "просыпается" с тем же DOM; если форма осталась открытой,
// без этой чистки она осталась бы видна(!) при возврате в приложение (мигание
// перед тем, как её на следующем переходе экрана всё равно уберёт goToScreen —
// сама чистка в goToScreen синхронна и мигать не может, а вот "оживший" при
// возврате в приложение кадр с формой — может).
function closeStaleExerciseForms() {
  document.querySelectorAll(".ref-form-backdrop").forEach(bd => bd.remove());
}

// Сворачивание приложения / уход со страницы — пробуем дослать всё
// несинхронизированное прямо сейчас, не дожидаясь обычной задержки
// (раздел 6.1: активная тренировка должна переживать переключение приложений).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { SyncQueue.flush(); closeStaleExerciseForms(); }
});
window.addEventListener("pagehide", () => { SyncQueue.flush(); closeStaleExerciseForms(); });

/* ==========================================================================
   Screen switching
   ========================================================================== */
const SCREENS = { profile: screenProfile, menu: screenMenu, workout: screenWorkout, run: screenRun, exercises: screenExercises, exerciseDetail: $("screen-exercise-detail"), muscleDetail: $("screen-muscle-detail"), history: $("screen-history"), detail: $("screen-detail"), stats: $("screen-stats"), statChart: $("screen-stat-chart"), templates: $("screen-templates"), constructor: $("screen-constructor") };

function goToScreen(name, opts = {}) {
  // Формы редактирования никогда не должны быть местом, куда можно "вернуться
  // назад" — если экран меняется, пока форма открыта, закрываем её сразу
  // (см. closeStaleExerciseForms — тот же приём и на сворачивание приложения).
  closeStaleExerciseForms();

  // opts.instant — переключить БЕЗ кроссфейд-анимации (0.32s). Нужно, когда
  // переключение происходит под перекрывающей шторкой: иначе, сняв шторку, мы
  // увидели бы недоигранный кроссфейд (вспышку прежнего экрана) — см. заход в
  // карточку мышцы из справочника (п. про мигание).
  const allScreens = Object.values(SCREENS).filter(Boolean);
  if (opts.instant) allScreens.forEach(s => { s.style.transition = "none"; });
  allScreens.forEach(s => s.classList.remove("active"));
  const target = SCREENS[name];
  if (!target) { if (opts.instant) allScreens.forEach(s => { s.style.transition = ""; }); return; }
  target.classList.add("active");
  if (opts.instant) {
    void target.offsetWidth;  // применить мгновенное состояние до восстановления перехода
    requestAnimationFrame(() => allScreens.forEach(s => { s.style.transition = ""; }));
  }

  // "profile" сюда сознательно НЕ включён (в отличие от остальных экранов):
  // renderProfiles() — асинхронная и решает, что показать (переключатель/форма
  // входа/тихий автовход), а не мгновенный синхронный рендер как у других
  // экранов. Раньше он тоже дёргался отсюда — из-за этого при переходах,
  // которые сами уже дожидались renderProfiles() ПЕРЕД goToScreen (см.
  // auth-ui.js switch-user-btn), полная загрузка происходила ДВАЖДЫ подряд:
  // сначала правильно (до перехода), потом ещё раз отсюда (уже на экране,
  // с новой вспышкой «Загрузка…» поверх). Теперь каждый вызывающий код сам
  // явно вызывает renderProfiles() — см. вызовы этой функции в auth-ui.js.
  if (name === "menu")     { refreshMenu(); }
  if (name === "workout")  { initWorkoutScreen(opts); }
  if (name === "run")      { initRunScreen(opts); }
  if (name === "exercises") { if (opts.keepFilter) renderExercisesList(exercisesSearch.value); else initExercisesScreen(); }
  if (name === "history")  { initHistoryScreen(); }
  if (name === "stats")    { initStatsScreen(); }
  if (name === "templates") { initTemplatesScreen(); }
  if (name === "constructor" && window.CONSTRUCTOR) { CONSTRUCTOR.init(); }
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
  const label = workout.name || (workout.type === "run" ? "Пробежка" : "Силовая тренировка");
  openConfirmModal({
    title: "Удалить тренировку?",
    message: `«${label}» (${fmtDate(workout.startedAt)}) будет удалена. Вернуть можно в настройках → «Недавно удалённые».`,
    confirmLabel: "Удалить",
    onConfirm: () => doDeleteWorkout(workout, rerender, label),
  });
}
function doDeleteWorkout(workout, rerender, label) {
  const userId = DATA.getCurrentUser();
  // Снимки для отката.
  const histSnap = [...DATA.getWorkoutHistory(userId)];
  const idxSnap  = [...DATA.getWorkoutIndex(userId)];
  const recSnap  = JSON.parse(JSON.stringify(DATA.getRecords(userId)));
  const binId = workout._remoteBinId; // удалим и сам бин на JSONBin (если не отменят)
  // В корзину — полная тренировка + её запись индекса (для восстановления на неделю).
  const idxEntry = DATA.getWorkoutIndex(userId).find(e => e.id === workout.id) || null;
  const trashId = Trash.push(userId, { type: "workout", label, sub: fmtDate(workout.startedAt), data: { workout: JSON.parse(JSON.stringify(workout)), index: idxEntry ? JSON.parse(JSON.stringify(idxEntry)) : null } });
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

  // Быстрая отмена + недельная корзина. При отмене чистим и запись корзины.
  showUndoToast("Тренировка удалена", () => {
    undone = true;
    clearTimeout(purgeTimer);
    Trash.remove(userId, trashId);
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
      // Возвращаем карточку на место и спрашиваем подтверждение (удаление внутри
      // deleteWorkoutWithUndo). Убирается карточка уже при re-render после подтверждения.
      row.style.transition = "transform 0.18s ease"; row.style.transform = "";
      wrap.classList.remove("will-delete");
      setTimeout(() => wrap.classList.remove("swiping"), 200);
      const w = DATA.getWorkoutHistory(DATA.getCurrentUser()).find(x => x.id === wId);
      if (w) deleteWorkoutWithUndo(w, rerender);
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

// «Недавно удалённые» — корзина на 7 дней со всеми удалёнными элементами и
// восстановлением. Открывается из настроек.
$("recently-deleted-btn").addEventListener("click", () => {
  closeModal(settingsModalBackdrop);
  openRecentlyDeletedSheet();
});

function openRecentlyDeletedSheet() {
  const userId = DATA.getCurrentUser();
  const TYPE_LABEL = { exercise: "Упражнение", muscle: "Мышца", movement: "Движение", category: "Группа", workout: "Тренировка", template: "Шаблон" };
  const bd = document.createElement("div");
  bd.className = "bottom-sheet-backdrop";
  bd.style.cursor = "pointer";
  const close = () => { bd.classList.remove("open"); setTimeout(() => bd.remove(), 300); };
  bd.addEventListener("click", e => { if (e.target === bd) close(); });

  bd.innerHTML = `
    <div class="bottom-sheet ref-sheet">
      <div class="ref-sheet-drag"><div class="bottom-sheet-handle"></div></div>
      <div class="cat-sheet-head">
        <span class="cat-sheet-title">Недавно удалённые</span>
        <button class="trash-clear-btn" id="trash-clear" style="display:none">Очистить</button>
      </div>
      <div class="ref-sheet-list" id="trash-list"></div>
    </div>`;

  const render = () => {
    const items = Trash.all(userId);
    const listEl = bd.querySelector("#trash-list");
    const clearBtn = bd.querySelector("#trash-clear");
    if (clearBtn) clearBtn.style.display = items.length ? "" : "none";
    if (!items.length) {
      listEl.innerHTML = `<p class="exd-empty">Здесь пусто. Сюда попадают удалённые за последние 7 дней элементы — их можно вернуть.</p>`;
      return;
    }
    const dayMs = 24 * 60 * 60 * 1000;
    listEl.innerHTML = items.map(it => {
      const daysLeft = Math.max(0, Math.ceil((TRASH_TTL_MS - (Date.now() - it.deletedAt)) / dayMs));
      const left = daysLeft <= 1 ? "истекает сегодня" : `ещё ${daysLeft} дн.`;
      return `<div class="trash-row-wrap" data-id="${escHtml(it.id)}">
        <div class="trash-row-del">${SVG_REF_TRASH} Удалить навсегда</div>
        <div class="trash-row">
          <div class="trash-row-body">
            <div class="trash-row-name">${escHtml(it.label || "Без названия")}</div>
            <div class="trash-row-meta">${escHtml(it.sub || TYPE_LABEL[it.type] || "")} · ${left}</div>
          </div>
          <button class="trash-restore-btn" data-id="${escHtml(it.id)}">Вернуть</button>
        </div>
      </div>`;
    }).join("");
    listEl.querySelectorAll(".trash-restore-btn").forEach(b => b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (restoreFromTrash(userId, b.dataset.id)) {
        showToast("Восстановлено");
        try { if (typeof window.onAtlasUpdated === "function") window.onAtlasUpdated(); } catch {}
        refreshAfterTrashRestore();
        render();
      } else showToast("Не удалось восстановить");
    }));
    // Свайп влево по строке → удалить безвозвратно (минуя недельное хранение).
    listEl.querySelectorAll(".trash-row-wrap").forEach(wrap => wireTrashSwipe(wrap, userId, render));
  };
  render();

  bd.querySelector("#trash-clear").addEventListener("click", () => {
    openConfirmModal({
      title: "Очистить корзину?",
      message: "Все элементы будут удалены безвозвратно.",
      confirmLabel: "Очистить",
      onConfirm: () => { try { localStorage.removeItem(Trash._key(userId)); } catch {} render(); showToast("Корзина очищена"); },
    });
  });

  document.body.appendChild(bd);
  requestAnimationFrame(() => bd.classList.add("open"));
  const sheetEl = bd.querySelector(".bottom-sheet");
  const dragZone = bd.querySelector(".ref-sheet-drag");
  if (sheetEl && dragZone) wireSheetDragClose(sheetEl, dragZone, close);
}

// Свайп влево по строке корзины → удалить элемент безвозвратно.
function wireTrashSwipe(wrap, userId, rerender) {
  const row = wrap.querySelector(".trash-row");
  if (!row) return;
  const id = wrap.dataset.id;
  let sx = 0, sy = 0, dx = 0, active = false, decided = false, horiz = false;
  const MAX = 130, DEL = 80;
  row.addEventListener("pointerdown", e => {
    if (e.target.closest("button")) return;
    sx = e.clientX; sy = e.clientY; dx = 0; active = true; decided = false; horiz = false;
    row.style.transition = "";
  });
  row.addEventListener("pointermove", e => {
    if (!active) return;
    const mx = e.clientX - sx, my = e.clientY - sy;
    if (!decided) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      decided = true; horiz = mx < 0 && Math.abs(mx) > Math.abs(my);
      if (!horiz) { active = false; return; }
      wrap.classList.add("swiping");
      try { row.setPointerCapture(e.pointerId); } catch {}
    }
    if (!horiz) return;
    dx = Math.max(-MAX, Math.min(0, mx));
    row.style.transform = `translateX(${dx}px)`;
    wrap.classList.toggle("will-delete", dx <= -DEL);
  });
  row.addEventListener("touchmove", e => {
    if (active && horiz && e.cancelable) e.preventDefault();
  }, { passive: false });
  const settle = () => {
    if (!active) return; active = false;
    if (!horiz) return;
    if (dx <= -DEL) {
      row.style.transition = "transform 0.16s ease"; row.style.transform = "translateX(-110%)";
      wrap.style.height = wrap.offsetHeight + "px";
      requestAnimationFrame(() => { wrap.style.transition = "height 0.16s ease, opacity 0.16s ease"; wrap.style.height = "0"; wrap.style.opacity = "0"; });
      setTimeout(() => { Trash.remove(userId, id); showToast("Удалено навсегда"); rerender(); }, 170);
    } else {
      row.style.transition = "transform 0.18s ease"; row.style.transform = "";
      wrap.classList.remove("will-delete");
      setTimeout(() => wrap.classList.remove("swiping"), 200);
    }
  };
  row.addEventListener("pointerup", settle);
  row.addEventListener("pointercancel", settle);
}

// Обновить видимый экран после восстановления из корзины (best-effort).
function refreshAfterTrashRestore() {
  try { if (SCREENS.menu && SCREENS.menu.classList.contains("active")) refreshMenu(); } catch {}
  try { if (SCREENS.exercises && SCREENS.exercises.classList.contains("active") && typeof exercisesSearch !== "undefined") renderExercisesList(exercisesSearch.value); } catch {}
  try { if (SCREENS.templates && SCREENS.templates.classList.contains("active") && typeof renderTemplatesList === "function") renderTemplatesList(); } catch {}
}

/* ==========================================================================
   Облачная синхронизация теперь автоматическая и построчная (bridge.js →
   db.js → Supabase, реляционная модель). Прежняя ручная Anki-схема (кнопки
   «В облако»/«Из облака», snapshot-блоб в таблице snapshots, разрешение
   конфликтов выбором) удалена из UI: авто-Bridge пишет каждое изменение сам,
   а ручной download старым блобом мог бы затереть свежие данные. Локальный
   файловый экспорт/импорт ниже сохранён как независимая страховка.
   ========================================================================== */

// Переход на экран выбора профиля и сама очистка текущего пользователя —
// теперь в auth-ui.js (второй addEventListener на этой же кнопке): экран
// показывается ТОЛЬКО когда список профилей уже полностью загружен (без
// вспышки «Загрузка…» на самом экране), поэтому порядок действий важен —
// здесь остаётся только закрытие модалки настроек.
$("switch-user-btn").addEventListener("click", () => {
  closeModal(settingsModalBackdrop);
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
    // На низких экранах (телефон в ландшафте) карточки истории прячем — торчит
    // только шапка-ручка («ИСТОРИЯ» + полоска). Её видно и удобно потянуть, и
    // она заведомо выше зоны жеста home-indicator (30px у самого низа на реальном
    // телефоне не поймать). Центральная кнопка центрируется над шторкой.
    if (window.matchMedia("(max-height: 560px)").matches) return sheetH - dragH;
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
  // Поворот экрана: одного resize мало — на момент его срабатывания раскладка
  // (высота шторки, dvh) ещё не устаканилась, и шторка вставала на место только
  // после ухода/возврата на экран. Добиваем несколькими отложенными пересчётами.
  const repositionSoon = () => {
    reposition();
    requestAnimationFrame(reposition);
    setTimeout(reposition, 150);
    setTimeout(reposition, 400);
  };
  window.addEventListener("orientationchange", repositionSoon);
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
// Не null — когда экран тренировки открыт РАДИ ПРАВКИ прошлой тренировки из
// истории (силовой): держит оригинальный объект истории, а _workout при этом —
// его копия-черновик. В этом режиме экран не пишет в активный слот, не крутит
// секундомер и не запускает отдых; «Завершить» превращается в «Сохранить»
// (см. commitWorkoutEdit / cancelWorkoutEdit / applyWorkoutEditorChrome).
let _editingHistory = null;
let _timerInt = null;     // setInterval handle секундомера тренировки

function stopWorkoutTimer() {
  if (_timerInt) { clearInterval(_timerInt); _timerInt = null; }
}

function initWorkoutScreen({ resume = false } = {}) {
  const userId = DATA.getCurrentUser();
  // В режиме правки истории _workout уже подготовлен (копия-черновик в
  // openWorkoutEditor) — НЕ перезатираем его активной тренировкой.
  if (!_editingHistory) _workout = DATA.getActiveWorkout(userId);
  if (!_workout) return;

  $("workout-name-input").value = _workout.name || "Силовая тренировка";
  endRest(false);            // отдых не переживает навигацию — прячем пилюлю
  applyWorkoutEditorChrome(); // подпись кнопок/секундомера под режим (живой vs правка)
  if (!_editingHistory) startWorkoutTimer(); // у прошлой тренировки секундомер не идёт
  renderExerciseList();
  updateSummaryBar();
}

// Открыть прошлую силовую тренировку из истории в полном редакторе заполнения
// (тот же экран, что и во время тренировки). Правим копию — оригинал трогаем
// только при «Сохранить» (commitWorkoutEdit → saveEditedWorkout).
function openWorkoutEditor(workout) {
  _editingHistory = workout;
  _workout = JSON.parse(JSON.stringify(workout));
  goToScreen("workout");
}

// Настроить шапку экрана тренировки под текущий режим. В живом режиме —
// «Завершить» + пульсирующий секундомер; в правке истории — «Сохранить» + дата
// тренировки без пульсации (секундомер прошлой тренировки не идёт).
function applyWorkoutEditorChrome() {
  const finishBtn = $("finish-workout-btn");
  const timerEl   = $("workout-timer");
  const dot       = document.querySelector(".timer-chip-dot");
  if (_editingHistory) {
    finishBtn.textContent = "Сохранить";
    timerEl.textContent   = fmtDate(_workout.startedAt);
    // display:none (а не visibility) — иначе скрытая точка + gap слева сдвигают
    // дату вправо, и она выглядит не по центру пилюли.
    if (dot) dot.style.display = "none";
  } else {
    finishBtn.textContent = "Завершить";
    if (dot) dot.style.display = "";
  }
}

// «Сохранить» в режиме правки истории — записать черновик обратно в историю
// через общий saveEditedWorkout (он же пересчитывает рекорды, шлёт синк,
// обновляет список истории и открывает деталь тренировки).
function commitWorkoutEdit() {
  const userId = DATA.getCurrentUser();
  _workout.name = $("workout-name-input").value || _workout.name || "Силовая тренировка";
  const edited = _workout;
  _editingHistory = null;
  _workout = null;
  exitExEditMode();
  stopWorkoutTimer();
  saveEditedWorkout(edited, userId);
}

// Уйти из редактора истории без сохранения — черновик просто отбрасываем
// (в активный слот он не писался), возвращаемся к просмотру той же тренировки.
function cancelWorkoutEdit() {
  const original = _editingHistory;
  _editingHistory = null;
  _workout = null;
  exitExEditMode();
  stopWorkoutTimer();
  openDetailScreen(original, _detailReturnScreen);
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
  // Правка истории: изменения копятся в черновике в памяти и коммитятся разом
  // по «Сохранить». В активную тренировку и в синк ничего не пишем.
  if (_editingHistory) return;
  carryRemoteBinId(_workout, DATA.getCurrentUser());
  DATA.saveActiveWorkout(DATA.getCurrentUser(), _workout);
  SyncQueue.push("workout:update", { workoutId: _workout.id });
}

/* — Кнопки шапки — */
$("workout-back-btn").addEventListener("click", () => {
  if (_editingHistory) { cancelWorkoutEdit(); return; } // выход из правки истории без сохранения
  endRest(true);      // зачесть текущий отдых, прежде чем уйти с экрана
  saveWorkoutState();
  stopWorkoutTimer(); // секундомер на кнопке меню сам покажет время активной тренировки
  goToScreen("menu");
});
$("workout-name-input").addEventListener("input", () => saveWorkoutState());

$("finish-workout-btn").addEventListener("click", () => {
  if (_editingHistory) commitWorkoutEdit(); else finishWorkout();
});

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
    v + ex.sets.filter(s => s.done).reduce((sv, s) => sv + setVolume(s), 0), 0);
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

/* ============================================================
   Корзина «Недавно удалённые» — мягкое удаление на 7 дней.
   Любое удаление в приложении кладёт запись сюда (тип + подпись + данные для
   восстановления). Настройки → «Недавно удалённые» показывает всё в общей куче и
   позволяет вернуть. Просроченные (> 7 дней) вычищаются при каждом чтении.
   ============================================================ */
const TRASH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const Trash = {
  _key: (u) => `train_trash_${u}`,
  all(userId) {
    let arr = [];
    try { arr = JSON.parse(localStorage.getItem(this._key(userId)) || "[]"); } catch {}
    if (!Array.isArray(arr)) arr = [];
    const now = Date.now();
    const fresh = arr.filter(x => x && typeof x.deletedAt === "number" && (now - x.deletedAt) < TRASH_TTL_MS);
    if (fresh.length !== arr.length) { try { localStorage.setItem(this._key(userId), JSON.stringify(fresh)); } catch {} }
    return fresh.sort((a, b) => b.deletedAt - a.deletedAt);
  },
  push(userId, entry) {
    const arr = this.all(userId);
    const rec = Object.assign({ id: "trash_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), deletedAt: Date.now() }, entry);
    arr.unshift(rec);
    try { localStorage.setItem(this._key(userId), JSON.stringify(arr)); } catch {}
    return rec.id;
  },
  get(userId, id) { return this.all(userId).find(x => x.id === id) || null; },
  remove(userId, id) {
    const arr = this.all(userId).filter(x => x.id !== id);
    try { localStorage.setItem(this._key(userId), JSON.stringify(arr)); } catch {}
  },
};

// Восстановление по типу. Каждый обработчик возвращает вставленный элемент в
// нужный список (идемпотентно — не плодит дублей) и досылает событие синка.
const TRASH_RESTORE = {
  exercise(userId, d) {
    if (d.own) { const l = DATA.getOwnExercises(userId); if (!l.some(e => e.id === d.own.id)) l.push(d.own); DATA.saveOwnExercises(userId, l); }
    if (d.exId) DATA.unhideExercise(userId, d.exId);
    SyncQueue.push("exercise:create", {});
  },
  category(userId, d) {
    DATA.addCategory(userId, d.name);
    if (d.color) DATA.setCategoryColor(userId, d.name, d.color);
    SyncQueue.push("user:update", {});
  },
  workout(userId, d) {
    const hist = DATA.getWorkoutHistory(userId);
    if (!hist.some(w => w.id === d.workout.id)) { hist.push(d.workout); DATA.saveWorkoutHistory(userId, hist); }
    if (d.index) { const idx = DATA.getWorkoutIndex(userId); if (!idx.some(e => e.id === d.index.id)) { idx.push(d.index); DATA.saveWorkoutIndex(userId, idx); } }
    DATA.recomputeRecords(userId);
    SyncQueue.push("workout:create", {}); SyncQueue.push("user:update", {});
  },
  template(userId, d) {
    const l = DATA.getTemplates(userId); if (!l.some(t => t.id === d.template.id)) l.push(d.template); DATA.saveTemplates(userId, l);
    SyncQueue.push("template:create", {});
  },
  muscle(userId, d) { trashRestoreRef(userId, "muscle", d); },
  movement(userId, d) { trashRestoreRef(userId, "movement", d); },
};

// Восстановить мышцу/движение: личное — в own-оверлей; общее (админ) — обратно в
// атлас (кэш) и в БД (реконструируем строки по текущим маппингам групп/имён).
function trashRestoreRef(userId, kind, d) {
  if (d.shared) {
    const a = DATA.atlasSnapshot();
    const arr = kind === "muscle" ? a.muscles : a.categories;
    if (!arr.some(x => x.id === d.item.id)) arr.push(d.item);
    (d.links || []).forEach(l => {
      const dup = a.muscleCategoryLinks.some(x => x.muscle === l.muscle && x.category === l.category && (x.bundle || "") === (l.bundle || ""));
      if (!dup) a.muscleCategoryLinks.push(l);
    });
    DATA.commitAtlas(a);
    if (DATA.isAdmin() && typeof DB !== "undefined" && typeof Auth !== "undefined" && Auth.isSignedIn()) {
      trashReinsertSharedToDB(kind, d, DATA.atlasSnapshot()).catch(e => console.warn("restore shared→DB", e));
    }
  } else {
    if (kind === "muscle") { const l = DATA.getOwnMuscles(userId); if (!l.some(x => x.id === d.item.id)) l.push(d.item); DATA.saveOwnMuscles(userId, l); }
    else { const l = DATA.getOwnMovements(userId); if (!l.some(x => x.id === d.item.id)) l.push(d.item); DATA.saveOwnMovements(userId, l); }
  }
}
async function trashReinsertSharedToDB(kind, d, a) {
  const gid = (a.groupRows.find(g => g.name === d.item.group) || {}).id || null;
  if (kind === "muscle") {
    const pos = a.muscles.findIndex(m => m.id === d.item.id);
    await DB.saveAtlasMuscles({ id: d.item.id, name: d.item.name, group_id: gid, visible: !!d.item.visible, bundles: d.item.bundles || [], position: pos });
    const vById = {}; a.categories.forEach(v => { vById[v.name] = v.id; });
    const rows = (d.links || []).filter(l => vById[l.category]).map(l => ({ id: "al_" + d.item.id + "_" + vById[l.category], muscle_id: d.item.id, bundle: l.bundle || "", movement_id: vById[l.category] }));
    if (rows.length) await DB.saveAtlasLinks(rows);
  } else {
    const pos = a.categories.findIndex(m => m.id === d.item.id);
    await DB.saveAtlasMovements({ id: d.item.id, name: d.item.name, group_id: gid, type: d.item.type || "База", position: pos });
    const mById = {}; a.muscles.forEach(m => { mById[m.name] = m.id; });
    const rows = (d.links || []).filter(l => mById[l.muscle]).map(l => ({ id: "al_" + mById[l.muscle] + "_" + d.item.id, muscle_id: mById[l.muscle], bundle: l.bundle || "", movement_id: d.item.id }));
    if (rows.length) await DB.saveAtlasLinks(rows);
  }
}

// Восстановить запись из корзины: применяем обработчик, убираем из корзины,
// перерисовываем текущий экран. Возвращает true при успехе.
function restoreFromTrash(userId, id) {
  const entry = Trash.get(userId, id);
  if (!entry) return false;
  const handler = TRASH_RESTORE[entry.type];
  if (!handler) return false;
  try { handler(userId, entry.data || {}); } catch (e) { console.warn("restore failed", e); return false; }
  Trash.remove(userId, id);
  return true;
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
  if (!evalGroupIntent()) reorderDuringDrag(pointerY);   // в зоне «папки» перестановку не делаем
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
  evalGroupIntent();   // прогреваем dwell «папки», даже когда палец стоит
  d.raf = requestAnimationFrame(autoScrollTick);
}

function startDrag(block, ex, pointerY) {
  if (!_exEdit) enterExEditMode();
  const top = block.getBoundingClientRect().top;
  _drag = { block, ex, grabDy: pointerY - top, ty: 0, pointerY, raf: 0,
            groupBlock: null, groupBoundary: null, groupDwellStart: 0, grouping: false };
  block.style.transition = "none";
  block.classList.add("dragging");
  $("workout-scroll").classList.add("ss-dragging");   // прячем спайны — геометрия «плывёт»
  haptic(18);
  _drag.raf = requestAnimationFrame(autoScrollTick);
}

function endDrag(commit) {
  const d = _drag; if (!d) return;
  // Отпустили «в папке» — собрать суперсет с соседом-кандидатом (он смежен в
  // массиве: свап на dwell мы подавляли, так что индексы i и i±1 актуальны).
  const doGroup = commit && d.grouping && d.groupBlock;
  const boundary = d.groupBoundary;
  _clearGroupIntent();
  _drag = null;
  if (d.raf) cancelAnimationFrame(d.raf);
  const block = d.block;
  block.style.transition = "transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1)";
  block.style.transform = "";
  block.classList.remove("dragging");
  $("workout-scroll").classList.remove("ss-dragging");
  setTimeout(() => { block.style.transition = ""; }, 200);
  if (commit) {
    if (doGroup) {
      const arr = _workout.exercises, i = arr.indexOf(d.ex);
      linkSupersetAt(boundary === "next" ? i : i - 1);   // связать i с соседом
    }
    // После перестановки связка могла порваться (участник уехал из группы) или
    // группа — распасться на одиночку: нормализуем и перерисовываем маркеры.
    normalizeSupersets(); saveWorkoutState();
  }
  applySupersetVisuals();   // всегда: вернуть/пересчитать спайны после драга
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
    if (target.closest(".ex-swap-badge")) return false;    // замена — отдаём клику
    // вне режима не мешаем вводу, кнопкам, свайпу подхода и тапу по названию
    if (!_exEdit && target.closest("input, textarea, button, .set-row, .ex-block-name")) return false;
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

// Тренировка, в которой был поставлен текущий рекорд веса упражнения. Рекорд
// (train_records) хранит только само значение (maxWeight/repsAtMaxWeight), без
// ссылки на тренировку — поэтому ищем её в истории: самый ранний силовой
// подход, где выполнен (не дроп-сет) сет ровно с этим весом и повторами (та же
// проверка, что isPrSet в детали). История отсортирована по убыванию даты, так
// что, перезаписывая match на каждом совпадении, в конце получаем самую раннюю
// тренировку — ту, где рекорд и был впервые установлен. null — если совпадения
// нет (например, рекорд только что поставлен в текущей, ещё не сохранённой).
function findPrWorkout(userId, exerciseId, rec) {
  if (!rec || rec.maxWeight == null) return null;
  let match = null;
  DATA.getWorkoutHistory(userId).forEach(w => {
    if (w.type !== "strength") return;
    const ex = (w.exercises || []).find(e => e.exerciseId === exerciseId);
    if (!ex) return;
    const hit = (ex.sets || []).some(s =>
      s.done && !s.dropSet && s.weight === rec.maxWeight && s.reps === rec.repsAtMaxWeight);
    if (hit) match = w;
  });
  return match;
}

/* ============================================================
   Суперсеты — связка «без отдыха» из подряд идущих упражнений.
   Модель: у блока тренировки поле ex.supersetId. Суперсет = максимальный
   непрерывный отрезок блоков в _workout.exercises с одинаковым непустым
   supersetId. Массив остаётся плоским (история/статистика/синк не трогаются),
   порядок в нём = порядок внутри связки.
   Инвариант: supersetId ⟺ непрерывная группа. Его держит normalizeSupersets,
   которую зовём после любой структурной правки (связать/разорвать/переставить/
   удалить). Одиночка суперсетом не считается — его id обнуляется.
   ============================================================ */
function _newSsId() { return "ss_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

// Индексы непрерывного отрезка вокруг i с тем же непустым supersetId.
function _ssRun(arr, i) {
  const id = arr[i] && arr[i].supersetId;
  if (!id) return [i];
  let a = i, b = i;
  while (a > 0 && arr[a - 1].supersetId === id) a--;
  while (b < arr.length - 1 && arr[b + 1].supersetId === id) b++;
  const r = []; for (let k = a; k <= b; k++) r.push(k);
  return r;
}

// Привести supersetId к инварианту: каждой непрерывной группе — свежий общий id,
// одиночкам — null. Опирается на текущий порядок массива.
function normalizeSupersets() {
  const arr = _workout && _workout.exercises || [];
  let k = 0;
  while (k < arr.length) {
    const id = arr[k].supersetId;
    if (!id) { k++; continue; }
    let j = k;
    while (j + 1 < arr.length && arr[j + 1].supersetId === id) j++;
    if (j === k) arr[k].supersetId = null;                 // одиночка
    else { const nid = _newSsId(); for (let t = k; t <= j; t++) arr[t].supersetId = nid; }
    k = j + 1;
  }
}

// Связать блок i со следующим (i+1) — объединяет и их уже существующие связки.
function linkSupersetAt(i) {
  const arr = _workout.exercises;
  if (i < 0 || i + 1 >= arr.length) return;
  const id = arr[i].supersetId || arr[i + 1].supersetId || _newSsId();
  const runL = _ssRun(arr, i), runR = _ssRun(arr, i + 1);
  const lo = Math.min(runL[0], i), hi = Math.max(runR[runR.length - 1], i + 1);
  for (let k = lo; k <= hi; k++) arr[k].supersetId = id;
  normalizeSupersets();
}

// Разорвать связь между i и i+1 (правой части — свежий id, дальше нормализация).
function unlinkSupersetAt(i) {
  const arr = _workout.exercises;
  if (!(arr[i] && arr[i + 1] && arr[i].supersetId && arr[i].supersetId === arr[i + 1].supersetId)) return;
  const id = arr[i].supersetId, nid = _newSsId();
  for (let k = i + 1; k < arr.length && arr[k].supersetId === id; k++) arr[k].supersetId = nid;
  normalizeSupersets();
}

// Проставить класс участника суперсета и перерисовать спайны-оверлеи по текущему
// состоянию. Порядок .ex-block в DOM == _workout.exercises (драг двигает и массив,
// и DOM синхронно), поэтому индекс блока = индекс упражнения.
function applySupersetVisuals() {
  if (!_workout) return;
  const scroll = $("workout-scroll");
  const blocks = [...scroll.querySelectorAll(".ex-block")];
  const arr = _workout.exercises || [];
  blocks.forEach((b, i) => {
    const ex = arr[i]; if (!ex) return;
    b.classList.toggle("ss-member", !!ex.supersetId);   // отступ вправо под спайн
  });
  layoutSupersetSpines();     // немедленно — когда layout уже устоялся (обычный случай)
  scheduleSpineLayout();      // и повтор в след. кадре: первый синхронный замер после
                              // рендера/смены шрифта бывает неточным (см. offsetHeight)
}

// Спайн суперсета — не псевдоэлемент на блоках (одну надпись «СУПЕРСЕТ» на всю
// группу так не отцентрировать), а отдельный absolute-оверлей на группу: меряем
// первый/последний блок непрерывного отрезка и кладём .ss-spine в .workout-scroll
// (он position:relative → оверлей скроллится с содержимым). Флекс-колонка внутри
// центрирует надпись: сегмент линии → слово → сегмент линии.
function layoutSupersetSpines() {
  const scroll = $("workout-scroll");
  if (!scroll) return;
  scroll.querySelectorAll(".ss-spine").forEach(el => el.remove());
  if (!_workout) return;
  const blocks = [...scroll.querySelectorAll(".ex-block")];
  const arr = _workout.exercises || [];
  let i = 0;
  while (i < blocks.length) {
    const id = arr[i] && arr[i].supersetId;
    if (!id) { i++; continue; }
    let j = i;
    while (j + 1 < blocks.length && arr[j + 1] && arr[j + 1].supersetId === id) j++;
    const first = blocks[i], last = blocks[j];
    const top = first.offsetTop;
    const spine = document.createElement("div");
    spine.className = "ss-spine";
    spine.style.top = top + "px";
    spine.style.height = ((last.offsetTop + last.offsetHeight) - top) + "px";
    spine.innerHTML = `<span class="ss-spine-seg"></span><span class="ss-spine-label">Суперсет</span><span class="ss-spine-seg"></span>`;
    scroll.appendChild(spine);
    i = j + 1;
  }
}

// Пересчёт спайнов в следующем кадре, дебаунс одним rAF. Нужен и как «повтор после
// осадки» (см. applySupersetVisuals), и для ResizeObserver.
let _ssRO = null, _ssROraf = 0;
function scheduleSpineLayout() {
  if (_ssROraf) cancelAnimationFrame(_ssROraf);
  _ssROraf = requestAnimationFrame(layoutSupersetSpines);
}

// Высота блоков меняется не только структурно (добавить подход, раскрыть заметку),
// поэтому держим спайны в актуальной геометрии через ResizeObserver — иначе линия
// группы отставала бы от реальной высоты.
function observeSupersetLayout() {
  const scroll = $("workout-scroll");
  if (!scroll) return;
  if (!_ssRO) _ssRO = new ResizeObserver(scheduleSpineLayout);
  _ssRO.disconnect();
  scroll.querySelectorAll(".ex-block").forEach(b => _ssRO.observe(b));
}

// Драг-группировка «папкой»: пока тащим блок и глубоко (в центральной зоне соседа)
// зависаем на нём GROUP_DWELL мс — сосед подсвечивается, и отпускание собирает
// суперсет. Мелкое пересечение середины — как раньше, просто перестановка. Возврат
// true = мы в зоне группировки, свап на этом кадре подавляем (см. dragMoveTo).
const GROUP_DWELL = 340;    // мс удержания в центре соседа для «папки»
const GROUP_BAND  = 0.30;   // доля высоты соседа вокруг его центра
function evalGroupIntent() {
  const d = _drag; if (!d) return false;
  const dc = (d.pointerY - d.grabDy) + d.block.getBoundingClientRect().height / 2;
  let hit = null;
  for (const [nb, dir] of [[d.block.previousElementSibling, "prev"], [d.block.nextElementSibling, "next"]]) {
    if (!nb || !nb.classList.contains("ex-block")) continue;
    const r = nb.getBoundingClientRect();
    if (Math.abs(dc - (r.top + r.height / 2)) <= r.height * GROUP_BAND) { hit = [nb, dir]; break; }
  }
  if (!hit) { _clearGroupIntent(); return false; }
  const [nb, dir] = hit;
  if (d.groupBlock !== nb) {                       // зашли на нового кандидата — копим dwell
    _clearGroupIntent();
    d.groupBlock = nb; d.groupBoundary = dir; d.groupDwellStart = performance.now();
  } else if (!d.grouping && performance.now() - d.groupDwellStart >= GROUP_DWELL) {
    d.grouping = true; nb.classList.add("ss-group-cand"); haptic(18);
  }
  return true;
}
function _clearGroupIntent() {
  const d = _drag; if (!d) return;
  if (d.groupBlock) d.groupBlock.classList.remove("ss-group-cand");
  d.groupBlock = null; d.groupBoundary = null; d.groupDwellStart = 0; d.grouping = false;
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

    // Рекорд веса — компактный бейдж в шапке (как в макете 03). Вес может
    // быть отрицательным (упражнения с помощью) — рекорд есть, если он вообще
    // был поставлен хоть раз (см. applySetToRecord: null = рекорда ещё нет).
    let prChip = "";
    if (rec && rec.maxWeight != null) {
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
      <button class="ex-swap-badge" title="Заменить упражнение" aria-label="Заменить упражнение">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
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
        <button class="set-dropset-btn" title="Добавить дроп-сет (тот же подход со сброшенным весом сразу после)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="15" y2="12"/><line x1="4" y1="18" x2="10" y2="18"/></svg>
        </button>
        <button class="set-note-btn ${ex.note ? "has-note" : ""}" title="Заметка">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L13 14l-4 1 1-4 6.5-6.5z"/></svg>
        </button>
      </div>
    `;

    // Блок вставляем в DOM ДО рендера подходов. Дерево дроп-сетов (wireDropTree
    // внутри renderSetsInBlock) меряет поля через getBoundingClientRect, а у
    // detached-элемента все размеры = 0 → ширины схлопывались (кг → минимум,
    // повт → 0), ствол вставал не на место. Это и был баг «при повторном
    // открытии тренировки»: здесь блок строится с нуля (detached), тогда как
    // при добавлении подхода/дроп-сета renderSetsInBlock звался уже на
    // вставленном блоке — поэтому там всё считалось верно.
    scroll.insertBefore(block, addBtn);

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
          normalizeSupersets();     // удаление могло оставить одиночку от связки
          saveWorkoutState();
          applySupersetVisuals();
          updateSummaryBar();
          if (!_workout.exercises.length) exitExEditMode();
        }
      });
    });

    // Замена упражнения (в режиме редактирования, рядом с крестиком) — ТОЛЬКО в
    // этой тренировке: меняем exerciseId/имя, подходы (вес/повторы) сохраняются.
    // В правке истории коммитится по «Сохранить» (там пересчитываются рекорды),
    // в живой тренировке — уходит в активный черновик через saveWorkoutState.
    block.querySelector(".ex-swap-badge").addEventListener("click", (e) => {
      e.stopPropagation();
      openExercisePicker(newId => {
        if (!newId || newId === ex.exerciseId) return;
        const newEx = DATA.getVisibleExercises(userId).find(x => x.id === newId);
        ex.exerciseId = newId;
        if (newEx) ex.name = newEx.name;
        saveWorkoutState();
        renderExerciseList();     // сбрасывает режим правки и перерисовывает
        updateSummaryBar();
        showToast("Упражнение заменено");
      }, ex.exerciseId);
    });

    // Зажатие (long-press) → режим перестановки; в нём блок тащится вверх/вниз,
    // а зависание «в папке» на соседе собирает суперсет (см. evalGroupIntent).
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

    // Add drop-set — то же упражнение сразу со сброшенным весом, без отдыха
    // между ним и предыдущим подходом. Помечается ex.sets[i].dropSet=true:
    // считается в тоннаж (реальная работа), но не в рекорды (см. applySetToRecord)
    // и не потеряется к следующей тренировке, как терялось бы при обычном подходе.
    block.querySelector(".set-dropset-btn").addEventListener("click", () => {
      if (!ex.sets.length) { showToast("Сначала добавь обычный подход"); return; }
      haptic();
      const last = ex.sets[ex.sets.length - 1];
      // done:true сразу — у дроп-сета нет своей галочки (это же усилие, что и
      // основной подход, отмечать отдельно и прерываться на это незачем).
      ex.sets.push({ weight: last.weight, reps: 0, rpe: 0, done: true, dropSet: true });
      saveWorkoutState();
      renderSetsInBlock(block, ex, lastWorkout);
      updateSummaryBar();
    });

    // Тап по названию упражнения → его детальная карточка (визуально это тот же
    // текст, просто кликабельный). В режиме перестановки блоков не реагируем.
    // Возврат — на экран тренировки. Недоступное упражнение (нет в справочнике)
    // openExerciseDetail просто проигнорирует.
    const nameEl = block.querySelector(".ex-block-name");
    if (nameEl) nameEl.addEventListener("click", (e) => {
      e.stopPropagation();
      if (scroll.classList.contains("ex-editing")) return;
      openExerciseDetail(ex.exerciseId, "workout");
    });

    // Тап по бейджу-рекорду (звёздочке) → открыть тренировку, где рекорд был
    // поставлен. Визуально бейдж не меняем. stopPropagation — чтобы тап не
    // спутался с long-press-перетаскиванием блока; в режиме правки (бейдж скрыт)
    // не реагируем. Возврат — на экран тренировки (кнопка «назад» в детали).
    const prChipEl = block.querySelector(".ex-pr-chip");
    if (prChipEl) {
      prChipEl.style.cursor = "pointer";
      prChipEl.addEventListener("click", (e) => {
        e.stopPropagation();
        if (scroll.classList.contains("ex-editing")) return;
        const prWorkout = findPrWorkout(userId, ex.exerciseId, rec);
        if (prWorkout) openDetailScreen(prWorkout, "workout", ex.exerciseId);
        else showToast("Рекорд поставлен в текущей тренировке");
      });
    }

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
    // (Блок уже вставлен в DOM выше — до renderSetsInBlock, см. комментарий там.)
  });

  // Спайны суперсетов по всем блокам разом — после того как все .ex-block уже в
  // DOM в порядке _workout.exercises; и переподписываем ResizeObserver на блоки,
  // чтобы линия группы следила за их высотой (добавленный подход, заметка).
  applySupersetVisuals();
  observeSupersetLayout();
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

  // Нумерация — только у обычных подходов (дроп-сет и так понятен по отступу,
  // отдельный номер ему не нужен, см. .set-dropset-btn).
  let mainNum = 0;
  const labels = ex.sets.map(s => { if (s.dropSet) return ""; mainNum++; return `${mainNum}`; });

  // Основной подход + все его дроп-сеты идут в общей обёртке .set-group —
  // так их можно измерить и связать линией-деревом одним блоком (см.
  // wireDropTree), и она не путается с деревом соседнего подхода.
  let group = null;

  ex.sets.forEach((set, sIdx) => {
    const prev = lastSets[sIdx];
    const wrap = document.createElement("div");
    wrap.className = "set-row-wrap" + (set.dropSet ? " set-row-wrap-drop" : "");
    const del = document.createElement("div");
    del.className = "set-row-delete";
    del.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg><span>Удалить</span>`;
    const row = document.createElement("div");
    row.className = "set-row";
    // Дроп-сет — без номера, RPE и галочки "выполнено": это то же усилие, что
    // и основной подход (тут не прерываются отмечать его отдельно, отдыха
    // между ними по смыслу нет — засчитывается выполненным сразу при
    // добавлении, см. .set-dropset-btn), только кг/повт, подвешенные на
    // линии от веса основного подхода (см. wireDropTree).
    row.innerHTML = set.dropSet ? `
      <div class="set-drop-fields">
        <div class="set-field set-field-weight set-field-weight-mini${(set.weight || 0) < 0 ? " negative" : ""}">
          <button type="button" class="set-sign-btn" title="Минус — для упражнений с помощью (гравитрон и т.п.)">±</button>
          <input type="number" inputmode="decimal" placeholder="кг" value="${set.weight || ""}" step="0.5">
        </div>
        <div class="set-field set-field-reps-mini"><input type="number" inputmode="numeric" placeholder="повт" value="${set.reps || ""}"></div>
      </div>
    ` : `
      <span class="set-num">${labels[sIdx]}</span>
      <div class="set-field set-field-weight${(set.weight || 0) < 0 ? " negative" : ""}">
        <button type="button" class="set-sign-btn" title="Минус — для упражнений с помощью (гравитрон и т.п.): чем ближе к нулю, тем лучше результат">±</button>
        <input type="number" inputmode="decimal" placeholder="${prev ? prev.weight : "кг"}" value="${set.weight || ""}" step="0.5" ${prev ? 'class="has-prev"' : ""}>
      </div>
      <div class="set-field"><input type="number" inputmode="numeric" placeholder="${prev ? prev.reps : "повт"}" value="${set.reps || ""}" ${prev ? 'class="has-prev"' : ""}></div>
      <button class="rpe-btn ${set.rpe ? "has-rpe" : ""}" aria-label="RPE — усилие подхода" title="RPE — усилие подхода">${set.rpe ? set.rpe : (prev && prev.rpe ? `<span class="rpe-ghost">${prev.rpe}</span>` : "—")}</button>
      <button class="set-done-btn ${set.done ? "done" : ""}" title="Отметить выполненным">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </button>
    `;

    // Weight input
    const weightInput = row.querySelectorAll("input")[0];
    const weightField = row.querySelector(".set-field-weight");
    const markNegative = () => weightField.classList.toggle("negative", (parseFloat(weightInput.value) || 0) < 0);
    weightInput.addEventListener("change", () => {
      ex.sets[sIdx].weight = parseFloat(weightInput.value) || 0;
      markNegative();
      saveWorkoutState(); updateSummaryBar();
    });
    // ± — переключить знак веса. Нужно для упражнений с помощью (гравитрон
    // и т.п.): виртуальная цифровая клавиатура (inputmode="decimal") на
    // многих устройствах не даёт набрать "-", поэтому это единственный
    // надёжный способ ввести отрицательный вес независимо от клавиатуры.
    row.querySelector(".set-sign-btn").addEventListener("click", () => {
      const next = -(parseFloat(weightInput.value) || 0);
      weightInput.value = next || "";
      ex.sets[sIdx].weight = next;
      markNegative();
      saveWorkoutState(); updateSummaryBar();
    });

    // Reps input
    const repsInput = row.querySelectorAll("input")[1];
    repsInput.addEventListener("change", () => {
      ex.sets[sIdx].reps = parseInt(repsInput.value) || 0;
      saveWorkoutState(); updateSummaryBar();
    });

    // RPE button — только у обычных подходов (индекс упражнения берём живым:
    // блоки могут переставляться, чтобы пикер писал RPE именно в него).
    const rpeBtn = row.querySelector(".rpe-btn");
    if (rpeBtn) rpeBtn.addEventListener("click", () => {
      openRpePicker(_workout.exercises.indexOf(ex), sIdx);
    });

    // Done toggle — у дроп-сета кнопки нет (см. выше), он уже done с момента добавления.
    const doneBtn = row.querySelector(".set-done-btn");
    if (doneBtn) doneBtn.addEventListener("click", () => {
      haptic();
      // Snag current input values before toggling
      ex.sets[sIdx].weight = parseFloat(weightInput.value) || 0;
      ex.sets[sIdx].reps   = parseInt(repsInput.value) || 0;
      ex.sets[sIdx].done   = !ex.sets[sIdx].done;
      // Отдых — только в живой тренировке. При правке истории таймер отдыха не
      // нужен и не должен доначислять restSec старой тренировки.
      if (ex.sets[sIdx].done && !_editingHistory) startRest(); // подход выполнен — пошёл отдых
      saveWorkoutState();
      renderSetsInBlock(block, ex, lastWorkout);
      updateSummaryBar();
    });

    // Свайп влево по строке → удалить подход (п.7). Удаляем по ссылке на объект
    // подхода: индексы после ре-рендера сдвигаются. У дроп-сета жест ловим по
    // ВСЕЙ ширине строки (включая пустую область слева от полей — так его легко
    // нащупать, не попадая в узкие поля-инпуты), а ехать под пальцем должен
    // только блок полей .set-drop-fields (см. wireDropTree — он же и совпадает
    // с красной подложкой). У обычного подхода ловим и двигаем всю строку.
    wrap.appendChild(del);
    wrap.appendChild(row);
    const moveEl = set.dropSet ? row.querySelector(".set-drop-fields") : row;
    wireSetRowSwipe(wrap, row, () => {
      const i = ex.sets.indexOf(set);
      if (i === -1) return;
      // Удаление ОСНОВНОГО подхода утягивает за собой все его дроп-сеты
      // каскадом — иначе они остались бы в массиве и "перепривязались" бы
      // визуально к соседнему предыдущему подходу (это то же самое усилие,
      // без основного подхода дроп-сеты сами по себе смысла не имеют).
      let count = 1;
      if (!set.dropSet) {
        while (ex.sets[i + count] && ex.sets[i + count].dropSet) count++;
      }
      ex.sets.splice(i, count);
      saveWorkoutState();
      renderSetsInBlock(block, ex, lastWorkout);
      updateSummaryBar();
      showToast(set.dropSet ? "Дроп-сет удалён" : (count > 1 ? "Подход и его дроп-сеты удалены" : "Подход удалён"));
    }, moveEl);

    if (!set.dropSet || !group) {
      group = document.createElement("div");
      group.className = "set-group";
      tbody.appendChild(group);
    }
    group.appendChild(wrap);
  });

  // Линии-деревья от веса основного подхода к его дроп-сетам — считаются от
  // реальных координат (см. wireDropTree), поэтому делаем это ПОСЛЕ того, как
  // все строки уже в DOM и их можно измерить.
  tbody.querySelectorAll(".set-group").forEach(wireDropTree);
}

// Соединяет основной подход с его дроп-сетами линией-деревом (см. набросок
// пользователя): вертикальный "ствол" стартует РОВНО по центру поля веса
// основного подхода, горизонтальные "ветки" ведут к каждому дроп-сету, а его
// "повт" заканчивается РОВНО там же, где заканчивается RPE основного подхода.
// Считаем через getBoundingClientRect (не фиксированные px) — иначе слетает
// при другой ширине экрана.
function wireDropTree(group) {
  group.querySelectorAll(".set-drop-trunk, .set-drop-branch").forEach(el => el.remove());
  const mainWrap = group.querySelector(".set-row-wrap:not(.set-row-wrap-drop)");
  const dropWraps = [...group.querySelectorAll(".set-row-wrap-drop")];
  if (!mainWrap || !dropWraps.length) return;

  const groupRect = group.getBoundingClientRect();
  // Detached/скрытый блок меряется в нули — тогда все ширины схлопнулись бы в
  // мусор (кг→минимум, повт→0, ствол в левый край). Не трогаем разметку, пока
  // блок реально не в потоке (страховка; штатно блок вставляется в DOM ещё до
  // рендера — см. renderExerciseList).
  if (!groupRect.width) return;
  const weightRect = mainWrap.querySelector(".set-field-weight").getBoundingClientRect();
  const rpeRect = mainWrap.querySelector(".rpe-btn").getBoundingClientRect();
  const trunkX = weightRect.left + weightRect.width / 2 - groupRect.left;
  const endX = rpeRect.right - groupRect.left;

  const BRANCH_GAP = 14; // расстояние от ствола до первого поля мини-подхода
  const FIELD_GAP = 6;
  const startX = trunkX + BRANCH_GAP;
  const totalW = Math.max(0, endX - startX);
  // MIN_WEIGHT_W — чтобы кнопке "±" (см. CSS .set-field-weight-mini .set-sign-btn)
  // всегда хватало места и поле не сжималось у́же неё на узких экранах.
  const MIN_WEIGHT_W = 46;
  const weightW = Math.max(MIN_WEIGHT_W, Math.round(totalW * 0.42)); // кг короче повт
  const repsW = Math.max(0, totalW - weightW - FIELD_GAP);

  dropWraps.forEach(w => {
    const fields = w.querySelector(".set-drop-fields");
    fields.style.marginLeft = startX + "px";
    // Ширину блока полей фиксируем ровно по содержимому (кг + зазор + повт).
    // Без этого flex-контейнер растягивается на всю ширину строки, и его
    // непрозрачный фон (см. CSS .set-drop-fields) тянется ВПРАВО за "повт" до
    // края карточки — при свайпе он перекрывал красную подложку, из-за чего
    // между "повт" и красной плашкой "Удалить" зиял пустой зазор. Теперь правый
    // край блока совпадает с концом "повт", и красное открывается сразу за ним.
    fields.style.width = (weightW + FIELD_GAP + repsW) + "px";
    fields.querySelector(".set-field-weight-mini").style.width = weightW + "px";
    fields.querySelector(".set-field-reps-mini").style.width = repsW + "px";
    // Зона свайпа/удаления (красная подложка) — под реальными полями, а не
    // во всю строку: иначе она осталась бы там, где поля были в старой
    // раскладке, и не совпадала бы с тем, что реально видно.
    const del = w.querySelector(".set-row-delete");
    if (del) {
      del.style.left = startX + "px";
      del.style.right = "auto"; // иначе right:0 из inset (см. CSS) и left вместе растянут блок на всю ширину
      del.style.width = (weightW + FIELD_GAP + repsW) + "px";
    }
  });

  const mainBottom = mainWrap.getBoundingClientRect().bottom - groupRect.top;
  const lastRect = dropWraps[dropWraps.length - 1].getBoundingClientRect();
  const lastCenterY = lastRect.top + lastRect.height / 2 - groupRect.top;

  const trunk = document.createElement("div");
  trunk.className = "set-drop-trunk";
  trunk.style.left = trunkX + "px";
  trunk.style.top = mainBottom + "px";
  trunk.style.height = Math.max(0, lastCenterY - mainBottom) + "px";
  group.appendChild(trunk);

  dropWraps.forEach(w => {
    const r = w.getBoundingClientRect();
    const centerY = r.top + r.height / 2 - groupRect.top;
    const branch = document.createElement("div");
    branch.className = "set-drop-branch";
    branch.style.left = trunkX + "px";
    branch.style.top = centerY + "px";
    branch.style.width = BRANCH_GAP + "px";
    group.appendChild(branch);
  });
}

// Ширина экрана могла смениться (поворот) — пересчитать все видимые деревья.
window.addEventListener("resize", () => {
  document.querySelectorAll(".set-group").forEach(wireDropTree);
});

// Горизонтальный свайп влево по строке подхода → раскрыть зону «Удалить»;
// за порогом отпускания подход удаляется, иначе строка возвращается. Вертикаль
// отдаём скроллу; в режиме перестановки свайп выключен. (п.7)
// row — элемент, НА КОТОРОМ ловим жест (зона касания); tEl — элемент, который
// реально едет под пальцем (по умолчанию тот же). У дроп-сета это разные вещи:
// ловить надо по всей ширине строки (включая пустую область слева от полей —
// иначе касание попадает только в узкие поля-инпуты, а по инпуту свайп мы не
// начинаем, и жест почти невозможно нащупать), а ехать должен только блок полей.
function wireSetRowSwipe(wrap, row, onDelete, tEl = row) {
  let sx = 0, sy = 0, dx = 0, active = false, decided = false, horiz = false, swiped = false;
  const MAX = 132, DEL = 92;
  row.addEventListener("pointerdown", (e) => {
    if (_exEdit) return;
    if (e.target.closest("input")) return;          // правка веса/повторов — не свайп
    sx = e.clientX; sy = e.clientY; dx = 0;
    active = true; decided = false; horiz = false; swiped = false;
    tEl.style.transition = "";
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
      tEl.style.willChange = "transform";
      try { row.setPointerCapture(e.pointerId); } catch {}
    }
    dx = Math.max(-MAX, Math.min(0, mx));            // тянем только влево
    if (dx < -4) swiped = true;
    tEl.style.transform = `translateX(${dx}px)`;
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
      tEl.style.transition = "transform 0.16s ease";
      tEl.style.transform = "translateX(-110%)";
      wrap.style.height = wrap.offsetHeight + "px";
      requestAnimationFrame(() => {
        wrap.style.transition = "height 0.16s ease, opacity 0.16s ease";
        wrap.style.height = "0"; wrap.style.opacity = "0";
      });
      setTimeout(onDelete, 180);
    } else {
      tEl.style.transition = "transform 0.18s ease";
      tEl.style.transform = "";
      wrap.classList.remove("will-delete");
      setTimeout(() => { wrap.classList.remove("swiping"); tEl.style.willChange = ""; }, 200);
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
  const volume   = exs.reduce((v, ex) => v + ex.sets.filter(s => s.done).reduce((sv, s) => sv + setVolume(s), 0), 0);
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

let _pickerGroupExpanded = new Set(); // id раскрытых групп упражнений (аккордеон, как в списке «Упражнения»)

function openExercisePicker(onSelect, selectedId) {
  _pickerOnSelect = onSelect || addExerciseToWorkout;
  _pickerSelectedId = selectedId || null;
  _pickerCat = "Все";
  _pickerGroupExpanded = new Set();
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
  const userId = DATA.getCurrentUser();
  const all = DATA.getVisibleExercises(userId);
  // Поиск ищет по всей базе (вкладка при вводе текста сама сбрасывается на
  // «Все», см. обработчик pickerSearch), иначе — фильтр по выбранной вкладке.
  // Текстовое совпадение — внутри resolveDisplayItems: оно же схлопывает
  // варианты одной группы упражнений в одну строку (см. вкладку «Упражнения»).
  const candidates = q ? all : (_pickerCat && _pickerCat !== "Все" ? all.filter(e => e.cat === _pickerCat) : all);
  const items = DATA.resolveDisplayItems(userId, candidates, q);

  if (!items.length) {
    pickerList.innerHTML = `<p style="padding:24px 16px;color:var(--text-tertiary);font-size:14px">Ничего не найдено</p>`;
    return;
  }

  const SVG_CHECK = `<svg class="picker-item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="20 6 9 17 4 12"/></svg>`;
  const exItemHtml = e => {
    const sel = e.id === _pickerSelectedId;
    const color = DATA.getCategoryColor(userId, e.cat);
    return `
    <div class="picker-item${sel ? " selected" : ""}" data-id="${escHtml(e.id)}" style="--cat-color:${escHtml(color)}">
      <span class="picker-item-name">${escHtml(e.name)}</span>
      ${sel ? SVG_CHECK : ""}
    </div>`;
  };
  const itemHtml = item => {
    if (item.kind !== "group") return exItemHtml(item.ex);
    const color = DATA.getCategoryColor(userId, item.cat);
    const expanded = _pickerGroupExpanded.has(item.id);
    const memberRows = expanded ? item.members.map(exItemHtml).join("") : "";
    return `
    <div class="picker-item-group-wrap${expanded ? " expanded" : ""}" data-group-id="${escHtml(item.id)}" style="--cat-color:${escHtml(color)}">
      <div class="picker-item picker-item-group" data-group-id="${escHtml(item.id)}" style="--cat-color:${escHtml(color)}">
        <span class="picker-item-name">${escHtml(item.name)}</span>
        <span class="picker-item-group-badge">${item.members.length}</span>
      </div>
      <div class="picker-item-group-members">${memberRows}</div>
    </div>`;
  };

  if (!q && _pickerCat !== "Все") {
    // Конкретная категория — плоский список без повторного заголовка.
    pickerList.innerHTML = items.map(itemHtml).join("");
  } else {
    // «Все»/поиск — с разбивкой по категориям (заголовок с цветной точкой).
    const sections = {};
    items.forEach(item => { const cat = item.kind === "group" ? item.cat : item.ex.cat; (sections[cat] = sections[cat] || []).push(item); });
    pickerList.innerHTML = Object.entries(sections).map(([cat, its]) => {
      const color = DATA.getCategoryColor(userId, cat);
      return `<div class="picker-section-label"><span class="picker-section-dot" style="background:${escHtml(color)}"></span>${escHtml(cat)}<span class="picker-section-count">${its.length}</span></div>${its.map(itemHtml).join("")}`;
    }).join("");
  }

  pickerList.querySelectorAll(".picker-item:not(.picker-item-group)").forEach(item => {
    item.addEventListener("click", () => {
      _pickerOnSelect(item.dataset.id);
      closeExercisePicker();
    });
  });

  pickerList.querySelectorAll(".picker-item-group").forEach(item => {
    item.addEventListener("click", () => {
      const groupId = item.dataset.groupId;
      if (_pickerGroupExpanded.has(groupId)) _pickerGroupExpanded.delete(groupId);
      else _pickerGroupExpanded.add(groupId);
      renderPickerList(pickerSearch.value);
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
let _mergeHover = null; // { target, timer, armed } — наведение на цель слияния при перетаскивании (см. moveExDrag)
let _exGroupExpanded = new Set(); // id раскрытых групп упражнений (аккордеон в списке)
// Роли рабочих мышц — фиксированный порядок и подписи для деталей/формы.
const MUSCLE_ROLES = [
  { key: "agonists",     label: "Агонисты", primary: true },
  { key: "synergists",   label: "Синергисты" },
  { key: "stabilizers",  label: "Стабилизаторы" },
  { key: "distributors", label: "Распределители усилий" },
];
// Роли новой модели Атласа ({muscle,bundle}[]) для богатой карточки.
const ATLAS_ROLES = [
  { key: "target",     label: "Целевые",       primary: true },
  { key: "synergist",  label: "Синергисты" },
  { key: "stabilizer", label: "Стабилизаторы", stab: true },
];
const LEVEL_LABELS = { global: "Глобальное", regional: "Региональное", local: "Локальное",
  "глобальные": "Глобальное", "региональные": "Региональное", "локальные": "Локальное" };
const LOAD_LABELS = { weighted: "С отягощением", bodyweight: "Свой вес" };

function initExercisesScreen() {
  exercisesSearch.value = "";
  _exercisesCatFilter = "all";
  _exercisesShowHidden = false;
  _exListEditMode = false;
  _exGroupExpanded = new Set();
  exercisesSearch.placeholder = "Поиск упражнения…";
  const doneBtn = $("exercises-done-btn"); if (doneBtn) doneBtn.classList.remove("visible");
  const addBtn  = $("exercises-add-btn");  if (addBtn)  addBtn.hidden  = false;
  exercisesScroll.scrollTop = 0;
  const userId = DATA.getCurrentUser();
  if (DATA.ensureExercisesSeeded(userId)) SyncQueue.push("exercise:create", {});
  renderExercisesList("");
}

$("exercises-back-btn").addEventListener("click", () => { exitExListEditMode(); goToScreen("menu"); });
exercisesSearch.addEventListener("input", () => renderExercisesList(exercisesSearch.value));
// Шестерёнка → шторка «Справочник»; открывается на вкладке «Группы» (первой).
$("ex-cat-manage-btn").addEventListener("click", () => openReferenceSheet("groups"));

// Порядок групп для справочника: как у пользователя (getAllCategories), но только
// группы Атласа; недостающие добавляем в каноничном порядке.
function atlasOrderedGroups(userId) {
  const all = DATA.getAllCategories(userId);
  const g = DATA.atlasGroups();
  return [...all.filter(x => g.includes(x)), ...g.filter(x => !all.includes(x))];
}

// Личный (own) элемент справочника? id личных мышц — "om_…", движений — "ov_…".
function refItemIsOwn(item) {
  const id = String(item && item.id || "");
  return (item && item.owner != null) || id.startsWith("om_") || id.startsWith("ov_");
}
// Можно ли править элемент: общий — только админ; личный — его владелец (текущий).
function refCanEdit(item) { return DATA.isAdmin() || refItemIsOwn(item); }

const SVG_REF_EDIT  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
// Модульные копии — нужны и рендеру списка, и строителю строки-варианта при
// «живом» раскрытии группы во время перетаскивания (см. memberRowHtml).
const SVG_CHEVRON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>`;
const SVG_DEL_EX = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>`;
// Строка-вариант внутри раскрытой группы (единый шаблон: рендер списка +
// «живое» раскрытие при перетаскивании).
function memberRowHtml(ex, cat) {
  return `
    <div class="ex-row-wrap ex-row-wrap-nested" data-id="${escHtml(ex.id)}" data-cat="${escHtml(cat)}">
      <div class="ex-row-edit-slot">${SVG_REF_EDIT}<span>Изменить</span></div>
      <div class="ex-row-delete">${SVG_DEL_EX} Удалить</div>
      <div class="ex-row tappable" data-id="${escHtml(ex.id)}">
        <span class="ex-row-body">
          <span class="ex-row-name">${escHtml(ex.name)}</span>
        </span>
        <span class="ex-row-chevron">${SVG_CHEVRON}</span>
      </div>
    </div>`;
}
const SVG_REF_TRASH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>`;
const SVG_REF_HIDE  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
const SVG_REF_SHOW  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>`;

// Секция «Скрытые» в режиме правки: общие элементы, которые пользователь скрыл у
// себя. Показываем приглушённо с кнопкой «вернуть» — иначе непонятно, куда делись.
function refHiddenSection(kind, hiddenItems) {
  if (!hiddenItems.length) return "";
  const cards = hiddenItems.map(m => `<div class="ref-card ref-card-editing ref-card-hidden" data-kind="${kind}" data-id="${escHtml(m.id)}">
    <div class="ref-card-top"><span class="ref-card-name">${escHtml(m.name)}</span>
    <span class="ref-card-actions"><button class="ref-card-act" data-act="unhide" title="Вернуть">${SVG_REF_SHOW}</button></span></div></div>`).join("");
  return `<div class="ref-group-label ref-hidden-head">Скрытые · ${hiddenItems.length}</div>${cards}`;
}

// Карточка справочника с обёрткой для двустороннего свайпа — ровно как строки
// упражнений: под карточкой лежат слоты «Изменить» (вправо) и «Удалить/Скрыть»
// (влево). В обычном режиме тап по мышце открывает полноэкранную деталь, по
// движению — раскрывает список мышц на месте. В правке тап ничего не делает —
// правка только через свайп вправо (см. openReferenceSheet). meta — звезда
// (мышца) / бейдж (движение).
function refCardHtml(kind, m, opts) {
  const { editMode, expanded, color, detail, meta } = opts;
  const own = refItemIsOwn(m);
  const canDelete = own || DATA.isAdmin();
  const ownBadge = own ? `<span class="ref-own-badge">моё</span>` : "";
  const chev = editMode ? "" : `<span class="ref-card-chev">${expanded ? "⌄" : "›"}</span>`;
  return `<div class="ref-card-wrap" data-kind="${kind}" data-id="${escHtml(m.id)}">
    <div class="ref-card-edit-slot">${SVG_REF_EDIT}<span>Изменить</span></div>
    <div class="ref-card-del">${canDelete ? SVG_REF_TRASH : SVG_REF_HIDE}<span>${canDelete ? "Удалить" : "Скрыть"}</span></div>
    <div class="ref-card${editMode ? " ref-card-editing" : " ref-card-tap"}${expanded ? " expanded" : ""}" style="border-left-color:${escHtml(color)}">
      <div class="ref-card-top"><span class="ref-card-name">${escHtml(m.name)}</span>${ownBadge}${meta || ""}${chev}</div>${detail}
    </div>
  </div>`;
}

// Детали движения (разворот, инлайн): только работающие мышцы, ОДНИМ столбцом
// (тип уже показан бейджем в шапке карточки — не дублируем).
function movementDetailHtml(mv, muscles) {
  const cells = muscles.length
    ? `<div class="ref-detail-label">Работающие мышцы</div><div class="ref-cells">${muscles.map(mn => `<button class="ref-cell" data-goto="muscle" data-name="${escHtml(mn)}">${escHtml(mn)}</button>`).join("")}</div>`
    : `<div class="ref-detail-empty">Мышцы не заданы</div>`;
  return `<div class="ref-card-detail">${cells}</div>`;
}

// ── Вкладка «Мышцы» шторки-справочника — рендер в переданный контейнер ────────
// Квадратик (не точка) перед группой; тап по карточке открывает полноэкранную
// деталь мышцы (анатомия) — см. openMuscleDetailScreen.
function renderMusclesTab(container, query, opts) {
  opts = opts || {};
  const editMode = !!opts.editMode;
  const userId = DATA.getCurrentUser();
  const q = (query || "").trim().toLowerCase();
  const muscles = DATA.refMuscles(userId);
  const filtered = muscles.filter(m => !q || m.name.toLowerCase().includes(q)
    || (m.bundles || []).some(b => b.toLowerCase().includes(q)));
  const byGroup = {};
  filtered.forEach(m => (byGroup[m.group] = byGroup[m.group] || []).push(m));
  const order = DATA.getRefOrder(userId, "muscle");
  const oIdx = id => { const i = order.indexOf(id); return i === -1 ? Infinity : i; };
  const groups = atlasOrderedGroups(userId).filter(g => byGroup[g]);
  let html = groups.map(g => {
    const color = DATA.getCategoryColor(userId, g);
    byGroup[g].sort((a, b) => oIdx(a.id) - oIdx(b.id));   // пользовательский порядок (drag)
    const cards = byGroup[g].map(m => {
      const star = m.visible ? `<span class="ref-star" title="Поверхностная — рост виден внешне">★</span>` : "";
      return refCardHtml("muscle", m, { editMode, expanded: false, color, detail: "", meta: star });
    }).join("");
    return `<div class="ref-group-label"><span class="ref-sq" style="background:${escHtml(color)}"></span>${escHtml(g)}<span class="ref-count" style="margin-left:auto">${byGroup[g].length}</span></div>${cards}`;
  }).join("");
  if (editMode) {
    const hiddenSet = new Set(DATA.getHiddenMuscleIds(userId));
    html += refHiddenSection("muscle", DATA.atlasMuscles().filter(m => hiddenSet.has(m.id)));
  }
  container.innerHTML = html || `<p class="empty-state">Ничего не найдено</p>`;
}

// ── Вкладка «Движения» шторки-справочника ────────────────────────────────────
function renderMovementsTab(container, query, opts) {
  opts = opts || {};
  const editMode = !!opts.editMode;
  const expandedIds = opts.expandedIds || new Set();
  const userId = DATA.getCurrentUser();
  const q = (query || "").trim().toLowerCase();
  const moves = DATA.refMovements(userId);
  const musByMove = DATA.refMusclesByMove(userId);
  const filtered = moves.filter(m => !q || m.name.toLowerCase().includes(q));
  const byGroup = {};
  filtered.forEach(m => (byGroup[m.group] = byGroup[m.group] || []).push(m));
  const order = DATA.getRefOrder(userId, "movement");
  const oIdx = id => { const i = order.indexOf(id); return i === -1 ? Infinity : i; };
  const groups = atlasOrderedGroups(userId).filter(g => byGroup[g]);
  let html = groups.map(g => {
    const color = DATA.getCategoryColor(userId, g);
    const cards = byGroup[g].slice()
      // База раньше Опции; при заданном пользователем порядке (drag) — он главнее.
      .sort((a, b) => (a.type === b.type ? 0 : a.type === "База" ? -1 : 1))
      .sort((a, b) => oIdx(a.id) - oIdx(b.id))
      .map(m => {
        const badge = m.type === "База" ? `<span class="ref-badge">База</span>` : `<span class="ref-badge opt">Опция</span>`;
        const expanded = !editMode && expandedIds.has(m.id);
        const detail = expanded ? movementDetailHtml(m, [...(musByMove[m.name] || [])]) : "";
        return refCardHtml("movement", m, { editMode, expanded, color, detail, meta: badge });
      }).join("");
    return `<div class="ref-group-label"><span class="ref-sq" style="background:${escHtml(color)}"></span>${escHtml(g)}</div>${cards}`;
  }).join("");
  if (editMode) {
    const hiddenSet = new Set(DATA.getHiddenMovementIds(userId));
    html += refHiddenSection("movement", DATA.atlasMovements().filter(m => hiddenSet.has(m.id)));
  }
  container.innerHTML = html || `<p class="empty-state">Ничего не найдено</p>`;
}

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
      // Сброс прокрутки к началу новой вкладки (как в пикере, см. picker-tab).
      // Иначе после прокрутки вниз по длинной вкладке короткая открывается
      // «пустой» — вьюпорт остаётся под контентом (плюс баг пустого экрана
      // при смене innerHTML на -webkit-overflow-scrolling во время инерции).
      exercisesScroll.scrollTop = 0;
    });
  });
}

function renderExercisesList(query) {
  const userId  = DATA.getCurrentUser();
  const q       = query.trim().toLowerCase();
  const allExs  = DATA.getVisibleExercises(userId); // seeded + personal, единый список

  renderCatTabs(userId, Array.from(new Set(allExs.map(e => e.cat))));

  // Фильтр по вкладке-категории — отдельно от текстового поиска: последний
  // должен учитывать группы упражнений (см. DATA.resolveDisplayItems) —
  // если запрос совпал с ОДНИМ вариантом, показать нужно всю группу целиком,
  // а не только совпавшего участника, поэтому query нельзя резать здесь.
  const tabFiltered = allExs.filter(e => _exercisesCatFilter === "all" || e.cat === _exercisesCatFilter);

  // Группировка по категориям. Порядок категорий — как в списке пользователя,
  // плюс любые «осиротевшие» (встречаются в упражнениях, но нет в списке).
  const catOrder = DATA.getAllCategories(userId);
  const groups = new Map(); // cat -> [ex]
  tabFiltered.forEach(ex => {
    if (!groups.has(ex.cat)) groups.set(ex.cat, []);
    groups.get(ex.cat).push(ex);
  });
  const orderedCats = [
    ...catOrder.filter(c => groups.has(c)),
    ...[...groups.keys()].filter(c => !catOrder.includes(c)),
  ];

  const isFiltered = _exercisesCatFilter !== "all";
  const customOrder = DATA.getExerciseOrder(userId);

  // Пустые категории показываем только на вкладке "Все" и без поиска (для drag-to-category)
  const emptyCats = (!isFiltered && !q) ? catOrder.filter(c => !groups.has(c)) : [];
  const allOrderedCats = [...orderedCats, ...emptyCats];

  if (_exListEditMode) exercisesScroll.classList.add("ex-list-editing");
  else exercisesScroll.classList.remove("ex-list-editing");

  // Ключ сортировки на уровне отображаемых элементов (а не «сырых»
  // упражнений): группа — это один пользовательский элемент со своей
  // позицией в customOrder ("group:<id>"), как и обычное упражнение.
  const orderKey = item => item.kind === "group" ? `group:${item.id}` : item.ex.id;
  const displayName = item => item.kind === "group" ? item.name : item.ex.name;

  const itemsByCat = new Map(); // cat -> display items (для клика по группе после рендера)
  exercisesScroll.innerHTML = allOrderedCats.map(cat => {
    const color = DATA.getCategoryColor(userId, cat);
    const catExs = groups.get(cat) || [];
    const isEmpty = catExs.length === 0;
    const accentStyle = ` style="border-left-color:${escHtml(color)};"`;
    // Стабильная база по имени — дальше пересортировываем уже отображаемые
    // элементы (см. orderKey) пользовательским порядком, если он есть.
    const rawSorted = [...catExs].sort((a, b) => a.name.localeCompare(b.name, "ru"));
    const items = DATA.resolveDisplayItems(userId, rawSorted, q).sort((a, b) => {
      if (customOrder) {
        const ia = customOrder.indexOf(orderKey(a)), ib = customOrder.indexOf(orderKey(b));
        if (ia !== -1 || ib !== -1) {
          if (ia === -1) return 1;
          if (ib === -1) return -1;
          return ia - ib;
        }
      }
      return displayName(a).localeCompare(displayName(b), "ru");
    });
    itemsByCat.set(cat, items);
    const rows = items.map(item => {
      if (item.kind !== "group") return `
        <div class="ex-row-wrap" data-id="${escHtml(item.ex.id)}" data-cat="${escHtml(cat)}">
          <div class="ex-row-edit-slot">${SVG_REF_EDIT}<span>Изменить</span></div>
          <div class="ex-row-delete">${SVG_DEL_EX} Удалить</div>
          <div class="ex-row tappable" data-id="${escHtml(item.ex.id)}"${accentStyle}>
            <span class="ex-row-body">
              <span class="ex-row-name">${escHtml(item.ex.name)}</span>
            </span>
            <span class="ex-row-chevron">${SVG_CHEVRON}</span>
          </div>
        </div>`;
      const expanded = _exGroupExpanded.has(item.id);
      // Раскрытые варианты — вложенные строки упражнения (тот же тап-в-деталь/
      // свайп), но плоские, без своей рамки/пилюли — единая карточка группы,
      // как разворот категории в справочнике (см. .cat-item-wrap.expanded).
      const memberRows = expanded ? item.members.map(ex => memberRowHtml(ex, cat)).join("") : "";
      return `
      <div class="ex-row-wrap ex-row-wrap-group${expanded ? " expanded" : ""}" data-group-id="${escHtml(item.id)}" data-cat="${escHtml(cat)}" style="--cat-color:${escHtml(color)}">
        <div class="ex-row-edit-slot">${SVG_REF_EDIT}<span>Изменить</span></div>
        <div class="ex-row ex-row-group tappable" data-group-id="${escHtml(item.id)}"${accentStyle}>
          <span class="ex-row-body">
            <span class="ex-row-name">${escHtml(item.name)}</span>
          </span>
          <span class="ex-row-group-badge">${item.members.length}</span>
          <span class="ex-row-chevron ex-row-chevron-group">${SVG_CHEVRON}</span>
        </div>
        <div class="ex-row-group-members">${memberRows}</div>
      </div>`;
    }).join("");
    const header = isFiltered ? "" : `
      <div class="ex-group${isEmpty ? " ex-group-empty" : ""}" data-cat="${escHtml(cat)}">
        <span class="ex-group-dot" style="background:${escHtml(color)}"></span>
        <span class="ex-group-name">${escHtml(cat)}</span>
        ${!isEmpty ? `<span class="ex-group-count">${catExs.length}</span>` : ""}
      </div>`;
    return header + rows;
  }).join("");

  if (![...itemsByCat.values()].some(items => items.length)) {
    exercisesScroll.innerHTML = `<p class="empty-state">Ничего не найдено</p>`;
    return;
  }

  exercisesScroll.querySelectorAll(".ex-row:not(.ex-row-group)").forEach(row => {
    row.addEventListener("click", () => {
      // В режиме правки строка только переставляется; имя меняется свайпом
      // вправо → форма (как у мышц/движений). Инлайн-переименование убрано.
      if (_exListEditMode) return;
      openExerciseDetail(row.dataset.id);
    });
  });

  exercisesScroll.querySelectorAll(".ex-row-group").forEach(row => {
    row.addEventListener("click", () => {
      const groupId = row.dataset.groupId;
      // Тап (в ЛЮБОМ режиме, включая правку) — свернуть/развернуть группу. В
      // режиме правки это нужно, чтобы видеть участников перед перетаскиванием
      // внутрь. Переименование — свайпом вправо → форма (openGroupForm).
      if (_exGroupExpanded.has(groupId)) _exGroupExpanded.delete(groupId);
      else _exGroupExpanded.add(groupId);
      renderExercisesList(exercisesSearch.value);
    });
  });

  // Свайп (изменить/удалить) — на все обёртки упражнений, включая вложенные
  // варианты внутри раскрытой группы: это обычные упражнения, ничем не хуже.
  exercisesScroll.querySelectorAll(".ex-row-wrap[data-id]").forEach(wrap => wireExRowSwipe(wrap, userId));
  // Свайп вправо по группе (только у свёрнутой) → форма группы (openGroupForm).
  exercisesScroll.querySelectorAll(".ex-row-wrap-group[data-group-id]").forEach(wrap => wireGroupRowSwipe(wrap, userId));

  // Драг-перестановка — на элементы верхнего уровня (обычные строки и сами
  // группы целиком), а также на варианты внутри раскрытой группы: вариант
  // двигается внутри группы, а если увести палец за её пределы — выносится
  // наружу (см. moveExDrag/endExDrag).
  [...exercisesScroll.children].forEach(wrap => {
    if (wrap.matches(".ex-row-wrap[data-id]") || wrap.matches(".ex-row-wrap-group[data-group-id]")) {
      wireExRowGesture(wrap, userId);
    }
  });
  exercisesScroll.querySelectorAll(".ex-row-wrap-nested").forEach(wrap => wireExRowGesture(wrap, userId));
}

// Свайп ВПРАВО по свёрнутой группе → форма группы (переименование/роспуск),
// как «Изменить» у упражнений/мышц/движений. Влево не тянем (удаление группы —
// «Распустить» внутри формы). У раскрытой группы свайп не активен (плашка
// «Изменить» иначе растянулась бы на всю высоту с участниками).
function wireGroupRowSwipe(wrap, userId) {
  const row = wrap.querySelector(".ex-row-group");
  if (!row) return;
  const groupId = row.dataset.groupId;
  let sx = 0, sy = 0, dx = 0, active = false, decided = false, horiz = false, didSwipe = false;
  const MAX = 120, EDIT = 80;

  row.addEventListener("pointerdown", e => {
    if (_exListEditMode || wrap.classList.contains("expanded")) return;
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
      horiz = Math.abs(mx) > Math.abs(my);
      if (!horiz) { active = false; return; }
      wrap.classList.add("swiping");
      try { row.setPointerCapture(e.pointerId); } catch {}
    }
    if (!horiz) return;
    dx = Math.max(0, Math.min(MAX, mx));   // только вправо
    if (dx > 4) didSwipe = true;
    row.style.transform = `translateX(${dx}px)`;
    wrap.classList.toggle("swiping-right", dx > 0);
    wrap.classList.toggle("will-edit", dx >= EDIT);
  });
  row.addEventListener("touchmove", e => {
    if (!active) return;
    const t = e.touches[0]; if (!t) return;
    const mx = t.clientX - sx, my = t.clientY - sy;
    if (horiz || (Math.abs(mx) >= 8 && Math.abs(mx) > Math.abs(my))) { if (e.cancelable) e.preventDefault(); }
  }, { passive: false });
  const settle = () => {
    if (!active) return;
    active = false;
    if (!horiz) return;
    row.style.transition = "transform 0.18s ease"; row.style.transform = "";
    wrap.classList.remove("will-edit", "swiping-right");
    setTimeout(() => wrap.classList.remove("swiping"), 200);
    if (dx >= EDIT) openGroupForm(groupId);
  };
  row.addEventListener("pointerup", settle);
  row.addEventListener("pointercancel", settle);
  row.addEventListener("click", e => {
    if (didSwipe) { e.stopPropagation(); e.preventDefault(); didSwipe = false; }
  }, true);
}

// Форма группы упражнений — своя отдельная форма (у упражнений/мышц/движений она
// уже есть). Только имя + роспуск группы. focusName=true — сразу фокус и
// выделение (при создании группы слиянием, как папка на iOS).
function openGroupForm(groupId, focusName = false) {
  const userId = DATA.getCurrentUser();
  const group = DATA.getExerciseGroups(userId).find(g => g.id === groupId);
  if (!group) return;

  const bd = document.createElement("div");
  bd.className = "modal-backdrop open ref-form-backdrop";
  bd.style.zIndex = "60";
  bd.innerHTML = `
    <div class="modal modal-form ref-form">
      <h2 class="modal-title">Редактировать группу</h2>
      <div class="ex-form-field"><label class="ex-form-label">Название</label>
        <input class="ex-form-input" id="gf-name" type="text" placeholder="Название группы" value="${escHtml(group.name)}"></div>
      <p class="ex-form-hint">Группа объединяет похожие варианты одного упражнения (штанга/гантели/тренажёр) в одну строку списка.</p>
      <button class="modal-option modal-option-full danger" id="gf-dissolve">Распустить группу</button>
      <div class="modal-form-actions">
        <button class="btn-chip" data-act="cancel">Отмена</button>
        <button class="btn-chip primary" data-act="save">Сохранить</button>
      </div>
    </div>`;
  document.body.appendChild(bd);

  const nameInp = bd.querySelector("#gf-name");
  if (focusName) { nameInp.focus(); nameInp.select(); }

  const close = () => bd.remove();
  bd.addEventListener("click", e => { if (e.target === bd) close(); });
  bd.querySelector('[data-act="cancel"]').addEventListener("click", close);
  bd.querySelector('[data-act="save"]').addEventListener("click", () => {
    const name = nameInp.value.trim();
    if (!name) { nameInp.focus(); showToast("Введи название группы"); return; }
    if (name !== group.name) {
      DATA.renameExerciseGroup(userId, groupId, name);
      SyncQueue.push("exercise:update", { groupId });
    }
    close();
    renderExercisesList(exercisesSearch.value);
  });
  bd.querySelector("#gf-dissolve").addEventListener("click", () => {
    openConfirmModal({
      title: "Распустить группу?",
      message: `Группа «${group.name}» будет расформирована. Упражнения останутся — просто перестанут быть в группе.`,
      confirmLabel: "Распустить",
      onConfirm: () => {
        DATA.deleteExerciseGroup(userId, groupId);
        SyncQueue.push("exercise:update", { groupId });
        close();
        renderExercisesList(exercisesSearch.value);
        showToast("Группа расформирована");
      },
    });
  });
}

function wireExRowSwipe(wrap, userId) {
  const row = wrap.querySelector(".ex-row");
  if (!row) return;
  const exId = row.dataset.id;
  let sx = 0, sy = 0, dx = 0, active = false, decided = false, horiz = false, didSwipe = false;
  // MAX подобран так, чтобы при свайпе полностью показывалась надпись «Изменить».
  const MAX = 120, DEL = 80;

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
      horiz = Math.abs(mx) > Math.abs(my);
      if (!horiz) { active = false; return; }
      wrap.classList.add("swiping");
      try { row.setPointerCapture(e.pointerId); } catch {}
    }
    if (!horiz) return;
    dx = Math.max(-MAX, Math.min(MAX, mx));
    if (Math.abs(dx) > 4) didSwipe = true;
    row.style.transform = `translateX(${dx}px)`;
    wrap.classList.toggle("swiping-left", dx < 0);
    wrap.classList.toggle("swiping-right", dx > 0);
    wrap.classList.toggle("will-delete", dx <= -DEL);
    wrap.classList.toggle("will-edit", dx >= DEL);
  });
  // Во время горизонтального свайпа гасим вертикальный скролл (п.2).
  row.addEventListener("touchmove", e => {
    if (!active) return;
    const t = e.touches[0]; if (!t) return;
    const mx = t.clientX - sx, my = t.clientY - sy;
    if (horiz || (Math.abs(mx) >= 8 && Math.abs(mx) > Math.abs(my))) {
      if (e.cancelable) e.preventDefault();
    }
  }, { passive: false });
  const settle = () => {
    if (!active) return;
    active = false;
    if (!horiz) return;
    if (dx <= -DEL) {
      // Мягкое удаление с подтверждением: карточку не убираем, пока не подтвердили.
      row.style.transition = "transform 0.18s ease"; row.style.transform = "";
      wrap.classList.remove("will-delete", "swiping-left", "swiping-right");
      setTimeout(() => wrap.classList.remove("swiping"), 200);
      const ex = DATA.getVisibleExercises(userId).find(e => e.id === exId);
      const exName = ex ? ex.name : exId;
      openConfirmModal({
        title: "Удалить упражнение?",
        message: `«${exName}» будет удалено. Вернуть можно в настройках → «Недавно удалённые» (7 дней).`,
        confirmLabel: "Удалить",
        onConfirm: () => {
          const own = DATA.getOwnExercises(userId).find(e => e.id === exId) || null;
          const trashId = Trash.push(userId, { type: "exercise", label: exName, sub: "Упражнение", data: { own: own ? JSON.parse(JSON.stringify(own)) : null, exId } });
          const snapshot = [...DATA.getOwnExercises(userId)];
          const hiddenSnapshot = [...DATA.getHiddenIds(userId)];
          DATA.deleteOwnExercise(userId, exId);
          SyncQueue.push("exercise:delete", { id: exId });
          renderExercisesList(exercisesSearch.value);
          showUndoToast(`Упражнение «${exName}» удалено`, () => {
            Trash.remove(userId, trashId);
            DATA.saveOwnExercises(userId, snapshot);
            DATA.saveHiddenIds(userId, hiddenSnapshot);
            SyncQueue.push("exercise:create", {});
            renderExercisesList(exercisesSearch.value);
            showToast("Восстановлено");
          });
        },
      });
    } else if (dx >= DEL) {
      row.style.transition = "transform 0.18s ease";
      row.style.transform = "";
      wrap.classList.remove("will-edit", "swiping-left", "swiping-right");
      setTimeout(() => wrap.classList.remove("swiping"), 200);
      openExerciseForm(exId);
    } else {
      row.style.transition = "transform 0.18s ease";
      row.style.transform = "";
      wrap.classList.remove("will-delete", "will-edit", "swiping-left", "swiping-right");
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
  // Один плоский список кодирует И порядок верхнего уровня, И порядок вариантов
  // внутри групп: для группы кладём "group:<id>", а сразу за ним — id её
  // вариантов в их DOM-порядке (см. resolveDisplayItems: верхний уровень
  // читает id/group-ключи, порядок вариантов — по индексу их id).
  const userId = DATA.getCurrentUser();
  // Прежний порядок — чтобы у СВЁРНУТОЙ группы (её участников нет в DOM) не
  // потерять ранее заданный порядок вариантов. Раньше он просто выпадал из
  // списка и на следующем рендере участники сбрасывались на алфавит.
  const prev = DATA.getExerciseOrder(userId) || [];
  const prevIdx = id => { const i = prev.indexOf(id); return i === -1 ? Infinity : i; };
  const ids = [];
  for (const el of exercisesScroll.children) {
    if (el.matches(".ex-row-wrap[data-id]")) ids.push(el.dataset.id);
    else if (el.matches(".ex-row-wrap-group[data-group-id]")) {
      const gid = el.dataset.groupId;
      ids.push(`group:${gid}`);
      const container = el.querySelector(".ex-row-group-members");
      const domMembers = container
        ? [...container.children].filter(m => m.matches("[data-id]")).map(m => m.dataset.id)
        : [];
      if (domMembers.length) {
        ids.push(...domMembers);               // группа раскрыта — порядок из DOM
      } else {
        // группа свёрнута — берём её участников из данных и сохраняем в прежнем
        // относительном порядке (или по алфавиту, если порядка ещё не было).
        DATA.getVisibleExercises(userId)
          .filter(e => e.groupId === gid)
          .sort((a, b) => (prevIdx(a.id) - prevIdx(b.id)) || a.name.localeCompare(b.name, "ru"))
          .forEach(e => ids.push(e.id));
      }
    }
  }
  if (ids.length) DATA.saveExerciseOrder(userId, ids);
}

// Поставить новосозданную группу в пользовательском порядке НА МЕСТО цели
// слияния (см. performMerge) — иначе у нового group:<id> нет позиции в
// customOrder, и она проваливается в конец списка (для "не найдено в
// порядке" сортировка отправляет элемент последним).
function pinGroupOrderAtTarget(userId, groupId, targetOrderKey) {
  const groupKey = `group:${groupId}`;
  let order = DATA.getExerciseOrder(userId);
  if (!Array.isArray(order)) {
    order = [...exercisesScroll.children]
      .filter(el => el.matches(".ex-row-wrap[data-id]") || el.matches(".ex-row-wrap-group[data-group-id]"))
      .map(w => w.dataset.id || `group:${w.dataset.groupId}`);
  }
  order = order.filter(k => k !== groupKey);
  const idx = order.indexOf(targetOrderKey);
  if (idx === -1) order.push(groupKey);
  else order.splice(idx, 0, groupKey);
  DATA.saveExerciseOrder(userId, order);
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
      // Вариант внутри группы стартует ПРЯМО В ГРУППЕ (не вынимается сразу) —
      // так его можно двигать внутри; вынос наружу происходит только если
      // увести палец за пределы группы (см. moveExDrag).
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

  // Вариант внутри группы: гасим всплытие жеста к обёртке-группе — иначе тот
  // же touchstart запускал бы ЕЩЁ и жест самой группы (drag/hold), конкурируя
  // со свайпом-редактированием/удалением варианта и перехватывая его на
  // реальном тач-устройстве. Свайп живёт на .ex-row (ниже по дереву) — его
  // этот stopPropagation не трогает, а собственный жест варианта (на этой же
  // обёртке) продолжает работать.
  const nested = () => wrap.classList.contains("ex-row-wrap-nested");
  wrap.addEventListener("touchstart", e => { if (nested()) e.stopPropagation(); const t = e.touches[0]; begin(t.clientX, t.clientY, e.target); }, { passive: true });
  wrap.addEventListener("touchmove",  e => { if (nested()) e.stopPropagation(); const t = e.touches[0]; if (t) move(t.clientX, t.clientY, e); }, { passive: false });
  wrap.addEventListener("touchend",   e => { if (nested()) e.stopPropagation(); finish(); });
  wrap.addEventListener("mousedown",  e => { if (nested()) e.stopPropagation(); begin(e.clientX, e.clientY, e.target); });
  wrap.addEventListener("mousemove",  e => { if (_exListDrag) move(e.clientX, e.clientY, null); });
  wrap.addEventListener("mouseup",    finish);
  wrap.addEventListener("click", e => {
    if (dragStarted) { e.stopPropagation(); dragStarted = false; }
  }, true);
}

function startExDrag(wrap, pointerY) {
  if (_exListDrag) return;
  const top = wrap.getBoundingClientRect().top;
  _exListDrag = { wrap, grabDy: pointerY - top, ty: 0, didLiveOpen: false, pointerY, raf: 0 };
  // Замираем вихляние на время drag (см. .ex-drag-active) и разрешаем поднятому
  // элементу выходить за пределы карточки группы (у .ex-row-wrap overflow:hidden —
  // иначе вынос варианта из группы обрезался бы по её краю).
  exercisesScroll.classList.add("ex-drag-active");
  exercisesScroll.querySelectorAll(".ex-row-wrap-group").forEach(g => { g.style.overflow = "visible"; });
  wrap.style.transition = "none";
  wrap.classList.add("ex-dragging");
  haptic(18);
  _exListDrag.raf = requestAnimationFrame(exAutoScrollTick);
}

// Автопрокрутка списка, когда перетаскиваемый элемент подведён к верхней/нижней
// кромке — иначе на длинном списке нельзя было бы дотащить объект дальше видимой
// области (см. аналог autoScrollTick для блоков тренировки). После сдвига
// прокрутки повторяем moveExDrag, чтобы элемент остался под пальцем.
function exAutoScrollTick() {
  const d = _exListDrag; if (!d) return;
  const r = exercisesScroll.getBoundingClientRect();
  const edge = 64;
  let dy = 0;
  if (d.pointerY < r.top + edge)         dy = -Math.ceil((r.top + edge - d.pointerY) / 4);
  else if (d.pointerY > r.bottom - edge) dy =  Math.ceil((d.pointerY - (r.bottom - edge)) / 4);
  if (dy) {
    const before = exercisesScroll.scrollTop;
    exercisesScroll.scrollTop = before + Math.max(-18, Math.min(18, dy));
    if (exercisesScroll.scrollTop !== before) moveExDrag(d.pointerY);
  }
  d.raf = requestAnimationFrame(exAutoScrollTick);
}

// «Живое» раскрытие свёрнутой группы прямо во время перетаскивания (как папка
// на iOS открывается, когда над ней задержишься): наполняем её тело вариантами
// и помечаем раскрытой — дальше moveExDrag увидит её как раскрытую и начнёт
// вставлять перетаскиваемый элемент ВНУТРЬ, позиционно. Без ре-рендера (он бы
// уничтожил перетаскиваемый узел и оборвал жест).
function liveOpenGroup(userId, groupWrap) {
  if (!groupWrap || groupWrap.classList.contains("expanded")) return;
  const groupId = groupWrap.dataset.groupId;
  const cat = groupWrap.dataset.cat;
  const order = DATA.getExerciseOrder(userId);
  const members = DATA.getVisibleExercises(userId).filter(e => e.groupId === groupId).sort((a, b) => {
    if (order) { const ia = order.indexOf(a.id), ib = order.indexOf(b.id); if (ia !== -1 || ib !== -1) { if (ia === -1) return 1; if (ib === -1) return -1; return ia - ib; } }
    return a.name.localeCompare(b.name, "ru");
  });
  const container = groupWrap.querySelector(".ex-row-group-members");
  if (container) container.innerHTML = members.map(ex => memberRowHtml(ex, cat)).join("");
  groupWrap.classList.add("expanded");
  _exGroupExpanded.add(groupId);
  if (_exListDrag) _exListDrag.didLiveOpen = true;
  haptic(14);
}

// Наведение на цель во время перетаскивания. Задержался над свёрнутой группой —
// она «открывается» вживую (входим внутрь, позиционируем). Задержался над
// обычным упражнением — «вооружаем» слияние (на отпускании создастся новая
// группа). Сменилась цель — таймер и подсветка сбрасываются.
function updateMergeHover(target) {
  if (_mergeHover && _mergeHover.target === target) return;
  if (_mergeHover) {
    clearTimeout(_mergeHover.timer);
    _mergeHover.target.classList.remove("ex-merge-candidate", "ex-merge-armed");
    _mergeHover = null;
  }
  if (!target) return;
  target.classList.add("ex-merge-candidate");
  const isGroup = target.matches(".ex-row-wrap-group[data-group-id]");
  const timer = setTimeout(() => {
    if (!_mergeHover || _mergeHover.target !== target) return;
    if (isGroup) {
      // Свёрнутая группа — открываем вживую, дальше вставляем внутрь позиционно.
      target.classList.remove("ex-merge-candidate");
      _mergeHover = null;
      liveOpenGroup(DATA.getCurrentUser(), target);
    } else {
      _mergeHover.armed = true;
      target.classList.add("ex-merge-armed");
      haptic(14);
    }
  }, 450);
  _mergeHover = { target, timer, armed: false };
}

function moveExDrag(pointerY) {
  const d = _exListDrag; if (!d) return;
  d.pointerY = pointerY;   // для автопрокрутки (exAutoScrollTick)
  const wrap = d.wrap;
  const isGroupDrag = !!wrap.dataset.groupId;
  const h = wrap.getBoundingClientRect().height;
  const center = (pointerY - d.grabDy) + h / 2;

  // Контекст: внутри раскрытой группы (вставка/перестановка вариантов) или на
  // верхнем уровне. Группу целиком внутрь другой группы не кладём.
  let intoGroup = null;
  if (!isGroupDrag) {
    for (const gw of exercisesScroll.querySelectorAll(".ex-row-wrap-group.expanded")) {
      const r = gw.getBoundingClientRect();
      if (center > r.top && center < r.bottom) { intoGroup = gw; break; }
    }
  }

  if (intoGroup) {
    updateMergeHover(null);                       // внутри раскрытой группы слияние не нужно
    const container = intoGroup.querySelector(".ex-row-group-members");
    let insertBefore = null;
    for (const child of container.children) {
      if (child === wrap) continue;
      const r = child.getBoundingClientRect();
      if (r.top + r.height / 2 > center) { insertBefore = child; break; }
    }
    if (wrap.parentElement !== container) {
      wrap.classList.add("ex-row-wrap-nested");
      container.insertBefore(wrap, insertBefore);
    } else if (insertBefore !== wrap.nextElementSibling) {
      container.insertBefore(wrap, insertBefore);
    }
  } else {
    if (wrap.parentElement !== exercisesScroll) wrap.classList.remove("ex-row-wrap-nested");

    // Слияние (dwell) — только на верхнем уровне. Цель: другое упражнение
    // (создать новую группу) или свёрнутая группа (открыть её вживую). Раскрытые
    // группы обрабатываются вставкой внутрь (см. ветку intoGroup выше).
    let mergeTarget = null;
    if (!isGroupDrag) {
      for (const child of exercisesScroll.children) {
        if (child === wrap) continue;
        const isEx = child.matches(".ex-row-wrap[data-id]");
        const isCollapsedGroup = child.matches(".ex-row-wrap-group[data-group-id]") && !child.classList.contains("expanded");
        if (!isEx && !isCollapsedGroup) continue;
        const r = child.getBoundingClientRect();
        if (center > r.top && center < r.bottom) { mergeTarget = child; break; }
      }
    }
    updateMergeHover(mergeTarget);

    if (!mergeTarget) {
      let insertBeforeEl = null;
      for (const child of exercisesScroll.children) {
        if (child === wrap) continue;
        const r = child.getBoundingClientRect();
        if (r.top + r.height / 2 > center) { insertBeforeEl = child; break; }
      }
      if (wrap.parentElement !== exercisesScroll || insertBeforeEl !== wrap.nextElementSibling) {
        exercisesScroll.insertBefore(wrap, insertBeforeEl); // null → в конец
      }
    }
  }

  const rect = wrap.getBoundingClientRect();
  const naturalTop = rect.top - d.ty;
  d.ty = (pointerY - d.grabDy) - naturalTop;
  wrap.style.transform = `translateY(${d.ty}px)`;
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

// Слияние по отпусканию над "вооружённой" целью (см. updateMergeHover).
// draggedWrap — всегда обычное упражнение (moveExDrag не даёт "вооружиться",
// когда тащат группу). targetWrap — либо тоже упражнение (оба сливаются в
// НОВУЮ группу), либо уже существующая группа (draggedWrap просто входит в неё).
function performMerge(userId, draggedWrap, targetWrap) {
  haptic(20);
  const exId = draggedWrap.dataset.id;
  if (targetWrap.dataset.groupId) {
    const group = DATA.getExerciseGroups(userId).find(g => g.id === targetWrap.dataset.groupId);
    if (group) {
      DATA.setExerciseGroupByName(userId, exId, group.name);
      SyncQueue.push("exercise:update", { id: exId, groupId: group.id });
      // Раскрываем сразу — иначе непонятно, что перетаскивание вообще сработало.
      _exGroupExpanded.add(group.id);
    }
    renderExercisesList(exercisesSearch.value);
    return;
  }
  const targetId = targetWrap.dataset.id;
  const targetEx = DATA.getVisibleExercises(userId).find(e => e.id === targetId);
  const group = DATA.createExerciseGroup(userId, targetEx ? targetEx.name : "Новая группа", [targetId, exId]);
  SyncQueue.push("exercise:update", { id: exId, groupId: group.id });
  // Встаёт на место цели (иначе у новой группы нет позиции в customOrder, и
  // она проваливается в самый низ), и сразу раскрывается — видно, что именно
  // слилось, а не просто "что-то пропало".
  pinGroupOrderAtTarget(userId, group.id, targetId);
  _exGroupExpanded.add(group.id);
  renderExercisesList(exercisesSearch.value);
  // Сразу предложить назвать новую группу — форму с фокусом на имени. Открываем
  // СИНХРОННО (в стеке обработчика отпускания пальца): iOS поднимает клавиатуру
  // только если focus() вызван в рамках пользовательского жеста — через rAF он
  // оказывался вне жеста, и клавиатура не появлялась (текст выделялся впустую).
  openGroupForm(group.id, true);
}

function endExDrag() {
  const d = _exListDrag; if (!d) return;
  _exListDrag = null;
  if (d.raf) cancelAnimationFrame(d.raf);
  const wrap = d.wrap;

  const merge = _mergeHover;
  if (merge) {
    clearTimeout(merge.timer);
    merge.target.classList.remove("ex-merge-candidate", "ex-merge-armed");
    _mergeHover = null;
  }

  exercisesScroll.classList.remove("ex-drag-active");
  exercisesScroll.querySelectorAll(".ex-row-wrap-group").forEach(g => { g.style.overflow = ""; });

  wrap.style.transition = "transform 0.18s ease";
  wrap.style.transform = "";
  wrap.classList.remove("ex-dragging");
  setTimeout(() => { wrap.style.transition = ""; }, 200);

  const userId = DATA.getCurrentUser();

  // Слияние по dwell над обычным упражнением — создать новую группу.
  if (merge && merge.armed) { performMerge(userId, wrap, merge.target); return; }

  // Порядок (верхний уровень + порядок вариантов внутри групп) — из финального DOM.
  saveExOrder();

  // Всегда перерисовываем, если во время drag открыли группу вживую (её DOM
  // построен на лету, нужно нормализовать обработчики/стили) — иначе только
  // при смене состава/категории (чистая перестановка — без ре-рендера, плавно).
  let needsRender = d.didLiveOpen;

  if (wrap.dataset.groupId) {
    // Тащили группу целиком — только возможная смена категории (+ порядок выше).
    const newCat = _exDragGetCat(wrap);
    if (newCat && newCat !== wrap.dataset.cat) {
      const groupId = wrap.dataset.groupId;
      DATA.getVisibleExercises(userId).filter(e => e.groupId === groupId).forEach(e => DATA.updateOwnExercise(userId, e.id, { cat: newCat }));
      SyncQueue.push("exercise:update", { groupId, cat: newCat });
      const color = DATA.getCategoryColor(userId, newCat);
      const row = wrap.querySelector(".ex-row"); if (row) row.style.borderLeftColor = color;
      wrap.dataset.cat = newCat;
    }
  } else {
    // Обычное упражнение: финальную принадлежность берём из родителя в DOM.
    const exId = wrap.dataset.id;
    const inGroup = wrap.parentElement && wrap.parentElement.classList.contains("ex-row-group-members");
    const ex = DATA.getVisibleExercises(userId).find(e => e.id === exId);
    const curGroupId = ex ? (ex.groupId || null) : null;

    if (inGroup) {
      const groupWrap = wrap.closest(".ex-row-wrap-group");
      const groupId = groupWrap.dataset.groupId;
      const patch = {};
      if (curGroupId !== groupId) patch.groupId = groupId;
      if (ex && ex.cat !== groupWrap.dataset.cat) patch.cat = groupWrap.dataset.cat;
      if (Object.keys(patch).length) {
        DATA.updateOwnExercise(userId, exId, patch);
        SyncQueue.push("exercise:update", { id: exId });
        _exGroupExpanded.add(groupId);
        needsRender = true;
      }
    } else {
      // Верхний уровень: если было в группе — выносим (снимаем groupId).
      const newCat = _exDragGetCat(wrap);
      const patch = {};
      if (curGroupId) patch.groupId = null;
      if (newCat && ex && newCat !== ex.cat) patch.cat = newCat;
      if (Object.keys(patch).length) {
        DATA.updateOwnExercise(userId, exId, patch);
        SyncQueue.push("exercise:update", { id: exId });
        needsRender = true;
      }
    }
  }

  if (needsRender) {
    const st = exercisesScroll.scrollTop;
    renderExercisesList(exercisesSearch.value);
    exercisesScroll.scrollTop = st;
  }
}

$("exercises-done-btn").addEventListener("click", exitExListEditMode);

/* — Экран деталей упражнения: медиа, рабочие мышцы, техника, действия — */
let _detailExerciseId = null;
let _exdReturnScreen = "exercises";

function isHttpUrl(url) {
  return /^https?:\/\//i.test((url || "").trim());
}
function isImageUrl(url) {
  return isHttpUrl(url) && /\.(png|jpe?g|gif|webp|avif|svg)(\?.*)?$/i.test(url.trim());
}
function splitMuscles(str) {
  return (str || "").split(",").map(s => s.trim()).filter(Boolean);
}

function openExerciseDetail(exerciseId, returnScreen = "exercises") {
  const userId = DATA.getCurrentUser();
  const ex = DATA.getVisibleExercises(userId).find(e => e.id === exerciseId);
  if (!ex) return;
  _detailExerciseId = exerciseId;
  _exdReturnScreen = returnScreen;
  exitExerciseEdit();  // всегда открываем деталь в режиме просмотра, не редактирования

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

  const a = ex.atlas || null;

  // Мета-чипы: оборудование, уровень, режим отягощения.
  const metaChips = [];
  if (a && a.equipment) metaChips.push(`<span class="exd-metachip">${escHtml(a.equipment)}</span>`);
  if (a && a.level) metaChips.push(`<span class="exd-metachip level">${escHtml(LEVEL_LABELS[a.level] || a.level)}</span>`);
  if (a && a.loadTypes) a.loadTypes.forEach(lt => metaChips.push(`<span class="exd-metachip">${escHtml(LOAD_LABELS[lt] || lt)}</span>`));
  const metaSection = metaChips.length ? `<div class="exd-metachips">${metaChips.join("")}</div>` : "";

  // Основные движения (категории Атласа).
  const movements = (a && a.categories) || [];
  const movementsSection = movements.length
    ? `<div class="exd-section-label">Основные движения</div><div class="exd-chips">${movements.map(m => `<span class="exd-chip">${escHtml(m)}</span>`).join("")}</div>`
    : "";

  // Рабочие мышцы: новая модель (роли с пучками) или легаси-строки.
  let musclesSection = "";
  const hasAtlasMuscles = a && Array.isArray(a.target) && a.target.length;
  if (hasAtlasMuscles) {
    const rolesHtml = ATLAS_ROLES.map(r => ({ ...r, items: (a[r.key] || []) }))
      .filter(r => r.items.length)
      .map(r => `
        <div class="exd-muscle-role">
          <div class="exd-muscle-role-name">${escHtml(r.label)}</div>
          <div class="exd-chips">${r.items.map(o => {
            const lbl = o.bundle ? `${o.muscle} · ${o.bundle}` : o.muscle;
            const cls = r.primary ? " primary" : (r.stab ? " stab" : "");
            return `<span class="exd-chip${cls}">${escHtml(lbl)}</span>`;
          }).join("")}</div>
        </div>`).join("");
    musclesSection = `<div class="exd-section-label">Рабочие мышцы</div>${rolesHtml}`;
  } else {
    const muscles = ex.muscles || {};
    const rolesHtml = MUSCLE_ROLES
      .map(r => ({ ...r, items: splitMuscles(muscles[r.key]) }))
      .filter(r => r.items.length)
      .map(r => `
        <div class="exd-muscle-role">
          <div class="exd-muscle-role-name">${escHtml(r.label)}</div>
          <div class="exd-chips">${r.items.map(m => `<span class="exd-chip${r.primary ? " primary" : ""}">${escHtml(m)}</span>`).join("")}</div>
        </div>`).join("");
    musclesSection = rolesHtml ? `<div class="exd-section-label">Рабочие мышцы</div>${rolesHtml}` : "";
  }

  // Техника: из atlas.technique (шаги через \n) или легаси steps.
  const techniqueText = (a && a.technique) || "";
  const steps = techniqueText
    ? techniqueText.split("\n").map(s => s.trim()).filter(Boolean)
    : (Array.isArray(ex.steps) ? ex.steps : []);
  const stepsSection = steps.length
    ? `<div class="exd-section-label">Техника</div>${steps.map((s, i) => `
        <div class="exd-step">
          <span class="exd-step-num">${i + 1}</span>
          <span class="exd-step-text">${escHtml(s)}</span>
        </div>`).join("")}`
    : "";

  // Типичные ошибки.
  const mistakes = (a && a.mistakes) || [];
  const mistakesSection = mistakes.length
    ? `<div class="exd-section-label">Типичные ошибки</div>${mistakes.map(m => `
        <div class="exd-mistake"><span class="exd-mistake-dot"></span><span>${escHtml(m)}</span></div>`).join("")}`
    : "";

  // Отличия от похожих / когда выбирать.
  const differences = ((a && a.differences) || "").trim();
  const differencesSection = differences
    ? `<div class="exd-section-label">Отличия от похожих</div><p class="exd-note">${escHtml(differences)}</p>`
    : "";

  // Биомех-нюанс.
  const extra = ((a && a.extra) || "").trim();
  const extraSection = extra
    ? `<div class="exd-section-label">Нюанс</div><p class="exd-note">${escHtml(extra)}</p>`
    : "";

  // Противопоказания — предупреждающий блок.
  const contra = ((a && a.contraindications) || "").trim();
  const contraSection = contra
    ? `<div class="exd-warn"><span class="exd-warn-icon">⚠️</span><span><b>Противопоказания.</b> ${escHtml(contra)}</span></div>`
    : "";

  // Ссылка-референс (напр. каталог muscleandmotion).
  const ref = ((a && a.referenceUrl) || "").trim();
  const refSection = isHttpUrl(ref)
    ? `<a class="exd-video-btn" href="${escHtml(ref)}" target="_blank" rel="noopener" style="margin-top:18px">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        Открыть референс</a>`
    : "";

  const tip = (ex.tip || "").trim();
  const tipSection = tip
    ? `<div class="exd-tip"><span class="exd-tip-icon">💡</span><span><b>Совет.</b> ${escHtml(tip)}</span></div>`
    : "";

  const body = metaSection + movementsSection + musclesSection + stepsSection
    + mistakesSection + differencesSection + extraSection + contraSection + refSection + tipSection;
  $("exd-body").innerHTML = mediaHtml +
    (body || `<p class="exd-empty">Техника и мышцы пока не заполнены.</p>`);
  // К началу: тело карточки переиспользуется между упражнениями и сохранял бы
  // прокрутку от предыдущего (открыл следующее — а ты уже в середине страницы).
  $("exd-body").scrollTop = 0;

  goToScreen("exerciseDetail");
}

$("exd-back-btn").addEventListener("click", () => goToScreen(_exdReturnScreen, { keepFilter: true }));

// Единое поведение шторки (bottom-sheet): закрытие ТОЛЬКО перетаскиванием
// верхней зоны (dragZone — обычно ручка+шапка), а не из любой точки — иначе
// конфликтует со скроллом/тапами содержимого. Лист следует за пальцем;
// отпускание за порогом (110px) ИЛИ быстрым флингом вниз — закрывает, иначе
// возврат на место. Общая реализация для ВСЕХ шторок, которые строим/чиним —
// одна функция гарантирует одинаковое поведение везде (см. эталон — шторка
// главного меню setupSheetDrag).
function wireSheetDragClose(sheetEl, dragZone, onClose) {
  let startY = 0, startX = 0, dy = 0, active = false, decided = false, vert = false, hist = [];
  const vel = () => { if (hist.length < 2) return 0; const f = hist[0], l = hist[hist.length - 1], dt = l.t - f.t; return dt <= 0 ? 0 : (l.y - f.y) / dt; };
  const down = (y, x) => { active = true; decided = false; vert = false; dy = 0; startY = y; startX = x; hist = [{ y, t: performance.now() }]; sheetEl.style.transition = "none"; };
  const moveTo = (y, x, e) => {
    if (!active) return;
    const d = y - startY, dx = x - startX;
    hist.push({ y, t: performance.now() }); if (hist.length > 5) hist.shift();
    if (!decided) {
      if (Math.abs(d) < 6 && Math.abs(dx) < 6) return;
      decided = true;
      vert = d > 0 && Math.abs(d) > Math.abs(dx);
      if (!vert) { active = false; sheetEl.style.transition = ""; return; }
    }
    dy = Math.max(0, d);
    if (e && e.cancelable) e.preventDefault();
    sheetEl.style.transform = `translateY(${dy}px)`;
  };
  const up = () => {
    if (!active) return;
    active = false;
    sheetEl.style.transition = "";
    if (!vert) return;
    const fling = vel() > 0.45;
    if (dy > 110 || fling) { sheetEl.style.transition = "transform 0.22s ease"; sheetEl.style.transform = `translateY(${sheetEl.offsetHeight}px)`; onClose(); }
    else sheetEl.style.transform = "";
  };
  dragZone.addEventListener("touchstart", e => down(e.touches[0].clientY, e.touches[0].clientX), { passive: true });
  dragZone.addEventListener("touchmove", e => { const t = e.touches[0]; if (t) moveTo(t.clientY, t.clientX, e); }, { passive: false });
  dragZone.addEventListener("touchend", up);
  dragZone.addEventListener("touchcancel", up);
  dragZone.addEventListener("mousedown", e => { down(e.clientY, e.clientX); const mm = ev => moveTo(ev.clientY, ev.clientX, ev); const mu = () => { up(); window.removeEventListener("mousemove", mm); window.removeEventListener("mouseup", mu); }; window.addEventListener("mousemove", mm); window.addEventListener("mouseup", mu); });
}

/* ══════════════════════════════════════════════════════════════════════════
   Полноэкранная деталь мышцы — открывается ТОЛЬКО тапом по мышце в справочнике
   (не входит в обычную навигацию). Анатомия (Начало/Прикрепление/Функции) — из
   личного конспекта Anki (window.MUSCLE_ANATOMY, см. muscle-anatomy.js), без
   фото и без раздела «Упражнение» из конспекта — вместо него перекрёстная
   ссылка на СВОИ упражнения из атласа этого приложения (по target/synergist/
   stabilizer). Список этих упражнений — отдельное окно (модалка), в него
   можно попасть только с этого экрана.
   ══════════════════════════════════════════════════════════════════════════ */
function muscleExerciseRoles(userId, muscleName) {
  const exs = DATA.getVisibleExercises(userId);
  const byRole = { target: [], synergist: [], stabilizer: [] };
  exs.forEach(ex => {
    const a = ex.atlas; if (!a) return;
    ["target", "synergist", "stabilizer"].forEach(role => {
      if ((a[role] || []).some(o => o.muscle === muscleName)) byRole[role].push(ex);
    });
  });
  return byRole;
}

let _msdReturnScreen = "exercises";
function openMuscleDetailScreen(muscleId, returnScreen = "exercises", instant = false) {
  const userId = DATA.getCurrentUser();
  const m = DATA.refMuscles(userId).find(x => x.id === muscleId);
  if (!m) return;
  _msdReturnScreen = returnScreen;
  _msdMuscleId = muscleId;
  exitMuscleEdit();  // всегда открываем деталь в режиме просмотра

  $("msd-title").textContent = m.name;
  const color = DATA.getCategoryColor(userId, m.group);
  $("msd-meta").innerHTML = `<span class="exd-cat-dot" style="background:${escHtml(color)}"></span>${escHtml(m.group)}${m.visible ? " · ★ поверхностная" : ""}`;

  const bundlesHtml = (m.bundles || []).length
    ? `<div class="ref-detail-label">Пучки</div><div class="ref-chips">${m.bundles.map(b => `<span class="ref-chip">${escHtml(b)}</span>`).join("")}</div>`
    : "";
  const anatomy = (window.MUSCLE_ANATOMY && window.MUSCLE_ANATOMY[m.name]) || "";
  const anatomyHtml = anatomy
    ? `<div class="ref-detail-label">Анатомия</div><div class="msd-anatomy">${anatomy}</div>`
    : `<p class="exd-empty">Анатомические данные для этой мышцы пока не добавлены.</p>`;
  const links = DATA.refMovesByMuscle(userId);
  const moves = [...(links[m.name] || [])];
  const movesHtml = moves.length
    ? `<div class="ref-detail-label">Участвует в движениях</div><div class="ref-cells">${moves.map(mv => `<button class="ref-cell" data-goto="movement" data-name="${escHtml(mv)}">${escHtml(mv)}</button>`).join("")}</div>`
    : "";

  $("msd-body").innerHTML = bundlesHtml + anatomyHtml + movesHtml;
  $("msd-body").querySelectorAll('.ref-cell[data-goto="movement"]').forEach(cell => {
    cell.addEventListener("click", () => {
      goToScreen("exercises");
      initExercisesScreen();
      openReferenceSheet("movements", cell.dataset.name);
    });
  });

  const byRole = muscleExerciseRoles(userId, m.name);
  const total = byRole.target.length + byRole.synergist.length + byRole.stabilizer.length;
  const exBtn = $("msd-exercises-btn");
  exBtn.textContent = total ? `Упражнения с этой мышцей (${total})` : "Упражнений пока нет";
  exBtn.disabled = !total;
  exBtn.onclick = () => openMuscleExercisesModal(m.name);

  const editBtn = $("msd-edit-btn");
  const canEdit = refCanEdit(m);
  editBtn.style.display = canEdit ? "" : "none";
  editBtn.onclick = enterMuscleEdit;

  goToScreen("muscleDetail", { instant });
}

/* ══════════════════════════════════════════════════════════════════════════
   Inline-редактирование мышцы прямо на её странице-детали — тот же приём, что и
   у упражнения (см. enterExerciseEdit): карандаш в шапке симметрично «назад»,
   заголовок → поле, тело → поля формы мышцы, футер Отмена/Сохранить только в
   этом режиме. Сохранение — тот же refSaveMuscle (own-оверлей / общий у админа),
   что и старая модалка openMuscleForm.
   ══════════════════════════════════════════════════════════════════════════ */
let _msdEditing = false;
let _msdEditCtx = null;
let _msdMuscleId = null;

function exitMuscleEdit() {
  _msdEditing = false;
  _msdEditCtx = null;
  const ef = $("msd-edit-footer"); if (ef) ef.style.display = "none";
  const vf = $("msd-view-footer"); if (vf) vf.style.display = "";
  const eb = $("msd-edit-btn");    if (eb) eb.style.display = "";
}

function enterMuscleEdit() {
  if (_msdEditing) return;
  const userId = DATA.getCurrentUser();
  const m = DATA.refMuscles(userId).find(x => x.id === _msdMuscleId);
  if (!m) return;
  _msdEditing = true;
  const groups = DATA.atlasGroupRows().map(g => g.name);
  const allMoves = DATA.refMovements(userId).map(mv => mv.name);
  const curMoves = [...(DATA.refMovesByMuscle(userId)[m.name] || [])];
  let bundles = [...(m.bundles || [])];

  $("msd-title").innerHTML = `<input class="exd-title-input" id="msd-e-name" type="text" value="${escHtml(m.name)}" placeholder="Название">`;

  $("msd-body").innerHTML = `
    <div class="ex-form-field"><label class="ex-form-label">Группа</label><div class="ex-form-dd" id="mse-group"></div></div>
    <div class="ex-form-field"><button type="button" class="ref-toggle" id="mse-visible" aria-pressed="${m.visible ? "true" : "false"}"><span class="ref-toggle-dot"></span>Поверхностная — рост виден внешне</button></div>
    <div class="ex-form-field"><label class="ex-form-label">Пучки</label>
      <div class="ref-chips-edit" id="mse-bundles"></div>
      <input class="ex-form-input" id="mse-bundle-add" type="text" placeholder="+ добавить пучок, Enter"></div>
    <div class="ex-form-field"><label class="ex-form-label">Участвует в движениях</label><div class="ex-form-dd" id="mse-moves"></div></div>`;
  $("msd-body").scrollTop = 0;

  const groupSel = refDropdownSelect($("mse-group"), groups, [m.group], false);
  const moveSel = refDropdownSelect($("mse-moves"), allMoves, curMoves, true);
  const visBtn = $("mse-visible");
  visBtn.addEventListener("click", () => visBtn.setAttribute("aria-pressed", visBtn.getAttribute("aria-pressed") === "true" ? "false" : "true"));

  const bundlesEl = $("mse-bundles");
  const renderBundles = () => {
    bundlesEl.innerHTML = bundles.length ? bundles.map((b, i) =>
      `<span class="ref-chip-edit">${escHtml(b)}<button type="button" data-i="${i}">×</button></span>`).join("") : `<span class="ref-detail-empty">Пучков нет</span>`;
    bundlesEl.querySelectorAll("button[data-i]").forEach(btn => btn.addEventListener("click", () => { bundles.splice(+btn.dataset.i, 1); renderBundles(); }));
  };
  renderBundles();
  const bundleAdd = $("mse-bundle-add");
  bundleAdd.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); const v = bundleAdd.value.trim(); if (v) { bundles.push(v); bundleAdd.value = ""; renderBundles(); } }
  });

  _msdEditCtx = { groupSel, moveSel, visBtn, getBundles: () => bundles };
  $("msd-edit-save").disabled = false;
  $("msd-edit-btn").style.display = "none";
  $("msd-view-footer").style.display = "none";
  $("msd-edit-footer").style.display = "";
}

async function saveMuscleEdit() {
  if (!_msdEditing || !_msdEditCtx) return;
  const userId = DATA.getCurrentUser();
  const m = DATA.refMuscles(userId).find(x => x.id === _msdMuscleId);
  if (!m) return;
  const { groupSel, moveSel, visBtn, getBundles } = _msdEditCtx;
  const name = $("msd-e-name").value.trim();
  if (!name) { $("msd-e-name").focus(); showToast("Введи название мышцы"); return; }
  const groups = DATA.atlasGroupRows().map(g => g.name);
  const data = { name, group: groupSel.getOne() || groups[0], visible: visBtn.getAttribute("aria-pressed") === "true", bundles: getBundles(), movements: moveSel.get() };
  const saveBtn = $("msd-edit-save");
  saveBtn.disabled = true;
  try {
    await refSaveMuscle(m, data);
    showToast("Мышца обновлена");
    openMuscleDetailScreen(_msdMuscleId, _msdReturnScreen, true);  // сам вызовет exitMuscleEdit()
  } catch (err) {
    saveBtn.disabled = false;
    showToast("Ошибка сохранения: " + (err && err.message || err));
  }
}

$("msd-edit-save").addEventListener("click", saveMuscleEdit);
$("msd-edit-cancel").addEventListener("click", () => openMuscleDetailScreen(_msdMuscleId, _msdReturnScreen, true));

// Возврат из карточки мышцы. Обычно это имя экрана; но если мышца открыта ИЗ
// шторки-справочника, _msdReturnScreen — функция, которая ПОКАЗЫВАЕТ обратно ту
// же самую (спрятанную, а не закрытую) шторку — с сохранённой вкладкой,
// раскрытой группой и скроллом, — чтобы «назад» вернул ровно туда, откуда пришли
// (см. сценарий п.5).
$("msd-back-btn").addEventListener("click", () => {
  if (typeof _msdReturnScreen === "function") _msdReturnScreen();
  else goToScreen(_msdReturnScreen);
});

// Шторка-справочник, открытая в данный момент (для скрытия/показа при заходе в
// карточку мышцы и возврате). Ставится в openReferenceSheet, снимается в close().
let _refSheetEl = null;
// Спрятать шторку (сохранив её DOM и состояние: вкладку, раскрытую группу,
// скролл), уходя в карточку мышцы. ВАЖНО: вызывать ПОСЛЕ openMuscleDetailScreen —
// карточка уже активна под шторкой, поэтому её скрытие сразу открывает карточку,
// без промежуточной вспышки экрана «Упражнения».
function hideRefSheet() { if (_refSheetEl) { _refSheetEl.style.display = "none"; return true; } return false; }
// Показать шторку обратно на «назад». Порядок обратный: СНАЧАЛА показываем шторку
// (она перекрывает экран), ПОТОМ меняем экран под ней на «Упражнения» — иначе на
// миг мелькнул бы экран при переключении. Если шторки уже нет — просто «Упражнения».
function refSheetBackReturn() {
  if (_refSheetEl && document.body.contains(_refSheetEl)) {
    _refSheetEl.style.display = "";
    goToScreen("exercises", { instant: true });  // под шторкой — без кроссфейда
  } else {
    goToScreen("exercises");
  }
}

// «Отдельное окно» со списком СВОИХ упражнений, где эта мышца работает —
// попасть сюда можно только с экрана мышцы (кнопка в футере). Модалка (не
// полноценный «экран»): закрывается — экран мышцы под ней остаётся как был.
// Свайп-закрытие — та же единая функция wireSheetDragClose, что и у шторки.
function openMuscleExercisesModal(muscleName) {
  const userId = DATA.getCurrentUser();
  const byRole = muscleExerciseRoles(userId, muscleName);
  const ROLE_LABELS = { target: "Целевая мышца", synergist: "Синергист", stabilizer: "Стабилизатор" };
  const total = byRole.target.length + byRole.synergist.length + byRole.stabilizer.length;

  const bd = document.createElement("div");
  bd.className = "bottom-sheet-backdrop";
  bd.style.cursor = "pointer";
  const close = () => { bd.classList.remove("open"); setTimeout(() => bd.remove(), 300); };
  bd.addEventListener("click", e => { if (e.target === bd) close(); });

  const section = key => byRole[key].length ? `
    <div class="ref-group-label">${escHtml(ROLE_LABELS[key])} · ${byRole[key].length}</div>
    ${byRole[key].map(ex => `<div class="ref-card ref-card-tap" data-id="${escHtml(ex.id)}"><div class="ref-card-top"><span class="ref-card-name">${escHtml(ex.name)}</span><span class="ref-card-chev">›</span></div></div>`).join("")}
  ` : "";

  bd.innerHTML = `
    <div class="bottom-sheet ref-sheet">
      <div class="ref-sheet-drag"><div class="bottom-sheet-handle"></div></div>
      <div class="cat-sheet-head"><span class="cat-sheet-title">${escHtml(muscleName)}</span><span class="cat-sheet-count">${total} упр.</span></div>
      <div class="ref-sheet-list">
        ${total ? section("target") + section("synergist") + section("stabilizer") : `<p class="exd-empty">В базе пока нет упражнений с этой мышцей.</p>`}
      </div>
    </div>`;
  bd.querySelectorAll(".ref-card[data-id]").forEach(card => {
    card.addEventListener("click", () => {
      const exId = card.dataset.id;
      close();
      setTimeout(() => openExerciseDetail(exId, "muscleDetail"), 260);
    });
  });

  document.body.appendChild(bd);
  requestAnimationFrame(() => bd.classList.add("open"));
  const sheetEl = bd.querySelector(".bottom-sheet");
  const dragZone = bd.querySelector(".ref-sheet-drag");
  if (sheetEl && dragZone) wireSheetDragClose(sheetEl, dragZone, close);
}

/* — Управление категориями v2: свайп-удаление, долгое нажатие = редактирование/перестановка — */
// Шторка «Справочник» (открывается шестерёнкой на экране «Упражнения»).
// Три вкладки: Группы / Движения / Мышцы. «Группы» = прежний менеджер категорий
// (переименование/перетаскивание/удаление/добавление/цвета).
function openReferenceSheet(initialTab, focusName) {
  const userId = DATA.getCurrentUser();
  const existing = $("cat-manager-backdrop");
  if (existing) existing.remove();

  // Порядок вкладок: Группы, Движения, Мышцы (п.8).
  let refTab = initialTab || "groups";
  let refQuery = "";
  let refExpanded = { movements: new Set() };  // id развёрнутых карточек движений (мультивыбор; у мышц теперь полноэкранная деталь)
  let groupExpanded = new Set();  // раскрытые группы (п.9)
  // Режим правки — ОТДЕЛЬНО у каждой вкладки; переключение вкладки ВСЕГДА
  // гасит правку (во всех вкладках разом), не переносит её на новую (п.4).
  let editModeByTab = { groups: false, movements: false, muscles: false };
  let refDrag = null;        // перетаскивание карточки мышцы/движения
  let catDrag = null;
  let editEnteredAt = 0;   // момент входа в правку — гасим клик-переименование сразу после входа

  const curEditMode = () => editModeByTab[refTab];

  const backdrop = document.createElement("div");
  backdrop.id = "cat-manager-backdrop";
  backdrop.className = "bottom-sheet-backdrop";
  // iOS: click не стреляет по non-interactive div без cursor:pointer
  backdrop.style.cursor = "pointer";
  _refSheetEl = backdrop;  // для скрытия/показа при заходе в карточку мышцы (п.5)

  function close() {
    if (_refSheetEl === backdrop) _refSheetEl = null;
    backdrop.classList.remove("open");
    setTimeout(() => backdrop.remove(), 300);
  }
  // Не закрывать шторку, если поверх неё открыта форма/модалка (правка мышцы,
  // движения и т.п.) — иначе тап по форме через elementFromPoint читается как
  // «клик мимо листа» и рушит шторку; закрыв форму, пользователь оказывался бы
  // в «Упражнениях», а не там, откуда открыл правку.
  const closeBlocked = () => !!document.querySelector(".ref-form-backdrop, .modal-backdrop.open") || backdrop.style.display === "none";
  backdrop.addEventListener("click", e => { if (e.target === backdrop && !closeBlocked()) close(); });
  backdrop.addEventListener("touchend", e => {
    if (closeBlocked()) return;
    const t = e.changedTouches[0];
    const el = t && document.elementFromPoint(t.clientX, t.clientY);
    if (el && !el.closest(".bottom-sheet")) close();
  });

  const SVG_DEL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>`;
  const SVG_PLUS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;

  function getListEl() { return backdrop.querySelector(".cat-sheet-list"); }

  // Вход/выход правки — общая пара для ВСЕХ трёх вкладок; работает с состоянием
  // ТЕКУЩЕЙ вкладки (editModeByTab[refTab]).
  function enterEditMode() {
    if (curEditMode()) return;
    editModeByTab[refTab] = true;
    editEnteredAt = Date.now();
    haptic(22);
    renderContent();
  }
  function exitEditMode() {
    if (!curEditMode()) return;
    editModeByTab[refTab] = false;
    renderContent();
  }

  function saveCatOrder() {
    const list = getListEl();
    if (!list) return;
    const newOrder = [...list.querySelectorAll(".cat-item-wrap[data-cat]")].map(w => w.dataset.cat);
    DATA.saveAllCategories(userId, newOrder);
    renderExercisesList(exercisesSearch.value);
  }

  function removeCategory(cat) {
    const trashId = Trash.push(userId, { type: "category", label: cat, sub: "Группа", data: { name: cat, color: DATA.getCategoryColors(userId)[cat] || null } });
    const catSnapshot = [...DATA.getAllCategories(userId)];
    const exSnapshot  = [...DATA.getOwnExercises(userId)];
    DATA.deleteCategory(userId, cat);
    renderExercisesList(exercisesSearch.value);
    renderContent();
    showUndoToast(`Группа «${cat}» удалена`, () => {
      Trash.remove(userId, trashId);
      DATA.saveAllCategories(userId, catSnapshot);
      DATA.saveOwnExercises(userId, exSnapshot);
      renderExercisesList(exercisesSearch.value);
      renderContent();
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
      renderContent();
      closeMod();
    };
    addBd.querySelector('[data-act="cancel"]').addEventListener("click", closeMod);
    addBd.querySelector('[data-act="ok"]').addEventListener("click", save);
    inp.addEventListener("keydown", e => { if (e.key === "Enter") save(); });
    addBd.addEventListener("click", e => { if (e.target === addBd) closeMod(); });
    setTimeout(() => inp.focus(), 50);
  }

  // Форма группы (категории) — отдельное окно (как у упражнений/мышц/движений):
  // название + цвет + удаление. Пришло на смену инлайн-переименованию.
  function openCatForm(cat) {
    const curColor = DATA.getCategoryColor(userId, cat);
    // Курированная палитра в гамме приложения: единый «луч» от синего через
    // фиолетовый (≈ акцент hsl(249,70%,66%)) до розового. Насыщенность/светлота
    // держатся в узком коридоре (S≈60–70%, L≈63–68%) — оттенки различимы, но
    // читаются как одна семья и вписываются в оформление упражнений/мышц/движений.
    // Намеренно без зелёного (он у нас = «прогресс») и без тёмных/чёрных тонов.
    const palette = [
      "hsl(214, 70%, 63%)", // синий
      "hsl(228, 70%, 65%)", // индиго
      "hsl(242, 70%, 66%)", // сине-фиолетовый
      "hsl(255, 68%, 66%)", // фиолетовый (≈ акцент)
      "hsl(270, 62%, 66%)", // пурпурный
      "hsl(288, 58%, 66%)", // пурпурно-розовый
      "hsl(312, 60%, 66%)", // маджента
      "hsl(330, 68%, 68%)", // розовый
    ];

    const bd = document.createElement("div");
    bd.className = "modal-backdrop open";
    bd.style.zIndex = "70";
    bd.innerHTML = `
      <div class="modal modal-form">
        <h2 class="modal-title">Редактировать группу</h2>
        <div class="ex-form-field"><label class="ex-form-label">Название</label>
          <input class="ex-form-input" id="cf-name" type="text" placeholder="Название группы" value="${escHtml(cat)}"></div>
        <div class="ex-form-field"><label class="ex-form-label">Цвет</label>
          <div class="cat-color-row">
            ${palette.map(c => `<button type="button" class="cat-color-swatch${c === curColor ? " selected" : ""}" data-color="${escHtml(c)}" style="background:${escHtml(c)}"></button>`).join("")}
          </div></div>
        <button class="modal-option modal-option-full danger" id="cf-del">Удалить группу</button>
        <div class="modal-form-actions">
          <button class="btn-chip" data-act="cancel">Отмена</button>
          <button class="btn-chip primary" data-act="save">Сохранить</button>
        </div>
      </div>`;
    document.body.appendChild(bd);

    const nameInp = bd.querySelector("#cf-name");
    let chosenColor = curColor;
    bd.querySelectorAll(".cat-color-swatch").forEach(sw => {
      sw.addEventListener("click", () => {
        chosenColor = sw.dataset.color;
        bd.querySelectorAll(".cat-color-swatch").forEach(s => s.classList.toggle("selected", s === sw));
      });
    });

    const close = () => bd.remove();
    bd.addEventListener("click", e => { if (e.target === bd) close(); });
    bd.querySelector('[data-act="cancel"]').addEventListener("click", close);
    bd.querySelector('[data-act="save"]').addEventListener("click", () => {
      const next = nameInp.value.trim();
      if (!next) { nameInp.focus(); showToast("Введи название группы"); return; }
      const col = chosenColor || curColor;
      if (next !== cat) DATA.renameCategory(userId, cat, next);
      // Цвет в карте хранится по имени — задаём под финальным именем (renameCategory
      // цвет не переносит), поэтому ставим всегда под next.
      if (col) DATA.setCategoryColor(userId, next, col);
      close();
      renderExercisesList(exercisesSearch.value);
      renderContent();
    });
    bd.querySelector("#cf-del").addEventListener("click", () => {
      close();
      openConfirmModal({
        title: "Удалить группу?",
        message: `«${cat}» будет удалена, упражнения перейдут в другую группу. Вернуть можно в настройках → «Недавно удалённые».`,
        confirmLabel: "Удалить",
        onConfirm: () => removeCategory(cat),
      });
    });
  }

  // Свайп категории: ВЛЕВО — удалить (как раньше), ВПРАВО — переименовать
  // (п.5: правка ячейки теперь всегда через свайп вправо, не через тап в
  // режиме правки). Свайп работает только ВНЕ режима правки — в правке ячейка
  // только перетаскивается (эталон — упражнения).
  function wireCatSwipe(wrap, item, cat) {
    let sx = 0, sy = 0, dx = 0, active = false, decided = false, horiz = false, swiped = false;
    const MAX = 120, DEL = 72;  // MAX — чтобы «Изменить» показывалось полностью
    item.addEventListener("pointerdown", e => {
      if (curEditMode()) return;
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
        horiz = Math.abs(mx) > Math.abs(my);
        if (!horiz) { active = false; return; }
        wrap.classList.add("swiping");
        try { item.setPointerCapture(e.pointerId); } catch {}
      }
      if (!horiz) return;
      dx = Math.max(-MAX, Math.min(MAX, mx));
      if (Math.abs(dx) > 4) swiped = true;
      item.style.transform = `translateX(${dx}px)`;
      wrap.classList.toggle("swiping-left", dx < 0);
      wrap.classList.toggle("swiping-right", dx > 0);
      wrap.classList.toggle("will-delete", dx <= -DEL);
      wrap.classList.toggle("will-edit", dx >= DEL);
    });
    // Во время горизонтального свайпа гасим вертикальный скролл (п.2).
    item.addEventListener("touchmove", e => {
      if (!active) return;
      const t = e.touches[0]; if (!t) return;
      const mx = t.clientX - sx, my = t.clientY - sy;
      if (horiz || (Math.abs(mx) >= 8 && Math.abs(mx) > Math.abs(my))) {
        if (e.cancelable) e.preventDefault();
      }
    }, { passive: false });
    const settle = () => {
      if (!active) return;
      active = false;
      if (!horiz) return;
      if (dx <= -DEL) {
        // Мягкое удаление с подтверждением — карточку возвращаем на место до ответа.
        item.style.transition = "transform 0.18s ease"; item.style.transform = "";
        wrap.classList.remove("will-delete", "swiping-left", "swiping-right");
        setTimeout(() => wrap.classList.remove("swiping"), 200);
        openConfirmModal({
          title: "Удалить группу?",
          message: `«${cat}» будет удалена, упражнения перейдут в другую группу. Вернуть можно в настройках → «Недавно удалённые».`,
          confirmLabel: "Удалить",
          onConfirm: () => removeCategory(cat),
        });
      } else if (dx >= DEL) {
        item.style.transition = "transform 0.18s ease"; item.style.transform = "";
        wrap.classList.remove("will-edit", "swiping-left", "swiping-right");
        setTimeout(() => wrap.classList.remove("swiping"), 200);
        openCatForm(cat);
      } else {
        item.style.transition = "transform 0.18s ease";
        item.style.transform = "";
        wrap.classList.remove("will-delete", "will-edit", "swiping-left", "swiping-right");
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
    let holdTimer = null, sx = 0, sy = 0, moved = false, dragStarted = false, skip = false;
    const DELAY = () => curEditMode() ? 150 : 430;
    const clearHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };

    const begin = (x, y, target) => {
      // Тап внутри развёрнутого состава группы (ячейки мышц/движений) —
      // это переход по ссылке (crossNav), а не сворачивание группы.
      skip = !!(target && target.closest(".cat-item-detail-block, input"));
      if (skip) return;
      moved = false; dragStarted = false; sx = x; sy = y;
      clearHold();
      holdTimer = setTimeout(() => {
        holdTimer = null;
        if (moved) return;
        if (!curEditMode()) { enterEditMode(); return; }
        dragStarted = true;
        startCatDrag(wrap, cat, y);
      }, DELAY());
    };
    const move = (x, y, e) => {
      if (skip) return;
      if (catDrag && catDrag.wrap === wrap) {
        if (e && e.cancelable) e.preventDefault();
        moveCatDrag(y); return;
      }
      if (holdTimer && (Math.abs(x - sx) > 8 || Math.abs(y - sy) > 8)) { moved = true; clearHold(); }
    };
    const finish = () => {
      if (skip) { skip = false; return; }
      clearHold();
      if (catDrag && catDrag.wrap === wrap) { endCatDrag(); return; }
      // Обычный тап (не свайп, не драг, не правка) — показать инфо о группе (п.9).
      if (!moved && !curEditMode()) toggleGroupExpand(cat);
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

  function toggleGroupExpand(cat) {
    groupExpanded.has(cat) ? groupExpanded.delete(cat) : groupExpanded.add(cat);
    renderContent();
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

  // Каркас шторки: вкладки (Группы/Движения/Мышцы) + поиск+«+» — присутствуют на
  // ВСЕХ трёх вкладках (п.7). Зона перетаскивания для закрытия — ТОЛЬКО ручка
  // (как в шторке главного меню, см. setupSheetDrag) — вкладки-кнопки и остальной
  // контент туда не входят, иначе жест конфликтует с тапами по кнопкам.
  function render() {
    const ph = { groups: "Поиск группы…", movements: "Поиск движения…", muscles: "Поиск мышцы…" }[refTab];
    backdrop.innerHTML = `
      <div class="bottom-sheet ref-sheet">
        <div class="ref-sheet-drag">
          <div class="bottom-sheet-handle"></div>
        </div>
        <div class="ref-sheet-tabs">
          <button class="ref-sheet-tab${refTab === "groups" ? " active" : ""}" data-tab="groups">Группы</button>
          <button class="ref-sheet-tab${refTab === "movements" ? " active" : ""}" data-tab="movements">Движения</button>
          <button class="ref-sheet-tab${refTab === "muscles" ? " active" : ""}" data-tab="muscles">Мышцы</button>
        </div>
        <div class="ref-sheet-search-wrap">
          <input class="ref-sheet-search" type="text" placeholder="${ph}" value="${escHtml(refQuery)}">
          <button class="ref-sheet-add-btn" title="Добавить">${SVG_PLUS}</button>
        </div>
        <div class="ref-sheet-list"></div>
        <div class="ref-sheet-actions"></div>
      </div>`;

    backdrop.querySelectorAll(".ref-sheet-tab").forEach(b => b.addEventListener("click", () => {
      if (refTab === b.dataset.tab) return;
      // #4: переключение вкладки ВСЕГДА гасит правку — в любой вкладке.
      Object.keys(editModeByTab).forEach(k => { editModeByTab[k] = false; });
      refTab = b.dataset.tab;
      refQuery = "";
      render();
    }));

    const searchInp = backdrop.querySelector(".ref-sheet-search");
    if (searchInp) searchInp.addEventListener("input", () => { refQuery = searchInp.value; renderContent(); });
    const addBtn = backdrop.querySelector(".ref-sheet-add-btn");
    if (addBtn) addBtn.addEventListener("click", () => {
      if (refTab === "muscles") openMuscleForm(null, () => renderContent());
      else if (refTab === "movements") openMovementForm(null, () => renderContent());
      else openAddCatModal();
    });

    renderContent();

    // Закрытие — единая функция (см. верх файла), только зона ручки.
    const sheetEl = backdrop.querySelector(".bottom-sheet");
    const dragZone = backdrop.querySelector(".ref-sheet-drag");
    if (sheetEl && dragZone) wireSheetDragClose(sheetEl, dragZone, close);
  }

  function renderContent() {
    const listEl = backdrop.querySelector(".ref-sheet-list");
    const actionsEl = backdrop.querySelector(".ref-sheet-actions");
    if (!listEl) return;
    const editMode = curEditMode();
    if (refTab === "muscles" || refTab === "movements") {
      const isMus = refTab === "muscles";
      (isMus ? renderMusclesTab : renderMovementsTab)(listEl, refQuery, {
        expandedIds: refExpanded.movements, editMode,
      });
      wireRefCards(listEl);
      // Каждая карточка: свайп влево — удалить/скрыть, вправо — изменить;
      // долгое удержание — войти в правку / тащить (эталон строк упражнений).
      listEl.querySelectorAll(".ref-card-wrap[data-id]").forEach(wrap => {
        wireRefSwipe(wrap);
        wireRefGesture(wrap);
      });
    } else {
      renderGroupsInto(listEl, editMode);
    }
    listEl.classList.toggle("ref-editing", editMode);
    // Плавающая «Готово» — единый стиль с упражнениями (fixed-пилюля), появляется
    // только в режиме правки текущей вкладки.
    actionsEl.innerHTML = `<button class="exercises-float-done ref-done-btn">Готово</button>`;
    const doneBtn = actionsEl.querySelector(".ref-done-btn");
    doneBtn.classList.toggle("visible", editMode);
    doneBtn.addEventListener("click", () => exitEditMode());
  }

  // Клики по содержимому текущей вкладки. Обычный режим: тап по карточке
  // мышцы открывает полноэкранную деталь (анатомия), тап по движению —
  // раскрывает список мышц на месте; тап по группе (Группы) — раскрывает
  // мышцы/движения группы. Ячейка перекрёстной ссылки — переход. «Вернуть» у
  // скрытых. В РЕЖИМЕ ПРАВКИ тап по карточке теперь НИЧЕГО не делает (п.5) —
  // правка только через свайп вправо, вход в правку — долгим удержанием.
  function wireRefCards(listEl) {
    listEl.onclick = (e) => {
      const cell = e.target.closest(".ref-cell[data-goto]");
      if (cell) { crossNav(cell.dataset.goto, cell.dataset.name); return; }
      const unhideBtn = e.target.closest('.ref-card-act[data-act="unhide"]');
      if (unhideBtn) { const c = e.target.closest(".ref-card[data-kind]"); if (c) return unhideRefItem(c.dataset.kind, c.dataset.id); }
      const wrap = e.target.closest(".ref-card-wrap[data-kind]");
      if (!wrap) return;
      if (wrap.dataset.swiped) { delete wrap.dataset.swiped; return; }  // клик после свайпа глушим
      if (curEditMode()) return;                          // #5: тап в правке — ничего
      const kind = wrap.dataset.kind, id = wrap.dataset.id;
      if (kind === "muscle") { openMuscleDetailScreen(id, refSheetBackReturn, true); hideRefSheet(); return; }
      const set = refExpanded.movements;
      set.has(id) ? set.delete(id) : set.add(id);        // разворот, без схлопывания других
      renderContent();
    };
  }

  // Свайп по карточке: ВЛЕВО — «Удалить/Скрыть», ВПРАВО — «Изменить» (полная
  // форма). Свайп работает только ВНЕ режима правки (в правке ячейка тащится).
  function wireRefSwipe(wrap) {
    const card = wrap.querySelector(".ref-card");
    if (!card) return;
    let sx = 0, sy = 0, dx = 0, active = false, decided = false, horiz = false, swiped = false;
    const MAX = 128, DEL = 74;  // MAX — чтобы «Изменить» показывалось полностью
    card.addEventListener("pointerdown", e => {
      if (curEditMode()) return;
      sx = e.clientX; sy = e.clientY; dx = 0; active = true; decided = false; horiz = false; swiped = false;
      card.style.transition = "";
    });
    card.addEventListener("pointermove", e => {
      if (!active) return;
      const mx = e.clientX - sx, my = e.clientY - sy;
      if (!decided) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        decided = true; horiz = Math.abs(mx) > Math.abs(my);
        if (!horiz) { active = false; return; }
        wrap.classList.add("swiping");
        try { card.setPointerCapture(e.pointerId); } catch {}
      }
      if (!horiz) return;
      dx = Math.max(-MAX, Math.min(MAX, mx));
      if (Math.abs(dx) > 4) swiped = true;
      card.style.transform = `translateX(${dx}px)`;
      wrap.classList.toggle("swiping-left", dx < 0);
      wrap.classList.toggle("swiping-right", dx > 0);
      wrap.classList.toggle("will-delete", dx <= -DEL);
      wrap.classList.toggle("will-edit", dx >= DEL);
    });
    card.addEventListener("touchmove", e => {
      if (active && horiz && e.cancelable) e.preventDefault();
    }, { passive: false });
    const settle = () => {
      if (!active) return; active = false;
      if (!horiz) return;
      if (swiped) wrap.dataset.swiped = "1";
      if (dx <= -DEL) {
        const kind = wrap.dataset.kind, id = wrap.dataset.id;
        const item = (kind === "muscle" ? DATA.refMuscles(userId) : DATA.refMovements(userId)).find(x => x.id === id);
        const willDelete = item && (refItemIsOwn(item) || DATA.isAdmin());
        const snapBack = () => {
          card.style.transition = "transform 0.18s ease"; card.style.transform = "";
          wrap.classList.remove("will-delete", "swiping-left", "swiping-right");
          setTimeout(() => wrap.classList.remove("swiping"), 200);
        };
        if (willDelete) {
          // УДАЛЕНИЕ необратимо (своё — из личных; общее у админа — из общей базы И
          // БД, для всех). Поэтому спрашиваем подтверждение, а карточку не убираем,
          // пока не подтвердили (иначе — как случилось у пользователя — мышца
          // исчезала мгновенно без отмены). Скрытие (не-админ, общий элемент)
          // обратимо (раздел «Скрытые») — там подтверждение не нужно.
          snapBack();
          const shared = item && !refItemIsOwn(item);
          openConfirmModal({
            title: `Удалить ${kind === "muscle" ? "мышцу" : "движение"}?`,
            message: `«${item.name}» будет удалено безвозвратно${shared ? " из общей базы — для всех пользователей" : ""}.`,
            confirmLabel: "Удалить",
            onConfirm: () => deleteRefItem(kind, id),
          });
        } else {
          card.style.transition = "transform 0.16s ease"; card.style.transform = "translateX(-110%)";
          wrap.style.height = wrap.offsetHeight + "px";
          requestAnimationFrame(() => { wrap.style.transition = "height 0.16s ease, opacity 0.16s ease"; wrap.style.height = "0"; wrap.style.opacity = "0"; });
          setTimeout(() => hideRefItem(kind, id), 170);
        }
      } else if (dx >= DEL) {
        card.style.transition = "transform 0.18s ease"; card.style.transform = "";
        wrap.classList.remove("will-edit", "swiping-left", "swiping-right");
        setTimeout(() => wrap.classList.remove("swiping"), 200);
        openRefEditor(wrap.dataset.kind, wrap.dataset.id);
      } else {
        card.style.transition = "transform 0.18s ease"; card.style.transform = "";
        wrap.classList.remove("will-delete", "will-edit", "swiping-left", "swiping-right");
        setTimeout(() => wrap.classList.remove("swiping"), 200);
      }
    };
    card.addEventListener("pointerup", settle);
    card.addEventListener("pointercancel", settle);
  }

  function openRefEditor(kind, id) {
    const item = (kind === "muscle" ? DATA.refMuscles(userId) : DATA.refMovements(userId)).find(x => x.id === id);
    if (!item) return;
    const after = () => renderContent();
    if (kind === "muscle") openMuscleForm(item, after); else openMovementForm(item, after);
  }

  // Долгое удержание на карточке (эталон упражнений): вне правки — войти в
  // правку; в правке — тащить (реордер внутри группы; границы групп/секции
  // «Скрытые» не пускают). На отпускании drag — сохраняем порядок.
  function wireRefGesture(wrap) {
    let holdTimer = null, sx = 0, sy = 0, moved = false, dragging = false;
    const DELAY = () => curEditMode() ? 150 : 430;
    const clearHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };
    const begin = (x, y) => {
      moved = false; dragging = false; sx = x; sy = y; clearHold();
      holdTimer = setTimeout(() => {
        holdTimer = null; if (moved) return;
        if (!curEditMode()) { enterEditMode(); return; }
        dragging = true; startRefDrag(wrap, y);
      }, DELAY());
    };
    const move = (x, y, e) => {
      if (refDrag && refDrag.wrap === wrap) { if (e && e.cancelable) e.preventDefault(); moveRefDrag(y); return; }
      if (holdTimer && (Math.abs(x - sx) > 8 || Math.abs(y - sy) > 8)) { moved = true; clearHold(); }
    };
    const finish = () => { clearHold(); if (refDrag && refDrag.wrap === wrap) endRefDrag(); };
    wrap.addEventListener("touchstart", e => { const t = e.touches[0]; begin(t.clientX, t.clientY); }, { passive: true });
    wrap.addEventListener("touchmove", e => { const t = e.touches[0]; if (t) move(t.clientX, t.clientY, e); }, { passive: false });
    wrap.addEventListener("touchend", finish);
    wrap.addEventListener("touchcancel", finish);
    wrap.addEventListener("mousedown", e => begin(e.clientX, e.clientY));
    wrap.addEventListener("mousemove", e => { if (refDrag) move(e.clientX, e.clientY, null); });
    wrap.addEventListener("mouseup", finish);
    wrap.addEventListener("click", e => { if (dragging) { e.stopPropagation(); dragging = false; } }, true);
  }
  function startRefDrag(wrap, pointerY) {
    if (refDrag) return;
    refDrag = { wrap, grabDy: pointerY - wrap.getBoundingClientRect().top, ty: 0 };
    wrap.style.transition = "none"; wrap.classList.add("ref-dragging"); haptic(18);
  }
  function moveRefDrag(pointerY) {
    const d = refDrag; if (!d) return;
    const h = d.wrap.getBoundingClientRect().height;
    const center = (pointerY - d.grabDy) + h / 2;
    const okWrap = el => el && el.classList.contains("ref-card-wrap");
    const prev = d.wrap.previousElementSibling;
    if (okWrap(prev)) { const r = prev.getBoundingClientRect(); if (center < r.top + r.height / 2) d.wrap.parentNode.insertBefore(d.wrap, prev); }
    const next = d.wrap.nextElementSibling;
    if (okWrap(next)) { const r = next.getBoundingClientRect(); if (center > r.top + r.height / 2) d.wrap.parentNode.insertBefore(next, d.wrap); }
    const rect = d.wrap.getBoundingClientRect();
    d.ty = (pointerY - d.grabDy) - (rect.top - d.ty);
    d.wrap.style.transform = `translateY(${d.ty}px)`;
  }
  function endRefDrag() {
    const d = refDrag; if (!d) return;
    refDrag = null;
    d.wrap.style.transition = "transform 0.18s ease"; d.wrap.style.transform = "";
    d.wrap.classList.remove("ref-dragging");
    setTimeout(() => { d.wrap.style.transition = ""; }, 200);
    const listEl = backdrop.querySelector(".ref-sheet-list");
    const kind = refTab === "muscles" ? "muscle" : "movement";
    const ids = [...listEl.querySelectorAll(".ref-card-wrap[data-id]")].map(c => c.dataset.id);
    DATA.saveRefOrder(userId, kind, ids);
  }
  function hideRefItem(kind, id) {
    if (kind === "muscle") {
      const l = DATA.getHiddenMuscleIds(userId); if (!l.includes(id)) { l.push(id); DATA.saveHiddenMuscleIds(userId, l); }
    } else {
      const l = DATA.getHiddenMovementIds(userId); if (!l.includes(id)) { l.push(id); DATA.saveHiddenMovementIds(userId, l); }
    }
    renderContent();
    showToast(kind === "muscle" ? "Мышца скрыта — в разделе «Скрытые»" : "Движение скрыто — в разделе «Скрытые»");
  }
  function unhideRefItem(kind, id) {
    if (kind === "muscle") DATA.saveHiddenMuscleIds(userId, DATA.getHiddenMuscleIds(userId).filter(x => x !== id));
    else                   DATA.saveHiddenMovementIds(userId, DATA.getHiddenMovementIds(userId).filter(x => x !== id));
    renderContent();
    showToast("Возвращено");
  }
  function deleteRefItem(kind, id) {
    const list = kind === "muscle" ? DATA.refMuscles(userId) : DATA.refMovements(userId);
    const item = list.find(x => x.id === id); if (!item) return;
    const own = refItemIsOwn(item);
    const label = kind === "muscle" ? "Мышца" : "Движение";
    const undoToast = (trashId) => showUndoToast(`${label} «${item.name}» удалено`, () => {
      restoreFromTrash(userId, trashId);   // вернёт личное в оверлей / общее в атлас+БД и уберёт из корзины
      renderContent();
      showToast("Восстановлено");
    });
    if (own) {
      const trashId = Trash.push(userId, { type: kind, label: item.name, sub: label, data: { item: JSON.parse(JSON.stringify(item)) } });
      if (kind === "muscle") DATA.saveOwnMuscles(userId, DATA.getOwnMuscles(userId).filter(x => x.id !== id));
      else                   DATA.saveOwnMovements(userId, DATA.getOwnMovements(userId).filter(x => x.id !== id));
      renderContent();
      undoToast(trashId);
    } else if (DATA.isAdmin()) {
      // Общий элемент удаляет только админ — из общей базы (оптимистично + БД).
      // В корзину кладём строку атласа + её связи, чтобы восстановление вернуло и то, и другое.
      const a0 = DATA.atlasSnapshot();
      const atlasItem = (kind === "muscle" ? a0.muscles : a0.categories).find(x => x.id === id) || item;
      const links = a0.muscleCategoryLinks.filter(l => kind === "muscle" ? l.muscle === item.name : l.category === item.name);
      const trashId = Trash.push(userId, { type: kind, label: item.name, sub: `${label} (общая)`, data: { shared: true, item: JSON.parse(JSON.stringify(atlasItem)), links: JSON.parse(JSON.stringify(links)) } });
      refAdminDeleteShared(kind, item).then(() => { renderContent(); undoToast(trashId); })
        .catch(err => { showToast("Не удалось удалить: " + (err && err.message || err)); });
    }
  }

  // Переход мышца↔движение по имени: мышца → полноэкранная деталь; движение —
  // открыть вкладку «Движения» с развёрнутой карточкой и подскроллом к ней.
  function crossNav(gotoKind, name) {
    if (gotoKind === "muscle") {
      const found = DATA.refMuscles(userId).find(x => x.name === name);
      if (found) { openMuscleDetailScreen(found.id, refSheetBackReturn, true); hideRefSheet(); }
      return;
    }
    const found = DATA.refMovements(userId).find(x => x.name === name);
    if (!found) return;
    refTab = "movements";
    refExpanded.movements.add(found.id);
    refQuery = "";
    render();
    // Прокрутить список к раскрытой карточке движения (детерминированно через
    // scrollTop — scrollIntoView со smooth здесь не срабатывал, список оставался
    // вверху). rAF + запасной setTimeout — на случай, если лейаут ещё не готов.
    const scrollToMove = () => {
      const list = backdrop.querySelector(".ref-sheet-list");
      // data-id висит на ОБёртке .ref-card-wrap, а не на .ref-card (важно!).
      const wrap = backdrop.querySelector(`.ref-card-wrap[data-id="${CSS.escape(found.id)}"]`);
      if (!list || !wrap) return;
      const lr = list.getBoundingClientRect(), cr = wrap.getBoundingClientRect();
      const delta = (cr.top - lr.top) - (list.clientHeight - cr.height) / 2;
      list.scrollTop = Math.max(0, list.scrollTop + delta);
    };
    requestAnimationFrame(scrollToMove);
    setTimeout(scrollToMove, 60);
  }

  // Вкладка «Группы» = прежний менеджер категорий (группы == категории) + тап
  // по группе раскрывает её состав (мышцы/движения, п.9). Поиск по имени группы.
  function renderGroupsInto(listEl, editMode) {
    const q = refQuery.trim().toLowerCase();
    const allCats = DATA.getAllCategories(userId);
    const cats = q ? allCats.filter(c => c.toLowerCase().includes(q)) : allCats;
    const counts = {};
    DATA.getVisibleExercises(userId).forEach(e => { counts[e.cat] = (counts[e.cat] || 0) + 1; });
    const editingClass = editMode ? " cat-editing" : "";
    listEl.innerHTML = `
      <div class="cat-sheet-list${editingClass}">
        ${cats.length ? cats.map(c => {
          const color = DATA.getCategoryColor(userId, c);
          const expanded = !editMode && groupExpanded.has(c);
          return `
            <div class="cat-item-wrap${expanded ? " expanded" : ""}" data-cat="${escHtml(c)}" style="--cat-color:${escHtml(color)}">
              <div class="cat-item-edit-slot">${SVG_REF_EDIT}<span>Изменить</span></div>
              <div class="cat-item-delete">${SVG_DEL} Удалить</div>
              <div class="cat-item" data-cat="${escHtml(c)}" style="--cat-color:${escHtml(color)}">
                <span class="cat-item-sq" style="background:${escHtml(color)}"></span>
                <span class="cat-item-name-text" title="${escHtml(c)}">${escHtml(c)}</span>
                <span class="cat-item-count">${counts[c] || 0}</span>
                ${editMode ? "" : `<span class="ref-card-chev">${expanded ? "⌄" : "›"}</span>`}
              </div>
              ${expanded ? groupDetailHtml(c) : ""}
            </div>`;
        }).join("") : `<p class="exd-empty">${q ? "Ничего не найдено" : "Групп пока нет."}</p>`}
      </div>`;

    listEl.onclick = (e) => {
      const cell = e.target.closest(".ref-cell[data-goto]");
      if (cell) crossNav(cell.dataset.goto, cell.dataset.name);
    };

    listEl.querySelectorAll(".cat-item-wrap[data-cat]").forEach(wrap => {
      const cat = wrap.dataset.cat;
      const item = wrap.querySelector(".cat-item");
      wireCatSwipe(wrap, item, cat);
      wireCatGesture(wrap, cat);
    });
  }

  // Инфо о группе (п.9): мышцы и движения этой группы, одним столбцом,
  // кликабельны (переход к мышце/движению).
  function groupDetailHtml(cat) {
    const muscles = DATA.refMuscles(userId).filter(m => m.group === cat);
    const moves = DATA.refMovements(userId).filter(m => m.group === cat);
    const musHtml = muscles.length
      ? `<div class="ref-detail-label">Мышцы группы</div><div class="ref-cells">${muscles.map(m => `<button class="ref-cell" data-goto="muscle" data-name="${escHtml(m.name)}">${escHtml(m.name)}</button>`).join("")}</div>`
      : "";
    const movHtml = moves.length
      ? `<div class="ref-detail-label">Движения группы</div><div class="ref-cells">${moves.map(m => `<button class="ref-cell" data-goto="movement" data-name="${escHtml(m.name)}">${escHtml(m.name)}</button>`).join("")}</div>`
      : "";
    const empty = (!muscles.length && !moves.length) ? `<div class="ref-detail-empty">В этой группе пока пусто</div>` : "";
    return `<div class="ref-card-detail cat-item-detail-block">${musHtml}${movHtml}${empty}</div>`;
  }

  document.body.appendChild(backdrop);
  render();
  requestAnimationFrame(() => backdrop.classList.add("open"));

  // focusName (опц.) — сразу подсветить конкретный элемент при открытии:
  // движение — раскрыть карточку и подскроллить; мышца — открыть её
  // полноэкранную деталь вместо шторки (см. openMuscleDetailScreen, вызывается
  // при переходе «Участвует в движениях» → клик по мышце теперь ведёт обратно
  // в справочник, а не наоборот — см. использование ниже).
  if (focusName) {
    const found = refTab === "movements"
      ? DATA.refMovements(userId).find(x => x.name === focusName)
      : refTab === "muscles" ? DATA.refMuscles(userId).find(x => x.name === focusName) : null;
    if (found && refTab === "movements") {
      refExpanded.movements.add(found.id);
      renderContent();
      requestAnimationFrame(() => {
        const el = backdrop.querySelector(`.ref-card[data-id="${CSS.escape(found.id)}"]`);
        if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    } else if (found && refTab === "muscles") {
      openMuscleDetailScreen(found.id, refSheetBackReturn, true);
      hideRefSheet();
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   Редактирование справочника: формы мышцы/движения + запись.
   Общая база правится только админом (пишет и в БД); обычный пользователь
   правит/создаёт СВОИ элементы (own-оверлей) и скрывает общие.
   ══════════════════════════════════════════════════════════════════════════ */
function refNewId(kind) { return (kind === "muscle" ? "om_" : "ov_") + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function refNewSharedId(kind) { return (kind === "muscle" ? "am_" : "av_") + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

// Админ: удалить общий элемент из базы (локально сразу + БД + его связи).
async function refAdminDeleteShared(kind, item) {
  const a = DATA.atlasSnapshot();
  if (kind === "muscle") {
    a.muscles = a.muscles.filter(m => m.id !== item.id);
    a.muscleCategoryLinks = a.muscleCategoryLinks.filter(l => l.muscle !== item.name);
  } else {
    a.categories = a.categories.filter(m => m.id !== item.id);
    a.muscleCategoryLinks = a.muscleCategoryLinks.filter(l => l.category !== item.name);
  }
  DATA.commitAtlas(a);
  if (DATA.isAdmin() && typeof DB !== "undefined" && Auth.isSignedIn()) {
    if (kind === "muscle") { await DB.deleteAtlasLinksByMuscle(item.id); await DB.deleteAtlasMuscle(item.id); }
    else                   { await DB.deleteAtlasLinksByMovement(item.id); await DB.deleteAtlasMovement(item.id); }
  }
}

// Сохранить мышцу. existing=null → создание. data={name,group,visible,bundles,movements}.
async function refSaveMuscle(existing, data) {
  const userId = DATA.getCurrentUser();
  const own = existing ? refItemIsOwn(existing) : !DATA.isAdmin();
  if (own) {
    const list = DATA.getOwnMuscles(userId);
    if (existing) { const m = list.find(x => x.id === existing.id); if (m) Object.assign(m, data, { owner: userId }); }
    else list.push({ id: refNewId("muscle"), owner: userId, ...data });
    DATA.saveOwnMuscles(userId, list);
    return;
  }
  // Общая мышца (админ): оптимистичная правка ATLAS + связи по имени.
  const a = DATA.atlasSnapshot();
  const id = existing ? existing.id : refNewSharedId("muscle");
  let row = existing ? a.muscles.find(m => m.id === id) : null;
  const oldName = row ? row.name : null;
  if (row) Object.assign(row, { name: data.name, group: data.group, visible: data.visible, bundles: data.bundles });
  else { row = { id, name: data.name, group: data.group, visible: data.visible, bundles: data.bundles }; a.muscles.push(row); }
  a.muscleCategoryLinks = a.muscleCategoryLinks.filter(l => l.muscle !== oldName && l.muscle !== data.name);
  (data.movements || []).forEach(mvName => a.muscleCategoryLinks.push({ id: "al_" + Math.random().toString(36).slice(2, 9), muscle: data.name, bundle: "", category: mvName }));
  DATA.commitAtlas(a);
  if (DATA.isAdmin() && typeof DB !== "undefined" && Auth.isSignedIn()) {
    const gid = (a.groupRows.find(g => g.name === data.group) || {}).id || null;
    const pos = a.muscles.findIndex(m => m.id === id);
    await DB.saveAtlasMuscles({ id, name: data.name, group_id: gid, visible: !!data.visible, bundles: data.bundles || [], position: pos });
    await DB.deleteAtlasLinksByMuscle(id);
    const vById = {}; a.categories.forEach(v => { vById[v.name] = v.id; });
    const rows = (data.movements || []).filter(n => vById[n]).map(n => ({ id: "al_" + id + "_" + vById[n], muscle_id: id, bundle: "", movement_id: vById[n] }));
    if (rows.length) await DB.saveAtlasLinks(rows);
  }
}

// Сохранить движение. data={name,group,type,muscles}.
async function refSaveMovement(existing, data) {
  const userId = DATA.getCurrentUser();
  const own = existing ? refItemIsOwn(existing) : !DATA.isAdmin();
  if (own) {
    const list = DATA.getOwnMovements(userId);
    if (existing) { const m = list.find(x => x.id === existing.id); if (m) Object.assign(m, data, { owner: userId }); }
    else list.push({ id: refNewId("movement"), owner: userId, ...data });
    DATA.saveOwnMovements(userId, list);
    return;
  }
  const a = DATA.atlasSnapshot();
  const id = existing ? existing.id : refNewSharedId("movement");
  let row = existing ? a.categories.find(m => m.id === id) : null;
  const oldName = row ? row.name : null;
  if (row) Object.assign(row, { name: data.name, group: data.group, type: data.type });
  else { row = { id, name: data.name, group: data.group, type: data.type }; a.categories.push(row); }
  a.muscleCategoryLinks = a.muscleCategoryLinks.filter(l => l.category !== oldName && l.category !== data.name);
  (data.muscles || []).forEach(mn => a.muscleCategoryLinks.push({ id: "al_" + Math.random().toString(36).slice(2, 9), muscle: mn, bundle: "", category: data.name }));
  DATA.commitAtlas(a);
  if (DATA.isAdmin() && typeof DB !== "undefined" && Auth.isSignedIn()) {
    const gid = (a.groupRows.find(g => g.name === data.group) || {}).id || null;
    const pos = a.categories.findIndex(m => m.id === id);
    await DB.saveAtlasMovements({ id, name: data.name, group_id: gid, type: data.type || "База", position: pos });
    await DB.deleteAtlasLinksByMovement(id);
    const mById = {}; a.muscles.forEach(m => { mById[m.name] = m.id; });
    const rows = (data.muscles || []).filter(n => mById[n]).map(n => ({ id: "al_" + mById[n] + "_" + id, muscle_id: mById[n], bundle: "", movement_id: id }));
    if (rows.length) await DB.saveAtlasLinks(rows);
  }
}

// Универсальный конструктор мультиселект-чипов (single или multi).
function refChipSelect(container, options, selected, multi) {
  const sel = new Set(selected);
  const render = () => {
    container.innerHTML = options.map(o =>
      `<button type="button" class="ex-form-chip${sel.has(o) ? " selected" : ""}" data-v="${escHtml(o)}">${escHtml(o)}</button>`).join("");
    container.querySelectorAll(".ex-form-chip").forEach(ch => ch.addEventListener("click", () => {
      const v = ch.dataset.v;
      if (multi) { sel.has(v) ? sel.delete(v) : sel.add(v); }
      else { sel.clear(); sel.add(v); }
      render();
    }));
  };
  render();
  return { get: () => [...sel], getOne: () => [...sel][0] || "" };
}

// Выпадающий выбор для форм (вместо длинного перечисления чипов). Кастомный
// виджет: список раскрывается ВНИЗ прямо под кнопкой-триггером (инлайн, не
// нативный <select>, который всплывал в произвольном месте).
// multi=true: выбранные показываются чипами с ✕, снизу — кнопка «＋ добавить»,
// раскрывающая оставшиеся варианты (так можно добавить несколько).
// multi=false: один триггер с текущим значением; после выбора список сворачивается.
function refDropdownSelect(container, options, selected, multi) {
  const sel = multi ? [...new Set(selected)] : (selected[0] != null && selected[0] !== "" ? [selected[0]] : []);
  let open = false;

  // Клик мимо — свернуть открытый список (снимаем слушатель, когда форма закрыта).
  const onDocPointer = (e) => {
    if (!document.body.contains(container)) { document.removeEventListener("pointerdown", onDocPointer, true); return; }
    if (open && !container.contains(e.target)) { open = false; render(); }
  };
  document.addEventListener("pointerdown", onDocPointer, true);

  const render = () => {
    const rest = options.filter(o => !sel.includes(o));
    let html = "";
    if (multi && sel.length) {
      html += `<div class="ef-dd-chips">` + sel.map(v =>
        `<span class="ef-dd-chip" data-v="${escHtml(v)}">${escHtml(v)}<button type="button" class="ef-dd-x" aria-label="Убрать">×</button></span>`).join("") + `</div>`;
    }
    const listOpts = multi ? rest : options;
    const showTrigger = multi ? rest.length > 0 : true;
    if (showTrigger) {
      const label = multi ? "＋ добавить…" : (sel[0] || "— не выбрано —");
      const isPlaceholder = multi || !sel[0];
      html += `<div class="ef-dd-field${open ? " open" : ""}">
        <button type="button" class="ef-dd-trigger${isPlaceholder ? " placeholder" : ""}">
          <span class="ef-dd-trigger-label">${escHtml(label)}</span><span class="ef-dd-caret">⌄</span>
        </button>
        ${open ? `<div class="ef-dd-panel">${
          listOpts.length
            ? listOpts.map(o => `<button type="button" class="ef-dd-opt${!multi && o === sel[0] ? " sel" : ""}" data-v="${escHtml(o)}">${escHtml(o)}</button>`).join("")
            : `<div class="ef-dd-empty">Все добавлены</div>`
        }</div>` : ""}
      </div>`;
    }
    container.innerHTML = html;

    const trig = container.querySelector(".ef-dd-trigger");
    if (trig) trig.addEventListener("click", e => { e.stopPropagation(); open = !open; render(); });
    container.querySelectorAll(".ef-dd-opt").forEach(opt => opt.addEventListener("click", e => {
      e.stopPropagation();
      const v = opt.dataset.v;
      if (multi) { if (!sel.includes(v)) sel.push(v); } else { sel[0] = v; }
      open = false; render();
    }));
    container.querySelectorAll(".ef-dd-x").forEach(x => x.addEventListener("click", e => {
      e.stopPropagation();
      const v = x.parentElement.dataset.v;
      const i = sel.indexOf(v); if (i !== -1) sel.splice(i, 1); render();
    }));
  };
  render();
  return { get: () => [...sel], getOne: () => sel[0] || "" };
}

// Селектор рабочих мышц для роли (целевые/синергисты/стабилизаторы) с выбором
// ПУЧКА (головки), когда у мышцы он есть. muscles: [{name, bundles:[…]}].
// selected/get: [{muscle, bundle}] — bundle "" означает «вся мышца».
// Как refDropdownSelect (multi), но каждый выбранный чип с пучками кликабелен:
// открывает панель выбора пучка (Вся мышца / конкретный пучок) под списком.
function roleMuscleSelect(container, muscles, selected) {
  const byName = {}; muscles.forEach(m => { byName[m.name] = m.bundles || []; });
  let sel = (selected || []).map(o => ({ muscle: o.muscle, bundle: o.bundle || "" }));
  let addOpen = false;
  let bundleFor = null;   // имя мышцы, для которой открыт выбор пучка

  const onDocPointer = (e) => {
    if (!document.body.contains(container)) { document.removeEventListener("pointerdown", onDocPointer, true); return; }
    if ((addOpen || bundleFor) && !container.contains(e.target)) { addOpen = false; bundleFor = null; render(); }
  };
  document.addEventListener("pointerdown", onDocPointer, true);

  const render = () => {
    const chosen = new Set(sel.map(o => o.muscle));
    const rest = muscles.map(m => m.name).filter(n => !chosen.has(n));
    let html = "";
    if (sel.length) {
      html += `<div class="ef-dd-chips">` + sel.map(o => {
        const has = (byName[o.muscle] || []).length > 0;
        const label = o.bundle ? `${o.muscle} · ${o.bundle}` : o.muscle;
        return `<span class="ef-dd-chip role-chip${has ? " has-bundles" : ""}" data-m="${escHtml(o.muscle)}">
          <span class="role-chip-label">${escHtml(label)}${has ? `<span class="role-chip-caret">⌄</span>` : ""}</span>
          <button type="button" class="ef-dd-x" aria-label="Убрать">×</button>
        </span>`;
      }).join("") + `</div>`;
    }
    if (bundleFor && (byName[bundleFor] || []).length) {
      const cur = (sel.find(o => o.muscle === bundleFor) || {}).bundle || "";
      html += `<div class="ef-dd-panel role-bundle-panel">
        <div class="role-bundle-title">Пучок · ${escHtml(bundleFor)}</div>
        <button type="button" class="ef-dd-opt${!cur ? " sel" : ""}" data-b="">Вся мышца</button>
        ${(byName[bundleFor]).map(b => `<button type="button" class="ef-dd-opt${cur === b ? " sel" : ""}" data-b="${escHtml(b)}">${escHtml(b)}</button>`).join("")}
      </div>`;
    }
    if (rest.length) {
      html += `<div class="ef-dd-field${addOpen ? " open" : ""}">
        <button type="button" class="ef-dd-trigger placeholder"><span class="ef-dd-trigger-label">＋ добавить…</span><span class="ef-dd-caret">⌄</span></button>
        ${addOpen ? `<div class="ef-dd-panel">${rest.map(n => `<button type="button" class="ef-dd-opt" data-add="${escHtml(n)}">${escHtml(n)}</button>`).join("")}</div>` : ""}
      </div>`;
    }
    container.innerHTML = html;

    const trig = container.querySelector(".ef-dd-trigger");
    if (trig) trig.addEventListener("click", e => { e.stopPropagation(); addOpen = !addOpen; bundleFor = null; render(); });
    container.querySelectorAll(".ef-dd-opt[data-add]").forEach(opt => opt.addEventListener("click", e => {
      e.stopPropagation();
      const n = opt.dataset.add;
      if (!sel.some(o => o.muscle === n)) sel.push({ muscle: n, bundle: "" });
      addOpen = false;
      bundleFor = (byName[n] || []).length ? n : null;   // есть пучки — сразу предложить выбор
      render();
    }));
    container.querySelectorAll(".role-chip .ef-dd-x").forEach(x => x.addEventListener("click", e => {
      e.stopPropagation();
      const m = x.closest(".role-chip").dataset.m;
      sel = sel.filter(o => o.muscle !== m);
      if (bundleFor === m) bundleFor = null;
      render();
    }));
    container.querySelectorAll(".role-chip.has-bundles .role-chip-label").forEach(lbl => lbl.addEventListener("click", e => {
      e.stopPropagation();
      const m = lbl.closest(".role-chip").dataset.m;
      bundleFor = bundleFor === m ? null : m;
      addOpen = false;
      render();
    }));
    container.querySelectorAll(".role-bundle-panel .ef-dd-opt").forEach(opt => opt.addEventListener("click", e => {
      e.stopPropagation();
      const o = sel.find(x => x.muscle === bundleFor); if (o) o.bundle = opt.dataset.b;
      bundleFor = null;
      render();
    }));
  };
  render();
  return { get: () => sel.map(o => ({ muscle: o.muscle, bundle: o.bundle || "" })) };
}

// Автодополнение поверх обычного текстового поля (свободный ввод + подсказки
// по уже существующим значениям) — используется полем «Группа» в форме
// упражнения. Нативный <input list>/<datalist> не годится: WebKit (Safari,
// в т.ч. iOS-приложение) не рисует UI даталиста вообще, подсказки просто не
// появляются. Панель — на всех совпадающих вариантах при фокусе (пусто —
// показать все), сужается по мере ввода; клик по варианту подставляет его.
function wireComboSuggest(inputEl, panelEl, options) {
  if (!inputEl || !panelEl) return;
  const wrap = inputEl.closest(".ef-combo");
  let open = false;
  const render = () => {
    const q = inputEl.value.trim().toLowerCase();
    const matches = options.filter(o => !q || o.toLowerCase().includes(q));
    const showing = open && matches.length > 0;
    if (wrap) wrap.classList.toggle("open", showing);
    if (!showing) { panelEl.innerHTML = ""; panelEl.style.display = "none"; return; }
    panelEl.style.display = "";
    panelEl.innerHTML = matches.map(o => `<button type="button" class="ef-dd-opt" data-v="${escHtml(o)}">${escHtml(o)}</button>`).join("");
    panelEl.querySelectorAll(".ef-dd-opt").forEach(opt => {
      // mousedown+preventDefault — иначе инпут теряет фокус (blur) раньше,
      // чем успевает сработать клик, и панель закрывается без выбора.
      opt.addEventListener("mousedown", e => {
        e.preventDefault();
        inputEl.value = opt.dataset.v;
        open = false;
        render();
      });
    });
  };
  inputEl.addEventListener("focus", () => { open = true; render(); });
  inputEl.addEventListener("input", () => { open = true; render(); });
  inputEl.addEventListener("blur", () => { open = false; render(); });
  render();
}

// Форма мышцы. onSaved() — колбэк после сохранения (перерисовать шторку).
function openMuscleForm(existing, onSaved) {
  const userId = DATA.getCurrentUser();
  const groups = DATA.atlasGroupRows().map(g => g.name);
  const allMoves = DATA.refMovements(userId).map(m => m.name);
  const curMoves = existing ? [...(DATA.refMovesByMuscle(userId)[existing.name] || [])] : [];
  let bundles = existing ? [...(existing.bundles || [])] : [];
  const isShared = existing && !refItemIsOwn(existing);
  const readOnly = isShared && !DATA.isAdmin();

  const bd = document.createElement("div");
  bd.className = "modal-backdrop open ref-form-backdrop";
  bd.innerHTML = `
    <div class="modal modal-form ref-form">
      <h2 class="modal-title">${existing ? "Мышца" : "Новая мышца"}</h2>
      ${readOnly ? `<p class="ref-form-note">Общую мышцу может менять только администратор. Вы можете её скрыть у себя.</p>` : ""}
      <div class="ex-form-field"><label class="ex-form-label">Название</label>
        <input class="ex-form-input" id="rf-name" type="text" placeholder="Например, Большая грудная" value="${escHtml(existing ? existing.name : "")}"></div>
      <div class="ex-form-field"><label class="ex-form-label">Группа</label><div class="ex-form-dd" id="rf-groups"></div></div>
      <div class="ex-form-field"><button type="button" class="ref-toggle" id="rf-visible" aria-pressed="${existing && existing.visible ? "true" : "false"}"><span class="ref-toggle-dot"></span>Поверхностная — рост виден внешне</button></div>
      <div class="ex-form-field"><label class="ex-form-label">Пучки</label>
        <div class="ref-chips-edit" id="rf-bundles"></div>
        <input class="ex-form-input" id="rf-bundle-add" type="text" placeholder="+ добавить пучок, Enter"></div>
      <div class="ex-form-field"><label class="ex-form-label">Участвует в движениях</label><div class="ex-form-dd" id="rf-moves"></div></div>
      <div class="modal-form-actions">
        <button class="btn-chip" data-act="cancel">Закрыть</button>
        ${readOnly ? "" : `<button class="btn-chip primary" data-act="save">Сохранить</button>`}
      </div>
    </div>`;
  document.body.appendChild(bd);
  bd.style.zIndex = "60";

  const groupSel = refDropdownSelect(bd.querySelector("#rf-groups"), groups, existing ? [existing.group] : [groups[0]], false);
  const moveSel = refDropdownSelect(bd.querySelector("#rf-moves"), allMoves, curMoves, true);
  const visBtn = bd.querySelector("#rf-visible");
  visBtn.addEventListener("click", () => visBtn.setAttribute("aria-pressed", visBtn.getAttribute("aria-pressed") === "true" ? "false" : "true"));

  const bundlesEl = bd.querySelector("#rf-bundles");
  const renderBundles = () => {
    bundlesEl.innerHTML = bundles.length ? bundles.map((b, i) =>
      `<span class="ref-chip-edit">${escHtml(b)}<button type="button" data-i="${i}">×</button></span>`).join("") : `<span class="ref-detail-empty">Пучков нет</span>`;
    bundlesEl.querySelectorAll("button[data-i]").forEach(btn => btn.addEventListener("click", () => { bundles.splice(+btn.dataset.i, 1); renderBundles(); }));
  };
  renderBundles();
  const bundleAdd = bd.querySelector("#rf-bundle-add");
  bundleAdd.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); const v = bundleAdd.value.trim(); if (v) { bundles.push(v); bundleAdd.value = ""; renderBundles(); } }
  });

  if (readOnly) bd.querySelectorAll("input,button.ex-form-chip,.ef-dd-trigger,.ef-dd-x,#rf-visible,#rf-bundle-add").forEach(el => { el.disabled = true; });

  const close = () => bd.remove();
  bd.addEventListener("click", e => { if (e.target === bd) close(); });
  bd.querySelector('[data-act="cancel"]').addEventListener("click", close);
  const saveBtn = bd.querySelector('[data-act="save"]');
  if (saveBtn) saveBtn.addEventListener("click", async () => {
    const name = bd.querySelector("#rf-name").value.trim();
    if (!name) { bd.querySelector("#rf-name").focus(); return; }
    const data = { name, group: groupSel.getOne() || groups[0], visible: visBtn.getAttribute("aria-pressed") === "true", bundles, movements: moveSel.get() };
    saveBtn.disabled = true;
    try { await refSaveMuscle(existing, data); close(); onSaved && onSaved(); }
    catch (err) { saveBtn.disabled = false; showToast("Ошибка сохранения: " + (err && err.message || err)); }
  });
}

// Форма движения.
function openMovementForm(existing, onSaved) {
  const userId = DATA.getCurrentUser();
  const groups = DATA.atlasGroupRows().map(g => g.name);
  const allMuscles = DATA.refMuscles(userId).map(m => m.name);
  const curMuscles = existing ? [...(DATA.refMusclesByMove(userId)[existing.name] || [])] : [];
  let type = existing ? (existing.type || "База") : "База";
  const isShared = existing && !refItemIsOwn(existing);
  const readOnly = isShared && !DATA.isAdmin();

  const bd = document.createElement("div");
  bd.className = "modal-backdrop open ref-form-backdrop";
  bd.innerHTML = `
    <div class="modal modal-form ref-form">
      <h2 class="modal-title">${existing ? "Движение" : "Новое движение"}</h2>
      ${readOnly ? `<p class="ref-form-note">Общее движение может менять только администратор. Вы можете его скрыть у себя.</p>` : ""}
      <div class="ex-form-field"><label class="ex-form-label">Название</label>
        <input class="ex-form-input" id="rf-name" type="text" placeholder="Например, Движение рук вперёд" value="${escHtml(existing ? existing.name : "")}"></div>
      <div class="ex-form-field"><label class="ex-form-label">Группа</label><div class="ex-form-dd" id="rf-groups"></div></div>
      <div class="ex-form-field"><label class="ex-form-label">Тип</label><div class="ex-form-chips ex-form-2col" id="rf-type"></div></div>
      <div class="ex-form-field"><label class="ex-form-label">Работающие мышцы</label><div class="ex-form-dd" id="rf-muscles"></div></div>
      <div class="modal-form-actions">
        <button class="btn-chip" data-act="cancel">Закрыть</button>
        ${readOnly ? "" : `<button class="btn-chip primary" data-act="save">Сохранить</button>`}
      </div>
    </div>`;
  document.body.appendChild(bd);
  bd.style.zIndex = "60";

  const groupSel = refDropdownSelect(bd.querySelector("#rf-groups"), groups, existing ? [existing.group] : [groups[0]], false);
  const typeSel = refChipSelect(bd.querySelector("#rf-type"), ["База", "Опция"], [type], false);
  const muscleSel = refDropdownSelect(bd.querySelector("#rf-muscles"), allMuscles, curMuscles, true);

  if (readOnly) bd.querySelectorAll("input,button.ex-form-chip,.ef-dd-trigger,.ef-dd-x").forEach(el => { el.disabled = true; });

  const close = () => bd.remove();
  bd.addEventListener("click", e => { if (e.target === bd) close(); });
  bd.querySelector('[data-act="cancel"]').addEventListener("click", close);
  const saveBtn = bd.querySelector('[data-act="save"]');
  if (saveBtn) saveBtn.addEventListener("click", async () => {
    const name = bd.querySelector("#rf-name").value.trim();
    if (!name) { bd.querySelector("#rf-name").focus(); return; }
    const data = { name, group: groupSel.getOne() || groups[0], type: typeSel.getOne() || "База", muscles: muscleSel.get() };
    saveBtn.disabled = true;
    try { await refSaveMovement(existing, data); close(); onSaved && onSaved(); }
    catch (err) { saveBtn.disabled = false; showToast("Ошибка сохранения: " + (err && err.message || err)); }
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

// Полный редактор упражнения по модели Атласа (#6). Динамическая модалка со
// всеми полями ex.atlas: тип/категория, оборудование, уровень, целевые/синергисты/
// стабилизаторы (выбор из справочника мышц), движения, техника, частые ошибки,
// противопоказания, референс, медиа, совет. Сохраняет в own-оверлей (copy-on-write).
function openExerciseForm(exerciseId) {
  const userId = DATA.getCurrentUser();
  const ex = exerciseId ? DATA.getVisibleExercises(userId).find(e => e.id === exerciseId) : null;
  if (exerciseId && !ex) return;
  const a = (ex && ex.atlas) || {};
  const roleNames = arr => (arr || []).map(o => o.muscle);
  const muscleNames = DATA.refMuscles(userId).map(m => m.name);
  const moveNames = DATA.refMovements(userId).map(m => m.name);
  const cats = DATA.getAllCategories(userId);
  const exGroups = DATA.getExerciseGroups(userId);
  const curGroupName = (ex && ex.groupId && (exGroups.find(g => g.id === ex.groupId) || {}).name) || "";
  const LEVELS = ["Глобальное", "Региональное", "Локальное"];
  const curLevel = LEVEL_LABELS[a.level] || a.level || "";
  let technique = (ex && Array.isArray(ex.steps) ? ex.steps.join("\n") : (a.technique || ""));
  let mistakes = (a.mistakes || []).join("\n");

  const bd = document.createElement("div");
  bd.className = "modal-backdrop open ref-form-backdrop";
  bd.style.zIndex = "60";
  bd.innerHTML = `
    <div class="modal modal-form ref-form">
      <h2 class="modal-title">${ex ? "Редактировать упражнение" : "Новое упражнение"}</h2>
      <div class="ex-form-field"><label class="ex-form-label">Название</label>
        <input class="ex-form-input" id="ef-name" type="text" placeholder="Например, Гакк-приседания" value="${escHtml(ex ? ex.name : "")}"></div>
      <div class="ex-form-field"><label class="ex-form-label">Тип</label><div class="ex-form-chips ex-form-2col" id="ef-type"></div></div>
      <div class="ex-form-field"><label class="ex-form-label">Категория</label><div class="ex-form-dd" id="ef-cat"></div></div>
      <div class="ex-form-field"><label class="ex-form-label">Группа</label>
        <div class="ex-form-dd ef-combo">
          <input class="ex-form-input" id="ef-group" type="text" autocomplete="off" placeholder="Например, Жим лёжа" value="${escHtml(curGroupName)}">
          <div class="ef-dd-panel ef-combo-panel" id="ef-group-panel"></div>
        </div>
        <p class="ex-form-hint">Похожие варианты одного упражнения (штанга/гантели/тренажёр) — впиши общее имя, они схлопнутся в одну строку в списке.</p></div>
      <div class="ex-form-field"><label class="ex-form-label">Оборудование</label>
        <input class="ex-form-input" id="ef-equip" type="text" placeholder="Например, Штанга" value="${escHtml(a.equipment || "")}"></div>
      <div class="ex-form-field"><label class="ex-form-label">Уровень</label><div class="ex-form-dd" id="ef-level"></div></div>
      <div class="ex-form-group-label">Рабочие мышцы</div>
      <div class="ex-form-field"><label class="ex-form-label">Целевые</label><div class="ex-form-dd" id="ef-target"></div></div>
      <div class="ex-form-field"><label class="ex-form-label">Синергисты</label><div class="ex-form-dd" id="ef-syn"></div></div>
      <div class="ex-form-field"><label class="ex-form-label">Стабилизаторы</label><div class="ex-form-dd" id="ef-stab"></div></div>
      <div class="ex-form-field"><label class="ex-form-label">Движения</label><div class="ex-form-dd" id="ef-moves"></div></div>
      <div class="ex-form-group-label">Техника и заметки</div>
      <div class="ex-form-field"><label class="ex-form-label">Техника (по шагу на строку)</label>
        <textarea class="ex-form-input ex-form-textarea" id="ef-tech" rows="4" placeholder="Один шаг — одна строка">${escHtml(technique)}</textarea></div>
      <div class="ex-form-field"><label class="ex-form-label">Частые ошибки (по одной на строку)</label>
        <textarea class="ex-form-input ex-form-textarea" id="ef-mistakes" rows="3">${escHtml(mistakes)}</textarea></div>
      <div class="ex-form-field"><label class="ex-form-label">Отличия от похожих</label>
        <textarea class="ex-form-input ex-form-textarea" id="ef-diff" rows="3">${escHtml(a.differences || "")}</textarea></div>
      <div class="ex-form-field"><label class="ex-form-label">Нюанс</label>
        <textarea class="ex-form-input ex-form-textarea" id="ef-extra" rows="3">${escHtml(a.extra || "")}</textarea></div>
      <div class="ex-form-field"><label class="ex-form-label">Противопоказания</label>
        <textarea class="ex-form-input ex-form-textarea" id="ef-contra" rows="2">${escHtml(a.contraindications || "")}</textarea></div>
      <div class="ex-form-field"><label class="ex-form-label">Совет</label>
        <textarea class="ex-form-input ex-form-textarea" id="ef-tip" rows="2">${escHtml(ex ? (ex.tip || "") : "")}</textarea></div>
      <div class="ex-form-field"><label class="ex-form-label">Ссылка на медиа (фото/гиф/видео)</label>
        <input class="ex-form-input" id="ef-media" type="url" inputmode="url" placeholder="https://…" value="${escHtml(ex ? (ex.media || "") : "")}"></div>
      <div class="ex-form-field"><label class="ex-form-label">Ссылка-референс</label>
        <input class="ex-form-input" id="ef-ref" type="url" inputmode="url" placeholder="https://…" value="${escHtml(a.referenceUrl || "")}"></div>
      <div class="modal-form-actions">
        <button class="btn-chip" data-act="cancel">Отмена</button>
        <button class="btn-chip primary" data-act="save">Сохранить</button>
      </div>
    </div>`;
  document.body.appendChild(bd);

  // Тип — две равные кнопки (два столбца); остальное — выпадающие списки.
  const typeSel  = refChipSelect(bd.querySelector("#ef-type"), ["Силовое", "Бег"], [ex && ex.type === "run" ? "Бег" : "Силовое"], false);
  const muscleObjs = DATA.refMuscles(userId);
  const catSel   = refDropdownSelect(bd.querySelector("#ef-cat"), cats, [ex ? ex.cat : (cats[0] || "Ноги")], false);
  const levelSel = refDropdownSelect(bd.querySelector("#ef-level"), LEVELS, curLevel ? [curLevel] : [], false);
  const targetSel = roleMuscleSelect(bd.querySelector("#ef-target"), muscleObjs, a.target || []);
  const synSel    = roleMuscleSelect(bd.querySelector("#ef-syn"), muscleObjs, a.synergist || []);
  const stabSel   = roleMuscleSelect(bd.querySelector("#ef-stab"), muscleObjs, a.stabilizer || []);
  const moveSel   = refDropdownSelect(bd.querySelector("#ef-moves"), moveNames, a.categories || [], true);
  wireComboSuggest(bd.querySelector("#ef-group"), bd.querySelector("#ef-group-panel"), exGroups.map(g => g.name));

  // сохранить пучок у мышцы, если он уже был задан (иначе пусто)
  const toRoles = (names, prev) => names.map(n => {
    const old = (prev || []).find(o => o.muscle === n);
    return { muscle: n, bundle: old ? old.bundle : "" };
  });

  const close = () => bd.remove();
  bd.addEventListener("click", e => { if (e.target === bd) close(); });
  bd.querySelector('[data-act="cancel"]').addEventListener("click", close);
  bd.querySelector('[data-act="save"]').addEventListener("click", () => {
    const name = bd.querySelector("#ef-name").value.trim();
    if (!name) { bd.querySelector("#ef-name").focus(); showToast("Введи название упражнения"); return; }
    const atlas = Object.assign((ex && ex.atlas) ? JSON.parse(JSON.stringify(ex.atlas)) : {}, {
      equipment: bd.querySelector("#ef-equip").value.trim(),
      level: levelSel.getOne() || "",
      target:     targetSel.get(),
      synergist:  synSel.get(),
      stabilizer: stabSel.get(),
      categories: moveSel.get(),
      technique: bd.querySelector("#ef-tech").value.trim(),
      mistakes: bd.querySelector("#ef-mistakes").value.split("\n").map(s => s.trim()).filter(Boolean),
      differences: bd.querySelector("#ef-diff").value.trim(),
      extra: bd.querySelector("#ef-extra").value.trim(),
      contraindications: bd.querySelector("#ef-contra").value.trim(),
      referenceUrl: bd.querySelector("#ef-ref").value.trim(),
    });
    const payload = {
      name, type: typeSel.getOne() === "Бег" ? "run" : "strength",
      cat: catSel.getOne() || "Другое",
      media: bd.querySelector("#ef-media").value.trim(),
      tip: bd.querySelector("#ef-tip").value.trim(),
      atlas,
    };
    let savedId = exerciseId;
    if (exerciseId) {
      DATA.updateOwnExercise(userId, exerciseId, payload);
      SyncQueue.push("exercise:update", { id: exerciseId });
      showToast("Упражнение обновлено");
    } else {
      savedId = DATA.addExercise(userId, payload).id;
      SyncQueue.push("exercise:create", { name });
      showToast("Упражнение добавлено");
    }
    DATA.setExerciseGroupByName(userId, savedId, bd.querySelector("#ef-group").value);
    close();
    renderExercisesList(exercisesSearch.value);
    if (savedId && SCREENS.exerciseDetail.classList.contains("active")) openExerciseDetail(savedId, _exdReturnScreen);
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   Inline-редактирование упражнения ПРЯМО на его странице-детали (карандаш в
   шапке, симметрично стрелке «назад»). В отличие от модалки openExerciseForm
   (её открывает свайп вправо в списке), здесь редактируем ту же страницу в её
   же формате: заголовок становится полем ввода, тело — набором полей с теми же
   разделами, что и в просмотре. Save/Cancel — в футере, который виден только в
   этом режиме. Сохранение — тот же own-оверлей (copy-on-write), что и в модалке.
   ══════════════════════════════════════════════════════════════════════════ */
let _exdEditing = false;
let _exdEditCtx = null;

// Вернуть страницу-деталь в режим просмотра (спрятать футер, показать карандаш).
// Идемпотентно — безопасно звать из openExerciseDetail при каждом открытии.
function exitExerciseEdit() {
  _exdEditing = false;
  _exdEditCtx = null;
  const footer = $("exd-edit-footer");
  if (footer) footer.style.display = "none";
  const editBtn = $("exd-edit-btn");
  if (editBtn) editBtn.style.display = "";
}

function enterExerciseEdit() {
  if (_exdEditing) return;
  const userId = DATA.getCurrentUser();
  const ex = DATA.getVisibleExercises(userId).find(e => e.id === _detailExerciseId);
  if (!ex) return;
  _exdEditing = true;
  const a = ex.atlas || {};
  const roleNames = arr => (arr || []).map(o => o.muscle);
  const muscleNames = DATA.refMuscles(userId).map(m => m.name);
  const moveNames = DATA.refMovements(userId).map(m => m.name);
  const cats = DATA.getAllCategories(userId);
  const exGroups = DATA.getExerciseGroups(userId);
  const curGroupName = (ex.groupId && (exGroups.find(g => g.id === ex.groupId) || {}).name) || "";
  const LEVELS = ["Глобальное", "Региональное", "Локальное"];
  const curLevel = LEVEL_LABELS[a.level] || a.level || "";
  const technique = (Array.isArray(ex.steps) && ex.steps.length) ? ex.steps.join("\n") : (a.technique || "");
  const mistakes = (a.mistakes || []).join("\n");

  // Заголовок в шапке превращаем в поле ввода имени — сохраняем «тот же формат».
  $("exd-title").innerHTML = `<input class="exd-title-input" id="exd-e-name" type="text" value="${escHtml(ex.name)}" placeholder="Название">`;

  $("exd-body").innerHTML = `
    <div class="ex-form-field"><label class="ex-form-label">Тип</label><div class="ex-form-chips ex-form-2col" id="exe-type"></div></div>
    <div class="ex-form-field"><label class="ex-form-label">Категория</label><div class="ex-form-dd" id="exe-cat"></div></div>
    <div class="ex-form-field"><label class="ex-form-label">Группа</label>
      <div class="ex-form-dd ef-combo">
        <input class="ex-form-input" id="exe-group" type="text" autocomplete="off" placeholder="Например, Жим лёжа" value="${escHtml(curGroupName)}">
        <div class="ef-dd-panel ef-combo-panel" id="exe-group-panel"></div>
      </div>
      <p class="ex-form-hint">Похожие варианты одного упражнения (штанга/гантели/тренажёр) схлопнутся в одну строку в списке.</p></div>
    <div class="ex-form-field"><label class="ex-form-label">Оборудование</label>
      <input class="ex-form-input" id="exe-equip" type="text" placeholder="Например, Штанга" value="${escHtml(a.equipment || "")}"></div>
    <div class="ex-form-field"><label class="ex-form-label">Уровень</label><div class="ex-form-dd" id="exe-level"></div></div>
    <div class="exd-section-label">Рабочие мышцы</div>
    <div class="ex-form-field"><label class="ex-form-label">Целевые</label><div class="ex-form-dd" id="exe-target"></div></div>
    <div class="ex-form-field"><label class="ex-form-label">Синергисты</label><div class="ex-form-dd" id="exe-syn"></div></div>
    <div class="ex-form-field"><label class="ex-form-label">Стабилизаторы</label><div class="ex-form-dd" id="exe-stab"></div></div>
    <div class="exd-section-label">Основные движения</div>
    <div class="ex-form-field"><label class="ex-form-label">Движения</label><div class="ex-form-dd" id="exe-moves"></div></div>
    <div class="exd-section-label">Техника</div>
    <div class="ex-form-field"><label class="ex-form-label">По шагу на строку</label>
      <textarea class="ex-form-input ex-form-textarea" id="exe-tech" rows="5" placeholder="Один шаг — одна строка">${escHtml(technique)}</textarea></div>
    <div class="ex-form-field"><label class="ex-form-label">Частые ошибки (по одной на строку)</label>
      <textarea class="ex-form-input ex-form-textarea" id="exe-mistakes" rows="3">${escHtml(mistakes)}</textarea></div>
    <div class="ex-form-field"><label class="ex-form-label">Отличия от похожих</label>
      <textarea class="ex-form-input ex-form-textarea" id="exe-diff" rows="3">${escHtml(a.differences || "")}</textarea></div>
    <div class="ex-form-field"><label class="ex-form-label">Нюанс</label>
      <textarea class="ex-form-input ex-form-textarea" id="exe-extra" rows="3">${escHtml(a.extra || "")}</textarea></div>
    <div class="ex-form-field"><label class="ex-form-label">Противопоказания</label>
      <textarea class="ex-form-input ex-form-textarea" id="exe-contra" rows="2">${escHtml(a.contraindications || "")}</textarea></div>
    <div class="ex-form-field"><label class="ex-form-label">Совет</label>
      <textarea class="ex-form-input ex-form-textarea" id="exe-tip" rows="2">${escHtml(ex.tip || "")}</textarea></div>
    <div class="ex-form-field"><label class="ex-form-label">Ссылка на медиа (фото/гиф/видео)</label>
      <input class="ex-form-input" id="exe-media" type="url" inputmode="url" placeholder="https://…" value="${escHtml(ex.media || "")}"></div>
    <div class="ex-form-field"><label class="ex-form-label">Ссылка-референс</label>
      <input class="ex-form-input" id="exe-ref" type="url" inputmode="url" placeholder="https://…" value="${escHtml(a.referenceUrl || "")}"></div>`;
  $("exd-body").scrollTop = 0;

  const muscleObjs = DATA.refMuscles(userId);
  const typeSel   = refChipSelect($("exe-type"), ["Силовое", "Бег"], [ex.type === "run" ? "Бег" : "Силовое"], false);
  const catSel    = refDropdownSelect($("exe-cat"), cats, [ex.cat], false);
  const levelSel  = refDropdownSelect($("exe-level"), LEVELS, curLevel ? [curLevel] : [], false);
  const targetSel = roleMuscleSelect($("exe-target"), muscleObjs, a.target || []);
  const synSel    = roleMuscleSelect($("exe-syn"), muscleObjs, a.synergist || []);
  const stabSel   = roleMuscleSelect($("exe-stab"), muscleObjs, a.stabilizer || []);
  const moveSel   = refDropdownSelect($("exe-moves"), moveNames, a.categories || [], true);
  wireComboSuggest($("exe-group"), $("exe-group-panel"), exGroups.map(g => g.name));

  const toRoles = (names, prev) => names.map(n => {
    const old = (prev || []).find(o => o.muscle === n);
    return { muscle: n, bundle: old ? old.bundle : "" };
  });

  _exdEditCtx = { a, typeSel, catSel, levelSel, targetSel, synSel, stabSel, moveSel, toRoles };
  $("exd-edit-btn").style.display = "none";
  $("exd-edit-footer").style.display = "";
}

function saveExerciseEdit() {
  if (!_exdEditing || !_exdEditCtx) return;
  const userId = DATA.getCurrentUser();
  const ex = DATA.getVisibleExercises(userId).find(e => e.id === _detailExerciseId);
  if (!ex) return;
  const { a, typeSel, catSel, levelSel, targetSel, synSel, stabSel, moveSel, toRoles } = _exdEditCtx;
  const name = $("exd-e-name").value.trim();
  if (!name) { $("exd-e-name").focus(); showToast("Введи название упражнения"); return; }
  const atlas = Object.assign(ex.atlas ? JSON.parse(JSON.stringify(ex.atlas)) : {}, {
    equipment: $("exe-equip").value.trim(),
    level: levelSel.getOne() || "",
    target:     targetSel.get(),
    synergist:  synSel.get(),
    stabilizer: stabSel.get(),
    categories: moveSel.get(),
    technique: $("exe-tech").value.trim(),
    mistakes: $("exe-mistakes").value.split("\n").map(s => s.trim()).filter(Boolean),
    differences: $("exe-diff").value.trim(),
    extra: $("exe-extra").value.trim(),
    contraindications: $("exe-contra").value.trim(),
    referenceUrl: $("exe-ref").value.trim(),
  });
  const payload = {
    name, type: typeSel.getOne() === "Бег" ? "run" : "strength",
    cat: catSel.getOne() || "Другое",
    media: $("exe-media").value.trim(),
    tip: $("exe-tip").value.trim(),
    atlas,
  };
  DATA.updateOwnExercise(userId, _detailExerciseId, payload);
  SyncQueue.push("exercise:update", { id: _detailExerciseId });
  DATA.setExerciseGroupByName(userId, _detailExerciseId, $("exe-group").value);
  showToast("Упражнение обновлено");
  renderExercisesList(exercisesSearch.value);
  openExerciseDetail(_detailExerciseId, _exdReturnScreen);  // сам вызовет exitExerciseEdit()
}

$("exd-edit-btn").addEventListener("click", enterExerciseEdit);
$("exd-edit-save").addEventListener("click", saveExerciseEdit);
$("exd-edit-cancel").addEventListener("click", () => openExerciseDetail(_detailExerciseId, _exdReturnScreen));

/* ==========================================================================
   Screen: detail view (просмотр тренировки из истории)
   ========================================================================== */
let _detailReturnScreen = "menu";
function openDetailScreen(workout, returnScreen = "menu", scrollToExerciseId = null) {
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
    const totalVol  = allEx.reduce((v, ex) => v + ex.sets.reduce((a, s) => a + (s.done ? setVolume(s) : 0), 0), 0);

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
    // личным максимумом по весу для этого упражнения (вес может быть
    // отрицательным — упражнения с помощью, см. applySetToRecord).
    const isPrSet = (rec, s) => !!rec && rec.maxWeight != null && !s.dropSet && s.weight === rec.maxWeight && s.reps === rec.repsAtMaxWeight;
    // Компактная дата для стрелок навигации по истории упражнения («12 июн»).
    const shortDate = (ts) => new Date(ts).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
    const chevron = (dir) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${dir === "prev" ? '<polyline points="15 18 9 12 15 6"/>' : '<polyline points="9 18 15 12 9 6"/>'}</svg>`;

    body.innerHTML = `
      <div class="wd-statgrid">
        <div class="wd-stat"><div class="wd-stat-val"><span class="wd-stat-num">${allEx.length}</span></div><div class="wd-stat-label">Упражнения</div></div>
        <div class="wd-stat"><div class="wd-stat-val"><span class="wd-stat-num">${totalSets}</span></div><div class="wd-stat-label">Подходы</div></div>
        <div class="wd-stat"><div class="wd-stat-val">${totalVol ? `<span class="wd-stat-num">${totalVol.toLocaleString("ru-RU")}</span> <span class="wd-stat-unit">кг</span>` : dash}</div><div class="wd-stat-label">Тоннаж</div></div>
        <div class="wd-stat"><div class="wd-stat-val">${workout.durationSec ? statTimeHTML(workout.durationSec) : dash}</div><div class="wd-stat-label">Время</div></div>
      </div>
      ${allEx.map((ex, exIdx) => {
        const known    = exercises.find(e => e.id === ex.exerciseId);
        const exDef    = known || { name: ex.name || "Упражнение недоступно" };
        const isOrphan = !known;   // упражнение удалено из базы — есть только в истории
        // Суперсет (только для чтения): подряд идущие блоки с общим supersetId.
        const ssId       = ex.supersetId || null;
        const ssPrev     = !!ssId && allEx[exIdx - 1] && allEx[exIdx - 1].supersetId === ssId;
        const ssNext     = !!ssId && allEx[exIdx + 1] && allEx[exIdx + 1].supersetId === ssId;
        const ssClass    = ssId ? ` wd-ss${ssPrev ? "" : " wd-ss-first"}${ssNext ? "" : " wd-ss-last"}` : "";
        const doneSets = ex.sets.filter(s => s.done);
        const rec      = records[ex.exerciseId];
        const exVol    = doneSets.reduce((v, s) => v + setVolume(s), 0);
        const hasPr    = doneSets.some(s => isPrSet(rec, s));
        // Тоннаж-рекорд: максимальный объём за одну тренировку для упражнения.
        const volPr    = !!rec && exVol > 0 && exVol >= (rec.maxVolume || 0);
        const anyRpe   = doneSets.some(s => s.rpe);
        // Рекорд подсвечиваем только у ПЕРВОГО подхода с рекордным весом:
        // если следующие подходы повторяют тот же вес — это уже не рекорд.
        let prShown    = false;
        // Номер — только у обычных подходов; дроп-сет и так виден по отступу
        // (см. .wd-set-drop), как и на экране тренировки.
        let mainNum = 0;
        const setLabels = doneSets.map(s => { if (s.dropSet) return ""; mainNum++; return `${mainNum}`; });
        // Соседние тренировки с этим упражнением — для перехода по его истории
        // (назад к прошлому выполнению / вперёд к следующему).
        const prevW = DATA.adjacentWorkoutForExercise(userId, ex.exerciseId, workout.startedAt, "prev");
        const nextW = DATA.adjacentWorkoutForExercise(userId, ex.exerciseId, workout.startedAt, "next");
        return `<div class="wd-ex${ssClass}" data-ex-id="${ex.exerciseId}">
          <div class="wd-ex-head">
            <span class="wd-ex-name${isOrphan ? " orphan" : ""}">${escHtml(exDef.name)}</span>
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
                return `<div class="wd-set${s.dropSet ? " wd-set-drop" : ""}">
                  <span class="wd-set-num">${setLabels[i]}</span>
                  <div class="wd-cell${pr ? " pr" : ""}">${pr ? "★ " : ""}${s.weight || "—"}</div>
                  <div class="wd-cell">${s.reps}</div>
                  ${anyRpe ? `<div class="wd-cell wd-rpe ${s.rpe ? rpeClass(s.rpe) : "none"}">${s.rpe || "—"}</div>` : ""}
                </div>`;
              }).join("")}
            </div>` : `<div class="wd-empty">Нет выполненных подходов</div>`}
          ${isOrphan ? `<button class="wd-ex-remap" data-remap-id="${escHtml(ex.exerciseId)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            Заменить упражнение</button>` : ""}
          ${(prevW || nextW) ? `
            <div class="wd-ex-nav">
              ${prevW
                ? `<button class="wd-ex-nav-btn" data-ex-id="${ex.exerciseId}" data-nav="prev" title="Прошлое выполнение — ${escHtml(fmtDate(prevW.startedAt))}">${chevron("prev")}<span>${escHtml(shortDate(prevW.startedAt))}</span></button>`
                : `<span class="wd-ex-nav-btn disabled">${chevron("prev")}<span>—</span></span>`}
              ${nextW
                ? `<button class="wd-ex-nav-btn" data-ex-id="${ex.exerciseId}" data-nav="next" title="Следующее выполнение — ${escHtml(fmtDate(nextW.startedAt))}"><span>${escHtml(shortDate(nextW.startedAt))}</span>${chevron("next")}</button>`
                : `<span class="wd-ex-nav-btn disabled"><span>—</span>${chevron("next")}</span>`}
            </div>` : ""}
        </div>`;
      }).join("")}
      <button class="wd-add-btn" id="save-as-template-btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Добавить в шаблоны
      </button>
    `;

    $("save-as-template-btn").addEventListener("click", () => openSaveAsTemplateModal(workout));

    // Замена «осиротевшего» упражнения (удалено из базы — в истории висит как
    // «Упражнение недоступно», не попадает в статистику). Пикер базы → глобальный
    // remapExercise: перепривязывает ВСЕ вхождения этого id в истории/шаблонах и
    // пересчитывает рекорды, чтобы записи наконец учлись в статистике.
    body.querySelectorAll(".wd-ex-remap[data-remap-id]").forEach(btn => {
      btn.addEventListener("click", () => {
        const oldId = btn.dataset.remapId;
        openExercisePicker(newId => {
          const n = DATA.remapExercise(userId, oldId, newId);
          if (n) {
            SyncQueue.push("exercise:remap", { from: oldId, to: newId });
            SyncQueue.push("user:update", {});   // рекорды пересчитаны
            showToast("Упражнение заменено — записи учтены в статистике");
            renderHistory(userId);
            const updated = DATA.getWorkoutHistory(userId).find(w => w.id === workout.id) || workout;
            openDetailScreen(updated, _detailReturnScreen);
          }
        }, null);
      });
    });

    // Переход по истории конкретного упражнения: открываем деталь соседней
    // тренировки, проматывая сразу к тому же упражнению (тот же экран возврата).
    body.querySelectorAll(".wd-ex-nav-btn[data-nav]").forEach(btn => {
      btn.addEventListener("click", () => {
        const target = DATA.adjacentWorkoutForExercise(userId, btn.dataset.exId, workout.startedAt, btn.dataset.nav);
        if (!target) return;
        haptic();
        openDetailScreen(target, returnScreen, btn.dataset.exId);
      });
    });
  }

  goToScreen("detail");

  // Открыли деталь ради конкретного упражнения (тап по бейджу-рекорду на экране
  // тренировки) — подматываем список прямо к нему и коротко подсвечиваем, чтобы
  // не искать глазами. rAF — дождаться раскладки после смены экрана; scrollIntoView
  // центрирует карточку в прокручиваемом теле детали.
  if (scrollToExerciseId) {
    requestAnimationFrame(() => {
      const target = body.querySelector(`.wd-ex[data-ex-id="${scrollToExerciseId}"]`);
      if (target) {
        // НЕ scrollIntoView: на iOS-standalone он прокручивает и внешний
        // контейнер (документ), утягивая шапку под часы статус-бара. Двигаем
        // scrollTop ТОЛЬКО у прокручиваемого тела детали — шапка остаётся на
        // месте. Центрируем карточку через разницу getBoundingClientRect,
        // независимо от offsetParent.
        const bodyRect = body.getBoundingClientRect();
        const tRect = target.getBoundingClientRect();
        const delta = (tRect.top - bodyRect.top) - (body.clientHeight - tRect.height) / 2;
        // МГНОВЕННО, без smooth: при переходе «вперёд» по истории цель далеко от
        // текущей позиции, и длинный плавный скролл выглядел рваным («упражнение
        // сверху, потом падает вниз»). Позиционируем сразу — а «вот оно» показывает
        // короткая вспышка карточки.
        body.scrollTop = body.scrollTop + delta;
        target.classList.add("wd-ex-flash");
        setTimeout(() => target.classList.remove("wd-ex-flash"), 1600);
      }
    });
  }

  // Удаление доступно из списка истории (свайп/долгое нажатие) — на экране
  // деталей оставляем только редактирование, чтобы не удалить случайно.
  // Повторный тап по карандашу в режиме редактирования = отмена без сохранения.
  $("detail-edit-btn").onclick = () => {
    const editBtn = $("detail-edit-btn");
    // Силовые правим в полном редакторе заполнения (тот же экран, что и во время
    // тренировки) — единый код, правки применяются везде сразу. Бег — прежний
    // инлайновый редактор в деталке (у него свои поля: дистанция/темп/пульс).
    if (workout.type !== "run") {
      delete editBtn.dataset.editing;
      openWorkoutEditor(workout);
      return;
    }
    if (editBtn.dataset.editing === "1") {
      delete editBtn.dataset.editing;
      openDetailScreen(workout, _detailReturnScreen);
    } else {
      editBtn.dataset.editing = "1";
      openDetailEditMode(workout);
    }
  };
}

// Инлайновый редактор в деталке — ТОЛЬКО для бега (свои поля: дистанция, темп,
// пульс, каденс). Силовые тренировки редактируются в полном редакторе заполнения
// (openWorkoutEditor) — единый код с экраном «во время тренировки».
function openDetailEditMode(workout) {
  const userId = DATA.getCurrentUser();
  const draft  = JSON.parse(JSON.stringify(workout));
  const body = $("detail-screen-body");
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
  strength.forEach(w => (w.exercises||[]).forEach(ex => (ex.sets||[]).filter(s=>s.done&&s.reps>0).forEach(s=>{ volume+=setVolume(s); })));

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
      // Вес — без фильтра по >0 (упражнения с помощью работают в минусе, см.
      // getExerciseProgress); тоннаж по-прежнему через setVolume — минус в
      // тоннаж не идёт.
      const done = (ex.sets||[]).filter(s=>s.done&&s.reps>0);
      if (!done.length) return;
      graphPoints.push({ ts: w.startedAt, maxWeight: Math.max(...done.map(s=>s.weight||0)), volume: Math.round(done.reduce((a,s)=>a+setVolume(s),0)) });
    });
  }

  // Прогресс за период — отдельной ячейкой под графиком
  const gpInPeriod = graphPoints.filter(p=>p.ts>=ps);
  let progTxt = "—", progValCls = "";
  if (gpInPeriod.length>=2 && gpInPeriod[0].maxWeight!==0) {
    // Знаменатель — |первое значение|, а не само число: для упражнений с
    // помощью вес отрицательный, и деление на отрицательное число развернуло
    // бы знак (реальное улучшение — приближение к нулю — показалось бы
    // регрессом). |x| работает верно в обоих случаях.
    const first = gpInPeriod[0].maxWeight, last = gpInPeriod[gpInPeriod.length-1].maxWeight;
    const pct = Math.round((last - first) / Math.abs(first) * 100);
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

  // Старые упражнения из истории, которых нет в новой базе — предложить привязку,
  // чтобы статистика/рекорды считались корректно (после перехода на «Атлас»).
  const orphans = DATA.getOrphanExercises(userId);
  const orphanBanner = orphans.length ? `
    <button class="s-orphan-banner" id="s-orphan-btn">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
      <span><b>Старых упражнений: ${orphans.length}</b><small>Привяжи к базе, чтобы учитывалась статистика</small></span>
      <svg class="s-orphan-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
    </button>` : "";

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
      ${orphanBanner}
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

  const orphanBtn = $("s-orphan-btn");
  if (orphanBtn) orphanBtn.addEventListener("click", () => openOrphanRemapSheet());
}

// Лист перепривязки старых упражнений: список «сирот» из истории, у каждого —
// «Заменить на…» → общий пикер базы → DATA.remapExercise (история/шаблоны/рекорды).
function openOrphanRemapSheet() {
  const userId = DATA.getCurrentUser();
  const existing = $("orphan-remap-backdrop");
  if (existing) existing.remove();

  const backdrop = document.createElement("div");
  backdrop.id = "orphan-remap-backdrop";
  backdrop.className = "stats-picker-backdrop";
  const sheet = document.createElement("div");
  sheet.className = "stats-picker-sheet";
  backdrop.appendChild(sheet);
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add("open"));
  const close = () => { backdrop.classList.remove("open"); setTimeout(() => backdrop.remove(), 250); };
  backdrop.addEventListener("click", e => { if (e.target === backdrop) close(); });

  const rebuild = () => {
    const orphans = DATA.getOrphanExercises(userId);
    if (!orphans.length) { close(); initStatsScreen(); return; }
    sheet.innerHTML = `<div class="stats-picker-handle"></div>
      <div class="stats-picker-title">Старые упражнения</div>
      <p class="orphan-hint">Эти упражнения есть в истории, но их нет в новой базе. Выбери, чем заменить — статистика и рекорды перейдут на новое упражнение.</p>
      <div class="orphan-list">${orphans.map(o => `
        <div class="orphan-row">
          <div class="orphan-info"><span class="orphan-name">${escHtml(o.name)}</span><span class="orphan-count">${o.count}× в истории</span></div>
          <button class="orphan-pick" data-old="${escHtml(o.id)}">Заменить на…</button>
        </div>`).join("")}</div>`;
    sheet.querySelectorAll(".orphan-pick").forEach(btn => {
      btn.addEventListener("click", () => {
        const oldId = btn.dataset.old;
        openExercisePicker(newId => {
          const n = DATA.remapExercise(userId, oldId, newId);
          if (n) { SyncQueue.push("exercise:remap", { from: oldId, to: newId }); showToast("Перепривязано"); }
          rebuild();
        }, null);
      });
    });
  };
  rebuild();
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
  // Реальные данные не уходят в минус (дистанция/темп/вес обычной штанги) —
  // тогда зажимаем низ оси в 0, не отдавая пустой отступ под несуществующие
  // отрицательные значения. Но упражнения с помощью (гравитрон) — вес
  // изначально отрицательный: тут зажимать в 0 нельзя, иначе график схлопнется.
  const rawMinNonNegative = minY >= 0;
  if (minY === maxY) { minY -= 1; maxY += 1; }
  const yPad = (maxY - minY) * 0.18;
  minY -= yPad; maxY += yPad;
  if (minY < 0 && rawMinNonNegative) minY = 0;

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
  const constructorBtn = `<button class="tpl-constructor-btn" id="tpl-constructor-btn">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/><circle cx="12" cy="12" r="3.2"/></svg>
    <span><b>Собрать тренировку</b><small>Конструктор по движениям и балансу</small></span>
    <svg class="tpl-constructor-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
  </button>`;
  templatesScroll.innerHTML = `<div class="tpl-list">${constructorBtn}${cards}${tplAddBtnHtml()}</div>`;

  list.forEach(t => wireTplCard(t.id));
  const addBtn = $("tpl-add-new");
  if (addBtn) addBtn.addEventListener("click", createNewTemplate);
  const conBtn = $("tpl-constructor-btn");
  if (conBtn) conBtn.addEventListener("click", () => { exitTplEditMode(); goToScreen("constructor"); });
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
$("constructor-back-btn").addEventListener("click", () => goToScreen("templates"));

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
  const tpl = DATA.getTemplates(userId).find(t => t.id === id);
  if (!tpl) return;
  openConfirmModal({
    title: "Удалить шаблон?",
    message: `«${tpl.name || "Шаблон"}» будет удалён. Вернуть можно в настройках → «Недавно удалённые».`,
    confirmLabel: "Удалить",
    onConfirm: () => {
      const trashId = Trash.push(userId, { type: "template", label: tpl.name || "Шаблон", sub: "Шаблон", data: { template: JSON.parse(JSON.stringify(tpl)) } });
      const snapshot = [...DATA.getTemplates(userId)];
      DATA.deleteTemplate(userId, id);
      SyncQueue.push("template:delete", { templateId: id });
      renderTemplatesList();
      showUndoToast("Шаблон удалён", () => {
        Trash.remove(userId, trashId);
        DATA.saveTemplates(userId, snapshot);
        SyncQueue.push("template:create", {});
        renderTemplatesList();
        showToast("Восстановлено");
      });
    },
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
      // Возврат карточки + подтверждение (удаление/корзина внутри).
      row.style.transition = "transform 0.18s ease"; row.style.transform = "";
      wrap.classList.remove("will-delete");
      setTimeout(() => wrap.classList.remove("swiping"), 200);
      deleteTemplateWithUndo(id);
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
  // Авто-обновление PWA. Раньше location.reload() (в т.ч. кнопка «Синхронизация»)
  // НЕ обновляла приложение: старый service worker продолжал отдавать старый
  // каркас из кэша, и единственным способом получить новую версию было снести
  // иконку с рабочего стола и добавить заново. Теперь:
  //   • sw.js делает skipWaiting (install) + clients.claim (activate) — новая
  //     версия активируется сразу, как только браузер её скачал;
  //   • здесь ловим controllerchange (момент, когда новый SW перехватил
  //     управление страницей) и перезагружаемся — уже на свежий каркас.
  // Итог: достаточно открыть/свернуть-развернуть приложение (или нажать
  // «Синхронизация»), сносить с рабочего стола больше не нужно.
  let _reloadedForUpdate = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (_reloadedForUpdate) return;
    // Посреди активной тренировки не перезагружаем молча — предлагаем тапом,
    // чтобы не сбить с толку в середине подхода (активная тренировка переживёт
    // перезагрузку — она в localStorage, — но резкий reload всё равно неприятен).
    const inWorkout = document.getElementById("screen-workout")?.classList.contains("active")
                   || document.getElementById("screen-run")?.classList.contains("active");
    if (inWorkout) {
      showActionToast("Доступна новая версия", "Обновить", () => { _reloadedForUpdate = true; location.reload(); }, 0);
      return;
    }
    _reloadedForUpdate = true;
    location.reload();
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js")
      .then(reg => reg.update())   // сразу проверить, нет ли новой версии
      .catch(() => { /* нет SW — офлайн-режим работает только на уже загруженных данных */ });
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
    "screen-muscle-detail":   "msd-back-btn",
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
    // Спрятанная (display:none) шторка-справочник — та, из которой мы ушли в
    // карточку мышцы, — НЕ должна блокировать свайп-назад: она видимо закрыта.
    const sheets = document.querySelectorAll(".modal-backdrop.open, .picker-backdrop.open, .bottom-sheet-backdrop.open, .stats-picker-backdrop.open, .settings-modal-backdrop.open");
    for (const s of sheets) { if (s.style.display !== "none") return true; }
    return false;
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

// Справочник Атласа обновился из облака (Bridge.hydrate подменил ATLAS) —
// перерисовываем открытый экран, чтобы правки админа/новые данные проявились
// без перезагрузки. Дёргается только при реальном изменении содержимого.
window.onAtlasUpdated = function () {
  if (screenExercises && screenExercises.classList.contains("active")) {
    try { renderExercisesList(exercisesSearch.value); } catch {}
  }
  if (screenMenu && screenMenu.classList.contains("active")) {
    try { refreshMenu(); } catch {}
  }
};

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

// Ориентацию больше не блокируем: приложение адаптируется под любую ширину
// (портрет телефона — основной вид, а на широких экранах подаётся центрированной
// карточкой-устройством, см. media (min-width: 481px) в index.html).
