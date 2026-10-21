import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const hash = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const DRIVER = '11111111111', OTHER = '22222222222', DEVICE = 'device-client-1234567890';
function slice(a, b) { const i = source.indexOf(a); const j = source.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, a); return source.slice(i, j); }
function harness(ride) {
  const records = new Map([['corridas/r1', ride]]);
  let seq = 0;
  const ref = path => ({ path, id: path.split('/').at(-1), get: async () => snap(path), collection: name => ({ doc: id => ref(`${path}/${name}/${id || `m${++seq}`}`),
    where: (_f, _o, v) => ({ limit: () => ({ get: async () => list(`${path}/${name}/`, d => d.criadoEmMs > v) }) }), limit: () => ({ get: async () => list(`${path}/${name}/`, () => true) }) }) });
  const snap = path => ({ id: path.split('/').at(-1), exists: records.has(path), data: () => records.get(path) });
  const list = async (prefix, keep) => ({ docs: [...records.keys()].filter(p => p.startsWith(prefix) && keep(records.get(p))).map(snap) });
  const db = { collection: name => ({ doc: id => ref(`${name}/${id}`) }),
    batch: () => { const ops = []; return { set: (r, d, o) => ops.push([r, d, o]), commit: async () => ops.forEach(([r, d, o]) => records.set(r.path, o?.merge ? { ...records.get(r.path), ...Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v?.inc ? Number(records.get(r.path)?.[k] || 0) + v.inc : v])) } : d)) }; } };
  const routes = {};
  const ctx = vm.createContext({ db, Date, Math, Number, String, Map, console,
    admin: { firestore: { FieldValue: { serverTimestamp: () => 'TS', increment: n => ({ inc: n }) } } },
    cleanText: (v, n = 500) => String(v || '').trim().slice(0, n), onlyDigits: v => String(v || '').replace(/\D/g, ''),
    hashSecret: hash, timestampMs: v => Number(v || 0), rideStatusCache: new Map(), createRideLimiter: 0,
    getDriverWithProof: async (cpf, body) => { if (body.driverCnh !== 'ok') throw Object.assign(new Error('prova'), { status: 401 }); return {}; },
    canReadRideTracking: async (req, access) => req.header('x-customer-device') && hash(req.header('x-customer-device')) === access.deviceHash,
    app: { post: (p, ...h) => { routes[p] = h.at(-1); } } });
  vm.runInContext(slice('const RIDE_CHAT_MAX', "app.post('/api/rides/:rideId/chat/send'"), ctx);
  vm.runInContext(slice("app.post('/api/rides/:rideId/chat/send'", "app.post('/api/rides/:rideId/renew'"), ctx);
  const call = async (path, { body = {}, device = '' } = {}) => {
    const out = { status: 200 }; let failure;
    const res = { status: c => { out.status = c; return res; }, json: d => { out.data = d; return res; } };
    await routes[path]({ params: { rideId: 'r1' }, body, header: n => (n === 'x-customer-device' ? device : '') }, res, e => { failure = e; });
    if (failure) throw failure; return out;
  };
  return { records, call, ctx };
}
const ride = (extra = {}) => ({ status: 'aceita', motoboyCpf: DRIVER, motoboy: 'Bruno', nome: 'Ana', clienteDeviceId: DEVICE, ...extra });
const driver = (texto, cpf = DRIVER) => ({ body: { driverCpf: cpf, driverCnh: 'ok', texto } });
test('client and motoboy of the ride talk in the app; others cannot read or write', async () => {
  const h = harness(ride());
  assert.equal((await h.call('/api/rides/:rideId/chat/send', driver('Estou a caminho'))).data.mensagem.autor, 'motoboy');
  assert.equal((await h.call('/api/rides/:rideId/chat/send', { body: { texto: 'Estou na frente' }, device: DEVICE })).data.mensagem.autor, 'cliente');
  const list = await h.call('/api/rides/:rideId/chat/list', driver());
  assert.deepEqual(list.data.mensagens.map(m => m.texto), ['Estou a caminho', 'Estou na frente']);
  assert.equal(list.data.voce, 'motoboy'); assert.equal(list.data.outro.nome, 'Ana');
  assert.equal((await h.call('/api/rides/:rideId/chat/list', { body: {}, device: DEVICE })).data.outro.nome, 'Bruno');
  assert.equal((await h.call('/api/rides/:rideId/chat/send', driver('oi', OTHER))).status, 403);
  assert.equal((await h.call('/api/rides/:rideId/chat/list', { body: {}, device: 'outro-aparelho-1234567' })).status, 403);
  assert.equal(h.records.get('corridas/r1').chatUltimoAutor, 'cliente');
  assert.equal(h.records.get('corridas/r1').chatTotal, 2);
  const since = await h.call('/api/rides/:rideId/chat/list', { body: { depoisDeMs: list.data.mensagens[1].criadoEmMs }, device: DEVICE });
  assert.equal(since.data.mensagens.length, 0);
});
test('phone numbers and links typed in the chat are hidden', async () => {
  const h = harness(ride());
  for (const [typed, hidden] of [
    ['me chama no 19 99999-0000', /\[número oculto\]/], ['(19)999990000', /\[número oculto\]/], ['+55 19 9 9999 0000 obrigado', /\[número oculto\]/],
    ['wa.me/5519999990000', /\[link oculto\]/], ['https://instagram.com/eu', /\[link oculto\]/]]) {
    const sent = await h.call('/api/rides/:rideId/chat/send', { body: { texto: typed }, device: DEVICE });
    assert.match(sent.data.mensagem.texto, hidden, typed);
    assert.doesNotMatch(sent.data.mensagem.texto, /9999/, typed);
  }
  assert.equal(h.ctx.maskChatText('Rua 15, número 140, casa 2'), 'Rua 15, número 140, casa 2');
});
test('chat closes for writing after the ride ends and is limited per minute', async () => {
  const done = harness(ride({ status: 'finalizada', finalizadaEm: Date.now() - 60000 }));
  assert.equal((await done.call('/api/rides/:rideId/chat/send', { body: { texto: 'oi' }, device: DEVICE })).status, 409);
  assert.equal((await done.call('/api/rides/:rideId/chat/list', { body: {}, device: DEVICE })).data.aberto, false);
  const h = harness(ride());
  for (let i = 0; i < 20; i++) assert.equal((await h.call('/api/rides/:rideId/chat/send', driver(`msg ${i}`))).status, 200);
  assert.equal((await h.call('/api/rides/:rideId/chat/send', driver('mais uma'))).status, 429);
});
test('the motoboy never receives the client WhatsApp and accepting already starts GPS and the notice', () => {
  const ctx = vm.createContext({});
  vm.runInContext(slice('function privateDriverJob(', 'function supportAlertVersion('), ctx);
  const job = ctx.privateDriverJob({ id: 'r1', telefoneCliente: '19999990000', nome: 'Ana', clienteDeviceId: 'x' });
  assert.equal(job.telefoneCliente, undefined); assert.equal(job.clienteDeviceId, undefined); assert.equal(job.nome, 'Ana');
  const accept = slice("app.post('/api/rides/:rideId/accept'", "app.get('/api/companies/me/active-deliveries'");
  assert.match(accept, /clienteAvisadoEm: admin\.firestore\.FieldValue\.serverTimestamp\(\),\s*\n\s*clienteAvisadoPor/);
  assert.match(accept, /rastreamentoAtivo: true/);
  const notify = slice("app.post('/api/rides/:rideId/notify-client'", "app.post('/api/rides/:rideId/cancel'");
  assert.match(notify, /res\.json\(\{ ok: true, whatsapp: '' \}\)/);
  const status = slice("app.get('/api/rides/:rideId/status'", "app.post('/api/rides/:rideId/renew'");
  assert.doesNotMatch(status, /motoboyTelefone:/);
});
