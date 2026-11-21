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
  const out=clone(ex),a=out.atlas||={};a.categories=sections.movement.value.filter(name=>typeof name==='string'&&name.trim());
  for(const role of ['target','synergist','stabilizer'])a[role]=sections.muscles.value.filter(m=>m.role===role&&m.muscle?.trim()).map(({role,...m})=>({...m,bundle:m.bundles?.length?m.bundles.join(' · '):m.bundle||''}));
  out.muscles={...(out.muscles||{}),...Object.fromEntries([['target','agonists'],['synergist','synergists'],['stabilizer','stabilizers']].map(([role,key])=>[key,a[role].map(m=>m.muscle+(m.bundle?' ('+m.bundle+')':'')).join(', ')]))};
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
 const icons={history:'<path d="M3 12a9 9 0 1 0 3-6L3 9m0-5v5h5m4-2v5l3 2"/>',movement:'<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',muscles:'<path d="M3 12h4l3-8 4 16 3-8h4"/>',technique:'<path d="M9 5h11M9 12h11M9 19h11M3 5h1M3 12h1M3 19h1"/>',mistakes:'<path d="m12 3 10 18H2L12 3ZM12 9v5M12 17v1"/>',features:'<path d="M9 18h6M9 21h6M8 14a6 6 0 1 1 8 0l-1 3H9l-1-3Z"/>',restrictions:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3ZM12 8v5M12 16v1"/>',parameters:'<path d="M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6"/>'};
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
   const slides=[...content.children],track=document.createElement('div');track.className='template-carousel xd-carousel-track';track.setAttribute('role','region');track.setAttribute('aria-label',label);track.tabIndex=0;
   slides.forEach((slide,n)=>{slide.classList.add('xd-carousel-slide');slide.setAttribute('aria-label',`${n+1} из ${slides.length}`);track.append(slide);});
   const dots=document.createElement('div');dots.className='xd-carousel-dots';
   content.replaceChildren(dots,track);
   const render=setupCompactCarouselDots(dots,slides.length,label);
   const controller=setupTemplateCarousel(track,{onIndexChange:render,followHeight:true});
   track.onkeydown=event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();const index=Math.max(0,Math.min(slides.length-1,controller.currentIndex()+(event.key==='ArrowRight'?1:-1)));track.scrollTo({left:templateCarouselTargets(track)[index],behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});}};
   const cleanup=new MutationObserver(()=>{if(!content.isConnected){controller.destroy();cleanup.disconnect();}});cleanup.observe($('screen-exercise-detail'),{childList:true,subtree:true});
 }
 function parameters(ex,catalog,returnScreen,options){
   const host=document.createElement('div'),current=options.executionSnapshot||executionForExercise(DATA.getCurrentUser(),ex);
   host.innerHTML=executionControlsHtml(current,ex.id);
   wireExecutionControls(host,()=>current,value=>{
    if(options.onExecutionChange){options.onExecutionChange(value);return;}
    _executionDrafts.set(executionDraftKey(DATA.getCurrentUser(),ex.id),value);
    const body=$('exd-body'),scroll=body.scrollTop;openExerciseDetail(ex.id,returnScreen,{scope:catalog?'catalog':'mine'});body.scrollTop=scroll;
   });return host;
 }
 function removalLabel(ex,catalog){
   if(catalog)return 'Удалить из каталога';
   return ex.catalogSource||DATA.atlasExerciseById(ex.id)?'Убрать из моих':'Удалить упражнение';
 }
 function mountRemoval(ex,returnScreen,options={}){
   const screen=options.container||$('screen-exercise-detail'),catalog=options.catalog??_exdCatalog;
   screen.querySelector('[data-xd-remove]')?.remove();
   if(options.previewExercise||!canEditExerciseLibrary(catalog))return;
   const label=removalLabel(ex,catalog),owner=Auth.userId(),userId=DATA.getCurrentUser();
   const button=document.createElement('button');button.type='button';button.className='btn-chip xd-remove';button.dataset.xdRemove='';button.setAttribute('aria-label',label);button.title=label;button.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/></svg>';
   screen.querySelector('.xe-toolbar, .detail-screen-header').append(button);
   button.onclick=()=>{if(owner===Auth.userId()&&userId===DATA.getCurrentUser())confirmRemoval(ex,returnScreen,{...options,catalog});};
 }
 function confirmRemoval(ex,returnScreen,options){
   const {catalog}=options,screen=options.container||$('screen-exercise-detail'),label=removalLabel(ex,catalog);
   const userId=DATA.getCurrentUser(),owner=Auth.userId();
   const current=()=>owner===Auth.userId()&&userId===DATA.getCurrentUser()&&!Auth.contextChanged()&&canEditExerciseLibrary(catalog);
   if(!current()||options.isCurrent&&!options.isCurrent())return;
   const dialog=document.createElement('dialog');dialog.className='xd-sheet xd-remove-sheet';
   dialog.innerHTML=`<h2>${label}?</h2><p>«${escHtml(ex.name)}» ${catalog?'будет удалено из общего каталога у всех.':ex.catalogSource||DATA.atlasExerciseById(ex.id)?'исчезнет из «Моих». История тренировок сохранится.':'можно будет восстановить в «Недавно удалённых» в течение 7 дней.'}</p><p class="xd-editor-error" role="alert" hidden></p><div class="xd-remove-actions"><button type="button" data-cancel>Отмена</button><button type="button" data-remove-confirm>${label}</button></div>`;
   dialog.querySelector('[data-cancel]').onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove());screen.append(dialog);dialog.showModal();
   const refresh=()=>{renderExercisesList(exercisesSearch.value);if(SCREENS.exerciseReference.classList.contains('active'))renderExerciseReference();};
   dialog.querySelector('[data-remove-confirm]').onclick=async event=>{
     if(!current()||options.isCurrent&&!options.isCurrent()){dialog.close();return;}
     const confirm=event.currentTarget;confirm.disabled=true;
     try{
       let data;
       if(catalog){
         const next=DATA.atlasSnapshot(),positions=atlasExercisePositions(next),index=next.exercises.findIndex(item=>item.id===ex.id);
         if(index<0)throw Error('Упражнение уже удалено');
         data={raw:next.exercises.splice(index,1)[0],position:positions[ex.id],owner};
         delete positions[ex.id];
         await commitSharedAtlas(next,[['deleteAtlasExercise',ex.id]]);
       }else{
         data={own:DATA.getOwnExercises(userId).find(item=>item.id===ex.id),exId:ex.id};
         DATA.deleteOwnExercise(userId,ex.id);
         SyncQueue.push('exercise:delete',{id:ex.id});
       }
       const trashId=Trash.push(userId,{type:'exercise',label:ex.name,sub:catalog?'Упражнение каталога':'Упражнение',data});
       dialog.close();
       if(!current())return;
       options.onRemoved?.();refresh();
       if($('screen-exercise-detail').classList.contains('active')&&_detailExerciseId===ex.id&&_exdCatalog===catalog)goBackScreen(returnScreen,{keepFilter:true,resumeConstructor:returnScreen==='constructor'});
       showUndoToast(catalog?'Упражнение удалено из каталога':'Упражнение убрано из моих',async()=>{
         if(!current())return;
         if(await restoreFromTrash(userId,trashId)){if(current())refresh();}
         else showToast('Не удалось восстановить упражнение');
       });
     }catch(error){const message=dialog.querySelector('.xd-editor-error');message.textContent='Не удалось удалить: '+error.message;message.hidden=false;confirm.disabled=false;}
   };
 }
 function decorate(ex,returnScreen,options,snapshot,resolved){
   const screen=$('screen-exercise-detail'),body=$('exd-body'),catalog=_exdCatalog,a=ex.atlas||{},userId=DATA.getCurrentUser();
   screen.classList.add('xd-view');screen.querySelector('[data-xd-remove]')?.remove();$('exd-title').textContent='Упражнение';
   document.querySelector('.xd-source')?.remove();
   document.querySelectorAll('.xd-membership').forEach(button=>button.remove());
   const tabs=document.createElement('div');tabs.className='xd-source';tabs.dataset.active=catalog?'catalog':'mine';tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Источник упражнения');
   tabs.innerHTML=['mine','catalog'].map(scope=>`<button type="button" role="tab" data-xd-scope="${scope}" aria-selected="${catalog===(scope==='catalog')}">${scope==='mine'?'Мои':'Каталог'}</button>`).join('');

   const changeSource=scope=>{
     if(!scope||scope===(catalog?'catalog':'mine'))return;
     const found=DATA.libraryExercises(userId,scope==='catalog').find(item=>item.id===ex.id);
     if(!found){if(scope==='catalog')sheet('В каталоге больше нет','Оригинал недоступен. Ваша личная копия сохранена.');else sheet('В «Моих» пока нет','Добавьте упражнение из каталога в «Мои», чтобы открыть его в своей библиотеке.');return;}
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
   const updateMarks=()=>execution.querySelectorAll('.xd-section').forEach(section=>{
    const relation=resolved.sections[section.dataset.sectionKind],host=section.querySelector('.xd-section-parameters');if(!relation||!host)return;
    const values=relation.conditions.map(([id,value])=>({name:snapshot.executionParameters.find(p=>p.id===id)?.name||'',value}));host.hidden=!values.length;host.innerHTML=values.map(v=>`<span class="xd-parameter-mark">${escHtml(v.value)}</span>`).join('');host.title=values.map(v=>v.name+': '+v.value).join(' · ');host.setAttribute('aria-label',host.title);
    if(relation.changed)section.querySelector('.xd-content')?.classList.add('xd-dependent-fragment');
    if(relation.conflict){const note=document.createElement('p');note.className='ex-form-hint';note.textContent='Для этого сочетания показано общее описание: отличия требуют уточнения.';section.querySelector('.xd-content')?.prepend(note);}
   });
   const canEdit = canEditExerciseLibrary(catalog) && !options.previewExercise && !_constructorCatalog && returnScreen !== 'workout';
   const parameterNodes = snapshot.executionParameters.length ? [parameters(ex,catalog,returnScreen,options)] : [];
   if (canEdit) {
     const edit = document.createElement('button');
     edit.type = 'button'; edit.className = 'btn-chip';
     edit.textContent = parameterNodes.length ? 'Настроить параметры' : 'Добавить параметр';
     edit.onclick = () => openExerciseForm(ex.id,{catalog,focus:'parameters'});
     parameterNodes.push(edit);
   }
   if (parameterNodes.length) tree.append(wrap('Параметры выполнения',parameterNodes,'parameters',index++));
   if (canEdit) {
     const add = document.createElement('button');
     add.type = 'button'; add.className = 'btn-chip'; add.textContent = 'Добавить вариацию';
     add.onclick = () => openExerciseForm(null,{catalog,variationOf:ex.id});
     tree.append(wrap('Вариации',[add],'features',index++));
   }
   tree.append(execution);
   const moves=exerciseMovements(resolved.exercise);
   if(moves.length){const links=document.createElement('div');links.innerHTML=moves.map(name=>`<button class="xd-movement-link" type="button" data-reference-kind="movement" data-reference-name="${escHtml(name)}"><span>${escHtml(name)}</span>${chevron}</button>`).join('');execution.append(wrap('Движения',[links],'movement',index++));}
   cards.forEach(card=>{
     const labels=[...card.querySelectorAll('.exd-section-label')];
     let title=labels[0]?.textContent.trim()||'',icon='features';
     if(card.querySelector('.exd-muscle-role'))icon='muscles';
     else if(card.querySelector('.exd-step'))icon='technique';
     else if(card.querySelector('.exd-mistake'))icon='mistakes';
     else if(card.querySelector('.exd-warn')){title='Ограничения';icon='restrictions';}
     else if(card.querySelector('.exd-tip')){title='Дополнительно';icon='additional';card.querySelector('.exd-tip b')?.remove();}
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
         content.replaceChildren();for(const text of resolved.sections.features.value.filter(text=>text.trim())){const item=document.createElement('article');item.className='xd-feature-item';item.innerHTML=`<p class="xd-feature-detail">${escHtml(text)}</p>`;content.append(item);}
         carousel(content,'Особенности упражнения');
       }else if(title==='Ограничения'){
         section.classList.add('xd-restrictions-section');section.querySelector('.xd-content').classList.add('xd-restrictions-content');
         const toggle=section.querySelector('.xd-section-heading'),heading=document.createElement('h2');heading.className='xd-section-heading xd-fixed-heading';heading.innerHTML=toggle.innerHTML;heading.querySelector(':scope > svg')?.remove();toggle.replaceWith(heading);
         const lead=section.querySelector('.exd-warn b');if(lead?.textContent==='Противопоказания.')lead.remove();
       }
       execution.append(section);
     }
   });
   if(!options.previewExercise){
     const sessions=DATA.getWorkoutHistory(userId).filter(w=>w.type==='strength' && !w.deleted &&
       w.exercises?.some(entry=>entry.exerciseId===ex.id && entry.sets?.some(WorkoutCore.performed)));
     const list=document.createElement('div');
     function showSessions(all){
       list.replaceChildren();
       for(const workout of all?sessions:sessions.slice(0,3)){
         const button=document.createElement('button');button.type='button';button.className='xd-movement-link xd-session';
         button.innerHTML=`<span>${escHtml(workout.name || 'Силовая тренировка')}<small>${escHtml(fmtDate(workout.startedAt))}</small></span>${chevron}`;
         button.onclick=()=>openDetailScreen(workout,'exerciseDetail',ex.id);
         list.append(button);
       }
       if(!sessions.length)list.textContent='Пока нет выполнений';
       if(sessions.length>3){
         const more=document.createElement('button');more.type='button';more.className='btn-chip';
         more.textContent=all?'Свернуть':`Посмотреть все (${sessions.length})`;more.onclick=()=>showSessions(!all);list.append(more);
       }
     }
     showSessions(false);tree.append(wrap('Последние тренировки',[list],'history',index++));
   }
   updateMarks();
   if(options.previewExercise)execution.querySelectorAll('[data-reference-kind]').forEach(button=>button.disabled=true);
   if(!execution.children.length)execution.remove();
   const included=!DATA.isHidden(userId,ex.id);
   const hero=document.createElement('article');hero.className='xd-hero';
   hero.innerHTML=`<h1>${escHtml(ex.name)}</h1><div class="xd-hero-meta">${ex.cat?.trim()?`<button type="button" class="xd-group movement-group-chip" data-xd-group="${escHtml(ex.cat)}" aria-label="Группа: ${escHtml(ex.cat)}">${referenceIcon('groups')}<span>${escHtml(ex.cat)}</span></button>`:''}${a.level?.trim()?`<span class="xd-type">${escHtml(LEVEL_LABELS[a.level]||a.level)}</span>`:''}${catalog&&!options.previewExercise?'<button type="button" class="xd-membership" aria-pressed="'+included+'"></button>':''}</div>`;
   if(!options.previewExercise&&returnScreen!=='workout')hero.querySelector('.xd-hero-meta').append(tabs);
   const groupButton=hero.querySelector('[data-xd-group]');
   if(groupButton){groupButton.disabled=!!options.previewExercise;groupButton.onclick=()=>{
     if(!ex.cat)return;
     _referenceTrail=[{screen:'screen-exercise-detail',state:{..._referenceState},exerciseId:ex.id,returnScreen,scroll:body.scrollTop}];
     _referenceState={page:'group',name:ex.cat,scope:_exerciseLibrary,query:'',sort:'count-desc',picker:null,scrollTop:0,owner:Auth.userId(),userId};goToScreen('exerciseReference');
   };}
   if(catalog&&!options.previewExercise){const button=hero.querySelector('.xd-membership');button.setAttribute('aria-pressed',String(included));button.innerHTML=exerciseMembershipIcon(included);button.setAttribute('aria-label',included?'Убрать из моих':'Добавить в мои');button.title=included?'Убрать из моих':'Добавить в мои';button.onclick=()=>{toggleExerciseLibrary(ex.id);openExerciseDetail(ex.id,returnScreen,{scope:'catalog'});};}
   let header=screen.querySelector('.xd-fixed-header');
   if(!header){header=document.createElement('header');header.className='xd-fixed-header';const toolbar=screen.querySelector('.detail-screen-header');screen.prepend(header);header.append(toolbar);}
   header.querySelector('.xd-hero')?.remove();header.append(hero);
   const membershipButton=hero.querySelector('.xd-membership');if(membershipButton)header.querySelector('.detail-screen-header').insertBefore(membershipButton,$('exd-edit-btn'));
   const inner=document.createElement('div');inner.className='xd-scroll-inner';inner.append(...(media?[media]:[]),...(tree.querySelector('.xd-section')?[tree]:[]),...links);body.replaceChildren(inner);
   if(!catalog&&!options.previewExercise&&DATA.catalogUpdateAvailable(userId,ex.id)){
     const notice=document.createElement('section');notice.className='xd-catalog-update';
     notice.innerHTML='<p><b>В каталоге есть обновление</b><br>Ваша версия сохранена. Можно оставить её или заменить версией из каталога.</p><button type="button" class="btn-chip">Посмотреть обновление</button>';
     notice.querySelector('button').onclick=()=>{
       const owner=Auth.userId(),source=DATA.atlasExerciseById(ex.catalogSource.id);
       if(!source)return;
       const dialog=document.createElement('dialog');dialog.className='xd-sheet';
       dialog.innerHTML=`<h2>Обновить упражнение?</h2><p>Версия из каталога: ${escHtml(source.name)}. Название, описание, группа и параметры вашей копии будут заменены. История тренировок сохранится.</p><button type="button" data-review>Открыть версию каталога</button><button type="button" data-update>Обновить мою копию</button><button type="button" data-keep>Оставить текущую</button>`;
       screen.append(dialog);dialog.addEventListener('close',()=>dialog.remove());
       dialog.querySelector('[data-keep]').onclick=()=>dialog.close();
       dialog.querySelector('[data-review]').onclick=()=>{dialog.close();openExerciseDetail(source.id,returnScreen,{scope:'catalog'});};
       dialog.querySelector('[data-update]').onclick=()=>{
         if(owner!==Auth.userId()||userId!==DATA.getCurrentUser()||Auth.contextChanged())return;
         try{
           if(!DATA.refreshExerciseFromCatalog(userId,ex.id))return;
           _executionDrafts.delete(executionDraftKey(userId,ex.id));
           dialog.close();openExerciseDetail(ex.id,returnScreen,{scope:'mine'});
         }catch(error){showToast(error.message);}
       };
       dialog.showModal();
     };
     inner.prepend(notice);
   }
   body.scrollTop=0;body.querySelectorAll('.exd-video-btn').forEach(link=>{link.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2"/></svg>Открыть материал';});
 }
 window.ExerciseDetailPage={decorate,mountRemoval,confirmRemoval};
})();
