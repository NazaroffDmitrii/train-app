/*
 * auth.js — клиент Supabase Auth (GoTrue) поверх сырого fetch.
 *
 * Осознанно без supabase-js: остальной проект (storage.js) уже говорит с
 * PostgREST напрямую через fetch, и та же логика тут — не тащить SDK в PWA
 * ради консистентности стиля и офлайн-кэша Service Worker'а (см. sw.js —
 * кэшируется только APP_SHELL, лишний внешний бандл туда не хочется).
 *
 * Отвечает только за сессию (вход/регистрация/выход/refresh) и за то, чтобы у
 * db.js всегда был свежий access_token. Не знает о профилях/ролях — это уровень
 * db.js (таблица profiles).
 */

const Auth = (() => {
  const SESSION_KEY = "train_auth_session";
  const EPOCH_KEY = "train_auth_logout_epoch";
  // Проактивно обновляем токен за минуту до истечения, чтобы обычный запрос
  // никогда не словил 401 из-за протухшего JWT.
  const REFRESH_MARGIN_MS = 60_000;
  const REQUEST_TIMEOUT_MS = 15_000;

  function base() { return `${CONFIG.SUPABASE_URL}/auth/v1`; }
  function apiKeyHeader() { return { apikey: CONFIG.SUPABASE_KEY }; }

  async function request(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (e) {
      if (controller.signal.aborted) throw new Error("Сервер не ответил за 15 секунд");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      const stored = raw ? JSON.parse(raw) : null;
      const epoch = localStorage.getItem(EPOCH_KEY);
      // A durable logout marker also invalidates tokens whose removal failed.
      if ((stored?._authEpoch || null) !== epoch) return null;
      if (!stored?.user?.id || typeof stored.access_token !== "string" || !stored.access_token ||
          typeof stored.refresh_token !== "string" || !stored.refresh_token ||
          !Number.isFinite(stored.expires_at)) return null;
      return stored;
    } catch { return null; }
  }
  function storeSession(session) {
    try {
      session._authEpoch = observedEpoch;
      const raw = JSON.stringify(session);
      localStorage.setItem(SESSION_KEY, raw);
      if (localStorage.getItem(SESSION_KEY) !== raw) throw new Error("write not retained");
      observedRaw = raw;
    } catch { throw storageFailure(); }
  }
  function clearSession() {
    try {
      const epoch = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
      localStorage.setItem(EPOCH_KEY, epoch);
      if (localStorage.getItem(EPOCH_KEY) !== epoch) throw new Error("logout marker not retained");
      observedEpoch = epoch;
      localStorage.removeItem(SESSION_KEY);
      if (localStorage.getItem(SESSION_KEY) !== null) throw new Error("session not removed");
      observedRaw = null;
    } catch { throw storageFailure(); }
  }

  let session = loadSession();
  let refreshInFlight = null;
  let generation = 0;
  let observedRaw;
  let observedEpoch;
  try { observedRaw = localStorage.getItem(SESSION_KEY); observedEpoch = localStorage.getItem(EPOCH_KEY); } catch {}
  let contextChanged = false;
  let contextReason = "Сессия изменилась в другой вкладке или её хранилище недоступно. Отправка данных из этой вкладки остановлена.";
  function storageFailure() {
    const error = new Error("Не удалось сохранить изменение сессии. Вход или выход не подтверждён. Перезагрузка сама по себе не гарантирует выход; проверьте хранилище браузера.");
    error.code = "AUTH_STORAGE_ERROR";
    pauseContext(error.message);
    return error;
  }
  function pauseContext(reason) {
    if (contextChanged) return;
    if (reason) contextReason = reason;
    contextChanged = true;
    generation++;
    refreshInFlight = null;
    session = null; // Never erase the other tab's session or adopt its account.
    if (typeof window !== "undefined") window.dispatchEvent(new Event("train-auth-context-changed"));
  }
  function reconcileSession() {
    if (contextChanged) return;
    let raw;
    try {
      if (localStorage.getItem(EPOCH_KEY) !== observedEpoch) { pauseContext(); return; }
      raw = localStorage.getItem(SESSION_KEY);
    } catch { pauseContext(); return; }
    if (raw === observedRaw) return;
    observedRaw = raw;
    let next;
    try { next = JSON.parse(raw); } catch {}
    if ((next?._authEpoch || null) !== observedEpoch || !session?.user?.id || next?.user?.id !== session.user.id ||
        typeof next.access_token !== "string" || !next.access_token ||
        typeof next.refresh_token !== "string" || !next.refresh_token ||
        !Number.isFinite(next.expires_at)) { pauseContext(); return; }
    generation++;
    session = next;
  }
  function assertContext() {
    reconcileSession();
    if (contextChanged) {
      const error = new Error("Аккаунт изменился в другой вкладке. Перезагрузите эту вкладку.");
      error.code = "ACCOUNT_CHANGED";
      throw error;
    }
  }
  if (typeof window !== "undefined") {
    window.addEventListener("storage", event => {
      if (event.storageArea && event.storageArea !== localStorage) return;
      if (event.key === EPOCH_KEY) {
        if (event.newValue !== observedEpoch) pauseContext();
        return;
      }
      if (event.key !== null && event.key !== SESSION_KEY) return;
      // Observe intermediate logout/account changes even if storage has changed again.
      let next;
      try { next = JSON.parse(event.newValue); } catch {}
      if (!next?.user?.id || next.user.id !== session?.user?.id) pauseContext();
      else reconcileSession();
    });
    window.addEventListener("focus", reconcileSession);
  }
  function beginAuthChange() { assertContext(); generation++; refreshInFlight = null; return generation; }
  function assertGeneration(expected) {
    assertContext();
    if (expected !== generation) {
      const error = new Error("Сессия изменилась. Устаревший ответ проигнорирован.");
      error.code = "ACCOUNT_CHANGED";
      throw error;
    }
  }

  function fromTokenResponse(json) {
    if (typeof json?.access_token !== "string" || !json.access_token ||
        typeof json.refresh_token !== "string" || !json.refresh_token ||
        typeof json.user?.id !== "string" || !json.user.id ||
        (json.expires_in != null && (!Number.isFinite(Number(json.expires_in)) || Number(json.expires_in) <= 0))) {
      throw new Error("Некорректный ответ сервера авторизации");
    }
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: Date.now() + (json.expires_in || 3600) * 1000,
      user: { id: json.user?.id, email: json.user?.email },
    };
  }

  // Supabase (GoTrue) отдаёт сообщения об ошибках на английском — они шли на
  // экран как есть ("Invalid login credentials" и т.п.). Переводим известные
  // формулировки; неизвестные оставляем как есть (лучше английский текст, чем
  // потерять содержание ошибки).
  const AUTH_ERROR_RU = [
    [/invalid login credentials/i, "Неверный email или пароль"],
    [/user already registered/i, "Пользователь с таким email уже зарегистрирован"],
    [/email not confirmed/i, "Email не подтверждён"],
    [/password should be at least/i, "Пароль слишком короткий (минимум 6 символов)"],
    [/unable to validate email address/i, "Некорректный формат email"],
    [/user not found/i, "Пользователь не найден"],
    [/email rate limit exceeded/i, "Слишком много попыток — попробуйте чуть позже"],
    [/signup requires a valid password/i, "Введите пароль"],
    [/network/i, "Нет соединения с сервером"],
  ];
  function translateAuthError(msg) {
    const hit = AUTH_ERROR_RU.find(([re]) => re.test(msg));
    return hit ? hit[1] : msg;
  }

  async function parseAuthError(res) {
    let msg = `HTTP ${res.status}`;
    let code;
    try {
      const j = await res.json();
      msg = j.error_description || j.msg || j.error || msg;
      code = j.error_code || j.code;
    } catch {}
    const error = new Error(`HTTP ${res.status}: ${translateAuthError(String(msg))}`);
    error.status = res.status;
    error.code = code;
    return error;
  }

  // ---- регистрация -----------------------------------------------------
  // meta: { name, role } — попадает в user_metadata, триггер handle_new_user
  // (см. supabase-setup.sql) создаёт из этого строку profiles.
  async function signUp(email, password, meta = {}) {
    const expected = beginAuthChange();
    const res = await request(`${base()}/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...apiKeyHeader() },
      body: JSON.stringify({ email, password, data: meta }),
    });
    if (!res.ok) throw await parseAuthError(res);
    const json = await res.json();
    assertGeneration(expected);
    // При включённом email-confirm сервер не возвращает access_token сразу.
    if (json.access_token) {
      session = fromTokenResponse(json);
      storeSession(session);
    }
    return json;
  }

  // ---- вход --------------------------------------------------------------
  async function signIn(email, password) {
    const expected = beginAuthChange();
    const res = await request(`${base()}/token?grant_type=password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...apiKeyHeader() },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw await parseAuthError(res);
    const json = await res.json();
    assertGeneration(expected);
    session = fromTokenResponse(json);
    storeSession(session);
    return session;
  }

  // ---- выход ---------------------------------------------------------------
  async function signOut() {
    const s = session;
    beginAuthChange();
    session = null;
    let localError;
    try { clearSession(); } catch (error) { localError = error; }
    if (s?.access_token) {
      try {
        await request(`${base()}/logout`, {
          method: "POST",
          headers: { Authorization: `Bearer ${s.access_token}`, ...apiKeyHeader() },
        });
      } catch { /* локальный выход важнее сетевого — не блокируем на ошибке */ }
    }
    if (localError) throw localError;
  }

  // ---- refresh ---------------------------------------------------------
  function refresh() {
    try { assertContext(); } catch (e) { return Promise.reject(e); }
    if (!session?.refresh_token) return Promise.reject(new Error("Нет сессии для обновления"));
    if (refreshInFlight) return refreshInFlight;
    const expected = generation, source = session;
    const run = async () => {
      assertContext();
      // Another tab may have rotated the token while we waited for its lock.
      if (session !== source && session?.user?.id === source.user?.id &&
          session.expires_at - Date.now() > REFRESH_MARGIN_MS) return session;
      assertGeneration(expected);
      const res = await request(`${base()}/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiKeyHeader() },
        body: JSON.stringify({ refresh_token: source.refresh_token }),
      });
      if (!res.ok) {
        const error = await parseAuthError(res);
        assertGeneration(expected);
        // Сбрасываем только явно отозванную/истёкшую сессию. 429/5xx,
        // конфликты, ошибки gateway и неизвестные отказы не означают logout.
        const invalid = ["refresh_token_not_found", "refresh_token_already_used", "session_expired", "session_not_found", "user_not_found"].includes(error.code) ||
          (!error.code && /invalid refresh token|refresh token not found|refresh token already used/i.test(error.message));
        if (error.status >= 400 && error.status < 500 && error.status !== 429 && invalid) {
          session = null;
          clearSession();
        }
        throw error;
      }
      const json = await res.json();
      assertGeneration(expected);
      const next = fromTokenResponse(json);
      if (next.user.id !== source.user?.id) throw new Error("Ответ обновления относится к другому аккаунту");
      session = next;
      storeSession(session);
      return session;
    };
    const withLock = async () => {
      if (typeof navigator === "undefined" || !navigator.locks?.request) return run();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        return await navigator.locks.request("train-auth-refresh", { signal: controller.signal }, () => {
          clearTimeout(timer); // Only the lock wait is timed here; HTTP has its own timeout.
          return run();
        });
      } catch (error) {
        if (controller.signal.aborted) throw new Error("Обновление сессии занято другой вкладкой. Повторите попытку.");
        throw error; // Do not bypass a failed lock with an uncoordinated request.
      } finally { clearTimeout(timer); }
    };
    const task = withLock().finally(() => { if (refreshInFlight === task) refreshInFlight = null; });
    refreshInFlight = task;
    return task;
  }

  // Гарантирует валидный access_token перед запросом к PostgREST/RPC.
  // Возвращает null, если сессии нет вообще (гость, экран входа).
  async function ensureFreshSession() {
    assertContext();
    if (!session) return null;
    if (session.expires_at - Date.now() > REFRESH_MARGIN_MS) return session;
    try { return await refresh(); }
    catch (e) {
      // При сетевой ошибке refresh() сохраняет прежнюю локальную сессию.
      // Передаём временный/неизвестный отказ выше. Только подтверждённый
      // отзыв сессии или явный выход дают null, не истёкший access_token.
      if (session || contextChanged || e.code === "AUTH_STORAGE_ERROR") throw e;
      return null;
    }
  }

  function currentSession() { reconcileSession(); return session; }
  function isSignedIn() { return !!currentSession(); }
  function userId() { return currentSession()?.user?.id || null; }

  return {
    signUp, signIn, signOut, refresh, ensureFreshSession,
    currentSession, isSignedIn, userId,
    contextChanged: () => { reconcileSession(); return contextChanged; },
    contextReason: () => contextReason,
  };
})();
