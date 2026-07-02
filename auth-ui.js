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
  document.getElementById("auth-invite-field").style.display = isSignup ? "" : "none";
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
      const inviteCode = document.getElementById("auth-invite-code").value.trim();
      if (inviteCode) {
        try { await DB.claimInvite(inviteCode); }
        catch (e) { console.warn("auth-ui: claimInvite при регистрации", e); }
      }
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

// ---- миграция старых локальных данных в облако ----
// Кнопка в настройках показывается только если на устройстве есть легаси-данные.
function refreshMigrateButton() {
  const btn = document.getElementById("migrate-legacy-btn");
  if (!btn) return;
  const has = Auth.isSignedIn() && Migrate.detectLegacyProfiles().length > 0;
  btn.style.display = has ? "" : "none";
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
      refreshMigrateButton();
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
async function renderProfiles() {
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
    listView.innerHTML = `<div class="auth-error">Не удалось загрузить профиль: ${escHtml(e.message)}</div>`;
    return;
  }
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
    refreshMigrateButton();
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
          `Передай его клиенту. Пусть на экране входа нажмёт «Нет аккаунта? ` +
          `Зарегистрироваться», введёт свой email и пароль, впишет этот код в ` +
          `поле приглашения и зарегистрируется.`;
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
    } catch (e) { console.warn("bootAuthAware: hydrate", e); }
    _menuHydrating = false;
    if (screenMenu.classList.contains("active")) refreshMenu();
    refreshMigrateButton();
  } else {
    // Нет сессии ИЛИ профиль не выбран → форма входа / переключатель профиля.
    // clearCurrentUser защищает от «залипшего» локального профиля без сессии
    // (иначе app.js init мог показать чужие локальные данные без входа).
    if (!Auth.isSignedIn()) DATA.clearCurrentUser();
    goToScreen("profile");
    await renderProfiles();
  }
})();
