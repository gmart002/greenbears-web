/* Service worker — Pizarra Green Bears.
   Deja la app disponible sin conexión: cachea el "app shell" y, en tiempo de
   ejecución, las fuentes de Google y el logo. Navegación: red primero (para
   recibir actualizaciones) con respaldo a caché cuando no hay conexión. */
const CACHE = 'greenbears-v3';
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // Cachear cada recurso por separado para que un 404 (p.ej. logo.png
    // ausente) no rompa toda la instalación.
    await Promise.all(SHELL.map(async (u) => {
      try { const r = await fetch(u, { cache: 'no-cache' }); if (r.ok) await c.put(u, r); } catch (_) {}
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Fuentes de Google (CSS + woff2): cache-first, se pueblan al primer uso.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const hit = await c.match(req);
      if (hit) return hit;
      try { const res = await fetch(req); if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone()); return res; }
      catch (_) { return hit || Response.error(); }
    })());
    return;
  }

  // Solo gestionamos el mismo origen de aquí en adelante.
  if (url.origin !== self.location.origin) return;

  // Navegación (abrir la app): red primero con TIMEOUT de 3s → respaldo a
  // caché. Así offline o con red lenta la app abre al instante.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      try {
        const res = await Promise.race([
          fetch(req),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))
        ]);
        c.put('./index.html', res.clone());
        return res;
      } catch (_) {
        return (await c.match(req)) || (await c.match('./index.html')) || (await c.match('./')) ||
               new Response('<h1>Sin conexión</h1>', { headers: { 'content-type': 'text/html' } });
      }
    })());
    return;
  }

  // Resto (íconos, logo, etc.): cache-first con respaldo a red y guardado.
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(req);
    if (hit) return hit;
    try { const res = await fetch(req); if (res && res.ok) c.put(req, res.clone()); return res; }
    catch (_) { return hit || Response.error(); }
  })());
});
