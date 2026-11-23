// Espelho ao vivo das corridas e entregas em andamento (economia do banco).
//
// Antes, cada app que abria a lista de chamadas, o status da corrida ou o painel da
// loja fazia o servidor consultar o banco de novo, a cada poucos segundos. O Firestore
// cobra leitura em toda consulta, mesmo quando volta vazia. Agora o servidor "escuta"
// essas listas uma vez: o banco avisa so o que mudou e cobra 1 leitura por documento
// alterado. As rotas leem daqui, da memoria.
//
// Seguranca: enquanto o espelho nao esta pronto (servidor acabou de ligar, banco fora)
// ou logo depois de o proprio servidor gravar uma corrida/entrega (o aviso do banco
// ainda nao chegou), ready() responde false e as rotas consultam o banco como antes.

export const LIVE_JOB_STATUSES = Object.freeze({
  corridas: ['pendente', 'aceita', 'retirada'],
  entregas: ['pendente', 'aceita', 'retirada']
});

export function createLiveJobs({
  db,
  watch = LIVE_JOB_STATUSES,
  now = Date.now,
  settleMs = 4000,
  retryMs = 20000,
  log = console,
  onChange = () => {},
  onReads = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  const lists = new Map();
  for (const [name, statuses] of Object.entries(watch)) {
    lists.set(name, { name, statuses: [...statuses], docs: new Map(), ready: false, unsubscribe: null, timer: null, failures: 0, writes: new Map(), changes: 0, readyAt: 0 });
  }
  let started = false;

  function retry(list, error) {
    list.ready = false;
    list.docs.clear();
    list.writes.clear();
    try { list.unsubscribe?.(); } catch { /* ja parou */ }
    list.unsubscribe = null;
    list.failures += 1;
    log.error?.(`[espelho] ${list.name} parou: ${String(error?.message || error).slice(0, 160)}`);
    if (!started) return;
    const wait = Math.min(10 * 60000, retryMs * 2 ** Math.min(5, list.failures - 1));
    clearTimer(list.timer);
    list.timer = setTimer(() => listen(list), wait);
    list.timer?.unref?.();
  }

  function listen(list) {
    clearTimer(list.timer);
    list.timer = null;
    if (!started) return;
    try {
      list.unsubscribe = db.collection(list.name).where('status', 'in', list.statuses).onSnapshot((snapshot) => {
        const changes = snapshot.docChanges();
        // A primeira resposta vazia tambem e cobrada (1 leitura).
        try { onReads(Math.max(changes.length, list.ready ? 0 : 1), list.name); } catch { /* medidor nunca derruba */ }
        for (const change of changes) {
          const id = change.doc.id;
          const before = list.docs.get(id);
          if (change.type === 'removed') list.docs.delete(id);
          else list.docs.set(id, change.doc);
          list.writes.delete(id);
          list.changes += 1;
          try {
            onChange(list.name, change.type, before ? before.data() || {} : null, change.type === 'removed' ? null : change.doc.data() || {}, id);
          } catch (error) {
            log.error?.(`[espelho] aviso de mudanca falhou: ${String(error?.message || error).slice(0, 120)}`);
          }
        }
        if (!list.ready) list.readyAt = now();
        list.ready = true;
        list.failures = 0;
      }, (error) => retry(list, error));
    } catch (error) {
      retry(list, error);
    }
  }

  function settled(list) {
    if (!list.writes.size) return true;
    const t = now();
    for (const [id, at] of list.writes) if (t - at > settleMs) list.writes.delete(id);
    return list.writes.size === 0;
  }

  return {
    start() {
      if (started) return;
      started = true;
      for (const list of lists.values()) listen(list);
    },
    stop() {
      started = false;
      for (const list of lists.values()) {
        clearTimer(list.timer);
        list.timer = null;
        try { list.unsubscribe?.(); } catch { /* ja parou */ }
        list.unsubscribe = null;
        list.ready = false;
        list.docs.clear();
        list.writes.clear();
      }
    },
    watches(name) { return lists.has(name); },
    // true = pode responder pela memoria agora.
    ready(name) {
      const list = lists.get(name);
      return !!list && list.ready && settled(list);
    },
    // Documentos (QueryDocumentSnapshot) em andamento, com filtro opcional pelos dados.
    docs(name, filter) {
      const list = lists.get(name);
      if (!list) return [];
      const all = [...list.docs.values()];
      return filter ? all.filter((doc) => filter(doc.data() || {}, doc)) : all;
    },
    doc(name, id) {
      return lists.get(name)?.docs.get(String(id || '')) || null;
    },
    // O servidor gravou "colecao/id": ate o banco confirmar, a colecao responde pelo banco.
    noteWrite(path) {
      const parts = String(path || '').split('/');
      if (parts.length !== 2 || !parts[1]) return;
      const list = lists.get(parts[0]);
      if (list) list.writes.set(parts[1], now());
    },
    stats() {
      return Object.fromEntries([...lists.values()].map((list) => [list.name, {
        pronto: list.ready, emAndamento: list.docs.size, mudancas: list.changes, falhas: list.failures, prontoDesdeMs: list.readyAt
      }]));
    }
  };
}
