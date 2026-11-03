import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  createCustomerCards, publicCard, storedCard, cardExpired, rejectionMessage, repasseUpdate,
  CPF_MAX_ERRORS, MAX_CARDS
} from '../src/customer-cards.js';

const hashSecret = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const CPF = '52998224725';
const OTHER_CPF = '11144477735';
const TOKEN = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

function fakeDb(records) {
  const ref = path => ({ path, id: path.split('/').at(-1), get: async () => snap(path), set: async (data, opts) => write(path, data, opts) });
  const snap = path => ({ id: path.split('/').at(-1), exists: records.has(path), data: () => records.get(path), ref: ref(path) });
  const merge = (a = {}, b = {}) => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) {
      out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) ? merge(out[k], v) : v;
    }
    return out;
  };
  function write(path, data, opts) { records.set(path, opts?.merge ? merge(records.get(path), data) : { ...data }); }
  let queue = Promise.resolve();
  return {
    collection: name => ({ doc: id => ref(`${name}/${id}`) }),
    runTransaction: fn => {
      const run = queue.then(async () => {
        const writes = [];
        const result = await fn({
          get: async r => snap(r.path),
          set: (r, data, opts) => writes.push([r.path, data, opts]),
          update: (r, data) => writes.push([r.path, data, { merge: true }])
        });
        writes.forEach(([path, data, opts]) => write(path, data, opts));
        return result;
      });
      queue = run.catch(() => {});
      return run;
    },
    ref
  };
}

function setup({ customer = {}, ride = {}, mp = {} } = {}) {
  const records = new Map();
  records.set('clientes/19999990000', { nome: 'Rafael Souza', ...customer });
  records.set('corridas/r1', {
    status: 'aceita', customerId: '19999990000', valor: 12, km: 4, motoboyCpf: '12345678901', motoboy: 'Joao',
    pagamento: { status: 'preference_created', initPoint: 'https://mp/link', preferenceId: 'pref1', receiver: undefined },
    ...ride
  });
  const db = fakeDb(records);
  const calls = [];
  const expired = [];
  let t = Date.UTC(2026, 9, 26, 15);
  const fetchImpl = async (url, options) => {
    const path = url.replace('https://api.mercadopago.com', '');
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, method: options.method, body, headers: options.headers });
    const handler = Object.entries(mp).find(([prefix]) => `${options.method} ${path}`.startsWith(prefix));
    const [status, data] = handler ? handler[1](body, options) : [500, {}];
    return { ok: status < 400, status, json: async () => data };
  };
  const cards = createCustomerCards({
    db,
    admin: { firestore: { FieldValue: { serverTimestamp: () => 'now' } } },
    fetchImpl,
    ownerToken: () => 'owner-token',
    publicKey: () => 'APP_USR-public',
    hashSecret,
    safeEqual: (a, b) => a === b,
    validCpf: value => /^\d{11}$/.test(value),
    rideAmounts: r => ({ total: Number(r.valor), appFee: 3, driverAmount: Number(r.valor) - 3 }),
    webhookUrl: params => `https://api.test/webhook?${new URLSearchParams(params)}`,
    expireRidePreference: async r => { expired.push(r.id); },
    now: () => t
  });
  const session = () => ({
    customerId: '19999990000',
    customer: records.get('clientes/19999990000'),
    customerSnap: { ref: db.ref('clientes/19999990000') }
  });
  return { records, cards, calls, expired, session, tick: ms => { t += ms; } };
}

const mpCard = (over = {}) => ({
  id: 'card9', last_four_digits: '4242', expiration_month: 11, expiration_year: 2030,
  payment_method: { id: 'master', name: 'Mastercard', payment_type_id: 'credit_card' },
  issuer: { id: 24 }, cardholder: { name: 'RAFAEL SOUZA', identification: { type: 'CPF', number: CPF } }, ...over
});
const savedCard = () => storedCard(mpCard(), CPF, hashSecret, Date.UTC(2026, 9, 1));

