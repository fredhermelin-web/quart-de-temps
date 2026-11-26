/* Quart de temps — service worker : hors ligne + réception des fichiers partagés. */
const CACHE = 'atelier-v70';
const SHARE = 'atelier-share';
const SHELL = [
  './',
  'index.html',
  'mentions-legales.html',
  'styles.css',
  'fonts.css',
  'fonts/ebgaramond-italic-500.woff2',
  'fonts/ebgaramond-normal-500.woff2',
  'fonts/manrope-normal-500.woff2',
  'fonts/unbounded-normal-400.woff2',
  'sounds.js',
  'vendor/signalsmith-stretch-1.3.2.js',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'Sound/Clave.wav',
  'Sound/Conga.mp3',
  'Sound/Cowbell.wav',
  'Sound/Wood.wav'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SHARE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Fichier partagé depuis une autre appli (Android) : on le garde puis on ouvre l'app.
  if (req.method === 'POST' && url.searchParams.has('share-target')) {
    e.respondWith((async () => {
      try {
        const fd = await req.formData();
        const f = fd.get('audio');
        if (f && typeof f !== 'string') {
          const c = await caches.open(SHARE);
          await c.put('shared-audio', new Response(f, {
            headers: { 'content-type': f.type || 'audio/mpeg', 'x-filename': encodeURIComponent(f.name || 'Morceau partagé') }
          }));
        }
      } catch (err) { /* on ouvre l'app quand même */ }
      return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
    })());
    return;
  }

  if (req.method !== 'GET') return;

  if (url.origin !== self.location.origin) return;

  // Réseau d'abord (les mises à jour arrivent tout de suite), cache en secours hors ligne.
  const isLegal = /mentions-legales\.html$/.test(url.pathname);
  const key = req.mode === 'navigate' ? (isLegal ? 'mentions-legales.html' : 'index.html') : req;
  // cache: 'no-cache' : on revalide toujours auprès du serveur, jamais de vieille copie du cache HTTP.
  e.respondWith(fetch(req, { cache: 'no-cache' }).then((res) => {
    if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
    return res;
  }).catch(() => caches.match(key, { ignoreSearch: true })));
});
