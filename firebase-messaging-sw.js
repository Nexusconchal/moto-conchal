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
  var target = './motoboy.html';
  if (data.tipo === 'cliente_lembrete') {
    target = './index.html';
  } else if (data.tipo === 'nova_entrega') {
    target = './motoboy.html?aba=entregas';
  }

  event.waitUntil(clients.openWindow(target));
});
