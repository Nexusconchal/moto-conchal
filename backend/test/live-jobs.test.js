import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createLiveJobs } from '../src/live-jobs.js';
import { createDbUsage, instrumentFirestore, usageLabel, quotaDayKey } from '../src/db-usage.js';

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const slice = (start, end) => { const i = source.indexOf(start); assert.ok(i >= 0, start); return source.slice(i, source.indexOf(end, i + 1)); };

function fakeDb() {
  const listeners = [];
  const queries = [];
  return {
    listeners, queries,
    collection: (name) => ({
      where: (field, op, value) => ({
        onSnapshot(next, error) {
          const l = { name, field, op, value, next, error, stopped: false };
          listeners.push(l);
          return () => { l.stopped = true; };
        },
        get: async () => { queries.push(name); return { docs: [] }; },
        limit() { return this; }
      })
    })
  };
}
const doc = (id, data) => ({ id, data: () => data, ref: { path: `x/${id}` }, exists: true });
const snap = (changes) => ({ docChanges: () => changes.map(([type, d]) => ({ type, doc: d })) });

test('espelho: escuta pendente/aceita/retirada, guarda as mudancas e conta 1 leitura por mudanca', () => {
  const db = fakeDb();
  const reads = [];
  const changes = [];
  const live = createLiveJobs({ db, watch: { corridas: ['pendente', 'aceita', 'retirada'] }, onReads: (n) => reads.push(n), onChange: (...a) => changes.push(a) });
  assert.equal(live.ready('corridas'), false, 'antes de ligar responde pelo banco');
  live.start();
  assert.equal(db.listeners.length, 1);
  assert.deepEqual([db.listeners[0].field, db.listeners[0].op, db.listeners[0].value], ['status', 'in', ['pendente', 'aceita', 'retirada']]);
  db.listeners[0].next(snap([]));
  assert.deepEqual(reads, [1], 'a primeira resposta vazia custa 1 leitura');
  assert.equal(live.ready('corridas'), true);
  db.listeners[0].next(snap([['added', doc('a', { status: 'pendente', motoboyCpf: '' })], ['added', doc('b', { status: 'aceita', motoboyCpf: '111' })]]));
  assert.deepEqual(reads, [1, 2]);
  assert.deepEqual(live.docs('corridas', (job) => job.status === 'pendente').map((d) => d.id), ['a']);
  assert.equal(live.doc('corridas', 'b').data().motoboyCpf, '111');
  db.listeners[0].next(snap([['removed', doc('b', { status: 'aceita' })]]));
  assert.equal(live.doc('corridas', 'b'), null, 'saiu do andamento (finalizada/cancelada)');
  assert.equal(changes.at(-1)[1], 'removed');
  assert.equal(changes.at(-1)[2].motoboyCpf, '111', 'o aviso traz como estava antes');
  assert.equal(live.watches('entregas'), false);
});

test('espelho: logo depois de o servidor gravar, responde pelo banco ate o aviso chegar (ou 4 s)', () => {
  const db = fakeDb();
  let t = 1000;
  const live = createLiveJobs({ db, watch: { entregas: ['pendente'] }, now: () => t });
  live.start();
  db.listeners[0].next(snap([['added', doc('e1', { status: 'pendente' })]]));
  assert.equal(live.ready('entregas'), true);
  live.noteWrite('entregas/e1');
  assert.equal(live.ready('entregas'), false, 'gravou e o aviso ainda nao chegou');
  live.noteWrite('entregas/e1/paradas/1');
  live.noteWrite('motoboys/123');
  db.listeners[0].next(snap([['modified', doc('e1', { status: 'pendente', valor: 9 })]]));
  assert.equal(live.ready('entregas'), true, 'o aviso do banco confirmou a gravacao');
  live.noteWrite('entregas/velha');
  assert.equal(live.ready('entregas'), false);
  t += 4001;
  assert.equal(live.ready('entregas'), true, 'gravacao fora do andamento nao gera aviso: libera depois de 4 s');
});

test('espelho: se o banco derruba a escuta, volta a consultar o banco e tenta escutar de novo depois', () => {
  const db = fakeDb();
  const timers = [];
  const live = createLiveJobs({ db, watch: { corridas: ['pendente'] }, retryMs: 1000, log: { error() {} }, setTimer: (fn, ms) => { timers.push({ fn, ms }); return {}; }, clearTimer: () => {} });
  live.start();
  db.listeners[0].next(snap([['added', doc('a', { status: 'pendente' })]]));
  db.listeners[0].error(new Error('RESOURCE_EXHAUSTED'));
  assert.equal(live.ready('corridas'), false);
  assert.equal(live.docs('corridas').length, 0);
  assert.equal(timers.at(-1).ms, 1000);
  timers.at(-1).fn();
  assert.equal(db.listeners.length, 2, 'escutou de novo');
  db.listeners[1].error(new Error('de novo'));
  assert.equal(timers.at(-1).ms, 2000, 'espera mais a cada falha');
  db.listeners.at(-1).stopped = false;
  live.stop();
  assert.equal(live.ready('corridas'), false);
});

