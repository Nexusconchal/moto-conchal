importScripts('https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.5/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyAWY3Y9heJqKL_iTA2jCr4Zw3AQ39jB-Q',
  authDomain: 'moto-conchal.firebaseapp.com',
  projectId: 'moto-conchal',
  storageBucket: 'moto-conchal.firebasestorage.app',
  messagingSenderId: '904931531597',
  appId: '1:904931531597:web:14b7c6b35657e3982d3504',
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || 'Nova corrida Nexus MotoJa';
  const options = {
    body: payload.notification?.body || 'Abra o painel do motoboy para aceitar.',
    icon: './nexus-motoja-icon-192.png',
    badge: './nexus-motoja-icon-192.png',
    data: payload.data || {},
  };

  self.registration.showNotification(title, options);
});
const CACHE_NAME = 'nexus-motoja-v36-push-unico';
const ARQUIVOS = ['./', './index.html', './motoboy.html', './dono.html', './cliente.webmanifest', './motorista.webmanifest', './dono.webmanifest', './firebase-messaging-sw.js', './nexus-motoja-logo-mark.png', './motorista-icon.svg', './nexus-motoja-icon-180.png', './nexus-motoja-icon-192.png', './nexus-motoja-icon-512.png'];

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
