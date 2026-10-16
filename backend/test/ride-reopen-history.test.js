import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
function slice(startText, endText) { const a = source.indexOf(startText); const b = source.indexOf(endText, a + 1); assert.ok(a >= 0 && b > a); return source.slice(a, b); }
function makeDb(records) {
  const ref = path => ({ path, id: path.split('/').at(-1) });
  const snap = path => ({ exists: records.has(path), data: () => records.get(path), ref: ref(path), id: path.split('/').at(-1) });
  const apply = (path, data) => records.set(path, { ...records.get(path), ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v === 'DELETE' ? undefined : v])) });
  return {
    batch: () => { const ops = []; return { update: (r, d) => ops.push([r, d]), commit: async () => ops.forEach(([r, d]) => apply(r.path, d)) }; },
    collection: name => ({ doc: id => ref(`${name}/${id}`), where: (_f, _o, value) => ({ get: async () => {
      const docs = [...records.keys()].filter(p => p.startsWith(`${name}/`) && records.get(p).status === value).map(p => snap(p));
      return { docs, forEach: fn => docs.forEach(fn) };
    } }) }),
    runTransaction: async fn => { const pending = []; const result = await fn({ get: async r => snap(r.path), update: (r, d) => pending.push([r, d]), set: (r, d) => pending.push([r, d]) }); pending.forEach(([r, d]) => apply(r.path, d)); return result; }
  };
}
const fv = { serverTimestamp: () => 'TS', delete: () => 'DELETE' };
const onlyDigits = v => String(v || '').replace(/\D/g, '');

function cleanupHarness(records, sent) {
  const ctx = vm.createContext({ db: makeDb(records), Date, Number, Array, console, admin: { firestore: { FieldValue: fv } }, timestampMs: Number, cleanText: v => String(v || ''),
    RIDE_EXPIRE_MS: 9e9, CAR_RIDE_EXPIRE_MS: 9e9, DELIVERY_EXPIRE_MS: 9e9, ACCEPTED_NOTICE_MS: 6 * 60000,
    notifyClientRideReopened: async ride => sent.push(ride.telefoneCliente),
    releaseDeliveryReservation: async () => {}, driverAvailability: { job: () => {} }, driverAvailabilitySocket: { publishAll: () => {} } });
  vm.runInContext(slice('async function cleanupRides(', '\n}\n') + '\n}', ctx);
  return ctx;
}

test('a ride accepted 4 minutes ago is not reopened (limit is 6 minutes)', async () => {
  const at = Date.now() - 4 * 60000;
  const records = new Map([['corridas/r1', { status: 'aceita', motoboyCpf: '11111111111', motoboy: 'Laerte', aceitaEm: at, criadaEm: at }]]);
  await cleanupHarness(records, []).cleanupRides();
  assert.equal(records.get('corridas/r1').status, 'aceita');
});

test('reopening keeps who accepted, keeps the link the client already got and warns the client', async () => {
  const at = Date.now() - 7 * 60000;
  const records = new Map([
    ['corridas/r1', { status: 'aceita', motoboyCpf: '11111111111', motoboy: 'Laerte', motoboyTelefone: '19988887777', aceitaEm: at, criadaEm: at, telefoneCliente: '19999990000',
      pagamento: { initPoint: 'https://mp/link' }, clienteAvisoAutomatico: { enviado: true } }],
    ['corridas/r2', { status: 'aceita', motoboyCpf: '22222222222', motoboy: 'B', aceitaEm: at, criadaEm: at, telefoneCliente: '19999991111', pagamento: { initPoint: 'https://mp/b' } }]]);
  const sent = [];
  await cleanupHarness(records, sent).cleanupRides();
  const r1 = records.get('corridas/r1');
  assert.equal(r1.status, 'pendente'); assert.equal(r1.motoboyCpf, '');
  assert.equal(r1.reaberturas.length, 1);
  assert.equal(r1.reaberturas[0].motoboy, 'Laerte'); assert.equal(r1.reaberturas[0].motoboyCpf, '11111111111');
  assert.equal(r1.reaberturas[0].clienteRecebeuLink, true);
  assert.equal(r1.pagamento.initPoint, 'https://mp/link');
  // Sem aviso automatico, o link era so do motoboy anterior e sai.
  assert.equal(records.get('corridas/r2').pagamento, undefined);
  assert.equal(records.get('corridas/r2').reaberturas[0].clienteRecebeuLink, false);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(sent, ['19999990000']);
});

function noticeHarness(records, evolution) {
  const ctx = vm.createContext({ db: makeDb(records), onlyDigits, money: Number, BACKEND_BASE_URL: 'https://api', isStandaloneDelivery: () => false,
    ridePaymentInstructions: ride => `Pague: ${ride.pagamento.initPoint}`, sendEvolutionText: evolution, setTimeout, Promise, Date, String });
  vm.runInContext([
    slice('function clientWhatsappNumber(', '\n}\n') + '\n}',
    slice('function rideAcceptedClientMessage(', '\n}\n') + '\n}',
    slice('async function notifyClientRideAccepted(', '\n}\n') + '\n}'
  ].join('\n'), ctx);
  return ctx;
}

test('on accept the client gets the motoboy and the payment link by WhatsApp, and the ride records it', async () => {
  const records = new Map([['corridas/r1', { status: 'aceita', motoboyCpf: '11111111111' }]]);
  const msgs = [];
  const ctx = noticeHarness(records, async (number, text) => { msgs.push([number, text]); return { sent: true }; });
  await ctx.notifyClientRideAccepted({ path: 'corridas/r1', id: 'r1' }, { nome: 'Ana', motoboy: 'Laerte', motoboyCpf: '11111111111', telefoneCliente: '(19) 99999-0000', valor: 12, pagamento: { initPoint: 'https://mp/link' } });
  assert.equal(msgs[0][0], '5519999990000');
  assert.match(msgs[0][1], /Laerte/); assert.match(msgs[0][1], /https:\/\/mp\/link/); assert.match(msgs[0][1], /https:\/\/api\/corrida\/r1/);
  assert.equal(records.get('corridas/r1').clienteAvisoAutomatico.enviado, true);
});

test('a failed WhatsApp is recorded as not sent, and a ride already taken by someone else is left alone', async () => {
  const records = new Map([['corridas/r1', { status: 'aceita', motoboyCpf: '11111111111' }], ['corridas/r2', { status: 'pendente', motoboyCpf: '' }]]);
  const ctx = noticeHarness(records, async () => { throw Object.assign(new Error('x'), { code: 'evolution_envio_falhou' }); });
  await ctx.notifyClientRideAccepted({ path: 'corridas/r1', id: 'r1' }, { motoboyCpf: '11111111111', telefoneCliente: '19999990000', pagamento: { initPoint: 'https://mp/link' } });
  assert.deepEqual({ ...records.get('corridas/r1').clienteAvisoAutomatico, emMs: 0 }, { enviado: false, motivo: 'evolution_envio_falhou', emMs: 0 });
  await ctx.notifyClientRideAccepted({ path: 'corridas/r2', id: 'r2' }, { motoboyCpf: '11111111111', telefoneCliente: '19999990000', pagamento: { initPoint: 'https://mp/link' } });
  assert.equal(records.get('corridas/r2').clienteAvisoAutomatico, undefined);
});
