(() => {
  'use strict';
  let socket, options, timer, stopped = true, state = { connected: false, desired: false, busy: false }, changing = false;
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
  function apply(next) { const previous = `${state.connected}:${state.desired}`; state = next; render(); if (previous !== `${state.connected}:${state.desired}`) options?.onChange?.(); }
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
    try {
      await library(); if (stopped || document.visibilityState === 'hidden') return;
      if (socket) { socket.connect(); return; }
      socket = window.io(`${options.backend}/driver-availability`, { auth: callback => callback(options.getProof()), transports: ['websocket', 'polling'], timeout: 12000, reconnectionDelay: 2000, reconnectionDelayMax: 15000 });
      socket.on('availability:state', apply);
      socket.on('disconnect', () => { state = { ...state, connected: false, available: false }; render(); options?.onChange?.(); });
      socket.on('connect_error', () => {
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
    if (stopped || document.visibilityState === 'hidden') return;
    if (!socket?.connected) { connect(); return; }
    socket.timeout(8000).emit('availability:heartbeat', {}, (error, reply) => {
      if (!error && reply?.ok) apply(reply);
      else { state = { ...state, connected: false, available: false }; render(); socket.disconnect(); connect(); }
    });
  }
  window.MotojaDriverAvailability = {
    start(config) {
      this.stop(); options = config; stopped = false; state = { connected: false, desired: false, busy: false }; render();
      box()?.querySelectorAll('[data-available]').forEach(button => {
        button.onclick = () => {
          if (!socket?.connected || changing) return;
          changing = true; render();
          socket.timeout(8000).emit('availability:set', { available: button.dataset.available === 'true' }, (error, reply) => {
            changing = false;
            if (!error && reply?.ok) apply(reply);
            else { render(); alert(reply?.message || 'Não consegui confirmar a disponibilidade. Tente novamente.'); }
          });
        };
      });
      connect(); timer = setInterval(heartbeat, 30000);
    },
    stop() { stopped = true; clearInterval(timer); socket?.disconnect(); socket = null; changing = false; state = { connected: false, desired: false, busy: false }; render(); },
    canReceive() { return stopped ? null : state.connected && state.desired; }
  };
  document.addEventListener('visibilitychange', () => {
    if (stopped) return;
    if (document.visibilityState === 'hidden') socket?.disconnect(); else connect();
  });
  window.addEventListener('offline', () => socket?.disconnect());
  window.addEventListener('online', connect);
  window.addEventListener('pagehide', () => socket?.disconnect());
})();
