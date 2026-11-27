/* Quart de temps — service worker : hors ligne + réception des fichiers partagés. */
const CACHE = 'atelier-v98';
const SHARE = 'atelier-share';
// Fichiers indispensables : s'il en manque un, la nouvelle version n'est pas installée (l'ancienne continue de servir).
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'fonts.css',
  'sounds.js',
  'vendor/signalsmith-stretch-1.3.2.js',
  'app.js',
  'manifest.webmanifest'
];
// Fichiers secondaires : gardés hors ligne s'ils sont disponibles, sans bloquer l'installation.
const EXTRA = [
  'mentions-legales.html',
  'fonts/ebgaramond-italic-500.woff2',
  'fonts/ebgaramond-normal-500.woff2',
  'fonts/manrope-normal-500.woff2',
  'fonts/unbounded-normal-400.woff2',
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png',
  'Sound/Clave.wav',
  'Sound/Conga.mp3',
  'Sound/Cowbell.wav',
  'Sound/Wood.wav'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(async (c) => {
    await c.addAll(SHELL);
    await Promise.all(EXTRA.map((u) => c.add(u).catch(() => {})));
  }).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => /^atelier-v\d+$/.test(k) && k !== CACHE).map((k) => caches.delete(k))))
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
  // Si le serveur répond par une erreur ou ne répond pas assez vite, on sert la copie gardée plutôt qu'une page cassée.
  const fromCache = () => caches.open(CACHE).then((c) => c.match(key, { ignoreSearch: true }));
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), 8000) : 0;
  e.respondWith(fetch(req, ctl ? { cache: 'no-cache', signal: ctl.signal } : { cache: 'no-cache' }).then(async (res) => {
    clearTimeout(timer);
    if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); return res; }
    return (await fromCache()) || res;
  }).catch(async () => { clearTimeout(timer); return (await fromCache()) || Response.error(); }));
});
