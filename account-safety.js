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
