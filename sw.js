// Простой Service Worker: кэширует оболочку приложения для офлайн-доступа.
// Данные (тренировки/пробежки) синхронизируются отдельно через JSONBin с fallback на localStorage —
// этот SW отвечает только за то, чтобы сама страница открывалась без интернета.

const CACHE_NAME = 'train-app-v1';
const ASSETS = [
  './index.html',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Запросы к JSONBin.io (данные) всегда идут в сеть — не кэшируем, чтобы не отдавать устаревшие данные.
  if (req.url.includes('api.jsonbin.io')) {
    event.respondWith(
      fetch(req).catch(() => new Response(JSON.stringify({error: 'offline'}), {
        headers: {'Content-Type': 'application/json'}
      }))
    );
    return;
  }

  // Для остального — cache-first с фоновым обновлением (stale-while-revalidate)
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req).then((res) => {
        if (res && res.status === 200) {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
        }
        return res;
      }).catch(() => cached);
      return cached || networkFetch;
    })
  );
});