test('the saved card keeps only the last digits, brand, expiry and a CPF hash', () => {
  const card = savedCard();
  assert.equal(card.final, '4242');
  assert.equal(card.validade, '11/2030');
  assert.equal(card.cpfHash, hashSecret(CPF));
  assert.ok(!JSON.stringify(card).includes(CPF));
  const view = publicCard(card);
  assert.deepEqual(Object.keys(view).sort(), ['bandeira', 'bandeiraNome', 'cpfFinal', 'final', 'id', 'tipo', 'titular', 'validade']);
  assert.ok(!JSON.stringify(view).includes(hashSecret(CPF)));
  assert.equal(view.tipo, 'credito');
  assert.equal(cardExpired({ validade: '10/2026' }, Date.UTC(2026, 9, 31, 12)), false);
  assert.equal(cardExpired({ validade: '10/2026' }, Date.UTC(2026, 10, 1, 12)), true);
  assert.match(rejectionMessage('cc_rejected_bad_filled_security_code'), /Código de segurança/);
  assert.match(rejectionMessage('qualquer_coisa'), /não foi aprovado/);
});

test('adding a card creates the Mercado Pago customer once and never sees the card number', async () => {
  const h = setup({
    mp: {
      'GET /v1/customers/search': () => [200, { results: [] }],
      'POST /v1/customers/cus1/cards': () => [201, mpCard()],
      'POST /v1/customers': () => [201, { id: 'cus1' }]
    }
  });
  const result = await h.cards.add(h.session(), { token: TOKEN, cpf: CPF, cardNumber: '5031433215406351' });
  assert.equal(result.cartao.final, '4242');
  const customer = h.records.get('clientes/19999990000');
  assert.equal(customer.mpCustomerId, 'cus1');
  assert.equal(customer.cartoesMp.length, 1);
  assert.ok(!JSON.stringify([...h.records.values()]).includes('5031433215406351'));
  assert.ok(h.calls.every(call => !JSON.stringify(call.body || {}).includes('5031433215406351')));
  assert.match(h.calls.find(c => c.path === '/v1/customers').body.email, /^c[0-9a-f]{20}@clientes\.nexusmotoja\.com\.br$/);
  // Segundo cartao: reaproveita o customer.
  h.calls.length = 0;
  await h.cards.add(h.session(), { token: TOKEN, cpf: CPF });
  assert.ok(!h.calls.some(c => c.path.startsWith('/v1/customers/search')));
});

test('adding a card checks the holder CPF and the card limit', async () => {
  const h = setup({
    customer: { mpCustomerId: 'cus1' },
    mp: { 'POST /v1/customers/cus1/cards': () => [201, mpCard()] }
  });
  await assert.rejects(h.cards.add(h.session(), { token: TOKEN, cpf: OTHER_CPF }), { code: 'cpf_titular_divergente' });
  await assert.rejects(h.cards.add(h.session(), { token: 'curto', cpf: CPF }), { code: 'token_cartao_invalido' });
  h.records.set('clientes/19999990000', { ...h.records.get('clientes/19999990000'), cartoesMp: Array.from({ length: MAX_CARDS }, (_, i) => ({ id: `c${i}` })) });
  await assert.rejects(h.cards.add(h.session(), { token: TOKEN, cpf: CPF }), { code: 'limite_cartoes' });
});

function payable(over = {}) {
  return setup({
    customer: { mpCustomerId: 'cus1', cartoesMp: [savedCard()] },
    mp: {
      'POST /v1/payments': body => [201, { id: 777, status: 'approved', status_detail: 'accredited', transaction_amount: body.transaction_amount }],
      ...over.mp
    },
    ride: over.ride
  });
}

