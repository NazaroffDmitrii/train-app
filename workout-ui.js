/* Presentation for the approved active workout. DATA/Bridge remain the write boundary. */
(() => {
  'use strict';
  const C = window.WorkoutCore;
  const paths = {
    check:'<path d="m5 12 4 4L19 6"/>', plus:'<path d="M12 5v14M5 12h14"/>',
    drop:'<path d="M4 6h16M4 12h11M4 18h6"/>', hash:'<path d="M10 3 8 21M16 3l-2 18M4 8h17M3 16h17"/>',
    timer:'<circle cx="12" cy="13" r="8"/><path d="M10 2h4M12 9v4l2 2M17 5l2-2"/>',
    radar:'<circle cx="12" cy="12" r="3"/><path d="M21 12a9 9 0 1 1-9-9M18 12a6 6 0 1 1-6-6M12 12l9-9"/>',
    down:'<path d="m6 9 6 6 6-6"/>', up:'<path d="m6 15 6-6 6 6"/>', arrow:'<path d="M19 12H5m7-7-7 7 7 7"/>',
    star:'<path d="m12 3 2.8 5.7 6.3.9-4.6 4.4 1.1 6.3-5.6-3-5.6 3 1.1-6.3L3 9.6l6.3-.9Z"/>',
    trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>'
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.check}</svg>`;
  const $ = id => document.getElementById(id);
  const current = () => typeof _workout === 'undefined' ? null : _workout;
  const history = () => DATA.getWorkoutHistory(DATA.getCurrentUser());
  const cursors = new WeakMap();
  const owners = new WeakMap();
  let wired = false, observer = null, drawing = false;
  const observedBlocks=new Set();
  function view() {
    const workout = current();
    return workout ? (workout._workoutView ||= {enabled:true,expanded:false,list:false,selected:null}) : null;
  }
  function initialize(workout, editing) {
    const user = DATA.getCurrentUser(), definitions = DATA.getVisibleExercises(user);
    owners.set(workout,{user,account:typeof Auth==='undefined'?null:Auth.userId()});
    for (const ex of workout.exercises || []) {
      const definition = definitions.find(d => d.id === ex.exerciseId);
      if(!ex.name && definition)ex.name=definition.name;
      if (!Array.isArray(ex.executionParameters)) Object.assign(ex,executionSnapshot(definition?.atlas?.executionParameters,ex.executionValues));
      C.prepare(ex,DATA.getExerciseMetric(user,ex.exerciseId));
      if (!ex.movements && definition) ex.movements=[...(definition.atlas?.categories || [])];
    }
    $('screen-workout').classList.toggle('aw-history-editor',!!editing);
    if (!wired) {
      wired=true;
      $('workout-movements-btn').addEventListener('click',()=>{const v=view();if (!v)return;v.enabled=!v.enabled;renderCoverage();saveWorkoutState();});
      $('workout-coverage-toggle').addEventListener('click',()=>{const v=view();if (!v)return;v.expanded=!v.expanded;renderCoverage();saveWorkoutState();});
      $('workout-coverage-pin').addEventListener('click',()=>{const v=view();if (!v)return;if(!v.expanded){v.expanded=true;renderCoverage();saveWorkoutState();}const scroll=$('workout-scroll'),box=$('workout-coverage');scroll.scrollTo({top:scroll.scrollTop+box.getBoundingClientRect().top-scroll.getBoundingClientRect().top-10,behavior:reducedMotion()?'instant':'smooth'});});
      $('workout-coverage-body').addEventListener('click',event=>{
        const button=event.target.closest('[data-aw]'),v=view();if(!button||!v)return;
        if(button.dataset.aw==='list')v.list=!v.list;
        else if(button.dataset.aw==='movement')v.selected=v.selected===button.dataset.movement?null:button.dataset.movement;
        else if(button.dataset.aw==='add'){
          const movement=button.dataset.movement;
          openExercisePicker(addExerciseToWorkout,null,{canSelect:id=>DATA.getVisibleExercises(DATA.getCurrentUser()).find(ex=>ex.id===id)?.atlas?.categories?.includes(movement)});
          return;
        }else if(button.dataset.aw==='jump'){
          const ex=current()?.exercises[Number(button.dataset.index)],block=[...$('workout-scroll').querySelectorAll('.ex-block')].find(b=>b._workoutExercise===ex);
          const scroll=$('workout-scroll');if(block)scroll.scrollTo({top:scroll.scrollTop+block.getBoundingClientRect().top-scroll.getBoundingClientRect().top-76,behavior:reducedMotion()?'instant':'smooth'});return;
        }
        const movement=button.dataset.movement;renderCoverage();saveWorkoutState();
        if(movement){const buttons=[...$('workout-coverage-body').querySelectorAll('[data-aw="movement"]')];buttons.find(b=>b.dataset.movement===movement&&b.getClientRects().length)?.focus({preventScroll:true});}
      });
      $('workout-coverage-body').addEventListener('keydown',event=>{if(event.target.matches('g[data-aw]')&&['Enter',' '].includes(event.key)){event.preventDefault();event.target.dispatchEvent(new MouseEvent('click',{bubbles:true}));}});
      $('workout-scroll').addEventListener('scroll',updatePin,{passive:true});
      observer=new ResizeObserver(()=>{positionTimer();updatePin();layoutAllDrops();if(!drawing&&view()?.expanded)drawRadar();});
      observer.observe($('screen-workout'));observer.observe($('workout-coverage'));observer.observe($('workout-coverage-preview'));
      window.addEventListener('resize',()=>{positionTimer();updatePin();layoutAllDrops();drawRadar();});
    }
    renderCoverage();
  }
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function ownsCurrent(workout=current()) {
    const owner=workout && owners.get(workout);
    return !owner || DATA.getCurrentUser()===owner.user && (typeof Auth==='undefined' || Auth.userId()===owner.account && !Auth.contextChanged?.());
  }
  function movements() {return DATA.refMovements(DATA.getCurrentUser()).filter(m=>m.type==='База');}
  function coverageModel() {
    const rows=movements(),definitions=DATA.getVisibleExercises(DATA.getCurrentUser());
    return {rows,definitions,counts:C.movementCounts(current()?.exercises,definitions,rows.map(m=>m.name))};
  }
  function movementHtml(row,index,count,definitions,expanded) {
    const related=(current()?.exercises || []).map((ex,i)=>({ex,i})).filter(({ex})=>(definitions.find(d=>d.id===ex.exerciseId)?.atlas?.categories||ex.movements||[]).includes(row.name));
    return `<div class="aw-movement-item${expanded?' is-selected':''}"><button type="button" class="aw-movement-row${count?' complete':''}" data-aw="movement" data-movement="${escHtml(row.name)}" aria-expanded="${expanded}"><span>${index+1}</span><span>${escHtml(row.name)}</span><span>${count?count+' ✓':'—'}</span></button>${expanded?`<div class="aw-movement-choice"><small>${count?count+' основных подходов выполнено':'Ещё не выполнено'}</small>${related.map(({ex,i})=>`<button type="button" class="aw-movement-exercise" data-aw="jump" data-index="${i}">${escHtml(definitions.find(d=>d.id===ex.exerciseId)?.name||ex.name||'Упражнение')} ${icon('down')}</button>`).join('')}<button type="button" class="aw-choose-exercise" data-aw="add" data-movement="${escHtml(row.name)}">${icon('plus')}Выбрать упражнение</button></div>`:''}</div>`;
  }
  function renderCoverage() {
    if (!$('workout-coverage')||!current())return;
    const v=view(),{rows,counts,definitions}=coverageModel(),covered=counts.filter(n=>n>0).length;
    $('workout-coverage').hidden=!v.enabled;
    $('workout-coverage-count').textContent=`Выполнено ${covered} из ${rows.length} движений`;
    $('workout-pin-count').textContent=$('workout-coverage-count').textContent;
    $('workout-movements-btn').setAttribute('aria-pressed',v.enabled);
    $('workout-movements-btn').setAttribute('aria-label',v.enabled?'Скрыть самопроверку движений':'Показать самопроверку движений');
    $('workout-coverage-toggle').setAttribute('aria-expanded',v.expanded);
    $('workout-coverage-chevron').innerHTML=icon(v.expanded?'up':'down');
    const body=$('workout-coverage-body');body.hidden=!v.expanded;
    if(v.expanded){
      const selected=rows.findIndex(r=>r.name===v.selected);
      const listButton=`<button type="button" class="aw-list-toggle" data-aw="list" aria-expanded="${v.list}">${v.list?'Скрыть список':'Показать списком'}${icon(v.list?'up':'down')}</button>`;
      body.innerHTML=`<div class="aw-radar" id="workout-radar"></div><div class="aw-radar-legend"><span>Выполненные основные подходы</span><span>0–${Math.max(1,...counts)} подх.</span></div>${!v.list&&selected>=0?movementHtml(rows[selected],selected,counts[selected],definitions,true):''}${listButton}${v.list?`<div class="aw-movement-list">${rows.map((row,i)=>movementHtml(row,i,counts[i],definitions,i===selected)).join('')}</div>${listButton}`:''}`;
      drawRadar();
    }else body.innerHTML='';
    requestAnimationFrame(updatePin);
  }
  function drawRadar() {
    const node=$('workout-radar');if(!node||!view()?.expanded||!view()?.enabled)return;
    const {rows,counts}=coverageModel(),width=node.clientWidth;if(!width||!rows.length)return;
    const center=width/2,radius=Math.max(38,center-38),max=Math.max(1,...counts);
    const point=(i,r)=>{const a=i*2*Math.PI/rows.length-Math.PI/2;return [center+Math.cos(a)*r,center+Math.sin(a)*r];};
    drawing=true;
    node.innerHTML=`<svg viewBox="0 0 ${width} ${width}" class="aw-radar-svg" role="group" aria-label="Выполненные подходы по базовым движениям"><title>Базовые движения</title>${[.33,.66,1].map(f=>`<polygon class="aw-radar-grid" points="${rows.map((_,i)=>point(i,radius*f).join(',')).join(' ')}"/>`).join('')}${rows.map((_,i)=>`<path class="aw-radar-grid" d="M${center},${center}L${point(i,radius).join(',')}"/>`).join('')}<polygon class="aw-radar-area" points="${counts.map((n,i)=>point(i,n/max*radius).join(',')).join(' ')}"/>${rows.map((row,i)=>{const [x,y]=point(i,radius+22),[dx,dy]=point(i,counts[i]/max*radius),selected=view().selected===row.name;return `${counts[i]?`<circle class="aw-radar-dot" cx="${dx}" cy="${dy}" r="3.5"/>`:''}<g data-aw="movement" data-movement="${escHtml(row.name)}" role="button" tabindex="0" aria-pressed="${selected}" aria-label="${escHtml(row.name)}: ${counts[i]} выполненных подходов"><circle class="aw-radar-index${selected?' selected':''}" cx="${x}" cy="${y}" r="13"/><text x="${x}" y="${y+4}" text-anchor="middle">${i+1}</text><circle class="aw-radar-hit" cx="${x}" cy="${y}" r="20"/></g>`;}).join('')}</svg>`;
    drawing=false;
  }
  function updatePin() {
    const root=$('screen-workout'),pin=$('workout-coverage-pin'),box=$('workout-coverage'),scroll=$('workout-scroll');
    if(!root||!pin||!box||!current())return;
    root.style.setProperty('--aw-header-height',root.querySelector('.workout-header').getBoundingClientRect().height+'px');
    pin.hidden=!view()?.enabled;
    const r=box.getBoundingClientRect(),top=scroll.getBoundingClientRect().top,height=pin.firstElementChild.getBoundingClientRect().height;
    const stuck=!!view()?.enabled&&root.classList.contains('active')&&r.top<top&&r.bottom-top<=height+1;
    pin.classList.toggle('is-pinned',stuck);pin.inert=!stuck;pin.setAttribute('aria-hidden',!stuck);
  }
  function positionTimer() {
    const root=$('screen-workout'),scroll=$('workout-scroll'),timer=$('rest-timer');
    if(!root?.classList.contains('active')||!scroll||!timer)return;
    const target=$('ex-edit-done')||((timer.classList.contains('collapsed'))?$('rest-open'):$('rest-pill'));
    if(!target||timer.hidden&&!$('ex-edit-done')){scroll.style.setProperty('--rest-reserve','20px');return;}
    const r=target.getBoundingClientRect(),bottom=root.getBoundingClientRect().bottom,gap=Math.max(0,bottom-r.bottom);
    scroll.style.setProperty('--rest-reserve',Math.max(0,scroll.getBoundingClientRect().bottom-r.top+gap)+'px');
  }
  function currentRecord(ex) {return C.record(history(),ex);}
  function recordHtml(ex) {
    const rec=currentRecord(ex);
    return `<button type="button" class="ex-pr-chip" ${rec?'':'hidden'} aria-label="${rec?'Рекорд '+(rec.metric==='time'?C.formatTime(rec.value):rec.weight+' кг на '+rec.value)+'. Открыть тренировку':'Рекорд упражнения'}">${icon('star')}${rec?rec.metric==='time'?C.formatTime(rec.value):rec.weight+' кг':''}</button>`;
  }
  function refreshRecord(block,ex) {
    const badge=block.querySelector('.ex-pr-chip'),rec=currentRecord(ex);if(!badge)return;
    badge.hidden=!rec;if(rec){badge.innerHTML=icon('star')+(rec.metric==='time'?C.formatTime(rec.value):rec.weight+' кг');badge.setAttribute('aria-label',`Рекорд ${rec.metric==='time'?C.formatTime(rec.value):rec.weight+' кг на '+rec.value}. Открыть тренировку`);}
  }
  function decorateRpeButton(button,set) {
    if(!button)return;button.classList.remove('effort-normal','effort-medium','effort-heavy');
    if(set.done&&set.rpe)button.classList.add(set.rpe<=6?'effort-normal':set.rpe<=8?'effort-medium':'effort-heavy');
  }
  function rememberCursor(input,ex,set) {
    if(!input||!['quantity','minutes','seconds'].includes(input.dataset.role))return;
    if(!cursors.has(set))cursors.set(set,new Map());
    cursors.get(set).set(input.dataset.metric,{role:input.dataset.role,start:input.selectionStart,end:input.selectionEnd,direction:input.selectionDirection||'none'});
  }
  function hideTools(block=$('workout-scroll')) {
    block?.querySelectorAll('[data-cell-tools]').forEach(b=>b.hidden=true);
    block?.querySelectorAll('[data-cell-normal]').forEach(b=>b.hidden=false);
  }
  function showTools(row,type,sourceSet) {
    hideTools();row.querySelectorAll('[data-cell-normal]').forEach(b=>b.hidden=true);
    row.querySelectorAll(`[data-cell-tools="${type}"]`).forEach(b=>{b.hidden=false;b._sourceSet=sourceSet;});
  }
  function changeMetric(ex,set,metric,block) {
    if(!ownsCurrent()){showToast('Профиль изменился. Перезагрузи страницу перед продолжением.');return;}
    const input=document.activeElement;rememberCursor(input,ex,set);
    if(ex.metric===metric)return;
    const saved=cursors.get(set)?.get(metric);
    C.chooseMetric(ex,metric);DATA.setExerciseMetric(DATA.getCurrentUser(),ex.exerciseId,metric);
    renderSets(block,ex);refreshRecord(block,ex);saveWorkoutState();
    const row=[...block.querySelectorAll('.set-row')].find(r=>r._set===set),display=row?.querySelector('[data-role="quantity"]');
    display?.focus({preventScroll:true});
    const field=metric==='time'?row?.querySelector(`[data-role="${saved?.role==='minutes'?'minutes':'seconds'}"]`):display;
    if(field){field.focus({preventScroll:true});field.setSelectionRange(Math.min(saved?.start??field.value.length,field.value.length),Math.min(saved?.end??field.value.length,field.value.length),saved?.direction||'none');}
  }
  function quantityHtml(ex,set,old,label) {
    if(set.done&&C.mode(set)!==ex.metric)return `<div class="set-field aw-saved-value"><input readonly value="${escHtml(C.mode(set)==='time'?C.formatTime(set.durationSec):set.reps+' повт.')}" aria-label="${escHtml(label)}, сохранённый результат"></div>`;
    const draft=C.draft(set),metric=ex.metric,ghost=old&&C.mode(old)===metric?C.quantity(old):null;
    if(metric==='reps')return `<div class="set-field set-measurement"><input type="text" inputmode="numeric" pattern="[0-9]+" data-role="quantity" data-metric="reps" value="${draft.reps??''}" placeholder="${ghost??'повт.'}" aria-label="${escHtml(label)}, повторения"></div>`;
    const seconds=draft.durationSec;
    return `<div class="set-field set-measurement aw-time-cell"><input class="aw-time-display" type="text" inputmode="numeric" data-role="quantity" data-metric="time" value="${C.formatTime(seconds)}" placeholder="${ghost==null?'м:с':C.formatTime(ghost)}" aria-label="${escHtml(label)}, время"><div class="aw-time-editor"><label><input type="text" inputmode="numeric" pattern="[0-9]*" data-role="minutes" data-metric="time" value="${seconds==null?'':Math.floor(seconds/60)}" placeholder="${ghost==null?'0':Math.floor(ghost/60)}" aria-label="${escHtml(label)}, минуты"><span>мин</span></label><b aria-hidden="true">:</b><label><input type="text" inputmode="numeric" pattern="[0-9]*" data-role="seconds" data-metric="time" value="${seconds==null?'':seconds%60}" placeholder="${ghost==null?'00':String(ghost%60).padStart(2,'0')}" aria-label="${escHtml(label)}, секунды"><span>сек</span></label></div></div>`;
  }
  function renderSets(block,ex) {
    const body=block.querySelector('.sets-body');if(!body)return;
    block.querySelector('.set-measurement-label').textContent=ex.metric==='time'?'Время':'Повт.';
    const old=C.previous(history(),ex),oldGroups=old?.groups||[],groups=C.groups(ex);
    body.innerHTML='';
    groups.forEach((group,mainIndex)=>{
      const container=document.createElement('div');container.className='set-group';body.appendChild(container);
      const mainRow=makeRow(group.main,false,oldGroups[mainIndex]?.main,mainIndex,group.main,container);
      group.drops.forEach((set,dropIndex)=>makeRow(set,true,oldGroups[mainIndex]?.drops[dropIndex],mainIndex,group.main,container,dropIndex,mainRow));
      layoutDropTree(container);
    });
    function makeRow(set,drop,previous,mainIndex,main,container,dropIndex=0,parentRow=null) {
      const draft=C.draft(set),rpe=C.effort(set.rpe),previousRpe=C.effort(previous?.rpe),label=`${ex.name||'Упражнение'}, подход ${mainIndex+1}${drop?', дроп-сет '+(dropIndex+1):''}`;
      const wrap=document.createElement('div');wrap.className='set-row-wrap'+(drop?' set-row-wrap-drop':'');
      wrap.dataset.setIndex=ex.sets.indexOf(set);wrap.dataset.mainIndex=mainIndex;
      const row=document.createElement('div');row.className='set-row'+(set.done?' aw-done-row':'');row._set=set;
      const weight=`<div class="set-field set-field-weight${(draft.weight??previous?.weight)<0?' negative':''}"><input type="text" inputmode="decimal" pattern="-?(?:[0-9]+(?:[.,][0-9]+)?|[.,][0-9]+)" data-role="weight" data-metric="${ex.metric}" value="${escHtml(draft.weight??'')}" placeholder="${escHtml(previous?.weight??'кг')}" aria-label="${escHtml(label)}, вес в кг"></div>`;
      row.innerHTML=drop?`<div class="set-drop-fields">${weight}${quantityHtml(ex,set,previous,label)}</div>`:`<span class="set-num">${mainIndex+1}</span>${weight}${quantityHtml(ex,set,previous,label)}<button type="button" class="rpe-btn${set.rpe?' has-rpe':''}" data-cell-normal aria-label="Усилие подхода ${mainIndex+1}">${rpe||`<span class="rpe-ghost">${previousRpe||'—'}</span>`}</button><button type="button" class="set-done-btn${set.done?' done':''}" data-cell-normal aria-pressed="${set.done}" aria-label="${set.done?'Снять выполнение':'Выполнить'} подход ${mainIndex+1}">${icon('check')}</button><button type="button" class="aw-cell-tool aw-sign" data-cell-tools="weight" aria-label="Изменить знак веса" hidden>±</button><button type="button" class="aw-cell-tool aw-drop" data-cell-tools="weight" aria-label="Добавить дроп-сет к подходу ${mainIndex+1}" hidden>${icon('drop')}</button><button type="button" class="aw-cell-tool aw-reps" data-cell-tools="quantity" aria-pressed="${ex.metric==='reps'}" aria-label="Считать повторения" hidden>${icon('hash')}</button><button type="button" class="aw-cell-tool aw-duration" data-cell-tools="quantity" aria-pressed="${ex.metric==='time'}" aria-label="Считать время" hidden>${icon('timer')}</button>`;
      wrap.innerHTML=`<div class="set-row-delete" aria-hidden="true">${icon('trash')}<span>Удалить</span></div>`;wrap.appendChild(row);container.appendChild(wrap);
      const toolsRow=parentRow||row;
      row.querySelectorAll('input[data-role]').forEach(input=>{
        input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();input.blur();}});
        input.addEventListener('focus',()=>{
          showTools(toolsRow,input.dataset.role==='weight'?'weight':'quantity',set);
          if(input.matches('.aw-time-display')){const field=row.querySelector(`[data-role="${draft.durationSec>=60?'minutes':'seconds'}"]`);field?.focus({preventScroll:true});field?.setSelectionRange(field.value.length,field.value.length);}
        });
        input.addEventListener('blur',()=>{
          rememberCursor(input,ex,set);
          requestAnimationFrame(()=>{
            if(!row.contains(document.activeElement)){
              const display=row.querySelector('.aw-time-display'),m=row.querySelector('[data-role="minutes"]'),s=row.querySelector('[data-role="seconds"]');
              if(display&&m.validity.valid&&s.validity.valid){display.value=C.formatTime(draft.durationSec);m.value=draft.durationSec==null?'':Math.floor(draft.durationSec/60);s.value=draft.durationSec==null?'':draft.durationSec%60;}
            }
            if(!block.contains(document.activeElement)||!document.activeElement.matches('input[data-role]'))hideTools(block);
          });
        });
        input.addEventListener('input',()=>{
          const role=input.dataset.role;
          if(role==='minutes'||role==='seconds'){
            const m=row.querySelector('[data-role="minutes"]'),s=row.querySelector('[data-role="seconds"]');
            [m,s].forEach(field=>field.setCustomValidity(field.value!==''&&(!Number.isSafeInteger(C.numeric(field.value))||C.numeric(field.value)<0)?'Введи целое число от нуля':''));
            if(!m.validity.valid||!s.validity.valid)return;
            const seconds=m.value===''&&s.value===''?null:Number(m.value||0)*60+Number(s.value||0);
            if(seconds!==null&&!Number.isSafeInteger(seconds)){input.setCustomValidity('Проверь время');return;}
            draft.durationSec=seconds;row.querySelector('.aw-time-display').value=C.formatTime(seconds);
          }else{
            const value=role==='weight'?C.numeric(input.value):ex.metric==='time'?C.parseTime(input.value):C.numeric(input.value);
            const bad=value!==null&&(!Number.isFinite(value)||role==='quantity'&&(!Number.isSafeInteger(value)||value<(ex.metric==='time'?0:1)));
            input.setCustomValidity(bad?'Проверь значение':'');if(bad)return;
            draft[role==='weight'?'weight':ex.metric==='time'?'durationSec':'reps']=value;
            row.querySelector('.set-field-weight')?.classList.toggle('negative',(draft.weight||0)<0);
          }
          // Editing a checked result makes the group pending; the next checkmark commits it.
          if(main.done){
            const priorMode=C.mode(main);C.uncheck(ex,main);
            const done=toolsRow.querySelector('.set-done-btn');done?.classList.remove('done');done?.setAttribute('aria-pressed','false');done?.setAttribute('aria-label',`Выполнить подход ${mainIndex+1}`);
            decorateRpeButton(toolsRow.querySelector('.rpe-btn'),main);updateSummaryBar();
            if(priorMode!==ex.metric){const start=input.selectionStart,end=input.selectionEnd,role=input.dataset.role;renderSets(block,ex);const replacement=[...block.querySelectorAll('.set-row')].find(r=>r._set===set)?.querySelector(`[data-role="${role}"]`);replacement?.focus({preventScroll:true});replacement?.setSelectionRange(start,end);}
          }
          saveWorkoutState();
        });
      });
      if(!drop){
        decorateRpeButton(row.querySelector('.rpe-btn'),set);
        row.querySelector('.rpe-btn').addEventListener('click',()=>{hideTools(block);openRpePicker(current().exercises.indexOf(ex),ex.sets.indexOf(set),row.querySelector('.rpe-btn'));});
        row.querySelector('.set-done-btn').addEventListener('click',()=>{
          if(!ownsCurrent()){showToast('Профиль изменился. Перезагрузи страницу перед продолжением.');return;}
          if(!current()?.exercises.includes(ex)||!ex.sets.includes(set))return;
          if(set.done)C.uncheck(ex,set);
          else{
            if([...container.querySelectorAll('input')].some(field=>!field.validity.valid)){showToast('Проверь значения подхода');return;}
            try{C.commit(ex,set,oldGroups[mainIndex]);}catch(error){showToast(error.message);return;}
            DATA.setExerciseMetric(DATA.getCurrentUser(),ex.exerciseId,ex.metric);if(!_editingHistory)startRest();
          }
          haptic();saveWorkoutState();renderSets(block,ex);updateSummaryBar();
        });
        row.querySelectorAll('[data-cell-tools]').forEach(button=>button.addEventListener('pointerdown',event=>event.preventDefault()));
        row.querySelector('.aw-sign').addEventListener('click',()=>{
          const source=row.querySelector('.aw-sign')._sourceSet||set,targetRow=[...block.querySelectorAll('.set-row')].find(r=>r._set===source),field=targetRow?.querySelector('[data-role="weight"]');if(!field)return;
          const wasEmpty=field.value==='',raw=wasEmpty?field.placeholder==='кг'?'':field.placeholder:field.value,negative=raw.startsWith('-'),next=negative?raw.slice(1):'-'+raw,start=field.selectionStart??raw.length,end=field.selectionEnd??start,delta=negative?-1:1;
          field.value=next;field.focus({preventScroll:true});field.setSelectionRange(wasEmpty?next.length:Math.max(0,start+delta),wasEmpty?next.length:Math.max(0,end+delta));field.dispatchEvent(new Event('input',{bubbles:true}));
        });
        row.querySelector('.aw-drop').addEventListener('click',()=>{
          const focused=document.activeElement,source=row.querySelector('.aw-sign')._sourceSet||set;rememberCursor(focused,ex,source);
          if(set.done)C.uncheck(ex,set);C.addDrop(ex,set);saveWorkoutState();renderSets(block,ex);updateSummaryBar();
          const focusRow=[...block.querySelectorAll('.set-row')].find(r=>r._set===source);focusRow?.querySelector('[data-role="weight"]')?.focus({preventScroll:true});
        });
        row.querySelector('.aw-reps').addEventListener('click',()=>changeMetric(ex,row.querySelector('.aw-reps')._sourceSet||set,'reps',block));
        row.querySelector('.aw-duration').addEventListener('click',()=>changeMetric(ex,row.querySelector('.aw-duration')._sourceSet||set,'time',block));
      }
      wireSetRowSwipe(wrap,row,()=>{
        if(!current()?.exercises.includes(ex))return;const removed=C.remove(ex,set);if(!removed.length)return;
        saveWorkoutState();renderSets(block,ex);updateSummaryBar();showToast(drop?'Дроп-сет удалён':removed.length>1?'Подход и его дроп-сеты удалены':'Подход удалён');
      },drop?row.querySelector('.set-drop-fields'):row);
      return row;
    }
    for(const oldBlock of observedBlocks)if(!oldBlock.isConnected){observer?.unobserve(oldBlock);observedBlocks.delete(oldBlock);}
    observer?.observe(block);observedBlocks.add(block);
    requestAnimationFrame(()=>{body.querySelectorAll('.set-group').forEach(layoutDropTree);positionTimer();});
  }
  function layoutAllDrops() { $('workout-scroll')?.querySelectorAll('.set-group').forEach(layoutDropTree); }
  function layoutDropTree(group) {
    group.querySelectorAll('.set-drop-trunk,.set-drop-branch').forEach(el=>el.remove());
    const main=group.querySelector('.set-row-wrap:not(.set-row-wrap-drop)'),drops=[...group.querySelectorAll('.set-row-wrap-drop')];
    if(!main||!drops.length||!group.getBoundingClientRect().width)return;
    const rect=group.getBoundingClientRect(),number=main.querySelector('.set-num').getBoundingClientRect(),quantity=main.querySelector('.set-measurement,.aw-saved-value').getBoundingClientRect(),rowRect=main.querySelector('.set-row').getBoundingClientRect();
    const x=number.left+number.width/2-rect.left,start=quantity.left-rect.left,end=rowRect.right-rect.left,gap=parseFloat(getComputedStyle(main.querySelector('.set-row')).columnGap)||6,width=quantity.width,qtyWidth=Math.max(0,end-start-width-gap);
    drops.forEach(w=>{const fields=w.querySelector('.set-drop-fields');fields.style.marginLeft=start+'px';fields.style.width=(end-start)+'px';fields.querySelector('.set-field-weight').style.width=width+'px';fields.querySelector('.set-measurement,.aw-saved-value').style.width=qtyWidth+'px';const backdrop=w.querySelector('.set-row-delete');backdrop.style.left=start+'px';backdrop.style.right='auto';backdrop.style.width=(end-start)+'px';});
    const top=main.getBoundingClientRect().bottom-rect.top,last=drops.at(-1).getBoundingClientRect(),bottom=last.top+last.height/2-rect.top;
    const trunk=document.createElement('span');trunk.className='set-drop-trunk';trunk.style.cssText=`left:${x}px;top:${top}px;height:${Math.max(0,bottom-top)}px`;group.appendChild(trunk);
    drops.forEach(w=>{const r=w.getBoundingClientRect(),branch=document.createElement('span');branch.className='set-drop-branch';branch.style.cssText=`left:${x}px;top:${r.top+r.height/2-rect.top}px;width:${Math.max(0,start-x)}px`;group.appendChild(branch);});
  }
  function wireRpeSheet() {
    const sheet=$('rpe-backdrop')?.querySelector('.bottom-sheet'),handle=sheet?.querySelector('.bottom-sheet-handle');
    if(!handle||handle.dataset.awWired)return;handle.dataset.awWired='true';
    const surface=handle.parentElement;let start=null,dy=0;
    surface.addEventListener('pointerdown',event=>{if(!event.target.closest('.bottom-sheet-handle,.bottom-sheet-title'))return;start=event.clientY;dy=0;surface.style.transition='none';surface.setPointerCapture(event.pointerId);});
    surface.addEventListener('pointermove',event=>{if(start===null)return;dy=Math.max(0,event.clientY-start);surface.style.transform=`translateY(${dy}px)`;});
    const end=()=>{if(start===null)return;start=null;surface.style.transition='transform .2s ease';if(dy>50){closeRpePicker();surface.style.transform='';}else surface.style.transform='';};
    surface.addEventListener('pointerup',end);surface.addEventListener('pointercancel',end);
  }
  window.WorkoutUI={icon,initialize,ownsCurrent,renderCoverage,updatePin,positionTimer,currentRecord,recordHtml,refreshRecord,decorateRpeButton,renderSets,layoutDropTree,wireRpeSheet,hideTools};
})();
