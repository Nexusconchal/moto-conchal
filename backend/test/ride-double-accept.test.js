import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
function slice(startText, endText) { const a = source.indexOf(startText); const b = source.indexOf(endText, a + 1); assert.ok(a >= 0 && b > a); return source.slice(a, b); }
function makeDb(records, hooks = {}) {
  const ref = path => ({ path, id: path.split('/').at(-1) });
  const snap = path => ({ exists: records.has(path), data: () => records.get(path), ref: ref(path), id: path.split('/').at(-1) });
  const apply = (path, data) => records.set(path, { ...records.get(path), ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v === 'DELETE' ? undefined : v])) });
  return {
    batch: () => { const ops = []; return { update: (r, d) => ops.push([r, d]), commit: async () => ops.forEach(([r, d]) => apply(r.path, d)) }; },
    collection: name => ({ doc: id => ref(`${name}/${id}`), where: (_f, _o, value) => ({ get: async () => {
      // Snapshot of the query moment: later changes are not visible to it.
      const docs = [...records.keys()].filter(p => p.startsWith(`${name}/`) && records.get(p).status === value)
        .map(p => { const copy = { ...records.get(p) }; return { ...snap(p), data: () => copy }; });
      await hooks.afterQuery?.(name, value);
      return { docs, forEach: fn => docs.forEach(fn) };
    } }) }),
    runTransaction: async fn => { const pending = []; const result = await fn({ get: async r => snap(r.path), update: (r, d) => pending.push([r, d]), set: (r, d) => pending.push([r, d]) }); pending.forEach(([r, d]) => apply(r.path, d)); return result; }
  };
}
const fv = { serverTimestamp: () => 'TS', delete: () => 'DELETE' };
test('the 3-minute reopen does not take a ride from a motoboy who notified the client right after the scan', async () => {
  const old = Date.now() - 5 * 60000;
  const records = new Map([['corridas/r1', { status: 'aceita', motoboyCpf: '11111111111', motoboy: 'A', aceitaEm: old, criadaEm: old }],
    ['corridas/r2', { status: 'aceita', motoboyCpf: '22222222222', motoboy: 'B', aceitaEm: old, criadaEm: old }]]);
  // Motoboy A taps "Avisar cliente" right after the scan read the accepted rides.
  const db = makeDb(records, { afterQuery: (name, value) => { if (name === 'corridas' && value === 'aceita') records.set('corridas/r1', { ...records.get('corridas/r1'), clienteAvisadoEm: 'TS' }); } });
  const released = [];
  const ctx = vm.createContext({ db, Date, Number, console, admin: { firestore: { FieldValue: fv } }, timestampMs: Number, cleanText: v => String(v || ''),
    RIDE_EXPIRE_MS: 9e9, CAR_RIDE_EXPIRE_MS: 9e9, DELIVERY_EXPIRE_MS: 9e9, ACCEPTED_NOTICE_MS: 180000,
    releaseDeliveryReservation: async () => {}, driverAvailability: { job: (_k, id) => released.push(id) }, driverAvailabilitySocket: { publishAll: () => {} } });
  vm.runInContext(slice('async function cleanupRides(', '\n}\n') + '\n}', ctx);
  await ctx.cleanupRides();
  assert.equal(records.get('corridas/r1').status, 'aceita'); assert.equal(records.get('corridas/r1').motoboyCpf, '11111111111');
  assert.equal(records.get('corridas/r2').status, 'pendente'); assert.equal(records.get('corridas/r2').motoboyCpf, '');
  assert.deepEqual(released, ['r2']);
});
test('notify-client only marks the ride for the motoboy who still owns it', async () => {
  const records = new Map([['corridas/r1', { status: 'pendente', motoboyCpf: '', telefoneCliente: '19999990000' }]]);
  const routes = {};
  const ctx = vm.createContext({ db: makeDb(records), admin: { firestore: { FieldValue: fv } }, onlyDigits: v => String(v || '').replace(/\D/g, ''),
    getDriverWithProof: async () => ({}), BACKEND_BASE_URL: '', isStandaloneDelivery: () => false, money: Number, ridePaymentInstructions: () => '',
    whatsappLink: (phone) => `https://wa.me/55${phone}`, sendEvolutionText: async () => ({}), console, setTimeout, Promise,
    app: { post: (path, ...h) => { routes[path] = h.at(-1); } } });
  vm.runInContext(slice("app.post('/api/rides/:rideId/notify-client'", "\napp.post("), ctx);
  const call = async cpf => { const out = {}; const res = { status: c => { out.status = c; return res; }, json: d => { out.data = d; return res; } };
    await routes['/api/rides/:rideId/notify-client']({ params: { rideId: 'r1' }, body: { driverCpf: cpf } }, res, e => { throw e; }); return out; };
  const reopened = await call('11111111111');
  assert.equal(reopened.status, 409); assert.equal(records.get('corridas/r1').clienteAvisadoEm, undefined);
  records.set('corridas/r1', { status: 'aceita', motoboyCpf: '22222222222', motoboy: 'B', telefoneCliente: '19999990000' });
  assert.equal((await call('11111111111')).status, 409); assert.equal(records.get('corridas/r1').clienteAvisadoEm, undefined);
  const owner = await call('22222222222');
  assert.equal(owner.data.ok, true); assert.equal(records.get('corridas/r1').clienteAvisadoEm, 'TS');
});
