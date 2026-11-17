const CACHE = 'velocimetro-shell-v10';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

async function storeAsset(cache, asset) {
  const response = await fetch(new Request(asset, { cache: 'reload', redirect: 'follow' }));
  if (!response.ok) throw new Error('Falha ao cachear ' + asset);
  const headers = new Headers(response.headers);
  const body = await response.arrayBuffer();
  await cache.put(asset, new Response(body, {
    status: 200,
    statusText: 'OK',
    headers: headers
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(ASSETS.map((asset) => storeAsset(cache, asset)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.cache === 'reload' || event.request.cache === 'no-store') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.match(event.request).then((hit) => hit || caches.match('./index.html')).then((hit) => {
        if (hit) return hit;
        return fetch(event.request);
      })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((hit) => {
      if (hit) return hit;
      return fetch(event.request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      });
    })
  );
});
