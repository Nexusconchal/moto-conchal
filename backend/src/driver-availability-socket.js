export function attachDriverAvailability(io, presence, { verifyDriver, enabledCities, loadJobs, now = Date.now }) {
  const namespace = io.of('/driver-availability');
  const initializations = new Map();
  const connections = new Map();
  const room = cpf => `driver:${cpf}`;
  const publish = cpf => namespace.to(room(cpf)).emit('availability:state', presence.state(cpf));
  namespace.use(async (socket, next) => {
    try {
      const ip = socket.handshake.address || 'unknown';
      for (const [key, value] of connections) if (value.until <= now()) connections.delete(key);
      const attempts = connections.get(ip) || { count: 0, until: now() + 60000 };
      if (connections.size >= 5000 && !connections.has(ip)) throw new Error('muitas_conexoes');
      connections.set(ip, attempts);
      if (++attempts.count > 60) throw new Error('muitas_conexoes');
      const proof = socket.handshake.auth || {};
      const cpf = String(proof.driverCpf || '').replace(/\D/g, '');
      if (!/^\d{11}$/.test(cpf)) throw new Error('dados_motoboy_invalidos');
      const driver = await verifyDriver(cpf, proof);
      const { fresh } = presence.connect(cpf, socket.id, enabledCities(driver));
      socket.data.availabilityCpf = cpf; socket.data.verifiedAt = now();
      // A shared initialization handles simultaneous tabs without duplicate database queries.
      if (fresh) initializations.set(cpf, Promise.resolve().then(() => loadJobs(cpf))
        .then(jobs => presence.initializeJobs(cpf, jobs)));
      if (initializations.has(cpf)) await initializations.get(cpf);
      next();
    } catch {
      const cpf = socket.data.availabilityCpf;
      if (cpf) { presence.disconnect(cpf, socket.id); if (!presence.state(cpf).connected) presence.remove(cpf); }
      next(new Error('disponibilidade_nao_autorizada'));
    } finally { if (socket.data.availabilityCpf) initializations.delete(socket.data.availabilityCpf); }
  });
  namespace.on('connection', socket => {
    const cpf = socket.data.availabilityCpf;
    socket.join(room(cpf));
    socket.emit('availability:state', presence.state(cpf));
    let eventsAt = now(), events = 0;
    let queue = Promise.resolve();
    function handle(action) {
      socket.on(action, (payload, ack) => {
        if (typeof ack !== 'function') return;
        const at = now();
        if (at - eventsAt >= 60000) { eventsAt = at; events = 0; }
        if (++events > 20) return ack({ ok: false, message: 'Aguarde antes de alterar novamente.' });
        if (action === 'availability:set' && typeof payload?.available !== 'boolean') return ack({ ok: false, message: 'Disponibilidade inválida.' });
        queue = queue.then(async () => {
          try {
            if (!socket.connected) return;
            if (now() - socket.data.verifiedAt >= 5 * 60000) {
              const driver = await verifyDriver(cpf, socket.handshake.auth);
              presence.cities(cpf, enabledCities(driver)); socket.data.verifiedAt = now();
            }
            const state = action === 'availability:set' ? presence.set(cpf, socket.id, payload.available) : presence.heartbeat(cpf, socket.id);
            ack({ ok: true, ...state }); publish(cpf);
          } catch {
            presence.disconnect(cpf, socket.id); publish(cpf);
            ack({ ok: false, message: 'Reconecte o painel para atualizar a disponibilidade.' }); socket.disconnect(true);
          }
        });
      });
    }
    handle('availability:set'); handle('availability:heartbeat');
    socket.on('disconnect', () => { presence.disconnect(cpf, socket.id); publish(cpf); });
  });
  return { publish, publishAll() { for (const cpf of new Set([...namespace.sockets.values()].map(s => s.data.availabilityCpf))) publish(cpf); },
    revoke(cpf) { presence.remove(cpf); namespace.in(room(cpf)).disconnectSockets(true); } };
}
