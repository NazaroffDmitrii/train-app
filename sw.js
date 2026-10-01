/*
 * train. — Service Worker
 *
 * Кэширует каркас приложения (раздел 8 спецификации): index.html (HTML+CSS) +
 * вынесенные скрипты (config/auth/db/app.js) + иконки. Цель — чтобы
 * приложение открывалось и работало вообще без сети, а не только данные
 * тренировок (данные уже офлайн-устойчивы сами по себе — см. модуль DATA
 * в app.js, пишет в localStorage синхронно при каждом действии).
 *
 * Стратегия: stale-while-revalidate.
 *   - Если каркас уже в кэше — отдаём его мгновенно, без ожидания сети.
 *   - Параллельно в фоне идёт запрос за свежей версией; если она пришла —
 *     кладём в кэш на следующий раз и сообщаем странице об обновлении.
 *   - Если сети нет вообще — используется то, что уже в кэше.
 *
 * Версию кэша надо поднимать (CACHE_VERSION) при каждом значимом релизе
 * каркаса, чтобы activate-обработчик подчистил старые записи.
 */

const CACHE_VERSION = "train-shell-v200";

// Эти пути — относительно расположения sw.js (корень GitHub Pages).
// manifest.json намеренно НЕ кэшируем: он не подключён в index.html (см.
// комментарий в <head> про чёрную полосу на iOS) — кэшировать неиспользуемый
// файл нет смысла.
const APP_SHELL = [
  "./",
  "./index.html",
  "./config.js",
  "./lib.js",
  "./atlas-seed.js",
  "./muscle-anatomy.js",
  "./auth.js",
  "./db.js",
  "./app.js",
  "./app-loader.js",
  "./backup-core.js",
  "./account-safety.js",
  "./account.html",
  "./account-loader.js",
  "./account-ui.js",
  "./restore.html",
  "./restore-loader.js",
  "./restore-core.js",
  "./restore-ui.js",
  "./restore-journal.js",
  "./constructor.js",
  "./outbox.js",
  "./syncengine.js",
  "./bridge.js",
  "./auth-ui.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png",
];

async function precacheFreshShell() {
  const cache = await caches.open(CACHE_VERSION);
  // cache.addAll() вправе взять ответы из обычного HTTP-кэша браузера. В PWA
  // на iOS это приводило к странному состоянию: новый sw.js уже активирован,
  // а внутри его нового Cache Storage лежат старые index/app.js. Явный
  // cache:"reload" заставляет проверить каждый файл в сети до активации.
  await Promise.all(APP_SHELL.map(async path => {
    const request = new Request(new URL(path, self.registration.scope).href, { cache: "reload" });
    const response = await fetch(request);
    if (!response.ok) throw new Error(`Не удалось обновить ${path}: HTTP ${response.status}`);
    await cache.put(request, response);
  }));
}

self.addEventListener("install", event => {
  event.waitUntil(precacheFreshShell().then(() => self.skipWaiting()));
});

// Ручная кнопка обновления посылает это сообщение для браузеров, которые
// оставляют установленный worker в waiting несмотря на skipWaiting в install.
self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
    return;
  }

  // Кнопка в настройках использует этот путь даже когда браузер решил, что
  // новый worker создавать не нужно. Сначала целиком обновляем текущий cache
  // shell из сети и лишь затем разрешаем странице перезапуститься.
  if (event.data?.type === "REFRESH_SHELL") {
    event.waitUntil(
      precacheFreshShell()
        .then(() => event.ports[0]?.postMessage({ ok: true }))
        .catch(error => event.ports[0]?.postMessage({ ok: false, error: error?.message || String(error) }))
    );
  }
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key !== CACHE_VERSION).map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;

  // Запросы записи сервис-воркер не трогает,
  // ими занимается очередь синхронизации внутри самого приложения.
  if (req.method !== "GET") return;

  // Чужие источники (включая API Supabase) тоже не кэшируем здесь.
  if (new URL(req.url).origin !== self.location.origin) return;

  // Навигация. Корень/index — отдаём каркас даже офлайн (index.html-фолбэк).
  // Прочие реальные страницы (например tests.html) обслуживаем как есть, не
  // подменяя на index.html, иначе их нельзя открыть при активном SW.
  if (req.mode === "navigate") {
    const url = new URL(req.url);
    const path = url.pathname;
    const isRoot = path.endsWith("/") || path.endsWith("/index.html");
    if (isRoot && url.searchParams.has("__app_update")) {
      event.respondWith(freshNavigation(req, "./index.html"));
      return;
    }
    event.respondWith(staleWhileRevalidate(req, isRoot ? "./index.html" : null));
    return;
  }

  event.respondWith(staleWhileRevalidate(req));
});

async function freshNavigation(req, fallbackKey) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const response = await fetch(req, { cache: "reload" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await cache.put(fallbackKey, response.clone());
    return response;
  } catch (_) {
    return (await cache.match(fallbackKey)) || new Response("Нет сети", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}

function staleWhileRevalidate(req, fallbackKey) {
  return caches.open(CACHE_VERSION).then(cache =>
    cache.match(fallbackKey || req).then(cached => {
      const network = fetch(req)
        .then(res => {
          if (res && res.ok) cache.put(fallbackKey || req, res.clone());
          return res;
        })
        .catch(() => cached || new Response("Нет сети", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }));
      return cached || network;
    })
  );
}
