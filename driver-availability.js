(() => {
  'use strict';
  let socket, options, timer, stopped = true, state = { connected: false, desired: false, busy: false }, changing = false;
  let generation = 0, preferenceKey = '';
  const remembered = new Map(), preferenceTtl = 24 * 60 * 60 * 1000;
  function preference() {
    let value;
    try { value = JSON.parse(localStorage.getItem(preferenceKey) || 'null') || remembered.get(preferenceKey); }
    catch { value = remembered.get(preferenceKey); }
    if (typeof value?.desired === 'boolean' && Number.isFinite(value.at) && Date.now() >= value.at && Date.now() - value.at < preferenceTtl) return value;
  }
  function remember(desired) {
    if (!preferenceKey) return;
    const value = { desired, at: Date.now() }; remembered.set(preferenceKey, value);
    try { localStorage.setItem(preferenceKey, JSON.stringify(value)); } catch {}
  }
  function forget() {
    remembered.delete(preferenceKey);
    try { localStorage.removeItem(preferenceKey); } catch {}
  }
  const box = () => document.getElementById('driver-availability');
  function render() {
    const root = box(); if (!root) return;
    root.hidden = stopped;
    root.dataset.state = state.connected && state.available ? 'available' : 'offline';
    root.querySelectorAll('[data-available]').forEach(button => {
      button.setAttribute('aria-pressed', String(state.desired === (button.dataset.available === 'true')));
      button.disabled = !state.connected || changing;
    });
    const status = root.querySelector('[data-availability-status]');
    status.textContent = !state.connected ? 'Conectando disponibilidade…' : state.busy ? 'Em atendimento · fora da contagem de disponíveis' : state.desired ? 'Disponível para novos serviços' : 'Indisponível para novos serviços';
  }
  function apply(next) {
    const previous = `${state.connected}:${state.desired}`; state = next;
    if (next.connected && !changing) remember(next.desired);
    render(); if (previous !== `${state.connected}:${state.desired}`) options?.onChange?.();
  }
  function setAvailability(desired, restored = false) {
    if (!socket?.connected || changing) return;
    const current = generation, session = socket.id; changing = true; render();
    socket.timeout(8000).emit('availability:set', { available: desired }, (error, reply) => {
      if (current !== generation || stopped || session !== socket?.id || !socket.connected) return;
      changing = false;
      if (!error && reply?.ok) apply(reply);
      else { render(); if (!restored) alert(reply?.message || 'Não consegui confirmar a disponibilidade. Tente novamente.'); }
    });
  }
  function library() {
    if (window.io) return Promise.resolve();
    if (window.__motojaSocketLibrary) return window.__motojaSocketLibrary;
    window.__motojaSocketLibrary = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `${options.backend}/socket.io/socket.io.js`;
      const timeout = setTimeout(() => { script.remove(); reject(new Error('conexao_indisponivel')); }, 15000);
      script.onload = () => { clearTimeout(timeout); window.io ? resolve() : reject(new Error('conexao_indisponivel')); };
      script.onerror = () => { clearTimeout(timeout); reject(new Error('conexao_indisponivel')); };
      document.head.appendChild(script);
    }).catch(error => { delete window.__motojaSocketLibrary; throw error; });
    return window.__motojaSocketLibrary;
  }
  async function connect() {
    if (stopped || document.visibilityState === 'hidden') return;
    const current = generation;
    try {
      await library(); if (stopped || current !== generation || document.visibilityState === 'hidden') return;
      if (socket) { socket.connect(); return; }
      socket = window.io(`${options.backend}/driver-availability`, { auth: callback => callback(options.getProof()), transports: ['websocket', 'polling'], timeout: 12000, reconnectionDelay: 2000, reconnectionDelayMax: 15000 });
      socket.on('availability:state', next => {
        if (stopped || current !== generation) return;
        const saved = preference();
        if (next.preferenceMissing === true && saved?.desired === true) {
          // Restore a confirmed choice only after authentication and server job initialization.
          state = { ...next, connected: false, desired: true, available: false }; setAvailability(true, true);
        } else apply(next);
      });
      socket.on('disconnect', () => { if (current !== generation || stopped) return; changing = false; state = { ...state, connected: false, available: false }; render(); options?.onChange?.(); });
      socket.on('connect_error', () => {
        if (current !== generation || stopped) return;
        state = { ...state, connected: false, available: false }; render();
        const label = box()?.querySelector('[data-availability-status]');
        if (label) label.textContent = 'Sem conexão de disponibilidade · tentando reconectar';
      });
    } catch {
      const label = box()?.querySelector('[data-availability-status]');
      if (label) label.textContent = 'Disponibilidade sem conexão. Confira a internet.';
    }
  }
  function heartbeat() {
    if (stopped) return;
    if (!socket?.connected) { connect(); return; }
    const current = generation, session = socket.id;
    socket.timeout(8000).emit('availability:heartbeat', {}, (error, reply) => {
      if (current !== generation || stopped || session !== socket?.id || !socket.connected) return;
      if (!error && reply?.ok) apply(reply);
      else { state = { ...state, connected: false, available: false }; render(); socket.disconnect(); connect(); }
    });
  }
  window.MotojaDriverAvailability = {
    start(config) {
      this.stop({ forgetPreference: false }); options = config; stopped = false;
      const cpf = String(options.getProof()?.driverCpf || '').replace(/\D/g, '');
      preferenceKey = /^\d{11}$/.test(cpf) ? `motoja:availability:${cpf}` : '';
      state = { connected: false, desired: preference()?.desired === true, busy: false }; render();
      box()?.querySelectorAll('[data-available]').forEach(button => {
        button.onclick = () => {
          setAvailability(button.dataset.available === 'true');
        };
      });
      connect(); timer = setInterval(heartbeat, 30000);
    },
    stop({ forgetPreference = true } = {}) { stopped = true; generation++; if (forgetPreference) forget(); clearInterval(timer); socket?.disconnect(); socket = null; changing = false; state = { connected: false, desired: false, busy: false }; render(); },
    canReceive() { return stopped ? null : state.connected && state.desired; }
  };
  document.addEventListener('visibilitychange', () => {
    if (stopped) return;
    if (document.visibilityState === 'visible') heartbeat();
  });
  window.addEventListener('offline', () => socket?.disconnect());
  window.addEventListener('online', connect);
  window.addEventListener('pagehide', () => socket?.disconnect());
  window.addEventListener('pageshow', () => { if (!stopped) heartbeat(); });
})();
