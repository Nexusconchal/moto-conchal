(function () {
  'use strict';

  const BACKEND = 'https://motoboy-conchal.onrender.com';
  const STORAGE_KEY = 'motoJaMotoboyDados';
  const watches = new Map();
  const jobs = new Map();
  const rideWatches = new Map();
  const rideJobs = new Map();
  let loading = false;

  function savedDriver() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch (_) {
      return {};
    }
  }

  function proof() {
    const driver = savedDriver();
    return {
      driverCpf: String(driver.cpf || '').replace(/\D/g, ''),
      driverCnh: String(driver.cnh || '').replace(/\D/g, ''),
      driverTelefone: String(driver.telefone || '').replace(/\D/g, ''),
      driverName: String(driver.nome || '').trim()
    };
  }

  async function post(path, body) {
    const response = await fetch(`${BACKEND}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error || 'Nao consegui atualizar a entrega.');
    return data;
  }

  function distanceMeters(a, b) {
    if (!a || !b) return Infinity;
    const rad = Math.PI / 180;
    const dLat = (b.latitude - a.latitude) * rad;
    const dLon = (b.longitude - a.longitude) * rad;
    const lat1 = a.latitude * rad;
    const lat2 = b.latitude * rad;
    const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
  }

  function stopTracking(deliveryId) {
    const current = watches.get(deliveryId);
    if (!current) return;
    navigator.geolocation.clearWatch(current.watchId);
    watches.delete(deliveryId);
  }

  function startTracking(deliveryId) {
    if (watches.has(deliveryId) || !navigator.geolocation) return;
    const state = { watchId: 0, lastSentAt: 0, lastLocation: null, sending: false };
    state.watchId = navigator.geolocation.watchPosition(async (position) => {
      const currentJob = jobs.get(deliveryId);
      if (!currentJob || currentJob.status !== 'retirada') {
        stopTracking(deliveryId);
        return;
      }
      const location = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
        heading: position.coords.heading,
        speed: position.coords.speed,
        timestamp: position.timestamp || Date.now()
      };
      const elapsed = Date.now() - state.lastSentAt;
      if (state.sending || (elapsed < 8000 && distanceMeters(state.lastLocation, location) < 12)) return;
      state.sending = true;
      try {
        await post(`/api/deliveries/${encodeURIComponent(deliveryId)}/location`, { ...proof(), ...location });
        state.lastSentAt = Date.now();
        state.lastLocation = location;
        setTrackingMessage(deliveryId, 'GPS ativo: a empresa esta acompanhando esta entrega.', false);
      } catch (error) {
        if (/rastreamento_nao_ativo|finalizada|cancelada/i.test(error.message)) stopTracking(deliveryId);
        setTrackingMessage(deliveryId, error.message || 'Falha ao enviar GPS.', true);
      } finally {
        state.sending = false;
      }
    }, (error) => {
      const message = error.code === 1
        ? 'GPS bloqueado. Libere a localizacao do app para continuar a entrega.'
        : 'Nao consegui obter o GPS. Verifique a localizacao e a internet.';
      setTrackingMessage(deliveryId, message, true);
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    watches.set(deliveryId, state);
  }

  function stopRideTracking(rideId) {
    const current = rideWatches.get(rideId);
    if (!current) return;
    navigator.geolocation.clearWatch(current.watchId);
    rideWatches.delete(rideId);
  }

  function startRideTracking(rideId) {
    if (rideWatches.has(rideId) || !navigator.geolocation) return;
    const state = { watchId: 0, lastSentAt: 0, lastLocation: null, sending: false };
    state.watchId = navigator.geolocation.watchPosition(async (position) => {
      const ride = rideJobs.get(rideId);
      if (!ride || ride.status !== 'aceita' || !ride.clienteAvisadoEm) {
        stopRideTracking(rideId);
        return;
      }
      const location = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
        heading: position.coords.heading,
        speed: position.coords.speed,
        timestamp: position.timestamp || Date.now()
      };
      const elapsed = Date.now() - state.lastSentAt;
      if (state.sending || (elapsed < 8000 && distanceMeters(state.lastLocation, location) < 12)) return;
      state.sending = true;
      try {
        await post(`/api/rides/${encodeURIComponent(rideId)}/location`, { ...proof(), ...location });
        state.lastSentAt = Date.now();
        state.lastLocation = location;
        setTrackingMessage(rideId, 'GPS ativo: o cliente acompanha sua chegada. Mantenha o app aberto.', false);
      } catch (error) {
        if (/rastreamento_nao_ativo|finalizada|cancelada/i.test(error.message)) stopRideTracking(rideId);
        setTrackingMessage(rideId, error.message || 'Falha ao enviar GPS.', true);
      } finally {
        state.sending = false;
      }
    }, (error) => {
      const message = error.code === 1
        ? 'GPS bloqueado. Libere a localizacao para o cliente acompanhar sua chegada.'
        : 'Nao consegui obter o GPS. Verifique a localizacao e a internet.';
      setTrackingMessage(rideId, message, true);
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    rideWatches.set(rideId, state);
  }

  function cardFor(deliveryId) {
    return [...document.querySelectorAll('[data-finalizar]')]
      .find((button) => button.dataset.finalizar === deliveryId)
      ?.closest('article');
  }

  function setTrackingMessage(deliveryId, message, isError) {
    const card = cardFor(deliveryId);
    if (!card) return;
    let box = card.querySelector('[data-tracking-message]');
    if (!box) {
      box = document.createElement('p');
      box.dataset.trackingMessage = '1';
      const actions = card.querySelector('.actions');
      actions?.before(box);
    }
    const className = isError ? 'status danger' : 'status';
    if (box.className !== className) box.className = className;
    if (box.style.display !== 'block') box.style.display = 'block';
    if (box.textContent !== message) box.textContent = message;
  }

  function decorateCards() {
    document.querySelectorAll('[data-finalizar]').forEach((finishButton) => {
      const deliveryId = finishButton.dataset.finalizar;
      const job = jobs.get(deliveryId);
      if (!job || job.tipo !== 'entrega_empresarial') return;
      const exclusive = job.tipoEntrega === 'MotoJa Exclusivo' || job.tipo === 'servico_exclusivo';
      const card = finishButton.closest('article');
      const actions = card?.querySelector('.actions');
      if (!actions) return;

      let pickupButton = actions.querySelector('[data-confirmar-retirada]');
      if (!exclusive && !pickupButton) {
        pickupButton = document.createElement('button');
        pickupButton.type = 'button';
        pickupButton.className = 'done';
        pickupButton.dataset.confirmarRetirada = deliveryId;
        actions.insertBefore(pickupButton, finishButton);
        pickupButton.addEventListener('click', async () => {
          pickupButton.disabled = true;
          pickupButton.textContent = 'Ativando GPS...';
          try {
            await post(`/api/deliveries/${encodeURIComponent(deliveryId)}/pickup`, proof());
            job.status = 'retirada';
            startTracking(deliveryId);
            decorateCards();
          } catch (error) {
            alert(error.message || 'Nao consegui confirmar a retirada.');
            pickupButton.disabled = false;
            pickupButton.textContent = 'Confirmei a retirada e iniciar GPS';
          }
        });
      }

      if (exclusive) return;
      if (job.status === 'aceita') {
        pickupButton.disabled = false;
        pickupButton.textContent = 'Confirmei a retirada e iniciar GPS';
        finishButton.disabled = true;
        setTrackingMessage(deliveryId, 'Ao retirar o pedido, confirme aqui para liberar a entrega e o rastreamento.', false);
      } else if (job.status === 'retirada') {
        pickupButton.disabled = true;
        pickupButton.textContent = 'Pedido retirado - GPS ativo';
        finishButton.disabled = false;
        startTracking(deliveryId);
        setTrackingMessage(deliveryId, 'GPS ativo: mantenha o app aberto durante o trajeto.', false);
      } else {
        pickupButton.disabled = true;
        stopTracking(deliveryId);
      }
    });
  }

  function decorateRideCards() {
    document.querySelectorAll('[data-finalizar]').forEach((finishButton) => {
      const rideId = finishButton.dataset.finalizar;
      const ride = rideJobs.get(rideId);
      if (!ride || ride.tipo === 'entrega_empresarial') return;
      if (ride.status === 'aceita' && ride.clienteAvisadoEm) {
        startRideTracking(rideId);
        setTrackingMessage(rideId, 'GPS ativo: o cliente acompanha sua chegada. Mantenha o app aberto.', false);
      } else {
        stopRideTracking(rideId);
      }
    });
  }

  async function refreshJobs() {
    if (loading) return;
    const credentials = proof();
    if (credentials.driverCpf.length !== 11 || credentials.driverCnh.length !== 11 || credentials.driverTelefone.length < 10) return;
    loading = true;
    try {
      const data = await post(`/api/drivers/${credentials.driverCpf}/jobs`, {
        ...credentials,
        kind: 'deliveries',
        scope: 'mine'
      });
      jobs.clear();
      (data.jobs || []).forEach((job) => jobs.set(job.id, job));
      for (const deliveryId of watches.keys()) {
        if (jobs.get(deliveryId)?.status !== 'retirada') stopTracking(deliveryId);
      }
      decorateCards();
      const rides = await post(`/api/drivers/${credentials.driverCpf}/jobs`, {
        ...credentials,
        kind: 'rides',
        scope: 'mine'
      });
      rideJobs.clear();
      (rides.jobs || []).forEach((job) => rideJobs.set(job.id, job));
      for (const rideId of rideWatches.keys()) {
        const ride = rideJobs.get(rideId);
        if (!ride || ride.status !== 'aceita' || !ride.clienteAvisadoEm) stopRideTracking(rideId);
      }
      decorateRideCards();
    } catch (_) {
      // O painel principal ja mostra erros de conexao; aqui mantemos o GPS atual sem interromper.
    } finally {
      loading = false;
    }
  }

  const observer = new MutationObserver(() => {
    decorateCards();
    decorateRideCards();
  });
  window.addEventListener('DOMContentLoaded', () => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js?v=150', { updateViaCache: 'none' }).then((registration) => registration.update()).catch(() => {});
    }
    const list = document.getElementById('lista');
    if (list) observer.observe(list, { childList: true, subtree: true });
    refreshJobs();
    window.addEventListener('motoja:jobs-rendered', (event) => {
      if (event.detail?.scope !== 'mine' || !Array.isArray(event.detail?.jobs)) return;
      const incoming = event.detail.jobs;
      if (event.detail.kind === 'deliveries') {
        jobs.clear();
        incoming.forEach((job) => jobs.set(job.id, job));
        for (const deliveryId of watches.keys()) {
          if (jobs.get(deliveryId)?.status !== 'retirada') stopTracking(deliveryId);
        }
        decorateCards();
        return;
      }
      if (event.detail.kind === 'rides') {
        rideJobs.clear();
        incoming.forEach((job) => rideJobs.set(job.id, job));
        for (const rideId of rideWatches.keys()) {
          const ride = rideJobs.get(rideId);
          if (!ride || ride.status !== 'aceita' || !ride.clienteAvisadoEm) stopRideTracking(rideId);
        }
        decorateRideCards();
      }
    });
    window.addEventListener('motoja:ride-gps-start', (event) => {
      const rideId = String(event.detail?.rideId || '');
      if (!rideId) return;
      const ride = rideJobs.get(rideId) || { id: rideId, status: 'aceita' };
      ride.clienteAvisadoEm = ride.clienteAvisadoEm || { seconds: Math.floor(Date.now() / 1000) };
      rideJobs.set(rideId, ride);
      startRideTracking(rideId);
    });
    setInterval(() => {
      if (document.visibilityState === 'visible' && (watches.size > 0 || rideWatches.size > 0)) refreshJobs();
    }, 5 * 60 * 1000);
  });
})();