test('medidor: separa leituras e gravacoes por rota, ids viram :id, e o dia segue a cota do Pacifico', async () => {
  assert.equal(usageLabel('post', '/api/drivers/12345678901/jobs'), 'POST /api/drivers/:id/jobs');
  assert.equal(usageLabel('GET', '/api/rides/AbCdEfGhIjKlMnOpQr/status?x=1'), 'GET /api/rides/:id/status');
  assert.equal(quotaDayKey(new Date('2026-11-23T06:00:00Z')), '2026-11-22', '3h da manha em Brasilia ainda e o dia anterior no Pacifico');
  let t = Date.parse('2026-11-23T12:00:00Z');
  const usage = createDbUsage({ now: () => t });
  await new Promise((resolve) => usage.middleware({ method: 'GET', path: '/api/companies/me/active-deliveries' }, {}, async () => {
    await Promise.resolve();
    usage.reads(3);
    usage.writes(1);
    resolve();
  }));
  usage.reads(2);
  usage.run('rotina: limpeza', () => usage.reads(4));
  const hoje = usage.snapshot();
  assert.equal(hoje.leituras, 9);
  assert.equal(hoje.gravacoes, 1);
  const rota = hoje.rotas.find((r) => r.rota === 'GET /api/companies/me/active-deliveries');
  assert.deepEqual([rota.leituras, rota.gravacoes, rota.vezes], [3, 1, 1]);
  assert.equal(hoje.rotas.find((r) => r.rota === 'rotas do servidor')?.leituras, undefined);
  assert.equal(hoje.rotas.find((r) => r.rota === 'rotinas do servidor').leituras, 2);
  assert.equal(hoje.rotas.find((r) => r.rota === 'rotina: limpeza').leituras, 4);
  assert.equal(usage.seed({ dia: hoje.dia, leituras: 100, gravacoes: 10, rotas: [{ rota: 'rotina: limpeza', leituras: 50 }] }), true);
  assert.equal(usage.snapshot().leituras, 109);
  assert.equal(usage.seed({ dia: '2000-01-01', leituras: 5 }), false, 'conta de outro dia nao entra');
  t += 24 * 3600e3;
  assert.equal(usage.snapshot().leituras, 0, 'virou o dia da cota');
  assert.equal(usage.previous().leituras, 109);
});

test('medidor: liga nas gravacoes (lote/transacao/doc) e nas leituras de consulta e de documento', async () => {
  class DocumentReference { constructor(path) { this.path = path; } }
  class WriteBatch { set(ref) { return this; } update(ref) { return this; } delete(ref) { return this; } create(ref) { return this; } }
  class Query { async _get() { return { result: { size: this.size } }; } }
  class Firestore { async getAll(...refs) { return refs; } }
  class Transaction { async get(x) { return x; } async getAll(...refs) { return refs; } }
  const reads = [], writes = [];
  assert.equal(instrumentFirestore({ Firestore, Transaction, DocumentReference, Query, WriteBatch }, { onReads: (n) => reads.push(n), onWrite: (p) => writes.push(p) }), true);
  assert.equal(instrumentFirestore({ Firestore, Transaction, DocumentReference, Query, WriteBatch }), false, 'liga uma vez so');
  new WriteBatch().set(new DocumentReference('corridas/a')).update(new DocumentReference('empresas/1'));
  assert.deepEqual(writes, ['corridas/a', 'empresas/1']);
  const q = new Query(); q.size = 0; await q._get();
  q.size = 7; await q._get();
  await new Firestore().getAll(new DocumentReference('a/1'), new DocumentReference('a/2'));
  await new Transaction().get(new DocumentReference('a/1'));
  await new Transaction().get(q);
  assert.deepEqual(reads, [1, 7, 2, 1], 'consulta vazia custa 1; consulta na transacao conta pelo _get, nao duas vezes');
});

