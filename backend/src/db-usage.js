// Medidor de consumo do banco (Firestore): conta leituras e gravacoes por rota do
// servidor, para o dono ver no painel quem esta gastando a cota gratis
// (50 mil leituras e 20 mil gravacoes por dia, zerando a meia-noite do Pacifico).
import { AsyncLocalStorage } from 'node:async_hooks';

export const FREE_READS_PER_DAY = 50000;
export const FREE_WRITES_PER_DAY = 20000;

// O Firebase zera a cota a meia-noite no horario do Pacifico (EUA), nao no de Brasilia.
export function quotaDayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// /api/drivers/12345678901/jobs -> /api/drivers/:id/jobs (ids e telefones viram :id).
export function usageLabel(method, path) {
  const clean = String(path || '').split('?')[0].split('/').map((part) => (
    /\d{4,}/.test(part) || /^[A-Za-z0-9_]{16,}$/.test(part) ? ':id' : part
  )).join('/').slice(0, 90);
  return `${String(method || 'GET').toUpperCase()} ${clean || '/'}`;
}

export function createDbUsage({ now = Date.now, dayKey = quotaDayKey, maxLabels = 300 } = {}) {
  const als = new AsyncLocalStorage();
  let day = dayKey(new Date(now()));
  let totals = { leituras: 0, gravacoes: 0 };
  let labels = new Map();
  let startedAtMs = now();
  let previous = null;

  function roll() {
    const today = dayKey(new Date(now()));
    if (today === day) return;
    previous = snapshot();
    day = today;
    totals = { leituras: 0, gravacoes: 0 };
    labels = new Map();
    startedAtMs = now();
  }

  function add(kind, amount, label) {
    const n = Math.max(0, Math.round(Number(amount) || 0));
    if (!n) return;
    roll();
    totals[kind] += n;
    const key = label || als.getStore()?.label || 'rotinas do servidor';
    let entry = labels.get(key);
    if (!entry) {
      if (labels.size >= maxLabels) entry = labels.get('outros') || { leituras: 0, gravacoes: 0, vezes: 0 };
      else entry = { leituras: 0, gravacoes: 0, vezes: 0 };
      labels.set(labels.size >= maxLabels ? 'outros' : key, entry);
    }
    entry[kind] += n;
  }

  function snapshot(limit = 40) {
    const top = [...labels.entries()]
      .map(([rota, v]) => ({ rota, leituras: v.leituras, gravacoes: v.gravacoes, vezes: v.vezes }))
      .sort((a, b) => (b.leituras + b.gravacoes) - (a.leituras + a.gravacoes))
      .slice(0, limit);
    return { dia: day, desdeMs: startedAtMs, leituras: totals.leituras, gravacoes: totals.gravacoes, rotas: top };
  }

  return {
    reads(amount, label) { add('leituras', amount, label); },
    writes(amount, label) { add('gravacoes', amount, label); },
    // Cada pedido HTTP leva o nome da sua rota ate as leituras que ele faz.
    middleware(req, _res, next) {
      const label = usageLabel(req.method, req.path || req.url);
      roll();
      const entry = labels.get(label);
      if (entry) entry.vezes += 1;
      else if (labels.size < maxLabels) labels.set(label, { leituras: 0, gravacoes: 0, vezes: 1 });
      als.run({ label }, next);
    },
    run(label, fn) { return als.run({ label }, fn); },
    // Junta o que veio de antes de reiniciar o servidor (mesmo dia) ao que conta agora.
    seed(saved = {}) {
      if (!saved || saved.dia !== day) return false;
      totals.leituras += Math.max(0, Number(saved.leituras) || 0);
      totals.gravacoes += Math.max(0, Number(saved.gravacoes) || 0);
      for (const item of Array.isArray(saved.rotas) ? saved.rotas : []) {
        const key = String(item?.rota || '').slice(0, 100);
        if (!key) continue;
        const entry = labels.get(key) || { leituras: 0, gravacoes: 0, vezes: 0 };
        entry.leituras += Math.max(0, Number(item.leituras) || 0);
        entry.gravacoes += Math.max(0, Number(item.gravacoes) || 0);
        entry.vezes += Math.max(0, Number(item.vezes) || 0);
        labels.set(key, entry);
      }
      if (Number(saved.desdeMs) > 0) startedAtMs = Math.min(startedAtMs, Number(saved.desdeMs));
      return true;
    },
    day() { roll(); return day; },
    previous() { return previous; },
    snapshot(limit) { roll(); return snapshot(limit); }
  };
}

// Liga o medidor (e quem precisa saber das gravacoes) nas classes do cliente do Firestore.
// Todas as gravacoes (doc.set, transacao, lote) passam pelo WriteBatch; as consultas pelo
// Query._get (tambem as feitas dentro de transacao); os documentos pelo getAll do banco
// (doc.get usa ele) e pelo get/getAll da transacao.
export function instrumentFirestore({ Firestore, Transaction, DocumentReference, Query, WriteBatch }, { onReads = () => {}, onWrite = () => {} } = {}) {
  if (!WriteBatch?.prototype || WriteBatch.prototype.__motojaMedidor) return false;
  WriteBatch.prototype.__motojaMedidor = true;
  const safe = (fn) => { try { fn(); } catch { /* medidor nunca derruba o app */ } };
  const isDoc = (value) => !!DocumentReference && value instanceof DocumentReference;
  const wrap = (proto, method, after) => {
    const original = proto?.[method];
    if (typeof original !== 'function') return;
    proto[method] = async function medido(...args) {
      const result = await original.apply(this, args);
      safe(() => after(args, result));
      return result;
    };
  };
  for (const method of ['set', 'update', 'delete', 'create']) {
    const original = WriteBatch.prototype[method];
    if (typeof original !== 'function') continue;
    WriteBatch.prototype[method] = function medido(documentRef, ...args) {
      safe(() => onWrite(documentRef?.path || ''));
      return original.call(this, documentRef, ...args);
    };
  }
  wrap(Query?.prototype, '_get', (_args, result) => onReads(Math.max(1, Number(result?.result?.size) || 0)));
  wrap(Firestore?.prototype, 'getAll', (args) => onReads(Math.max(1, args.filter(isDoc).length)));
  wrap(Transaction?.prototype, 'get', (args) => { if (isDoc(args[0])) onReads(1); });
  wrap(Transaction?.prototype, 'getAll', (args) => onReads(Math.max(1, args.filter(isDoc).length)));
  return true;
}
