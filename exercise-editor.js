"use strict";
// Approved full-page editor. Persistence stays behind the existing DATA/shared-atlas boundaries.
(() => {
  if(new URLSearchParams(location.search).has("__exercise_design"))return;
  const {cardIcon,sectionShell,descriptionOrder,fillCardHeader,headerTags,libraryTabs}=window.ExerciseDetailPage;
  const clone=value=>JSON.parse(JSON.stringify(value)),E=escHtml;
  const icon=cardIcon;
  const titles={tip:'Дополнительно',media:'Материалы',level:'Тип упражнения',groups:'Группа',muscles:'Рабочие мышцы',movement:'Движения',technique:'Техника выполнения',mistakes:'Типичные ошибки',features:'Особенности',restrictions:'Ограничения'};
  const roles=[['target','Основные'],['synergist','Вспомогательные']];
  let draft,baseline,seed,root,form,context=[],contextKey='',dirty=false,previewEx=null,pendingNew=false;
  let editorOptions={},editorOwner,editorUser,editorReturn,previewReturn;
  const validContext=()=>editorOwner===Auth.userId()&&editorUser===DATA.getCurrentUser()&&!Auth.contextChanged()&&editorOptions.isCurrent?.()!==false&&(!editorOptions.catalog||DATA.isAdmin());
  const quantity=(n,forms)=>n+' '+forms[n%100>10&&n%100<20?2:n%10===1?0:n%10>=2&&n%10<=4?1:2];
  const keyFor=values=>JSON.stringify(values.map(v=>[v.id,v.value]).sort((a,b)=>a[0].localeCompare(b[0])));
  const visibleRole=m=>m.role==='stabilizer'?'synergist':m.role;
  const variant=()=>contextKey?(draft.variants[contextKey]||={}):null;
  function baseField(kind){
    if(kind==='groups')return [draft.cat].filter(Boolean);
    if(kind==='level')return draft.level;
    if(kind==='media'||kind==='tip')return draft.extra[kind];
    return draft.base[kind];
  }
  function setField(kind,value){
    if(!contextKey){
      if(kind==='groups')draft.cat=value[0]||'';
      else if(kind==='level')draft.level=value;
      else if(kind==='media'||kind==='tip')draft.extra[kind]=value;
      else draft.base[kind]=value;
      return;
    }
    const rule=variant();delete rule[kind];
    const inherited=resolveDescription(kind);
    if(inherited.conflict||JSON.stringify(inherited.value)!==JSON.stringify(value))rule[kind]=value;
  }
  function resolveDescription(kind){
    const base=baseField(kind);
    if(!contextKey)return {value:base,key:'',conflict:false};
    const values=ExerciseDescriptions.effectiveValues(executionSnapshot(draft.parameters,context));
    const result=ExerciseDescriptions.section(base,draft.variants,values,kind);
    return {...result,key:result.conditions.length?JSON.stringify(result.conditions):''};
  }
  const effective=kind=>resolveDescription(kind).value;
  const groupColor=name=>(editorOptions.catalog?DATA.categoryColor(DATA.atlasGroups().indexOf(name)):DATA.getCategoryColor(DATA.getCurrentUser(),name))||'#b9aeff';
  function fromExercise(ex){
    const a=ex.atlas||{};const snap=executionForExercise(DATA.getCurrentUser(),ex);

    return {id:ex.id,name:ex.name,cat:ex.cat||'',level:a.level||'',format:ex.type==='run'?'run':'strength',parameters:clone(snap?.executionParameters||a.executionParameters||[]),variants:ExerciseDescriptions.variants(ex),base:ExerciseDescriptions.base(ex),extra:{equipment:a.equipment||'',media:ex.media||'',reference:a.referenceUrl||'',tip:ex.tip||''},original:clone(ex)};
  }
  function newDraft(){return {id:'e_own_'+crypto.randomUUID(),name:'',cat:'',level:'',format:'strength',parameters:[],variants:{},base:{muscles:[],movement:[],technique:'',mistakes:[],features:[],restrictions:''},extra:{equipment:'',media:'',reference:'',tip:''},original:{atlas:{}}};}
  const serialized=value=>{const copy=clone(value);for(const key of Object.keys(copy.variants))if(!Object.keys(copy.variants[key]).length)delete copy.variants[key];return JSON.stringify(copy);};
  function touch(){dirty=serialized(draft)!==baseline;const status=root?.querySelector('.xe-status');if(status){status.textContent='Изменения не сохранены';status.hidden=!dirty;}}
  function field(label,id,value,placeholder='',area=false,extra=''){return `<div class="xe-field"><label class="xe-label ${extra==='xe-fix-input'?'xe-fix-label':''}" for="${id}">${label}</label>${area?`<textarea class="xe-input ${extra}" id="${id}" rows="4" placeholder="${E(placeholder)}">${E(value)}</textarea>`:`<input class="xe-input ${extra}" id="${id}" type="text" placeholder="${E(placeholder)}" value="${E(value)}">`}</div>`;}
  
  function count(kind){const value=effective(kind);if(kind==='level')return LEVEL_LABELS[value]||value||'Не указан';if(kind==='groups')return value.join(' · ')||'Не выбраны';if(kind==='muscles')return value.length?quantity(value.length,['мышца','мышцы','мышц']):'Не выбраны';if(kind==='movement')return value.length?quantity(value.length,['движение','движения','движений']):'Не выбраны';if(kind==='mistakes')return value.length?quantity(value.length,['ошибка','ошибки','ошибок']):'Не заполнено';if(kind==='features')return value.length?quantity(value.length,['карточка','карточки','карточек']):'Не заполнено';return value.trim()?'Заполнено':'Не заполнено';}
  function section(kind,content,open=false){
    return sectionShell(kind,{content,editing:true,open,count:count(kind)});
  }
  function legacyChoices(){
    if(!contextKey)return '';
    const exercises=DATA.libraryExercises(editorUser,editorOptions.catalog),links=ExerciseDescriptions.legacyMap(exercises);
    const members=exercises.filter(e=>e.id!==draft.id&&!links.has(e.id)&&!Object.values(ExerciseDescriptions.variants(e)).some(rule=>rule.sources?.length));
    if(links.has(draft.id))return '';
    const linked=variant().sources||[];
    const chips=linked.map(id=>'<span class="xe-tag">'+E(exercises.find(e=>e.id===id)?.name||id)+'<button type="button" data-unlink="'+E(id)+'" aria-label="Снять привязку">×</button></span>').join('');
    const candidates=members.filter(e=>!Object.values(draft.variants).some(rule=>rule.sources?.includes(e.id)));
    if(!chips&&!candidates.length)return '';
    return '<details class="xe-disclosure"><summary>Перенос прежней карточки</summary><div class="xe-disclosure-body">'+chips+
      (candidates.length?'<label class="xe-field">Прежняя карточка<select data-legacy-source><option value="">Выберите упражнение</option>'+
      candidates.sort((a,b)=>Number(!!seed?.groupId&&b.groupId===seed.groupId)-Number(!!seed?.groupId&&a.groupId===seed.groupId)||a.name.localeCompare(b.name,'ru')).map(e=>'<option value="'+E(e.id)+'">'+E(e.name)+'</option>').join('')+
      '</select></label><button type="button" class="btn-chip" data-link-source>Привязать к выполнению</button>':'')+
      '<p class="xe-note">После сохранения выбранная карточка и её подходы будут относиться к этому выполнению.</p></div></details>';
  }
  function linkSource(id){
    const ex=DATA.libraryExercises(editorUser,editorOptions.catalog).find(item=>item.id===id);if(!ex)return;
    const rule=variant(),old=ExerciseDescriptions.base(ex);
    for(const kind of Object.keys(titles))if(!Object.hasOwn(rule,kind)&&JSON.stringify(old[kind])!==JSON.stringify(effective(kind)))rule[kind]=clone(old[kind]);
    const ids=new Map();
    for(const p of normalizeExecutionParameters(ex.atlas?.executionParameters)){
      let dest=draft.parameters.find(other=>other.id===p.id||other.name===p.name);
      if(!dest){dest=clone(p);draft.parameters.push(dest);}
      else dest.options=[...new Set([...dest.options,...p.options])];
      ids.set(p.id,dest.id);
    }
    for(const [key,oldRule] of Object.entries(ExerciseDescriptions.variants(ex))){
      const values=new Map(context.map(v=>[v.id,v.value]));
      for(const [id,value] of JSON.parse(key))values.set(ids.get(id)||id,value);
      const target=keyFor([...values].map(([id,value])=>({id,value})));
      draft.variants[target]={...clone(oldRule),...draft.variants[target]};
    }
    rule.sources=[...new Set([...(rule.sources||[]),id])];
    render(root.querySelector('.xe-body').scrollTop);touch();
  }
  function classificationRow(kind){
    const choices=kind==='groups'?(editorOptions.catalog?DATA.atlasGroups():DATA.getAllCategories(editorUser)):['global','regional','local'];
    const current=[effective(kind)].flat().filter(Boolean);
    const available=[...new Set([...choices,...current])];
    const buttons=available.map(value=>
      `<button type="button" data-class-value="${E(value)}" aria-pressed="${current[0]===value}">${E(kind==='level'?(LEVEL_LABELS[value]||value):value)}</button>`).join('');
    let extra='';
    if(kind==='groups'&&contextKey){
      const others=available.filter(value=>value!==current[0]).map(value=>
        `<button type="button" data-other-group="${E(value)}" aria-pressed="${current.includes(value)}">${E(value)}</button>`).join('');
      const priority=current.map(value=>`<label><input type="checkbox" data-group-priority="${E(value)}" ${variant().preferredGroups?.includes(value)?'checked':''}>Показывать первым в группе «${E(value)}»</label>`).join('');
      extra='<details class="more-moves group-placement"><summary>Размещение в группах'+icon('down')+'</summary><div class="class-options">'+others+'</div>'+priority+'</details>';
    }
    return section(kind,'<div class="class-options">'+buttons+'</div>'+extra);
  }
  function errorsHtml(){return effective('mistakes').map((m,n)=>`<article class="xe-entry" data-entry="mistakes"><div class="xe-entry-bar"><span>Ошибка ${n+1}</span><div class="xe-row-actions"><button type="button" data-delete-error="${n}" aria-label="Удалить ошибку ${n+1}">×</button></div></div>${field('Ошибка',`xe-error-${n}`,m.problem,'Что происходит при неправильном выполнении',true)}${field(icon('check')+'Исправление',`xe-fix-${n}`,m.correction,'Что сделать иначе',true,'xe-fix-input')}</article>`).join('')+`<button type="button" class="xe-soft-button" data-add-error>${icon('plus')}Добавить ошибку</button>`;}
  function featuresHtml(){return effective('features').map((text,n)=>`<article class="xe-entry" data-entry="features"><div class="xe-entry-bar"><span>Особенность ${n+1}</span><div class="xe-row-actions"><button type="button" data-delete-feature="${n}" aria-label="Удалить особенность ${n+1}">×</button></div></div>${field('Полный текст',`xe-feature-${n}`,text,'Одна особенность — одна карточка',true)}</article>`).join('')+`<button type="button" class="xe-soft-button" data-add-feature>${icon('plus')}Добавить особенность</button>`;}
  function musclesHtml(){
    return roles.map(([role,label])=>{const chosen=effective('muscles').map((m,n)=>({...m,index:n})).filter(m=>visibleRole(m)===role);
      return `<div class="xe-role-field"><div class="xe-role-heading"><label>${label}</label><button type="button" data-pick="muscles" data-role="${role}">${icon('plus')}Выбрать</button></div>${chosen.length?`<div class="xe-role-selected">${chosen.map(m=>{const bundles=(editorOptions.catalog?DATA.atlasMuscles():DATA.refMuscles(DATA.getCurrentUser())).find(item=>item.name===m.muscle)?.bundles||[];const names=m.bundles?.length?m.bundles:Array.isArray(m.bundles)?m.bundles:m.bundle?[m.bundle]:[];return `<div class="xe-role-muscle"><div><span>${E(m.muscle)}</span>${bundles.length?`<button type="button" data-edit-bundles="${m.index}" aria-label="Пучки мышцы ${E(m.muscle)}">${E(names.length?names.join(' · '):'Вся мышца')}${icon('down')}</button>`:names.length?`<small>${E(names.join(' · '))}</small>`:''}</div><button class="xe-muscle-remove" type="button" data-delete-muscle="${m.index}" aria-label="Убрать ${E(m.muscle)}">×</button></div>`;}).join('')}</div>`:'<p class="xe-role-empty">Мышцы не выбраны</p>'}</div>`;
    }).join('');
  }
  function movesHtml(){
    const source=editorOptions.catalog?DATA.atlasMovements():DATA.refMovements(editorUser);
    const selected=effective('movement'),groups=effective('groups');
    const main=[...new Set([...selected,...source.filter(item=>groups.includes(item.group)).map(item=>item.name)])];
    const rest=[...new Set(source.map(item=>item.name))].filter(name=>!main.includes(name));
    const options=names=>names.map(name=>`<button type="button" data-move-choice="${E(name)}" aria-pressed="${selected.includes(name)}">${E(name)}</button>`).join('');
    return `<div class="option-grid motion-options">${options(main)}</div>${rest.length?`<details class="more-moves"><summary>Другие движения${icon('down')}</summary><input type="search" class="xe-input" data-move-search aria-label="Поиск движения" placeholder="Найти движение"><div class="option-grid motion-options">${options(rest)}</div><p class="xe-note" data-no-moves hidden>Ничего не найдено</p></details>`:''}`;
  }
  function addButton(attr,label){return `<button type="button" class="add-control" ${attr}>${icon('plus')}${label}</button>`;}
  function paramsHtml(){
    const newVariant=addButton('data-preset="custom"','Новый вариант');
    if(!draft.parameters.length)return newVariant;
    return draft.parameters.map((p,n)=>`<div class="xe-param-row" data-param-row>
      <div class="xe-param-title"><input class="xe-input" data-param-name aria-label="Название варианта выполнения" placeholder="Название варианта выполнения" maxlength="80" value="${E(p.name)}"><button type="button" class="remove-control" data-delete-param="${n}" aria-label="Удалить вариант выполнения">×</button></div>
      <p class="xe-label xe-values-label">Параметры</p><div class="options-list" style="--cell-basis:${Math.min(164,Math.max(85,...p.options.map(v=>49+v.length*6)))}px">${(p.options.length?p.options:['']).map((v,j)=>`<div class="option-line">
      <button type="button" class="star-control" data-default-value="${j}" data-param="${n}" aria-pressed="${!!v&&v===p.defaultValue}" title="По умолчанию" aria-label="По умолчанию · ${E(v)}">${v&&v===p.defaultValue?'★':'☆'}</button>
      <input class="xe-input" data-param-value value="${E(v)}" maxlength="80" placeholder="Параметр" aria-label="Параметр ${j+1}">
      <button type="button" class="remove-control" data-delete-param-value="${j}" data-param="${n}" aria-label="Удалить параметр ${j+1}">×</button></div>`).join('')}</div>
      <div class="param-actions">${addButton('data-add-param-value="'+n+'"','Ещё параметр')}${newVariant}</div></div>`).join('');
  }
  function renameCondition(id,oldValue,newValue){for(const key of Object.keys(draft.variants)){const pairs=JSON.parse(key);if(!pairs.some(pair=>pair[0]===id&&pair[1]===oldValue))continue;const contents=draft.variants[key];delete draft.variants[key];const updated=pairs.map(([pid,value])=>({id:pid,value:pid===id&&value===oldValue?newValue:value}));draft.variants[keyFor(updated)]={...(draft.variants[keyFor(updated)]||{}),...contents};}context.forEach(value=>{if(value.id===id&&value.value===oldValue)value.value=newValue;});contextKey=context.length?keyFor(context):'';}
  function deleteOption(n,j){const p=draft.parameters[n],value=p.options[j];const keys=Object.keys(draft.variants).filter(key=>JSON.parse(key).some(pair=>pair[0]===p.id&&pair[1]===value));const remove=()=>{p.options.splice(j,1);if(p.defaultValue===value)delete p.defaultValue;keys.forEach(key=>delete draft.variants[key]);if(context.some(v=>v.id===p.id&&v.value===value)){context=[];contextKey='';render(root.querySelector('.xe-body').scrollTop);}else refreshParameters();touch();};if(keys.some(key=>Object.keys(draft.variants[key]).length))confirm('Удалить значение?','Отдельное описание для этого значения будет удалено из описания.',remove);else remove();}
  function bundleDialog(index,trigger){const items=clone(effective('muscles')),m=items[index],options=(editorOptions.catalog?DATA.atlasMuscles():DATA.refMuscles(DATA.getCurrentUser())).find(item=>item.name===m.muscle)?.bundles||[];let selected=new Set(m.bundles?.length?m.bundles:Array.isArray(m.bundles)?m.bundles:m.bundle?[m.bundle]:[]);const d=inlinePanel(trigger,m.muscle,'<p class="xe-note">Выберите всю мышцу или один/несколько пучков.</p><div class="xe-bundle-options"></div><div class="xe-dialog-footer"><button type="button" data-done>Готово</button></div>');const draw=()=>d.querySelector('.xe-bundle-options').innerHTML=['',...new Set([...options,...selected])].map(value=>`<button type="button" class="xe-bundle-option" data-bundle="${E(value)}" aria-pressed="${value?selected.has(value):!selected.size}"><span>${E(value||'Вся мышца')}</span><b>${(value?selected.has(value):!selected.size)?'✓':''}</b></button>`).join('');d.querySelector('.xe-bundle-options').onclick=event=>{const button=event.target.closest('[data-bundle]');if(!button)return;const value=button.dataset.bundle;if(!value)selected.clear();else selected.has(value)?selected.delete(value):selected.add(value);draw();};d.querySelector('[data-done]').onclick=()=>{m.bundles=[...selected];m.bundle=m.bundles.join(' · ');setField('muscles',items);refreshKind('muscles');touch();d.close();};draw();}

  function editorHeader(){
    const header=document.createElement('header');
    const action=document.createElement('button');action.type='button';action.dataset.preview='';action.setAttribute('aria-label','Предпросмотр упражнения');action.innerHTML=icon('eye');
    const back=document.createElement('button');back.type='button';back.dataset.close='';back.setAttribute('aria-label','Выйти из редактора');back.innerHTML=icon('back');
    const title=document.createElement('div');title.id='xe-name';title.className='xe-name';title.contentEditable='plaintext-only';title.setAttribute('role','textbox');title.setAttribute('aria-label','Название упражнения');title.dataset.placeholder='Название упражнения';
    const hero=document.createElement('article');hero.className='xd-hero';
    hero.innerHTML='<div class="xd-hero-meta"><span class="header-fields"></span></div>';
    const catalog=!!editorOptions.catalog,meta=hero.firstElementChild;
    meta.querySelector('.header-fields').innerHTML=headerTags(effective('groups'),effective('level'));
    const tabs=libraryTabs(catalog);if(!pendingNew&&!editorOptions.onCreated&&!editorOptions.isCurrent)meta.append(tabs);
    tabs.onclick=e=>{
      const scope=e.target.closest('[data-xd-scope]')?.dataset.xdScope;
      if(!validContext()||pendingNew||!scope||scope===(catalog?'catalog':'mine'))return;
      const nextCatalog=scope==='catalog';
      if(!DATA.libraryExercises(editorUser,nextCatalog).some(ex=>ex.id===draft.id)){
        inlinePanel(tabs,'Источник упражнения','<p>Этой карточки пока нет в выбранной библиотеке.</p>');return;
      }
      const switchLibrary=()=>{const id=draft.id;dispose();setReferenceLibraryScope(scope);openExerciseDetail(id,'exercises',{scope});if(canEditExerciseLibrary(nextCatalog))open(id,{catalog:nextCatalog});};
      collect();if(dirty)confirm('Сменить библиотеку?','Несохранённые изменения будут сброшены.',switchLibrary,tabs);else switchLibrary();
    };
    if(catalog&&!pendingNew){
      const bookmark=document.createElement('button');bookmark.type='button';bookmark.className='xd-membership';
      const update=()=>{const included=!DATA.isHidden(editorUser,draft.id);bookmark.setAttribute('aria-pressed',included);bookmark.setAttribute('aria-label',included?'Убрать из моих':'Добавить в мои');bookmark.innerHTML=exerciseMembershipIcon(included);};
      bookmark.onclick=()=>{if(!validContext())return;toggleExerciseLibrary(draft.id);update();};update();meta.append(bookmark);
    }
    hero.insertAdjacentHTML('beforeend',executionBadges(executionSnapshot(draft.parameters,context)));
    fillCardHeader(header,{back,action,title,name:draft.name,kind:seed?.kind,hero});
    return header;
  }

  function render(scroll=0){
    activePanel?.close(false);root?.remove();root=document.createElement('div');root.className='xe'+(editorOptions.catalog?' from-catalog':'');root.setAttribute('role','dialog');root.setAttribute('aria-modal','true');root.setAttribute('aria-label',pendingNew?'Добавление упражнения':'Редактирование упражнения');root.innerHTML=`
    <main class="xe-body"><form class="xe-form xd-tree" id="xe-form" novalidate>
      <p class="xe-error" data-name-error hidden>Введите название упражнения.</p>
      ${sectionShell('parameters',{editing:true,open:false,attr:'data-parameters',content:'<div data-parameter-rows>'+paramsHtml()+'</div><p class="xe-error" data-param-error hidden></p>'})}
      <div class="context-slot"><button type="button" aria-expanded="false" data-context>${icon('parameters')}<b><span>${E(contextLabel())}</span></b>${icon('down')}</button></div>
      ${classificationRow('groups')}${classificationRow('level')}
      <p class="xe-error" data-cat-error hidden>Выберите группу.</p><p class="xe-error" data-level-error hidden>Выберите тип упражнения.</p>
      ${section('movement',movesHtml())}${section('muscles',musclesHtml())}
      ${descriptionOrder.map(kind=>kind==='additional'?sectionShell(kind,{editing:true,open:false,attr:'data-extra',content:field('Материалы · ссылка','xe-media',effective('media'),'Фото, видео, документ или другая ссылка')+field('Дополнительно','xe-tip',effective('tip'),'Любая дополнительная информация',true)+legacyChoices()}):section(kind,descriptionBody(kind))).join('')}
    </form></main><footer class="xe-footer"><div class="xe-footer-inner"><span class="xe-status"></span><div class="xe-footer-actions"><button class="xe-save" type="button" data-save>${icon('check')}<span>${pendingNew?'Добавить':'Сохранить'}</span></button></div></div><p class="xe-error" data-general-error hidden></p></footer>`;
    root.style.setProperty('--cat-color',groupColor(effective('groups')[0]));root.prepend(editorHeader());document.body.append(root);
    if(!pendingNew){const editor=root;ExerciseDetailPage.mountRemoval(seed,editorReturn.screen==='exerciseDetail'?editorReturn.returnScreen:editorReturn.screen,{container:editor,catalog:!!editorOptions.catalog,isCurrent:()=>root===editor&&editor.isConnected&&validContext(),onRemoved:()=>{dirty=false;dispose();}});}
    form=root.querySelector('form');
    const removeButton=root.querySelector('[data-xd-remove]');if(removeButton){removeButton.append(removeButton.title);form.querySelector('[data-extra] .xd-content').append(removeButton);}
    const scroller=root.querySelector('.xe-body'),slot=form.querySelector('.context-slot'),params=form.querySelector('[data-parameters]');
    const pin=()=>slot.classList.toggle('pinned',params.getBoundingClientRect().bottom+9<=scroller.getBoundingClientRect().top+1);
    scroller.addEventListener('scroll',pin,{passive:true});params.addEventListener('toggle',pin);
    scroller.scrollTop=scroll;pin();touch();
    const name=root.querySelector('#xe-name');
    name.onbeforeinput=e=>{if(e.inputType==='insertParagraph'||e.inputType==='insertLineBreak')e.preventDefault();};
    const changed=()=>{if(!validContext()){dispose();return;}collect();touch();if(draft.name)root.querySelector('[data-name-error]').hidden=true;};
    root.addEventListener('click',event=>{if(!validContext()){event.stopImmediatePropagation();dispose();}},true);
    root.addEventListener('input',e=>{
      if(e.target.matches('[data-move-search]')){
        const more=e.target.closest('details'),q=e.target.value.trim().toLowerCase();
        const options=[...more.querySelectorAll('[data-move-choice]')];options.forEach(b=>b.hidden=!b.dataset.moveChoice.toLowerCase().includes(q));
        more.querySelector('[data-no-moves]').hidden=options.some(b=>!b.hidden);
      }
      changed();
    });root.addEventListener('change',event=>{
      const value=event.target.dataset.groupPriority;
      if(value&&validContext()&&contextKey){
        for(const [key,rule] of Object.entries(draft.variants)){
          if(key!==contextKey&&!event.target.checked)continue;
          if(rule.preferredGroups){rule.preferredGroups=rule.preferredGroups.filter(name=>name!==value);if(!rule.preferredGroups.length)delete rule.preferredGroups;}
        }
        if(event.target.checked)(variant().preferredGroups||=[]).push(value);
      }
      changed();
    });
    
    const body=root.querySelector('.xe-body');
    root.onclick=event=>{if(!validContext()){dispose();return;}const button=event.target.closest('button');if(!button)return;
      if(button.hasAttribute('data-link-source')){collect();linkSource(root.querySelector('[data-legacy-source]').value);return;}
      if(button.hasAttribute('data-unlink')){collect();variant().sources=variant().sources.filter(id=>id!==button.dataset.unlink);render(body.scrollTop);touch();return;}
      if(button.hasAttribute('data-class-value')||button.hasAttribute('data-other-group')){
        const row=button.closest('[data-kind]'),kind=row.dataset.kind,other=button.dataset.otherGroup,value=other||button.dataset.classValue;
        if(kind==='groups'){
          const previous=effective(kind);
          const groups=other?(previous.includes(other)?previous.filter(v=>v!==other):[...previous,other]):[value,...previous.slice(1).filter(v=>v!==value)];
          setField(kind,groups);
          if(contextKey&&variant().preferredGroups){variant().preferredGroups=variant().preferredGroups.filter(g=>groups.includes(g));if(!variant().preferredGroups.length)delete variant().preferredGroups;}
          root.style.setProperty('--cat-color',groupColor(groups[0]));refreshKind('movement');
        }else setField(kind,value);
        root.querySelector('.header-fields').innerHTML=headerTags(effective('groups'),effective('level'));
        row.outerHTML=classificationRow(kind);
        const updated=root.querySelector('[data-kind="'+kind+'"]');
        if(other){updated.open=true;updated.querySelector('.group-placement').open=true;[...updated.querySelectorAll('[data-other-group]')].find(b=>b.dataset.otherGroup===other)?.focus({preventScroll:true});}
        else updated.querySelector('summary').focus({preventScroll:true});
        const key=kind==='level'?'level':'cat';root.querySelector('[data-'+key+'-error]').hidden=true;
        touch();return;
      }
      if(button.hasAttribute('data-pick')){collect();if(activePanel?.trigger===button)activePanel.close();else pickMuscles(button,button.dataset.role);}
      if(button.hasAttribute('data-move-choice')){
        const name=button.dataset.moveChoice,values=effective('movement'),on=values.includes(name);
        setField('movement',on?values.filter(v=>v!==name):[...values,name]);button.setAttribute('aria-pressed',String(!on));
        root.querySelector('[data-count=movement]').textContent=count('movement');touch();
      }
      if(button.hasAttribute('data-default-value')){
        collect();const p=draft.parameters[Number(button.dataset.param)],v=p.options[Number(button.dataset.defaultValue)];
        if(v&&p.defaultValue!==v)p.defaultValue=v;else delete p.defaultValue;
        const opened=[...form.querySelectorAll('.exercise-section[open]')].map(row=>row.dataset.kind);
        const scroll=body.scrollTop;render(scroll);
        for(const kind of opened)form.querySelector('[data-kind="'+kind+'"]').open=true;
        root.querySelector('.xe-body').scrollTop=scroll;touch();return;
      }
      if(button.hasAttribute('data-context')){collect();if(activePanel?.trigger===button)activePanel.close();else contextDialog(button);}
      if(button.hasAttribute('data-edit-bundles')){collect();if(activePanel?.trigger===button)activePanel.close();else bundleDialog(Number(button.dataset.editBundles),button);}if(button.hasAttribute('data-add-param-value')){collect();draft.parameters[Number(button.dataset.addParamValue)].options.push('');refreshParameters();touch();}if(button.hasAttribute('data-delete-param-value')){collect();deleteOption(Number(button.dataset.param),Number(button.dataset.deleteParamValue));}
      if(button.hasAttribute('data-close'))closeEditor();
      if(button.hasAttribute('data-save'))save();
      if(button.hasAttribute('data-preview'))preview(false);
      if(button.hasAttribute('data-add-error'))mutate('mistakes',v=>v.push({problem:'',correction:''}));
      if(button.hasAttribute('data-add-feature'))mutate('features',v=>v.push(''));
      for(const [attr,kind] of [['error','mistakes'],['feature','features'],['muscle','muscles'],['move','movement']])if(button.hasAttribute('data-delete-'+attr))mutate(kind,v=>v.splice(Number(button.dataset['delete'+attr[0].toUpperCase()+attr.slice(1)]),1));
      if(button.hasAttribute('data-preset')){collect();draft.parameters.push({id:crypto.randomUUID(),name:'',options:['']});refreshParameters();form.querySelector('[data-param-row]:last-child [data-param-name]')?.focus();touch();}
      if(button.hasAttribute('data-delete-param')){collect();const id=draft.parameters[Number(button.dataset.deleteParam)].id;const used=Object.keys(draft.variants).some(k=>JSON.parse(k).some(pair=>pair[0]===id));const remove=()=>{draft.parameters.splice(Number(button.dataset.deleteParam),1);for(const k of Object.keys(draft.variants))if(JSON.parse(k).some(pair=>pair[0]===id))delete draft.variants[k];if(context.some(v=>v.id===id)){context=[];contextKey='';render(body.scrollTop);}else refreshParameters();touch();};if(used)confirm('Удалить параметр?','Его отдельные описания тоже будут удалены из описания.',remove);else remove();}
    };
    form.onsubmit=event=>{event.preventDefault();save();};root.onkeydown=event=>{if(event.key==='Tab'){const targets=[...root.querySelectorAll('button,input,textarea,select,summary')].filter(el=>!el.disabled&&el.type!=='hidden'&&el.getClientRects().length&&!el.closest('[inert]'));const first=targets[0],last=targets.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}if(event.key==='Escape'&&!document.querySelector('dialog[open]')){event.preventDefault();if(activePanel)activePanel.close();else closeEditor();}};
  }
  function collect(){
    if(!form)return;const value=id=>root.querySelector('#'+id)?.value||'';draft.name=root.querySelector('#xe-name').innerText.replace(/\s*\n+\s*/g,' ').trim();
    if(pendingNew)draft.format='strength';
    for(const [key,id] of [['media','xe-media'],['tip','xe-tip']])if(value(id)!==effective(key))setField(key,value(id));
    form.querySelectorAll('[data-param-row]').forEach((row,n)=>{draft.parameters[n].name=row.querySelector('[data-param-name]').value;const next=[...row.querySelectorAll('[data-param-value]')].map(input=>input.value);next.forEach((value,j)=>{const old=draft.parameters[n].options[j];if(old&&old!==value){renameCondition(draft.parameters[n].id,old,value);if(draft.parameters[n].defaultValue===old)draft.parameters[n].defaultValue=value;}});draft.parameters[n].options=next;});
    const fields={technique:value('xe-technique'),restrictions:value('xe-restrictions'),
      mistakes:[...form.querySelectorAll('[data-entry="mistakes"]')].map((_,i)=>({problem:value('xe-error-'+i),correction:value('xe-fix-'+i)})),
      features:[...form.querySelectorAll('[data-entry="features"]')].map((_,i)=>value('xe-feature-'+i))};
    for(const [kind,next] of Object.entries(fields)){
      if(JSON.stringify(effective(kind))!==JSON.stringify(next))setField(kind,next);
      const label=form.querySelector('[data-count="'+kind+'"]');if(label)label.textContent=count(kind);
    }
    context.forEach(v=>{v.name=draft.parameters.find(p=>p.id===v.id)?.name||v.name;});
    form.querySelector('[data-context] b span').textContent=contextLabel();
    const hero=root.querySelector('.xd-hero');
    const badges=hero.querySelectorAll('.execution-badge');
    if(context.some((v,i)=>badges[i]?.textContent!==v.value)||badges.length!==context.length){
      badges.forEach(b=>b.remove());hero.insertAdjacentHTML('beforeend',executionBadges(executionSnapshot(draft.parameters,context)));
    }
  }
  function contextLabel(){return context.length?context.map(v=>v.name+' · '+v.value).join(' / '):'Общее описание';}
  function refreshParameters(){root.querySelector('[data-parameter-rows]').innerHTML=paramsHtml();root.querySelector('[data-param-error]').hidden=true;}
  function descriptionBody(kind){
    if(kind==='technique')return field('Техника выполнения','xe-technique',effective(kind),'Каждый шаг с новой строки',true);
    if(kind==='restrictions')return field('Ограничения','xe-restrictions',effective(kind),'Укажите ограничения, если они есть',true);
    return kind==='features'?featuresHtml():errorsHtml();
  }
  function refreshKind(kind){
    const el=root.querySelector('[data-kind="'+kind+'"]');
    const content=kind==='movement'?movesHtml():kind==='muscles'?musclesHtml():descriptionBody(kind);
    el.outerHTML=section(kind,content,el.open);
  }
  function mutate(kind,fn){collect();const items=clone(effective(kind));fn(items);setField(kind,items);refreshKind(kind);touch();}
  let activePanel=null;
  function inlinePanel(trigger,title,html){
    if(!trigger?.closest||!root.contains(trigger))trigger=root.querySelector('[data-save]');
    if(activePanel)activePanel.close(false);
    const panel=document.createElement('section');panel.className='inline-panel';panel.setAttribute('aria-label',title);
    panel.innerHTML=`<div class="inline-panel-head"><strong>${E(title)}</strong><button type="button" data-panel-close aria-label="Свернуть">×</button></div>${html}`;
    const host=trigger.closest('.context-slot,.xe-role-field,.xe-role-muscle,.xe-param-row,.xd-content,.xe-footer,.card-header')||root.querySelector('form');
    host.append(panel);activePanel=panel;panel.trigger=trigger;trigger.setAttribute('aria-expanded','true');
    panel.close=(focus=true)=>{panel.remove();panel.trigger.setAttribute('aria-expanded','false');if(activePanel===panel)activePanel=null;if(focus&&panel.trigger.isConnected)panel.trigger.focus({preventScroll:true});};
    panel.querySelector('[data-panel-close]').onclick=()=>panel.close();
    panel.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();panel.close();}};
    return panel;
  }
  function confirm(title,text,callback,trigger=document.activeElement){
    const d=inlinePanel(trigger||root.querySelector('.xe-footer button'),title,`<p>${E(text)}</p><div class="inline-actions"><button type="button" data-no>Остаться</button><button type="button" data-yes>Продолжить</button></div>`);
    d.querySelector('[data-no]').onclick=()=>d.close();d.querySelector('[data-yes]').onclick=()=>{d.close();callback();};
  }
  function pickMuscles(trigger,role){
    const all=editorOptions.catalog?DATA.atlasMuscles():DATA.refMuscles(editorUser);
    const panel=inlinePanel(trigger,roles.find(([id])=>id===role)[1],
      '<input type="search" class="xe-input" placeholder="Найти мышцу" aria-label="Поиск мышцы"><div class="muscle-filters"></div><div class="option-grid muscle-choices"></div><p class="xe-note" data-empty hidden>Ничего не найдено</p>');
    let group=effective('groups')[0]||'';
    const search=panel.querySelector('input'),filters=panel.querySelector('.muscle-filters'),choices=panel.querySelector('.muscle-choices');
    function draw(){
      const query=search.value.trim().toLocaleLowerCase('ru'),current=effective('muscles');
      filters.innerHTML=['',...new Set(all.map(m=>m.group).filter(Boolean))].map(g=>`<button type="button" data-filter="${E(g)}" aria-pressed="${group===g}">${E(g||'Все')}</button>`).join('');
      const list=all.filter(m=>query?m.name.toLocaleLowerCase('ru').includes(query):!group||m.group===group);
      choices.innerHTML=list.map(m=>{
        const existing=current.find(item=>item.muscle===m.name),unavailable=existing&&visibleRole(existing)!==role;
        return `<button type="button" data-muscle="${E(m.name)}" aria-pressed="${existing&&visibleRole(existing)===role}" ${unavailable?'disabled':''}>${E(m.name)}${unavailable?`<small>${E(roles.find(([id])=>id===visibleRole(existing))?.[1]||'')}</small>`:''}</button>`;
      }).join('');
      panel.querySelector('[data-empty]').hidden=!!list.length;
    }
    search.oninput=draw;
    filters.onclick=e=>{const b=e.target.closest('[data-filter]');if(b){group=b.dataset.filter;search.value='';draw();}};
    choices.onclick=e=>{
      const b=e.target.closest('[data-muscle]');if(!b||b.disabled)return;
      const name=b.dataset.muscle,current=effective('muscles'),wasSelected=current.some(m=>visibleRole(m)===role&&m.muscle===name);
      const next=wasSelected?current.filter(m=>m.muscle!==name):[...current,{muscle:name,role,bundle:'',bundles:[]}];
      setField('muscles',next);touch();
      // Refresh the selected muscles while keeping the expanded selector in place.
      refreshKind('muscles');
      const nextTrigger=root.querySelector('[data-pick="muscles"][data-role="'+role+'"]');
      nextTrigger.closest('.xe-role-field').append(panel);nextTrigger.setAttribute('aria-expanded','true');panel.trigger=nextTrigger;
      draw();[...choices.children].find(option=>option.dataset.muscle===name)?.focus({preventScroll:true});
    };
    draw();
  }
  function validateParameters(){const values=draft.parameters;if(values.some(p=>!p.name.trim()||!p.options.length||p.options.some(value=>!value.trim())))return 'Укажите название варианта выполнения и заполните его параметры.';if(new Set(values.map(p=>p.name.trim().toLowerCase())).size!==values.length)return 'Названия вариантов выполнения должны быть разными.';if(values.length>12||values.some(p=>p.options.length>20||p.name.length>80||p.options.some(o=>o.length>80)))return 'До 12 параметров; до 20 вариантов длиной не более 80 символов.';if(values.some(p=>new Set(p.options.map(value=>value.trim().toLowerCase())).size!==p.options.length))return 'Параметры одного варианта не должны повторяться.';return '';}
  function contextDialog(trigger){
    const error=validateParameters();if(error){root.querySelector('[data-parameters]').open=true;const message=root.querySelector('[data-param-error]');message.hidden=false;message.textContent=error;root.querySelector('[data-parameters]').scrollIntoView({block:'start'});return;}
    if(!draft.parameters.length){root.querySelector('[data-parameters]').open=true;root.querySelector('[data-parameters]').scrollIntoView({block:'start'});root.querySelector('[data-preset="custom"]').focus();return;}
    const quickOptions=draft.parameters.map((p,i)=>`<fieldset><legend>${E(p.name)}</legend><div class="execution-options">${p.options.map((v,j)=>`<button type="button" data-quick-param="${i}" data-option="${j}" aria-pressed="${context.length===1&&context[0].id===p.id&&context[0].value===v}">${E(v)}</button>`).join('')}</div></fieldset>`).join('');
    const combinations=draft.parameters.length>1?`<details class="context-combination"><summary>Сочетание параметров${icon('down')}</summary>${draft.parameters.map((p,i)=>`<fieldset><legend>${E(p.name)}</legend><div class="execution-options">${p.options.map((v,j)=>`<button type="button" data-combo="${i}" data-opt="${j}" aria-pressed="${context.some(c=>c.id===p.id&&c.value===v)}">${E(v)}</button>`).join('')}</div></fieldset>`).join('')}<button type="button" data-combo-apply>Выбрать сочетание</button></details>`:'';
    const d=inlinePanel(trigger,'Выбрать описание',`<div class="context-choices"><button type="button" data-base aria-pressed="${!contextKey}">Общее описание</button>${quickOptions}${combinations}</div>`);
    function apply(pairs){
      const body=root.querySelector('.xe-body'),previous=body.scrollTop;
      const opened=[...root.querySelectorAll('.exercise-section[open]')].map(el=>el.dataset.kind);
      context=executionSnapshot(draft.parameters,pairs).executionValues;
      contextKey=context.length?keyFor(context):'';d.close();render(previous);
      for(const id of opened){
        const el=root.querySelector('[data-kind="'+id+'"]');if(el)el.open=true;
      }
      root.querySelector('.xe-body').scrollTop=previous;
      root.querySelector('[data-context]').focus({preventScroll:true});
    }
    d.querySelector('[data-base]').onclick=()=>apply([]);
    d.querySelectorAll('[data-quick-param]').forEach(button=>button.onclick=()=>{
      const p=draft.parameters[Number(button.dataset.quickParam)];apply([{id:p.id,value:p.options[Number(button.dataset.option)]}]);
    });
    const combo=d.querySelector('[data-combo-apply]');
    if(combo){
      d.querySelector('.context-combination').addEventListener('click',event=>{
        const option=event.target.closest('[data-combo]');if(!option)return;
        const select=option.getAttribute('aria-pressed')!=='true';
        for(const sibling of option.parentElement.children)sibling.setAttribute('aria-pressed',String(select&&sibling===option));
      });
      combo.onclick=()=>apply([...d.querySelectorAll('[data-combo][aria-pressed=true]')].map(option=>{
        const p=draft.parameters[Number(option.dataset.combo)];return {id:p.id,value:p.options[Number(option.dataset.opt)]};
      }));
    }
  }
  function validate(){collect();
    if(contextKey&&(!draft.cat.trim()||!draft.level.trim())){context=[];contextKey='';render(root.querySelector('.xe-body').scrollTop);}
    let first=null;for(const [key,element] of [['name',root.querySelector('#xe-name')],['cat',form.querySelector('[data-kind=groups]>summary')],['level',form.querySelector('[data-kind=level]>summary')]]){
      const invalid=!draft[key].trim();element.classList.toggle('xe-invalid',invalid);root.querySelector('[data-'+key+'-error]').hidden=!invalid;
      if(invalid&&!first)first=element;
    }if(first){first.focus();first.scrollIntoView({block:'center'});return false;}
    const parameterError=validateParameters();if(parameterError){const block=root.querySelector('[data-parameters]');block.open=true;const error=root.querySelector('[data-param-error]');error.hidden=false;error.textContent=parameterError;block.scrollIntoView({block:'center'});return false;}
    const general=root.querySelector('[data-general-error]');general.hidden=true;
    if(draft.name.length>180){const error=root.querySelector('[data-name-error]');error.textContent='До 180 символов в названии.';error.hidden=false;root.querySelector('#xe-name').focus();return false;}
    if(Object.values(draft.variants).some(rule=>Array.isArray(rule.groups)&&!rule.groups.length)){general.textContent='Выберите группу выполнения или уберите отличие от базовой группы.';general.hidden=false;return false;}
    const conflict=ExerciseDescriptions.conflictingCombination(draft.variants,draft.parameters);
    if(conflict){
      context=conflict.values;contextKey=keyFor(context);
      render(root.querySelector('.xe-body').scrollTop);
      const kind=['media','tip'].includes(conflict.kind)?'additional':conflict.kind;
      const error=root.querySelector('[data-general-error]'),section=root.querySelector('[data-kind="'+kind+'"]');
      error.textContent='Уточните раздел «'+titles[conflict.kind]+'» для сочетания '+context.map(v=>v.value).join(' · ')+'.';
      error.hidden=false;if(section){section.open=true;section.scrollIntoView({block:'center'});}return false;
    }
    // Complete pairs only: blank placeholder cards do not leak into the detail page.
    for(const description of [draft.base,...Object.values(draft.variants)])if(description.mistakes?.some(m=>!m.problem.trim()&&m.correction.trim())){general.textContent='Заполните текст ошибки, к которой добавлено исправление.';general.hidden=false;root.querySelector('[data-kind="mistakes"]').open=true;return false;}
    return true;
  }
  function toExercise(){
    const ex=clone(draft.original),a=ex.atlas||={};ex.id=draft.id;ex.name=draft.name.trim();ex.cat=draft.cat;ex.type=draft.format;ex.media=draft.extra.media.trim();ex.tip=draft.extra.tip;
    a.level=({'Глобальное':'global','Региональное':'regional','Локальное':'local'})[draft.level]||draft.level;a.executionParameters=normalizeExecutionParameters(draft.parameters);a.executionDescriptions={...a.executionDescriptions,version:1,variants:JSON.parse(serialized(draft)).variants};
    a.categories=clone(draft.base.movement);for(const role of ['target','synergist','stabilizer'])a[role]=draft.base.muscles.filter(m=>m.role===role).map(({role,...m})=>({...clone(m),bundles:clone(m.bundles||[]),bundle:m.bundles?.length?m.bundles.join(' · '):m.bundle||''}));
    a.technique=draft.base.technique.trim();ex.steps=a.technique.split('\n').map(s=>s.trim()).filter(Boolean);a.mistakeDetails=draft.base.mistakes.filter(m=>m.problem.trim()).map(m=>({problem:m.problem.trim(),correction:m.correction.trim()}));a.mistakes=a.mistakeDetails.map(m=>m.problem+(m.correction?' Исправление: '+m.correction:''));
    a.features=draft.base.features.map(t=>t.trim()).filter(Boolean);a.differences=a.features[0]||'';a.extra=a.features.slice(1).join('\n\n');a.contraindications=draft.base.restrictions;a.equipment=draft.extra.equipment;a.referenceUrl=draft.extra.reference;return ex;
  }
  function endPreview(){
    document.querySelector('.xe-preview-ribbon')?.remove();$('exd-back-btn').removeEventListener('click',previewBack,true);previewReturn=false;
    if(root){root.hidden=false;if(validContext()&&editorReturn.screen&&SCREENS[editorReturn.screen])goToScreen(editorReturn.screen,{instant:true});}
  }
  function previewBack(event){event.preventDefault();event.stopImmediatePropagation();endPreview();}
  function preview(){
    if(!validContext()||!validate())return;previewEx=toExercise();root.hidden=true;previewReturn=true;
    const show=values=>openExerciseDetail(draft.id,editorReturn.screen||'exercises',{previewExercise:previewEx,scope:editorOptions.catalog?'catalog':'mine',executionSnapshot:values,onExecutionChange:show});
    show(executionSnapshot(draft.parameters,context));
    $('exd-back-btn').addEventListener('click',previewBack,true);
    const ribbon=document.createElement('div');ribbon.className='xe-preview-ribbon';ribbon.classList.toggle('from-catalog',!!editorOptions.catalog);ribbon.innerHTML='<p>Предпросмотр</p><button type="button">Вернуться к форме</button>';ribbon.querySelector('button').onclick=endPreview;document.body.append(ribbon);
    $('screen-exercise-detail').querySelectorAll('[data-reference-kind],[data-xd-group]').forEach(button=>button.disabled=true);
  }
  function dispose(){
    activePanel?.close(false);if(previewReturn)endPreview();root?.remove();root=null;form=null;document.querySelectorAll('.xe-dialog,.xe-preview-ribbon').forEach(el=>el.remove());
  }
  async function save(){
    if(!validContext()||!validate())return;const editor=root,button=editor.querySelector('[data-save]');if(button.disabled)return;const ex=toExercise();button.disabled=true;editor.inert=true;
    const payload={name:ex.name,type:ex.type,cat:ex.cat,media:ex.media,tip:ex.tip,atlas:ex.atlas};
    try{
      let id=draft.id;
      if(editorOptions.catalog){
        if(pendingNew)id='ae_'+crypto.randomUUID();
        await saveSharedExercises([{id,patch:payload,create:pendingNew}]);
      }else if(pendingNew){id=DATA.addExercise(editorUser,payload).id;SyncQueue.push('exercise:create',{id,name:ex.name});}
      else{if(!DATA.updateOwnExercise(editorUser,id,payload))throw Error('Упражнение больше недоступно');SyncQueue.push('exercise:update',{id});}
      if(root!==editor)return;
      if(!validContext()){dispose();return;}
      _executionDrafts.set(executionDraftKey(editorUser,id),executionSnapshot(ex.atlas.executionParameters,context));
      const wasNew=pendingNew,onCreated=editorOptions.onCreated;dirty=false;dispose();showToast(wasNew?'Упражнение добавлено':'Упражнение обновлено');
      if(wasNew&&onCreated){onCreated(id);return;}
      renderExercisesList(exercisesSearch.value);
      if(editorReturn.screen==='exerciseDetail'||wasNew)openExerciseDetail(id,editorReturn.screen==='exerciseDetail'?editorReturn.returnScreen:editorReturn.screen==='exerciseReference'?'exerciseReference':'exercises',{scope:editorOptions.catalog?'catalog':'mine'});
      else if(editorReturn.screen==='exerciseReference')renderExerciseReference();
    }catch(error){if(root===editor){const message=root.querySelector('[data-general-error]');message.textContent='Ошибка сохранения: '+error.message;message.hidden=false;}}finally{editor.inert=false;button.disabled=false;}
  }
  function closeEditor(){collect();const close=()=>{const {screen,exerciseId,returnScreen,scope}=editorReturn;dispose();if(screen==='exerciseDetail'&&exerciseId)openExerciseDetail(exerciseId,returnScreen,{scope,executionSnapshot:editorReturn.snapshot});};if(dirty)confirm('Выйти без сохранения?','Несохранённые изменения формы будут сброшены.',close);else close();}
  function open(exerciseId,options={}){
    if(!canEditExerciseLibrary(options.catalog))return;
    const user=DATA.getCurrentUser(),source=DATA.libraryExercises(user,options.catalog),ex=exerciseId?source.find(e=>e.id===exerciseId):null;if(exerciseId&&!ex)return;
    dispose();editorOptions={...options};editorOwner=Auth.userId();editorUser=user;
    const active=Object.entries(SCREENS).find(([,element])=>element.classList.contains('active'))?.[0]||'exercises';
    editorReturn={screen:active,exerciseId:_detailExerciseId,returnScreen:_exdReturnScreen,scope:_exdCatalog?'catalog':'mine'};
    const shown=ex&&active==='exerciseDetail'&&ExerciseDetailPage.currentExecution(ex.id,!!options.catalog,user);
    editorReturn.snapshot=shown||null;
    seed=ex;pendingNew=!ex;context=ex?(shown||executionForExercise(user,ex)).executionValues:[];contextKey=context.length?keyFor(context):'';draft=ex?fromExercise(ex):newDraft();if(!ex)draft.cat=options.cat||'';
    baseline=serialized(draft);dirty=false;render();
    const detail=$('screen-exercise-detail'),reader=$('exd-body');
    if(active==='exerciseDetail')for(const row of detail.querySelectorAll('.exercise-section[open],section.exercise-section')){
      const matching=root.querySelector('[data-kind="'+row.dataset.sectionKind+'"]');if(matching)matching.open=true;
    }
    if(active==='exerciseDetail'&&reader.scrollTop>0){
      const edge=reader.getBoundingClientRect().top;
      const visible=[...reader.querySelectorAll('.exercise-section')].find(el=>el.getBoundingClientRect().bottom>edge+12);
      const match=visible&&root.querySelector('[data-kind="'+visible.dataset.sectionKind+'"]');
      if(match){const body=root.querySelector('.xe-body');body.scrollTop+=match.getBoundingClientRect().top-body.getBoundingClientRect().top-Math.max(0,visible.getBoundingClientRect().top-edge);}
    }
    if(options.focus==='parameters')root.querySelector('[data-parameters]').open=true;
  }
  window.addEventListener("train-auth-context-changed",dispose);
  window.ExerciseEditor={open,dispose};
})();
