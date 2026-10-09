// Disponibilidade escolhida pelo motoboy. A contagem publica depende so da escolha
// (Disponivel/Indisponivel), de nao estar em servico e de nao estar bloqueado:
// fechar o app, reiniciar ou perder o celular nao tira o motoboy da contagem.
// Sessoes/heartbeat servem apenas para o painel conversar com o servidor.
// Sem coordenadas ou dados pessoais nas contagens publicas.
export function createDriverAvailability({ now = Date.now, ttlMs = 90000, maxDrivers = 2000, maxSessions = 4, onPreference = () => {} } = {}) {
  const drivers = new Map();
  const cities = ['conchal', 'aguai', 'engenheiro_coelho'];
  const cityMap = enabledCities => Object.fromEntries(cities.map(city => [city, enabledCities?.[city] === true]));
  function entry(cpf) {
    let d = drivers.get(cpf);
    if (!d) {
      if (drivers.size >= maxDrivers) throw new Error('presenca_lotada');
      d = { sessions: new Map(), lastSeen: now(), desired: false, known: false, ready: false, jobs: new Set(), initialRemoved: new Set(), cities: {} };
      drivers.set(cpf, d);
    }
    return d;
  }
  function prune() {
    const at = now();
    for (const [cpf, d] of drivers) {
      for (const [id, seen] of d.sessions) if (at - seen >= ttlMs) d.sessions.delete(id);
      // Quem escolheu Disponivel ou esta em servico continua guardado mesmo sem sessao.
      if (!d.sessions.size && !d.desired && !d.jobs.size && at - d.lastSeen >= ttlMs) drivers.delete(cpf);
    }
  }
  function state(cpf) {
    prune();
    const d = drivers.get(cpf);
    const connected = !!d?.sessions.size;
    return { desired: d?.desired === true, connected, busy: !!d?.jobs.size,
      available: d?.desired === true && d?.ready === true && !d.jobs.size };
  }
  return {
    connect(cpf, id, enabledCities) {
      prune();
      if (!/^\d{11}$/.test(cpf) || typeof id !== 'string' || !id || id.length > 120) throw new Error('presenca_invalida');
      const existing = drivers.get(cpf);
      if (existing && !existing.sessions.has(id) && existing.sessions.size >= maxSessions) throw new Error('muitas_sessoes');
      const d = entry(cpf);
      // fresh: os servicos ativos ainda precisam ser lidos do banco.
      const fresh = !d.ready;
      const preferenceMissing = !d.known;
      d.sessions.set(id, now()); d.lastSeen = now(); d.cities = cityMap(enabledCities);
      return { fresh, preferenceMissing, ...state(cpf) };
    },
    // Escolha salva no banco, carregada quando o servidor reinicia.
    restore(cpf, desired, enabledCities) {
      if (!/^\d{11}$/.test(cpf) || typeof desired !== 'boolean') return;
      const d = entry(cpf); d.desired = desired; d.known = true; d.cities = cityMap(enabledCities); d.lastSeen = now();
    },
    heartbeat(cpf, id) {
      prune(); const d = drivers.get(cpf);
      if (!d?.sessions.has(id)) throw new Error('presenca_expirada');
      d.sessions.set(id, now()); d.lastSeen = now(); return state(cpf);
    },
    set(cpf, id, desired) {
      if (typeof desired !== 'boolean') throw new Error('disponibilidade_invalida');
      this.heartbeat(cpf, id);
      const d = drivers.get(cpf); const changed = d.desired !== desired || !d.known;
      d.desired = desired; d.known = true;
      if (changed) onPreference(cpf, desired);
      return state(cpf);
    },
    cities(cpf, enabledCities) { const d = drivers.get(cpf); if (d) d.cities = cityMap(enabledCities); },
    initializeJobs(cpf, jobs) { const d = drivers.get(cpf); if (d) { for (const key of jobs) if (!d.initialRemoved.has(key)) d.jobs.add(key); d.initialRemoved.clear(); d.ready = true; } },
    job(kind, id, status, cpf = '') {
      const key = `${kind}:${id}`;
      const active = ['aceita', 'retirada'].includes(status);
      if (!active) { for (const d of drivers.values()) { d.jobs.delete(key); if (!d.ready) d.initialRemoved.add(key); } }
      else if (/^\d{11}$/.test(cpf)) { try { entry(cpf).jobs.add(key); } catch {} }
    },
    disconnect(cpf, id) { const d = drivers.get(cpf); if (d) { d.sessions.delete(id); d.lastSeen = now(); } },
    // Falha de autenticacao: so descarta a sessao; a escolha continua valendo.
    drop(cpf) { const d = drivers.get(cpf); if (d && !d.sessions.size && !d.desired && !d.jobs.size) drivers.delete(cpf); },
    // Bloqueio do dono: sai da contagem e a escolha volta para Indisponivel.
    remove(cpf) { const d = drivers.get(cpf); drivers.delete(cpf); if (d?.desired) onPreference(cpf, false); },
    state,
    publicCounts() {
      prune(); const counts = Object.fromEntries(cities.map(c => [c, 0]));
      for (const d of drivers.values()) if (d.desired && d.ready && !d.jobs.size) for (const city of cities) if (d.cities[city]) counts[city]++;
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
