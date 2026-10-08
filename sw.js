const CACHE_NAME = 'nexus-motoja-v224-availability-resume';
const ARQUIVOS = ['./', './index.html', './motoboy.html', './motoboy-tracking.js?v=210', './dono.html', './owner-dashboard.css', './owner-dashboard.js', './owner-workspace.css', './owner-workspace.js', './empresa.html', './company-profile.js?v=208', './company-deposits.js?v=214', './owner-delivery-review.js?v=210', './company-reports.js?v=207', './report-export.js?v=207', './empresa-tracking.js?v=211', './empresa-pedidos.js', './privacy.html', './cliente.webmanifest', './motorista.webmanifest', './dono.webmanifest', './empresa.webmanifest', './firebase-messaging-sw.js', './nexus-motoja-logo-mark.png', './nexus-motoja-site-logo.png', './motorista-icon.svg', './nexus-motoja-icon-180.png', './nexus-motoja-icon-192.png', './nexus-motoja-icon-512.png'];

ARQUIVOS.push('./availability.css?v=224', './driver-availability.js?v=224', './customer-availability.js?v=224');

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll([...ARQUIVOS, './tracking-map.js?v=187'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((chaves) =>
      Promise.all(chaves.filter((cache) => cache !== CACHE_NAME).map((cache) => caches.delete(cache)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.origin.includes('firestore.googleapis.com')) return;
  if (url.origin.includes('firebaseio.com')) return;
  if (url.origin.includes('nominatim.openstreetmap.org')) return;
  if (url.origin.includes('router.project-osrm.org')) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const copia = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copia));
          }
          return response;
        })
        .catch(() => caches.match(event.request, { ignoreSearch: true }))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const copia = response.clone();
            caches.open(CACHE_NAME).then((c) => c.put(event.request, copia));
          }
          return response;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
