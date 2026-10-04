import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { prepareQuickDelivery, quickDeliveryFare } from '../src/quick-delivery.js';

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const company = { empresa: 'Loja de teste', responsavel: 'Responsavel', retirada: 'Rua da Loja, 100, Conchal', saldo: 100, reservado: 0 };
const raw = () => ({ entregaNaNota: true, regiaoEntrega: 'conchal', paradas: 3, tipoEntrega: 'Lanche / pizza / pastel / marmita', clientRequestId: 'quick-test' });
test('all batch destinations use the selected region tariff and fee, with no invented GPS or customer data', () => {
  for (const region of ['conchal', 'martinho_prado', 'tujuguaba', 'iate']) {
    const d = { ...raw(), regiaoEntrega: region, entrega: 'old address', observacao: 'old note', valor: 0.01 };
    prepareQuickDelivery(d, 3, company, true);
    assert.equal(d.valor, region === 'conchal' ? 19.5 : 48);
    assert.equal(quickDeliveryFare(d, true), region === 'conchal' ? 4.5 : 6);
    assert.equal(d.entregaLat, null); assert.equal(d.entregaLon, null);
    assert.equal(d.observacao, ''); assert.equal(d.retirada, company.retirada);
    assert.deepEqual(d.pontosExtras, []); assert.equal(d.dadosNaNota, true);
  }
});
test('invalid quantities, regions, distance fares, forged daily types and integration shortcuts are rejected', () => {
  for (const count of [0, -1, 31, 1.5, NaN, undefined]) assert.throws(() => prepareQuickDelivery(raw(), count, company, true));
  for (const d of [{ ...raw(), regiaoEntrega: 'other' }, { ...raw(), regiaoEntrega: 'constructor' }, { ...raw(), regiaoEntrega: '__proto__' }, { ...raw(), tipoEntrega: 'Encomendas' }, { ...raw(), tipoEntrega: 'Plano Diario MotoJa Pro lanche' }, { ...raw(), integracaoPedidoId: '123' }]) assert.throws(() => prepareQuickDelivery(d, 3, company, true));
});

function harness(balance = 100) {
  const records = new Map([['empresas/company', { ...company, saldo: balance }]]);
  const geocodes = [], notices = [], writes = [];
  const ref = path => ({ path, id: path.split('/').at(-1), get: async () => snap(path) });
  const snap = path => ({ exists: records.has(path), data: () => records.get(path), ref: ref(path) });
  const db = { collection: name => ({ doc: id => ref(`${name}/${id || 'generated'}`) }), runTransaction: async fn => {
    const pending = [];
    await fn({ get: async r => snap(r.path), set: (r, data) => pending.push([r, data]) });
    for (const [r, data] of pending) { writes.push(r.path); records.set(r.path, { ...records.get(r.path), ...data }); }
  }};
  const money = n => Math.round(Number(n || 0) * 100) / 100;
  const context = vm.createContext({ console, db, prepareQuickDelivery, quickDeliveryFare,
    cleanText: s => String(s || '').trim(), onlyDigits: s => String(s || '').replace(/\D/g, ''), normalizeText: s => String(s || '').toLowerCase(), money,
    admin: { firestore: { FieldValue: { serverTimestamp: () => Date.now() } } },
    companyBalance: d => ({ saldo: d.saldo, reservado: d.reservado, disponivel: d.saldo - d.reservado }),
    ledgerRef: () => ref('ledger/event'), isPricedDeliveryType: t => !!t,
    bairroFromAddress: () => '',
    isFixedFoodDelivery: t => /lanche|farmacia|acai/i.test(t), isDailyPlanDelivery: () => false,
    geocodeCapturedAddress: async text => { geocodes.push(text); return { lat: -22.3, lon: -47.1, text }; },
    findRecentDuplicateDelivery: async () => '',
    notifyTelegramAboutDelivery: async id => { notices.push(id); return { sent: true }; },
    notifyDriversAboutDelivery: async () => ({ sent: 1 }), emitDeliveryTracking: () => {},
    assertCompany: () => {}, assertCompanyApproved: () => {}, createRideLimiter: () => {},
    app: { post: (_path, ...handlers) => { context.handler = handlers.at(-1); } }
  });
  for (const [start, end] of [['deliveryStopCount', 'validCoordinate'], ['deliveryPublicData', 'notifyTelegramAboutRide']]) {
    vm.runInContext(source.slice(source.indexOf(`function ${start}(`), source.indexOf(`${end === 'notifyTelegramAboutRide' ? 'async ' : ''}function ${end}(`)), context);
  }
  const start = source.indexOf("app.post('/api/deliveries',");
  const end = source.indexOf("\napp.post(", start + 1);
  vm.runInContext(source.slice(start, end), context);
  async function call(body = raw()) {
    let result = { status: 200 }, failure;
    const res = { status: code => { result.status = code; return res; }, json: data => { result.data = data; return res; } };
    await context.handler({ body, companyId: '11999999999', company, companySnap: { ref: ref('empresas/company') } }, res, error => { failure = error; });
    if (failure) throw failure;
    return result;
  }
  return { call, records, geocodes, notices, writes };
}
test('actual delivery route creates one batch, reserves 3 fares once, geocodes only pickup and retries safely', async () => {
  const h = harness();
  assert.equal((await h.call()).status, 201);
  assert.equal(h.records.get('empresas/company').reservado, 19.5);
  assert.equal(h.records.get('entregas/quick-test').paradas, 3);
  assert.equal(h.records.get('entregas/quick-test').entregaLat, null);
  assert.deepEqual(h.geocodes, [company.retirada]);
  assert.equal((await h.call()).data.duplicated, true);
  assert.equal(h.records.get('empresas/company').reservado, 19.5);
  assert.equal(h.notices.length, 1);
  assert.equal(h.writes.filter(p => p.startsWith('entregas/')).length, 1);
});
test('insufficient balance and invalid batch leave no reservation, job or notification', async () => {
  const h = harness(7);
  assert.equal((await h.call()).status, 402);
  assert.equal(h.writes.length, 0); assert.equal(h.notices.length, 0);
  await assert.rejects(h.call({ ...raw(), paradas: 31 }), /chamada sem endereco/);
  assert.equal(h.writes.length, 0);
});

