/*
 * train. — Service Worker
 *
 * Кэширует каркас приложения (раздел 8 спецификации): сейчас это один файл
 * index.html (HTML/CSS/JS вместе) + manifest.json + иконки. Цель — чтобы
 * приложение открывалось и работало вообще без сети, а не только данные
 * тренировок (данные уже офлайн-устойчивы сами по себе — см. модуль DATA
 * в index.html, пишет в localStorage синхронно при каждом действии).
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

const CACHE_VERSION = "train-shell-v12";

// Эти пути — относительно расположения sw.js (корень GitHub Pages).
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./config.js",
  "./storage.js",
  "./sync.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
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

  // Запросы записи (а в будущем — к JSONBin) сервис-воркер не трогает,
  // ими занимается очередь синхронизации внутри самого приложения.
  if (req.method !== "GET") return;

  // Чужие источники (например, будущий JSONBin API) тоже не кэшируем здесь.
  if (new URL(req.url).origin !== self.location.origin) return;

  // Навигация (открытие приложения / обновление страницы) — всегда должна
  // получить каркас, даже если сети нет вообще.
  if (req.mode === "navigate") {
    event.respondWith(staleWhileRevalidate(req, "./index.html"));
    return;
  }

  event.respondWith(staleWhileRevalidate(req));
});

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
