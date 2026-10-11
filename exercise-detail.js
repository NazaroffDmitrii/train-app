"use strict";
const ExerciseDescriptions = (() => {
 const clone=value=>JSON.parse(JSON.stringify(value));
 const kinds=['movement','muscles','technique','mistakes','features','restrictions'];
 function base(ex){
  const a=ex.atlas||{},roles=[['target','agonists'],['synergist','synergists'],['stabilizer','stabilizers']];
  return {movement:clone(a.categories||[]),muscles:roles.flatMap(([role,legacy])=>(a[role]||splitMuscles(ex.muscles?.[legacy]).map(text=>{const m=text.match(/^(.*?)\s*\(([^)]+)\)$/);return {muscle:m?m[1].trim():text,bundle:m?m[2]:''};})).map(m=>({...clone(m),role,bundles:Array.isArray(m.bundles)?m.bundles:m.bundle?[m.bundle]:[]}))),technique:a.technique||(ex.steps||[]).join('\n'),mistakes:Array.isArray(a.mistakeDetails)?clone(a.mistakeDetails):(a.mistakes||[]).map(text=>{const parts=String(text).split(/Исправление:\s*/);return {problem:parts.shift().trim(),correction:parts.join('Исправление: ').trim()};}),features:Array.isArray(a.features)?clone(a.features):[a.differences,a.extra].filter(Boolean),restrictions:a.contraindications||''};
 }
 function variants(ex){
  const result={},defs=normalizeExecutionParameters(ex.atlas?.executionParameters);
  for(const [key,description] of Object.entries(ex.atlas?.executionDescriptions?.variants||{})){
   try{const pairs=JSON.parse(key);if(!Array.isArray(pairs)||!pairs.length||pairs.some(pair=>!Array.isArray(pair)||pair.length!==2||!defs.some(p=>p.id===pair[0]&&p.options.includes(pair[1]))))continue;
    const clean={};for(const kind of kinds)if(Object.hasOwn(description,kind)&&((['technique','restrictions'].includes(kind)&&typeof description[kind]==='string')||(!['technique','restrictions'].includes(kind)&&Array.isArray(description[kind]))))clean[kind]=clone(description[kind]);
    result[key]=clean;
   }catch{}
  }return result;
 }
 function resolve(ex,snapshot){
  const common=base(ex),rules=variants(ex),values=snapshot.executionValues,sections={};
  for(const kind of kinds){
   const matches=Object.entries(rules).filter(([key,rule])=>Object.hasOwn(rule,kind)&&JSON.parse(key).every(([id,value])=>values.some(v=>v.id===id&&v.value===value))).sort((a,b)=>JSON.parse(b[0]).length-JSON.parse(a[0]).length);
   const best=matches[0],conflict=best&&matches.some(([key,rule])=>JSON.parse(key).length===JSON.parse(best[0]).length&&JSON.stringify(rule[kind])!==JSON.stringify(best[1][kind]));
   sections[kind]={value:best&&!conflict?best[1][kind]:common[kind],conditions:best&&!conflict?JSON.parse(best[0]):[],conflict:!!conflict,changed:!!best&&!conflict&&JSON.stringify(best[1][kind])!==JSON.stringify(common[kind])};
  }
  const out=clone(ex),a=out.atlas||={};a.categories=sections.movement.value;
  for(const role of ['target','synergist','stabilizer'])a[role]=sections.muscles.value.filter(m=>m.role===role).map(({role,...m})=>({...m,bundle:m.bundles?.length?m.bundles.join(' · '):m.bundle||''}));
  a.technique=sections.technique.value;out.steps=a.technique.split('\n').map(v=>v.trim()).filter(Boolean);
  a.mistakeDetails=sections.mistakes.value;a.mistakes=a.mistakeDetails.filter(m=>m.problem?.trim()).map(m=>m.problem.trim()+(m.correction?.trim()?' Исправление: '+m.correction.trim():''));
  a.features=sections.features.value.filter(t=>t.trim());a.differences=a.features[0]||'';a.extra=a.features.slice(1).join('\n\n');a.contraindications=sections.restrictions.value;
  return {exercise:out,sections};
 }
 return {base,variants,resolve};
})();
(() => {
 if(new URLSearchParams(location.search).has("__exercise_design"))return;
 const chevron='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg>';
 const down='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
 const icons={movement:'<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',muscles:'<path d="M3 12h4l3-8 4 16 3-8h4"/>',technique:'<path d="M9 5h11M9 12h11M9 19h11M3 5h1M3 12h1M3 19h1"/>',mistakes:'<path d="m12 3 10 18H2L12 3ZM12 9v5M12 17v1"/>',features:'<path d="M9 18h6M9 21h6M8 14a6 6 0 1 1 8 0l-1 3H9l-1-3Z"/>',restrictions:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3ZM12 8v5M12 16v1"/>',parameters:'<path d="M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6"/>'};
 const sheet=(title,text)=>{
   document.querySelector('.xd-sheet')?.remove();
   const dialog=document.createElement('dialog');dialog.className='xd-sheet';
   dialog.innerHTML=`<h2>${escHtml(title)}</h2><p>${escHtml(text)}</p><button type="button">Понятно</button>`;
   $('screen-exercise-detail').append(dialog);dialog.querySelector('button').onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove());dialog.showModal();
 };
 function wrap(title,nodes,icon,index){
   const section=document.createElement('section');section.className='xd-section';
   section.dataset.sectionKind=icon;
   const id='xd-section-'+index;
   section.innerHTML=`<button class="xd-section-heading" type="button" aria-expanded="true" aria-controls="${id}"><span class="xd-node" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${icons[icon]||icons.features}</svg></span><span class="xd-heading-title">${escHtml(title)}</span><span class="xd-section-parameters" hidden></span>${down}</button><div class="xd-content" id="${id}"></div>`;
   section.querySelector('.xd-content').append(...nodes);
   section.querySelector('button').onclick=event=>{const button=event.currentTarget,content=section.querySelector('.xd-content');content.hidden=!content.hidden;button.setAttribute('aria-expanded',String(!content.hidden));};
   return section;
 }
 function carousel(content,label){
   const slides=[...content.children],track=document.createElement('div');track.className='xd-carousel-track';track.setAttribute('role','region');track.setAttribute('aria-label',label);track.tabIndex=0;
   slides.forEach((slide,n)=>{slide.classList.add('xd-carousel-slide');slide.setAttribute('aria-label',`${n+1} из ${slides.length}`);track.append(slide);});
   const dots=document.createElement('div');dots.className='xd-carousel-dots';dots.setAttribute('role','img');dots.hidden=slides.length<2;dots.innerHTML=Array.from({length:Math.min(3,slides.length)},()=>'<span aria-hidden="true"></span>').join('');
   content.replaceChildren(dots,track);let active=0,pending=null;
   const resize=()=>{if(track.clientWidth&&slides[active])track.style.height=slides[active].offsetHeight+'px';};
   const render=()=>{const slot=slides.length<3?active:active===0?0:active===slides.length-1?2:1;[...dots.children].forEach((dot,n)=>dot.classList.toggle('is-active',n===slot));dots.dataset.index=active;dots.setAttribute('aria-label',`${label}: карточка ${active+1} из ${slides.length}`);resize();};
   const choose=n=>{active=Math.max(0,Math.min(slides.length-1,n));pending=active;track.scrollTo({left:slides[active].offsetLeft-slides[0].offsetLeft,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});render();};
   // Preserve keyboard access without adding any visible carousel controls.
   track.onkeydown=event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();choose(active+(event.key==='ArrowRight'?1:-1));}};
   track.addEventListener('scroll',()=>{if(!track.clientWidth)return;if(pending!==null){const target=slides[pending].offsetLeft-slides[0].offsetLeft;if(Math.abs(track.scrollLeft-target)>2)return;pending=null;}active=Math.max(0,Math.min(slides.length-1,Math.round(track.scrollLeft/track.clientWidth)));render();},{passive:true});
   const cancelPending=()=>{pending=null;active=Math.max(0,Math.min(slides.length-1,Math.round(track.scrollLeft/Math.max(1,track.clientWidth))));render();};['pointerdown','touchstart','wheel'].forEach(event=>track.addEventListener(event,cancelPending,{passive:true}));
   const observer=new ResizeObserver(resize);slides.forEach(slide=>observer.observe(slide));observer.observe(track);
   const cleanup=new MutationObserver(()=>{if(!content.isConnected){observer.disconnect();cleanup.disconnect();}});cleanup.observe($('screen-exercise-detail'),{childList:true,subtree:true});
   requestAnimationFrame(render);
 }
 function parameters(ex,catalog,returnScreen,options){
   const host=document.createElement('div'),current=options.executionSnapshot||executionForExercise(DATA.getCurrentUser(),ex);
   host.innerHTML=executionControlsHtml(current,ex.id)||'<p class="ex-form-hint">Параметры пока не заданы.</p>';
   if(!options.previewExercise&&(!catalog||DATA.isAdmin())){
    const button=document.createElement('button');button.type='button';button.className='execution-configure';button.textContent=current.executionParameters.length?'Настроить параметры':'+ Добавить параметр';host.append(button);
    button.onclick=()=>openExerciseForm(ex.id,{catalog,focus:'parameters'});
   }
   wireExecutionControls(host,()=>current,value=>{
    if(options.onExecutionChange){options.onExecutionChange(value);return;}
    _executionDrafts.set(executionDraftKey(DATA.getCurrentUser(),ex.id),value);
    const body=$('exd-body'),scroll=body.scrollTop;openExerciseDetail(ex.id,returnScreen,{scope:catalog?'catalog':'mine'});body.scrollTop=scroll;
   });return host;
 }
 function decorate(ex,returnScreen,options={}){
   const screen=$('screen-exercise-detail'),body=$('exd-body'),catalog=_exdCatalog,a=ex.atlas||{},userId=DATA.getCurrentUser();
   screen.classList.add('xd-view');$('exd-title').textContent='Упражнение';
   document.querySelector('.xd-source')?.remove();
   document.querySelectorAll('.xd-membership').forEach(button=>button.remove());
   const tabs=document.createElement('div');tabs.className='xd-source';tabs.dataset.active=catalog?'catalog':'mine';tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Источник упражнения');
   tabs.innerHTML=['mine','catalog'].map(scope=>`<button type="button" role="tab" data-xd-scope="${scope}" aria-selected="${catalog===(scope==='catalog')}">${scope==='mine'?'Мои':'Каталог'}</button>`).join('');

   const changeSource=scope=>{
     if(!scope||scope===(catalog?'catalog':'mine'))return;
     const found=(scope==='catalog'?DATA.DEFAULT_EXERCISES:DATA.getVisibleExercises(userId)).find(item=>item.id===ex.id);
     if(!found){sheet('В «Моих» пока нет','Добавьте упражнение из каталога в «Мои», чтобы открыть его в своей библиотеке.');return;}
     setReferenceLibraryScope(scope);openExerciseDetail(ex.id,returnScreen,{scope});
     document.querySelector('.xd-source [aria-selected="true"]')?.focus();
   };
   tabs.onclick=event=>changeSource(event.target.closest('[data-xd-scope]')?.dataset.xdScope);
   tabs.onkeydown=event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();changeSource(catalog?'mine':'catalog');}};
   $('exd-edit-btn').style.display=options.previewExercise||catalog&&!DATA.isAdmin()?'none':'';
   $('exd-edit-btn').onclick=null;
   const cards=[...body.querySelectorAll(':scope > .exd-card')],media=body.querySelector(':scope > .exd-media'),links=[...body.querySelectorAll(':scope > a.exd-video-btn')].filter(link=>link.getAttribute('href')===(ex.media||'').trim());
   const tree=document.createElement('div');tree.className='xd-tree';let index=0;
   const execution=document.createElement('div');execution.className='xd-execution-group xd-variant-description';execution.setAttribute('aria-label','Описание выполнения: движения, мышцы, техника, ошибки, особенности и ограничения');
   const snapshot=options.executionSnapshot||executionForExercise(userId,ex),resolved=ExerciseDescriptions.resolve(ex,snapshot);
   const updateMarks=()=>execution.querySelectorAll('.xd-section').forEach(section=>{
    const relation=resolved.sections[section.dataset.sectionKind],host=section.querySelector('.xd-section-parameters');if(!relation||!host)return;
    const values=relation.conditions.map(([id,value])=>({name:snapshot.executionParameters.find(p=>p.id===id)?.name||'',value}));host.hidden=!values.length;host.innerHTML=values.map(v=>`<span class="xd-parameter-mark">${escHtml(v.value)}</span>`).join('');host.title=values.map(v=>v.name+': '+v.value).join(' · ');host.setAttribute('aria-label',host.title);
    if(relation.changed)section.querySelector('.xd-content')?.classList.add('xd-dependent-fragment');
    if(relation.conflict){const note=document.createElement('p');note.className='ex-form-hint';note.textContent='Для этого сочетания показано общее описание: отличия требуют уточнения.';section.querySelector('.xd-content')?.prepend(note);}
   });
   const parameterHost=parameters(ex,catalog,returnScreen,options);tree.append(wrap('Параметры выполнения',[parameterHost],'parameters',index++),execution);
   const moves=exerciseMovements(resolved.exercise);
   if(moves.length){const links=document.createElement('div');links.innerHTML=moves.map(name=>`<button class="xd-movement-link" type="button" data-reference-kind="movement" data-reference-name="${escHtml(name)}"><span>${escHtml(name)}</span>${chevron}</button>`).join('');execution.append(wrap('Движения',[links],'movement',index++));}
   cards.forEach(card=>{
     const labels=[...card.querySelectorAll('.exd-section-label')];
     let title=labels[0]?.textContent.trim()||'',icon='features';
     if(card.classList.contains('execution-detail')){
       return;
     }else if(card.querySelector('.exd-muscle-role'))icon='muscles';
     else if(card.querySelector('.exd-step'))icon='technique';
     else if(card.querySelector('.exd-mistake'))icon='mistakes';
     else if(card.querySelector('.exd-warn')){title='Ограничения';icon='restrictions';}
     else if(card.querySelector('.exd-tip'))title='Дополнительно';
     else if(card.querySelector('.exd-note'))title='Особенности упражнения';
     if(!title)return;
     labels.forEach(label=>label.remove());
     card.querySelectorAll('.exd-muscle-role-name').forEach(label=>{if(label.textContent.trim()==='Целевые')label.textContent='Агонисты';});
     card.querySelectorAll('.exd-chip').forEach(button=>{
       const text=button.textContent,parts=text.split(' · ');
       button.innerHTML=`<span>${escHtml(parts[0])}${parts.length>1?`<small>${escHtml(parts.slice(1).join(' · '))}</small>`:''}</span>${chevron}`;
     });
     const section=wrap(title,[...card.childNodes],icon,index++);
     if(icon==='muscles')execution.append(section);
     else{
       if(icon==='technique'){
         section.classList.add('xd-technique-section');
         const list=document.createElement('ol');list.className='xd-technique-list';section.querySelectorAll('.exd-step').forEach(step=>{const item=document.createElement('li'),paragraph=document.createElement('p');paragraph.className='xd-technique-paragraph';paragraph.textContent=step.querySelector('.exd-step-text').textContent;item.append(paragraph);list.append(item);});section.querySelector('.xd-content').replaceChildren(list);
       }
       if(icon==='mistakes'){
         section.classList.add('xd-errors-section');
         const content=section.querySelector('.xd-content');content.classList.add('xd-errors-content');
         content.querySelectorAll('.exd-mistake').forEach((old,n)=>{
           const text=old.querySelector('span:last-child').textContent,parts=text.split(/Исправление:\s*/),problem=parts.shift(),correction=parts.join('Исправление: ');
           const item=document.createElement('details');item.className='xd-error-item';
           item.innerHTML=`<summary><span class="xd-slide-title">${escHtml(problem.trim())}</span>${down}</summary><div class="xd-error-detail">${correction?`<div class="xd-error-fix"><span class="xd-fix-label"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>Исправление</span><p>${escHtml(correction)}</p></div>`:''}</div>`;
           old.replaceWith(item);
         });
         carousel(content,'Типичные ошибки');
       }else if(title==='Особенности упражнения'){
         section.classList.add('xd-features-section');const content=section.querySelector('.xd-content');content.classList.add('xd-features-content');
         content.replaceChildren();for(const text of ExerciseDescriptions.resolve(ex,snapshot).sections.features.value.filter(text=>text.trim())){const item=document.createElement('article');item.className='xd-feature-item';item.innerHTML=`<p class="xd-feature-detail">${escHtml(text)}</p>`;content.append(item);}
         carousel(content,'Особенности упражнения');
       }else if(title==='Ограничения'){
         section.classList.add('xd-restrictions-section');section.querySelector('.xd-content').classList.add('xd-restrictions-content');
         const toggle=section.querySelector('.xd-section-heading'),heading=document.createElement('h2');heading.className='xd-section-heading xd-fixed-heading';heading.innerHTML=toggle.innerHTML;heading.querySelector(':scope > svg')?.remove();toggle.replaceWith(heading);
         const lead=section.querySelector('.exd-warn b');if(lead?.textContent==='Противопоказания.')lead.remove();
       }
       execution.append(section);
     }
   });
   updateMarks();
   if(options.previewExercise)execution.querySelectorAll('[data-reference-kind]').forEach(button=>button.disabled=true);
   const included=!DATA.isHidden(userId,ex.id);
   const hero=document.createElement('article');hero.className='xd-hero';
   hero.innerHTML=`<h1>${escHtml(ex.name)}</h1><div class="xd-hero-meta"><button type="button" class="xd-group movement-group-chip" data-xd-group="${escHtml(ex.cat||'')}" aria-label="Группа: ${escHtml(ex.cat||'Без группы')}">${referenceIcon('groups')}<span>${escHtml(ex.cat||'Без группы')}</span></button><span class="xd-type" aria-label="Тип: ${escHtml(LEVEL_LABELS[a.level]||a.level||'Не указан')}">${escHtml(LEVEL_LABELS[a.level]||a.level||'Не указан')}</span>${catalog&&!options.previewExercise?'<button type="button" class="xd-membership" aria-pressed="'+included+'"></button>':''}</div>`;
   if(!options.previewExercise&&returnScreen!=='workout')hero.querySelector('.xd-hero-meta').append(tabs);
   hero.querySelector('[data-xd-group]').disabled=!!options.previewExercise;
   hero.querySelector('[data-xd-group]').onclick=()=>{
     if(!ex.cat)return;
     _referenceTrail=[{screen:'screen-exercise-detail',state:{..._referenceState},exerciseId:ex.id,returnScreen,scroll:body.scrollTop}];
     _referenceState={page:'group',name:ex.cat,scope:_exerciseLibrary,query:'',sort:'count-desc',picker:null,scrollTop:0,owner:Auth.userId(),userId};goToScreen('exerciseReference');
   };
   if(catalog&&!options.previewExercise){const button=hero.querySelector('.xd-membership');button.setAttribute('aria-pressed',String(included));button.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="${included?'m5 12 4 4L19 6':'M12 5v14M5 12h14'}"/></svg>${included?'В моих':'Добавить в мои'}`;button.onclick=()=>{toggleExerciseLibrary(ex.id);openExerciseDetail(ex.id,returnScreen,{scope:'catalog'});};}
   let header=screen.querySelector('.xd-fixed-header');
   if(!header){header=document.createElement('header');header.className='xd-fixed-header';const toolbar=screen.querySelector('.detail-screen-header');screen.prepend(header);header.append(toolbar);}
   header.querySelector('.xd-hero')?.remove();header.append(hero);
   const membershipButton=hero.querySelector('.xd-membership');if(membershipButton)header.querySelector('.detail-screen-header').append(membershipButton);
   body.replaceChildren(...(media?[media]:[]),tree,...links);
   body.scrollTop=0;body.querySelectorAll('.exd-video-btn').forEach(link=>{link.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2"/></svg>Открыть материал';});
 }
 window.ExerciseDetailPage={decorate};
})();