test('paying with a saved card charges the server price, records the motoboy payout and closes the link', async () => {
  const h = payable();
  const result = await h.cards.payRide(h.session(), 'r1', { cardId: 'card9', cpf: CPF, token: TOKEN, valor: 1 }, { deviceSessionId: 'armor.abc123456' });
  assert.equal(result.aprovado, true);
  const pay = h.calls.find(c => c.path === '/v1/payments');
  assert.equal(pay.body.transaction_amount, 12, 'valor da corrida, nao o do pedido');
  assert.equal(pay.body.payer.id, 'cus1');
  assert.equal(pay.body.binary_mode, true);
  assert.equal(pay.body.metadata.payment_kind, 'ride_card_owner');
  assert.equal(pay.body.external_reference, 'r1');
  assert.ok(pay.headers['X-Idempotency-Key']);
  assert.equal(pay.headers['X-meli-session-id'], 'armor.abc123456');
  const ride = h.records.get('corridas/r1');
  assert.equal(ride.pagamento.status, 'approved');
  assert.equal(ride.pagamento.valido, true);
  assert.equal(ride.pagamento.receiver, 'motoja_owner');
  assert.equal(ride.pagamento.metodo, 'cartao_app');
  assert.equal(ride.pagamento.cartaoFinal, '4242');
  assert.equal(ride.pagamento.cartaoProcessandoAteMs, 0);
  const repasse = h.records.get('repassesMotoboy/r1');
  assert.equal(repasse.status, 'a_pagar');
  assert.equal(repasse.valor, 9);
  assert.equal(repasse.motoboyCpf, '12345678901');
  assert.equal(repasse.origem, 'cartao_app');
  assert.deepEqual(h.expired, ['r1']);
  await assert.rejects(h.cards.payRide(h.session(), 'r1', { cardId: 'card9', cpf: CPF, token: TOKEN }), { code: 'corrida_ja_paga' });
});

test('a declined card keeps the payment link working', async () => {
  const h = payable({ mp: { 'POST /v1/payments': () => [201, { id: 778, status: 'rejected', status_detail: 'cc_rejected_insufficient_amount', transaction_amount: 12 }] } });
  const result = await h.cards.payRide(h.session(), 'r1', { cardId: 'card9', cpf: CPF, token: TOKEN });
  assert.equal(result.aprovado, false);
  assert.match(result.message, /limite ou saldo/);
  const ride = h.records.get('corridas/r1');
  assert.equal(ride.pagamento.status, 'preference_created');
  assert.equal(ride.pagamento.initPoint, 'https://mp/link');
  assert.equal(ride.pagamento.cartaoUltimaRecusa.statusDetail, 'cc_rejected_insufficient_amount');
  assert.equal(ride.pagamento.cartaoProcessandoAteMs, 0);
  assert.equal(h.records.has('repassesMotoboy/r1'), false);
  assert.deepEqual(h.expired, []);
  // Pode tentar de novo (outra chave de idempotencia).
  await h.cards.payRide(h.session(), 'r1', { cardId: 'card9', cpf: CPF, token: TOKEN });
  const keys = h.calls.filter(c => c.path === '/v1/payments').map(c => c.headers['X-Idempotency-Key']);
  assert.equal(new Set(keys).size, 2);
});

test('wrong holder CPF is counted and locks the card after 5 tries', async () => {
  const h = payable();
  for (let i = 1; i < CPF_MAX_ERRORS; i += 1) {
    await assert.rejects(h.cards.payRide(h.session(), 'r1', { cardId: 'card9', cpf: OTHER_CPF, token: TOKEN }), { code: 'cpf_titular_errado' });
  }
  await assert.rejects(h.cards.payRide(h.session(), 'r1', { cardId: 'card9', cpf: OTHER_CPF, token: TOKEN }), { message: /30 minutos/ });
  await assert.rejects(h.cards.payRide(h.session(), 'r1', { cardId: 'card9', cpf: CPF, token: TOKEN }), { code: 'cartao_bloqueado' });
  assert.ok(!h.calls.some(c => c.path === '/v1/payments'), 'nenhuma cobranca com CPF errado');
  h.tick(31 * 60000);
  const ok = await h.cards.payRide(h.session(), 'r1', { cardId: 'card9', cpf: CPF, token: TOKEN });
  assert.equal(ok.aprovado, true);
  assert.equal(h.records.get('clientes/19999990000').cartaoCpfBloqueio.erros, 0);
});

