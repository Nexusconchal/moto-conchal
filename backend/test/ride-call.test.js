import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createCallStore, CALL_RING_MS } from '../src/ride-call.js';

const offer = { type: 'offer', sdp: 'v=0 oferta de teste' };
const answer = { type: 'answer', sdp: 'v=0 resposta de teste' };

test('ligacao pelo app: cliente liga, motoboy ve o convite, atende e cada lado ve so o que precisa', () => {
  let at = 1000;
  const store = createCallStore({ now: () => at, randomId: () => 'c1' });
  const call = store.start('r1', 'cliente', offer);
  assert.equal(call.status, 'chamando');
  assert.equal(store.view('r1', 'motoboy').offer.sdp, offer.sdp);
  assert.equal(store.view('r1', 'cliente').offer, null);
  assert.throws(() => store.start('r1', 'motoboy', offer), /em andamento/);
  assert.throws(() => store.answer('r1', 'cliente', 'c1', answer), /So quem recebeu/);
  store.answer('r1', 'motoboy', 'c1', answer);
  assert.equal(store.view('r1', 'cliente').answer.sdp, answer.sdp);
  assert.equal(store.view('r1', 'motoboy').answer, null);
  store.end('r1', 'cliente', 'c1');
  assert.deepEqual([store.view('r1', 'motoboy').status, store.view('r1', 'motoboy').motivo], ['encerrada', 'encerrada']);
  at += 61000;
  assert.equal(store.view('r1', 'motoboy'), null);
});

test('ligacao sem resposta encerra sozinha; recusar e cancelar ficam registrados; convite invalido e recusado', () => {
  let at = 0;
  const store = createCallStore({ now: () => at });
  store.start('r2', 'motoboy', offer);
  at += CALL_RING_MS + 1;
  assert.equal(store.view('r2', 'cliente').motivo, 'sem_resposta');
  at += 70000;
  const id = store.start('r2', 'motoboy', offer).id;
  store.end('r2', 'cliente', id);
  assert.equal(store.view('r2', 'motoboy').motivo, 'recusada');
  at += 70000;
  const id2 = store.start('r2', 'cliente', offer).id;
  store.end('r2', 'cliente', id2);
  assert.equal(store.view('r2', 'motoboy').motivo, 'cancelada');
  assert.throws(() => store.start('r3', 'cliente', { type: 'answer', sdp: 'x'.repeat(20) }), /invalido/);
  assert.throws(() => store.start('r3', 'outro', offer), /nao autorizada/);
  assert.equal(store.view('r1', 'cliente'), null);
});

test('ficha da ligacao vale so para a corrida e o lado dela', () => {
  const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const ctx = vm.createContext({ crypto, Buffer, Date, CALL_TOKEN_SECRET: 'segredo', CALL_TOKEN_MS: 60000 });
  vm.runInContext(source.slice(source.indexOf('function callToken('), source.indexOf('async function rideCallContext(')), ctx);
  const token = ctx.callToken('r1', 'motoboy');
  assert.equal(ctx.callTokenRole('r1', token), 'motoboy');
  assert.equal(ctx.callTokenRole('r2', token), '');
  assert.equal(ctx.callTokenRole('r1', token.replace('motoboy.', 'cliente.')), '');
  assert.equal(ctx.callTokenRole('r1', 'lixo'), '');
});

test('na entrega a ligacao e entre a loja e o motoboy, e a loja acha as ligacoes dela sem ler o banco', () => {
  const store = createCallStore({ now: () => 1000, randomId: () => 'e1', roles: ['empresa', 'motoboy'] });
  assert.throws(() => store.start('d1', 'cliente', offer), /nao autorizada/);
  store.start('d1', 'motoboy', offer, { companyId: '19999990000', motoboy: 'Ana' });
  assert.equal(store.view('d1', 'empresa').offer.sdp, offer.sdp);
  assert.deepEqual(store.ringing((c) => c.to === 'empresa' && c.meta.companyId === '19999990000').map((c) => [c.key, c.id, c.meta.motoboy]), [['d1', 'e1', 'Ana']]);
  assert.deepEqual(store.ringing((c) => c.meta.companyId === '11111111111'), []);
  store.answer('d1', 'empresa', 'e1', answer);
  assert.equal(store.view('d1', 'motoboy').answer.sdp, answer.sdp);
  assert.deepEqual(store.ringing(), []);
});

