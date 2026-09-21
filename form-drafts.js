/* Persist input, not executable markup. Drafts never save domain entities. */
const FormDrafts = (() => {
  const cleanups=new Map();
  if(typeof MutationObserver!=='undefined')new MutationObserver(()=>{
    for(const [root,dispose] of cleanups)if(!root.isConnected)dispose();
  }).observe(document.body,{childList:true,subtree:true});
  let storageFailures=0;document.addEventListener('storage-full',()=>storageFailures++);
  function bind(root,identity,controllers={}){
    cleanups.get(root)?.();
    const owner=Auth.userId(),profile=DATA.getCurrentUser();
    const key='train_form_draft_'+JSON.stringify([owner,profile,identity]);
    const guard=()=>Auth.userId()===owner&&DATA.getCurrentUser()===profile;
    let stopped=false,disposed=false,lastRaw=null;const initialFailures=storageFailures;
    try{lastRaw=localStorage.getItem(key);}catch{stopped=true;}
    const note=document.createElement('p');note.className='form-draft-note';note.setAttribute('role','status');(root.querySelector('.modal')||root.querySelector('[data-draft-body]')||root).prepend(note);
    if(stopped)note.textContent='Хранилище недоступно. Черновик не сохраняется; скопируйте ввод перед закрытием.';
    function capture(){return {version:1,fields:Object.fromEntries([...root.querySelectorAll('input[id],textarea[id],select[id]')].filter(e=>!['password','file'].includes(e.type)).map(e=>[e.id,e.type==='checkbox'?e.checked:e.value])),controls:Object.fromEntries(Object.entries(controllers).map(([id,c])=>[id,c.get()]))};}
    function write(){if(disposed||stopped||!root.isConnected)return;try{if(!guard())return;
      if(localStorage.getItem(key)!==lastRaw){stopped=true;note.textContent='Черновик изменён в другой вкладке. Эта форма больше не перезаписывает его; скопируйте введённый текст.';return;}
      const raw=JSON.stringify(capture());localStorage.setItem(key,raw);if(localStorage.getItem(key)!==raw)throw Error('write');lastRaw=raw;note.textContent='Черновик сохранён на этом устройстве. Закрытие формы его не удаляет.';
    }catch{note.textContent='Не удалось сохранить черновик. Не закрывайте страницу; скопируйте введённый текст.';}}
    if(lastRaw){try{
      const draft=JSON.parse(lastRaw);if(draft.version!==1||!draft.fields||!draft.controls)throw Error('format');
      if(confirm('Восстановить сохранённый черновик этой формы?')){
        for(const el of root.querySelectorAll('input[id],textarea[id],select[id]'))if(Object.hasOwn(draft.fields,el.id)&&!['password','file'].includes(el.type)){if(el.type==='checkbox')el.checked=draft.fields[el.id]===true;else if(typeof draft.fields[el.id]==='string')el.value=draft.fields[el.id];}
        for(const [id,c]of Object.entries(controllers))if(Object.hasOwn(draft.controls,id))c.set(draft.controls[id]);
        note.textContent='Черновик восстановлен. Проверьте поля перед сохранением.';
      }else{stopped=true;note.textContent='Старый черновик оставлен без изменений. Новая форма не перезаписывает его.';}
    }catch{stopped=true;note.textContent='Черновик повреждён; он сохранён без изменений.';}}
    const deferredWrite=()=>queueMicrotask(write);
    const onStorage=event=>{
      if(disposed||stopped||(event.key!==key&&event.key!==null))return;
      try{if(localStorage.getItem(key)!==lastRaw){stopped=true;note.textContent='Черновик изменён в другой вкладке. Эта форма больше не перезаписывает его; скопируйте введённый текст.';}}catch{stopped=true;note.textContent='Хранилище недоступно. Скопируйте введённый текст перед закрытием.';}
    };
    if(typeof window!=='undefined')window.addEventListener('storage',onStorage);
    root.addEventListener('input',write);root.addEventListener('change',write);
    root.addEventListener('click',deferredWrite,true);root.addEventListener('keydown',deferredWrite,true);
    function dispose(){disposed=true;cleanups.delete(root);if(typeof window!=='undefined')window.removeEventListener('storage',onStorage);root.removeEventListener('input',write);root.removeEventListener('change',write);root.removeEventListener('click',deferredWrite,true);root.removeEventListener('keydown',deferredWrite,true);note.remove();}
    cleanups.set(root,dispose);
    return {dispose,clear(){try{if(disposed||!guard()||stopped||storageFailures!==initialFailures)return;if(localStorage.getItem(key)===lastRaw)localStorage.removeItem(key);stopped=true;if(typeof window!=='undefined')window.removeEventListener('storage',onStorage);}catch{if(typeof showToast==='function')showToast('Запись сохранена, но старый черновик не удалось удалить.');}}};
  }
  return {bind};
})();
