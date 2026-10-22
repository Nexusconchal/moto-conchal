import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { reachedPickup, lateCancelState, lateCancelBlocker, LATE_CANCEL_MS } from '../src/ride-late.js';

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const DRIVER = '11111111111', DEVICE = 'device-client-1234567890';
const MIN = 60000;
function slice(a, b) { const i = source.indexOf(a); const j = source.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, a); return source.slice(i, j); }

const DELETE = { del: true };
function apply(base = {}, data = {}) {
  const out = { ...base };
  for (const [k, v] of Object.entries(data)) {
    if (v === DELETE) delete out[k];
    else if (v?.inc) out[k] = Number(out[k] || 0) + v.inc;
    else out[k] = v;
  }
  return out;
}

function harness(ride) {
  const records = new Map([['corridas/r1', ride], [`motoboys/${DRIVER}`, { nome: 'Bruno' }]]);
  const ref = (path) => ({ path, id: path.split('/').at(-1), get: async () => snap(path) });
  const snap = (path) => ({ id: path.split('/').at(-1), exists: records.has(path), data: () => records.get(path) });
  const db = { collection: (name) => ({ doc: (id) => ref(`${name}/${id}`) }),
    runTransaction: async (fn) => { const ops = []; const out = await fn({ get: (r) => r.get(), update: (r, d) => ops.push([r, d]), set: (r, d) => ops.push([r, d]) }); ops.forEach(([r, d]) => records.set(r.path, apply(records.get(r.path), d))); return out; } };
  const calls = { push: [], telegram: [], driver: [], jobs: [] };
  const routes = {};
  const ctx = vm.createContext({ db, Date, Math, Number, String, Object, Array, console,
    admin: { firestore: { FieldValue: { serverTimestamp: () => Date.now(), delete: () => DELETE, increment: (n) => ({ inc: n }) } } },
    lateCancelBlocker, cleanText: (v, n = 200) => String(v || '').trim().slice(0, n), onlyDigits: (v) => String(v || '').replace(/\D/g, ''),
    hashSecret: hash, timestampMs: (v) => Number(v || 0), rideStatusCache: new Map(), adminStateCache: {}, createRideLimiter: 0,
    driverAvailability: { job: (...a) => calls.jobs.push(a) }, driverAvailabilitySocket: { publishAll() {} }, emitSupportOperationsRefresh() {},
    notifyDriversAboutRide: async (id, r) => calls.push.push([id, r.status]), notifyTelegramAboutRide: async (id) => calls.telegram.push(id),
    notifyDriverLateCancel: async (r, acao) => calls.driver.push([r.motoboyCpf, acao]),
    getDriverWithProof: async (_cpf, body) => { if (body.driverCnh !== 'ok') throw Object.assign(new Error('prova'), { status: 401 }); return {}; },
    canReadRideTracking: async (req, access) => !!req.header('x-customer-device') && hash(req.header('x-customer-device')) === access.deviceHash,
    app: { post: (p, ...h) => { routes[p] = h.at(-1); } } });
  vm.runInContext(slice('// Motoboy avisa pelo app que chegou ao local de embarque.', '// Avisa o motoboy que perdeu a corrida por atraso'), ctx);
  const call = async (path, { body = {}, device = '' } = {}) => {
    const out = { status: 200 }; let failure;
    const res = { status: (c) => { out.status = c; return res; }, json: (d) => { out.data = d; return res; } };
    await routes[path]({ params: { rideId: 'r1' }, body, header: (n) => (n === 'x-customer-device' ? device : '') }, res, (e) => { failure = e; });
    if (failure) { out.status = failure.status || 500; out.data = { error: failure.code, message: failure.message }; }
    return out;
  };
  return { records, call, calls };
}

const accepted = (minutesAgo, extra = {}) => ({ status: 'aceita', aceitaEm: Date.now() - minutesAgo * MIN, criadaEm: Date.now() - (minutesAgo + 2) * MIN,
  motoboyCpf: DRIVER, motoboy: 'Bruno', motoboyTelefone: '19999990000', nome: 'Ana', clienteDeviceId: DEVICE, valor: 6.5, origem: 'Rua A', ...extra });

