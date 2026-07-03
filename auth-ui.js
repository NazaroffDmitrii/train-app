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

// ---- видимость кнопок в модалке «Настройки» ----
// Одна функция вместо нескольких разрозненных — все проверки используют ОДИН
// и тот же DB.myProfile() (личность РЕАЛЬНОЙ залогиненной сессии), поэтому не
// могут разъехаться друг с другом. Правила:
//   • «Перенести старые данные» — видна, если на устройстве есть легаси-данные.
//   • «Сменить профиль» — видна ТОЛЬКО тренеру: у обычного клиента структурно
//     нет второго профиля, переключаться некуда (см. чат: решение пользователя).
//   • «Ввести код приглашения» — скрыта тренеру (вводить ему нечего, над ним
//     никого нет) И скрыта клиенту, который уже привязан хотя бы к одному
//     тренеру (повторный ввод уже ничего не даст).
//   • «Удалить аккаунт» — скрыта, если СЕЙЧАС ПРОСМАТРИВАЕТСЯ (переключателем)
//     чужой профиль: кнопка всегда удаляет РЕАЛЬНУЮ залогиненную сессию, а не
//     то, что на экране — показывать её при просмотре клиента было бы опасно
//     вводящей в заблуждение (ровно так чуть не удалили тренерский аккаунт,
//     пытаясь удалить тестового клиента).
async function refreshSettingsButtons() {
  const migrateBtn = document.getElementById("migrate-legacy-btn");
  const inviteBtn  = document.getElementById("enter-invite-btn");
  const switchBtn  = document.getElementById("switch-user-btn");
  const deleteBtn  = document.getElementById("delete-account-btn");

  if (migrateBtn) migrateBtn.style.display = (Auth.isSignedIn() && Migrate.detectLegacyProfiles().length > 0) ? "" : "none";

  if (!Auth.isSignedIn()) {
    if (inviteBtn) inviteBtn.style.display = "none";
    if (switchBtn) switchBtn.style.display = "none";
    if (deleteBtn) deleteBtn.style.display = "none";
    return;
  }

  let me = null;
  try { me = await DB.myProfile(); } catch {}
  const isTrainer = me?.role === "trainer";

  if (switchBtn) switchBtn.style.display = isTrainer ? "" : "none";
  if (deleteBtn) deleteBtn.style.display = (me && DATA.getCurrentUser() === me.id) ? "" : "none";

  if (inviteBtn) {
    if (!me) { inviteBtn.style.display = ""; }               // не смогли проверить — лучше показать, чем спрятать нужное
    else if (isTrainer) { inviteBtn.style.display = "none"; }
    else {
      try { inviteBtn.style.display = (await DB.hasAnyTrainer(me.id)) ? "none" : ""; }
      catch { inviteBtn.style.display = ""; }
    }
  }
}

