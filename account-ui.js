(() => {
  const content=document.getElementById('content'),status=document.getElementById('status');
  let busy=false,finished=false;
  const report=text=>status.textContent=text;
  const owner=Auth.userId(),user=JSON.parse(localStorage.getItem('train_current_user')||'null');
  const mode=new URLSearchParams(location.search).get('mode');
  function guard(){if(!window.TRAIN_ACCOUNT_LOCK||!owner||Auth.userId()!==owner||JSON.parse(localStorage.getItem('train_current_user')||'null')!==user)throw Error('Аккаунт или профиль изменился. Перезагрузите страницу.');}
  function button(label,action){const b=document.createElement('button');b.textContent=label;b.onclick=async()=>{if(busy||finished)return;busy=true;b.disabled=true;try{await action();}catch(e){report(e.message);}finally{busy=false;b.disabled=finished;}};content.append(b);return b;}
  function download(backup){const url=URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='train-before-account-change.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  async function queueCheck(){
    const stats=await Outbox.stats(user);guard();if(stats.storageError||stats.pending!==0)throw Error('Очередь профиля не пуста или недоступна. Сначала обработайте её в приложении.');
    if(mode==='self'){const rows=await Outbox.all();guard();if(rows.some(row=>row.owner===owner))throw Error('У аккаунта остались неотправленные изменения других профилей. Сначала обработайте их.');}
  }
  async function start(){
    guard();if(!user||!['invite','self','managed'].includes(mode))throw Error('Откройте этот экран из настроек выбранного профиля.');
    await queueCheck();const me=await DB.myProfile();guard();const profile=await DB.getProfile(user);guard();
    if(!me||!profile)throw Error('Не подтверждён доступ к профилю.');
    if(mode==='self'&&(me.id!==user||profile.auth_id!==owner))throw Error('Удаление доступно только для собственного аккаунта.');
    if(mode==='managed'&&(me.role!=='trainer'||profile.auth_id))throw Error('Можно удалить только управляемого клиента без входа.');
    if(mode==='invite'&&(me.id!==user||me.role==='trainer'))throw Error('Приглашение принимает клиент из собственного профиля.');
    const backup=AccountSafety.capture(localStorage,user);
    const active=backup.data[`train_active_${user}`];
    if(active&&JSON.parse(active)!==null)throw Error('Сначала завершите активную тренировку и сохраните её.');
    if(mode==='invite'){
      const cloud={};for(const table of RestoreCore.requiredTables(backup,user)){cloud[table]=await DB.pullEntities(table,user);guard();}
      AccountSafety.assertClean(backup,user,me.id,localStorage,cloud);
    }
    report(mode==='invite'?'Перед применением кода сохраните копию исходного профиля.':'Удаление необратимо: будут удалены '+(mode==='self'?'профиль и учётная запись входа.':'профиль управляемого клиента.')+' Чужая история не удаляется; связанные данные могут заблокировать операцию.');
    let saved=false;
    button('Скачать исходные данные',()=>{guard();AccountSafety.unchanged(localStorage,backup);download(backup);saved=true;});
    const label=document.createElement('label');label.textContent=mode==='invite'?'Код приглашения':'Для подтверждения введите УДАЛИТЬ';
    const input=document.createElement('input');input.autocomplete='off';label.append(input);content.append(label);
    button(mode==='invite'?'Применить приглашение':'Удалить',async()=>{
      guard();if(!saved)throw Error('Сначала скачайте исходные данные и сохраните файл.');
      const value=input.value.trim();if(!value||(mode!=='invite'&&value!=='УДАЛИТЬ'))throw Error('Введите '+(mode==='invite'?'код приглашения.':'УДАЛИТЬ для подтверждения.'));
      await queueCheck();AccountSafety.unchanged(localStorage,backup);
      // Durable recovery copy is saved before sending a destructive request.
      const key='train_account_backup_'+crypto.randomUUID(),raw=JSON.stringify({owner,mode,createdAt:new Date().toISOString(),backup});
      localStorage.setItem(key,raw);if(localStorage.getItem(key)!==raw)throw Error('Не удалось сохранить страховочную копию.');
      guard();
      let result;
      try{result=mode==='invite'?await DB.claimInvite(value,owner):mode==='self'?await DB.deleteMyAccount(user,owner):await DB.deleteManagedClient(user,owner);}
      catch(error){throw Error('Операция не подтверждена: '+error.message+'. При сетевой ошибке результат может быть неопределённым. Проверьте профиль после входа; исходная копия сохранена.');}
      guard();finished=true;content.replaceChildren();
      localStorage.removeItem('train_current_user');localStorage.removeItem('train_current_owner');
      if(mode==='self'){
        try{await Auth.signOut();report('Учётная запись и профиль удалены. Локальная копия сохранена; чужие профили не удалялись.');}
        catch{report('Сервер подтвердил удаление. Локальный выход не подтверждён — закройте вкладки и очистите сессию перед следующим входом.');}
      }else report(mode==='invite'?'Приглашение применено. Вернитесь в приложение для загрузки профиля. Исходная копия сохранена.':'Профиль клиента удалён. Исходная локальная копия сохранена.');
    });
  }
  window.addEventListener('train-auth-context-changed',()=>{content.replaceChildren();if(!finished)report('Сессия изменилась. Операция остановлена; локальные данные сохранены.');});
  start().catch(error=>report(error.message));
})();
