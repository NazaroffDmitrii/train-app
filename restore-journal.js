/* Local import write-ahead journal used by the isolated restore page.
 * Caller must hold an exclusive restore lock, stop all DATA/sync writers,
 * validate the candidate and recheck account/profile access before use.
 * localStorage is NOT transactional; this module does not claim otherwise.
 */
const RestoreJournal = (() => {
  const KEY = "train_import_journal";
  function create(storage, fields) {
    const allowedFields = new Set(fields);
    function validate(journal) {
      if (journal?.format !== "train-restore-journal" || journal.version !== 1 ||
          typeof journal.user !== "string" || !journal.user ||
          !["prepared", "applied", "complete", "rolled-back"].includes(journal.phase) ||
          !Array.isArray(journal.entries) || !journal.entries.length || journal.entries.length > allowedFields.size) throw Error("Некорректный журнал восстановления");
      const keys = new Set();
      for (const entry of journal.entries) {
        if (!entry || !allowedFields.has(entry.field) || entry.key !== `train_${entry.field}_${journal.user}` || keys.has(entry.key) ||
            (entry.before !== null && typeof entry.before !== "string") || typeof entry.after !== "string") throw Error("Недопустимая запись журнала");
        keys.add(entry.key);
      }
      return journal;
    }
    function read(user) {
      const raw = storage.getItem(KEY);
      if (raw === null) return null;
      const journal = validate(JSON.parse(raw));
      if (journal.user !== user) throw Error("Журнал принадлежит другому профилю");
      return {raw, journal};
    }
    function put(key, value) {
      if (value === null) storage.removeItem(key); else storage.setItem(key, value);
      if (storage.getItem(key) !== value) throw Error("Хранилище не подтвердило запись");
    }
    function unchanged(raw) {
      if (storage.getItem(KEY) !== raw) throw Error("Журнал изменился; восстановление остановлено");
    }
    function begin(user, changes, guard, meta) {
      if (typeof guard !== "function") throw Error("Нужна проверка контекста восстановления");
      guard();
      if (storage.getItem(KEY) !== null) throw Error("Предыдущий журнал ещё не обработан");
      const journal = validate({format:"train-restore-journal",version:1,user,phase:"prepared",meta,entries:changes.map(change=>({...change}))});
      for (const entry of journal.entries) {
        if (storage.getItem(entry.key) !== entry.before) throw Error("Данные изменились после просмотра плана");
      }
      // The whole undo snapshot must be durable before the first live write.
      const raw = JSON.stringify(journal);
      guard();
      put(KEY, raw);
      return read(user);
    }
    function apply(user, guard) {
      if (typeof guard !== "function") throw Error("Нужна проверка контекста восстановления");
      const state = read(user);
      if (!state || state.journal.phase !== "prepared") throw Error("Нет подготовленного журнала");
      guard();
      // Preflight every key before touching any key. A partial earlier attempt
      // can be resumed, but an unrelated edit must never be silently replaced.
      for (const entry of state.journal.entries) {
        const value = storage.getItem(entry.key);
        if (value !== entry.before && value !== entry.after) throw Error("Обнаружены новые изменения; применение остановлено");
      }
      for (const entry of state.journal.entries) {
        guard(); unchanged(state.raw);
        const value = storage.getItem(entry.key);
        if (value === entry.after) continue;
        if (value !== entry.before) throw Error("Данные изменились во время восстановления");
        put(entry.key, entry.after);
      }
      guard(); unchanged(state.raw);
      for (const entry of state.journal.entries) if (storage.getItem(entry.key) !== entry.after) throw Error("Результат восстановления изменился");
      put(KEY, JSON.stringify({...state.journal,phase:"applied"}));
      return read(user);
    }
    function rollback(user, guard) {
      if (typeof guard !== "function") throw Error("Нужна проверка контекста восстановления");
      const state = read(user);
      if (!state) throw Error("Журнал не найден");
      guard();
      for (const entry of state.journal.entries) {
        const value = storage.getItem(entry.key);
        if (value !== entry.before && value !== entry.after) throw Error("Есть новые изменения; автоматический откат остановлен");
      }
      for (const entry of [...state.journal.entries].reverse()) {
        guard(); unchanged(state.raw);
        const value = storage.getItem(entry.key);
        if (value === entry.before) continue;
        if (value !== entry.after) throw Error("Данные изменились во время отката");
        put(entry.key, entry.before);
      }
      guard(); unchanged(state.raw);
      for (const entry of state.journal.entries) if (storage.getItem(entry.key) !== entry.before) throw Error("Результат отката изменился");
      put(KEY, JSON.stringify({...state.journal,phase:"rolled-back"}));
      return read(user);
    }
    function complete(user, guard) {
      const state = read(user);
      if (!state || state.journal.phase !== "applied") throw Error("Нет применённого журнала");
      guard(); unchanged(state.raw);
      put(KEY, JSON.stringify({...state.journal,phase:"complete"}));
    }
    return {begin, apply, rollback, read, complete};
  }
  return {create};
})();
if (typeof module !== "undefined" && module.exports) module.exports = RestoreJournal;