test('only the account that asked can pay, only after a motoboy accepted, one charge at a time', async () => {
  const other = payable({ ride: { customerId: '19888887777' } });
  await assert.rejects(other.cards.payRide(other.session(), 'r1', { cardId: 'card9', cpf: CPF, token: TOKEN }), { code: 'corrida_de_outra_conta' });
  const pending = payable({ ride: { status: 'pendente' } });
  await assert.rejects(pending.cards.payRide(pending.session(), 'r1', { cardId: 'card9', cpf: CPF, token: TOKEN }), { code: 'corrida_sem_motoboy' });
  const busy = payable({ ride: { pagamento: { status: 'preference_created', cartaoProcessandoAteMs: Date.UTC(2026, 9, 26, 16) } } });
  await assert.rejects(busy.cards.payRide(busy.session(), 'r1', { cardId: 'card9', cpf: CPF, token: TOKEN }), { code: 'pagamento_em_andamento' });
  const missing = payable();
  await assert.rejects(missing.cards.payRide(missing.session(), 'r1', { cardId: 'nao-existe', cpf: CPF, token: TOKEN }), { code: 'cartao_nao_encontrado' });
  for (const h of [other, pending, busy, missing]) assert.ok(!h.calls.some(c => c.path === '/v1/payments'));
});

test('the card feature stays off until the public key is configured', async () => {
  const off = createCustomerCards({ db: {}, admin: {}, ownerToken: () => 'x', publicKey: () => '', hashSecret, safeEqual: () => true, validCpf: () => true });
  assert.deepEqual(off.config(), { ativo: false, publicKey: '' });
  await assert.rejects(off.add({ customer: {} }, {}), { code: 'cartao_desativado' });
});

test('motoboy payout follows approval and refunds', () => {
  const ride = { motoboyCpf: '123.456.789-01', motoboy: 'Joao', pagamento: { metodo: 'cartao_app' } };
  const paid = repasseUpdate(null, { rideId: 'r1', ride, payment: { id: 5, status: 'approved', transaction_amount: 12 }, valido: true, driverAmount: 9, now: 1 });
  assert.equal(paid.status, 'a_pagar');
  assert.equal(paid.valor, 9);
  assert.equal(repasseUpdate(paid, { rideId: 'r1', ride, payment: { id: 5, status: 'approved' }, valido: true, driverAmount: 9 }), null, 'nao duplica');
  assert.equal(repasseUpdate(null, { rideId: 'r1', ride, payment: { id: 5, status: 'approved' }, valido: false, driverAmount: 9 }), null, 'valor divergente nao gera repasse');
  assert.deepEqual(repasseUpdate(paid, { rideId: 'r1', ride, payment: { id: 5, status: 'refunded' }, now: 2 }), { status: 'estornado', estornadoEmMs: 2 });
  assert.deepEqual(repasseUpdate({ ...paid, status: 'pago' }, { rideId: 'r1', ride, payment: { id: 5, status: 'charged_back' }, now: 3 }), { estornoAposPagamento: true, estornadoEmMs: 3 });
  assert.equal(repasseUpdate(paid, { rideId: 'r1', ride, payment: { id: 6, status: 'refunded' } }), null, 'estorno de outro pagamento nao mexe');
});

test('the ride webhook keeps the first approved payment and books payouts for MotoJa-account payments', () => {
  const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const start = source.indexOf("const repasseRef = db.collection('repassesMotoboy').doc(rideId);");
  const end = source.indexOf("res.json({ ok: true });", start);
  assert.ok(start > 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /anterior\.paymentId !== String\(payment\.id\)/);
  assert.match(block, /pagamentosDuplicados/);
  assert.match(block, /paymentSource === 'owner' && pagamento\.receiver === 'motoja_owner'/);
  assert.match(block, /repasseUpdate\(/);
  assert.ok(block.indexOf('tx.get(repasseRef)') < block.indexOf('tx.set('), 'leituras antes das escritas');
});
