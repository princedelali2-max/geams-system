/* GEAMS service worker.
 * 1) Lets the Civilian app open with no signal: keeps a copy of the app and the files it loads, trying the network first (4 s).
 *    It never caches /api/ calls.
 * 2) Receives push messages from the GEAMS server so HQ alerts reach phones even when the app is closed. */
const CACHE = 'geams-shell-v2';
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then(c => c.add('/geams-civilian-app.html').catch(() => {})).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.pathname.startsWith('/api/') || !/^https?:$/.test(u.protocol)) return;
  e.respondWith((async () => {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 4000);
    try {
      const res = await fetch(r, { signal: ctl.signal }); clearTimeout(t);
      if (res && (res.ok || res.type === 'opaque')) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(r, cp)).catch(() => {}); }
      return res;
    } catch (err) {
      clearTimeout(t);
      const hit = await caches.match(r, { ignoreSearch: true });
      if (hit) return hit;
      if (r.mode === 'navigate' && u.pathname === '/geams-civilian-app.html') { const app = await caches.match('/geams-civilian-app.html'); if (app) return app; }
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  })());
});
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) { d = { title: 'Alert', message: e.data ? e.data.text() : '' }; }
  const sev = d.severity || 'info';
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (cs.some(c => c.visibilityState === 'visible')) return;          // the open app already shows its own banner
    await self.registration.showNotification('GEAMS · ' + (d.title || 'Alert'), { body: d.message || '', tag: d.id || 'geams-alert', renotify: true, requireInteraction: sev === 'critical', vibrate: sev === 'critical' ? [400, 150, 400, 150, 800] : sev === 'warning' ? [300, 120, 300] : undefined, data: { url: d.url || '/' } });
  })());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close(); const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => { const hit = cs.find(c => new URL(c.url).pathname === url) || cs[0]; return hit ? hit.focus() : self.clients.openWindow(url); }));
});
