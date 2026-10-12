/* Statistics reads completed history; it never changes workouts or cached records. */
(() => {
  'use strict';
  const DAY = 86400000;
  const num = v => (typeof v === 'number' || (typeof v === 'string' && v.trim())) && Number.isFinite(Number(v)) ? Number(v) : null;
  const positive = v => Math.max(0, num(v) || 0);
  const dayStart = ts => { const d = new Date(ts); d.setHours(0,0,0,0); return +d; };
  const shiftDay = (ts, days) => { const d = new Date(ts); d.setDate(d.getDate() + days); return +d; };
  const dayKey = ts => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
  const fmt = v => Number(v.toFixed(1)).toLocaleString('ru-RU');
  const date = ts => new Date(ts).toLocaleDateString('ru-RU', {day:'numeric', month:'short'}).replace('.', '');
  const fullDate = ts => new Date(ts).toLocaleDateString('ru-RU', {day:'numeric',month:'long',year:'numeric'});
  const time = sec => sec > 0 ? (sec < 3600 ? `${Math.round(sec / 60)} мин` : `${fmt(sec / 3600)} ч`) : '—';
  const pace = sec => sec > 0 ? `${Math.floor(Math.round(sec)/60)}:${String(Math.round(sec)%60).padStart(2,'0')}` : '—';
  function paceSeconds(value) {
    const m = /^(\d+):([0-5]\d)$/.exec(String(value || ''));
    return m && Number(m[1]) * 60 + Number(m[2]) > 0 ? Number(m[1]) * 60 + Number(m[2]) : null;
  }
  function duration(w) {
    // Recorded duration excludes pauses; old workouts may only have timestamps.
    const sec = num(w.durationSec);
    if (sec !== null && sec > 0) return sec;
    const start = num(w.startedAt), end = num(w.finishedAt);
    return start !== null && end !== null && end > start ? (end - start) / 1000 : 0;
  }
  function validHistory(history, now) {
    const ids = new Set();
    return (Array.isArray(history) ? history : []).filter(w => {
      if (!w || w.deleted || !['strength','run'].includes(w.type)) return false;
      const ts = num(w.startedAt);
      if (ts === null || ts <= 0 || ts > now || (w.id && ids.has(w.id))) return false;
      if (w.id) ids.add(w.id);
      return true;
    }).map(w => ({...w, startedAt:num(w.startedAt)})).sort((a,b) => a.startedAt-b.startedAt);
  }
  function periodRange(period, now) {
    const days = {week:7,month:30,'3month':90,year:365}[period];
    if (!days) return {from:0, to:now, previousFrom:0, days:null};
    const from = shiftDay(dayStart(now), 1-days);
    // Same local time in the preceding window gives equal elapsed exposure.
    return {from, to:now, previousFrom:shiftDay(from,-days), previousTo:shiftDay(now,-days), days};
  }
  function doneSets(ex) {
    return (Array.isArray(ex.sets) ? ex.sets : []).filter(s => s && s.done && positive(s.metric === "time" ? s.durationSec : s.reps)>0).map(s => ({...s, reps:s.metric === "time" ? 0 : positive(s.reps), weight:num(s.weight)}));
  }
  function summarize(workouts) {
    let seconds=0, timed=0, volume=0, sets=0, reps=0, distance=0, paceDistance=0, paceTime=0, bestPace=null, longest=0;
    const days = new Set();
    workouts.forEach(w => {
      days.add(dayKey(w.startedAt)); const sec = duration(w); seconds+=sec; if(sec>0)timed++;
      if(w.type==='run') {
        const km=positive(w.distance), ps=paceSeconds(w.pace); distance+=km; longest=Math.max(longest,km);
        if(ps && km>0) {paceDistance+=km; paceTime+=ps*km; bestPace=bestPace===null?ps:Math.min(bestPace,ps);}
      } else (Array.isArray(w.exercises)?w.exercises:[]).forEach(ex => doneSets(ex).forEach(s => {sets++;reps+=s.reps;volume+=Math.max(0,s.weight||0)*s.reps;}));
    });
    return {count:workouts.length,days:days.size,seconds,timed,avgSeconds:timed?seconds/timed:0,volume,sets,reps,distance,longest,avgPace:paceDistance?paceTime/paceDistance:null,bestPace};
  }
  function analyze(history, period='month', type='all', now=Date.now()) {
    const all = validHistory(history,now), range=periodRange(period,now);
    const scope=all.filter(w => type==='all'||w.type===type);
    const current=scope.filter(w=>w.startedAt>=range.from && w.startedAt<=range.to);
    const previous=range.days?scope.filter(w=>w.startedAt>=range.previousFrom && w.startedAt<=range.previousTo):[];
    const elapsedDays=range.days || (current.length?Math.max(1,Math.round((dayStart(now)-dayStart(current[0].startedAt))/DAY)+1):1);
    return {all,scope,current,previous,range,summary:summarize(current),prior:summarize(previous),perWeek:current.length/elapsedDays*7,elapsedDays,now};
  }
  function exerciseSeries(workouts, catalog=[]) {
    const names=new Map(catalog.map(ex=>[ex.id,ex])); const series=new Map();
    workouts.filter(w=>w.type==='strength').forEach(w=>{
      const session=new Map();
      (Array.isArray(w.exercises)?w.exercises:[]).forEach(ex=>{
        if(!ex.exerciseId)return;
        const done=doneSets(ex); if(!done.length)return;
        if(!session.has(ex.exerciseId))session.set(ex.exerciseId,{name:ex.name,sets:[]});
        session.get(ex.exerciseId).sets.push(...done);
      });
      session.forEach((ex,id)=>{
        if(!series.has(id))series.set(id,{id,name:names.get(id)?.name||ex.name||'Упражнение из истории',cat:names.get(id)?.cat||'Без группы',points:[]});
        const attempts=ex.sets.filter(s=>s.metric!=="time" && !s.dropSet && s.weight!==null);
        series.get(id).points.push({ts:w.startedAt,workoutId:w.id,weight:attempts.length?attempts.reduce((max,s)=>Math.max(max,s.weight),-Infinity):null,volume:ex.sets.reduce((sum,s)=>sum+Math.max(0,s.weight||0)*s.reps,0),sets:ex.sets.length,reps:ex.sets.reduce((sum,s)=>sum+s.reps,0)});
      });
    });
    return [...series.values()].map(ex=>({...ex,points:ex.points.sort((a,b)=>a.ts-b.ts)})).sort((a,b)=>b.points.length-a.points.length || a.name.localeCompare(b.name,'ru'));
  }
  // An explicit catalog choice stays selected even before its first workout.
  function selectedExercise(series,catalog,id,from) {
    if(id) {
      const recorded=series.find(ex=>ex.id===id);
      if(recorded)return recorded;
      const definition=catalog.find(ex=>ex.id===id);
      if(definition)return {...definition,points:[]};
    }
    return series.find(ex=>ex.points.some(p=>p.ts>=from))||series[0]||null;
  }
  function change(value, before) {
    if(before===null || before===undefined || !Number.isFinite(before) || before===0)return null;
    return Math.round((value-before)/Math.abs(before)*100);
  }
  function activityBins(m) {
    const start=m.range.from || (m.current[0]?dayStart(m.current[0].startedAt):shiftDay(dayStart(m.now),-29));
    const days=m.range.days || Math.max(1,Math.round((dayStart(m.now)-start)/DAY)+1);
    const group=days<=7?'day':days<=100?'week':days<=400?'month':days<=1096?'quarter':'year';
    let cursor=new Date(start); cursor.setHours(0,0,0,0);
    if(group==='week')cursor.setDate(cursor.getDate()-(cursor.getDay()+6)%7);
    if(['month','quarter','year'].includes(group))cursor.setDate(1);
    if(group==='quarter')cursor.setMonth(Math.floor(cursor.getMonth()/3)*3);
    const yearStep=Math.max(1,Math.ceil(days/365/12));
    if(group==='year')cursor.setMonth(0);
    const bins=[];
    while(+cursor<=m.now) {
      const from=Math.max(start,+cursor), next=new Date(cursor);
      if(group==='day'||group==='week')next.setDate(next.getDate()+(group==='day'?1:7));
      else if(group==='year')next.setFullYear(next.getFullYear()+yearStep);
      else next.setMonth(next.getMonth()+(group==='month'?1:3));
      bins.push({from,to:+next,count:0,seconds:0,strength:0,run:0,strengthSeconds:0,runSeconds:0});cursor=next;
    }
    m.current.forEach(w=>{const b=bins.find(b=>w.startedAt>=b.from && w.startedAt<b.to);if(b){b.count++;b.seconds+=duration(w);b[w.type]++;b[w.type+'Seconds']+=duration(w);}});
    return {bins,group};
  }
  const calendarDay=ts=>{const d=new Date(ts);d.setHours(0,0,0,0);return +d;};
  const calendarShift=(ts,n)=>{const d=new Date(ts);d.setDate(d.getDate()+n);return +d;};
  const calendarShort=ts=>new Date(ts).toLocaleDateString('ru-RU',{day:'numeric',month:'short'}).replace('.','');
  const calendarWeekdays=['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
  function calendarBins(model) {
    const span=model.range.days||model.elapsedDays||1,mode=span<=35?'days':span<=120?'weeks':'months';
    const from=model.range.from||calendarDay(model.current[0]?.startedAt||model.now),to=calendarShift(calendarDay(model.now),1);
    let cursor=new Date(from);cursor.setHours(0,0,0,0);
    if(mode==='weeks')cursor.setDate(cursor.getDate()-(cursor.getDay()+6)%7);
    if(mode==='months')cursor.setDate(1);
    const months=(new Date(to-1).getFullYear()-cursor.getFullYear())*12+new Date(to-1).getMonth()-cursor.getMonth()+1;
    const crossYear=new Date(from).getFullYear()!==new Date(to-1).getFullYear();
    const step=mode==='months'?Math.max(1,Math.ceil(months/60)):1,cells=[];
    while(+cursor<to) {
      const next=new Date(cursor);
      if(mode==='months')next.setMonth(next.getMonth()+step);else next.setDate(next.getDate()+(mode==='weeks'?7:1));
      const start=Math.max(from,+cursor),end=Math.min(to,+next);
      let label=mode==='days'?String(new Date(start).getDate()):mode==='weeks'?calendarShort(start):new Date(start).toLocaleDateString('ru-RU',{month:'short'}).replace('.','')+(crossYear?' '+String(new Date(start).getFullYear()).slice(-2):'');
      cells.push({from:start,to:end,label,workouts:[],strength:0,run:0,count:0});cursor=next;
    }
    const byDay=mode==='days'?new Map(cells.map(c=>[calendarDay(c.from),c])):null;
    model.current.forEach(w=>{
      const cell=byDay?byDay.get(calendarDay(w.startedAt)):cells.find(c=>w.startedAt>=c.from&&w.startedAt<c.to);
      if(cell){cell.workouts.push(w);cell.count++;cell[w.type]++;}
    });
    const strip=mode==='days'&&span===7;
    return {mode,span,from,to,step,cells,strip,offset:mode==='days'&&!strip?(new Date(from).getDay()+6)%7:0,weekdays:strip?cells.map(c=>calendarWeekdays[new Date(c.from).getDay()]):['Пн','Вт','Ср','Чт','Пт','Сб','Вс']};
  }
  const api={analyze,summarize,exerciseSeries,change,periodRange,duration,paceSeconds,activityBins,calendarBins,selectedExercise};
  if(typeof module!=='undefined' && module.exports)module.exports=api;
  if(typeof window==='undefined')return;
  const escape = value => String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const icons={activity:'<path d="M3 12h4l3-7 4 14 3-7h4"/>',clock:'<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',weight:'<path d="M6 8v8M3 10v4M18 8v8M21 10v4M6 12h12"/>',run:'<path d="m4 18 5-4 3 2 3 4M7 9l5-3 4 5h4M12 6l-2 7"/><circle cx="16" cy="3" r="1.5"/>',arrow:'<path d="m9 5 7 7-7 7"/>',calendar:'<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M8 3v4M16 3v4M4 10h16"/>'};
  const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]||icons.activity}</svg>`;
  let activityMode='count', selectedInterval=null, selectedActivity=null, viewKey='', calendarExpanded=false, animateCalendarDetail=false;
  let openFocusFilter=null, filterState=null;
  const plural=(n,forms)=>forms[n%100>=11&&n%100<=14?2:n%10===1?0:n%10>=2&&n%10<=4?1:2];
  const trainingWord=n=>plural(n,['тренировка','тренировки','тренировок']);
  const runWord=n=>plural(n,['пробежка','пробежки','пробежек']);
  const focusTypes=[['all','Все','Все тренировки'],['strength','Сил','Силовые'],['run','Бег','Бег']];
  const focusPeriods=[['week','7 д','Последние 7 дней'],['month','30 д','Последние 30 дней'],['3month','90 д','Последние 90 дней'],['year','Год','Последние 365 дней'],['all','∞','За всё время']];
  function updateFocusExpansion() {
    const screen=document.getElementById('screen-stats');
    const controls=screen.querySelector('.sf-controls');if(!controls)return;
    controls.querySelectorAll('[data-sf-trigger]').forEach(button=>button.setAttribute('aria-expanded',String(openFocusFilter===button.dataset.sfTrigger)));
    controls.querySelectorAll('[data-sf-menu]').forEach(menu=>{
      const isOpen=openFocusFilter===menu.dataset.sfMenu,shell=menu.closest('.sf-filter-shell');
      menu.dataset.open=String(isOpen);menu.setAttribute('aria-hidden',String(!isOpen));menu.inert=!isOpen;
      shell.dataset.open=String(isOpen);shell.style.height=`${isOpen?38+menu.scrollHeight:38}px`;
    });
  }
  function syncFocusFilters(state) {
    filterState=state;const screen=document.getElementById('screen-stats');
    const header=screen.querySelector('.exercises-header-top'),existing=header.querySelector('.sf-controls');
    const controls=existing||document.createElement('div');controls.className='sf-controls';
    const selectedType=focusTypes.find(([key])=>key===filterState.type),selectedPeriod=focusPeriods.find(([key])=>key===filterState.period);
    if(!existing){
      controls.innerHTML=`<div class="sf-filter-anchor"><div class="sf-filter-shell"><button class="sf-circle sf-circle--type" type="button" data-sf-trigger="type" aria-controls="sf-type-options"></button><div id="sf-type-options" class="sf-options sf-options--type" data-sf-menu="type" role="group" aria-label="Тип тренировок">${focusTypes.map(([key,short,label])=>`<button type="button" data-sf-type="${key}" aria-label="${label}" title="${label}">${short}</button>`).join('')}</div></div></div><div class="sf-filter-anchor"><div class="sf-filter-shell"><button class="sf-circle sf-circle--period" type="button" data-sf-trigger="period" aria-controls="sf-period-options"></button><div id="sf-period-options" class="sf-options sf-options--period" data-sf-menu="period" role="group" aria-label="Период статистики">${focusPeriods.map(([key,label,title])=>`<button type="button" data-sf-period="${key}" aria-label="${title}" title="${title}">${label}</button>`).join('')}</div></div></div>`;
      header.append(controls);
      controls.querySelectorAll('[data-sf-trigger]').forEach(button=>button.addEventListener('click',()=>{openFocusFilter=openFocusFilter===button.dataset.sfTrigger?null:button.dataset.sfTrigger;updateFocusExpansion();}));
      controls.querySelectorAll('[data-sf-type],[data-sf-period]').forEach(button=>button.addEventListener('click',()=>{
        const type=button.hasAttribute('data-sf-type'),key=type?button.dataset.sfType:button.dataset.sfPeriod;
        openFocusFilter=null;updateFocusExpansion();
        if(type)filterState.setType(key);else filterState.setPeriod(key);
        controls.querySelector(`[data-sf-trigger="${type?'type':'period'}"]`)?.focus({preventScroll:true});
      }));
    }
    const typeButton=controls.querySelector('[data-sf-trigger="type"]'),periodButton=controls.querySelector('[data-sf-trigger="period"]');
    typeButton.textContent=selectedType[1];periodButton.textContent=selectedPeriod[1];
    typeButton.setAttribute('aria-label',`Тип тренировок: ${selectedType[2]}`);periodButton.setAttribute('aria-label',`Период: ${selectedPeriod[2]}`);
    typeButton.title=selectedType[2];periodButton.title=selectedPeriod[2];
    controls.querySelectorAll('[data-sf-type]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.sfType===filterState.type)));
    controls.querySelectorAll('[data-sf-period]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.sfPeriod===filterState.period)));
    updateFocusExpansion();
  }
  document.addEventListener('pointerdown',event=>{
    if(openFocusFilter&&!document.querySelector('#screen-stats .sf-controls')?.contains(event.target)){openFocusFilter=null;updateFocusExpansion();}
  },true);
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&openFocusFilter){const key=openFocusFilter;openFocusFilter=null;updateFocusExpansion();document.querySelector(`#screen-stats [data-sf-trigger="${key}"]`)?.focus({preventScroll:true});event.preventDefault();}
  });
  function chartToggle(kind,mode) {
    const next={weight:'volume',volume:'weight',count:'time',time:'count'}[mode];
    const names={weight:'Рабочий вес',volume:'Тоннаж',count:'Количество тренировок',time:'Время тренировок'};
    const attr=kind==='graph'?'data-st-graph':'data-st-activity';
    return `<button type="button" class="sf-chart-switch" data-sf-chart="${kind}" data-mode="${mode}" ${attr}="${next}" aria-label="${names[mode]}. Переключить: ${names[next].toLowerCase()}" title="${names[mode]}. Переключить: ${names[next].toLowerCase()}">${kind==='graph'?`<span class="sf-mode-label">${mode==='weight'?'Вес':'Объём'}</span>`:icon(mode==='count'?'calendar':'clock').replace('<svg','<svg class="sf-icon-swap"')}</button>`;
  }
  function delta(value,before,model) {
    if(!model.range.days)return '<span class="st-delta">За всю историю</span>';
    if(!model.prior.count)return '<span class="st-delta">Нет данных для сравнения</span>';
    const pct=change(value,before);
    return `<span class="st-delta${pct>0?' st-delta-up':''}">${pct===null?'Без базы сравнения':`${pct>0?'+':''}${pct}% к прошлому периоду`}</span>`;
  }
  function metric(label,value,unit,sub,name) {
    return `<div class="st-metric"><div class="st-metric-label">${icon(name)}${label}</div><div class="st-metric-value">${value}<small>${unit}</small></div><div class="st-metric-sub">${sub}</div></div>`;
  }
  function panel(title,caption,body,extra='',cls='',attrs='') {
    return `<section class="st-panel ${cls}" ${attrs}><div class="st-panel-heading"><div><h2>${title}</h2><p>${caption}</p></div>${extra}</div>${body}</section>`;
  }
  function activityChart(m) {
    const {bins,group}=activityBins(m), values=bins.map(b=>activityMode==='time'?Math.round(b.seconds/60):b.count), max=Math.max(1,...values);
    const label=b=>`${date(b.from)} — ${date(Math.min(b.to-1,m.now))}`;
    const b=selectedActivity===null?null:bins[selectedActivity];
    return `<div class="st-bars" aria-label="Активность ${ {day:'по дням',week:'по неделям',month:'по месяцам',quarter:'по кварталам',year:'по годам'}[group]}">${bins.map((b,i)=>`<button class="st-bar-col${selectedActivity===i?' selected':''}" data-st-bin="${i}" aria-pressed="${selectedActivity===i}" aria-label="${escape(label(b))}: ${b.count} ${trainingWord(b.count)}, ${Math.round(b.seconds/60)} минут"><span class="st-bar-value">${values[i]||''}</span><span class="st-bar-track"><span class="st-bar${values[i]?'':' st-bar-zero'}" style="height:${values[i]?Math.max(5,values[i]/max*100):3}%"><i style="height:${activityMode==='time'?(b.seconds?b.runSeconds/b.seconds*100:0):(b.count?b.run/b.count*100:0)}%"></i></span></span></button>`).join('')}</div><div class="st-chart-axis"><span>${date(bins[0].from)}</span><span>${{day:'по дням',week:'по неделям',month:'по месяцам',quarter:'по кварталам',year:'по годам'}[group]}</span><span>${date(m.now)}</span></div><div class="st-bin-detail" aria-live="polite">${b?`<b>${label(b)}</b><span>${b.count} ${trainingWord(b.count)} · ${time(b.seconds)}</span>`:'<span>Нажми на столбец, чтобы увидеть итоги</span>'}</div>`;
  }
  const calendarDate=ts=>new Date(ts).toLocaleDateString('ru-RU',{day:'numeric',month:'short',year:'numeric'}).replace('.','');
  const shortDuration=seconds=>seconds>0?Math.round(seconds/60)+' мин':'—';
  const paceLabel=seconds=>seconds>0?`${Math.floor(Math.round(seconds)/60)}:${String(Math.round(seconds)%60).padStart(2,'0')}`:'—';
  function activityPanel(m) {
    const legend='<div class="st-legend sf-rhythm-legend"><span><i class="st-dot-strength"></i>Силовые</span><span><i class="st-dot-run"></i>Бег</span></div>';
    return panel('Ритм тренировок',activityMode==='count'?'Количество тренировок за выбранный период':'Время тренировок в минутах',activityChart(m).replace('<div class="st-bin-detail"',legend+'<div class="st-bin-detail"'),chartToggle('activity',activityMode),'st-activity-panel');
  }
  function bindActivity(panel,m) {
    if(!panel)return;
    function update(attribute,value) {
      const scroll=document.getElementById('stats-scroll'),top=scroll.scrollTop;
      const template=document.createElement('template');template.innerHTML=activityPanel(m);
      panel.replaceChildren(...template.content.firstElementChild.childNodes);
      bindActivity(panel,m);scroll.scrollTop=top;
      [...panel.querySelectorAll(`[${attribute}]`)].find(el=>el.getAttribute(attribute)===value)?.focus({preventScroll:true});
    }
    panel.querySelector('[data-st-activity]')?.addEventListener('click',btn=>{activityMode=btn.currentTarget.dataset.stActivity;update('data-sf-chart','activity');});
    panel.querySelectorAll('[data-st-bin]').forEach(btn=>btn.addEventListener('click',()=>{const index=Number(btn.dataset.stBin);selectedActivity=selectedActivity===index?null:index;update('data-st-bin',String(index));}));
  }
  function revealExercisePanel() {
    requestAnimationFrame(()=>{
      const screen=document.getElementById('screen-stats'),scroll=document.getElementById('stats-scroll'),target=scroll?.querySelector('.st-ex-panel');
      if(!screen?.classList.contains('active')||!target)return;
      const top=scroll.scrollTop+target.getBoundingClientRect().top-scroll.getBoundingClientRect().top;
      target.querySelector('#stats-ex-pick-btn')?.focus({preventScroll:true});
      scroll.scrollTo({top:Math.max(0,top),behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
    });
  }
  function calendarDetails(selected,entries,data,dateSpan) {
    if(!selected)return '';
    const sum=summarize(entries),strength=summarize(entries.filter(w=>w.type==='strength')),run=summarize(entries.filter(w=>w.type==='run'));
    const ratio=selected.count?selected.strength/selected.count*100:0;
    const title={days:'День в деталях',weeks:'Неделя в деталях',months:data.step===1?'Месяц в деталях':'Период в деталях'}[data.mode];
    const list=(calendarExpanded?entries:entries.slice(0,6)).map(w=>{
      const stats=summarize([w]),date=new Date(w.startedAt),running=w.type==='run';
      const metric=running?`${fmt(stats.distance)} км${stats.avgPace?' · '+paceLabel(stats.avgPace)+'/км':''}`:`${fmt(stats.volume/1000)} т · ${stats.sets} ${plural(stats.sets,['подход','подхода','подходов'])}`;
      return `<button type="button" class="sf-session-card" data-sf-session="${escape(w.id)}" data-type="${w.type}"><span class="sf-session-date"><b>${date.getDate()}</b><small>${escape(date.toLocaleDateString('ru-RU',{month:'short'}).replace('.',''))}</small></span><span class="sf-session-info"><small><i></i>${running?'Бег':'Силовая'}<span>${shortDuration(stats.seconds)}</span></small><b>${escape(w.name||'Тренировка')}</b><span>${metric}</span></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button>`;
    }).join('');
    return `<section class="sf-calendar-selection${animateCalendarDetail?' is-entering':''}"><header class="sf-detail-heading"><div><span>${escape(dateSpan(selected))}</span><h3>${title}</h3></div><button type="button" class="sf-detail-close" aria-label="Закрыть подробности календаря"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M7 17 17 7"/></svg></button></header>${selected.count?`<div class="sf-detail-totals"><div><strong>${sum.count}</strong><span>${plural(sum.count,['тренировка','тренировки','тренировок'])}</span></div><div><strong>${sum.seconds?Math.round(sum.seconds/60):'—'}<small>${sum.seconds?' мин':''}</small></strong><span>в движении</span></div><div><strong>${sum.days}</strong><span>${plural(sum.days,['активный день','активных дня','активных дней'])}</span></div></div><div class="sf-detail-ratio" role="img" aria-label="Силовые: ${selected.strength} (${fmt(ratio)}%). Бег: ${selected.run} (${fmt(100-ratio)}%)"><i style="width:${ratio}%"></i><i style="width:${100-ratio}%"></i></div><div class="sf-detail-types">${selected.strength?`<div><span><i class="st-dot-strength"></i>Силовые <b>${selected.strength}</b></span><strong>${fmt(strength.volume/1000)} <small>т тоннажа</small></strong></div>`:''}${selected.run?`<div><span><i class="st-dot-run"></i>Бег <b>${selected.run}</b></span><strong>${fmt(run.distance)} <small>км дистанции</small></strong></div>`:''}</div><div class="sf-detail-list-heading">Тренировки периода <span>Открой любую →</span></div><div class="sf-session-list">${list}</div>${entries.length>6?`<button type="button" class="sf-calendar-more" data-sf-more="list">${calendarExpanded?'Свернуть список':'Ещё '+(entries.length-6)+' '+plural(entries.length-6,['тренировка','тренировки','тренировок'])}</button>`:''}`:`<div class="sf-detail-empty"><strong>Пауза в расписании</strong><p>За этот ${data.mode==='days'?'день':'период'} тренировок не записано.</p></div>`}</section>`;
  }
  function calendar(m) {
    const data=calendarBins(m),max=Math.max(1,...data.cells.map(c=>c.count));
    const selected=data.cells.find(c=>String(c.from)===selectedInterval);
    const entries=selected?selected.workouts.slice().sort((a,b)=>b.startedAt-a.startedAt):[];
    const dateSpan=c=>`${calendarDate(c.from)}${data.mode==='days'?'':' — '+calendarDate(c.to-1)}`;
    const getColor=c=>c.strength&&c.run?`linear-gradient(90deg,var(--sf-cal-strength) ${c.strength/c.count*100}%,var(--sf-cal-run) ${c.strength/c.count*100}%)`:c.run?'var(--sf-cal-run)':'var(--sf-cal-strength)';
    const scale={days:'По дням',weeks:'По неделям',months:data.step===1?'По месяцам':`По ${data.step} мес`}[data.mode];
    const badge=`<span class="sf-calendar-scale">${{days:'Дни',weeks:'Недели',months:'Месяцы'}[data.mode]}</span>`;
    const cells=data.cells.map(c=>`<button type="button" class="sf-calendar-cell${c.count?' has-activity':''}${selectedInterval===String(c.from)?' selected':''}${c.to===data.to?' today':''}" data-sf-cell="${c.from}" aria-pressed="${selectedInterval===String(c.from)}" aria-label="${escape(dateSpan(c))}: ${c.count} ${trainingWord(c.count)}" style="--cell-color:${getColor(c)};--cell-opacity:${c.count ? .35+c.count/max*.42 : 0}">${data.mode==='days'?`<span>${c.label}</span>${c.count?'<i></i>':''}`:`<strong>${c.count}</strong><span>${escape(c.label)}</span>`}</button>`).join('');
    const body=`<div class="sf-calendar-body">${data.mode==='days'?`<div class="st-cal-weekdays">${data.weekdays.map(d=>`<span>${d}</span>`).join('')}</div>`:''}<div class="sf-calendar-grid sf-calendar-grid--${data.mode}">${'<span></span>'.repeat(data.offset)}${cells}</div><div class="st-legend"><span><i class="st-dot-strength"></i>Силовые</span><span><i class="st-dot-run"></i>Бег</span><span>Нажми на ${data.mode==='days'?'день':data.mode==='weeks'?'неделю':'месяц'}</span></div><div class="sf-calendar-detail" aria-live="polite">${calendarDetails(selected,entries,data,dateSpan)}</div></div>`;
    return panel('Календарь активности',`${scale} · ${calendarDate(data.from)} — ${calendarDate(data.to-1)}`,body,badge,'st-calendar-panel',`data-calendar-scale="${data.mode}"`);
  }
  function methodsPanel() {
    const items=[
      ['Период','7, 30, 90 или 365 дней, включая сегодня. «∞» — вся история.'],
      ['Сравнение','Предыдущий отрезок такой же длины, до того же времени суток.'],
      ['Регулярность','Тренировки ÷ дни периода × 7. За всё время отсчёт идёт от первой тренировки.'],
      ['Время','Записанная длительность. Если её нет — разница между окончанием и началом. Среднее — только по тренировкам с длительностью.'],
      ['Тоннаж','Положительный вес × повторы выполненных подходов. Дроп-сеты включены; помощь и собственный вес не добавляются.'],
      ['Средний темп','Темп каждой пробежки взвешивается по её дистанции. Нужны и дистанция, и темп.'],
      ['Прогресс','Рабочий вес — максимальный вес обычного выполненного подхода с повторами. Варианты упражнения объединены. Изменение: (последнее − первое) ÷ |первое| × 100%. Если первое равно нулю, процент не показывается.'],
      ['Распределение нагрузки','Каждый выполненный подход учитывается один раз — в основной группе упражнения.']
    ];
    return `<details class="st-method"><summary>Как считаются показатели</summary><dl class="sf-method-list">${items.map(([title,body])=>`<div><dt>${title}</dt><dd>${body}</dd></div>`).join('')}</dl></details>`;
  }
  function progressChart(points,mode) {
    const p=points.filter(p=>mode==='volume'||p.weight!==null);
    if(!p.length)return '<div class="st-chart-empty">Нет выполненных подходов за этот период.</div>';
    const vals=p.map(x=>mode==='volume'?x.volume:x.weight), low=Math.min(...vals), high=Math.max(...vals), padding=Math.max(1,(high-low)*.2), min=low-padding, max=high+padding;
    const x=i=>p.length===1?160:44+(i/(p.length-1))*254, y=v=>140-(v-min)/(max-min)*118;
    const line=p.map((v,i)=>`${x(i)},${y(vals[i])}`).join(' ');
    return `<svg class="st-progress-svg" viewBox="0 0 320 174" role="img" aria-label="${mode==='volume'?'Тоннаж':'Рабочий вес'}, кг: ${vals.map(fmt).join(', ')}"><defs><linearGradient id="st-chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b7a2ff" stop-opacity=".25"/><stop offset="1" stop-color="#b7a2ff" stop-opacity="0"/></linearGradient></defs>${[low,(low+high)/2,high].filter((v,i,a)=>a.indexOf(v)===i).map(v=>`<path d="M44 ${y(v)}H306" class="st-grid-line"/><text x="2" y="${y(v)+3}" class="st-svg-label">${fmt(v)}</text>`).join('')}<polygon points="${x(0)},146 ${line} ${x(p.length-1)},146" fill="url(#st-chart-fill)"/><polyline points="${line}" class="st-progress-line"/>${p.map((v,i)=>`<circle cx="${x(i)}" cy="${y(vals[i])}" r="${i===p.length-1?4:2.5}" class="st-progress-dot"><title>${date(v.ts)} · ${fmt(vals[i])} кг</title></circle>`).join('')}<text x="44" y="169" class="st-svg-label">${date(p[0].ts)}</text>${p.length>1?`<text x="306" y="169" text-anchor="end" class="st-svg-label">${date(p[p.length-1].ts)}</text>`:''}</svg>${p.length===1?'<p class="st-note">Первая точка. После следующей тренировки появится динамика.</p>':''}`;
  }
  function exercisePanel(series,catalog,m,state) {
    const ex=selectedExercise(series,catalog,state.exerciseId,m.range.from);
    if(ex)state.selectExercise(ex.id);
    const points=(ex?.points||[]).filter(p=>p.ts>=m.range.from), mode=state.graphMode, valid=points.filter(p=>mode==='volume'||p.weight!==null), val=p=>mode==='volume'?p.volume:p.weight;
    const first=valid[0],last=valid[valid.length-1], pct=valid.length>=2?change(val(last),val(first)):null;
    const title=`<button class="st-ex-select" id="stats-ex-pick-btn" aria-label="Выбрать упражнение">${escape(ex?.name||'Выбери упражнение')}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>`;
    const tabs=chartToggle('graph',mode);
    if(!valid.length) {
      const message=points.length?'Нет данных по весу за этот период':ex?.points.length?'Нет тренировок за этот период':'Пока нет данных';
      return panel('Прогресс упражнения','',`${title}<p class="st-ex-empty">${message}</p>`,tabs,'st-ex-panel st-progress-feature sf-progress-section is-empty');
    }
    return panel('Прогресс упражнения','По выполненным подходам за выбранный период',`${title}<div class="st-ex-summary"><div><strong>${last?fmt(val(last)):'—'}<small>${last?' кг':''}</small></strong><span>${mode==='volume'?'Объём последней тренировки':'Последний рабочий вес'}</span></div><span class="st-change ${pct>0?'positive':''}">${pct===null?'Нужны 2 точки':`${pct>0?'+':''}${pct}%`}</span></div>${progressChart(points,mode)}<div class="st-ex-foot"><span>${points.length} ${trainingWord(points.length)}</span><span>Лучший за период: ${valid.length?fmt(Math.max(...valid.map(val)))+' кг':'—'}</span></div><details class="st-data"><summary>Данные графика</summary>${points.map(p=>`<div><span>${date(p.ts)}</span><b>${val(p)===null?'—':fmt(val(p))+' кг'}</b></div>`).join('')}</details>`,tabs,'st-ex-panel st-progress-feature sf-progress-section');
  }
  function trendsPanel(series,m) {
    const trends=series.map(ex=>{
      const points=ex.points.filter(p=>p.ts>=m.range.from && p.weight!==null);
      if(points.length<2)return null;
      const first=points[0].weight,last=points[points.length-1].weight,pct=change(last,first);
      return pct===null?null:{id:ex.id,name:ex.name,first,last,pct,count:points.length};
    }).filter(Boolean).sort((a,b)=>b.pct-a.pct).slice(0,5);
    if(!trends.length)return '';
    return panel('Динамика упражнений','Рабочий вес: от первой к последней тренировке периода',`<div class="st-trends">${trends.map(ex=>`<button class="st-trend" data-st-exercise="${escape(ex.id)}"><span><b>${escape(ex.name)}</b><small>${fmt(ex.first)} → ${fmt(ex.last)} кг · ${ex.count} ${trainingWord(ex.count)}</small></span><span class="st-change ${ex.pct>0?'positive':''}">${ex.pct>0?'+':''}${ex.pct}%</span>${icon('arrow')}</button>`).join('')}</div>`,'','sf-trends-section');
  }
  function loadPanel(series,m) {
    const groups=new Map(); series.forEach(ex=>{const sets=ex.points.filter(p=>p.ts>=m.range.from).reduce((sum,p)=>sum+p.sets,0);if(sets)groups.set(ex.cat,(groups.get(ex.cat)||0)+sets);});
    const list=[...groups].sort((a,b)=>b[1]-a[1]), total=list.reduce((sum,p)=>sum+p[1],0);
    const top=list.slice(0,5); if(list.length>5)top.push(['Другие группы',list.slice(5).reduce((sum,p)=>sum+p[1],0)]);
    return panel('Распределение нагрузки','Выполненные подходы по основной группе упражнения',top.length?`<div class="st-load-list">${top.map(([name,count],i)=>`<div class="st-load-row"><div><span>${escape(name)}</span><b>${count} <small>· ${Math.round(count/total*100)}%</small></b></div><div class="st-load-track"><i style="width:${count/total*100}%;opacity:${1-i*.1}"></i></div></div>`).join('')}</div><p class="st-note">Каждый подход учитывается один раз. Это распределение записанных подходов, а не оценка восстановления мышц.</p>`:'<p class="st-note">Нет выполненных подходов в выбранном периоде.</p>');
  }
  function runPanel(m) {
    const s=summarize(m.current.filter(w=>w.type==='run'));
    return panel('Бег в цифрах','По пробежкам выбранного периода',`<div class="st-run-grid">${metric('Дистанция',fmt(s.distance),'км','За выбранный период','run')}${metric('Средний темп',pace(s.avgPace),'мин/км','Взвешен по дистанции','clock')}${metric('Самая длинная',s.longest?fmt(s.longest):'—','км','За выбранный период','run')}${metric('Лучший темп',pace(s.bestPace),'мин/км','За целую пробежку','activity')}</div><p class="st-note">Средний темп учитывает пробежки с указанными дистанцией и темпом.</p>`);
  }
  function render(state) {
    const user=DATA.getCurrentUser(), scroll=document.getElementById('stats-scroll');if(!user||!scroll)return;
    const key=`${user}|${state.type}|${state.period}`;
    const scrollTop=scroll.scrollTop;
    const activeControl=scroll.contains(document.activeElement)?document.activeElement:null;
    const focusAttribute=activeControl?[...activeControl.attributes].find(a=>['data-sf-chart','data-sf-cell','data-st-bin','data-sf-more'].includes(a.name)):null;
    const sameView=key===viewKey;
    const openDetails=[...scroll.querySelectorAll('details[open]')].map(el=>el.className);
    if(key!==viewKey){selectedInterval=null;selectedActivity=null;calendarExpanded=false;openFocusFilter=null;} viewKey=key;
    const m=analyze(DATA.getWorkoutHistory(user),state.period,state.type), s=m.summary;
    const catalog=DATA.getVisibleExercises(user), series=exerciseSeries(m.scope,catalog), runs=summarize(m.current.filter(w=>w.type==='run'));
    syncFocusFilters(state);
    const periodNames={week:'7 дней',month:'30 дней','3month':'90 дней',year:'365 дней',all:'всё время'};
    const headline={all:'Твой прогресс',strength:'Твои силовые',run:'Твой бег'}[state.type];
    const hero=`<section class="st-hero"><div class="st-eyebrow">${periodNames[state.period]} · ${state.type==='run'?'БЕГ':state.type==='strength'?'СИЛОВЫЕ':'ВСЕ ТРЕНИРОВКИ'}</div><h1>${headline}</h1><div class="st-focus-lead">${state.type==='run'?'Дистанция, темп и ритм тренировок':series.length?'От тренировки к тренировке — в цифрах':'Твоя активность за выбранный период'}</div><div class="st-focus-total"><strong>${s.count}</strong><span>${state.type==='run'?runWord(s.count):trainingWord(s.count)}</span>${delta(s.count,m.prior.count,m)}</div></section>`;
    const stats=`<div class="st-metrics">${metric('Время тренировок',time(s.seconds),'',s.timed?`${time(s.avgSeconds)} в среднем`:'Длительность пока не записана','clock')}${metric('Регулярность',fmt(m.perWeek),'в неделю',`${s.days} активных дней за период`,'activity')}${state.type==='run'?metric('Дистанция',fmt(s.distance),'км',delta(s.distance,m.prior.distance,m),'run'):metric('Тоннаж',fmt(s.volume/1000),'т',delta(s.volume,m.prior.volume,m),'weight')}${state.type==='run'?metric('Средний темп',pace(s.avgPace),'мин/км','С учётом дистанции пробежек','clock'):metric('Выполнено',s.sets,'подходов',`${fmt(s.reps)} повторов за период`,'weight')}</div>`;
    const charts=calendar(m)+activityPanel(m);
    const empty=!s.count?`<section class="st-empty"><span>${icon('activity')}</span><h2>${m.scope.length?'В этом периоде пока тихо':'Начни свою историю прогресса'}</h2><p>${m.scope.length?'Выбери другой период, чтобы увидеть предыдущие тренировки.':'Заверши тренировку — здесь появятся твой ритм, нагрузка и динамика результатов.'}</p>${m.scope.length?'<button id="st-show-all">Показать всё время</button>':''}</section>`:'';
    const extras=s.count?(state.type!=='run'?trendsPanel(series,m)+exercisePanel(series,catalog,m,state)+loadPanel(series,m):'')+(state.type==='run'||(state.type==='all'&&runs.count)?runPanel(m):''):'';
    const orphans=DATA.getOrphanExercises(user);
    const orphan=state.type!=='run'&&orphans.length?`<button class="st-orphan" id="s-orphan-btn"><span><b>Упражнения без связи с каталогом: ${orphans.length}</b><small>Привяжи их, чтобы объединить историю прогресса</small></span>${icon('arrow')}</button>`:'';
    scroll.innerHTML=`<div class="st-dashboard">${hero}${empty}${m.scope.length?stats+'<div class="st-main-grid">'+charts+extras+'</div>':''}${orphan}${methodsPanel()}</div>`;
    if(sameView)scroll.querySelectorAll('details').forEach(el=>{el.open=openDetails.includes(el.className);});
    scroll.scrollTop=sameView?scrollTop:0;
    if(sameView && focusAttribute)[...scroll.querySelectorAll(`[${focusAttribute.name}]`)].find(el=>el.getAttribute(focusAttribute.name)===focusAttribute.value)?.focus({preventScroll:true});
    bindActivity(scroll.querySelector('.st-activity-panel'),m);
    scroll.querySelectorAll('[data-st-graph]').forEach(btn=>btn.addEventListener('click',()=>state.setGraphMode(btn.dataset.stGraph)));
    scroll.querySelectorAll('[data-st-exercise]').forEach(btn=>btn.addEventListener('click',()=>{state.setExercise(btn.dataset.stExercise);revealExercisePanel();}));
    scroll.querySelectorAll('[data-sf-cell]').forEach(btn=>btn.addEventListener('click',()=>{selectedInterval=selectedInterval===btn.dataset.sfCell?null:btn.dataset.sfCell;calendarExpanded=false;animateCalendarDetail=!!selectedInterval;render(state);animateCalendarDetail=false;}));
    scroll.querySelectorAll('[data-sf-session]').forEach(btn=>btn.addEventListener('click',()=>{const w=m.current.find(w=>String(w.id)===btn.dataset.sfSession);if(w)openDetailScreen(w,'stats');}));
    scroll.querySelector('.sf-detail-close')?.addEventListener('click',()=>{const previous=selectedInterval;selectedInterval=null;calendarExpanded=false;render(state);scroll.querySelector(`[data-sf-cell="${previous}"]`)?.focus({preventScroll:true});});
    scroll.querySelector('.sf-calendar-more')?.addEventListener('click',()=>{calendarExpanded=!calendarExpanded;render(state);scroll.querySelector('.sf-calendar-more')?.focus({preventScroll:true});});
    document.getElementById('stats-ex-pick-btn')?.addEventListener('click',()=>openExercisePicker(id=>{state.setExercise(id);revealExercisePanel();},state.exerciseId));
    document.getElementById('s-orphan-btn')?.addEventListener('click',()=>openOrphanRemapSheet());
    document.getElementById('st-show-all')?.addEventListener('click',()=>state.setPeriod('all'));
  }
  window.TrainStats={...api,render};
})();
