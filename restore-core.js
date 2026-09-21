/* Pure restore plan + restartable coordinator. No implicit cloud writes. */
const RestoreCore = (() => {
  const tables = {own_exercises:"user_exercises",templates:"user_templates",exercise_groups:"user_exercise_groups",own_muscles:"user_muscles",own_movements:"user_movements"};
  const hidden = {hidden:"exercise",hidden_muscles:"muscle",hidden_movements:"movement"};
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value==="object" ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
  const hash = value => JSON.stringify(canonical(value));
  function build(candidate, user, author, storage, cloud, accountOwner) {
    const verified=prepareUserImport(JSON.stringify({app:"train.",version:2,user:candidate.user,data:candidate.data}),user);
    const snapshot={}, values={}, selected=new Set();
    for(const field of BACKUP_FIELDS){
      const key=`train_${field}_${user}`;snapshot[key]=storage.getItem(key);
      if(Object.hasOwn(verified.data,key))selected.add(field);
      const raw=Object.hasOwn(verified.data,key)?verified.data[key]:snapshot[key];
      values[field]=raw===null?null:JSON.parse(raw);
    }
    const operations=[], shadowKey=`train_sync_shadow_${user}`;
    const shadowRaw=storage.getItem(shadowKey),shadow=JSON.parse(shadowRaw||"{}");
    if(!shadow||typeof shadow!=="object"||Array.isArray(shadow))throw Error("Повреждена тень синхронизации");
    let cloudDeletes=0;
    function rowsFor(table){
      const rows=cloud[table];
      if(!Array.isArray(rows)||rows.some(row=>row.user_id!==user))throw Error("Не удалось получить полный снимок: "+table);
      return rows;
    }
    function entities(table, rows, keyOf, tombstone, filter=()=>true){
      const previous=rowsFor(table).filter(filter),keys=new Set(rows.map(keyOf));
      const next={...(shadow[table]||{})};
      for(const oldKey of Object.keys(next))if(filter({kind:oldKey.split(":")[0]}))delete next[oldKey];
      for(const row of rows){const key=keyOf(row);operations.push({opId:`ent:${table}:${user}|${key}`,type:"saveEntity",args:{table,row}});next[key]=hash(row);}
      for(const row of previous)if(!row.deleted&&!keys.has(keyOf(row))&&tombstone){
        const key=keyOf(row);operations.push({opId:`ent:${table}:${user}|${key}`,type:"saveEntity",args:{table,row:tombstone(row)}});cloudDeletes++;
      }
      shadow[table]=next;
    }
    for(const [field,table] of Object.entries(tables))if(selected.has(field)){
      const rows=values[field].map((entry,position)=>{const {id,...data}=entry;return {user_id:user,id,data,position,deleted:false};});
      entities(table,rows,row=>row.id,row=>({user_id:user,id:row.id,deleted:true}));
    }
    if(selected.has("categories")||selected.has("custom_categories")||selected.has("category_colors")){
      const previous=rowsFor("user_categories").filter(row=>!row.deleted);
      const names=selected.has("categories")?values.categories:selected.has("custom_categories")?values.custom_categories:previous.map(row=>row.name);
      const colors=selected.has("category_colors")?values.category_colors:Object.fromEntries(previous.map(row=>[row.name,row.color]));
      const rows=names.map((name,position)=>({user_id:user,name,color:colors[name]??null,position,deleted:false}));
      entities("user_categories",rows,row=>row.name,row=>({user_id:user,name:row.name,deleted:true}));
      // Normalize legacy categories to the canonical local field too.
      values.categories=names;selected.add("categories");
      values.category_colors=Object.fromEntries(rows.filter(row=>row.color!==null).map(row=>[row.name,row.color]));selected.add("category_colors");
    }
    if(Object.keys(hidden).some(field=>selected.has(field))){
      const selectedKinds=new Set(Object.keys(hidden).filter(field=>selected.has(field)).map(field=>hidden[field]));
      const rows=Object.entries(hidden).filter(([field])=>selected.has(field)).flatMap(([field,kind])=>values[field].map(ref_id=>({user_id:user,kind,ref_id,deleted:false})));
      entities("user_hidden",rows,row=>row.kind+":"+row.ref_id,row=>({user_id:user,kind:row.kind,ref_id:row.ref_id,deleted:true}),row=>selectedKinds.has(row.kind));
    }
    if(selected.has("ex_order"))entities("user_ordering",[{user_id:user,ordered_ids:values.ex_order}],()=>"ordering",null);
    if(selected.has("history")){
      const existing=rowsFor("workouts"),byId=new Map(existing.map(row=>[row.id,row]));
      const ids=new Set(values.history.map(workout=>workout.id));
      for(const workout of values.history){
        const {id,type,startedAt,createdBy,...data}=workout;
        operations.push({opId:"wk:"+id,type:"saveWorkout",args:{id,user_id:user,created_by:byId.get(id)?.created_by||author,type,performed_at:new Date(startedAt).toISOString(),data}});
      }
      for(const row of existing)if(!ids.has(row.id)){operations.push({opId:"wk:"+row.id,type:"deleteWorkout",args:{userId:user,id:row.id}});cloudDeletes++;}
      // Index/records are derived; never import fabricated personal records.
      values.workout_index=values.history.map(({id,type,name,startedAt,durationSec})=>({id,type,name,startedAt,durationSec}));
      const records={};
      for(const workout of values.history)for(const exercise of workout.exercises||[])for(const set of exercise.sets||[]){
        if(!set.done||!Number.isFinite(set.weight)||!Number.isFinite(set.reps)||set.reps<=0)continue;
        const record=records[exercise.exerciseId] ||= {maxWeight:null,repsAtMaxWeight:0,maxReps:0,weightAtMaxReps:null,maxVolume:0};
        if(record.maxWeight===null||set.weight>record.maxWeight||(set.weight===record.maxWeight&&set.reps>record.repsAtMaxWeight)){record.maxWeight=set.weight;record.repsAtMaxWeight=set.reps;}
        if(set.reps>record.maxReps||(set.reps===record.maxReps&&(record.weightAtMaxReps===null||set.weight>record.weightAtMaxReps))){record.maxReps=set.reps;record.weightAtMaxReps=set.weight;}
      }
      values.records=records;selected.add("records");selected.add("workout_index");
    }else{selected.delete("records");selected.delete("workout_index");}
    if(selected.has('active')&&accountOwner){
      const previous=JSON.parse(snapshot[`train_active_${user}`]||'null');
      if(previous&&previous._accountOwner!==accountOwner)throw Error('Сначала обработайте черновик исходного аккаунта. Импорт не перезаписывает чужой или неизвестный черновик.');
      if(values.active)values.active._accountOwner=accountOwner;
    }
    const changes=[...selected].map(field=>({field,key:`train_${field}_${user}`,before:snapshot[`train_${field}_${user}`],after:JSON.stringify(values[field])}));
    if(selected.has("own_exercises")||selected.has("categories"))for(const field of ["atlas_migrated","exercises_seeded"]){
      const key=`train_${field}_${user}`;changes.push({field,key,before:storage.getItem(key),after:"true"});
    }
    if(operations.some(op=>op.type==="saveEntity"))changes.push({field:"sync_shadow",key:shadowKey,before:shadowRaw,after:JSON.stringify(shadow)});
    if(!changes.length)throw Error("В копии только производные данные. Для их восстановления нужна история тренировок");
    return {user,snapshot,changes,operations,cloudDeletes};
  }
  function requiredTables(candidate,user){
    const selected=new Set(Object.keys(candidate.data).map(key=>key.slice(6,-(user.length+1))));
    return [...new Set([
      ...Object.entries(tables).filter(([field])=>selected.has(field)).map(([,table])=>table),
      ...(["categories","custom_categories","category_colors"].some(field=>selected.has(field))?["user_categories"]:[]),
      ...(Object.keys(hidden).some(field=>selected.has(field))?["user_hidden"]:[]),
      ...(selected.has("ex_order")?["user_ordering"]:[]),...(selected.has("history")?["workouts"]:[])
    ])];
  }
  function coordinator({storage,outbox,guard}){
    const journal=RestoreJournal.create(storage,[...BACKUP_FIELDS,"sync_shadow","atlas_migrated","exercises_seeded"]);
    function metadata(state,user){
      const meta=state?.journal.meta;
      if(typeof meta?.id!=="string"||!meta.id||typeof meta.owner!=="string"||!meta.owner||!Array.isArray(meta.operations))throw Error("Повреждены метаданные восстановления");
      const ids=new Set(),allowedTables=new Set([...Object.values(tables),"user_categories","user_hidden","user_ordering"]);
      for(const op of meta.operations){
        const args=op?.args;
        let valid=false;
        if(op?.type==="saveWorkout")valid=args?.user_id===user&&typeof args.id==="string"&&!!args.id&&op.opId==="wk:"+args.id&&Number.isFinite(Date.parse(args.performed_at))&&args.data&&typeof args.data==="object"&&!Array.isArray(args.data);
        if(op?.type==="deleteWorkout")valid=args?.userId===user&&typeof args.id==="string"&&!!args.id&&op.opId==="wk:"+args.id;
        if(op?.type==="saveEntity"&&allowedTables.has(args?.table)&&args.row?.user_id===user){
          const row=args.row,key=args.table==="user_categories"?row.name:args.table==="user_hidden"?row.kind+":"+row.ref_id:args.table==="user_ordering"?"ordering":row.id;
          valid=typeof key==="string"&&!!key&&op.opId===`ent:${args.table}:${user}|${key}`;
        }
        if(!valid||ids.has(op.opId))throw Error("Повреждён пакет восстановления");ids.add(op.opId);
      }
      return meta;
    }
    async function finish(user){
      guard();let state=journal.read(user);
      metadata(state,user);
      if(state.journal.phase==="prepared")journal.apply(user,guard);
      state=journal.read(user);
      if(state.journal.phase==="complete")return state;
      if(state.journal.phase!=="applied")throw Error("Этот журнал нельзя завершить");
      guard();await outbox.commitRestore(state.journal.meta.id,user,state.journal.meta.owner,state.journal.meta.operations);
      guard();journal.complete(user,guard);return journal.read(user);
    }
    async function rollback(user){
      guard();const state=journal.read(user);
      if(!state||state.journal.phase==="complete")throw Error("Завершённый импорт нельзя откатить после разрешения отправки");
      metadata(state,user);
      const receipt=await outbox.restoreReceipt(state.journal.meta.id);guard();
      if(receipt)throw Error("Пакет уже зафиксирован в очереди. Нажмите «Завершить восстановление»");
      return journal.rollback(user,guard);
    }
    return {journal,finish,rollback};
  }
  return {build,requiredTables,coordinator};
})();
