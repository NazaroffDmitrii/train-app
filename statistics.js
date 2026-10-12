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
  const api={analyze,summarize,exerciseSeries,change,periodRange,duration,paceSeconds,activityBins};
  if(typeof module!=='undefined' && module.exports)module.exports=api;
  if(typeof window==='undefined')return;
  const escape = value => String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const icons={activity:'<path d="M3 12h4l3-7 4 14 3-7h4"/>',clock:'<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',weight:'<path d="M6 8v8M3 10v4M18 8v8M21 10v4M6 12h12"/>',run:'<path d="m4 18 5-4 3 2 3 4M7 9l5-3 4 5h4M12 6l-2 7"/><circle cx="16" cy="3" r="1.5"/>',arrow:'<path d="m9 5 7 7-7 7"/>',calendar:'<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M8 3v4M16 3v4M4 10h16"/>'};
  const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]||icons.activity}</svg>`;
  let activityMode='count', selectedDay=null, selectedActivity=null, viewKey='';
  const plural=(n,forms)=>forms[n%100>=11&&n%100<=14?2:n%10===1?0:n%10>=2&&n%10<=4?1:2];
  const trainingWord=n=>plural(n,['тренировка','тренировки','тренировок']);
  const runWord=n=>plural(n,['пробежка','пробежки','пробежек']);
  function delta(value,before,model) {
    if(!model.range.days)return '<span class="st-delta">За всю историю</span>';
    if(!model.prior.count)return '<span class="st-delta">Нет данных для сравнения</span>';
    const pct=change(value,before);
    return `<span class="st-delta${pct>0?' st-delta-up':''}">${pct===null?'Без базы сравнения':`${pct>0?'+':''}${pct}% к прошлому периоду`}</span>`;
  }
  function metric(label,value,unit,sub,name) {
    return `<div class="st-metric"><div class="st-metric-label">${icon(name)}${label}</div><div class="st-metric-value">${value}<small>${unit}</small></div><div class="st-metric-sub">${sub}</div></div>`;
  }
  function panel(title,caption,body,extra='',cls='') {
    return `<section class="st-panel ${cls}"><div class="st-panel-heading"><div><h2>${title}</h2><p>${caption}</p></div>${extra}</div>${body}</section>`;
  }
  function activityChart(m) {
    const {bins,group}=activityBins(m), values=bins.map(b=>activityMode==='time'?Math.round(b.seconds/60):b.count), max=Math.max(1,...values);
    const label=b=>`${date(b.from)} — ${date(Math.min(b.to-1,m.now))}`;
    const b=selectedActivity===null?null:bins[selectedActivity];
    return `<div class="st-bars" aria-label="Активность ${ {day:'по дням',week:'по неделям',month:'по месяцам',quarter:'по кварталам',year:'по годам'}[group]}">${bins.map((b,i)=>`<button class="st-bar-col${selectedActivity===i?' selected':''}" data-st-bin="${i}" aria-pressed="${selectedActivity===i}" aria-label="${escape(label(b))}: ${b.count} ${trainingWord(b.count)}, ${Math.round(b.seconds/60)} минут"><span class="st-bar-value">${values[i]||''}</span><span class="st-bar-track"><span class="st-bar${values[i]?'':' st-bar-zero'}" style="height:${values[i]?Math.max(5,values[i]/max*100):3}%"><i style="height:${activityMode==='time'?(b.seconds?b.runSeconds/b.seconds*100:0):(b.count?b.run/b.count*100:0)}%"></i></span></span></button>`).join('')}</div><div class="st-chart-axis"><span>${date(bins[0].from)}</span><span>${{day:'по дням',week:'по неделям',month:'по месяцам',quarter:'по кварталам',year:'по годам'}[group]}</span><span>${date(m.now)}</span></div><div class="st-bin-detail" aria-live="polite">${b?`<b>${label(b)}</b><span>${b.count} ${trainingWord(b.count)} · ${time(b.seconds)}</span>`:'<span>Нажми на столбец, чтобы увидеть итоги</span>'}</div>`;
  }
  function calendar(m) {
    const count=Math.min(m.range.days||56,56), first=shiftDay(dayStart(m.now),1-count), offset=(new Date(first).getDay()+6)%7;
    let cells='<span class="st-cal-blank"></span>'.repeat(offset);
    const byDay=new Map(); m.current.forEach(w=>{const key=dayKey(w.startedAt); if(!byDay.has(key))byDay.set(key,[]);byDay.get(key).push(w);});
    for(let i=0;i<count;i++) {
      const ts=shiftDay(first,i), list=byDay.get(dayKey(ts))||[], s=list.some(w=>w.type==='strength'), r=list.some(w=>w.type==='run');
      cells+=`<button type="button" class="st-cal-day${s&&r?' st-cal-both':s?' st-cal-strength':r?' st-cal-run':''}${dayKey(ts)===selectedDay?' selected':''}${i===count-1?' today':''}" data-st-day="${ts}" aria-pressed="${dayKey(ts)===selectedDay}" aria-label="${fullDate(ts)}: ${list.length} тренировок"><span>${new Date(ts).getDate()}</span>${list.length?'<i></i>':''}</button>`;
    }
    const selection=selectedDay?m.current.filter(w=>dayKey(w.startedAt)===selectedDay):[];
    return `<div class="st-cal-weekdays">${['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(d=>`<span>${d}</span>`).join('')}</div><div class="st-calendar">${cells}</div><div class="st-legend"><span><i class="st-dot-strength"></i>Силовые</span><span><i class="st-dot-run"></i>Бег</span><span>Нажми на день</span></div><div id="st-day-detail" aria-live="polite">${selectedDay?selection.length?selection.map(w=>`<button class="st-session" data-st-workout="${escape(w.id)}"><span class="st-session-icon ${w.type==='run'?'mint':''}">${icon(w.type==='run'?'run':'weight')}</span><span><b>${escape(w.name||'Тренировка')}</b><small>${date(w.startedAt)} · ${time(duration(w))}${w.type==='run'?' · '+fmt(positive(w.distance))+' км':''}</small></span>${icon('arrow')}</button>`).join(''):'<p class="st-note">В этот день тренировок не было.</p>':''}</div>`;
  }
  function progressChart(points,mode) {
    const p=points.filter(p=>mode==='volume'||p.weight!==null);
    if(!p.length)return '<div class="st-chart-empty">Нет выполненных подходов за этот период.</div>';
    const vals=p.map(x=>mode==='volume'?x.volume:x.weight), low=Math.min(...vals), high=Math.max(...vals), padding=Math.max(1,(high-low)*.2), min=low-padding, max=high+padding;
    const x=i=>p.length===1?160:44+(i/(p.length-1))*254, y=v=>140-(v-min)/(max-min)*118;
    const line=p.map((v,i)=>`${x(i)},${y(vals[i])}`).join(' ');
    return `<svg class="st-progress-svg" viewBox="0 0 320 174" role="img" aria-label="${mode==='volume'?'Тоннаж':'Рабочий вес'}, кг: ${vals.map(fmt).join(', ')}"><defs><linearGradient id="st-chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b7a2ff" stop-opacity=".25"/><stop offset="1" stop-color="#b7a2ff" stop-opacity="0"/></linearGradient></defs>${[low,(low+high)/2,high].filter((v,i,a)=>a.indexOf(v)===i).map(v=>`<path d="M44 ${y(v)}H306" class="st-grid-line"/><text x="2" y="${y(v)+3}" class="st-svg-label">${fmt(v)}</text>`).join('')}<polygon points="${x(0)},146 ${line} ${x(p.length-1)},146" fill="url(#st-chart-fill)"/><polyline points="${line}" class="st-progress-line"/>${p.map((v,i)=>`<circle cx="${x(i)}" cy="${y(vals[i])}" r="${i===p.length-1?4:2.5}" class="st-progress-dot"><title>${date(v.ts)} · ${fmt(vals[i])} кг</title></circle>`).join('')}<text x="44" y="169" class="st-svg-label">${date(p[0].ts)}</text>${p.length>1?`<text x="306" y="169" text-anchor="end" class="st-svg-label">${date(p[p.length-1].ts)}</text>`:''}</svg>${p.length===1?'<p class="st-note">Первая точка. После следующей тренировки появится динамика.</p>':''}`;
  }
  function exercisePanel(series,m,state) {
    const inPeriod=series.map(ex=>({...ex,points:ex.points.filter(p=>p.ts>=m.range.from)})).filter(ex=>ex.points.length);
    let ex=inPeriod.find(ex=>ex.id===state.exerciseId) || series.find(ex=>ex.id===state.exerciseId) || inPeriod[0] || series[0];
    if(!ex)return panel('Прогресс упражнения','Рабочий вес и выполненный объём','<p class="st-note">Здесь появится прогресс после первой силовой тренировки.</p>');
    state.selectExercise(ex.id);
    const points=ex.points.filter(p=>p.ts>=m.range.from), mode=state.graphMode, valid=points.filter(p=>mode==='volume'||p.weight!==null), val=p=>mode==='volume'?p.volume:p.weight;
    const first=valid[0],last=valid[valid.length-1], pct=valid.length>=2?change(val(last),val(first)):null;
    const title=`<button class="st-ex-select" id="stats-ex-pick-btn" aria-label="Выбрать упражнение">${escape(ex.name)}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>`;
    const tabs=`<div class="st-toggle">${[['weight','Вес'],['volume','Тоннаж']].map(([key,label])=>`<button data-st-graph="${key}" class="${mode===key?'active':''}" aria-pressed="${mode===key}">${label}</button>`).join('')}</div>`;
    return panel('Прогресс упражнения','По выполненным подходам за выбранный период',`${title}<div class="st-ex-summary"><div><strong>${last?fmt(val(last)):'—'}<small>${last?' кг':''}</small></strong><span>${mode==='volume'?'Объём последней тренировки':'Последний рабочий вес'}</span></div><span class="st-change ${pct>0?'positive':''}">${pct===null?'Нужны 2 точки':`${pct>0?'+':''}${pct}%`}</span></div>${progressChart(points,mode)}<div class="st-ex-foot"><span>${points.length} ${trainingWord(points.length)}</span><span>Лучший за период: ${valid.length?fmt(Math.max(...valid.map(val)))+' кг':'—'}</span></div><details class="st-data"><summary>Данные и расчёт</summary><p>${mode==='volume'?'Тоннаж = положительный вес × повторы, включая дроп-сеты. Собственный вес и помощь в тоннаж не входят.':'Вес = максимальный вес выполненного подхода с повторами, без дроп-сетов. Отрицательный вес обозначает помощь; приближение к нулю увеличивает показатель.'} Изменение — между первой и последней точкой периода. Варианты выполнения объединены.</p>${points.map(p=>`<div><span>${date(p.ts)}</span><b>${val(p)===null?'—':fmt(val(p))+' кг'}</b></div>`).join('')}</details>`,tabs,'st-ex-panel');
  }
  function trendsPanel(series,m) {
    const trends=series.map(ex=>{
      const points=ex.points.filter(p=>p.ts>=m.range.from && p.weight!==null);
      if(points.length<2)return null;
      const first=points[0].weight,last=points[points.length-1].weight,pct=change(last,first);
      return pct===null?null:{id:ex.id,name:ex.name,first,last,pct,count:points.length};
    }).filter(Boolean).sort((a,b)=>b.pct-a.pct).slice(0,5);
    if(!trends.length)return '';
    return panel('Динамика упражнений','Рабочий вес: от первой к последней тренировке периода',`<div class="st-trends">${trends.map(ex=>`<button class="st-trend" data-st-exercise="${escape(ex.id)}"><span><b>${escape(ex.name)}</b><small>${fmt(ex.first)} → ${fmt(ex.last)} кг · ${ex.count} ${trainingWord(ex.count)}</small></span><span class="st-change ${ex.pct>0?'positive':''}">${ex.pct>0?'+':''}${ex.pct}%</span>${icon('arrow')}</button>`).join('')}</div>`);
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
    const focusAttribute=activeControl?[...activeControl.attributes].find(a=>['data-st-activity','data-st-graph','data-st-day','data-st-bin'].includes(a.name)):null;
    const sameView=key===viewKey;
    if(key!==viewKey){selectedDay=null;selectedActivity=null;} viewKey=key;
    const m=analyze(DATA.getWorkoutHistory(user),state.period,state.type), s=m.summary;
    const catalog=DATA.getVisibleExercises(user), series=exerciseSeries(m.scope,catalog), strength=summarize(m.current.filter(w=>w.type==='strength')), runs=summarize(m.current.filter(w=>w.type==='run'));
    const opts=[['all','Все'],['strength','Силовые'],['run','Бег']].map(([key,label])=>({key,label,count:m.all.filter(w=>w.startedAt>=m.range.from && (key==='all'||w.type===key)).length}));
    buildHistoryDropdown(document.getElementById('stats-type-dd'),opts,state.type,key=>state.setType(key));
    buildHistoryDropdown(document.getElementById('stats-period-dd'),STATS_PERIODS.map(([key,label])=>({key,label})),state.period,key=>state.setPeriod(key));
    const rangeLabel=m.current.length?`${date(m.range.from||m.current[0].startedAt)} — ${date(m.now)}`:(m.range.from?`${date(m.range.from)} — ${date(m.now)}`:'Вся история');
    const headline=state.type==='run'?'Твой беговой ритм':state.type==='strength'?'Твоя сила в цифрах':'Твой тренировочный ритм';
    const hero=`<section class="st-hero"><div class="st-eyebrow">ОБЗОР · ${escape(rangeLabel)}</div><h1>${headline}</h1><div class="st-hero-total"><strong>${s.count}</strong><div><span>${state.type==='run'?runWord(s.count):trainingWord(s.count)}</span>${delta(s.count,m.prior.count,m)}</div></div><div class="st-hero-footer">${state.type==='all'?`<span>${icon('weight')} ${strength.count} силовых</span><span class="mint">${icon('run')} ${runs.count} ${runWord(runs.count)}</span>`:`<span>${icon('calendar')} ${s.days} дней с тренировками</span><span>${icon('activity')} ${fmt(m.perWeek)} в неделю</span>`}</div><div class="st-hero-orbit" aria-hidden="true"></div></section>`;
    const stats=`<div class="st-metrics">${metric('Время тренировок',time(s.seconds),'',s.timed?`${time(s.avgSeconds)} в среднем`:'Длительность пока не записана','clock')}${metric('Регулярность',fmt(m.perWeek),'в неделю',`${s.days} активных дней за период`,'activity')}${state.type==='run'?metric('Дистанция',fmt(s.distance),'км',delta(s.distance,m.prior.distance,m),'run'):metric('Тоннаж',fmt(s.volume/1000),'т',delta(s.volume,m.prior.volume,m),'weight')}${state.type==='run'?metric('Средний темп',pace(s.avgPace),'мин/км','С учётом дистанции пробежек','clock'):metric('Выполнено',s.sets,'подходов',`${fmt(s.reps)} повторов за период`,'weight')}</div>`;
    const toggle=`<div class="st-toggle">${[['count','Тренировки'],['time','Время']].map(([key,label])=>`<button data-st-activity="${key}" class="${activityMode===key?'active':''}" aria-pressed="${activityMode===key}">${label}</button>`).join('')}</div>`;
    const charts=panel('Ритм тренировок','Как распределяется активность внутри периода',activityChart(m),toggle,'st-activity-panel')+panel('Календарь активности',`${date(shiftDay(dayStart(m.now),1-Math.min(m.range.days||56,56)))} — ${date(m.now)} · ${m.range.days>56||!m.range.days?'последние 8 недель':'выбранный период'}`,calendar(m),'','st-calendar-panel');
    const empty=!s.count?`<section class="st-empty"><span>${icon('activity')}</span><h2>${m.scope.length?'В этом периоде пока тихо':'Начни свою историю прогресса'}</h2><p>${m.scope.length?'Выбери другой период, чтобы увидеть предыдущие тренировки.':'Заверши тренировку — здесь появятся твой ритм, нагрузка и динамика результатов.'}</p>${m.scope.length?'<button id="st-show-all">Показать всё время</button>':''}</section>`:'';
    const extras=s.count?(state.type!=='run'?exercisePanel(series,m,state)+trendsPanel(series,m)+loadPanel(series,m):'')+(state.type==='run'||(state.type==='all'&&runs.count)?runPanel(m):''):'';
    const orphans=DATA.getOrphanExercises(user);
    const orphan=state.type!=='run'&&orphans.length?`<button class="st-orphan" id="s-orphan-btn"><span><b>Упражнения без связи с каталогом: ${orphans.length}</b><small>Привяжи их, чтобы объединить историю прогресса</small></span>${icon('arrow')}</button>`:'';
    scroll.innerHTML=`<div class="st-dashboard">${hero}${empty}${s.count?stats+'<div class="st-main-grid">'+charts+extras+'</div>':''}${orphan}<details class="st-method"><summary>Как считаются показатели</summary><p>Неделя — последние 7 дней, месяц — 30, три месяца — 90, год — 365, включая сегодня. Сравнение — с предыдущим таким же отрезком до того же времени суток. Частота — число тренировок, делённое на длину периода в неделях; за всё время — от первой тренировки. Время берётся из записанной длительности, а для старых записей — из времени начала и окончания. Тоннаж учитывает только положительный вес выполненных подходов.</p></details></div>`;
    scroll.scrollTop=sameView?scrollTop:0;
    if(sameView && focusAttribute)[...scroll.querySelectorAll(`[${focusAttribute.name}]`)].find(el=>el.getAttribute(focusAttribute.name)===focusAttribute.value)?.focus({preventScroll:true});
    scroll.querySelectorAll('[data-st-activity]').forEach(btn=>btn.addEventListener('click',()=>{activityMode=btn.dataset.stActivity;render(state);}));
    scroll.querySelectorAll('[data-st-graph]').forEach(btn=>btn.addEventListener('click',()=>state.setGraphMode(btn.dataset.stGraph)));
    scroll.querySelectorAll('[data-st-bin]').forEach(btn=>btn.addEventListener('click',()=>{const index=Number(btn.dataset.stBin);selectedActivity=selectedActivity===index?null:index;render(state);}));
    scroll.querySelectorAll('[data-st-exercise]').forEach(btn=>btn.addEventListener('click',()=>{state.setExercise(btn.dataset.stExercise);document.querySelector('.st-ex-panel')?.scrollIntoView({block:'start',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});}));
    scroll.querySelectorAll('[data-st-day]').forEach(btn=>btn.addEventListener('click',()=>{const key=dayKey(Number(btn.dataset.stDay));selectedDay=selectedDay===key?null:key;render(state);}));
    scroll.querySelectorAll('[data-st-workout]').forEach(btn=>btn.addEventListener('click',()=>{const w=m.current.find(w=>String(w.id)===btn.dataset.stWorkout);if(w)openDetailScreen(w,'stats');}));
    document.getElementById('stats-ex-pick-btn')?.addEventListener('click',()=>openExercisePicker(id=>state.setExercise(id),state.exerciseId));
    document.getElementById('s-orphan-btn')?.addEventListener('click',()=>openOrphanRemapSheet());
    document.getElementById('st-show-all')?.addEventListener('click',()=>state.setPeriod('all'));
  }
  window.TrainStats={...api,render};
})();
