window.TRAIN_RESTORE_MODE=true;
document.getElementById("reload").onclick=()=>location.reload();
(async()=>{
  const status=document.getElementById("status");
  if(!navigator.locks?.request){status.textContent="В этом браузере нет Web Locks. Восстановление недоступно; данные не изменены.";return;}
  await navigator.locks.request("train-app-lifetime",{mode:"exclusive",ifAvailable:true},async lock=>{
    if(!lock){status.textContent="Приложение открыто в другой вкладке. Закройте её и нажмите «Повторить проверку». Данные не изменены.";return;}
    window.TRAIN_RESTORE_LOCK=true;
    for(const src of ["config.js","auth.js","db.js","backup-core.js","restore-journal.js","restore-core.js","outbox.js","restore-ui.js"]){
      await new Promise((resolve,reject)=>{const script=document.createElement("script");script.src=src;script.onload=resolve;script.onerror=()=>reject(Error("Не удалось загрузить "+src));document.body.append(script);});
    }
    await new Promise(resolve=>window.addEventListener("pagehide",()=>{window.TRAIN_RESTORE_LOCK=false;resolve();},{once:true}));
  });
})().catch(error=>{document.getElementById("status").textContent=error.message;});
window.addEventListener("pageshow",event=>{if(event.persisted)location.reload();});
