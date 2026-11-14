import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
function slice(a, b) { const i = source.indexOf(a); const j = source.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, a); return source.slice(i, j); }
const DRIVER = '11111111111';

function harness(ride) {
  const records = new Map([['corridas/r1', ride]]);
  const ref = (path) => ({ path, id: path.split('/').at(-1), get: async () => ({ exists: records.has(path), data: () => records.get(path) }),
    set: async (d) => records.set(path, { ...records.get(path), ...Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v?.inc ? Number(records.get(path)?.[k] || 0) + v.inc : v])) }) });
  const db = { collection: (name) => ({ doc: (id) => ref(`${name}/${id}`) }),
    runTransaction: async (fn) => { const ops = []; await fn({ get: (r) => r.get(), set: (r, d) => ops.push([r, d]) }); for (const [r, d] of ops) await r.set(d); } };
  const routes = {};
  const ctx = vm.createContext({ db, Math, Number, String, Date,
    admin: { firestore: { FieldValue: { serverTimestamp: () => 'TS', increment: (n) => ({ inc: n }), delete: () => undefined } } },
    onlyDigits: (v) => String(v || '').replace(/\D/g, ''), timestampMs: () => Date.now(),
    getDriverWithProof: async () => ({}), isStandaloneDelivery: (r) => r.modalidade === 'entrega_avulsa', STANDALONE_DELIVERY_CODE_MAX_ATTEMPTS: 5,
    rideSplitAmounts: (v) => ({ driverAmount: 5, appFee: 1.5, driverPercent: 0.77, appPercent: 0.23 }),
    driverEarningEvent: () => ({}), recordDriverEarning: async () => {},
    app: { post: (p, ...h) => { routes[p] = h.at(-1); } } });
  vm.runInContext(slice("app.post('/api/rides/:rideId/finish'", "app.post('/api/admin/deliveries/:deliveryId/force-finish'"), ctx);
  const call = async (codigoEntrega) => {
    const out = { status: 200 }; let failure;
    const res = { status: (c) => { out.status = c; return res; }, json: (d) => { out.data = d; return res; } };
    await routes['/api/rides/:rideId/finish']({ params: { rideId: 'r1' }, body: { driverCpf: DRIVER, codigoEntrega } }, res, (e) => { failure = e; });
    if (failure) { out.status = failure.status || 500; out.data = { error: failure.code, message: failure.message, codigoConferido: failure.codigoConferido }; }
    return out;
  };
  return { records, call };
}

const ride = (extra = {}) => ({ status: 'aceita', modalidade: 'entrega_avulsa', motoboyCpf: DRIVER, clienteAvisadoEm: 1, codigoEntrega: '4821', tentativasCodigoEntrega: 0, ...extra });

test('standalone delivery: the code is checked before the payment and says how many tries are left', async () => {
  const pending = harness(ride({ pagamento: { status: 'pending' } }));
  const wrong = await pending.call('1111');
  assert.equal(wrong.data.error, 'codigo_entrega_invalido');
  assert.equal(wrong.data.tentativasRestantes, 4);
  assert.match(wrong.data.message, /restam 4 tentativas/);
  assert.equal(pending.records.get('corridas/r1').tentativasCodigoEntrega, 1);
  const right = await pending.call('4821');
  assert.equal(right.data.error, 'pagamento_ainda_nao_aprovado');
  assert.equal(right.data.codigoConferido, true);
  assert.match(right.data.message, /Codigo de entrega certo/);

  const paid = harness(ride({ pagamento: { status: 'approved' } }));
  assert.equal((await paid.call('4821')).status, 200);
  assert.equal(paid.records.get('corridas/r1').status, 'finalizada');

  const blocked = harness(ride({ tentativasCodigoEntrega: 5, pagamento: { status: 'approved' } }));
  assert.equal((await blocked.call('4821')).data.error, 'codigo_entrega_bloqueado');
});

