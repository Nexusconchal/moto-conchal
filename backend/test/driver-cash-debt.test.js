import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { repasseUpdate } from '../src/customer-cards.js';

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const slice = (a, b) => { const i = source.indexOf(a), j = source.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, a); return source.slice(i, j); };
const DRIVER = '11122233344';

function harness(records, payment) {
  const inc = (v) => v && typeof v === 'object' && 'inc' in v;
  const apply = (path, d, merge = true) => records.set(path, { ...(merge ? records.get(path) : {}), ...Object.fromEntries(Object.entries(d).map(([k, v]) => [k, inc(v) ? Number(records.get(path)?.[k] || 0) + v.inc : v])) });
  const ref = (path) => ({ path, id: path.split('/').at(-1), collection: (n) => ({ doc: (id) => ref(`${path}/${n}/${id}`) }) });
  const db = { collection: (n) => ({ doc: (id) => ref(`${n}/${id}`) }),
    runTransaction: async (fn) => { const ops = []; await fn({ get: async (r) => ({ exists: records.has(r.path), data: () => records.get(r.path) }), set: (r, d, o) => ops.push([r.path, d, o?.merge !== false]), update: (r, d) => ops.push([r.path, d, true]) }); ops.forEach(([p, d, m]) => apply(p, d, m)); } };
  const routes = {};
  const ctx = vm.createContext({ db, Date, Math, Number, String, Object, JSON, console,
    admin: { firestore: { FieldValue: { serverTimestamp: () => 'TS', increment: (n) => ({ inc: n }), delete: () => undefined } } },
    onlyDigits: (v) => String(v || '').replace(/\D/g, ''), cleanText: (v) => String(v || ''), money: (n) => Math.round(Number(n || 0) * 100) / 100,
    hashSecret: (v) => `h${v}`, requiredEnv: () => 'tok', mpFetch: async () => payment, repasseUpdate,
    applyCompanyDepositPayment: async () => {}, app: { post: (p, ...h) => { routes[p] = h.at(-1); } } });
  vm.runInContext(slice('const DEBT_MIN_DRIVER_SHARE', 'function isOutOfConchal('), ctx);
  vm.runInContext(slice("app.post('/api/mercadopago/webhook'", 'async function supportEvolution('), ctx);
  return async () => {
    const out = { status: 200 }; let failure;
    const res = { status: (c) => { out.status = c; return res; }, json: (d) => { out.data = d; return res; } };
    await routes['/api/mercadopago/webhook']({ query: { id: payment.id, topic: 'payment', driverCpf: DRIVER }, body: {} }, res, (e) => { failure = e; });
    if (failure) throw failure;
    return out;
  };
}

const pagamento = (extra = {}) => ({ id: '987', status: 'approved', currency_id: 'BRL', transaction_amount: 6.5, external_reference: 'r2',
  marketplace_fee: 3, metadata: { ride_id: 'r2', driver_cpf: DRIVER, app_fee: 1.5, driver_amount: 5, cobranca_divida: 1.5 }, ...extra });

test('proxima corrida paga pelo app (conta do motoboy) abate a taxa da corrida em dinheiro', async () => {
  const records = new Map([
    ['corridas/r2', { status: 'aceita', motoboyCpf: DRIVER, nome: 'Ana', valor: 6.5, pagamento: { total: 6.5, appFee: 1.5, driverAmount: 5, cobrancaDividaApp: 1.5 } }],
    [`motoboys/${DRIVER}`, { dividaAppCentavos: 150 }]
  ]);
  const call = harness(records, pagamento());
  assert.equal((await call()).status, 200);
  assert.equal(records.get(`motoboys/${DRIVER}`).dividaAppCentavos, 0);
  assert.equal(records.get(`motoboys/${DRIVER}/dividaApp/desconto_r2`).centavos, -150);
  const p = records.get('corridas/r2').pagamento;
  assert.equal(p.appFee, 1.5, 'taxa do app continua a da corrida');
  assert.equal(p.cobrancaDividaApp, 1.5);
  // Webhook repetido nao desconta de novo.
  await call();
  assert.equal(records.get(`motoboys/${DRIVER}`).dividaAppCentavos, 0);
});

test('sem a cobranca na taxa (pagamento sem desconto) a divida continua; pagamento depois de dinheiro vira duplicado', async () => {
  const records = new Map([
    ['corridas/r2', { status: 'aceita', motoboyCpf: DRIVER, valor: 6.5, pagamento: { total: 6.5 } }],
    [`motoboys/${DRIVER}`, { dividaAppCentavos: 150 }]
  ]);
  await harness(records, pagamento({ marketplace_fee: 1.5 }))();
  assert.equal(records.get(`motoboys/${DRIVER}`).dividaAppCentavos, 150);

  const cash = new Map([['corridas/r2', { status: 'finalizada', pagoEmDinheiro: true, motoboyCpf: DRIVER, valor: 6.5, pagamento: { total: 6.5, metodo: 'dinheiro', status: 'approved' } }]]);
  await harness(cash, pagamento())();
  assert.ok(cash.get('corridas/r2').pagamentoDuplicadoEm);
  assert.equal(cash.get('corridas/r2').pagamento.metodo, 'dinheiro');
});