function deliveryCallHarness() {
  const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const slice = (a, b) => { const i = source.indexOf(a); const j = source.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, a); return source.slice(i, j); };
  const routes = {};
  const emits = [];
  const pushes = [];
  let sessionReads = 0;
  const deliveries = {
    d1: { status: 'retirada', motoboyCpf: '12345678901', motoboy: 'Ana', empresaId: '19999990000', empresa: 'Pizzaria Boa' },
    d2: { status: 'aceita', motoboyCpf: '12345678901', motoboy: 'Ana', empresaId: '19999990000', empresa: 'Pizzaria Boa' },
    d3: { status: 'finalizada', motoboyCpf: '12345678901', motoboy: 'Ana', empresaId: '19999990000', empresa: 'Pizzaria Boa' }
  };
  const db = { collection: (name) => ({ doc: (id) => ({ get: async () => (name === 'entregas'
    ? { exists: !!deliveries[id], data: () => deliveries[id] }
    : { exists: true, data: () => ({ fcmTokens: { nativo1: { plataforma: 'android_nativo' }, web1: {}, velho: { ativo: false } } }) }) }) }) };
  const ctx = vm.createContext({
    crypto, Buffer, Date, Number, String, Math, Promise, console, CALL_TOKEN_SECRET: 'segredo', CALL_TOKEN_MS: 60000, CALL_RING_MS, createCallStore,
    app: { post: (path, ...handlers) => { routes[path] = handlers.at(-1); } }, rideChatLimiter: () => {}, db,
    onlyDigits: (v) => String(v || '').replace(/\D/g, ''), cleanText: (v) => String(v || ''), appUrl: (p) => `https://site${p}`,
    deliveryCompanyId: (d) => d.empresaId,
    io: { to: (room) => ({ emit: (event, data) => emits.push([room, event, data]) }) },
    admin: { messaging: () => ({ sendEachForMulticast: async (msg) => { pushes.push(msg); return { successCount: msg.tokens.length }; } }) },
    // Quem e quem: a loja manda o login dela, o motoboy manda a prova dele.
    deliveryChatParticipant: async (req, delivery) => (req.body?.driverCpf === delivery.motoboyCpf ? 'motoboy' : req.headers?.authorization === 'Bearer loja' ? 'empresa' : ''),
    findCompanySession: async (token) => { sessionReads += 1; return token === 'loja' ? { companyId: '19999990000' } : null; }
  });
  vm.runInContext(slice('function callToken(', 'async function rideCallContext(') + slice('// ---------- Ligacao de voz pelo app na entrega', '// Avaliacao do motoboy pelo cliente'), ctx);
  async function call(path, params, { body = {}, headers = {} } = {}) {
    let status = 200, out = null;
    const res = { status: (s) => { status = s; return res; }, json: (d) => { out = d; return res; }, set: () => res };
    const req = { params, body, headers, header: (n) => headers[n.toLowerCase()] || '' };
    await routes[path](req, res, (error) => { status = error.status || 500; out = { error: error.code, message: error.message }; });
    return { status, body: out };
  }
  return { call, emits, pushes, sessionReads: () => sessionReads };
}

test('motoboy liga pra loja: o painel toca na hora (socket) e a conferida da loja acha a ligacao pela memoria', async () => {
  const h = deliveryCallHarness();
  const motoboy = { body: { driverCpf: '12345678901', offer } };
  const start = await h.call('/api/deliveries/:deliveryId/call/start', { deliveryId: 'd1' }, motoboy);
  assert.equal(start.status, 200);
  assert.deepEqual(h.emits.map(([room, event, data]) => [room, event, data.deliveryId, data.motoboy]), [['company:19999990000', 'delivery:call', 'd1', 'Ana']]);
  const loja = { headers: { authorization: 'Bearer loja' } };
  const poll = await h.call('/api/companies/me/calls', {}, { ...loja, body: {} });
  assert.deepEqual(poll.body.ligacoes.map((l) => [l.deliveryId, l.motoboy]), [['d1', 'Ana']]);
  // Proximas conferidas usam a ficha: nao leem a sessao (nem o banco) de novo.
  const antes = h.sessionReads();
  const poll2 = await h.call('/api/companies/me/calls', {}, { body: { pollToken: poll.body.pollToken } });
  assert.equal(poll2.body.ligacoes.length, 1);
  assert.equal(h.sessionReads(), antes);
  const semLogin = await h.call('/api/companies/me/calls', {}, { body: { pollToken: 'falsa.1.abc' } });
  assert.equal(semLogin.status, 401);
  // A loja ve o convite e atende; o motoboy recebe a resposta.
  const estado = await h.call('/api/deliveries/:deliveryId/call/state', { deliveryId: 'd1' }, { ...loja, body: {} });
  assert.equal(estado.body.voce, 'empresa');
  assert.equal(estado.body.call.offer.sdp, offer.sdp);
  await h.call('/api/deliveries/:deliveryId/call/answer', { deliveryId: 'd1' }, { body: { callToken: estado.body.callToken, callId: estado.body.call.id, answer } });
  const doMotoboy = await h.call('/api/deliveries/:deliveryId/call/state', { deliveryId: 'd1' }, { body: { callToken: start.body.callToken } });
  assert.equal(doMotoboy.body.call.answer.sdp, answer.sdp);
  // A ficha de uma entrega nao abre outra.
  const outra = await h.call('/api/deliveries/:deliveryId/call/state', { deliveryId: 'd2' }, { body: { callToken: start.body.callToken } });
  assert.equal(outra.status, 403);
});

test('loja liga pro motoboy: app Android novo recebe push so com dados (toca ate atender); entrega encerrada nao liga', async () => {
  const h = deliveryCallHarness();
  const loja = { headers: { authorization: 'Bearer loja' }, body: { offer } };
  const start = await h.call('/api/deliveries/:deliveryId/call/start', { deliveryId: 'd2' }, loja);
  assert.equal(start.status, 200);
  await new Promise((r) => setTimeout(r, 0));
  const nativo = h.pushes.find((p) => p.tokens.includes('nativo1'));
  const web = h.pushes.find((p) => p.tokens.includes('web1'));
  assert.equal(nativo.notification, undefined);
  assert.equal(nativo.data.tipo, 'ligacao_app');
  assert.equal(nativo.data.deliveryId, 'd2');
  assert.match(nativo.data.title, /Pizzaria Boa/);
  assert.match(web.notification.title, /Pizzaria Boa/);
  assert.ok(!h.pushes.some((p) => p.tokens.includes('velho')));
  assert.equal(h.emits.length, 0);
  const fechada = await h.call('/api/deliveries/:deliveryId/call/start', { deliveryId: 'd3' }, loja);
  assert.equal(fechada.status, 409);
  const estado = await h.call('/api/deliveries/:deliveryId/call/state', { deliveryId: 'd3' }, { headers: { authorization: 'Bearer loja' }, body: {} });
  assert.equal(estado.body.encerrada, true);
  const estranho = await h.call('/api/deliveries/:deliveryId/call/start', { deliveryId: 'd2' }, { body: { offer } });
  assert.equal(estranho.status, 403);
});
