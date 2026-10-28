// Serves the page shell from cache, so the board opens on its last snapshot (kept by
// the page in Cache Storage) with no signal or after the Access session lapses, when
// a network navigation would land on the Access login instead. Only navigations are
// handled; the page's own fetches go straight to the network.
const SHELL = 'shell-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL).then((c) => c.add('/')));
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  // ?signin is the page's way out: let Access see the navigation and log in.
  if (e.request.mode !== 'navigate' || new URL(e.request.url).searchParams.has('signin')) return;
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const cached = await cache.match('/');
    if (!cached) return fetch(e.request);
    // A navigate-mode request can't take a RequestInit, so revalidate with a plain
    // fetch of '/'. Only a same-origin 200 is cached, never the Access redirect.
    e.waitUntil(fetch('/', { redirect: 'manual' }).then((res) => res.ok && res.type === 'basic' && cache.put('/', res)).catch(() => {}));
    return cached;
  })());
});