test('servidor: lista aberta, oferta e status saem do espelho quando ele esta pronto (sem consultar o banco)', async () => {
  const db = fakeDb();
  const live = createLiveJobs({ db, watch: { corridas: ['pendente', 'aceita', 'retirada'], entregas: ['pendente', 'aceita', 'retirada'] } });
  live.start();
  db.listeners[0].next(snap([['added', doc('p1', { status: 'pendente' })], ['added', doc('a1', { status: 'aceita', motoboyCpf: '11122233344' })]]));
  db.listeners[1].next(snap([]));
  const ctx = vm.createContext({ liveJobs: live, db, Date, Map, onlyDigits: (v) => String(v || '').replace(/\D/g, '') });
  vm.runInContext(slice('const OPEN_JOBS_CACHE_MS', "app.post('/api/drivers/:cpf/jobs'"), ctx);
  vm.runInContext(slice('async function activeJobsSnapshot(', 'function liveJobChanged('), ctx);
  const open = await ctx.openJobsSnapshot('corridas');
  assert.deepEqual(open.map((d) => d.id), ['p1']);
  assert.equal((await ctx.offerDoc('corridas', 'a1')).status, 'aceita');
  assert.equal(await ctx.offerDoc('corridas', 'sumiu'), null, 'fora do andamento = oferta encerrada');
  const mine = await ctx.activeJobsSnapshot('corridas', (job) => job.motoboyCpf === '11122233344', async () => { throw new Error('nao devia consultar'); });
  assert.deepEqual([mine.size, mine.empty, mine.docs[0].id], [1, false, 'a1']);
  assert.deepEqual(db.queries, [], 'nenhuma consulta ao banco');
  live.noteWrite('corridas/novo');
  await ctx.openJobsSnapshot('corridas');
  assert.deepEqual(db.queries, ['corridas'], 'logo depois de gravar, consulta o banco como antes');
});

test('servidor: login guardado de empresa e motoboy cai quando o servidor grava o cadastro', () => {
  let t = 10000;
  const ctx = vm.createContext({ Map, Date: { now: () => t }, String });
  vm.runInContext(slice('const DOC_WRITE_SETTLE_MS', '// Corridas/entregas em andamento: pela memoria'), ctx);
  const valeEmpresa = (savedAt) => vm.runInContext(`savedAfterLastWrite(companyWrittenAt, '19999990000', ${savedAt})`, ctx);
  const valeMotoboy = (cpf, savedAt) => vm.runInContext(`savedAfterLastWrite(driverWrittenAt, '${cpf}', ${savedAt})`, ctx);
  assert.equal(valeEmpresa(5000), true, 'sem gravacao, vale');
  vm.runInContext("noteDocWrite('empresas/19999990000')", ctx);
  assert.equal(valeEmpresa(9000), false, 'lido antes da gravacao: rele');
  assert.equal(valeEmpresa(12000), false, 'lido durante a gravacao: rele');
  assert.equal(valeEmpresa(13000), true, 'lido depois: vale');
  vm.runInContext("noteDocWrite('motoboys/11122233344'); noteDocWrite('motoboys/99999999999/ganhos/dia')", ctx);
  assert.equal(valeMotoboy('11122233344', 9000), false);
  assert.equal(valeMotoboy('99999999999', 9000), true, 'gravar subcolecao nao derruba o login');
  assert.match(source, /COMPANY_SESSION_CACHE_MS = 10 \* 60 \* 1000/);
  assert.match(source, /savedAfterLastWrite\(companyWrittenAt, saved\.session\?\.companyId, saved\.at\)/);
  assert.match(source, /savedAfterLastWrite\(driverWrittenAt, driverCpf, cached\.at \|\| 0\)/);
});

test('cidade pelo GPS (a cada 5 min): so grava e so apaga o login DESTE motoboy quando a cidade muda', async () => {
  const writes = [], cleared = [];
  let driver = { cidadeGps: 'conchal', cidadesAtivas: { conchal: true, aguai: false, engenheiro_coelho: false } };
  const ctx = vm.createContext({
    onlyDigits: (v) => String(v || '').replace(/\D/g, ''), Number, Math,
    getDriverWithProof: async () => driver,
    coordinateDistanceKm: () => 99, ESTIVA_GERBI_CENTER: {}, DRIVER_CITY_KM: 8,
    servedCityWithin: (p) => (p.lat > -22.25 ? 'aguai' : 'conchal'),
    db: { collection: () => ({ doc: (id) => ({ set: async (data) => writes.push([id, data.cidadeGps]) }) }) },
    admin: { firestore: { FieldValue: { serverTimestamp: () => 'TS' } } },
    clearDriverProofCache: (cpf) => cleared.push(cpf),
    driverAvailability: { cities() {} }, rideCityLabel: (c) => c,
    app: { post: (_p, h) => { ctx.handler = h; } }
  });
  vm.runInContext(slice("app.post('/api/drivers/:cpf/location-city'", '// ---------- SOS do motoboy'), ctx);
  const call = async (lat) => { const out = {}; const res = { status: (c) => { out.status = c; return res; }, json: (d) => { out.data = d; return res; } };
    await ctx.handler({ params: { cpf: '11122233344' }, body: { lat, lon: -47.17 } }, res, (e) => { throw e; }); return out; };
  await call(-22.33);
  assert.deepEqual(writes, [], 'mesma cidade: nao grava nada');
  assert.deepEqual(cleared, []);
  await call(-22.2);
  assert.deepEqual(writes, [['11122233344', 'aguai']], 'mudou para Aguai: grava uma vez');
  assert.deepEqual(cleared, ['11122233344'], 'apaga so o login dele, nao o de todos');
});

