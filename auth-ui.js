/*
 * auth-ui.js — реальный экран входа/регистрации + переключатель профиля для
 * тренера. Загружается ПОСЛЕ app.js и ПОСЛЕ bridge.js.
 *
 * Осознанный подход, тот же, что и в bridge.js: не трогаем app.js — вместо
 * этого ПЕРЕОПРЕДЕЛЯЕМ верхнеуровневую функцию renderProfiles() (в app.js
 * она была простым `DATA.USERS.forEach(...)` по двум хардкоженным профилям).
 * Поскольку renderProfiles объявлена как обычная `function` в глобальной
 * области (не внутри замыкания), переопределение здесь полностью её заменяет
 * — goToScreen("profile") в app.js вызывает уже эту, новую версию, ничего в
 * app.js менять не пришлось.
 */
"use strict";

let _authMode = "signin"; // signin | signup

function reviewLegacyDraft(user){
  const key=`train_active_${user}`,raw=localStorage.getItem(key),draft=JSON.parse(raw||'null');
  if(!draft)return;
  if(draft._accountOwner&&draft._accountOwner!==Auth.userId()){
    alert('В этом профиле есть активный черновик другого аккаунта. Он сохранён, но скрыт. Завершите его в исходном аккаунте перед новой тренировкой.');return;
  }
  if(!draft._accountOwner&&confirm('Найден старый черновик без отметки владельца. Это ваша тренировка? Привязать её к текущему аккаунту? Отмена сохранит черновик без изменений.')){
    DATA.adoptLegacyActiveWorkout(user,raw,true);
  }
}

// Регистрирует реальный профиль в DATA.USERS (см. enterProfile). Идемпотентно.
function registerUser(profile) {
  const initial = (profile.name || "?").trim().charAt(0).toUpperCase() || "?";
  const existing = DATA.USERS.find(u => u.id === profile.id);
  if (existing) { existing.name = profile.name || existing.name; existing.initial = initial; return; }
  DATA.USERS.push({ id: profile.id, name: profile.name || "Профиль", avatarClass: "", initial });
}

function authSetError(msg) {
  const el = document.getElementById("auth-error");
  if (el) el.textContent = msg || "";
}

function updateAuthFormMode() {
  const isSignup = _authMode === "signup";
  document.getElementById("auth-name-field").style.display = isSignup ? "" : "none";
  document.getElementById("auth-role-field").style.display = isSignup ? "" : "none";
  document.getElementById("auth-submit-btn").textContent = isSignup ? "Зарегистрироваться" : "Войти";
  document.getElementById("auth-toggle-mode").textContent = isSignup
    ? "Уже есть аккаунт? Войти"
    : "Нет аккаунта? Зарегистрироваться";
}

document.getElementById("auth-toggle-mode").addEventListener("click", () => {
  _authMode = _authMode === "signin" ? "signup" : "signin";
  authSetError("");
  updateAuthFormMode();
});

document.getElementById("auth-role-group").addEventListener("click", (e) => {
  const btn = e.target.closest(".ex-form-chip");
  if (!btn) return;
  document.querySelectorAll("#auth-role-group .ex-form-chip").forEach(b => b.classList.toggle("selected", b === btn));
});

document.getElementById("auth-submit-btn").addEventListener("click", async () => {
  const email = document.getElementById("auth-email").value.trim();
  const password = document.getElementById("auth-password").value;
  if (!email || !password) { authSetError("Заполните email и пароль."); return; }

  const btn = document.getElementById("auth-submit-btn");
  btn.disabled = true;
  authSetError("");
  try {
    if (_authMode === "signup") {
      const name = document.getElementById("auth-name").value.trim();
      const role = document.querySelector("#auth-role-group .ex-form-chip.selected")?.dataset.role || "client";
      const res = await Auth.signUp(email, password, { name, role });
      if (!res.access_token) {
        // На проекте включено подтверждение email — сессии сразу не будет.
        authSetError("Аккаунт создан. Проверьте почту, подтвердите email и войдите.");
        _authMode = "signin";
        updateAuthFormMode();
        return;
      }
      // Код приглашения регистрация больше не спрашивает (см. чат: ввод кода
      // ПОСЛЕ регистрации через Настройки → «Ввести код приглашения» оказался
      // надёжнее — ошибка при заявке кода видна сразу и не путается с самой
      // регистрацией, как было с Нателой).
    } else {
      await Auth.signIn(email, password);
    }
    // Recreate DATA and draft guards for the new account; never reuse old DOM.
    location.reload();
  } catch (e) {
    authSetError(e.message || "Не удалось выполнить вход.");
  } finally {
    btn.disabled = false;
  }
});

// ---- видимость и режим кнопок в модалке «Настройки» ----
// Одна функция вместо нескольких разрозненных — все проверки используют ОДИН
// и тот же DB.myProfile() (личность РЕАЛЬНОЙ залогиненной сессии), поэтому не
// могут разъехаться друг с другом. Правила:
//   • «Сменить профиль» — видна ТОЛЬКО тренеру: у обычного клиента структурно
//     нет второго профиля, переключаться некуда.
//   • «Ввести код приглашения» — скрыта тренеру И скрыта клиенту, который уже
//     привязан хотя бы к одному тренеру (повторный ввод ничего не даст).
//   • Удаление — АДАПТИВНАЯ кнопка (текст + режим в dataset):
//       – смотрю СВОЙ профиль → «Удалить аккаунт» (mode=self, самоудаление);
//       – смотрю СВОЕГО управляемого клиента (auth_id null) → «Удалить клиента»
//         (mode=managed, удаляет тот профиль, возврат к переключателю);
//       – смотрю клиента с СОБСТВЕННЫМ логином → кнопка скрыта (чужой аккаунт,
//         владелец удаляет сам). Кнопка всегда оперирует ПРОСМАТРИВАЕМЫМ
//         профилем явно (dataset.targetId), а не «текущей сессией вслепую» —
//         это и защита от прошлого бага (чуть не удалили тренера, «удаляя»
//         клиента), и то, что вернуло возможность чистить управляемых клиентов.
async function refreshSettingsButtons() {
  renderSettingsSyncStatus();
  updateOnlineStatus();
  const inviteBtn  = document.getElementById("enter-invite-btn");
  const switchBtn  = document.getElementById("switch-user-btn");
  const deleteBtn  = document.getElementById("delete-account-btn");
  const deleteLabel = deleteBtn?.querySelector("span:last-child");

  if (!Auth.isSignedIn()) {
    [inviteBtn, switchBtn, deleteBtn].forEach(b => { if (b) b.style.display = "none"; });
    return;
  }

  let me = null;
  try { me = await DB.myProfile(); } catch {}
  const isTrainer = me?.role === "trainer";
  const viewedId  = DATA.getCurrentUser();

  if (switchBtn) switchBtn.style.display = isTrainer ? "" : "none";

  if (inviteBtn) {
    if (!me) { inviteBtn.style.display = ""; }               // не смогли проверить — лучше показать, чем спрятать нужное
    else if (isTrainer) { inviteBtn.style.display = "none"; }
    else {
      try { inviteBtn.style.display = (await DB.hasAnyTrainer(me.id)) ? "none" : ""; }
      catch { inviteBtn.style.display = ""; }
    }
  }

  if (deleteBtn) {
    if (me && viewedId === me.id) {
      deleteBtn.style.display = "";
      deleteBtn.dataset.mode = "self";
      deleteBtn.dataset.targetId = me.id;
      if (deleteLabel) deleteLabel.textContent = "Удалить аккаунт";
    } else if (isTrainer && viewedId) {
      // Смотрим клиента: удалять можно только управляемого (без логина).
      let viewed = null;
      try { viewed = await DB.getProfile(viewedId); } catch {}
      if (viewed && !viewed.auth_id) {
        deleteBtn.style.display = "";
        deleteBtn.dataset.mode = "managed";
        deleteBtn.dataset.targetId = viewed.id;
        if (deleteLabel) deleteLabel.textContent = "Удалить клиента";
      } else {
        deleteBtn.style.display = "none";
      }
    } else {
      deleteBtn.style.display = "none";
    }
  }
}

