(function () {
  'use strict';

  const BACKEND = 'https://motoboy-conchal.onrender.com';
  const TOKEN_KEY = 'nexusEmpresaToken';
  const deliveries = new Map();
  let selectedId = '';
  let map = null;
  let driverMarker = null;
  let destinationMarker = null;
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
    if (status === 'aceita') return 'Motoboy aceitou - aguardando retirada';
    return status || 'Atualizando';
  }

  function locationOf(delivery) {
    const location = delivery?.motoboyLocalizacao || delivery?.location;
    const latitude = Number(location?.latitude);
    const longitude = Number(location?.longitude);
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
      if (mapStatus) mapStatus.textContent = 'Nenhuma entrega em andamento agora.';
      return;
    }

    const destinationLat = Number(delivery.entregaLat);
    const destinationLon = Number(delivery.entregaLon);
    if (Number.isFinite(destinationLat) && Number.isFinite(destinationLon)) {
      const point = [destinationLat, destinationLon];
      if (!destinationMarker) destinationMarker = window.L.marker(point).addTo(map).bindPopup('Destino da entrega');
      else destinationMarker.setLatLng(point);
    }

    if (!location) {
      if (driverMarker) {
        map.removeLayer(driverMarker);
        driverMarker = null;
      }
      if (destinationMarker) map.setView(destinationMarker.getLatLng(), 15);
      if (mapStatus) mapStatus.textContent = delivery.status === 'aceita'
        ? 'O motoboy aceitou. O mapa comeca a se mover quando ele confirmar a retirada.'
        : 'Aguardando o primeiro sinal de GPS do motoboy.';
      return;
    }

    const point = [location.latitude, location.longitude];
    const icon = window.L.divIcon({
      className: 'motoja-driver-marker',
      html: '<span aria-label="Motoboy">M</span>',
      iconSize: [40, 40],
      iconAnchor: [20, 20]
    });
    if (!driverMarker) driverMarker = window.L.marker(point, { icon }).addTo(map).bindPopup('Motoboy');
    else driverMarker.setLatLng(point);
    map.panTo(point, { animate: true, duration: 0.5 });
    if (mapStatus) mapStatus.textContent = `Localizacao atualizada ${relativeTime(location.serverTimestampMs || location.clientTimestamp)}.`;
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
      navigator.serviceWorker.register('./sw.js?v=148', { updateViaCache: 'none' }).then((registration) => registration.update()).catch(() => {});
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
    }, 5 * 60 * 1000);
    window.addEventListener('storage', (event) => {
      if (event.key === TOKEN_KEY) refresh();
    });
  });
})();
