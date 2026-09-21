/* Screen and overlay accessibility, shared by static and dynamic UI. */
const UX = (() => {
  const overlaySelector='.modal-backdrop,.picker-backdrop,.bottom-sheet-backdrop,.stats-picker-backdrop';
  let lastScreen=null,lastOverlay=null,restoreFocus=null,isolated=new Set(),serial=0;
  const name=(el,label)=>{if(!el.getAttribute('aria-label')&&!el.getAttribute('aria-labelledby'))el.setAttribute('aria-label',label);};
  function sync(){
    for(const el of isolated)el.inert=false;isolated.clear();
    const screen=document.querySelector('.screen.active');
    for(const el of document.querySelectorAll('.screen')){el.inert=el!==screen;el.setAttribute('aria-hidden',String(el!==screen));name(el,({ 'screen-menu':'Главная','screen-profile':'Профили','screen-exercises':'Упражнения','screen-workout':'Тренировка','screen-run':'Пробежка','screen-detail':'История тренировки','screen-constructor':'Конструктор','screen-templates':'Шаблоны','screen-stats':'Статистика'})[el.id]||'Раздел приложения');}
    const open=[...document.querySelectorAll(overlaySelector)].filter(el=>el.classList.contains('open')).sort((a,b)=>(parseInt(getComputedStyle(a).zIndex)||0)-(parseInt(getComputedStyle(b).zIndex)||0));
    const native=document.querySelector('dialog[open]'),top=native||open.at(-1)||null;
    for(const el of document.querySelectorAll(overlaySelector)){
      const visible=el===top;el.inert=!visible;el.setAttribute('aria-hidden',String(!visible));
      el.setAttribute('role','dialog');el.setAttribute('aria-modal',String(visible));
      name(el,el.querySelector('h1,h2,.modal-title')?.textContent.trim()||'Выбор');
    }
    if(top){let branch=top;while(branch.parentElement&&branch!==document.body){for(const sibling of branch.parentElement.children)if(sibling!==branch&&!['SCRIPT','STYLE','LINK'].includes(sibling.tagName)){sibling.inert=true;isolated.add(sibling);}branch=branch.parentElement;}}
    for(const el of document.querySelectorAll('button[id$="back-btn"]'))name(el,'Назад');
    const names={'run-dur-h':'Время бега: часы','run-dur-m':'Время бега: минуты','run-dur-s':'Время бега: секунды','run-distance':'Дистанция, км','run-cadence':'Каденс, шагов в минуту','run-hr':'Средний пульс, ударов в минуту','workout-name-input':'Название тренировки','auth-email':'Email','auth-password':'Пароль','auth-name':'Имя','exercises-search':'Поиск упражнения','picker-search':'Поиск упражнения для тренировки'};
    for(const [id,label]of Object.entries(names)){const el=document.getElementById(id);if(el)name(el,label);}
    for(const field of document.querySelectorAll('.ex-form-field')){
      const label=field.querySelector('label'),input=field.querySelector('input,textarea,select');
      if(label&&input){if(!input.id)input.id='ux-field-'+(++serial);label.htmlFor=input.id;}
      for(const trigger of field.querySelectorAll('.ef-dd-trigger'))if(label)trigger.setAttribute('aria-label',label.textContent.trim()+': '+trigger.textContent.trim());
    }
    for(const chip of document.querySelectorAll('.ex-form-chip'))chip.setAttribute('aria-pressed',String(chip.classList.contains('selected')));
    if(top!==lastOverlay){
      if(top){if(!lastOverlay)restoreFocus=document.activeElement;if(!top.contains(document.activeElement)){top.tabIndex=-1;(top.querySelector('input:not(:disabled),button:not(:disabled),[href]')||top).focus({preventScroll:true});}}
      else if(restoreFocus?.isConnected&&!restoreFocus.closest('[inert]'))restoreFocus.focus({preventScroll:true});
      else if(screen){screen.tabIndex=-1;screen.focus({preventScroll:true});}
      lastOverlay=top;
    }
    if(screen!==lastScreen){lastScreen=screen;if(screen&&!top){screen.tabIndex=-1;screen.focus({preventScroll:true});}}
  }
  function context(label){
    try{const owner=Auth.userId(),profile=JSON.parse(localStorage.getItem('train_current_user')||'null');if(owner&&profile)localStorage.setItem('train_ui_context_'+JSON.stringify([owner,profile]),label);}catch{}
    for(const id of ['screen-menu','screen-workout','screen-run','screen-detail','screen-constructor']){
      const screen=document.getElementById(id);if(!screen)continue;
      let bar=screen.querySelector('.profile-context');if(!bar){bar=document.createElement('p');bar.className='profile-context';screen.prepend(bar);}
      if(bar.textContent!==label)bar.textContent=label;
    }
  }
  new MutationObserver(sync).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','open']});
  try{const owner=Auth.userId(),profile=JSON.parse(localStorage.getItem('train_current_user')||'null');if(owner&&profile&&localStorage.getItem('train_current_owner')===owner)context(localStorage.getItem('train_ui_context_'+JSON.stringify([owner,profile]))||('Профиль: '+profile));}catch{}
  sync();return {sync,context};
})();