// Второй обработчик клика по той же пилюле «Настройки», что уже слушает
// app.js (multiple addEventListener на одном элементе — не конфликтуют) —
// на случай, если что-то сменилось с прошлого раза (роль, привязка к
// тренеру, просматриваемый профиль), кнопки должны отражать текущее состояние.
const settingsPill = document.querySelector('.pill[data-action="settings"]');
if (settingsPill) settingsPill.addEventListener("click", () => { refreshSettingsButtons(); });

// profile-chip (аватар в шапке меню) сейчас скрыт CSS-ом (см. index.html
// .profile-chip { display:none }) — оставлен нетронутым, кликнуть по нему
// физически нельзя. Если его когда-нибудь вернут — тот же принцип, что и у
// switch-user-btn ниже, должен применяться и здесь.
const profileChipEl = document.getElementById("profile-chip");
if (profileChipEl) profileChipEl.addEventListener("click", () => { renderProfiles(); });

// «Сменить профиль» — управляем ПОРЯДКОМ действий сами (app.js теперь только
// закрывает модалку настроек, см. его комментарий у этой же кнопки). Раньше
// экран #screen-profile показывался СРАЗУ (goToScreen), а полноценный список
// профилей дорисовывался следом — пользователь видел вспышку «Загрузка…» на
// уже открытом экране. Теперь наоборот: сперва тихо (оставаясь на текущем
// экране) дожидаемся renderProfiles() — она полностью строит контент
// #screen-profile, включая финальный список карточек одним кадром (см. её
// комментарий про DocumentFragment) — и только когда всё готово, ПОКАЗЫВАЕМ
// экран уже полностью заполненным. Задержка перед переходом ощущается как
// короткая пауза на прежнем экране, а не как дёрганая загрузка на новом.
document.getElementById("switch-user-btn").addEventListener("click", async () => {
  DATA.clearCurrentUser();
  await renderProfiles();
  goToScreen("profile");
});

