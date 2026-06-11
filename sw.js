/**
 * Service worker for Ruby PWA.
 * - Caches the app shell so it opens instantly / offline-tolerant.
 * - Receives (payload-less) web-push, then fetches the latest message text to
 *   display. Tapping the notification focuses or opens the app.
 */
const SHELL = 'ruby-shell-v1';
const ASSETS = ['/', '/index.html', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Network-first for the API; cache-first for the shell.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/auth') || url.pathname.startsWith('/push')) return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).catch(() => caches.match('/')))
  );
});

self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let title = 'S.G. Cleaning', body = 'Open Ruby for the latest.', url = '/';
    try {
      // No payload (keeps push simple + unencrypted); fetch the text to show.
      const r = await fetch('/api', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'last_push', session: await readSession() })
      });
      const j = await r.json();
      if (j && j.ok && j.data) { title = j.data.title || title; body = j.data.body || body; url = j.data.url || url; }
    } catch (err) { /* show the default */ }
    await self.registration.showNotification(title, {
      body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', tag: 'ruby', renotify: true, data: { url }
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const dest = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    for (const w of wins) { if ('focus' in w) return w.focus(); }
    return clients.openWindow(dest);
  }));
});

// The SW can't read localStorage; the app stashes the session in a cache entry.
async function readSession() {
  try {
    const c = await caches.open('ruby-session');
    const res = await c.match('/__session');
    return res ? await res.text() : '';
  } catch (e) { return ''; }
}
