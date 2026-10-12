/* Read-only presentation of saved workouts. Storage and edit actions stay in app.js. */
((root) => {
  'use strict';
  const C = root.WorkoutCore || (typeof module !== 'undefined' ? require('./workout-core.js') : null);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const number = value => Number(value || 0).toLocaleString('ru-RU');
  const paths = {
    star:'<path d="m12 3 2.8 5.7 6.3.9-4.6 4.4 1.1 6.3-5.6-3-5.6 3 1.1-6.3L3 9.6l6.3-.9Z"/>',
    volume:'<path d="M5 20v-6M12 20V9M19 20V4"/>',note:'<path d="M8 3h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM3 7h5M3 12h5M3 17h5M11 8h6M11 12h6"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',prev:'<path d="m15 18-6-6 6-6"/>',next:'<path d="m9 18 6-6-6-6"/>',
    remap:'<path d="M20 4v6h-6M4 20v-6h6M5 9a8 8 0 0 1 13-4l2 5M4 14l2 5a8 8 0 0 0 13-4"/>'
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
  function execution(source) {
    return (source.executionValues || []).map(v => `<span class="wd-execution-value"><span>${esc(v.name)}</span><b>${esc(v.value)}</b></span>`).join('');
  }
  function model(workout, context) {
    const history=context.history || [], cache=new Map();
    const exercises=(workout.exercises || []).map((ex,index) => {
      const known=(context.exercises || []).find(def=>def.id===ex.exerciseId), done=(ex.sets || []).filter(set=>set.done), seen=new Set();
      const rows=done.map(set => {
        const metric=C.mode(set), snapshot=Array.isArray(set.executionValues)?set:ex;
        const key=JSON.stringify([ex.exerciseId,C.executionKey(snapshot),metric]);
        if(!cache.has(key))cache.set(key,C.record(history,{...snapshot,exerciseId:ex.exerciseId,metric},metric));
        const record=cache.get(key);
        const pr=!set.dropSet&&!seen.has(key)&&!!record&&record.workout.id===workout.id&&Number(set.weight || 0)===record.weight&&C.quantity(set)===record.value;
        if(pr)seen.add(key);
        return {set,metric,pr,kind:metric==='time'?'time':'weight',execution:snapshot,
          changedExecution:C.executionKey(snapshot)!==C.executionKey(ex),rpe:C.effort(set.rpe)};
      });
      // Keep the original parent boundary even if that main set was not completed.
      const originalGroups=[],bySet=new Map(rows.map(row=>[row.set,row]));let group=null;
      (ex.sets || []).forEach(set=>{
        const row=bySet.get(set);
        if(!set.dropSet){group={main:row || null,drops:[],orphan:false};originalGroups.push(group);}
        else{
          if(!group){group={main:null,drops:[],orphan:true};originalGroups.push(group);}
          if(row)group.drops.push(row);
        }
      });
      const groups=originalGroups.filter(group=>group.main || group.drops.length).map(group=>group.main?group:{main:group.drops[0],drops:group.drops.slice(1),orphan:true});
      const volume=done.reduce((sum,set)=>sum+C.volume(set),0),rec=context.records?.[ex.exerciseId];
      return {ex,index,name:known?.name || ex.name || 'Упражнение недоступно',orphan:!known,rows,groups,volume,
        volumePr:!!rec&&volume>0&&volume>=Number(rec.maxVolume || 0),
        previous:context.adjacent?.(ex.exerciseId,'prev'),next:context.adjacent?.(ex.exerciseId,'next')};
    });
    return {workout,exercises,sets:exercises.reduce((n,ex)=>n+ex.rows.length,0),volume:exercises.reduce((n,ex)=>n+ex.volume,0)};
  }
  const effortClass = rpe => rpe>=9?'hi':rpe>=7?'mid':'lo';
  function rowHtml(row, index, exIndex, groupIndex, drop=false) {
    const set=row.set, qty=row.metric==='time'?C.formatTime(C.quantity(set)):number(C.quantity(set));
    const label=row.metric==='time'?`Рекорд времени ${qty}`:`Рекорд веса ${number(set.weight)} кг, ${qty} повторений`;
    const value=(content,pr,kind)=>pr?`<button type="button" class="wd-cell pr" data-history-record="${kind}" data-ex-index="${exIndex}" data-group-index="${groupIndex}" aria-label="${esc(label)}">${icon('star')}${content}</button>`:`<div class="wd-cell">${content}</div>`;
    if(drop)return `<div class="wd-drop-row">${row.rpe?`<div class="wd-drop-effort wd-rpe ${effortClass(row.rpe)}" aria-label="Усилие дроп-сета RPE ${row.rpe}"><small>RPE</small>${row.rpe}</div>`:''}<div class="wd-cell wd-drop-weight">${number(set.weight)}</div><div class="wd-cell wd-drop-quantity" aria-label="${row.metric==='time'?'Время':'Повторения'}">${qty}</div></div>${row.changedExecution?`<div class="wd-row-execution">${execution(row.execution)}</div>`:''}`;
    return `<div class="wd-set"><span class="wd-set-num">${index}</span>${value(Number(set.weight)===0?'—':number(set.weight),row.pr&&row.kind==='weight','weight')}${value(qty,row.pr&&row.kind==='time','time')}<div class="wd-cell wd-rpe ${row.rpe?effortClass(row.rpe):'none'}" aria-label="Усилие подхода RPE ${row.rpe || 'не указано'}">${row.rpe || '—'}</div></div>${row.changedExecution?`<div class="wd-row-execution">${execution(row.execution)}</div>`:''}`;
  }
  function render(data, fmtDate) {
    return `<div class="wd-statgrid"><div class="wd-stat"><strong>${data.exercises.length}</strong><small>упражнений</small></div><div class="wd-stat"><strong>${data.sets}</strong><small>подходов</small></div><div class="wd-stat"><strong>${number(data.volume)}</strong><small>кг объём</small></div></div>${data.exercises.map(entry=>{
      const {ex,index,groups,previous,next}=entry,ssId=ex.supersetId,ssPrev=ssId&&data.exercises[index-1]?.ex.supersetId===ssId,ssNext=ssId&&data.exercises[index+1]?.ex.supersetId===ssId;
      const ss=ssId?` wd-ss${ssPrev?'':' wd-ss-first'}${ssNext?'':' wd-ss-last'}`:'';
      const metrics=new Set(entry.rows.map(row=>row.metric)),metric=metrics.size>1?'Повт. / время':metrics.has('time')?'Время':'Повт.';
      const nav=(target,dir)=>target?`<button type="button" class="wd-ex-nav-btn" data-ex-id="${esc(ex.exerciseId)}" data-nav="${dir}" aria-label="${dir==='prev'?'Прошлое':'Следующее'} выполнение — ${esc(fmtDate(target.startedAt))}">${dir==='prev'?icon('prev'):''}<span>${esc(new Date(target.startedAt).toLocaleDateString('ru-RU',{day:'numeric',month:'short'}))}</span>${dir==='next'?icon('next'):''}</button>`:`<button type="button" class="wd-ex-nav-btn" disabled aria-label="${dir==='prev'?'Нет прошлого':'Нет следующего'} выполнения">${dir==='prev'?icon('prev'):''}<span>—</span>${dir==='next'?icon('next'):''}</button>`;
      let main=0;
      return `<section class="wd-ex${ss}" data-ex-id="${esc(ex.exerciseId)}" aria-label="${esc(entry.name)}"><div class="wd-ex-head"><h3 class="wd-ex-name${entry.orphan?' orphan':''}">${esc(entry.name)}</h3>${entry.volume>0?(entry.volumePr?`<button type="button" class="wd-ex-meta pr" data-history-record="volume" data-ex-index="${index}" aria-label="Рекорд объёма ${number(entry.volume)} кг">${icon('volume')}${number(entry.volume)} кг</button>`:`<span class="wd-ex-meta">${number(entry.volume)} кг</span>`):''}</div>${(ex.executionValues || []).length?`<div class="wd-execution">${execution(ex)}</div>`:''}${groups.length?`<div class="wd-cols"><span>№</span><span>Кг</span><span>${metric}</span><span>RPE</span></div><div class="wd-sets">${groups.map((group,g)=>`<div class="wd-set-group">${rowHtml(group.main,group.orphan?'—':++main,index,g)}${group.drops.length?`<div class="wd-drop-tree">${group.drops.map(row=>rowHtml(row,0,index,g,true)).join('')}</div>`:''}</div>`).join('')}</div>`:`<div class="wd-empty">Нет выполненных подходов</div>`}${typeof ex.note==='string'&&ex.note.trim()?`<div class="wd-note">${icon('note')}<span>${esc(ex.note)}</span></div>`:''}${entry.orphan?`<button type="button" class="wd-ex-remap" data-remap-id="${esc(ex.exerciseId)}">${icon('remap')}Заменить упражнение</button>`:''}${previous||next?`<nav class="wd-ex-nav" aria-label="Соседние тренировки с упражнением">${nav(previous,'prev')}${nav(next,'next')}</nav>`:''}</section>`;
    }).join('')}<button type="button" class="wd-add-btn" id="save-as-template-btn">${icon('plus')}Добавить в шаблоны</button>`;
  }
  function wireRecords(body,data) {
    observer?.disconnect();
    if(root.ResizeObserver){
      observer ||= new root.ResizeObserver(()=>{layoutTrees(body);root.layoutHistorySpines?.();});
      observer.observe(body);body.querySelectorAll('.wd-ex').forEach(card=>observer.observe(card));
    }
    body.querySelectorAll('[data-history-record]').forEach(button=>button.addEventListener('click',()=>{
      const entry=data.exercises[Number(button.dataset.exIndex)],kind=button.dataset.historyRecord;
      const row=entry.groups[Number(button.dataset.groupIndex)]?.main;
      const title=kind==='volume'?'Рекорд объёма':kind==='time'?'Рекорд времени':'Рекорд веса';
      const value=kind==='volume'?number(entry.volume)+' кг':kind==='time'?C.formatTime(C.quantity(row.set)):number(row.set.weight)+' кг × '+number(C.quantity(row.set));
      const snapshot=kind==='volume'?entry.ex:row.execution;
      const details=(snapshot.executionValues || []).map(v=>v.name+': '+v.value).join(' · ');
      const dialog=document.createElement('dialog');dialog.className='wd-record-dialog';dialog.setAttribute('aria-labelledby','wd-record-title');
      dialog.innerHTML=`<h2 id="wd-record-title">${icon(kind==='volume'?'volume':'star')}${title}</h2><div class="wd-record-value">${esc(value)}</div><p>${esc(entry.name)}${details?'<br>'+esc(details):''}</p><p>${kind==='volume'?'Объём всех выполненных подходов упражнения, включая дроп-сеты.':'Установлен в этой тренировке.'}</p><button type="button" class="wd-record-close">Вернуться к подходам</button>`;
      document.getElementById('screen-detail').appendChild(dialog);
      const close=()=>dialog.close();dialog.querySelector('button').addEventListener('click',close);
      dialog.addEventListener('click',event=>{const r=dialog.getBoundingClientRect();if(event.target===dialog&&(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom))close();});
      dialog.addEventListener('close',()=>{dialog.remove();if(button.isConnected)button.focus({preventScroll:true});},{once:true});
      dialog.showModal();
    }));
  }
  let observer=null;
  function layoutTrees(body) {
    body.querySelectorAll('.wd-drop-tree').forEach(tree=>{
      const cell=[...tree.querySelectorAll('.wd-drop-weight')].at(-1);if(!cell)return;
      const treeRect=tree.getBoundingClientRect(),cellRect=cell.getBoundingClientRect();
      tree.style.setProperty('--wd-trunk-bottom',Math.max(0,treeRect.bottom-cellRect.top-cellRect.height/2)+'px');
    });
  }
  const api={model,render,wireRecords,layoutTrees};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.WorkoutHistoryUI=api;
})(typeof window!=='undefined'?window:globalThis);
