// Hold a shared lifetime lease before ANY application scripts can write data.
// Restore uses an exclusive lease on a separate page with no DATA/Bridge boot.
(() => {
  const scripts = ["config.js","lib.js","atlas-seed.js","muscle-anatomy.js","auth.js","db.js","backup-core.js","account-safety.js","app.js","constructor.js","outbox.js","syncengine.js","bridge.js","auth-ui.js"];
  function notice(message, restore = false) {
    const panel = document.createElement("dialog");
    panel.style.cssText="padding:24px;max-width:420px;color:white;background:#11111c;border-radius:20px";
    const text=document.createElement("p");text.textContent=message;panel.append(text);
    const button=document.createElement("button");button.textContent=restore?"Открыть восстановление":"Повторить";
    button.onclick=()=>restore?location.assign("restore.html"):location.reload();panel.append(button);
    panel.addEventListener("cancel",e=>e.preventDefault());document.body.append(panel);panel.showModal();
  }
  async function boot() {
    try {
      const raw=localStorage.getItem("train_import_journal");
      if(raw){const journal=JSON.parse(raw);if(journal?.format!=="train-restore-journal"||journal.version!==1||typeof journal.user!=="string"||!Array.isArray(journal.entries)||!journal.entries.length||!["complete","rolled-back"].includes(journal.phase)){
        notice("Восстановление прервано. Сначала завершите его или выполните откат. Обычный запуск и синхронизация приостановлены.",true);return;
      }}
      for(const src of scripts){
        if(src==='app.js'&&localStorage.getItem('train_current_owner')!==Auth.userId())localStorage.removeItem('train_current_user');
        await new Promise((resolve,reject)=>{const script=document.createElement("script");script.src=src;script.onload=resolve;script.onerror=()=>reject(Error("Не удалось загрузить "+src));document.body.append(script);});
      }
    }catch(error){notice(error.message);}
  }
  if(!navigator.locks?.request){boot();return;} // Restoration itself requires Web Locks.
  navigator.locks.request("train-app-lifetime",{mode:"shared",ifAvailable:true},async lock=>{
    if(!lock){notice("В другой вкладке выполняется восстановление. Дождитесь его завершения.");return;}
    await boot();
    await new Promise(resolve=>window.addEventListener("pagehide",resolve,{once:true}));
  }).catch(error=>notice(error.message));
  window.addEventListener("pageshow",event=>{if(event.persisted)location.reload();});
})();