test('the button only works after 15 minutes without the motoboy arriving', async () => {
  const early = harness(accepted(10));
  const out = await early.call('/api/rides/:rideId/late-cancel', { device: DEVICE, body: { acao: 'trocar' } });
  assert.equal(out.data.error, 'ainda_no_prazo');
  assert.equal(early.records.get('corridas/r1').status, 'aceita');

  const arrived = harness(accepted(20, { motoboyChegouEm: Date.now() - 5 * MIN }));
  assert.equal((await arrived.call('/api/rides/:rideId/late-cancel', { device: DEVICE })).data.error, 'motoboy_chegou');

  const paid = harness(accepted(20, { pagamento: { status: 'approved' } }));
  assert.equal((await paid.call('/api/rides/:rideId/late-cancel', { device: DEVICE })).data.error, 'corrida_paga');

  const stranger = harness(accepted(20));
  assert.equal((await stranger.call('/api/rides/:rideId/late-cancel', { device: 'outro-aparelho-1234567' })).status, 403);
});

test('call another motoboy: the ride rings again for everyone and the late motoboy is recorded', async () => {
  const h = harness(accepted(16, { pagamento: { status: 'pending', initPoint: 'https://mp' }, clienteAvisadoEm: 1, rastreamentoAtivo: true, motoboyLocalizacao: { latitude: 1 } }));
  const out = await h.call('/api/rides/:rideId/late-cancel', { device: DEVICE, body: { acao: 'trocar' } });
  assert.equal(out.status, 200);
  const ride = h.records.get('corridas/r1');
  assert.equal(ride.status, 'pendente');
  assert.equal(ride.motoboyCpf, '');
  assert.equal(ride.pagamento, undefined);
  assert.equal(ride.motoboyLocalizacao, undefined);
  assert.ok(ride.reabertaEm > 0, 'o prazo de procura recomeca');
  assert.equal(ride.reaberturas.at(-1).motivo, 'cliente_cancelou_atraso');
  assert.equal(h.records.get(`motoboys/${DRIVER}`).cancelamentosPorAtraso, 1);
  assert.deepEqual(h.calls.push, [['r1', 'pendente']]);
  assert.deepEqual(h.calls.telegram, ['r1']);
  assert.deepEqual(h.calls.driver, [[DRIVER, 'trocar']]);
  assert.deepEqual(h.calls.jobs, [['rides', 'r1', 'pendente']]);
  // Duas vezes seguidas nao cancela de novo.
  assert.equal((await h.call('/api/rides/:rideId/late-cancel', { device: DEVICE })).data.error, 'corrida_nao_aceita');
});

test('cancel the ride: nobody is called again', async () => {
  const h = harness(accepted(30));
  await h.call('/api/rides/:rideId/late-cancel', { device: DEVICE, body: { acao: 'cancelar' } });
  const ride = h.records.get('corridas/r1');
  assert.equal(ride.status, 'cancelada');
  assert.equal(ride.canceladoPor, 'Cliente');
  assert.match(ride.motivoCancelamento, /Bruno passou de 15 minutos/);
  assert.deepEqual(h.calls.push, []);
  assert.deepEqual(h.calls.driver, [[DRIVER, 'cancelar']]);
});

test('the motoboy marks arrival only on his own accepted ride', async () => {
  const h = harness(accepted(5));
  assert.equal((await h.call('/api/rides/:rideId/arrived', { body: { driverCpf: '22222222222', driverCnh: 'ok' } })).status, 409);
  assert.equal((await h.call('/api/rides/:rideId/arrived', { body: { driverCpf: DRIVER, driverCnh: 'ok' } })).status, 200);
  assert.ok(h.records.get('corridas/r1').motoboyChegouEm);
  assert.equal(h.records.get('corridas/r1').motoboyChegouPor, 'motoboy');
});

test('late rules and GPS arrival', () => {
  const now = Date.now();
  assert.deepEqual({ ...lateCancelState({ status: 'aceita' }, now - 14 * MIN, now) }, { liberaEmMs: now + MIN, pode: false, pagoOnline: false });
  assert.equal(lateCancelState({ status: 'aceita' }, now - LATE_CANCEL_MS, now).pode, true);
  assert.equal(lateCancelState({ status: 'aceita', motoboyChegouEm: 1 }, now - 20 * MIN, now).pode, false);
  assert.equal(lateCancelBlocker({ status: 'aceita' }, now - 20 * MIN, now), null);
  const ride = { origemLat: -22.3300, origemLon: -47.1700 };
  assert.equal(reachedPickup(ride, { latitude: -22.3305, longitude: -47.1702, accuracy: 10 }), true);
  assert.equal(reachedPickup(ride, { latitude: -22.3400, longitude: -47.1700, accuracy: 10 }), false);
  assert.equal(reachedPickup({}, { latitude: 0, longitude: 0 }), false);
  // O GPS da corrida marca a chegada sozinho.
  assert.match(slice('async function saveTrackedLocation(', "app.post('/api/deliveries/:deliveryId/location'"), /reachedPickup\(job, result\.location\)/);
});
