"use strict";

(() => {
 if(new URLSearchParams(location.search).has("__exercise_design"))return;
  const paths={history:'M3 12a9 9 0 1 0 3-6L3 9m0-5v5h5m4-2v5l3 2',additional:'M10 13a5 5 0 0 1 7 0m-3-3 3-3',level:'M4 18h3v-4H4z M10 18h3v-8h-3z M16 18h3V6h-3z',back:'M19 12H5m7-7-7 7 7 7',down:'m6 9 6 6 6-6',plus:'M12 5v14M5 12h14',eye:'M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',groups:'M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z',parameters:'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',muscles:'M3 12h4l3-8 4 16 3-8h4',movement:'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',technique:'M9 5h11M9 12h11M9 19h11M3 5h1M3 12h1M3 19h1',mistakes:'m12 3 10 18H2L12 3ZM12 9v5M12 17v1',lock:'M5 10h14v11H5ZM8 10V6a4 4 0 0 1 8 0v4',features:'M9 18h6M9 21h6M8 14a6 6 0 1 1 8 0l-1 3H9l-1-3Z',restrictions:'m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3ZM12 8v5M12 16v1',check:'m5 12 4 4L19 6',link:'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2'};
  const cardIcon=name=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]||paths.features}"/></svg>`;
  const sectionNames={parameters:'Параметры выполнения',groups:'Группа',level:'Тип упражнения',movement:'Движения',muscles:'Рабочие мышцы',technique:'Техника выполнения',restrictions:'Ограничения',features:'Особенности',mistakes:'Типичные ошибки',additional:'Дополнительно'};
  const descriptionOrder=['technique','restrictions','features','mistakes','additional'];
  function sectionShell(kind,{content='',editing=false,open=true,count='',fallback='',attr=''}={}){
    const title=sectionNames[kind]||fallback;
    const tag=kind==='restrictions'&&!editing?'section':'details',heading=tag==='details'?'summary':'h2';
    return `<${tag} class="xd-section exercise-section" data-section-kind="${kind}" ${editing?'data-kind="'+kind+'"':''} ${tag==='details'&&open?'open':''} ${attr}>
      <${heading} class="xd-section-heading"><span class="xd-node" aria-hidden="true">${cardIcon(kind)}</span><span class="xd-heading-title">${escHtml(title)}</span>${editing?`<span class="xe-summary-count" data-count="${kind}">${escHtml(count)}</span>`:'<span class="xd-section-parameters" hidden></span>'}${tag==='details'?cardIcon('down'):''}</${heading}>
      <div class="xd-content${editing?' xe-disclosure-body':''}">${content}</div></${tag}>`;
  }
  function headerTags(groups,level,linkGroups=false){
    return groups.map(name=>{
      const body=referenceIcon('groups')+'<span>'+escHtml(name)+'</span>';
      return linkGroups?referenceLink('group',name,name,'xd-group movement-group-chip',body):'<span class="xd-group movement-group-chip">'+body+'</span>';
    }).join('')+(level?`<span class="xd-type">${escHtml(LEVEL_LABELS[level]||level)}</span>`:'');
  }
  function nameWords(name){
    return name.split(/(\s+)/).map(word=>{
      if(!word.includes('-'))return word;
      const span=document.createElement('span');span.className='title-word';span.textContent=word;return span;
    });
  }
  function fillCardHeader(header,{back,action,title,name,kind,hero,extra}){
    header.className='xd-fixed-header card-header';
    const toolbar=document.createElement('div');toolbar.className='detail-screen-header card-toolbar';
    const kicker=document.createElement('span');kicker.className='read-kicker';kicker.textContent=kind==='section'?'Раздел':'Упражнение';
    back.classList.add('card-back');action.classList.add('card-action');title.classList.add('card-title');
    title.replaceChildren(...nameWords(name));toolbar.append(back,kicker,action,title);
    if(extra)toolbar.append(extra);
    header.replaceChildren(toolbar,hero);
  }
  function libraryTabs(catalog){
    const tabs=document.createElement('div');tabs.className='xd-source';tabs.dataset.active=catalog?'catalog':'mine';
    tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Источник упражнения');
    tabs.innerHTML=['mine','catalog'].map(scope=>`<button type="button" role="tab" data-xd-scope="${scope}" aria-selected="${catalog===(scope==='catalog')}">${scope==='mine'?'Мои':'Каталог'}</button>`).join('');
    return tabs;
  }

 const chevron='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg>';
 let displayed=null;
 const currentExecution=(id,catalog,user)=>displayed?.id===id&&displayed.catalog===catalog&&displayed.user===user?copyExecutionSnapshot(displayed.snapshot):null;
 const sourceNotice=text=>{
   const header=$('screen-exercise-detail').querySelector('.xd-hero');
   header.querySelector('.source-note')?.remove();
   const note=document.createElement('p');note.className='source-note';note.textContent=text;note.setAttribute('role','status');header.append(note);
 };
 function wrap(title,nodes,kind,index){
   const template=document.createElement('template');template.innerHTML=sectionShell(kind,{fallback:title});
   const section=template.content.firstElementChild;
   const content=section.querySelector('.xd-content');content.id='xd-section-'+index;content.append(...nodes);
   return section;
 }
 function carousel(content,label){
   const slides=[...content.children],track=document.createElement('div');track.className='template-carousel xd-carousel-track';track.setAttribute('role','region');track.setAttribute('aria-label',label);track.tabIndex=0;
   slides.forEach((slide,n)=>{slide.classList.add('xd-carousel-slide');slide.setAttribute('aria-label',`${n+1} из ${slides.length}`);track.append(slide);});
   const dots=document.createElement('div');dots.className='xd-carousel-dots';
   content.replaceChildren(dots,track);
   const render=setupCompactCarouselDots(dots,slides.length,label);
   const controller=setupTemplateCarousel(track,{onIndexChange:render,naturalHeight:true});
   track.onkeydown=event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();const index=Math.max(0,Math.min(slides.length-1,controller.currentIndex()+(event.key==='ArrowRight'?1:-1)));track.scrollTo({left:templateCarouselTargets(track)[index],behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});}};
   const cleanup=new MutationObserver(()=>{if(!content.isConnected){controller.destroy();cleanup.disconnect();}});cleanup.observe($('screen-exercise-detail'),{childList:true,subtree:true});
 }
 function parameters(ex,catalog,returnScreen,options){
   const host=document.createElement('div'),current=options.executionSnapshot||executionForExercise(DATA.getCurrentUser(),ex);
   host.innerHTML=executionControlsHtml(current,ex.id);
   wireExecutionControls(host,()=>current,value=>{
    if(options.onExecutionChange){options.onExecutionChange(value);return;}
    if(_constructorCatalog?.selectedId===ex.id)_constructorCatalog.selectedSnapshot=value;
    _executionDrafts.set(executionDraftKey(DATA.getCurrentUser(),ex.id),value);
    const body=$('exd-body'),scroll=body.scrollTop;openExerciseDetail(ex.id,returnScreen,{...options,executionSnapshot:value,scope:catalog?'catalog':'mine'});body.scrollTop=scroll;
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
   screen.querySelector('.xd-pick-footer')?.remove();
   if(!options.previewExercise)displayed={id:ex.id,catalog,user:userId,snapshot};
   const picker=_constructorCatalog;
   if(picker && !options.previewExercise && returnScreen==='exercises' && picker.selectedId===ex.id){
     const footer=document.createElement('footer');footer.className='xd-pick-footer';
     const button=document.createElement('button');button.type='button';button.textContent='Выбрать и продолжить';
     button.onclick=()=>{if(_constructorCatalog===picker && picker.selectedId===ex.id)confirmExerciseSelection();};
     footer.append(button);screen.append(footer);
   }
   screen.classList.add('xd-view');screen.querySelector('[data-xd-remove]')?.remove();$('exd-title').textContent='Упражнение';
   const tabs=libraryTabs(catalog);
   const changeSource=scope=>{
     if(!scope||scope===(catalog?'catalog':'mine'))return;
     const found=DATA.libraryExercises(userId,scope==='catalog').find(item=>item.id===ex.id);
     if(!found){if(scope==='catalog')sourceNotice('Оригинал недоступен. Ваша личная копия сохранена.');else sourceNotice('Добавьте упражнение из каталога в «Мои», чтобы открыть его в своей библиотеке.');return;}
     setReferenceLibraryScope(scope);openExerciseDetail(ex.id,returnScreen,{scope});
     document.querySelector('.xd-source [aria-selected="true"]')?.focus();
   };
   tabs.onclick=event=>changeSource(event.target.closest('[data-xd-scope]')?.dataset.xdScope);
   tabs.onkeydown=event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();changeSource(catalog?'mine':'catalog');}};
   $('exd-edit-btn').style.display=options.previewExercise||catalog&&!DATA.isAdmin()?'none':'';
   $('exd-edit-btn').onclick=null;
   const cards=[...body.querySelectorAll(':scope > .exd-card')],media=body.querySelector(':scope > .exd-media');
   const tree=document.createElement('div');tree.className='xd-tree';let index=0;
   const execution=document.createElement('div');execution.className='xd-execution-group xd-variant-description';execution.setAttribute('aria-label','Описание выполнения: движения, мышцы, техника, ошибки, особенности и ограничения');
   const updateMarks=()=>execution.querySelectorAll('.xd-section').forEach(section=>{
    const relation=resolved.sections[section.dataset.sectionKind],host=section.querySelector('.xd-section-parameters');if(!relation||!host)return;
    const values=relation.conditions.map(([id,value])=>({name:snapshot.executionParameters.find(p=>p.id===id)?.name||'',value}));host.hidden=!values.length;host.innerHTML=values.map(v=>`<span class="xd-parameter-mark">${escHtml(v.value)}</span>`).join('');host.title=values.map(v=>v.name+': '+v.value).join(' · ');host.setAttribute('aria-label',host.title);
    if(relation.changed)section.querySelector('.xd-content')?.classList.add('xd-dependent-fragment');
    if(relation.conflict){const note=document.createElement('p');note.className='ex-form-hint';note.textContent='Для этого сочетания показано общее описание: отличия требуют уточнения.';section.querySelector('.xd-content')?.prepend(note);}
   });
   const parameterNodes=snapshot.executionParameters.length?[parameters(ex,catalog,returnScreen,options)]:[];
   if (parameterNodes.length) tree.append(wrap('Параметры выполнения',parameterNodes,'parameters',index++));
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
     else if(card.querySelector('.exd-note'))title='Особенности';
     if(!title)return;
     labels.forEach(label=>label.remove());
     const roleRows=[...card.querySelectorAll('.exd-muscle-role')];
     const support=roleRows.filter(row=>['Синергисты','Стабилизаторы','Распределители'].includes(row.querySelector('.exd-muscle-role-name')?.textContent.trim()));
     if(support.length){
       const first=support[0];first.querySelector('.exd-muscle-role-name').textContent='Вспомогательные';
       for(const row of support.slice(1)){first.querySelector('.exd-chips').append(...row.querySelector('.exd-chips').children);row.remove();}
     }
     card.querySelectorAll('.exd-muscle-role-name').forEach(label=>{if(label.textContent.trim()==='Целевые')label.textContent='Основные';else if(label.textContent.trim()==='Синергисты')label.textContent='Вспомогательные';});
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
           const item=document.createElement('article');item.className='xd-error-item';
           item.innerHTML=`<p class="xd-slide-title">${escHtml(problem.trim())}</p>${correction?`<div class="xd-error-detail xd-error-fix"><span class="xd-fix-label"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>Исправление</span><p>${escHtml(correction)}</p></div>`:''}`;
           old.replaceWith(item);
         });
         carousel(content,'Типичные ошибки');
       }else if(title==='Особенности'){
         section.classList.add('xd-features-section');const content=section.querySelector('.xd-content');content.classList.add('xd-features-content');
         content.replaceChildren();for(const text of resolved.sections.features.value.filter(text=>text.trim())){const item=document.createElement('article');item.className='xd-feature-item';item.innerHTML=`<p class="xd-feature-detail">${escHtml(text)}</p>`;content.append(item);}
         carousel(content,'Особенности');
       }else if(title==='Ограничения'){
         section.classList.add('xd-restrictions-section');section.querySelector('.xd-content').classList.add('xd-restrictions-content');
         const lead=section.querySelector('.exd-warn b');if(lead?.textContent==='Противопоказания.')lead.remove();
       }
       execution.append(section);
     }
   });
   if(!options.previewExercise){
     const sessions=ExerciseDescriptions.history(userId).filter(w=>w.type==='strength' && !w.deleted &&
       w.exercises?.some(entry=>entry.exerciseId===ex.id && entry.sets?.some(set=>WorkoutCore.performed(set)&&WorkoutCore.setKey(set,entry)===WorkoutCore.executionKey(snapshot))));
     const pr=WorkoutCore.record(sessions,{exerciseId:ex.id,...snapshot},DATA.getExerciseMetric(userId,ex.id));
     if(pr){
       const result=document.createElement('button');result.type='button';result.className='xd-movement-link';
       result.textContent=pr.metric==='time'?WorkoutCore.formatTime(pr.value):pr.weight+' кг × '+pr.value;
       result.onclick=()=>openDetailScreen(pr.workout,'exerciseDetail',ex.id);
       tree.append(wrap('Рекорд выполнения',[result],'history',index++));
     }
     const list=document.createElement('div');
     function showSessions(all){
       list.replaceChildren();
       for(const workout of all?sessions:sessions.slice(0,3)){
         const button=document.createElement('button');button.type='button';button.className='xd-movement-link xd-session';
         button.innerHTML=`<span>${escHtml(workout.name || 'Силовая тренировка')}<small>${escHtml(fmtDate(workout.startedAt))}</small></span>${chevron}`;
         button.onclick=()=>openDetailScreen(workout,'exerciseDetail',ex.id);
         list.append(button);
       }
       if(sessions.length>3){
         const more=document.createElement('button');more.type='button';more.className='btn-chip';
         more.textContent=all?'Свернуть':`Посмотреть все (${sessions.length})`;more.onclick=()=>showSessions(!all);list.append(more);
       }
     }
     if(sessions.length){showSessions(false);tree.append(wrap('Последние тренировки',[list],'history',index++));}
   }
   for(const kind of descriptionOrder){
     const section=execution.querySelector('[data-section-kind="'+kind+'"]');if(section)execution.append(section);
   }
   updateMarks();
   if(options.previewExercise)execution.querySelectorAll('[data-reference-kind]').forEach(button=>button.disabled=true);
   if(!execution.children.length)execution.remove();
   const included=!DATA.isHidden(userId,ex.id);
   const hero=document.createElement('article');hero.className='xd-hero';
   hero.innerHTML='<div class="xd-hero-meta"></div>';
   if(catalog&&!options.previewExercise)hero.firstChild.innerHTML='<button type="button" class="xd-membership"></button>';
   const meta=hero.querySelector('.xd-hero-meta');
   meta.insertAdjacentHTML('afterbegin',headerTags(resolved.sections.groups.value,resolved.sections.level.value,!options.previewExercise));
   if(snapshot.executionValues.length)hero.insertAdjacentHTML('beforeend',executionBadges(snapshot));
   if(options.previewExercise){
     const note=document.createElement('p');note.className='ex-form-hint';
     note.textContent='В выборе упражнений · '+resolved.sections.groups.value.join(' / ')+' · '+ex.name+
       (snapshot.executionValues.length?' · '+snapshot.executionValues.map(v=>v.value).join(' · '):'')+
       '  |  На графике · '+(resolved.exercise.atlas.categories.join(' · ')||'Движения не заданы');hero.append(note);
   }
   if(!options.previewExercise&&returnScreen!=='workout')hero.querySelector('.xd-hero-meta').append(tabs);
   if(catalog&&!options.previewExercise){const button=hero.querySelector('.xd-membership');button.setAttribute('aria-pressed',String(included));button.innerHTML=exerciseMembershipIcon(included);button.setAttribute('aria-label',included?'Убрать из моих':'Добавить в мои');button.title=included?'Убрать из моих':'Добавить в мои';button.onclick=()=>{toggleExerciseLibrary(ex.id);openExerciseDetail(ex.id,returnScreen,{scope:'catalog'});};}
   const back=$('exd-back-btn'),action=$('exd-edit-btn'),title=$('exd-title'),extra=$('exd-meta');
   const oldToolbar=screen.querySelector('.detail-screen-header');
   let header=screen.querySelector('.card-header');
   if(!header){header=document.createElement('header');screen.prepend(header);}
   title.className='card-title';title.setAttribute('role','heading');title.setAttribute('aria-level','1');
   fillCardHeader(header,{back,action,title,name:ex.name,kind:ex.kind,hero,extra});
   oldToolbar?.remove();
   const material=media||(ex.media&&isHttpUrl(ex.media)?body.querySelector('a.exd-video-btn'):null);
   const inner=document.createElement('div');inner.className='xd-scroll-inner';inner.append(...(material?[material]:[]),...(tree.querySelector('.xd-section')?[tree]:[]));body.replaceChildren(inner);
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
   body.scrollTop=0;
 }
 window.ExerciseDetailPage={currentExecution,decorate,mountRemoval,confirmRemoval,cardIcon,sectionShell,descriptionOrder,fillCardHeader,headerTags,libraryTabs};
})();