test('login do cliente: 1 consulta (lista de aparelhos primeiro), guardado ate o cadastro mudar', async () => {
  let t = 100000;
  const consultas = [];
  const conta = { nome: 'Ana', sessionTokenHash: 'h:novo', sessionTokenHashes: ['h:velho', 'h:novo'] };
  const db = { collection: () => ({ where: (field, op, value) => ({ limit: () => ({ get: async () => {
    consultas.push(field);
    const ok = op === 'array-contains' ? conta[field]?.includes(value) : conta[field] === value;
    return { empty: !ok, docs: ok ? [{ id: '19999338422', data: () => conta, ref: { set: async () => {} } }] : [] };
  } }) }) }) };
  const ctx = vm.createContext({ db, Map, String, Number, Date: { now: () => t }, hashSecret: (v) => `h:${v}`,
    admin: { firestore: { FieldValue: { delete: () => 'DEL', arrayUnion: (...v) => v } } } });
  vm.runInContext(slice('const DOC_WRITE_SETTLE_MS', '// Corridas/entregas em andamento: pela memoria'), ctx);
  vm.runInContext(slice('const customerSessionCache = new Map();', 'function carCustomerProfileComplete('), ctx);
  assert.equal((await ctx.findCustomerSession('velho')).customerId, '19999338422');
  assert.deepEqual(consultas, ['sessionTokenHashes'], 'achou na lista: uma consulta so');
  await ctx.findCustomerSession('velho');
  assert.equal(consultas.length, 1, 'segunda conferida sai da memoria');
  t += 5000;
  vm.runInContext("noteDocWrite('clientes/19999338422')", ctx);
  conta.sessionTokenHashes = ['h:novo'];
  conta.sessionTokenHash = 'h:novo';
  t += 3500;
  assert.equal(await ctx.findCustomerSession('velho'), null, 'saiu/trocou a senha: o login guardado cai');
  assert.equal(await ctx.findCustomerSession('velho'), null);
  assert.equal(consultas.length, 3, 'chave que nao vale fica guardada (nao consulta de novo a cada 4 s)');
});

test('motoboys ativos no espelho: sem a foto do documento na memoria, e avisar chamada nao consulta o banco', async () => {
  const db = fakeDb();
  const live = createLiveJobs({ db, watch: { motoboys: ['ativo'] }, transform: { motoboys: ({ crlvFoto, ...d }) => ({ ...d, crlvCadastrado: !!crlvFoto }) } });
  live.start();
  db.listeners[0].next(snap([['added', doc('11122233344', { status: 'ativo', nome: 'Ana', crlvFoto: 'data:image/jpeg;base64,AAAA', fcmTokens: { t1: { ativo: true } } })]]));
  const ana = live.doc('motoboys', '11122233344');
  assert.equal(ana.data().crlvFoto, undefined);
  assert.equal(ana.data().crlvCadastrado, true);
  assert.equal(ana.ref.path, 'x/11122233344', 'continua com a referencia do banco');
  live.noteWrite('motoboys/11122233344');
  assert.equal(live.ready('motoboys'), false);
  assert.equal(live.listening('motoboys'), true, 'para a lista de motoboys 1 s de atraso nao importa');
  const ctx = vm.createContext({ liveJobs: live, db });
  vm.runInContext(slice('async function activeDriverDocs(', 'instrumentFirestore(admin.firestore'), ctx);
  const drivers = await ctx.activeDriverDocs();
  assert.deepEqual([drivers.size, drivers.docs[0].id], [1, '11122233344']);
  assert.deepEqual(db.queries, [], 'nenhuma consulta: antes relia todos os motoboys a cada chamada e a cada 20 s');
  assert.match(source, /async function availableDriverTokens\(accepts = \(\) => true\) \{\n  const drivers = await activeDriverDocs\(\);/);
  assert.match(source, /const drivers = onlyReserved \? \[\] : \(await activeDriverDocs\(\)\)\.docs/);
});

test('chat da entrega: nada novo = nao le mensagens; login da loja guardado', () => {
  const rota = slice("app.post('/api/deliveries/:deliveryId/chat/list'", '// Distancia pela rua do motoboy');
  assert.match(rota, /chatJob\('entregas', ref\.id\)/);
  assert.match(rota, /if \(depois && Number\(delivery\.chatUltimaEmMs \|\| 0\) <= depois\)/);
  assert.match(slice('async function deliveryChatParticipant(', 'function deliveryChatOpen('), /cachedCompanySession\(token, true\)/);
});
