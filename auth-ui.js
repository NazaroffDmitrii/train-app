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
    Outbox.flush();   // войдя, дослать всё, что ждало в очереди офлайн
    await renderProfiles();
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

// «В облако» — досылает очередь несинхронизированных правок ПРЯМО СЕЙЧАС
// (обычно она и так пуста — Bridge пушит сразу после каждого изменения;
// кнопка даёт явное подтверждение и ручной повтор, если что-то зависло).
document.getElementById("sync-upload-btn").addEventListener("click", async () => {
  closeModal(settingsModalBackdrop);
  try {
    const res = await Outbox.flush();
    if (res.skipped === "offline") showToast("Нет сети — попробуйте позже");
    else if (res.skipped === "no-session") showToast("Вы не авторизованы");
    else if (res.skipped === "in-flight") showToast("Уже отправляем…");
    else if (res.failed > 0) showToast(`Отправлено ${res.sent}, ошибка на ${res.failed} — попробуйте ещё раз`);
    else if (res.sent > 0) showToast(`Отправлено в облако: ${res.sent}`);
    else showToast("Всё уже в облаке");
  } catch (e) {
    showToast("Ошибка отправки: " + (e.message || "неизвестная"));
  } finally {
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
  if (!viewedId) return;
  let profile;
  try { profile = await DB.getProfile(viewedId); }
  catch (e) { alert("Не удалось загрузить данные: " + e.message); return; }
  if (!profile) { alert("Профиль не найден."); return; }

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
    </div>`;
  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();
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

// «Синхронизация» — двойное действие: (1) форсирует проверку обновления
// приложения (reg.update() тянет свежий sw.js; если версия новее — новый SW
// установится, активируется и controllerchange в app.js сам перезагрузит
// страницу на свежий каркас); (2) перечитывает данные из облака (перезагрузка
// → bootAuthAware → Bridge.hydrate). Раньше тут был голый location.reload(),
// который НЕ обновлял приложение (старый SW отдавал старый кэш) — из-за этого
// и приходилось сносить иконку с рабочего стола.
document.getElementById("sync-reload-btn").addEventListener("click", async () => {
  closeModal(settingsModalBackdrop);
  showToast("Обновляем…");
  try {
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) await reg.update();
    }
  } catch { /* не смогли проверить SW — всё равно перезагрузимся ниже */ }
  // Если новая версия нашлась — controllerchange (app.js) перезагрузит раньше
  // этой строки (там стоит guard от двойной перезагрузки). Если новой версии
  // нет — этот reload просто перечитает данные из облака.
  location.reload();
});

// Удаление — необратимо, поэтому через подтверждение (openConfirmModal из
// app.js). Режим (свой аккаунт / управляемый клиент) и цель определяются в
// refreshSettingsButtons и лежат в dataset кнопки — обработчик оперирует
// ЯВНЫМ targetId, а не «текущей сессией».
document.getElementById("delete-account-btn").addEventListener("click", (e) => {
  const btn = e.currentTarget;
  const mode = btn.dataset.mode;               // "self" | "managed"
  const targetId = btn.dataset.targetId;
  closeModal(settingsModalBackdrop);

  if (mode === "managed") {
    openConfirmModal({
      title: "Удалить клиента?",
      message: "Профиль клиента и вся его история (тренировки, упражнения, шаблоны) будут удалены из облака безвозвратно. Отменить нельзя.",
      confirmLabel: "Удалить",
      danger: true,
      onConfirm: async () => {
        try {
          await DB.deleteManagedClient(targetId);
          // Мы смотрели этого клиента — возвращаемся к переключателю тренера.
          DATA.clearCurrentUser();
          goToScreen("profile");
          await renderProfiles();
          showToast("Клиент удалён");
        } catch (err) {
          alert("Не удалось удалить клиента: " + (err.message || "ошибка"));
        }
      },
    });
    return;
  }

  // mode === "self" (или отсутствует — трактуем как своё, безопасный дефолт).
  openConfirmModal({
    title: "Удалить аккаунт?",
    message: "Профиль и вся его история (тренировки, упражнения, шаблоны) будут удалены из облака безвозвратно. Отменить нельзя.",
    confirmLabel: "Удалить",
    danger: true,
    onConfirm: async () => {
      try {
        await DB.deleteMyAccount();
        await Auth.signOut();
        Bridge.reset();
        DATA.clearCurrentUser();
        goToScreen("profile");
        await renderProfiles();
        showToast("Аккаунт удалён");
      } catch (err) {
        alert("Не удалось удалить аккаунт: " + (err.message || "ошибка"));
      }
    },
  });
});

// «Ввести код приглашения» — основной (и единственный) способ клиента
// привязаться к тренеру: сначала обычная регистрация (email+пароль, без
// кода), затем здесь код заявляется отдельно — «захватывает» управляемый
// профиль тренера со всей накопленной историей, если код был на него
// привязан, либо просто линкует текущий профиль к тренеру.
document.getElementById("enter-invite-btn").addEventListener("click", async () => {
  const code = prompt("Введите код приглашения от тренера:");
  if (!code || !code.trim()) return;
  try {
    await DB.claimInvite(code.trim());
    closeModal(settingsModalBackdrop);
    // Профиль мог смениться (захват управляемого профиля) — перечитываем сессию
    // с чистого листа, bootAuthAware сам разрулит и подтянет данные из облака.
    DATA.clearCurrentUser();
    Bridge.reset();
    location.reload();
  } catch (e) {
    alert("Не удалось применить код: " + (e.message || "ошибка"));
  }
});

// «Выйти из аккаунта» — в настройках (см. index.html #auth-signout-btn),
// отдельно от «Сменить профиль» (та не трогает сессию — нужна тренеру для
// быстрого переключения между клиентами без повторного ввода пароля).
document.getElementById("auth-signout-btn").addEventListener("click", async () => {
  closeModal(settingsModalBackdrop);
  await Auth.signOut();
  Bridge.reset();
  DATA.clearCurrentUser();
  goToScreen("profile");
  // goToScreen больше не дёргает renderProfiles() сама (см. её комментарий в
  // app.js) — здесь единственное место, где после неё явно ничего не звалось;
  // после signOut() экран без этого остался бы со старым содержимым.
  await renderProfiles();
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
      await Auth.signOut();
      Bridge.reset();
      DATA.clearCurrentUser();
      await renderProfiles();
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
    // Ограничиваем локальный след: выкидываем тяжёлые данные других облачных
    // профилей (при возврате hydrate вернёт их из облака). См. Bridge.evictOtherProfiles.
    Bridge.evictOtherProfiles(profileId);
    DATA.setCurrentUser(profileId);
    goToScreen("menu");
    onProfileEnter(profileId);
    _menuHydrating = true;
    updateOnlineStatus();
    await Bridge.hydrate(profileId);
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

/* ---- auth-aware boot ----
   init() в app.js уже отработал синхронно в конце app.js — но ДО загрузки
   этого файла, поэтому он использовал старый путь (Sync.hydrateUser — теперь
   no-op) и не знает про Auth/Bridge. Здесь, когда всё загружено, приводим
   стартовый экран к реальному состоянию сессии. */
(async function bootAuthAware() {
  if (Auth.isSignedIn()) Outbox.flush();   // на старте дослать очередь оффлайн-правок
  const currentUser = DATA.getCurrentUser();
  if (Auth.isSignedIn() && currentUser) {
    // app.js init уже увёл на меню — дотягиваем данные из облака новым путём.
    // Профиль (свой ИЛИ клиента, которого вёл тренер) регистрируем в
    // DATA.USERS, чтобы refreshMenu отрисовал чип с именем. Если профиль не
    // читается (напр. стал недоступен) — возвращаемся к экрану входа.
    _menuHydrating = true;
    updateOnlineStatus();
    try {
      const profile = await DB.getProfile(currentUser);
      if (!profile) { DATA.clearCurrentUser(); goToScreen("profile"); await renderProfiles(); return; }
      registerUser(profile);
      await Bridge.hydrate(currentUser);
    } catch (e) {
      // Раньше ошибка тут терялась в console.warn — пользователь ничего не
      // видел (та самая ситуация с Нателой: молчаливый сбой). Теперь видно
      // тостом — актуально и для обычной загрузки, и для кнопки «Синхронизация»
      // (перезагрузка страницы проходит через этот же путь).
      console.warn("bootAuthAware: hydrate", e);
      showToast("Не удалось синхронизироваться: " + (e.message || "ошибка сети"));
    }
    _menuHydrating = false;
    if (screenMenu.classList.contains("active")) refreshMenu();
    refreshSettingsButtons();
  } else {
    // Нет сессии ИЛИ профиль не выбран → форма входа / переключатель профиля.
    // clearCurrentUser защищает от «залипшего» локального профиля без сессии
    // (иначе app.js init мог показать чужие локальные данные без входа).
    if (!Auth.isSignedIn()) DATA.clearCurrentUser();
    goToScreen("profile");
    await renderProfiles();
  }
})();

// Версия приложения в шапке меню (см. config.js APP_VERSION и правило её
// изменения). Простое присвоение, без зависимости от bootAuthAware.
const _versionEl = document.getElementById("app-version");
if (_versionEl) _versionEl.textContent = "v" + APP_VERSION;