// «В облако» — только принудительный PUSH. Обратную загрузку эта кнопка не
// запускает: её задача ровно та, которую ожидает пользователь по названию.
// Управление карантином. Native dialog удерживает фокус и поддерживает Escape.
async function openOutboxManager() {
  if (document.getElementById("outbox-manager")) return;
  const uid = DATA.getCurrentUser();
  const owner = Auth.userId();
  if (!uid || !owner) { showToast("Выберите профиль и войдите в аккаунт", 2500); return; }
  closeModal(settingsModalBackdrop);
  const dialog = document.createElement("dialog");
  dialog.id = "outbox-manager";
  dialog.className = "modal modal-scroll";
  dialog.setAttribute("aria-labelledby", "outbox-manager-title");
  dialog.style.cssText = "width:min(440px,calc(100vw - 32px));max-width:440px;max-height:85dvh;overflow:auto;margin:auto;border:1px solid #777;color:var(--text-primary,#f5f5f7);line-height:1.5;overflow-wrap:anywhere;";
  dialog.innerHTML = '<h2 class="modal-title" id="outbox-manager-title">Очередь выбранного профиля</h2>' +
    '<p data-status role="status" aria-live="polite">Проверяем очередь…</p><ul data-items></ul>' +
    '<p data-held></p><button type="button" class="modal-option" data-retry disabled>Повторить заблокированные</button>' +
    '<h3>Старые записи этого профиля</h3><div data-legacy></div>' +
    '<button type="button" class="modal-option" data-backup>Скачать архив восстановления</button>' +
    '<button type="button" class="modal-cancel" data-close>Закрыть</button>';
  document.body.appendChild(dialog);
  const status = dialog.querySelector("[data-status]"), list = dialog.querySelector("[data-items]");
  const held = dialog.querySelector("[data-held]"), retry = dialog.querySelector("[data-retry]");
  let viewed = [], busy = false;
  const active = () => Auth.userId() === owner && DATA.getCurrentUser() === uid;
  const labels = { saveWorkout: "Сохранение тренировки", deleteWorkout: "Удаление тренировки", saveEntity: "Изменение справочника", saveUserData: "Настройки профиля" };
  async function refresh() {
    retry.disabled = true;
    const state = await Outbox.review(uid);
    if (!active() || state.owner !== owner) throw new Error("Аккаунт или профиль изменился. Откройте очередь заново.");
    if (!dialog.isConnected) return;
    viewed = state.operations.filter(op => op.blocked);
    list.replaceChildren();
    for (const op of state.operations.slice(0, 50)) {
      const li = document.createElement("li");
      li.textContent = `${labels[op.type] || "Неизвестная операция"}: ${op.blocked ? "заблокировано" : "ожидает отправки"}. Попыток: ${op.attempts}.` +
        (op.lastError ? " Причина: " + String(op.lastError).slice(0, 180) : "");
      list.appendChild(li);
    }
    status.textContent = state.operations.length ? `Ожидает: ${state.operations.length}. Заблокировано: ${viewed.length}.` +
      (state.operations.length > 50 ? " Показаны первые 50 записей; повтор затронет все заблокированные этого профиля." : "") : "У этого аккаунта нет ожидающих операций для выбранного профиля.";
    held.textContent = state.legacy || state.foreign ?
      `Отдельно на устройстве: ${state.foreign} записей других аккаунтов, ${state.legacy} старых записей без владельца. Они не будут затронуты. Для чужих записей войдите в исходный аккаунт; старые требуют отдельного восстановления. Не очищайте данные приложения.` : "";
    retry.disabled = !viewed.length;
    const legacy = dialog.querySelector("[data-legacy]");
    legacy.replaceChildren();
    for (const op of (state.recoverable || []).slice(0, 50)) {
      const button = document.createElement("button");
      button.type = "button"; button.className = "modal-option";
      button.textContent = "Восстановить: " + (labels[op.type] || op.type) + " — " + op.label;
      button.addEventListener("click", async () => {
        if (busy || !active()) return;
        if (!window.confirm(`Восстановить запись «${op.label}»?\n\nПрофиль: ${uid}\nАккаунт: ${owner}\n\nПодтвердите, что эта запись принадлежит вам или была внесена вами для этого клиента. Она будет отправляться от текущего аккаунта и может заменить облачную запись (или удалить её, если это операция удаления). Исходная операция останется в локальном архиве. Если не уверены — отмените.`)) return;
        if (!active()) return;
        busy = true; button.disabled = true;
        try {
          await Outbox.recoverLegacy(uid, op, { expectedAccount: owner, confirmed: true });
          await refresh();
          status.textContent = "Запись восстановлена в очередь, оригинал сохранён в архиве. Она может отправиться при фоновой синхронизации; «В облако» запускает отправку вручную.";
        } catch (e) { status.textContent = String(e.message || e); button.disabled = false; }
        finally { busy = false; updateOnlineStatus(); }
      });
      legacy.appendChild(button);
    }
    if (!legacy.childElementCount) legacy.textContent = "Нет старых записей с однозначно указанным профилем и поддерживаемым форматом.";
  }
  dialog.querySelector("[data-backup]").addEventListener("click", async () => {
    if (!active()) return;
    try {
      const records = await Outbox.recoveryBackups(uid);
      if (!active()) return;
      if (!records.length) { status.textContent = "Архив восстановления этого профиля пока пуст."; return; }
      const url = URL.createObjectURL(new Blob([JSON.stringify({ format: "train-outbox-recovery", version: 1, profileId: uid, records }, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = "train-outbox-recovery.json";
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = "Архив подготовлен к скачиванию. Он содержит личные данные: храните его безопасно. Это не файл обычного импорта приложения.";
    } catch (e) { status.textContent = String(e.message || e); }
  });
  retry.addEventListener("click", async () => {
    if (busy || !active()) { status.textContent = "Проверьте выбранный аккаунт и откройте очередь заново."; return; }
    busy = true; retry.disabled = true;
    try {
      const count = await Outbox.retryBlocked(uid, viewed, { expectedAccount: owner });
      status.textContent = `Разблокировано: ${count}. Отправляем…`;
      await Outbox.flush();
      await refresh();
    } catch (e) { status.textContent = String(e.message || e); }
    finally { busy = false; updateOnlineStatus(); }
  });
  dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    dialog.remove();
    (document.querySelector('.pill[data-action="settings"]') || document.getElementById("outbox-manager-btn"))?.focus();
  });
  dialog.showModal();
  try { await refresh(); } catch (e) { status.textContent = "Очередь недоступна: " + String(e.message || e); }
}
document.getElementById("outbox-manager-btn")?.addEventListener("click", openOutboxManager);

// Recovery is a settings subsection; opening it never changes stored data.
const recoveryBackdrop = document.getElementById('recovery-modal-backdrop');
document.getElementById('recovery-settings-btn')?.addEventListener('click', () => {
  SettingsFlow.show('recovery-modal-backdrop');
});

document.getElementById('workout-backups-btn')?.addEventListener('click', async () => {
  const owner = Auth.userId(), uid = DATA.getCurrentUser();
  try {
    const copies = await WorkoutSafety.backups(owner, uid);
    if (Auth.userId() !== owner || DATA.getCurrentUser() !== uid || !recoveryBackdrop.classList.contains('open')) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'modal history-backups';
    const title = document.createElement('h2');
    title.className = 'modal-title';
    title.textContent = 'Копии истории';
    const hint = document.createElement('p');
    hint.className = 'modal-sync-info';
    hint.textContent = copies.length ? 'Скачайте нужную копию. Её можно открыть через «Импорт» и проверить изменения перед восстановлением.' : 'Копии появятся перед первым изменением истории из облака. Они хранятся на этом устройстве.';
    dialog.append(title, hint);
    const list = document.createElement('div');
    list.style.cssText = 'max-height:50vh;overflow:auto;display:grid;gap:8px';
    copies.sort((a, b) => b.at - a.at).forEach(copy => {
      const button = document.createElement('button');
      button.className = 'modal-option modal-option-full';
      button.textContent = new Date(copy.at).toLocaleString('ru-RU') + ' · тренировок: ' + copy.history.length;
      button.onclick = () => {
        if (Auth.userId() !== owner || DATA.getCurrentUser() !== uid) { dialog.close(); return; }
        const payload = { app: 'train.', version: 2, user: uid, data: { [`train_history_${uid}`]: JSON.stringify(copy.history) } };
        const url = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url; a.download = `train-history-${uid}-${copy.at}.json`;
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
      list.append(button);
    });
    const close = document.createElement('button');
    close.className = 'modal-option modal-option-full history-back'; close.textContent = 'Назад'; close.onclick = () => dialog.close();
    dialog.append(list, close);
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (Auth.userId() === owner && DATA.getCurrentUser() === uid) {
        openModal(recoveryBackdrop);
        document.getElementById('workout-backups-btn').focus();
      }
    });
    document.body.append(dialog); dialog.showModal(); closeModal(recoveryBackdrop);
  } catch (error) { showToast('Не удалось прочитать копии: ' + error.message); }
});

document.getElementById('sync-result-btn').addEventListener('click', () => {
  closeModal(settingsModalBackdrop); openSyncDetails();
});

function showCloudUploadResult(result) {
  if (result?.held > 0) {
    showSyncError("Сохранены записи другого аккаунта или старые записи без владельца. Не очищайте данные приложения.", 'queue');
    return;
  }
  if (result?.storageError) {
    showSyncError(result.lastError || "Не удалось проверить очередь устройства. Не очищайте данные приложения.", 'queue');
    return;
  }
  if (result?.skipped === "awaiting-publish") {
    setSyncNotice('Нужна первая отправка', 'Нажмите «В облако» и подтвердите отправку данных этого устройства.', 'warning');
    return;
  }
  const pending = Number(result?.pending) || 0;
  const blocked = Number(result?.blocked) || 0;
  const failed = Number(result?.failed) || 0;
  if (!result || result.skipped) {
    showSyncError(result?.skipped === 'offline' ? { code: 'OFFLINE' } :
      result?.lastError || "Отправка не началась. Проверьте вход и повторите.", 'upload');
  } else if (blocked > 0 || failed > 0 || pending > 0) {
    showSyncError((result.lastError || "Отправка не завершена; откройте очередь отправки.") + ` Ожидают отправки: ${pending}.`, 'upload');
  } else {
    setSyncNotice('Изменения отправлены', result.otherPending > 0 ?
      'Изменения выбранного профиля отправлены. Для других профилей ещё есть записи в очереди.' :
      'Отправка изменений подтверждена. Эта кнопка не загружает изменения с другого устройства и не отправляет незавершённую тренировку.', 'success');
  }
}

const manualUploadBtn = document.getElementById("sync-upload-btn");
manualUploadBtn.addEventListener("click", async () => {
  if (window.__manualSyncInProgress) return;
  window.__syncNoticeEpoch = (window.__syncNoticeEpoch || 0) + 1;
  closeModal(settingsModalBackdrop);
  const uid = DATA.getCurrentUser();
  if (!uid) { showToast("Сначала выберите профиль", 2000); return; }
  if (!navigator.onLine) {
    showSyncError({ code: 'OFFLINE' }, 'upload');
    return;
  }
  if (typeof Auth === "undefined" || !Auth.isSignedIn()) { showSyncError("Для отправки требуется вход.", 'session'); return; }
  manualUploadBtn.disabled = true;
  window.__manualSyncInProgress = true;
  setSyncNotice('Отправка в облако…', 'Отправка выполняется. Закрытие уведомления не отменяет её.', 'progress');
  try {
    if (!SyncEngine.isMigrated(uid)) {
      const approved = window.confirm(
        "Первая публикация выбранного профиля\n\n" +
        "Отправить упражнения, шаблоны и настройки этого устройства в облако? " +
        "Если там уже есть записи с теми же идентификаторами, они будут заменены локальными версиями. " +
        "Используйте устройство с актуальными данными.\n\n" +
        "При прерывании нажмите «В облако» ещё раз, чтобы продолжить."
      );
      if (!approved) { showToast("Публикация отменена. Локальные данные сохранены.", 2500); return; }
      if (DATA.getCurrentUser() !== uid) { showToast("Профиль изменился. Повторите отправку.", 2500); return; }
      const result = await SyncEngine.publishAll(uid, { confirmed: true });
      if (result.status === "ok" || result.status === "partial") showCloudUploadResult(result.flushed);
      else throw new Error(result.error || (result.status === "offline" ? "Нет сети" : "Публикация не выполнена"));
    } else {
      const result = await SyncEngine.pushOnly(uid);
      showCloudUploadResult(result);
    }
  } catch (e) {
    showSyncError(e, 'upload');
  } finally {
    window.__manualSyncInProgress = false;
    manualUploadBtn.disabled = false;
    updateOnlineStatus();
  }
});

// «Личные данные» — Имя/Фамилия/Возраст/Вес/Рост ПРОСМАТРИВАЕМОГО СЕЙЧАС
// профиля (DATA.getCurrentUser()) — своего или клиента (RLS profiles_update
// пускает тренера редактировать данные его клиентов, в т.ч. управляемых без
// логина — например, вписать вес/рост подопечного самому). Модалка строится
// динамически, как migrate/invite — тот же паттерн в этом файле.
async function openPersonalDataModal() {
  const viewedId = DATA.getCurrentUser();
  const owner = Auth.userId();
  if (!viewedId) return;
  if (document.getElementById('personal-data-modal')) return;
  let profile;
  try { profile = await DB.getProfile(viewedId); }
  catch (e) { alert("Не удалось загрузить данные: " + e.message); return; }
  if (!profile) { alert("Профиль не найден."); return; }
  const deleteButton = document.getElementById('delete-account-btn');
  // Reuse the existing guarded action and its current role/profile policy.
  deleteButton.style.display = 'none';
  await refreshSettingsButtons();
  if (DATA.getCurrentUser() !== viewedId || Auth.userId() !== owner || document.getElementById('personal-data-modal')) return;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop open";
  backdrop.id = "personal-data-modal";
  const num = v => (v === null || v === undefined ? "" : String(v));
  backdrop.innerHTML = `
    <div class="modal modal-form modal-scroll">
      <h2 class="modal-title">Личные данные</h2>
      <div class="ex-form-field">
        <span class="ex-form-label">Имя</span>
        <input class="ex-form-input" id="pd-name" type="text" value="${escHtml(profile.name || "")}">
      </div>
      <div class="ex-form-field">
        <span class="ex-form-label">Фамилия</span>
        <input class="ex-form-input" id="pd-last-name" type="text" value="${escHtml(profile.last_name || "")}">
      </div>
      <div class="ex-form-field">
        <span class="ex-form-label">Возраст</span>
        <input class="ex-form-input" id="pd-age" type="number" inputmode="numeric" min="0" max="120" value="${escHtml(num(profile.age))}">
      </div>
      <div class="ex-form-field">
        <span class="ex-form-label">Вес, кг</span>
        <input class="ex-form-input" id="pd-weight" type="number" inputmode="decimal" step="0.1" min="0" value="${escHtml(num(profile.weight))}">
      </div>
      <div class="ex-form-field">
        <span class="ex-form-label">Рост, см</span>
        <input class="ex-form-input" id="pd-height" type="number" inputmode="decimal" step="0.1" min="0" value="${escHtml(num(profile.height))}">
      </div>
      <div class="auth-error" id="pd-status"></div>
      <div class="modal-form-actions">
        <button class="btn-chip" id="pd-cancel" type="button">Отмена</button>
        <button class="btn-chip primary" id="pd-save" type="button">Сохранить</button>
      </div>
      <div class="personal-delete-slot" id="pd-delete-slot"></div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector('#pd-delete-slot').append(deleteButton);

  const close = () => {
    document.getElementById('account-actions-storage').append(deleteButton);
    backdrop.remove();
  };
  backdrop.querySelector("#pd-cancel").addEventListener("click", close);
  backdrop.addEventListener("click", e => { if (e.target === backdrop) close(); });

  backdrop.querySelector("#pd-save").addEventListener("click", async () => {
    const status = backdrop.querySelector("#pd-status");
    const saveBtn = backdrop.querySelector("#pd-save");
    const toNum = id => {
      const v = backdrop.querySelector(id).value.trim();
      return v === "" ? null : Number(v);
    };
    const name = backdrop.querySelector("#pd-name").value.trim();
    if (!name) { status.textContent = "Имя не может быть пустым."; return; }
    saveBtn.disabled = true;
    try {
      const updated = await DB.updateProfile(viewedId, {
        name,
        last_name: backdrop.querySelector("#pd-last-name").value.trim() || null,
        age:    toNum("#pd-age"),
        weight: toNum("#pd-weight"),
        height: toNum("#pd-height"),
      });
      // Если это МОЙ профиль (или тот, что сейчас открыт на экране) — обновить
      // чип/заголовок сразу, не дожидаясь следующего hydrate.
      if (updated) {
        registerUser(updated);
        if (screenMenu.classList.contains("active")) refreshMenu();
      }
      close();
      showToast("Сохранено");
    } catch (e) {
      saveBtn.disabled = false;
      status.textContent = "Не удалось сохранить: " + e.message;
    }
  });
}

document.getElementById("personal-data-btn").addEventListener("click", () => {
  closeModal(settingsModalBackdrop);
  openPersonalDataModal();
});

// Legacy marker from 1.92: consumed on boot, never set by data sync in 1.93.
const MANUAL_REFRESH_KEY = "train_manual_refresh_pending";
function withOperationTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => {
      const error = new Error(message); error.code = 'TIMEOUT'; reject(error);
    }, timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

// Stage codes remain in error details; do not replace the toast at each stage.
function showSyncProgress() {
  setSyncNotice('Синхронизация…', 'Загружаем данные из облака. Версия приложения не меняется. Итог появится после завершения; закрытие плашки не отменяет операцию.', 'progress');
}
function showHydrateResult(result, showSuccess = true, epoch) {
  const options = { automatic: !showSuccess, epoch, notify: showSuccess };
  if (result?.warnings?.length) {
    setSyncNotice('Синхронизация не полная', syncErrorText(result.warnings[0], 'atlas') + '\nЧасть данных загружена, но не всё. Повторите синхронизацию.', 'warning', { ...options, notify: true });
  } else if (['local-pending', 'publish-pending', 'awaiting-publish'].includes(result?.mode)) {
    setSyncNotice('Нужна отправка в облако', 'История загружена. Упражнения и настройки ещё не синхронизированы — нажмите «В облако».', 'warning', { ...options, notify: showSuccess });
  } else if (!result || ['no-user', 'no-session'].includes(result.mode)) {
    showSyncError('Не удалось завершить загрузку: выберите профиль и проверьте вход.', 'session', { ...options, notify: true });
  } else if (result.pending > 0 || result.held > 0) {
    setSyncNotice('Не всё отправлено', 'Загрузка завершена, но в очереди остаются изменения. Откройте «В облако» или очередь отправки.', 'warning', { ...options, notify: showSuccess });
  } else {
    setSyncNotice('Синхронизация завершена', 'История, справочник и настройки загружены без ошибок. Незавершённая тренировка остаётся локальным черновиком.', 'success', options);
  }
}

const manualRefreshBtn = document.getElementById("sync-reload-btn");
manualRefreshBtn.addEventListener("click", async () => {
  if (window.__manualSyncInProgress) return;
  window.__syncNoticeEpoch = (window.__syncNoticeEpoch || 0) + 1;
  closeModal(settingsModalBackdrop);
  const uid = DATA.getCurrentUser();
  if (!uid) { showToast("Сначала выберите профиль", 2000); return; }
  if (!navigator.onLine) { showSyncError({ code: 'OFFLINE' }, 'history'); return; }
  if (typeof Auth === "undefined" || !Auth.isSignedIn()) { showSyncError("Для синхронизации требуется вход.", 'session'); return; }
  manualRefreshBtn.disabled = true;
  window.__manualSyncInProgress = true;
  let stage = 'queue';
  try {
    showSyncProgress();
    const queued = await Outbox.stats();
    if (queued.storageError) throw new Error(queued.lastError || 'Не удалось прочитать очередь устройства.');
    if (queued.pending > 0) {
      setSyncNotice('Сначала отправьте изменения', `Нажмите «В облако», затем повторите синхронизацию. Ожидают отправки: ${queued.pending}.`, 'warning');
      return;
    }
    const result = await Bridge.hydrate(uid, { onProgress: next => { stage = next; } });
    stage = 'queue';
    const remaining = await Outbox.stats(uid);
    if (remaining.storageError) throw new Error(remaining.lastError || 'Не удалось проверить итог отправки.');
    try { sessionStorage.removeItem(MANUAL_REFRESH_KEY); } catch {}
    showHydrateResult(result && { ...result, pending: remaining.pending, held: remaining.held });
    if (screenMenu.classList.contains("active")) refreshMenu();
  } catch (e) {
    try { sessionStorage.removeItem(MANUAL_REFRESH_KEY); } catch {}
    showSyncError(e, stage);
  } finally {
    window.__manualSyncInProgress = false;
    manualRefreshBtn.disabled = false;
    updateOnlineStatus();
  }
});

// App-shell update never calls DB, Outbox or Bridge and never reports a sync result.
function waitForAppWorker(worker) {
  return new Promise((resolve, reject) => {
    const finish = error => { clearTimeout(timer); worker.removeEventListener('statechange', check); error ? reject(error) : resolve(); };
    const check = () => {
      if (worker.state === 'activated') finish();
      else if (worker.state === 'redundant') finish(new Error('Не удалось загрузить файлы новой версии. Повторите позже.'));
    };
    const timer = setTimeout(() => finish(Object.assign(new Error('Загрузка новой версии заняла слишком много времени.'), { code: 'TIMEOUT' })), 15000);
    worker.addEventListener('statechange', check); check();
  });
}
function offerAppReload() {
  showActionToast('Новая версия готова', 'Открыть', () => {
    if (window.__manualSyncInProgress) { showToast('Дождитесь завершения синхронизации', 5000); return; }
    location.reload();
  }, 10000);
}
const appUpdateBtn = document.getElementById('app-update-btn');
appUpdateBtn.addEventListener('click', async () => {
  if (window.__manualAppUpdateInProgress) return;
  closeModal(settingsModalBackdrop);
  if (window.__appUpdateReady) { offerAppReload(); return; }
  if (!navigator.onLine) {
    showToast('Обновление недоступно', 10000, { kind: 'error', detail: '[UPDATE-OFFLINE] Нет интернета. Синхронизация данных — отдельное действие.' }); return;
  }
  appUpdateBtn.disabled = true; window.__manualAppUpdateInProgress = true;
  showToast('Проверяем новую версию…', 8000);
  try {
    if (!navigator.serviceWorker) throw new Error('Этот браузер не поддерживает обновление установленного приложения.');
    const reg = await withOperationTimeout((async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) throw new Error('Приложение ещё не готово к обновлению. Откройте его заново и повторите.');
      await registration.update(); return registration;
    })(), 15000, 'Проверка новой версии заняла слишком много времени.');
    const worker = reg.installing || reg.waiting;
    if (worker) { await waitForAppWorker(worker); window.__appUpdateReady = true; }
    if (window.__appUpdateReady) offerAppReload();
    else showToast('Обновлений нет', 5000, { kind: 'success', detail: 'Проверка версии завершена. Эта кнопка не отправляет и не загружает тренировки.' });
  } catch (error) {
    showToast('Обновление не выполнено', 10000, { kind: 'error', detail: syncErrorText(error, 'update') + '\nОбмен тренировками не запускался. Для него используйте «В облако» и «Синхронизация».' });
  } finally {
    appUpdateBtn.disabled = false; window.__manualAppUpdateInProgress = false;
  }
});

// Dangerous operations run on an exclusive page, without DATA/Bridge writers.
function openAccountMaintenance(mode,targetId=DATA.getCurrentUser()){
  if(!Auth.isSignedIn()||!targetId||targetId!==DATA.getCurrentUser()||!['self','managed','invite'].includes(mode)){
    showToast('Профиль изменился. Откройте настройки заново.');return;
  }
  location.assign('account.html?mode='+encodeURIComponent(mode));
}
document.getElementById("delete-account-btn").addEventListener("click",event=>{
  openAccountMaintenance(event.currentTarget.dataset.mode,event.currentTarget.dataset.targetId);
});
document.getElementById("enter-invite-btn").addEventListener("click",()=>openAccountMaintenance('invite'));

// «Выйти из аккаунта» — в настройках (см. index.html #auth-signout-btn),
// отдельно от «Сменить профиль» (та не трогает сессию — нужна тренеру для
// быстрого переключения между клиентами без повторного ввода пароля).
document.getElementById("auth-signout-btn").addEventListener("click", async () => {
  closeModal(settingsModalBackdrop);
  try{await Auth.signOut();location.reload();}catch(error){alert(error.message);}
});

// ---- переопределение renderProfiles() из app.js ----
// renderProfiles() теперь вызывается из МНОГИХ мест (клик по чипу профиля,
// «Сменить профиль», отправка формы входа, bootAuthAware) и внутри себя ждёт
// сеть (DB.myProfile/myClients) — два конкурентных вызова могут переплестись:
// младший (запущенный раньше) допишет в listView УЖЕ ПОСЛЕ того, как более
// новый вызов её очистил и заполнил актуально, задваивая карточки. _renderGen
// — простой «номер поколения»: после каждого await проверяем, что мы всё ещё
// самый свежий вызов, и если нет — тихо прекращаем работу, не трогая DOM.
let _renderGen = 0;
async function renderProfiles() {
  const myGen = ++_renderGen;
  const authView = document.getElementById("auth-form-view");
  const listView = document.getElementById("profile-list");
  const subtitle = document.getElementById("profile-subtitle");

  if (!Auth.isSignedIn()) {
    authView.style.display = "";
    listView.style.display = "none";
    listView.innerHTML = "";
    subtitle.textContent = "Войдите, чтобы продолжить";
    updateAuthFormMode();
    return;
  }

  authView.style.display = "none";
  listView.style.display = "";
  listView.innerHTML = `<div class="profile-card" style="justify-content:center;color:var(--text-secondary)">Загрузка…</div>`;

  // Тупиковые состояния (сеть недоступна / профиль удалён — напр. сам себя
  // удалил и потом залогинился тем же email+паролем: аккаунт Supabase Auth
  // остаётся жив, а строку profiles мы стереть уже не можем) раньше показывали
  // текст «выйдите и войдите заново» БЕЗ единой кнопки выйти — тупик в буквальном
  // смысле, из него некуда было деться. Теперь всегда даём кнопку «Выйти».
  function renderStuck(message) {
    listView.innerHTML = `
      <div class="auth-error" style="margin-bottom:12px">${escHtml(message)}</div>
      <button class="btn-chip primary" id="stuck-signout-btn" type="button" style="width:100%">Выйти</button>`;
    document.getElementById("stuck-signout-btn").addEventListener("click", async () => {
      try{await Auth.signOut();location.reload();}catch(error){alert(error.message);}
    });
  }

  let me;
  try {
    me = await DB.myProfile();
  } catch (e) {
    if (myGen !== _renderGen) return; // подоспел более новый вызов — не мешаем ему
    renderStuck("Не удалось загрузить профиль: " + e.message);
    return;
  }
  if (myGen !== _renderGen) return;
  if (!me) {
    renderStuck("Профиль не найден для этого аккаунта (возможно, был удалён). Выйдите и попробуйте другой аккаунт, либо зарегистрируйтесь заново.");
    return;
  }

  const enterProfile = async (profile) => {
    // Регистрируем реальный профиль в DATA.USERS, чтобы штатный refreshMenu
    // (app.js) нашёл его по id и отрисовал чип с именем/инициалом — id теперь
    // uuid, а не хардкоженные dima/natela. Заодно это чинит легаси-импорт,
    // который тоже опирается на DATA.USERS.
    registerUser(profile);
    const profileId = profile.id;
    // Не удаляем историю других профилей: наличие очереди не доказывает,
    // что все локальные изменения уже сохранены в облаке.
    DATA.setCurrentUser(profileId);
    reviewLegacyDraft(profileId);
    goToScreen("menu");
    onProfileEnter(profileId);
    _menuHydrating = true;
    updateOnlineStatus();
    // Сперва дослать в облако всё, что ждёт в очереди (в т.ч. правки прежде
    // просматриваемого профиля), затем читать — чтобы hydrate не откатил
    // локальное устаревшим облаком (та же гонка, что и в bootAuthAware).
    const noticeEpoch = window.__syncNoticeEpoch || 0;
    try { await Outbox.flush(); } catch {}
    try {
      showHydrateResult(await Bridge.hydrate(profileId), false, noticeEpoch);
    } catch (e) {
      // Синк не прошёл — не молчим (пользователь должен знать), но и не рушим
      // вход: локальные данные local-first остаются на экране.
      console.warn("enterProfile: hydrate", e);
      showSyncError(e, 'history', { automatic: true, epoch: noticeEpoch });
    }
    _menuHydrating = false;
    if (screenMenu.classList.contains("active")) refreshMenu();
    refreshSettingsButtons();
  };

  // Клиент без клиентов-подопечных — сразу входим в свой профиль, без лишнего клика.
  if (me.role !== "trainer") {
    subtitle.textContent = "Входим…";
    listView.innerHTML = "";
    await enterProfile(me);
    return;
  }

  subtitle.textContent = "Кого тренируем?";
  // ВАЖНО: listView НЕ чистим здесь — «Загрузка…» остаётся на экране, пока не
  // соберём ВЕСЬ список (свой профиль + клиенты) целиком в отдельном
  // фрагменте, вне DOM. Раньше свой профиль вставлялся сразу, а карточки
  // клиентов — только после отдельного await DB.myClients() чуть позже:
  // список визуально «дёргался» (сначала одна карточка, потом остальные
  // рывком). Теперь единственная подмена DOM происходит одним кадром, когда
  // уже всё готово — ощущается бесшовно.

  function makeCard(profile, meta) {
    const card = document.createElement("button");
    card.className = "profile-card";
    const initial = (profile.name || "?").trim().charAt(0).toUpperCase() || "?";
    card.innerHTML = `
      <span class="avatar" style="background:var(--panel-hi);color:var(--accent-bright)">${escHtml(initial)}</span>
      <span class="profile-info">
        <span class="profile-name">${escHtml(profile.name || "Без имени")}</span>
        ${meta ? `<span class="profile-meta">${escHtml(meta)}</span>` : ""}
      </span>
      <span class="profile-chevron"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span>
    `;
    card.addEventListener("click", () => enterProfile(profile));
    return card;
  }

  let clients = [];
  try { clients = await DB.myClients(); }
  catch (e) { console.warn("auth-ui: myClients", e); }
  if (myGen !== _renderGen) return; // более новый вызов уже перерисовал список — не дублируем

  const frag = document.createDocumentFragment();
  frag.appendChild(makeCard(me, "Моя тренировка"));
  if (clients.length) {
    const title = document.createElement("div");
    title.className = "profile-list-section-title";
    title.textContent = "Клиенты";
    frag.appendChild(title);
    clients.forEach(c => frag.appendChild(makeCard(c, c.auth_id ? "Сам ведёт тренировки" : "Веду за него/неё")));
  }
  const actions = document.createElement("div");
  actions.className = "profile-list-actions";
  actions.innerHTML = `
    <button class="btn-chip" id="add-managed-client-btn" type="button">+ Клиент</button>
    <button class="btn-chip" id="gen-invite-btn" type="button">Код приглашения</button>
  `;
  frag.appendChild(actions);

  listView.innerHTML = "";     // убираем «Загрузка…» и...
  listView.appendChild(frag);  // ...сразу вставляем готовый список — одним кадром.

  document.getElementById("add-managed-client-btn").addEventListener("click", async () => {
    const name = prompt("Имя нового клиента:");
    if (!name || !name.trim()) return;
    try { await DB.createManagedClient(name.trim()); await renderProfiles(); }
    catch (e) { alert("Не удалось создать клиента: " + e.message); }
  });
  document.getElementById("gen-invite-btn").addEventListener("click", () => openInviteModal());
}

// Модалка «Код приглашения»: кому выдать доступ.
//  • Управляемому клиенту (без логина) — инвайт привязывается к ЕГО профилю, при
//    регистрации клиент «захватит» его вместе со всей накопленной историей.
//  • Новому человеку — обычный инвайт, создаст свежий профиль, связанный с тренером.
async function openInviteModal() {
  let clients = [];
  try { clients = await DB.myClients(); }
  catch (e) { alert("Не удалось загрузить клиентов: " + e.message); return; }
  const managed = clients.filter(c => !c.auth_id);

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop open";
  backdrop.id = "invite-modal";
  const managedBtns = managed.map(c =>
    `<button class="btn-chip" type="button" data-claim="${escHtml(c.id)}" style="width:100%;margin-bottom:8px">Дать доступ: ${escHtml(c.name || "клиент")}</button>`
  ).join("");
  backdrop.innerHTML = `
    <div class="modal modal-form modal-scroll">
      <h2 class="modal-title">Пригласить клиента</h2>
      <p style="margin:0 0 14px;color:var(--text-secondary);font-size:13.5px;line-height:1.5">
        Клиент регистрируется по коду сам (свой email и пароль). Если выдать
        доступ существующему клиенту — при регистрации он получит свой профиль
        со всей уже накопленной историей.</p>
      ${managed.length ? `<div style="margin-bottom:6px;font-size:12px;color:var(--text-3)">Мои клиенты без логина:</div>${managedBtns}` : ""}
      <button class="btn-chip" type="button" data-claim="" style="width:100%;margin-bottom:8px">Пригласить нового человека</button>
      <div class="auth-error" id="invite-result" style="color:var(--text-secondary);white-space:pre-line"></div>
      <div class="modal-form-actions">
        <button class="btn-chip" id="invite-close" type="button">Закрыть</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const result = backdrop.querySelector("#invite-result");
  const close = () => backdrop.remove();
  backdrop.querySelector("#invite-close").addEventListener("click", close);
  backdrop.addEventListener("click", e => { if (e.target === backdrop) close(); });

  backdrop.querySelectorAll("button[data-claim]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const claimId = btn.dataset.claim || null;
      result.style.color = "var(--text-secondary)";
      result.textContent = "Создаём код…";
      try {
        const code = await DB.createInvite(claimId, 14);
        result.style.color = "var(--green)";
        result.textContent =
          `Код (14 дней): ${code}\n\n` +
          `Передай его клиенту. Пусть зарегистрируется (email + пароль на ` +
          `экране входа), затем в Настройках нажмёт «Ввести код приглашения» ` +
          `и впишет этот код.`;
      } catch (e) {
        result.style.color = "var(--red)";
        result.textContent = "Не удалось создать код: " + e.message;
      }
    });
  });
}

