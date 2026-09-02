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

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification?.data || {};
  const target = data.tipo === 'cliente_lembrete' ? './index.html' : data.tipo === 'nova_entrega' ? './motoboy.html?aba=entregas' : './motoboy.html';
  event.waitUntil(clients.openWindow(target));
});
