// Tratamento de push compartilhado pelo sw.js e pelo firebase-messaging-sw.js.
// Os dois sao registrados no mesmo escopo e o ultimo registrado vence; com o
// codigo aqui, o push funciona qualquer que seja o service worker ativo.
var MOTOJA_OFERTAS = ['nova_corrida', 'nova_entrega', 'nova_corrida_carro'];

function motojaPayload(event) {
  try {
    return event.data ? event.data.json() : {};
  } catch (error) {
    return {};
  }
}

function motojaDestino(data) {
  if (data.tipo === 'cliente_lembrete') return './index.html';
  if (data.tipo === 'nova_entrega') return './motoboy.html?aba=entregas';
  return './motoboy.html';
}

function motojaJanelas() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
}

self.addEventListener('push', function (event) {
  var payload = motojaPayload(event);
  var notification = payload.notification || {};
  var data = payload.data || {};
  var oferta = MOTOJA_OFERTAS.indexOf(data.tipo) !== -1;
  var ofertaId = data.rideId || data.deliveryId || '';
  var title = notification.title || data.title || 'MotoJa Conchal';
  var options = {
    body: notification.body || data.body || 'A MotoJa esta online.',
    icon: './nexus-motoja-icon-192.png',
    badge: './nexus-motoja-icon-192.png',
    tag: oferta && ofertaId ? 'oferta-' + ofertaId : data.tipo || 'motoja',
    renotify: true,
    // Chamada fica presa no topo ate o motoboy tocar ou dispensar.
    requireInteraction: oferta || data.tipo === 'cliente_lembrete',
    vibrate: oferta ? [600, 200, 600, 200, 600, 200, 600] : [180, 80, 180],
    actions: oferta ? [{ action: 'abrir', title: 'Ver e aceitar' }] : [],
    data: data
  };

  event.waitUntil(
    motojaJanelas().then(function (janelas) {
      var focada = janelas.filter(function (janela) { return janela.focused; })[0];
      janelas.forEach(function (janela) {
        janela.postMessage({ tipo: 'motoja:push', data: data });
      });
      // Com o app aberto na frente, a propria tela de oferta toca o alarme.
      if (oferta && focada) return undefined;
      return self.registration.showNotification(title, options);
    })
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var data = event.notification && event.notification.data ? event.notification.data : {};
  var destino = motojaDestino(data);
  event.waitUntil(
    motojaJanelas().then(function (janelas) {
      var alvo = destino.replace('./', '').split('?')[0];
      var aberta = janelas.filter(function (janela) {
        return new URL(janela.url).pathname.split('/').pop() === alvo;
      })[0];
      if (aberta) {
        aberta.postMessage({ tipo: 'motoja:push', data: data, clique: true });
        return aberta.focus();
      }
      return self.clients.openWindow(destino);
    })
  );
});