// Keep the old DOM/drafts in place, but require an explicit reload before reuse.
function showChangedAuthContext() {
  if (document.getElementById("auth-context-changed")) return;
  const dialog = document.createElement("dialog");
  dialog.id = "auth-context-changed";
  dialog.className = "modal";
  dialog.style.cssText = "max-width:420px;width:calc(100% - 32px);color:var(--text-primary);background:var(--bg-base);padding:24px";
  dialog.setAttribute("aria-labelledby", "auth-context-title");
  dialog.innerHTML = `<h2 id="auth-context-title">Вкладка приостановлена</h2>
    <p data-auth-context-reason></p>
    <p>Сохранённые локальные записи не удалены. При перезагрузке незавершённый ввод в формах может потеряться.</p>
    <button type="button" class="btn-chip primary">Перезагрузить вкладку</button>`;
  dialog.querySelector("[data-auth-context-reason]").textContent = Auth.contextReason();
  dialog.addEventListener("cancel", event => event.preventDefault());
  dialog.querySelector("button").addEventListener("click", () => location.reload());
  document.body.appendChild(dialog);
  dialog.showModal();
}
window.addEventListener("train-auth-context-changed", showChangedAuthContext);
if (Auth.contextChanged()) showChangedAuthContext();

/* ---- auth-aware boot ----
   init() в app.js уже отработал синхронно в конце app.js, но до загрузки
   Auth/Bridge. Здесь, когда всё загружено, приводим стартовый экран к
   реальному состоянию сессии и выполняем cloud-hydrate. */
