const CACHE_NAME = 'nexus-motoja-v107-app-shell-fast';
const ARQUIVOS = ['./', './index.html', './motoboy.html', './dono.html', './empresa.html', './privacy.html', './cliente.webmanifest', './motorista.webmanifest', './dono.webmanifest', './firebase-messaging-sw.js', './nexus-motoja-logo-mark.png', './motorista-icon.svg', './nexus-motoja-icon-180.png', './nexus-motoja-icon-192.png', './nexus-motoja-icon-512.png'];

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

  const url = new URL(event.request.url);
  const mesmoSite = url.origin === location.origin;

  if (mesmoSite) {
    event.respondWith(
      caches.match(event.request).then((cache) => {
        const salvarAtualizacao = (resposta) => {
          if (resposta && resposta.ok) {
            const copia = resposta.clone();
            caches.open(CACHE_NAME).then((c) => c.put(event.request, copia));
          }
          return resposta;
        };
        const atualizacao = fetch(event.request).then(salvarAtualizacao).catch(() => null);

        if (event.request.mode === 'navigate' || event.request.destination === 'document') {
          return atualizacao.then((resposta) => resposta || cache || caches.match('./index.html'));
        }
        if (cache) return cache;
        return atualizacao.then((resposta) => resposta || caches.match('./index.html'));
      })
    );
    return;
  }

  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
