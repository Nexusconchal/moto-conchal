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
  const geocodes = [], notices = [], writes = [], reads = [], earnings = [];
  const ref = path => ({ path, id: path.split('/').at(-1), get: async () => snap(path) });
  const snap = path => ({ exists: records.has(path), data: () => records.get(path), ref: ref(path) });
  const db = { collection: name => ({ doc: id => ref(`${name}/${id || 'generated'}`) }), runTransaction: async fn => {
    const pending = [];
    await fn({ get: async r => { reads.push(r.path); return snap(r.path); }, set: (r, data) => pending.push([r, data]), update: (r, data) => pending.push([r, data]) });
    for (const [r, data] of pending) { writes.push(r.path); records.set(r.path, { ...records.get(r.path), ...data }); }
  }};
  const money = n => Math.round(Number(n || 0) * 100) / 100;
  const context = vm.createContext({ console, db, prepareQuickDelivery, quickDeliveryFare,
    cleanText: s => String(s || '').trim(), onlyDigits: s => String(s || '').replace(/\D/g, ''), normalizeText: s => String(s || '').toLowerCase(), money,
    admin: { firestore: { FieldValue: { serverTimestamp: () => Date.now(), delete: () => null } } },
    companyBalance: d => ({ saldo: d.saldo, reservado: d.reservado, disponivel: d.saldo - d.reservado }),
    ledgerRef: () => ref('ledger/event'), isPricedDeliveryType: t => !!t,
    bairroFromAddress: () => '',
    isFixedFoodDelivery: t => /lanche|farmacia|acai/i.test(t), isDailyPlanDelivery: t => String(t).toLowerCase() === 'plano diario motoja pro',
    todayKeySaoPaulo: () => '2026-10-04', dailyPlanRef: (phone, day) => ref(`plans/${phone}/${day}`),
    DAILY_PLAN_DELIVERY_FEE: 4, DAILY_PLAN_APP_FEE: 1,
    getDriverWithProof: async () => {}, timestampMs: Number,
    companyRefFromPhone: () => ref('empresas/company'),
    driverEarningEvent: (_kind, id, data) => ({ id, ganho: data.ganhoMotoboy }),
    recordDriverEarning: async (_tx, _cpf, event) => { earnings.push(event); },
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
  vm.runInContext(source.slice(source.indexOf('function fixedFoodDeliveryFare('), source.indexOf('function isPricedDeliveryType(')), context);
  vm.runInContext(source.slice(source.indexOf('function expectedDeliveryFare('), source.indexOf('function deliveryStopCount(')), context);
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
  const createHandler = context.handler;
  const finishStart = source.indexOf("app.post('/api/deliveries/:deliveryId/finish'");
  vm.runInContext(source.slice(finishStart,source.indexOf("\napp.post(",finishStart+1)),context);
  const finishHandler = context.handler;
  context.handler = createHandler;
  async function finish() {
    let result, failure;
    await finishHandler({ params: { deliveryId: 'quick-test' }, body: { driverCpf: '12345678901', confirmarLoteEntregue: true } }, { json: data => { result = data; } }, error => { failure = error; });
    if (failure) throw failure;
    return result;
  }
  return { call, finish, records, geocodes, notices, writes, reads, earnings, context };
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

const dailyRaw = () => ({ ...raw(), tipoEntrega: 'Plano Diario MotoJa Pro', valor: 0.01, planoDiario: true });
test('daily plan requires an active record for this company today and cannot be forged from the request', async () => {
  for (const scenario of ['missing', 'yesterday', 'other-company', 'inactive']) {
    const h = harness();
    if (scenario === 'yesterday') h.records.set('plans/11999999999/2026-10-03', { status: 'ativo' });
    if (scenario === 'other-company') h.records.set('plans/11888888888/2026-10-04', { status: 'ativo' });
    if (scenario === 'inactive') h.records.set('plans/11999999999/2026-10-04', { status: 'cancelado' });
    const result = await h.call(dailyRaw());
    assert.equal(result.status,403); assert.equal(h.writes.length,0); assert.equal(h.notices.length,0);
  }
});
test('active daily plan reserves R$ 4 per delivery across all regions without charging the R$ 70 activation again', async () => {
  for (const region of ['conchal','martinho_prado','tujuguaba','iate']) {
    const h = harness();
    h.records.set('plans/11999999999/2026-10-04', { status: 'ativo' });
    assert.equal((await h.call({ ...dailyRaw(), regiaoEntrega: region })).status,201);
    const d = h.records.get('entregas/quick-test');
    assert.equal(d.valor,12); assert.equal(d.planoDiarioDia,'2026-10-04');
    assert.equal(h.context.expectedDeliveryFare(0,3,d.tipoEntrega,d),12);
    assert.equal(h.context.deliverySplit(d).appFee,3);
    assert.equal(h.context.deliverySplit(d).driverAmount,9);
    assert.equal(h.records.get('empresas/company').saldo,100);
    assert.equal(h.records.get('empresas/company').reservado,12);
    assert.equal(h.reads.filter(p => p.startsWith('plans/')).length,1);
    assert.equal((await h.call({ ...dailyRaw(), regiaoEntrega: region })).data.duplicated,true);
    assert.equal(h.records.get('empresas/company').reservado,12);
  }
});
test('active daily plan does not permit insufficient balance', async () => {
  const h = harness(7);
  h.records.set('plans/11999999999/2026-10-04', { status: 'ativo' });
  assert.equal((await h.call(dailyRaw())).status,402);
  assert.equal(h.writes.length,0); assert.equal(h.notices.length,0);
});
test('finalization debits standard R$ 6.50 and daily R$ 4 batches exactly once and pays the matching driver share', async () => {
  for (const daily of [false,true]) {
    const h = harness();
    if (daily) h.records.set('plans/11999999999/2026-10-04', { status: 'ativo' });
    await h.call(daily ? dailyRaw() : raw());
    const d = h.records.get('entregas/quick-test');
    Object.assign(d,{ status:'retirada', motoboyCpf:'12345678901', retiradaConfirmadaEm:Date.now()-60000, motoboyLocalizacao:{serverTimestampMs:Date.now()} });
    await h.finish();
    assert.equal(h.records.get('empresas/company').saldo,daily ? 88 : 80.5);
    assert.equal(h.records.get('empresas/company').reservado,0);
    assert.equal(h.earnings[0].ganho,daily ? 9 : 15);
    const writeCount = h.writes.length;
    await assert.rejects(h.finish());
    assert.equal(h.writes.length,writeCount); assert.equal(h.earnings.length,1);
  }
});

test('daily batch renewals cannot use yesterday, revoked or another company plan', async () => {
  const reads = [];
  let active = true;
  const ctx = vm.createContext({ todayKeySaoPaulo: () => '2026-10-04', isDailyPlanDelivery: t => t === 'Plano Diario MotoJa Pro', dailyPlanRef: (phone, day) => `${phone}/${day}` });
  vm.runInContext(source.slice(source.indexOf('async function assertQuickDailyPlanRenewable('), source.indexOf('function isFixedFoodDelivery(')),ctx);
  const tx = { get: async ref => { reads.push(ref); return { exists:active, data:() => ({status:'ativo'}) }; } };
  const d = { ...dailyRaw(), planoDiarioDia:'2026-10-04' };
  await ctx.assertQuickDailyPlanRenewable(tx,d,'11999999999');
  assert.deepEqual(reads,['11999999999/2026-10-04']);
  await assert.rejects(ctx.assertQuickDailyPlanRenewable(tx,{...d,planoDiarioDia:'2026-10-03'},'11999999999'),/venceu/);
  active = false;
  await assert.rejects(ctx.assertQuickDailyPlanRenewable(tx,d,'11999999999'),/nao esta ativo/);
});

test('company summary enables R$ 4 only for active daily plans and driver display uses the same R$ 1 fee', () => {
  const html = fs.readFileSync(new URL('../../empresa.html',import.meta.url),'utf8');
  const fields = { quantidadeLote:{value:'3'},tipoEntrega:{value:'Plano Diario MotoJa Pro'},regiaoLote:{value:'martinho_prado'},resumoLote:{},chamarLote:{} };
  const ctx = vm.createContext({ $:id => fields[id], tipoPlanoDiario:t => t === 'Plano Diario MotoJa Pro', comidaFixa:t => /lanche|acai|farmacia/i.test(t), planoDiarioAtivo:false, enviando:false, moeda:n => n.toFixed(2) });
  vm.runInContext(html.slice(html.indexOf('function tipoLotePermitido('),html.indexOf('function selecionarModoEntrega(')),ctx);
  ctx.atualizarResumoLote(); assert.equal(fields.chamarLote.disabled,true);
  ctx.planoDiarioAtivo = true; ctx.atualizarResumoLote();
  assert.equal(fields.chamarLote.disabled,false); assert.match(fields.resumoLote.textContent,/4\.00 = 12\.00/);
  for (const type of ['Encomendas','Roupa / tenis / acessorio','Outro']) { fields.tipoEntrega.value=type; ctx.atualizarResumoLote(); assert.equal(fields.chamarLote.disabled,true); }
  const driver = fs.readFileSync(new URL('../../motoboy.html',import.meta.url),'utf8');
  const dctx = vm.createContext({ dinheiro:Number, planoDiario:c => c.tipoEntrega === 'Plano Diario MotoJa Pro', servicoExclusivo:() => false });
  vm.runInContext(driver.slice(driver.indexOf('function appValorEntrega('),driver.indexOf('function appPercent(')),dctx);
  assert.equal(dctx.appValorEntrega({...dailyRaw(),valor:12}),3);
  assert.equal(dctx.appValorEntrega({...raw(),valor:19.5}),4.5);
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
