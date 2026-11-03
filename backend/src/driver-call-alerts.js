const kinds = new Set(['rides', 'deliveries']);
export function callOfferExpiry(kind, job, durations = { rides: 10 * 60000, deliveries: 15 * 60000 }) {
  const created = typeof job?.criadaEm?.toMillis === 'function' ? job.criadaEm.toMillis()
    : Number(job?.criadaEm?.seconds || job?.criadaEm?._seconds || 0) * 1000;
  return Number(job?.expiraEmMs) || (created ? created + durations[kind] : 0);
}

export async function reconcileCallOffers(offers, { load, allowed, now = Date.now(), expiry = callOfferExpiry }) {
  if (!Array.isArray(offers) || offers.length > 30) throw new Error('chamadas_invalidas');
  const unique = new Map();
  for (const offer of offers) {
    if (!kinds.has(offer?.kind) || !/^[a-zA-Z0-9_-]{1,120}$/.test(offer.id || '')) throw new Error('chamadas_invalidas');
    unique.set(`${offer.kind}:${offer.id}`, offer);
  }
  const result = await Promise.all([...unique.values()].map(async ({ kind, id }) => {
    const job = await load(kind, id);
    if (!job || job.status !== 'pendente' || !allowed(kind, job)) return null;
    const expiresAtMs = expiry(kind, job);
    return expiresAtMs > now ? { kind, id, expiresAtMs } : null;
  }));
  return result.filter(Boolean);
}

// Apenas o Android atualizado recebe mensagens de dados para controlar o loop.
// Os demais aparelhos mantêm a notificação compatível com a versão instalada.
export function createCallPushDispatcher({ send, changed = () => {}, now = Date.now, expiry = callOfferExpiry }) {
  const devices = new Map();
  function remember(token, info) {
    if (!token || info?.ativo === false) { devices.delete(token); return; }
    if (info?.plataforma === 'android_nativo' && Number(info.callAlertVersion) === 1) devices.set(token, true);
    else devices.delete(token);
    if (devices.size > 10000) devices.delete(devices.keys().next().value);
  }
  async function batch(tokens, build) {
    const totals = { successCount: 0, failureCount: 0 };
    for (let at = 0; at < tokens.length; at += 500) {
      const result = await send(build(tokens.slice(at, at + 500)));
      totals.successCount += result.successCount || 0;
      totals.failureCount += result.failureCount || 0;
    }
    return totals;
  }
  return {
    remember,
    async offer(message, { kind, id, job, ring = true }) {
      const normal = message.tokens.filter(token => !ring || !devices.has(token));
      const native = ring ? message.tokens.filter(token => devices.has(token)) : [];
      if (ring && Number(message.data?.repeticao || 0) === 0) changed(kind, id, 'pendente');
      const results = await Promise.all([
        batch(normal, tokens => ({ ...message, tokens })),
        batch(native, tokens => ({ tokens, android: { priority: 'high', ttl: 120000 }, data: {
          ...message.data, callAlertVersion: '1', action: 'available', kind, id,
          title: message.notification?.title || 'MotoJÁ — chamado disponível',
          body: message.notification?.body || 'Abra o app para aceitar.',
          // O primeiro envio pode anteceder a resolução de serverTimestamp().
          // O Android só toca após reconciliar com a data gravada no servidor.
          expiresAtMs: String(expiry(kind, job) || expiry(kind, { ...job, criadaEm: { seconds: now() / 1000 } })), sentAtMs: String(now())
        } }))
      ]);
      return results.reduce((sum, r) => ({ successCount: sum.successCount + r.successCount, failureCount: sum.failureCount + r.failureCount }), { successCount: 0, failureCount: 0 });
    },
    async closed(kind, id) {
      if (!kinds.has(kind)) return;
      changed(kind, id, 'encerrada');
      return batch([...devices.keys()], tokens => ({ tokens, android: { priority: 'high', ttl: 60000 },
        data: { callAlertVersion: '1', action: 'removed', kind, id, sentAtMs: String(now()) } }));
    }
  };
}
