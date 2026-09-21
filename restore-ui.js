(() => {
  const status=document.getElementById("status"),content=document.getElementById("content");
  let busy=false;
  const labels={active:"Активная тренировка",history:"История тренировок",workout_index:"Индекс истории (пересчёт)",records:"Рекорды (пересчёт)",own_exercises:"Мои упражнения",templates:"Шаблоны",exercise_groups:"Группы упражнений",categories:"Категории",custom_categories:"Пользовательские категории",category_colors:"Цвета категорий",own_muscles:"Мои мышцы",own_movements:"Мои движения",hidden:"Скрытые упражнения",hidden_muscles:"Скрытые мышцы",hidden_movements:"Скрытые движения",ex_order:"Порядок упражнений",ref_order_muscle:"Порядок мышц",ref_order_movement:"Порядок движений"};
  const report=text=>{status.textContent=text;};
  const button=(label,action)=>{const element=document.createElement("button");element.type="button";element.textContent=label;element.onclick=async()=>{
    if(busy)return;busy=true;element.disabled=true;try{await action();}catch(error){report(error.message);}finally{busy=false;element.disabled=false;}
  };content.append(element);return element;};
  const paragraph=text=>{const element=document.createElement("p");element.textContent=text;content.append(element);};
  function download(raw,name){const url=URL.createObjectURL(new Blob([raw],{type:"application/json"}));const a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function guardFor(user,owner){return()=>{
    if(!window.TRAIN_RESTORE_LOCK||Auth.userId()!==owner||JSON.parse(localStorage.getItem("train_current_user")||"null")!==user)throw Error("Аккаунт или профиль изменился. Операция остановлена; перезагрузите страницу.");
  };}
  async function render(){
    content.replaceChildren();
    if(!Auth.isSignedIn()){
      report("Для восстановления войдите в исходный аккаунт. Данные профиля не отправляются до завершения восстановления.");
      const form=document.createElement("form");form.innerHTML='<label>Email<input name="email" type="email" autocomplete="username" required></label><label>Пароль<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Войти</button>';
      form.onsubmit=async event=>{event.preventDefault();const submit=form.querySelector("button");submit.disabled=true;try{await Auth.signIn(form.elements.email.value,form.elements.password.value);await render();}catch(error){report(error.message);}finally{submit.disabled=false;}};
      content.append(form);return;
    }
    const user=JSON.parse(localStorage.getItem("train_current_user")||"null"),owner=Auth.userId();
    button("Выйти из аккаунта",async()=>{await Auth.signOut();await render();});
    const rawJournal=localStorage.getItem("train_import_journal");
    if(rawJournal){
      const pending=JSON.parse(rawJournal);
      if(pending.meta?.owner!==owner)throw Error("Журнал создан другим аккаунтом. Войдите в исходный аккаунт; данные не изменены.");
      if(pending.user!==user){
        RestoreJournal.create(localStorage,[...BACKUP_FIELDS,"sync_shadow","atlas_migrated","exercises_seeded"]).read(pending.user);
        report("Для обработки журнала выберите исходный профиль: "+pending.user);
        button("Перейти к профилю восстановления",async()=>{
          if(!window.TRAIN_RESTORE_LOCK||Auth.userId()!==owner||localStorage.getItem("train_import_journal")!==rawJournal)throw Error("Контекст изменился. Перезагрузите страницу.");
          localStorage.setItem("train_current_user",JSON.stringify(pending.user));await render();
        });return;
      }
    }
    if(!user)throw Error("Не выбран профиль. Вернитесь в приложение и выберите его.");
    const guard=guardFor(user,owner),coordinator=RestoreCore.coordinator({storage:localStorage,outbox:Outbox,guard});
    const state=coordinator.journal.read(user);
    if(state){
      if(state.journal.meta?.owner!==owner)throw Error("Журнал создан другим аккаунтом. Войдите в исходный аккаунт; данные не изменены.");
      paragraph("Журнал профиля: "+user+". Состояние: "+({prepared:"ожидает восстановления",applied:"ожидает записи очереди",complete:"завершён локально", "rolled-back":"выполнен откат"}[state.journal.phase]||state.journal.phase));
      button("Скачать журнал с исходными данными",()=>download(state.raw,"train-restore-journal.json"));
      if(["complete","rolled-back"].includes(state.journal.phase)){
        report(state.journal.phase==="complete"?"Восстановление сохранено локально и поставлено в очередь. Облачная отправка начнётся после возврата в приложение; её успех проверяйте по индикатору синхронизации.":"Откат завершён. Исходные данные восстановлены; импорт не отправлен в облако.");
        button("Освободить завершённый журнал",async()=>{
          if(!confirm("Сначала сохраните скачанный журнал: он содержит данные для ручного восстановления. Убрать только завершённый журнал с устройства?"))return;
          guard();if(localStorage.getItem("train_import_journal")!==state.raw)throw Error("Журнал изменился");
          localStorage.removeItem("train_import_journal");if(localStorage.getItem("train_import_journal")!==null)throw Error("Не удалось удалить журнал");
          await render();
        });return;
      }
      report("Обнаружено прерванное восстановление. Обычный запуск и отправка очереди заблокированы до завершения или отката.");
      button("Завершить восстановление",async()=>{await coordinator.finish(user);await render();});
      button("Откатить локальные изменения",async()=>{
        if(!confirm("Вернуть значения из журнала до импорта? Новые конфликтующие правки не будут перезаписаны."))return;
        await coordinator.rollback(user);await render();
      });return;
    }
    const staged=readStagedImport(user);
    if(!staged){report("Нет подготовленной копии. Выберите JSON-файл в настройках приложения.");return;}
    report("Проверяем очередь и доступ к профилю…");
    // Empty queue is a deliberate precondition: never overwrite unacknowledged edits.
    const queue=await Outbox.stats(user);guard();
    if(queue.storageError||queue.pending!==0)throw Error("Очередь профиля не пуста или недоступна. Вернитесь в приложение, обработайте очередь и повторите.");
    const me=await DB.myProfile();guard();const profile=await DB.getProfile(user);guard();
    if(!me?.id||!profile)throw Error("Не подтверждён доступ к профилю. Нужны сеть и действующая сессия.");
    const cloud={};
    for(const table of RestoreCore.requiredTables(staged.candidate,user)){cloud[table]=await DB.pullEntities(table,user);guard();}
    const plan=RestoreCore.build(staged.candidate,user,me.id,localStorage,cloud,owner);
    report("План готов. Ничего ещё не изменено.");
    paragraph("Профиль: "+(profile.name||user)+". Локальных разделов в плане: "+plan.changes.filter(change=>labels[change.field]).length+". Операций очереди: "+plan.operations.length+". Удалений из облака/скрытий сущностей: "+plan.cloudDeletes+".");
    paragraph("Будут заменены только разделы из копии. Записи этих разделов, отсутствующие в копии, будут удалены при синхронизации. Индекс и рекорды пересчитываются из истории; без истории они не импортируются. Не редактируйте профиль на других устройствах до окончания отправки.");
    const list=document.createElement("ul");for(const change of plan.changes.filter(change=>labels[change.field])){const item=document.createElement("li");item.textContent=labels[change.field]+(change.before===change.after?" — без изменений":" — будет заменён");list.append(item);}content.append(list);
    const label=document.createElement("label");label.id="confirm-label";
    const checkbox=document.createElement("input");checkbox.type="checkbox";label.append(checkbox,document.createTextNode("Я сохранил исходный файл и подтверждаю замену указанных разделов, включая показанные удаления."));content.append(label);
    const apply=button("Применить копию",async()=>{
      if(!checkbox.checked)throw Error("Подтвердите замену данных");
      guard();if(localStorage.getItem("train_import_candidate")!==staged.raw)throw Error("Копия изменилась. Повторите проверку");
      for(const [key,raw] of Object.entries(plan.snapshot))if(localStorage.getItem(key)!==raw)throw Error("Данные изменились. Повторите проверку");
      const queue=await Outbox.stats(user);guard();if(queue.storageError||queue.pending!==0)throw Error("Очередь изменилась. Применение остановлено");
      const id=crypto.randomUUID();
      coordinator.journal.begin(user,plan.changes,guard,{id,owner,operations:plan.operations});
      try{await coordinator.finish(user);}finally{await render();}
    });apply.disabled=true;checkbox.onchange=()=>{apply.disabled=!checkbox.checked;};
  }
  window.addEventListener("train-auth-context-changed",()=>{content.replaceChildren();report("Сессия изменилась. Перезагрузите страницу; незавершённый журнал сохранён.");});
  render().catch(error=>report(error.message));
})();
