// Keeps the app shell available from the Home Screen without a connection.
// Network first, so a new version is picked up as soon as the phone is online.
const CACHE = 'mv-web-2';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'api.js', 'core.js', 'dig.js', 'manifest.webmanifest', 'icon-180.png', 'icon-512.png'];
self.addEventListener('install', (event) => { event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only this app's own files; OpenAI, Discogs and cover images always go to the network untouched.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok) { const copy = response.clone(); caches.open(CACHE).then((cache) => cache.put(event.request, copy)); }
    return response;
  }).catch(() => caches.match(event.request, { ignoreSearch: true }).then((hit) => hit ?? caches.match('index.html'))));
});
