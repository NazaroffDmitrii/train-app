/*
 * storage.js — адаптер доступа к удалённому хранилищу (раздел 2 спецификации)
 *
 * Бэкенд — Supabase (таблица public.snapshots), доступ напрямую из браузера
 * через PostgREST (${baseUrl}/rest/v1/...). Это единственный файл, который
 * вообще знает о существовании Supabase — DATA, sync.js и экраны приложения
 * обращаются только к функциям ниже. Раньше здесь был клиент JSONBin; при
 * переезде на другой бэкенд меняется только этот файл (и config.js).
 *
 * Один "bin" (в терминах остального кода — унаследовано от JSONBin-эпохи) =
 * одна строка таблицы snapshots, ключ — user_id (напр. "dima"/"natela").
 * Обновление всегда перезаписывает содержимое строки целиком (upsert) — как
 * и раньше с JSONBin, построчных/частичных обновлений тут тоже нет.
 *
 * Publishable key (аналог JSONBin Access Key) живёт в клиентском коде в
 * открытом виде — это нормально для Supabase: доступ ограничивается RLS-
 * политиками на сервере, а не секретностью ключа (см. config.js).
 */

const Storage = (() => {
  let cfg = { enabled: false, baseUrl: "", apiKey: "" };

  function configure(next) {
    cfg = { ...cfg, ...next };
  }

  function isEnabled() {
    return !!(cfg.enabled && cfg.baseUrl && cfg.apiKey);
  }

  function headers(extra) {
    return {
      apikey: cfg.apiKey,
      Authorization: `Bearer ${cfg.apiKey}`,
      ...extra,
    };
  }

  async function throwHttpError(res, where) {
    let message = "";
    try { message = (await res.json())?.message || ""; }
    catch {
      try { message = await res.text(); } catch {}
    }
    throw new Error(`${where}: HTTP ${res.status}${message ? ` — ${message}` : ""}`);
  }

  // Прочитать снапшот пользователя. null, если строки ещё нет — это не
  // ошибка, просто «пока ничего нет», вызывающий код сам решает, что делать
  // (обычно — оставить локальные данные).
  async function readBin(userKey) {
    if (!isEnabled() || !userKey) return null;
    const res = await fetch(
      `${cfg.baseUrl}/rest/v1/snapshots?user_id=eq.${encodeURIComponent(userKey)}&select=content`,
      { method: "GET", keepalive: true, headers: headers(), cache: "no-store" }
    );
    if (!res.ok) await throwHttpError(res, "Storage.readBin");
    const rows = await res.json();
    return rows?.[0]?.content ?? null;
  }

  // Перезаписать снапшот целиком (upsert по user_id — строка создаётся при
  // первом upload, дальше просто заменяется).
  async function updateBin(userKey, data) {
    if (!isEnabled() || !userKey) throw new Error("Storage.updateBin: нет user id или Supabase отключён");
    const res = await fetch(`${cfg.baseUrl}/rest/v1/snapshots`, {
      method: "POST",
      keepalive: true,
      headers: headers({
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=representation",
      }),
      body: JSON.stringify([{ user_id: userKey, content: data, updated_at: new Date().toISOString() }]),
    });
    if (!res.ok) await throwHttpError(res, "Storage.updateBin");
    const rows = await res.json();
    return rows?.[0]?.content ?? data;
  }

  // Удалить строку безвозвратно. Сейчас нигде не вызывается по-настоящему
  // (пережиток схемы «бин на тренировку» — см. app.js, там всегда falsy
  // guard), но оставлено ради совместимости сигнатур. 404/пустой ответ —
  // не ошибка.
  async function deleteBin(userKey) {
    if (!isEnabled() || !userKey) return;
    const res = await fetch(
      `${cfg.baseUrl}/rest/v1/snapshots?user_id=eq.${encodeURIComponent(userKey)}`,
      { method: "DELETE", keepalive: true, headers: headers() }
    );
    if (!res.ok && res.status !== 404) await throwHttpError(res, "Storage.deleteBin");
  }

  return { configure, isEnabled, readBin, updateBin, deleteBin };
})();
