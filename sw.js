// Offline support: the app's own files are cached on the phone. AI model files are cached separately by web-llm.
// A new version installs in the background and waits; it takes over after "Install update" or the next full restart.
const VERSION = '58759da3f5c4';
const CACHE = 'glencal-' + VERSION;
const FILES = ['./', 'index.html', 'app.js', 'parser.js', 'vault.js', 'holidays.js', 'finance.js', 'push-key.js', 'daily.js', 'gmail.js', 'tools.js', 'manifest.webmanifest',
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

// ---- Evening briefing. The push from the server carries no calendar data; this phone builds the text
// from its own encrypted copy (written by the app) and shows it. ----
function idbGet(key) {
  return new Promise((res) => {
    const r = indexedDB.open('glencal', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onerror = () => res(null);
    r.onsuccess = () => {
      try { const q = r.result.transaction('kv').objectStore('kv').get(key); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }
      catch (e) { res(null); }
    };
  });
}
async function briefing() {
  const now = new Date(), t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const iso = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
  const label = t.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const title = 'Tomorrow · ' + label;
  try {
    const rec = await idbGet('vault'), box = await idbGet('digest');
    if (!rec || !box || rec.method !== 'device') return { title, body: 'Open GlenCal to see tomorrow.' };
    const key = rec.deviceKey || await crypto.subtle.importKey('raw', rec.deviceRaw, 'AES-GCM', false, ['decrypt']);
    const d = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.iv }, key, box.ct)));
    const lines = (d.days && d.days[iso]) || [];
    if (!lines.length) return { title, body: 'Nothing scheduled.' };
    return { title, body: lines.slice(0, 5).join('\n') + (lines.length > 5 ? '\n+' + (lines.length - 5) + ' more' : '') };
  } catch (e) {
    return { title, body: 'Open GlenCal to see tomorrow.' };
  }
}
self.addEventListener('push', (e) => {
  e.waitUntil(briefing().then((n) => self.registration.showNotification(n.title, { body: n.body, tag: 'glencal-briefing', icon: 'icon-192.png', badge: 'icon-192.png' })));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => cs.length ? cs[0].focus() : self.clients.openWindow('./')));
});
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
