(function () {
  'use strict';

  const BACKEND = 'https://motoboy-conchal.onrender.com';
  const TOKEN_KEY = 'nexusEmpresaToken';
  const deliveries = new Map();
  let selectedId = '';
  let map = null;
  let driverMarker = null;
  let destinationMarker = null;
  let pickupMarker = null;
  let routeLayer = null;
  let lastRouteKey = '';
  let routeRequestVersion = 0;
  let socket = null;
  let lastToken = '';
  let mapResizeObserver = null;

  function token() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  }

  function statusLabel(status) {
    if (status === 'retirada') return 'Pedido retirado - em trajeto';
    if (status === 'aceita') return 'Motoboy aceitou - a caminho da retirada';
    if (status === 'pendente') return 'Chamando motoboy...';
    return status || 'Atualizando';
  }

  function locationOf(delivery) {
    const location = delivery?.motoboyLocalizacao || delivery?.location;
    const latitude = Number(location?.latitude ?? location?.lat);
    const longitude = Number(location?.longitude ?? location?.lon ?? location?.lng);
    return Number.isFinite(latitude) && Number.isFinite(longitude) ? { ...location, latitude, longitude } : null;
  }

  function relativeTime(milliseconds) {
    const seconds = Math.max(0, Math.round((Date.now() - Number(milliseconds || 0)) / 1000));
    if (seconds < 10) return 'agora';
    if (seconds < 60) return `ha ${seconds}s`;
    return `ha ${Math.floor(seconds / 60)} min`;
  }

  async function loadScript(src, test) {
    if (test()) return;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  async function ensureLibraries() {
    await loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', () => !!window.L);
    await loadScript(`${BACKEND}/socket.io/socket.io.js`, () => !!window.io);
  }

  function ensureMap() {
    if (map || !window.L) return;
    map = window.L.map('mapaEntregaEmpresa', { zoomControl: true }).setView([-22.3375, -47.1729], 14);
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap'
    }).addTo(map);
    const element = document.getElementById('mapaEntregaEmpresa');
    if (element && window.ResizeObserver) {
      mapResizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(() => map?.invalidateSize({ pan: false }));
      });
      mapResizeObserver.observe(element);
    }
    requestAnimationFrame(() => map.invalidateSize({ pan: false }));
    setTimeout(() => map?.invalidateSize({ pan: false }), 200);
  }

  function deliveryPoint(delivery, prefix) {
    const latitude = Number(
      delivery?.[`${prefix}Lat`] ??
      delivery?.[`${prefix}_lat`] ??
      delivery?.[prefix]?.lat ??
      delivery?.[prefix]?.latitude
    );
    const longitude = Number(
      delivery?.[`${prefix}Lon`] ??
      delivery?.[`${prefix}Lng`] ??
      delivery?.[`${prefix}_lon`] ??
      delivery?.[prefix]?.lon ??
      delivery?.[prefix]?.lng ??
      delivery?.[prefix]?.longitude
    );
    return Number.isFinite(latitude) && Number.isFinite(longitude) ? [latitude, longitude] : null;
  }

  function markerIcon(className, label, ariaLabel, centered = false) {
    return window.L.divIcon({
      className,
      html: `<span aria-label="${ariaLabel}"><b>${label}</b></span>`,
      iconSize: [42, 42],
      iconAnchor: centered ? [21, 21] : [21, 38]
    });
  }

  function clearRoute() {
    routeRequestVersion += 1;
    lastRouteKey = '';
    if (routeLayer && map) map.removeLayer(routeLayer);
    routeLayer = null;
  }

  async function updateDeliveryRoute(delivery) {
    const pickup = deliveryPoint(delivery, 'retirada');
    const destination = deliveryPoint(delivery, 'entrega');
    if (!pickup || !destination || !map) {
      clearRoute();
      return;
    }
    const routeKey = `${delivery.id}:${pickup.join(',')}:${destination.join(',')}`;
    if (routeKey === lastRouteKey) return;
    lastRouteKey = routeKey;
    const requestVersion = ++routeRequestVersion;
    try {
      const response = await fetch(`${BACKEND}/api/maps/route`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          points: [
            { lat: pickup[0], lon: pickup[1] },
            { lat: destination[0], lon: destination[1] }
          ]
        }),
        cache: 'no-store'
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(data.geometry) || data.geometry.length < 2) throw new Error('route_unavailable');
      if (requestVersion !== routeRequestVersion || routeKey !== lastRouteKey) return;
      if (routeLayer) map.removeLayer(routeLayer);
      routeLayer = window.L.polyline(data.geometry, {
        color: '#ff6b00',
        weight: 5,
        opacity: 0.95,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(map);
      map.fitBounds(routeLayer.getBounds(), { padding: [34, 34], maxZoom: 16, animate: true });
    } catch (_) {
      if (requestVersion !== routeRequestVersion || routeKey !== lastRouteKey) return;
      if (routeLayer) map.removeLayer(routeLayer);
      routeLayer = window.L.polyline([pickup, destination], {
        color: '#ff6b00',
        weight: 4,
        opacity: 0.78,
        dashArray: '8 10'
      }).addTo(map);
      map.fitBounds(routeLayer.getBounds(), { padding: [34, 34], maxZoom: 16, animate: true });
    }
  }

  function updateMap() {
    ensureMap();
    if (!map) return;
    map.invalidateSize({ pan: false });
    requestAnimationFrame(() => map?.invalidateSize({ pan: false }));
    setTimeout(() => map?.invalidateSize({ pan: false }), 180);
    const delivery = deliveries.get(selectedId);
    const location = locationOf(delivery);
    const mapStatus = document.getElementById('mapaEntregaStatus');
    if (!delivery) {
      clearRoute();
      [driverMarker, destinationMarker, pickupMarker].forEach((marker) => {
        if (marker) map.removeLayer(marker);
      });
      driverMarker = null;
      destinationMarker = null;
      pickupMarker = null;
      if (mapStatus) mapStatus.textContent = 'Nenhuma entrega em andamento agora.';
      return;
    }

    const pickupPoint = deliveryPoint(delivery, 'retirada');
    const destinationPoint = deliveryPoint(delivery, 'entrega');
    if (pickupPoint) {
      const popupHtml = `<b>Ponto de Retirada (Loja)</b><br>${escapeHtml(delivery.retirada || delivery.empresa || 'Loja')}`;
      if (!pickupMarker) pickupMarker = window.L.marker(pickupPoint, {
        icon: markerIcon('motoja-pickup-marker', 'L', 'Local de retirada')
      }).addTo(map).bindPopup(popupHtml);
      else {
        pickupMarker.setLatLng(pickupPoint);
        pickupMarker.setPopupContent(popupHtml);
      }
    } else if (pickupMarker) {
      map.removeLayer(pickupMarker);
      pickupMarker = null;
    }
    if (destinationPoint) {
      const popupHtml = `<b>Destino da Entrega</b><br>${escapeHtml(delivery.entrega || delivery.recebedor || 'Cliente')}`;
      if (!destinationMarker) destinationMarker = window.L.marker(destinationPoint, {
        icon: markerIcon('motoja-destination-marker', 'D', 'Destino da entrega')
      }).addTo(map).bindPopup(popupHtml);
      else {
        destinationMarker.setLatLng(destinationPoint);
        destinationMarker.setPopupContent(popupHtml);
      }
    } else if (destinationMarker) {
      map.removeLayer(destinationMarker);
      destinationMarker = null;
    }
    updateDeliveryRoute(delivery);

    if (!location) {
      if (driverMarker) {
        map.removeLayer(driverMarker);
        driverMarker = null;
      }
      if (routeLayer) map.fitBounds(routeLayer.getBounds(), { padding: [34, 34], maxZoom: 16 });
      else if (destinationMarker) map.setView(destinationMarker.getLatLng(), 15);
      if (mapStatus) mapStatus.textContent = delivery.status === 'aceita'
        ? 'Motoboy aceitou a corrida! O boneco da moto comeca a se mover no mapa assim que ele confirmar a retirada.'
        : delivery.status === 'pendente'
        ? 'Chamada enviada aos motoboys! Aguardando motoboy aceitar a corrida...'
        : 'Aguardando o primeiro sinal de GPS do motoboy.';
      return;
    }

    const point = [location.latitude, location.longitude];
    const icon = markerIcon('motoja-driver-marker', '🏍', 'Motoboy em rota', true);
    const driverPopup = `<b>Motoboy: ${escapeHtml(delivery.motoboy || 'Em trajeto')}</b><br>${location.speed ? 'Velocidade: ' + Math.round(location.speed * 3.6) + ' km/h' : 'Em deslocamento'}`;
    if (!driverMarker) driverMarker = window.L.marker(point, { icon }).addTo(map).bindPopup(driverPopup);
    else {
      driverMarker.setLatLng(point);
      driverMarker.setPopupContent(driverPopup);
    }
    if (routeLayer) {
      const bounds = routeLayer.getBounds();
      bounds.extend(point);
      map.fitBounds(bounds, { padding: [34, 34], maxZoom: 16 });
    } else {
      map.panTo(point, { animate: true, duration: 0.5 });
    }
    if (mapStatus) mapStatus.textContent = `Motoboy em trajeto! Localizacao atualizada ${relativeTime(location.serverTimestampMs || location.clientTimestamp)}.`;
  }

  function render() {
    const list = document.getElementById('entregasRastreamentoLista');
    if (!list) return;
    const active = [...deliveries.values()];
    if (!active.length) {
      selectedId = '';
      list.innerHTML = '<p class="muted">Nenhuma entrega aceita ou em trajeto agora.</p>';
      updateMap();
      return;
    }
    if (!selectedId || !deliveries.has(selectedId)) selectedId = active[0].id;
    list.innerHTML = active.map((delivery) => {
      const location = locationOf(delivery);
      return `<button type="button" class="tracking-delivery${delivery.id === selectedId ? ' active' : ''}" data-tracking-delivery="${escapeHtml(delivery.id)}">
        <span><strong>${escapeHtml(delivery.recebedor || delivery.empresa || 'Entrega')}</strong><small>${escapeHtml(delivery.entrega || delivery.entregaEncontrada || '-')}</small></span>
        <span><b>${escapeHtml(delivery.motoboy || 'Aguardando motoboy')}</b><small>${escapeHtml(statusLabel(delivery.status))}${location ? ` - GPS ${relativeTime(location.serverTimestampMs || location.clientTimestamp)}` : ''}</small></span>
      </button>`;
    }).join('');
    list.querySelectorAll('[data-tracking-delivery]').forEach((button) => {
      button.addEventListener('click', () => {
        selectedId = button.dataset.trackingDelivery;
        render();
      });
    });
    updateMap();
  }

  async function refresh() {
    const sessionToken = token();
    if (!sessionToken) return;
    try {
      const response = await fetch(`${BACKEND}/api/companies/me/active-deliveries`, {
        headers: { authorization: `Bearer ${sessionToken}` },
        cache: 'no-store'
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || data.error || 'Falha ao carregar rastreamento.');
      deliveries.clear();
      (data.deliveries || []).forEach((delivery) => deliveries.set(delivery.id, delivery));
      render();
      await connectSocket(sessionToken);
    } catch (error) {
      const status = document.getElementById('mapaEntregaStatus');
      if (status) status.textContent = error.message || 'Nao consegui atualizar o mapa.';
    }
  }

  async function connectSocket(sessionToken) {
    if (socket && lastToken === sessionToken) return;
    if (socket) socket.disconnect();
    await ensureLibraries();
    lastToken = sessionToken;
    socket = window.io(BACKEND, {
      auth: { token: sessionToken },
      transports: ['websocket', 'polling']
    });
    socket.on('delivery:tracking', (event) => {
      const deliveryId = event.deliveryId;
      if (!deliveryId) return;
      if (event.status === 'finalizada' || event.status === 'cancelada') {
        deliveries.delete(deliveryId);
        render();
        return;
      }
      const current = deliveries.get(deliveryId);
      if (!current) {
        refresh();
        return;
      }
      deliveries.set(deliveryId, {
        ...current,
        status: event.status || current.status,
        rastreamentoAtivo: event.rastreamentoAtivo,
        motoboy: event.motoboy || current.motoboy,
        motoboyLocalizacao: event.location || current.motoboyLocalizacao
      });
      render();
    });
  }

  window.addEventListener('DOMContentLoaded', async () => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js?v=167', { updateViaCache: 'none' }).then((registration) => registration.update()).catch(() => {});
    }
    try {
      await ensureLibraries();
      ensureMap();
    } catch (_) {
      const status = document.getElementById('mapaEntregaStatus');
      if (status) status.textContent = 'Nao consegui carregar o mapa. Confira a internet.';
    }
    refresh();
    setInterval(() => {
      if (token() && document.visibilityState === 'visible') refresh();
    }, 15 * 1000);
    window.addEventListener('storage', (event) => {
      if (event.key === TOKEN_KEY) refresh();
    });
    window.addEventListener('delivery:created', () => refresh());
    window.addEventListener('focus', () => {
      if (token()) refresh();
    });
    window.empresaTrackingRefresh = refresh;
  });
})();
