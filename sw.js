// Apunta — service worker.
// 1) Guarda la app en el móvil para que abra sin cobertura.
// 2) Cuando vuelve la señal, Chrome lo despierta para enviar lo pendiente
//    aunque la app esté cerrada (Background Sync; no es instantáneo ni 100 % garantizado).

importScripts('cola.js');

const VERSION = 'apunta-v1';
const ARCHIVOS = ['./', 'index.html', 'cola.js', 'manifest.webmanifest', 'icono-192.png', 'icono-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(claves.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Solo atiende los archivos de la propia app; las llamadas a Google pasan de largo.
// Abre siempre desde lo guardado en el móvil (rápido aunque haya poca señal)
// y, si hay red, actualiza la copia por detrás para la próxima vez.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const guardado = await cache.match(e.request, { ignoreSearch: true });
    const deRed = fetch(e.request)
      .then((r) => { if (r.ok) cache.put(e.request, r.clone()); return r; })
      .catch(() => null);
    if (guardado) { e.waitUntil(deRed); return guardado; }
    return (await deRed) || (await cache.match('index.html')) || Response.error();
  })());
});

self.addEventListener('sync', (e) => {
  if (e.tag !== 'enviar-apuntes') return;
  e.waitUntil((async () => {
    const r = await enviarPendientes();
    const ventanas = await self.clients.matchAll({ type: 'window' });
    ventanas.forEach((v) => v.postMessage({ tipo: 'sincronizado', quedan: r.quedan, enviados: r.enviados.length }));
    // Si queda algo por un fallo de red, Chrome lo reintentará más tarde.
    if (r.quedan > 0 && r.error && ['red', 'tiempo'].includes(r.error.codigo)) throw new Error('reintentar');
  })());
});
