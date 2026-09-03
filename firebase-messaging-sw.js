self.addEventListener('push', function (event) {
  var payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (error) {
    payload = {};
  }

  var notification = payload.notification || {};
  var data = payload.data || {};
  var title = notification.title || data.title || 'MotoJa Conchal';
  var options = {
    body: notification.body || data.body || 'A MotoJa esta online.',
    icon: './nexus-motoja-icon-192.png',
    badge: './nexus-motoja-icon-192.png',
    data: data
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var data = event.notification && event.notification.data ? event.notification.data : {};
  var target = data.tipo === 'cliente_lembrete'
    ? './index.html'
    : data.tipo === 'nova_entrega'
      ? './motoboy.html?aba=entregas'
      : './motoboy.html';

  event.waitUntil(clients.openWindow(target));
});
