// Offline support: the app's own files are cached on the phone. AI model files are cached separately by web-llm.
// A new version installs in the background and waits; it takes over after "Install update" or the next full restart.
const VERSION = '5a7b7c500c6d';
const CACHE = 'glencal-' + VERSION;
const FILES = ['./', 'index.html', 'app.js', 'parser.js', 'vault.js', 'holidays.js', 'finance.js', 'ai.js', 'manifest.webmanifest',
  'icon-180.png', 'icon-192.png', 'icon-512.png', 'vendor/web-llm-0.2.87.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('glencal-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('message', (e) => { if (e.data === 'skip-waiting') self.skipWaiting(); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/data/') >= 0) {   // live data: network first, cached copy when offline
    e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(CACHE).then((k) => k.put(e.request, c)); return r; })
      .catch(() => caches.match(e.request)));
    return;
  }
  e.respondWith(caches.open(CACHE).then((c) => c.match(e.request, { ignoreSearch: true })).then((r) => r || fetch(e.request)));
});
