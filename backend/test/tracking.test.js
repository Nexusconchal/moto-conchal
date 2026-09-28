import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { validateLocation } from '../src/tracking-policy.js';

const now = 1800000000000;
const point = { latitude: -22.33, longitude: -47.17, accuracy: 10, timestamp: now, heading: null, speed: null };
test('valid GPS preserves unknown speed and direction', () => {
  const result = validateLocation(point, null, now);
  assert.equal(result.location.heading, null);
  assert.equal(result.location.speed, null);
});
for (const [name, change, error] of [
  ['missing coordinates', { latitude: null }, 'coordenadas_invalidas'],
  ['invalid coordinates', { longitude: 181 }, 'coordenadas_invalidas'],
  ['old GPS fix', { timestamp: now - 31000 }, 'localizacao_fora_do_tempo'],
  ['future GPS fix', { timestamp: now + 11000 }, 'localizacao_fora_do_tempo'],
  ['poor accuracy', { accuracy: 200 }, 'gps_impreciso'],
  ['unknown accuracy', { accuracy: null }, 'gps_impreciso']
]) test(name, () => assert.equal(validateLocation({ ...point, ...change }, null, now).error, error));

test('delayed or duplicate fix cannot overwrite a newer position', () => {
  assert.equal(validateLocation(point, { ...point, clientTimestamp: now + 1 }, now).ignored, 'posicao_antiga');
});
test('rejects impossible jump, permits a normal street movement', () => {
  const previous = { ...point, clientTimestamp: now - 10000, serverTimestampMs: now - 10000 };
  assert.equal(validateLocation({ ...point, latitude: -23.33 }, previous, now).error, 'salto_gps_invalido');
  assert.ok(validateLocation({ ...point, latitude: -22.3305 }, previous, now).location);
});
test('server bounds write frequency', () => {
  const previous = { ...point, clientTimestamp: now - 1000, serverTimestampMs: now - 1000 };
  assert.equal(validateLocation(point, previous, now).ignored, 'intervalo_minimo');
});

const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const saveFunction = server.slice(server.indexOf('async function saveTrackedLocation('), server.indexOf("app.post('/api/deliveries/:deliveryId/location'"));
function transactionHarness(job) {
  const writes = [];
  const context = vm.createContext({
    validateLocation: (body, previous) => validateLocation(body, previous, now),
    onlyDigits: (v) => String(v || '').replace(/\D/g, ''),
    admin: { firestore: { FieldValue: { serverTimestamp: () => 'SERVER_TIME' } } },
    db: { runTransaction: (callback) => callback({
      get: async () => ({ data: () => job }),
      update: (ref, data) => writes.push({ ref, data })
    }) }
  });
  vm.runInContext(saveFunction, context);
  return { save: (body = point) => context.saveTrackedLocation('delivery', '12345678901', body, true), writes };
}
test('active assigned delivery writes one location in transaction', async () => {
  const h = transactionHarness({ status: 'retirada', motoboyCpf: '12345678901', rastreamentoAtivo: true });
  await h.save();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].data.motoboyLocalizacao.clientTimestamp, now);
});
for (const status of ['finalizada', 'cancelada', 'aceita']) test(`GPS cannot revive ${status} delivery`, async () => {
  const h = transactionHarness({ status, motoboyCpf: '12345678901', rastreamentoAtivo: true });
  await assert.rejects(h.save(), /rastreamento_nao_ativo/);
  assert.equal(h.writes.length, 0);
});
test('another driver cannot change position', async () => {
  const h = transactionHarness({ status: 'retirada', motoboyCpf: '99999999999', rastreamentoAtivo: true });
  await assert.rejects(h.save(), /rastreamento_nao_ativo/);
  assert.equal(h.writes.length, 0);
});
test('ignored fix causes no database write', async () => {
  const h = transactionHarness({ status: 'retirada', motoboyCpf: '12345678901', motoboyLocalizacao: { ...point, clientTimestamp: now + 1 } });
  assert.equal((await h.save()).ignored, 'posicao_antiga');
  assert.equal(h.writes.length, 0);
});

test('company query filters active records before limiting historical records', () => {
  const route = server.slice(server.indexOf("app.get('/api/companies/me/active-deliveries'"), server.indexOf('// Compatibility for installed clients'));
  assert.ok(route.indexOf(".where('status', 'in'") > 0);
  assert.ok(route.indexOf(".where('status', 'in'") < route.indexOf('.limit(100)'));
});

