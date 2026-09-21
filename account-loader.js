// Same exclusive lease as restore: no application writers or automatic flush.
window.TRAIN_RESTORE_MODE=true;
document.getElementById('reload').onclick=()=>location.reload();
(async()=>{
  if(!navigator.locks?.request)throw Error('Нужен браузер с Web Locks. Данные не изменены.');
  await navigator.locks.request('train-app-lifetime',{mode:'exclusive',ifAvailable:true},async lock=>{
    if(!lock)throw Error('Закройте другие вкладки приложения и повторите проверку.');
    window.TRAIN_ACCOUNT_LOCK=true;
    const journal=JSON.parse(localStorage.getItem('train_import_journal')||'null');
    if(journal&&!['complete','rolled-back'].includes(journal.phase))throw Error('Сначала завершите восстановление резервной копии.');
    for(const src of ['config.js','auth.js','db.js','backup-core.js','restore-core.js','account-safety.js','outbox.js','account-ui.js'])await new Promise((resolve,reject)=>{
      const script=document.createElement('script');script.src=src;script.onload=resolve;script.onerror=()=>reject(Error('Не удалось загрузить '+src));document.body.append(script);
    });
    await new Promise(resolve=>window.addEventListener('pagehide',()=>{window.TRAIN_ACCOUNT_LOCK=false;resolve();},{once:true}));
  });
})().catch(error=>document.getElementById('status').textContent=error.message);
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