test('tampered price and pickup are replaced by server data; another company cannot reuse an existing request id', async () => {
  const h = harness();
  await h.call({ ...raw(), valor: 0.01, retirada: 'fake pickup', entregaLat: 1, entregaLon: 1 });
  assert.equal(h.records.get('entregas/quick-test').valor, 19.5);
  assert.equal(h.records.get('entregas/quick-test').retirada, company.retirada);
  h.records.set('entregas/other', { ...h.records.get('entregas/quick-test'), telefoneEmpresa: '11888888888' });
  await assert.rejects(h.call({ ...raw(), clientRequestId: 'other' }), /outro pedido/);
  await assert.rejects(h.call({ ...raw(), paradas: 4 }), /outro pedido/);
  assert.equal(h.records.get('empresas/company').reservado, 19.5);
  assert.equal(h.notices.length, 1);
});

test('batch finish needs explicit whole-lot confirmation, pickup and fresh GPS; addressed delivery still needs destination proximity', () => {
  const start = source.indexOf('      if (!exclusiveService) {', source.indexOf("app.post('/api/deliveries/:deliveryId/finish'"));
  const end = source.indexOf('      const valor =', start);
  const context = vm.createContext({ timestampMs: Number, coordinateDistanceKm: () => 100 });
  vm.runInContext(`function validate(delivery, req) { const exclusiveService = false; ${source.slice(start, end)} }`, context);
  const d = { entregaNaNota: true, retiradaConfirmadaEm: Date.now() - 60000, motoboyLocalizacao: { serverTimestampMs: Date.now() } };
  assert.throws(() => context.validate(d, { body: {} }), /todas as entregas/);
  assert.doesNotThrow(() => context.validate(d, { body: { confirmarLoteEntregue: true } }));
  assert.throws(() => context.validate({ ...d, retiradaConfirmadaEm: 0 }, { body: { confirmarLoteEntregue: true } }), /retirada/);
  assert.throws(() => context.validate({ ...d, motoboyLocalizacao: {} }, { body: { confirmarLoteEntregue: true } }), /localizacao/);
  assert.throws(() => context.validate({ ...d, entregaNaNota: false }, { body: {} }), /mais perto/);
});

test('finish authorization still rejects another driver, a cancelled batch and repeated debit', () => {
  const route = source.indexOf("app.post('/api/deliveries/:deliveryId/finish'");
  const start = source.indexOf('      const delivery = deliverySnap.data();', route);
  const end = source.indexOf('      if (!exclusiveService) {', start);
  const ctx = vm.createContext({ onlyDigits: s => String(s || '').replace(/\D/g, '') });
  vm.runInContext(`function validate(data) { const driverCpf = '12345678901', deliverySnap = {data: () => data}; ${source.slice(start,end)} }`, ctx);
  const batch = { entregaNaNota: true, status: 'retirada', motoboyCpf: '12345678901' };
  assert.doesNotThrow(() => ctx.validate(batch));
  assert.throws(() => ctx.validate({ ...batch, motoboyCpf: '99999999999' }), /nao pertence/);
  assert.throws(() => ctx.validate({ ...batch, status: 'cancelada' }), /cancelada/);
  assert.throws(() => ctx.validate({ ...batch, status: 'aceita' }), /retirada/);
  assert.throws(() => ctx.validate({ ...batch, saldoDebitadoEm: Date.now() }), /debitada/);
});

test('switching modes hides address and notes, preserves the regular flow, and cannot switch during sending', () => {
  const html = fs.readFileSync(new URL('../../empresa.html', import.meta.url), 'utf8');
  const elements = new Map();
  const el = id => { if (!elements.has(id)) elements.set(id, { value: id === 'paradas' ? '1' : '', style: {}, parentElement: { style: {} }, setAttribute() {} }); return elements.get(id); };
  const ctx = vm.createContext({ $: el, resultadoBox: el('resultado'), modoChamadaSemEndereco: false, enviando: false,
    atualizarResumoLote() {}, quantidadePontos: () => 1, carregarPedidosPreparados() {}, mostrarDetalhesEntrega: visible => el('detalhesEntrega').style.display = visible ? 'grid' : 'none' });
  for (const [start,end] of [['atualizarCampoExtras','limparEnderecoExtra'],['selecionarModoEntrega',null]]) {
    const a = html.indexOf(`function ${start}(`), b = end ? html.indexOf(`function ${end}(`,a) : html.indexOf('$("modoComEndereco").onclick',a);
    vm.runInContext(html.slice(a,b),ctx);
  }
  ctx.selecionarModoEntrega(true);
  for (const id of ['campoEntregaPrincipal','detalhesEntrega','toggleDetalhesEntrega','campoEnderecosExtras']) assert.equal(el(id).style.display,'none');
  assert.equal(el('chamadaSemEndereco').style.display,'grid');
  ctx.enviando = true; ctx.selecionarModoEntrega(false); assert.equal(ctx.modoChamadaSemEndereco,true);
  ctx.enviando = false; ctx.selecionarModoEntrega(false);
  assert.equal(el('campoEntregaPrincipal').style.display,'grid');
  assert.equal(el('chamadaSemEndereco').style.display,'none');
  assert.equal(el('calcular').style.display,'block');
});
