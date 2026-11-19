// Offline shell: the app opens without internet. API calls are never cached (the app keeps its own offline queue).
const VERSION = 'bm-v7';
const SHELL = ['/', '/index.html', '/css/app.css', '/manifest.webmanifest', '/js/app.js', '/js/api.js', '/js/store.js', '/js/ui.js', '/js/calc.js', '/js/qr.js', '/js/receipt.js', '/js/escpos.js', '/js/pdf.js', '/js/logo.js', '/js/printer.js', '/js/share.js',
  '/js/views/login.js', '/js/views/dashboard.js', '/js/views/newbill.js', '/js/views/billview.js', '/js/views/menu.js', '/js/views/history.js', '/js/views/reports.js', '/js/views/settings.js', '/icons/icon-192.png', '/icons/icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // stale-while-revalidate; navigations fall back to the cached app shell when offline
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: true });
    // App code (js/css/html) is network-first so the files can never be a mix of old and new versions; the cache is only the offline fallback.
    if (req.mode === 'navigate' || /\.(js|css|html|webmanifest)$/.test(url.pathname)) {
      try { const res = await fetch(req, { cache: 'no-cache' }); if (res.ok) cache.put(req, res.clone()); return res; }
      catch { return hit || (req.mode === 'navigate' && (await cache.match('/index.html'))) || Response.error(); }
    }
    const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    const res = await net;
    if (res) return res;
    if (req.mode === 'navigate') return (await cache.match('/index.html')) || Response.error();
    return Response.error();
  })());
});