async function openMigrationModal() {
  const legacy = Migrate.detectLegacyProfiles();
  if (!legacy.length) return;

  // Облачные цели: свой профиль + клиенты (для тренера).
  let me, clients = [];
  try {
    me = await DB.myProfile();
    if (me?.role === "trainer") clients = await DB.myClients();
  } catch (e) { alert("Не удалось загрузить облачные профили: " + e.message); return; }
  const targets = [me, ...clients].filter(Boolean);

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop open";
  backdrop.id = "migrate-modal";
  const optionsHtml = targets.map(t => `<option value="${escHtml(t.id)}">${escHtml(t.name || "Профиль")}</option>`).join("");
  backdrop.innerHTML = `
    <div class="modal modal-form modal-scroll">
      <h2 class="modal-title">Перенос старых данных</h2>
      <p style="margin:0 0 14px;color:var(--text-secondary);font-size:13.5px;line-height:1.5">
        На этом устройстве найдены данные прошлой версии. Выберите, в какой
        облачный профиль их перенести. Старые данные на устройстве не удаляются;
        повторный перенос не создаёт дубликатов.</p>
      <div id="migrate-rows"></div>
      <div class="auth-error" id="migrate-status"></div>
      <div class="modal-form-actions">
        <button class="btn-chip" id="migrate-cancel" type="button">Закрыть</button>
        <button class="btn-chip primary" id="migrate-run" type="button">Перенести</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const rowsEl = backdrop.querySelector("#migrate-rows");
  legacy.forEach(p => {
    const row = document.createElement("div");
    row.className = "ex-form-field";
    row.innerHTML = `
      <span class="ex-form-label">${escHtml(p.name)} — ${p.workouts} трен., ${p.exercises} упр., ${p.templates} шабл.</span>
      <select class="ex-form-input" data-legacy="${escHtml(p.id)}">
        <option value="">— не переносить —</option>
        ${optionsHtml}
      </select>`;
    rowsEl.appendChild(row);
  });

  const close = () => backdrop.remove();
  backdrop.querySelector("#migrate-cancel").addEventListener("click", close);
  backdrop.addEventListener("click", e => { if (e.target === backdrop) close(); });

  backdrop.querySelector("#migrate-run").addEventListener("click", async () => {
    const status = backdrop.querySelector("#migrate-status");
    const runBtn = backdrop.querySelector("#migrate-run");
    const mappings = [...backdrop.querySelectorAll("select[data-legacy]")]
      .map(s => ({ legacy: s.dataset.legacy, target: s.value }))
      .filter(m => m.target);
    if (!mappings.length) { status.textContent = "Выберите хотя бы один профиль для переноса."; return; }

    runBtn.disabled = true;
    status.style.color = "var(--text-secondary)";
    try {
      const createdBy = me.id;   // импортёр — текущий залогиненный профиль
      let total = { workouts: 0, exercises: 0, templates: 0 };
      for (const m of mappings) {
        status.textContent = `Переносим «${m.legacy}»…`;
        const r = await Migrate.importInto(m.legacy, m.target, createdBy);
        total.workouts += r.workouts; total.exercises += r.exercises; total.templates += r.templates;
      }
      Migrate.markDone();
      status.style.color = "var(--green)";
      status.textContent = `Готово: ${total.workouts} трен., ${total.exercises} упр., ${total.templates} шабл. перенесено.`;
      refreshSettingsButtons();
      // Если перенесли в текущий открытый профиль — подтянуть свежие данные.
      const cur = DATA.getCurrentUser();
      if (cur && mappings.some(m => m.target === cur)) {
        await Bridge.hydrate(cur);
        if (screenMenu.classList.contains("active")) refreshMenu();
      }
    } catch (e) {
      status.style.color = "var(--red)";
      status.textContent = "Ошибка переноса: " + e.message;
    } finally {
      runBtn.disabled = false;
    }
  });
}

document.getElementById("migrate-legacy-btn").addEventListener("click", () => {
  closeModal(settingsModalBackdrop);
  openMigrationModal();
});

// Второй обработчик клика по той же пилюле «Настройки», что уже слушает
// app.js (multiple addEventListener на одном элементе — не конфликтуют) —
// на случай, если что-то сменилось с прошлого раза (роль, привязка к
// тренеру, просматриваемый профиль), кнопки должны отражать текущее состояние.
const settingsPill = document.querySelector('.pill[data-action="settings"]');
if (settingsPill) settingsPill.addEventListener("click", () => { refreshSettingsButtons(); });

// ---- КОРЕНЬ БАГА С «ЛОГИН-ФОРМОЙ ПОСЛЕ СИНХРОНИЗАЦИИ» ----
// app.js (не тронутый) вешает на profile-chip (аватар в шапке меню) и на
// switch-user-btn обработчики, которые ПРОСТО переключают экран:
//   DATA.clearCurrentUser(); goToScreen("profile");
// без единого вызова renderProfiles(). Раньше (хардкоженные dima/natela) это
// было безопасно — карточки профилей рисовались один раз при первой загрузке
// и больше не менялись. Теперь renderProfiles() — асинхронная, показывает
// РАЗНОЕ в зависимости от состояния, и если она ни разу не была вызвана в
// этой загрузке страницы (частый случай: сессия сама восстановилась при
// старте, bootAuthAware идёт по быстрому пути сразу в меню, минуя
// renderProfiles) — экран #screen-profile так и остаётся с "сырым" HTML по
// умолчанию: форма входа ВИДНА (для неё нет display:none, пока JS явно не
// поставит), список профилей СКРЫТ. Клик по чипу/«Сменить профиль» открывал
// ровно эту сырую форму входа — iOS видел парольное поле и предлагал
// Face ID/автозаполнение (то самое фото 2). Фикс: довызываем renderProfiles()
// СРАЗУ после — она сама решит, что показать (переключатель тренеру, тихий
// возврат в свой единственный профиль клиенту, или форму входа, если сессия
// правда истекла). Второй addEventListener на тех же элементах — не мешает
// оригинальному обработчику из app.js, просто выполняется следом.
const profileChipEl = document.getElementById("profile-chip");
if (profileChipEl) profileChipEl.addEventListener("click", () => { renderProfiles(); });
document.getElementById("switch-user-btn").addEventListener("click", () => { renderProfiles(); });

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

// «Синхронизация» — перезагрузка страницы: обновляет само приложение до
// актуальной версии (новый Service Worker) И перечитывает данные из облака
// (bootAuthAware → Bridge.hydrate на старте). Если hydrate после перезагрузки
// упадёт — bootAuthAware сам покажет тост с ошибкой (см. ниже).
document.getElementById("sync-reload-btn").addEventListener("click", () => {
  location.reload();
});

// «Удалить аккаунт» — необратимо, поэтому через то же подтверждение, что и
// удаление тренировок/упражнений (openConfirmModal определена в app.js).
document.getElementById("delete-account-btn").addEventListener("click", () => {
  closeModal(settingsModalBackdrop);
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
      } catch (e) {
        alert("Не удалось удалить аккаунт: " + (e.message || "ошибка"));
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

  let me;
  try {
    me = await DB.myProfile();
  } catch (e) {
    if (myGen !== _renderGen) return; // подоспел более новый вызов — не мешаем ему
    listView.innerHTML = `<div class="auth-error">Не удалось загрузить профиль: ${escHtml(e.message)}</div>`;
    return;
  }
  if (myGen !== _renderGen) return;
  if (!me) {
    listView.innerHTML = `<div class="auth-error">Профиль не найден для этого аккаунта. Попробуйте выйти и войти заново.</div>`;
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
  listView.innerHTML = "";

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

  listView.appendChild(makeCard(me, "Моя тренировка"));

  let clients = [];
  try { clients = await DB.myClients(); }
  catch (e) { console.warn("auth-ui: myClients", e); }
  if (myGen !== _renderGen) return; // более новый вызов уже перерисовал список — не дублируем

  if (clients.length) {
    const title = document.createElement("div");
    title.className = "profile-list-section-title";
    title.textContent = "Клиенты";
    listView.appendChild(title);
    clients.forEach(c => listView.appendChild(makeCard(c, c.auth_id ? "Сам ведёт тренировки" : "Веду за него/неё")));
  }

  const actions = document.createElement("div");
  actions.className = "profile-list-actions";
  actions.innerHTML = `
    <button class="btn-chip" id="add-managed-client-btn" type="button">+ Клиент</button>
    <button class="btn-chip" id="gen-invite-btn" type="button">Код приглашения</button>
  `;
  listView.appendChild(actions);

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
