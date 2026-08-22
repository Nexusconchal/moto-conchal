const CACHE_NAME = 'nexus-motoja-v44-comida-agrupada';
const ARQUIVOS = ['./', './index.html', './motoboy.html', './dono.html', './empresa.html', './cliente.webmanifest', './motorista.webmanifest', './dono.webmanifest', './firebase-messaging-sw.js', './nexus-motoja-logo-mark.png', './motorista-icon.svg', './nexus-motoja-icon-180.png', './nexus-motoja-icon-192.png', './nexus-motoja-icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ARQUIVOS)));
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
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((resposta) => {
        const copia = resposta.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copia));
        return resposta;
      })
      .catch(() => caches.match(event.request))
  );
});
