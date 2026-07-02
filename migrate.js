/*
 * migrate.js — одноразовый перенос СТАРЫХ локальных данных (localStorage,
 * профили-эпохи dima/natela) в новую облачную реляционную модель (db.js).
 *
 * Зачем отдельно. Прежняя схема хранила всё локально под строковыми id
 * ("dima"/"natela") и синхронизировалась в заброшенную таблицу snapshots. У
 * новых профилей — uuid, данные живут в workouts/user_data. Эти данные есть
 * только на устройстве пользователя, поэтому миграция — ручная операция «с
 * этого устройства в облако» с явным сопоставлением старый профиль → облачный.
 *
 * Безопасность: только ЧИТАЕТ localStorage и ПИШЕТ в облако (upsert). Локальные
 * ключи не трогает — если что-то пойдёт не так, старые данные на месте. Импорт
 * идемпотентен (workout.id — тот же "w_<ts>", upsert по нему), повторный запуск
 * не плодит дубли. Отметка train_migrated_v1 — только чтобы не показывать
 * баннер снова, саму операцию можно повторить вручную.
 */
"use strict";

const Migrate = (() => {
  const DONE_KEY = "train_migrated_v1";
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function get(key, d) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : d; }
    catch { return d; }
  }

  // Легаси-профили = все id из ключей train_history_<id> / train_own_exercises_<id>,
  // которые НЕ являются uuid (новые профили — uuid, их не трогаем).
  function detectLegacyProfiles() {
    const ids = new Set();
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const m = k && k.match(/^train_(?:history|own_exercises)_(.+)$/);
      if (m && !UUID_RE.test(m[1])) ids.add(m[1]);
    }
    return [...ids].map(id => {
      const history = get(`train_history_${id}`, []);
      const own = get(`train_own_exercises_${id}`, []);
      const templates = get(`train_templates_${id}`, []);
      const known = DATA.USERS.find(u => u.id === id); // старые dima/natela → имя
      return {
        id,
        name: known ? known.name : id,
        workouts: history.length,
        exercises: own.length,
        templates: templates.length,
      };
    }).filter(p => p.workouts || p.exercises || p.templates);
  }

  function readLegacy(id) {
    return {
      history:    get(`train_history_${id}`, []),
      own:        get(`train_own_exercises_${id}`, []),
      hidden:     get(`train_hidden_${id}`, []),
      categories: get(`train_categories_${id}`, []),
      colors:     get(`train_category_colors_${id}`, {}),
      order:      get(`train_ex_order_${id}`, null),
      templates:  get(`train_templates_${id}`, []),
    };
  }

  // Перенести легаси-профиль legacyId в облачный targetProfileId.
  // createdById — profiles.id того, кто выполняет импорт (для workouts.created_by).
  async function importInto(legacyId, targetProfileId, createdById) {
    const d = readLegacy(legacyId);

    // Тренировки — построчно, чанками (workouts.created_by нельзя подделать: он
    // должен быть = current_profile_id, поэтому ставим createdById импортёра).
    const rows = (d.history || [])
      .filter(w => w && w.id && w.startedAt)
      .map(w => {
        const { id, type, startedAt, ...data } = w;
        return {
          id, user_id: targetProfileId, created_by: createdById,
          type: type === "run" ? "run" : "strength",
          performed_at: new Date(startedAt).toISOString(),
          data,
        };
      });
    const CHUNK = 100;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await DB.saveWorkouts(rows.slice(i, i + CHUNK));
    }

    // «Мелкое» состояние — одним блобом.
    await DB.saveUserData(targetProfileId, {
      own_exercises:   d.own,
      hidden_ids:      d.hidden,
      categories:      d.categories,
      category_colors: d.colors,
      exercise_order:  d.order,
      templates:       d.templates,
    });

    return { workouts: rows.length, exercises: d.own.length, templates: d.templates.length };
  }

  function isDone() { return localStorage.getItem(DONE_KEY) === "1"; }
  function markDone() { try { localStorage.setItem(DONE_KEY, "1"); } catch {} }

  return { detectLegacyProfiles, readLegacy, importInto, isDone, markDone };
})();
