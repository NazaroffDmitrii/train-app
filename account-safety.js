/* Synchronous write-ahead log: survives a close before Outbox's IDB commit.
 * Entries are account-scoped and removed only after durable enqueue. */
const WorkoutSafety = (() => {
  const prefix = 'train_workout_wal_';
  const clone = value => JSON.parse(JSON.stringify(value));
  function entries(owner, userId) {
    const result = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const raw = localStorage.getItem(key);
      const value = JSON.parse(raw);
      if (value.owner === owner && (!userId || value.userId === userId)) result.push({ key, raw, ...value });
    }
    return result;
  }
  function record(owner, userId, changes) {
    if (!owner) throw Error('Нужен вход для сохранения тренировки.');
    // One batch / one setItem: a bulk edit cannot leave a partial journal.
    const key = prefix + crypto.randomUUID();
    const value = { owner, userId, changes: clone(changes), createdAt: Date.now() };
    localStorage.setItem(key, JSON.stringify(value));
    return key;
  }
  function acknowledge(entry) {
    if (localStorage.getItem(entry.key) === entry.raw) localStorage.removeItem(entry.key);
  }
  // A recovery snapshot must be durable BEFORE applying a cloud replacement.
  // Separate IDB does not change the existing queue / restore schema.
  let dbPromise;
  function database() {
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('train-workout-recovery', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('snapshots', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch(error => { dbPromise = null; throw error; });
    return dbPromise;
  }
  async function backup(owner, userId, history) {
    if (!history.length) return;
    const snapshot = { id: crypto.randomUUID(), owner, userId, at: Date.now(), history: clone(history) };
    const db = await database();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('snapshots', 'readwrite');
      tx.objectStore('snapshots').put(snapshot);
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(tx.error || Error('Не удалось сохранить резервную копию.'));
    });
  }
  async function backups(owner, userId) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('snapshots', 'readonly');
      const req = tx.objectStore('snapshots').getAll();
      tx.oncomplete = () => resolve(req.result.filter(x => x.owner === owner && x.userId === userId));
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  return { entries, record, acknowledge, backup, backups };
})();

/* Local guards shared by account maintenance and active workout storage. */
const AccountSafety = (() => {
  const stable=v=>JSON.stringify(sort(v));
  function sort(v){return Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;}
  function capture(storage,user){
    const data={};
    for(const field of BACKUP_FIELDS){const key=`train_${field}_${user}`,raw=storage.getItem(key);if(raw!==null)data[key]=raw;}
    return {app:'train.',version:2,user,data};
  }
  function unchanged(storage,backup){
    for(const field of BACKUP_FIELDS){const key=`train_${field}_${backup.user}`;if(storage.getItem(key)!==(backup.data[key]??null))throw Error('Локальные данные изменились. Повторите проверку.');}
  }
  function assertClean(backup,user,author,storage,cloud){
    const active=backup.data[`train_active_${user}`];
    if(active&&JSON.parse(active)!==null)throw Error('Сначала завершите активную тренировку и отправьте изменения в облако.');
    const candidate=prepareUserImport(JSON.stringify(backup),user);
    if(!Object.keys(candidate.data).length)return;
    const plan=RestoreCore.build(candidate,user,author,storage,cloud);
    for(const op of plan.operations){
      if(op.type==='deleteWorkout'||op.args.row?.deleted)throw Error('Локальные данные отличаются от облака. Сначала синхронизируйте профиль.');
      const expected=op.args.row||op.args,table=op.args.table||'workouts';
      const rows=cloud[table]||[];
      const found=rows.find(row=>row.user_id===user&&(table==='user_categories'?row.name===expected.name:table==='user_hidden'?row.kind===expected.kind&&row.ref_id===expected.ref_id:table==='user_ordering'?true:row.id===expected.id));
      if(!found||Object.keys(expected).some(key=>key==='performed_at'?Date.parse(found[key])!==Date.parse(expected[key]):stable(found[key]??(key==='deleted'?false:undefined))!==stable(expected[key])))throw Error('Есть локальные изменения без подтверждения облака. Сначала нажмите «В облако» и синхронизируйте профиль.');
    }
  }
  function draftOwner(workout,owner){return !workout||workout._accountOwner===owner;}
  return {capture,unchanged,assertClean,draftOwner};
})();
