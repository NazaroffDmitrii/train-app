/* Values written by a checkmark are immutable measurement snapshots.
   Draft values are kept separately so choosing another unit cannot rewrite them. */
(() => {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const numeric = value => value === '' || value == null ? null : Number(String(value).trim().replace(',', '.'));
  const effort = value => Number.isInteger(numeric(value)) && numeric(value)>=1 && numeric(value)<=10 ? numeric(value) : 0;
  const mode = set => set?.metric === 'time' ? 'time' : 'reps';
  const quantity = set => mode(set) === 'time' ? Number(set.durationSec) || 0 : Number(set.reps) || 0;
  const performed = set => !!set?.done && Number.isFinite(quantity(set)) && quantity(set) > 0;
  const volume = set => mode(set) === 'time' ? 0 : Math.max(0, (numeric(set?.weight) || 0) * (numeric(set?.reps) || 0));
  const formatTime = seconds => seconds == null ? '' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  function parseTime(raw) {
    const value = String(raw ?? '').trim();
    if (!value) return null;
    if (/^\d+$/.test(value)) return Number.isSafeInteger(Number(value)) ? Number(value) : NaN;
    const match = /^(\d+):([0-5]?\d)$/.exec(value);
    const seconds = match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
    return Number.isSafeInteger(seconds) ? seconds : NaN;
  }
  function executionKey(source) {
    const values = new Map();
    (source?.executionValues || []).forEach(v => {
      if (v && typeof v.id === 'string' && typeof v.value === 'string') values.set(v.id, v.value);
    });
    return JSON.stringify([...values].sort(([a], [b]) => a.localeCompare(b)));
  }
  const setKey = (set, exercise) => executionKey(Array.isArray(set?.executionValues) ? set : exercise);
  function groups(exercise) {
    const list = [];
    (exercise?.sets || []).forEach(set => {
      if (!set.dropSet) list.push({main:set, drops:[]});
      else if (list.length) list.at(-1).drops.push(set);
    });
    return list;
  }
  function previous(history, exercise, metric = exercise.metric || 'reps') {
    const key = executionKey(exercise);
    const sessions = (history || []).filter(w => w?.type === 'strength' && !w.deleted)
      .slice().sort((a,b) => Number(b.startedAt) - Number(a.startedAt));
    for (const workout of sessions) {
      for (const entry of workout.exercises || []) {
        if (entry.exerciseId !== exercise.exerciseId) continue;
        const matching = groups(entry).filter(g => performed(g.main) && setKey(g.main,entry) === key && (metric == null || mode(g.main) === metric));
        if (matching.length) return {workout, exercise:entry, groups:matching};
      }
    }
    return null;
  }
  function previousNote(history, exercise) {
    const key=executionKey(exercise);
    for(const workout of (history || []).filter(w=>w?.type==='strength'&&!w.deleted).slice().sort((a,b)=>Number(b.startedAt)-Number(a.startedAt))){
      const entry=(workout.exercises || []).find(ex=>ex.exerciseId===exercise.exerciseId&&executionKey(ex)===key&&(ex.sets || []).some(s=>performed(s)&&setKey(s,ex)===key));
      if(entry)return typeof entry.note==='string'?entry.note:'';
    }
    return '';
  }
  function record(history, exercise, metric = exercise.metric || 'reps') {
    const key = executionKey(exercise);
    let best = null;
    for (const workout of history || []) {
      if (workout?.type !== 'strength' || workout.deleted) continue;
      for (const entry of workout.exercises || []) {
        if (entry.exerciseId !== exercise.exerciseId) continue;
        for (const set of entry.sets || []) {
          if (!performed(set) || set.dropSet || mode(set) !== metric || setKey(set,entry) !== key) continue;
          const weight = numeric(set.weight) || 0, value = quantity(set);
          const better = !best || (metric === 'time' ? value > best.value || value === best.value && weight > best.weight
            : weight > best.weight || weight === best.weight && value > best.value);
          if (better) best = {weight,value,metric,workout,set};
          // Identical performances point to the first date the record was set.
          else if (weight === best.weight && value === best.value && Number(workout.startedAt) < Number(best.workout.startedAt)) best = {weight,value,metric,workout,set};
        }
      }
    }
    return best;
  }
  function blank(metric = 'reps', dropSet = false) {
    return {weight:0,reps:0,rpe:0,done:false,metric,...(dropSet ? {dropSet:true} : {}),_draft:{weight:null,reps:null,durationSec:null}};
  }
  function draft(set) {
    if (!set._draft) set._draft = {weight:set.done || set.weight ? numeric(set.weight) : null,
      reps:set.reps ? numeric(set.reps) : null,durationSec:set.durationSec ? numeric(set.durationSec) : null};
    return set._draft;
  }
  function prepare(exercise, metric) {
    exercise.metric = ['reps','time'].includes(exercise.metric) ? exercise.metric : metric || 'reps';
    exercise.sets ||= [];
    for (const set of exercise.sets) {
      set.rpe = effort(set.rpe);
      set.metric ||= set.durationSec > 0 && !(set.reps > 0) ? 'time' : 'reps';
      draft(set);
      if (set.done && !Array.isArray(set.executionValues)) {
        set.executionValues = clone(exercise.executionValues || []);
        set.executionParameters = clone(exercise.executionParameters || []);
      }
      if (!set.done) set.metric = exercise.metric;
    }
    return exercise;
  }
  function seed(history, exercise, metric = 'reps') {
    const previousExercise = previous(history,exercise,metric);
    return previousExercise ? previousExercise.groups.flatMap(g => [blank(metric),...g.drops.filter(performed).map(() => blank(metric,true))]) : [blank(metric)];
  }
  function chooseMetric(exercise, metric) {
    if (!['reps','time'].includes(metric)) return;
    exercise.metric = metric;
    exercise.sets.forEach(set => {if (!set.done) set.metric = metric;});
  }
  function children(exercise, main) {
    const start = exercise.sets.indexOf(main), result = [];
    for (let i=start+1; start >= 0 && i < exercise.sets.length && exercise.sets[i].dropSet; i++) result.push(exercise.sets[i]);
    return result;
  }
  function measurement(exercise, set, old) {
    const metric = exercise.metric || 'reps', input = draft(set);
    const compatible = old && mode(old) === metric;
    const value = input[metric === 'time' ? 'durationSec' : 'reps'] ?? (compatible ? quantity(old) : null);
    const weight = input.weight ?? (compatible ? numeric(old.weight) : 0) ?? 0;
    if (!Number.isFinite(weight) || !Number.isSafeInteger(value) || value <= 0) throw Error(metric === 'time' ? 'Укажи время подхода' : 'Укажи количество повторений');
    return {weight,metric,reps:metric === 'reps' ? value : 0,...(metric === 'time' ? {durationSec:value} : {}),
      rpe:effort(set.rpe) || (compatible ? effort(old.rpe) : 0),
      executionParameters:clone(exercise.executionParameters || []),executionValues:clone(exercise.executionValues || [])};
  }
  function commit(exercise, main, oldGroup) {
    const mainValue = measurement(exercise,main,oldGroup?.main), drops = children(exercise,main);
    const dropValues = drops.map((set,i) => {
      const d = draft(set), old = oldGroup?.drops[i];
      const value = d[exercise.metric === 'time' ? 'durationSec' : 'reps'] ?? (old && mode(old) === exercise.metric ? quantity(old) : null);
      return value > 0 ? measurement(exercise,set,old) : null;
    });
    const apply = (set, value) => {
      delete set.durationSec;
      Object.assign(set,value,{done:true});
      set._draft = {weight:value.weight,reps:value.metric === 'reps' ? value.reps : null,durationSec:value.metric === 'time' ? value.durationSec : null};
    };
    apply(main,mainValue);
    drops.forEach((set,i) => {if (dropValues[i]) apply(set,dropValues[i]); else set.done=false;});
    return main;
  }
  function uncheck(exercise, main) {
    [main,...children(exercise,main)].forEach(set => {set.done=false;set.metric=exercise.metric;});
  }
  function addDrop(exercise, main) {
    if (!main || main.dropSet || !exercise.sets.includes(main)) return null;
    const child = blank(exercise.metric,true), index = exercise.sets.indexOf(main) + children(exercise,main).length + 1;
    exercise.sets.splice(index,0,child);
    return child;
  }
  function remove(exercise, set) {
    const index = exercise.sets.indexOf(set);
    if (index < 0) return [];
    return exercise.sets.splice(index,set.dropSet ? 1 : children(exercise,set).length+1);
  }
  function finalize(workout) {
    const result = clone(workout);
    delete result._restTimer; delete result._workoutView;
    (result.exercises || []).forEach(ex => {
      delete ex._noteOpen; delete ex._noteDismissed;
      (ex.sets || []).forEach(set => {
        // Keep unfinished input for history editing, without treating it as a performed result.
        if(!set.done && set._draft){
          if(set._draft.weight!=null)set.weight=set._draft.weight;
          if(mode(set)==='time')set.durationSec=set._draft.durationSec ?? 0;
          else set.reps=set._draft.reps ?? 0;
        }
        delete set._draft;if(mode(set)==='time')set.reps=0;else delete set.durationSec;
      });
    });
    return result;
  }
  function movementCounts(exercises, definitions, names) {
    const byId = new Map(definitions.map(ex => [ex.id,ex]));
    const counts = new Map(names.map(name => [name,0]));
    for (const ex of exercises || []) {
      const def = byId.get(ex.exerciseId), movements = def?.atlas?.categories || ex.movements || [];
      const completed = (ex.sets || []).filter(s => performed(s) && !s.dropSet).length;
      new Set(movements).forEach(name => {if (counts.has(name)) counts.set(name,counts.get(name)+completed);});
    }
    return [...counts.values()];
  }
  const api = {numeric,effort,mode,quantity,performed,volume,formatTime,parseTime,executionKey,setKey,groups,previous,previousNote,record,blank,draft,prepare,seed,chooseMetric,children,commit,uncheck,addDrop,remove,finalize,movementCounts};
  if (typeof module !== 'undefined' && module.exports) module.exports=api;
  if (typeof window !== 'undefined') window.WorkoutCore=api;
})();
