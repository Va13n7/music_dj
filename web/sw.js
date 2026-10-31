/* Sonder FM PWA Service Worker：壳层离线缓存（网络优先，缓存兜底） */
const CACHE = 'sonder-v2';
const SHELL = ['/', '/index.html', '/app.js', '/style.css', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  // API / WS / 音频直链不缓存
  if (u.pathname.startsWith('/api') || u.pathname.startsWith('/tts') || u.pathname.startsWith('/fallback')) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok && e.request.method === 'GET') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('/index.html'))),
  );
});
