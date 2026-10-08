// Ephemeral presence: no Firebase writes, coordinates or personal data in public counts.
export function createDriverAvailability({ now = Date.now, ttlMs = 90000, maxDrivers = 2000, maxSessions = 4 } = {}) {
  const drivers = new Map();
  const cities = ['conchal', 'aguai', 'engenheiro_coelho'];
  function prune() {
    const at = now();
    for (const [cpf, d] of drivers) {
      for (const [id, seen] of d.sessions) if (at - seen >= ttlMs) d.sessions.delete(id);
      if (!d.sessions.size && at - d.lastSeen >= ttlMs) drivers.delete(cpf);
    }
  }
  function state(cpf) {
    prune();
    const d = drivers.get(cpf);
    const connected = !!d?.sessions.size;
    return { desired: d?.desired === true, connected, busy: !!d?.jobs.size,
      available: connected && d?.desired === true && d?.ready === true && !d.jobs.size };
  }
  return {
    connect(cpf, id, enabledCities) {
      prune();
      if (!/^\d{11}$/.test(cpf) || typeof id !== 'string' || !id || id.length > 120) throw new Error('presenca_invalida');
      let d = drivers.get(cpf);
      if (!d && drivers.size >= maxDrivers) throw new Error('presenca_lotada');
      if (d && !d.sessions.has(id) && d.sessions.size >= maxSessions) throw new Error('muitas_sessoes');
      const fresh = !d;
      if (!d) { d = { sessions: new Map(), lastSeen: now(), desired: false, ready: false, jobs: new Set(), initialRemoved: new Set(), cities: {} }; drivers.set(cpf, d); }
      d.sessions.set(id, now()); d.lastSeen = now(); d.cities = Object.fromEntries(cities.map(city => [city, enabledCities?.[city] === true]));
      return { fresh, ...state(cpf) };
    },
    heartbeat(cpf, id) {
      prune(); const d = drivers.get(cpf);
      if (!d?.sessions.has(id)) throw new Error('presenca_expirada');
      d.sessions.set(id, now()); d.lastSeen = now(); return state(cpf);
    },
    set(cpf, id, desired) {
      if (typeof desired !== 'boolean') throw new Error('disponibilidade_invalida');
      this.heartbeat(cpf, id); drivers.get(cpf).desired = desired; return state(cpf);
    },
    cities(cpf, enabledCities) { const d = drivers.get(cpf); if (d) d.cities = Object.fromEntries(cities.map(c => [c, enabledCities?.[c] === true])); },
    initializeJobs(cpf, jobs) { const d = drivers.get(cpf); if (d) { for (const key of jobs) if (!d.initialRemoved.has(key)) d.jobs.add(key); d.initialRemoved.clear(); d.ready = true; } },
    job(kind, id, status, cpf = '') {
      const key = `${kind}:${id}`;
      const active = ['aceita', 'retirada'].includes(status);
      if (!active) { for (const d of drivers.values()) { d.jobs.delete(key); if (!d.ready) d.initialRemoved.add(key); } }
      else if (drivers.has(cpf)) drivers.get(cpf).jobs.add(key);
    },
    disconnect(cpf, id) { const d = drivers.get(cpf); if (d) { d.sessions.delete(id); d.lastSeen = now(); } },
    remove(cpf) { drivers.delete(cpf); },
    state,
    publicCounts() {
      prune(); const counts = Object.fromEntries(cities.map(c => [c, 0]));
      for (const d of drivers.values()) if (d.sessions.size && d.desired && d.ready && !d.jobs.size) for (const city of cities) if (d.cities[city]) counts[city]++;
      return { ok: true, counts, updatedAt: now(), expiresInMs: 45000 };
    }
  };
}

// Only observe successful server responses; never infer success from a click.
export function observeAvailabilityJob(presence, path, status, body, driverCpf = '') {
  if (status < 200 || status >= 300 || body?.ok !== true) return;
  const match = path.split('?')[0].match(/^\/api\/(?:admin\/|companies\/me\/)?(rides|deliveries)\/([^/]+)\/(accept|finish|force-finish|cancel|client-cancel|approve-completion|deny-completion)$/);
  const support = path.match(/^\/api\/support\/operations\/(corrida|entrega)\/([^/]+)\/finish$/);
  if (match) {
    const [, kind, id, action] = match;
    if (action === 'accept') presence.job(kind, id, 'aceita', driverCpf);
    else if (!body.pendingApproval) presence.job(kind, id, 'finalizada');
    return true;
  } else if (support && !body.pendingApproval) { presence.job(support[1] === 'corrida' ? 'rides' : 'deliveries', support[2], 'finalizada'); return true; }
}
