import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as stops from '../src/delivery-stops.js';

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const driverCpf = '12345678901';
const companyId = '19999990000';

function setup(delivery) {
  const records = new Map([['entregas/d', { ...delivery }]]);
  const routes = new Map();
  const emitted = [];
  const learned = [];
  let n = 0;
  const ref = (path) => ({
    path, id: path.split('/').at(-1),
    get: async () => ({ exists: records.has(path), data: () => records.get(path) }),
    collection: (name) => ({
      doc: (id) => ref(`${path}/${name}/${id || `m${++n}`}`),
      where: (_f, _op, value) => ({ limit: () => ({ get: async () => ({ docs: [...records].filter(([k, v]) => k.startsWith(`${path}/${name}/`) && v.criadoEmMs > value).map(([k, v]) => ({ id: k.split('/').at(-1), data: () => v })) }) }) }),
      limit: () => ({ get: async () => ({ docs: [...records].filter(([k]) => k.startsWith(`${path}/${name}/`)).map(([k, v]) => ({ id: k.split('/').at(-1), data: () => v })) }) })
    })
  });
  const db = {
    collection: (name) => ({ doc: (id) => ref(`${name}/${id}`) }),
    runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, data) => records.set(r.path, { ...records.get(r.path), ...data }) }),
    batch: () => { const writes = []; return { set: (r, d) => writes.push([r, d]), commit: async () => writes.forEach(([r, d]) => records.set(r.path, { ...records.get(r.path), ...d })) }; }
  };
  const context = vm.createContext({
    ...stops, db, Date, Math, Number, String, Array, Object, JSON, Promise, Map, Set, AbortSignal, console,
    onlyDigits: (v) => String(v || '').replace(/\D/g, ''), cleanText: (v, max = 500) => String(v || '').trim().slice(0, max), timestampMs: Number,
    getDriverWithProof: async (cpf) => { if (cpf !== driverCpf) throw new Error('prova'); },
    findCompanySession: async (token) => (token === 'loja' ? { companyId } : token === 'outra' ? { companyId: '1' } : null),
    learnedAddresses: { learn: async (item) => { learned.push(item); return true; } },
    emitDeliveryTracking: (id, event) => emitted.push(['tracking', id, event]),
    io: { to: (room) => ({ emit: (name, event) => emitted.push([name, room, event]) }) },
    rideChatAllowed: () => true, RIDE_CHAT_MAX: 500, validCoordinate: (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon),
    admin: { firestore: { FieldValue: { serverTimestamp: () => Date.now(), increment: (v) => v } } },
    rateLimit: () => 'limit', createRideLimiter: 'limit', mapLimiter: 'limit',
    app: { post: (url, ...handlers) => routes.set(url, handlers.at(-1)) }
  });
  const start = source.indexOf('// ---------- Lote pela nota: enderecos no servidor');
  vm.runInContext(source.slice(start, source.indexOf('function driverStatusHtml(', start)), context);
  async function call(url, body, token = '') {
    let status = 200, result, error;
    const res = { status: (v) => { status = v; return res; }, json: (v) => { result = v; return res; } };
    await routes.get(url)({ body, params: { deliveryId: 'd' }, header: () => (token ? `Bearer ${token}` : '') }, res, (e) => { error = e; });
    if (error) throw error;
    return { status, data: result };
  }
  return { records, emitted, learned, call };
}

const lote = { entregaNaNota: true, status: 'retirada', motoboyCpf: driverCpf, motoboy: 'Zé', empresa: 'Pizzaria', empresaId: companyId, paradas: 2, cidadeOperacao: 'conchal' };

test('the driver phone saves the batch list; the store sees it and a good GPS delivery is learned', async () => {
  const h = setup(lote);
  const paradas = [
    { id: 'a', texto: 'Rua Nova 12', status: 'entregue', entregueEm: 1, gpsEntrega: { lat: -22.32, lon: -47.17, precisao: 10 } },
    { id: 'b', texto: 'Rua Velha 3', status: 'nao_encontrado', problema: 'ninguem_atende' }
  ];
  const r = await h.call('/api/deliveries/:deliveryId/notas', { driverCpf, paradas });
  assert.deepEqual(r.data.resumo, { total: 2, adicionados: 2, entregues: 1, problemas: 1 });
  assert.equal(h.records.get('entregas/d').paradasNota.length, 2);
  assert.equal(h.learned.length, 1);
  assert.equal(h.emitted[0][1], companyId);
  await h.call('/api/deliveries/:deliveryId/notas', { driverCpf, paradas });
  assert.equal(h.learned.length, 1, 'the same delivery is learned once');
  await assert.rejects(h.call('/api/deliveries/:deliveryId/notas', { driverCpf: '99999999999', paradas }), /prova/);
});

test('a finished batch or another driver cannot change the list', async () => {
  await assert.rejects(setup({ ...lote, status: 'finalizada' }).call('/api/deliveries/:deliveryId/notas', { driverCpf, paradas: [] }), /encerrada/);
  await assert.rejects(setup({ ...lote, motoboyCpf: '11111111111' }).call('/api/deliveries/:deliveryId/notas', { driverCpf, paradas: [] }), /nao pertence/);
});

test('driver "client not found" reaches the store chat with an alert; only that store and driver can read', async () => {
  const h = setup(lote);
  const sent = await h.call('/api/deliveries/:deliveryId/chat/send', { driverCpf, texto: 'Ninguém atende. Cliente 19 99876-5432?' });
  assert.equal(sent.data.mensagem.autor, 'motoboy');
  assert.match(sent.data.mensagem.texto, /99876-5432/, 'the phone can pass between store and driver');
  const alert = h.emitted.find((e) => e[0] === 'delivery:chat');
  assert.equal(alert[1], `company:${companyId}`);
  const list = await h.call('/api/deliveries/:deliveryId/chat/list', {}, 'loja');
  assert.equal(list.data.voce, 'empresa');
  assert.equal(list.data.mensagens.length, 1);
  assert.equal((await h.call('/api/deliveries/:deliveryId/chat/send', { texto: 'oi' }, 'outra')).status, 403);
  assert.equal((await h.call('/api/deliveries/:deliveryId/chat/send', { texto: 'veja https://x.com' }, 'loja')).data.mensagem.texto, 'veja [link oculto]');
});
