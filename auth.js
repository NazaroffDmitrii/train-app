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
  // Проактивно обновляем токен за минуту до истечения, чтобы обычный запрос
  // никогда не словил 401 из-за протухшего JWT.
  const REFRESH_MARGIN_MS = 60_000;

  function base() { return `${CONFIG.SUPABASE_URL}/auth/v1`; }
  function apiKeyHeader() { return { apikey: CONFIG.SUPABASE_KEY }; }

  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function storeSession(session) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch {}
  }
  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch {}
  }

  let session = loadSession();
  let refreshInFlight = null;

  function fromTokenResponse(json) {
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: Date.now() + (json.expires_in || 3600) * 1000,
      user: { id: json.user?.id, email: json.user?.email },
    };
  }

  async function parseAuthError(res) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      msg = j.error_description || j.msg || j.error || msg;
    } catch {}
    return new Error(msg);
  }

  // ---- регистрация -----------------------------------------------------
  // meta: { name, role } — попадает в user_metadata, триггер handle_new_user
  // (см. supabase-setup.sql) создаёт из этого строку profiles.
  async function signUp(email, password, meta = {}) {
    const res = await fetch(`${base()}/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...apiKeyHeader() },
      body: JSON.stringify({ email, password, data: meta }),
    });
    if (!res.ok) throw await parseAuthError(res);
    const json = await res.json();
    // При включённом email-confirm сервер не возвращает access_token сразу.
    if (json.access_token) {
      session = fromTokenResponse(json);
      storeSession(session);
    }
    return json;
  }

  // ---- вход --------------------------------------------------------------
  async function signIn(email, password) {
    const res = await fetch(`${base()}/token?grant_type=password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...apiKeyHeader() },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw await parseAuthError(res);
    const json = await res.json();
    session = fromTokenResponse(json);
    storeSession(session);
    return session;
  }

  // ---- выход ---------------------------------------------------------------
  async function signOut() {
    const s = session;
    session = null;
    clearSession();
    if (s?.access_token) {
      try {
        await fetch(`${base()}/logout`, {
          method: "POST",
          headers: { Authorization: `Bearer ${s.access_token}`, ...apiKeyHeader() },
        });
      } catch { /* локальный выход важнее сетевого — не блокируем на ошибке */ }
    }
  }

  // ---- refresh ---------------------------------------------------------
  async function refresh() {
    if (!session?.refresh_token) throw new Error("Нет сессии для обновления");
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const res = await fetch(`${base()}/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiKeyHeader() },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
      if (!res.ok) {
        session = null;
        clearSession();
        throw await parseAuthError(res);
      }
      const json = await res.json();
      session = fromTokenResponse(json);
      storeSession(session);
      return session;
    })();
    try { return await refreshInFlight; } finally { refreshInFlight = null; }
  }

  // Гарантирует валидный access_token перед запросом к PostgREST/RPC.
  // Возвращает null, если сессии нет вообще (гость, экран входа).
  async function ensureFreshSession() {
    if (!session) return null;
    if (session.expires_at - Date.now() > REFRESH_MARGIN_MS) return session;
    try { return await refresh(); } catch { return null; }
  }

  function currentSession() { return session; }
  function isSignedIn() { return !!session; }
  function userId() { return session?.user?.id || null; }

  return {
    signUp, signIn, signOut, refresh, ensureFreshSession,
    currentSession, isSignedIn, userId,
  };
})();
