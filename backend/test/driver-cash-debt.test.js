import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { repasseUpdate } from '../src/customer-cards.js';
import { mpPaymentForm } from '../src/payment-form.js';

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
    hashSecret: (v) => `h${v}`, requiredEnv: () => 'tok', mpFetch: async () => payment, repasseUpdate, mpPaymentForm,
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
  const call = harness(records, pagamento({ payment_method_id: 'pix', payment_type_id: 'bank_transfer' }));
  assert.equal((await call()).status, 200);
  assert.equal(records.get('corridas/r2').pagamento.forma, 'pix', 'o dono ve que foi Pix');
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

// Pagamento de verdade do Mercado Pago: a taxa da MotoJa vem em fee_details ("application_fee"),
// sem o campo marketplace_fee. Antes isso deixava a divida sem baixa mesmo com a taxa cobrada.
const pagamentoReal = (feeAmount, extra = {}) => {
  const { marketplace_fee, ...semCampo } = pagamento(extra);
  return { ...semCampo, fee_details: feeAmount === null ? [] : [{ type: 'mercadopago_fee', amount: 0.32 }, { type: 'application_fee', amount: feeAmount, fee_payer: 'collector' }] };
};

test('taxa cobrada vindo em fee_details (formato do Mercado Pago) da baixa na divida', async () => {
  const records = new Map([
    ['corridas/r2', { status: 'aceita', motoboyCpf: DRIVER, nome: 'Natan', valor: 6.5, pagamento: { total: 6.5, appFee: 1.5, driverAmount: 5, cobrancaDividaApp: 1.5 } }],
    [`motoboys/${DRIVER}`, { dividaAppCentavos: 150 }]
  ]);
  await harness(records, pagamentoReal(3))();
  assert.equal(records.get(`motoboys/${DRIVER}`).dividaAppCentavos, 0);
  // Sem nenhuma informacao de taxa no pagamento: vale a cobranca que o nosso servidor pediu.
  const r2 = new Map([
    ['corridas/r2', { status: 'aceita', motoboyCpf: DRIVER, valor: 6.5, pagamento: { total: 6.5, appFee: 1.5 } }],
    [`motoboys/${DRIVER}`, { dividaAppCentavos: 150 }]
  ]);
  await harness(r2, pagamentoReal(null))();
  assert.equal(r2.get(`motoboys/${DRIVER}`).dividaAppCentavos, 0);
  // A taxa cobrada nao incluiu a divida: nao da baixa.
  const r3 = new Map([
    ['corridas/r2', { status: 'aceita', motoboyCpf: DRIVER, valor: 6.5, pagamento: { total: 6.5, appFee: 1.5 } }],
    [`motoboys/${DRIVER}`, { dividaAppCentavos: 150 }]
  ]);
  await harness(r3, pagamentoReal(1.5))();
  assert.equal(r3.get(`motoboys/${DRIVER}`).dividaAppCentavos, 150);
});

test('reparo: corrida ja finalizada pelo app sem a baixa recebe o desconto uma vez so', async () => {
  const records = new Map([
    ['corridas/r9', { status: 'finalizada', motoboyCpf: DRIVER, nome: 'Natan', valor: 6.5, pagamento: { total: 6.5, appFee: 1.5, status: 'approved', paymentId: '987', cobrancaDividaApp: 0 } }],
    [`motoboys/${DRIVER}`, { dividaAppCentavos: 500 }]
  ]);
  const inc = (v) => v && typeof v === 'object' && 'inc' in v;
  const apply = (path, d) => records.set(path, { ...records.get(path), ...Object.fromEntries(Object.entries(d).map(([k, v]) => [k, inc(v) ? Number(records.get(path)?.[k] || 0) + v.inc : (v && typeof v === 'object' && !Array.isArray(v) && records.get(path)?.[k] && typeof records.get(path)[k] === 'object' ? { ...records.get(path)[k], ...v } : v)])) });
  const ref = (path) => ({ path, id: path.split('/').at(-1), collection: (n) => ({ doc: (id) => ref(`${path}/${n}/${id}`) }) });
  const db = { collection: (n) => ({ doc: (id) => ref(`${n}/${id}`) }),
    runTransaction: async (fn) => { const ops = []; const out = await fn({ get: async (r) => ({ exists: records.has(r.path), data: () => records.get(r.path) }), set: (r, d) => ops.push([r.path, d]), update: (r, d) => ops.push([r.path, d]) }); ops.forEach(([p, d]) => apply(p, d)); return out; } };
  const ctx = vm.createContext({ db, Date, Math, Number, String, Object, JSON, console,
    admin: { firestore: { FieldValue: { serverTimestamp: () => 'TS', increment: (n) => ({ inc: n }) } } },
    onlyDigits: (v) => String(v || '').replace(/\D/g, ''), cleanText: (v) => String(v || ''), money: (n) => Math.round(Number(n || 0) * 100) / 100 });
  vm.runInContext(slice('const DEBT_MIN_DRIVER_SHARE', 'function isOutOfConchal('), ctx);
  vm.runInContext(slice('// Corrida paga pelo app (conta do motoboy) cuja cobranca', '// Uma vez: confere'), ctx);
  const pago = pagamentoReal(4.55, { metadata: { ride_id: 'r9', driver_cpf: DRIVER, app_fee: 1.5, driver_amount: 5, cobranca_divida: 3.05 } });
  assert.equal(await ctx.settleRideDebtFromPayment(ref('corridas/r9'), pago), 3.05);
  assert.equal(records.get(`motoboys/${DRIVER}`).dividaAppCentavos, 195);
  assert.equal(records.get('corridas/r9').pagamento.dividaDescontadaEm, 'TS');
  assert.equal(await ctx.settleRideDebtFromPayment(ref('corridas/r9'), pago), 0, 'nao desconta de novo');
  assert.equal(records.get(`motoboys/${DRIVER}`).dividaAppCentavos, 195);
  // Pagamento na conta da MotoJa (sem Mercado Pago do motoboy): desconta no repasse, nao aqui.
  records.set('corridas/r8', { status: 'finalizada', motoboyCpf: DRIVER, valor: 6.5, pagamento: { total: 6.5, status: 'approved', paymentId: '988' } });
  assert.equal(await ctx.settleRideDebtFromPayment(ref('corridas/r8'), { ...pago, id: '988', metadata: { ...pago.metadata, payment_kind: 'ride_owner_fallback' } }), 0);
});