function cashHarness(ride) {
  const records = new Map([['corridas/r1', ride]]);
  const apply = (path, d) => records.set(path, { ...records.get(path), ...Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v?.inc ? Number(records.get(path)?.[k] || 0) + v.inc : v])) });
  const ref = (path) => ({ path, id: path.split('/').at(-1), get: async () => ({ exists: records.has(path), data: () => records.get(path) }), set: async (d) => apply(path, d),
    collection: (name) => ({ doc: (id) => ref(`${path}/${name}/${id}`) }) });
  const db = { collection: (name) => ({ doc: (id) => ref(`${name}/${id}`) }),
    runTransaction: async (fn) => { const ops = []; await fn({ get: (r) => r.get(), set: (r, d) => ops.push([r, d]) }); ops.forEach(([r, d]) => apply(r.path, d)); } };
  const routes = {}, earnings = [], released = [];
  const ctx = vm.createContext({ db, Date, Number, String, Object, Math,
    admin: { firestore: { FieldValue: { serverTimestamp: () => 'TS', increment: (n) => ({ inc: n }), delete: () => undefined } } },
    onlyDigits: (v) => String(v || '').replace(/\D/g, ''), cleanText: (v) => String(v || ''), getDriverWithProof: async () => ({}),
    isStandaloneDelivery: (r) => r.modalidade === 'entrega_avulsa', STANDALONE_DELIVERY_CODE_MAX_ATTEMPTS: 5,
    rideStatusCache: new Map(), adminStateCache: {}, emitSupportOperationsRefresh() {},
    money: (n) => Math.round(Number(n || 0) * 100) / 100, timestampMs: (v) => Number(v || 0),
    rideSplitAmounts: (total) => ({ total: Number(total || 6.5), appFee: 1.5, driverAmount: Number(total || 6.5) - 1.5, appPercent: 0.25, driverPercent: 0.75 }),
    driverEarningEvent: (kind, id, job) => ({ kind, id, ganho: job.ganhoMotoboy }), recordDriverEarning: async (tx, cpf, event) => earnings.push(event),
    clearDriverProofCache() {}, driverAvailability: { job: (k, id, st) => released.push([k, id, st]) }, driverAvailabilitySocket: { publishAll() {} },
    app: { post: (p, ...h) => { routes[p] = h.at(-1); } } });
  vm.runInContext(slice('const DEBT_MIN_DRIVER_SHARE', 'function isOutOfConchal('), ctx);
  vm.runInContext(slice('// Cliente pagou em dinheiro (ou Pix direto ao motoboy)', '// Avisa o motoboy que perdeu a corrida por atraso'), ctx);
  const call = async (body) => {
    const out = { status: 200 }; let failure;
    const res = { status: (c) => { out.status = c; return res; }, json: (d) => { out.data = d; return res; } };
    await routes['/api/rides/:rideId/cash-reported']({ params: { rideId: 'r1' }, body: { driverCpf: DRIVER, ...body } }, res, (e) => { failure = e; });
    if (failure) { out.status = failure.status || 500; out.data = { error: failure.code }; }
    return out;
  };
  return { records, call, earnings, released, ctx };
}

test('cash payment finishes the ride at once, frees the motoboy and the app fee becomes his debt (avulsa needs the right code)', async () => {
  const moto = cashHarness({ status: 'aceita', motoboyCpf: DRIVER, motoboy: 'Bruno', nome: 'Ana', valor: 6.5, clienteAvisadoEm: 1, pagamento: { status: 'pending' } });
  const ok = await moto.call({});
  assert.equal(ok.status, 200);
  assert.equal(ok.data.finalizada, true);
  const r = moto.records.get('corridas/r1');
  assert.equal(r.dinheiroInformado.motoboyCpf, DRIVER);
  assert.equal(r.status, 'finalizada', 'nao espera mais o dono');
  assert.equal(r.pagoEmDinheiro, true);
  assert.equal(r.pagamento.metodo, 'dinheiro');
  assert.equal(moto.records.get(`motoboys/${DRIVER}`).dividaAppCentavos, 150, 'taxa de R$ 1,50 vira divida');
  assert.equal(moto.records.get(`motoboys/${DRIVER}/dividaApp/dinheiro_r1`).centavos, 150);
  assert.equal(moto.earnings.length, 1);
  assert.deepEqual(moto.released, [['rides', 'r1', 'finalizada']]);
  // Desconto na proxima corrida paga pelo app: deixa pelo menos 30% para o motoboy.
  assert.equal(moto.ctx.debtCollectAmount(150, 6.5, 1.5), 1.5);
  assert.equal(moto.ctx.debtCollectAmount(1000, 6.5, 1.5), 3.05);
  assert.equal(moto.ctx.debtCollectAmount(-200, 6.5, 1.5), 0, 'credito nao cobra nada');
  assert.equal(moto.ctx.debtCollectAmount(0, 20, 5), 0);

  const avulsa = cashHarness(ride({ pagamento: { status: 'pending' } }));
  assert.equal((await avulsa.call({ codigoEntrega: '0000' })).data.error, 'codigo_entrega_invalido');
  assert.equal(avulsa.records.get('corridas/r1').tentativasCodigoEntrega, 1);
  assert.equal((await avulsa.call({ codigoEntrega: '4821' })).status, 200);
  assert.equal(avulsa.records.get('corridas/r1').dinheiroInformado.codigoConferido, true);

  const paid = cashHarness({ status: 'aceita', motoboyCpf: DRIVER, clienteAvisadoEm: 1, pagamento: { status: 'approved' } });
  assert.equal((await paid.call({})).data.error, 'pagamento_ja_aprovado');
  const other = cashHarness({ status: 'aceita', motoboyCpf: '22222222222', clienteAvisadoEm: 1 });
  assert.equal((await other.call({})).data.error, 'corrida_nao_e_sua');
});