(async function bootAuthAware() {
  if (Auth.contextChanged()) return;
  const noticeEpoch = window.__syncNoticeEpoch || 0;
  let resumedManualRefresh = false;
  try { resumedManualRefresh = sessionStorage.getItem(MANUAL_REFRESH_KEY) === "1"; } catch {}
  if (resumedManualRefresh) showSyncProgress('queue');
  // ВАЖНО: ДОЖИДАЕМСЯ флаша очереди ДО hydrate. Иначе флаш (отправка локальных
  // правок в облако) и hydrate (чтение облака обратно) шли параллельно — hydrate
  // мог прочитать облако раньше, чем туда доехали правки, и откатить локальное.
  // Теперь: сперва проталкиваем локальное в облако, потом читаем — облако уже
  // актуально. Оффлайн/ошибка флаша — не блокируем загрузку (hydrate ниже сам
  // не тронет локальное, пока правка висит в очереди, см. Bridge.hydrate).
  if (Auth.isSignedIn()) { try { await Outbox.flush(); } catch {} }
  const currentUser = DATA.getCurrentUser();
  if (Auth.isSignedIn() && currentUser) {
    // app.js init уже увёл на меню — дотягиваем данные из облака новым путём.
    // Профиль (свой ИЛИ клиента, которого вёл тренер) регистрируем в
    // DATA.USERS, чтобы refreshMenu отрисовал чип с именем. Если профиль не
    // читается (напр. стал недоступен) — возвращаемся к экрану входа.
    _menuHydrating = true;
    updateOnlineStatus();
    let stage = 'profile';
    try {
      const profile = await DB.getProfile(currentUser);
      if (!profile) {
        if (resumedManualRefresh) showSyncError("Профиль недоступен этому аккаунту.", 'profile');
        DATA.clearCurrentUser(); goToScreen("profile"); await renderProfiles(); return;
      }
      registerUser(profile);
      reviewLegacyDraft(currentUser);
      const result = await Bridge.hydrate(currentUser, { onProgress: next => {
        stage = next;
      } });
      if (noticeEpoch === (window.__syncNoticeEpoch || 0)) showHydrateResult(result, resumedManualRefresh, noticeEpoch);
    } catch (e) {
      // Раньше ошибка тут терялась в console.warn — пользователь ничего не
      // видел (та самая ситуация с Нателой: молчаливый сбой). Теперь видно
      // тостом — актуально и для обычной загрузки, и для кнопки «Синхронизация»
      // (перезагрузка страницы проходит через этот же путь).
      console.warn("bootAuthAware: hydrate", e);
      showSyncError(e, stage, { automatic: true, epoch: noticeEpoch });
    } finally {
      _menuHydrating = false;
      if (resumedManualRefresh) {
        try { sessionStorage.removeItem(MANUAL_REFRESH_KEY); } catch {}
      }
    }
    if (screenMenu.classList.contains("active")) refreshMenu();
    refreshSettingsButtons();
  } else {
    // Нет сессии ИЛИ профиль не выбран → форма входа / переключатель профиля.
    // clearCurrentUser защищает от «залипшего» локального профиля без сессии
    // (иначе app.js init мог показать чужие локальные данные без входа).
    if (!Auth.isSignedIn()) DATA.clearCurrentUser();
    if (resumedManualRefresh) {
      try { sessionStorage.removeItem(MANUAL_REFRESH_KEY); } catch {}
      showSyncError("Для синхронизации требуется вход.", 'session');
    }
    goToScreen("profile");
    await renderProfiles();
  }
})();

// Версия приложения в шапке меню (см. config.js APP_VERSION и правило её
// изменения). Простое присвоение, без зависимости от bootAuthAware.
const _versionEl = document.getElementById("app-version");
if (_versionEl) _versionEl.textContent = "v" + APP_VERSION;
const _settingsVersionEl = document.getElementById('settings-app-version');
if (_settingsVersionEl) _settingsVersionEl.textContent = 'Версия ' + APP_VERSION;

// Queue recovery is available through the clickable sync status → details.