test('tracking access checks device or verified customer, including cache path', async () => {
  const source = server.slice(server.indexOf('async function canReadRideTracking('), server.indexOf("app.get('/api/rides/:rideId/status'"));
  const context = vm.createContext({ validDeviceId: (x) => x || '', hashSecret: (x) => `hash:${x}`, findCustomerSession: async (token) => token === 'valid' ? { customerId: 'customer1' } : null });
  vm.runInContext(source, context);
  const access = { deviceHash: 'hash:device1', customerId: 'customer1' };
  const check = (headers) => context.canReadRideTracking({ header: (name) => headers[name] }, access);
  assert.equal(await check({}), false);
  assert.equal(await check({ 'x-customer-device': 'another' }), false);
  assert.equal(await check({ 'x-customer-device': 'device1' }), true);
  assert.equal(await check({ authorization: 'Bearer valid' }), true);
  assert.equal(await check({ authorization: 'Bearer invalid' }), false);
});

function driverHarness() {
  let clock = now;
  let nextGps;
  let watchCount = 0;
  const requests = [];
  const events = {};
  const documentEvents = {};
  const window = { addEventListener: (name, fn) => { events[name] = fn; } };
  const document = { visibilityState: 'visible', querySelectorAll: () => [], getElementById: () => null, addEventListener: (name, fn) => { documentEvents[name] = fn; } };
  const context = vm.createContext({
    window, document, Date: { now: () => clock },
    navigator: { onLine: true, geolocation: { watchPosition: (next) => { nextGps = next; return ++watchCount; }, clearWatch: () => {} } },
    localStorage: { getItem: () => JSON.stringify({ cpf: '12345678901', cnh: '12345678901', telefone: '19999999999' }) },
    AbortController, setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1,
    MutationObserver: class { observe() {} }, requestAnimationFrame: () => 1,
    fetch: async (url) => { requests.push(url); return { ok: true, json: async () => ({ ok: true, jobs: [] }) }; }
  });
  vm.runInContext(fs.readFileSync(new URL('../../motoboy-tracking.js', import.meta.url), 'utf8'), context);
  events.DOMContentLoaded();
  return {
    context, requests, documentEvents,
    watchCount: () => watchCount,
    jobs: (jobs) => events['motoja:jobs-rendered']({ detail: { scope: 'mine', kind: 'deliveries', jobs } }),
    tick: async (advance = 0, accuracy = 10) => {
      clock += advance;
      nextGps({ timestamp: clock, coords: { ...point, accuracy } });
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
}
test('multiple deliveries share one GPS watch even without visible cards', async () => {
  const h = driverHarness();
  h.jobs([{ id: 'a', status: 'retirada' }, { id: 'b', status: 'retirada' }]);
  assert.equal(h.watchCount(), 1);
  await h.tick();
  assert.equal(h.requests.filter((url) => url.endsWith('/location')).length, 2);
});
test('stationary driver heartbeat is limited; poor fixes do not reach server', async () => {
  const h = driverHarness();
  h.jobs([{ id: 'a', status: 'retirada' }]);
  await h.tick();
  await h.tick(1000);
  await h.tick(8000);
  assert.equal(h.requests.length, 1);
  await h.tick(12000);
  assert.equal(h.requests.length, 2);
  await h.tick(21000, 500);
  assert.equal(h.requests.length, 2);
});
test('completed jobs stop sending positions', async () => {
  const h = driverHarness();
  h.jobs([{ id: 'a', status: 'retirada' }]);
  await h.tick();
  h.jobs([]);
  await h.tick(21000);
  assert.equal(h.requests.length, 1);
});
test('hidden document does not restart GPS; visible document resumes', () => {
  const h = driverHarness();
  h.jobs([{ id: 'a', status: 'retirada' }]);
  h.context.document.visibilityState = 'hidden';
  h.documentEvents.visibilitychange();
  assert.equal(h.watchCount(), 1);
  h.context.document.visibilityState = 'visible';
  h.documentEvents.visibilitychange();
  assert.equal(h.watchCount(), 2);
});
test('map does not animate backwards on an out-of-order event or across a long gap', () => {
  const window = {};
  const context = vm.createContext({ window, Date: { now: () => now }, performance: { now: () => 0 }, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} });
  vm.runInContext(fs.readFileSync(new URL('../../tracking-map.js', import.meta.url), 'utf8'), context);
  const moves = [];
  const marker = { getLatLng: () => ({ lat: 1, lng: 2 }), setLatLng: (point) => moves.push(point), _map: {} };
  window.MotoTracking.move(marker, [3, 4], { clientTimestamp: now - 60000 });
  window.MotoTracking.move(marker, [9, 9], { clientTimestamp: now - 65000 });
  assert.equal(moves.length, 1);
  window.MotoTracking.move(marker, [5, 6], { clientTimestamp: now });
  assert.equal(moves.length, 2);
  assert.equal(window.MotoTracking.age(null), Infinity);
});
