import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { prepareQuickDelivery, quickDeliveryFare, planFare } from '../src/quick-delivery.js';
import { protectedDelivery, assertCompanyDelivery } from '../src/delivery-completion.js';

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
    const result = await fn({ get: async r => { reads.push(r.path); return snap(r.path); }, set: (r, data) => pending.push([r, data]), update: (r, data) => pending.push([r, data]) });
    for (const [r, data] of pending) { writes.push(r.path); records.set(r.path, { ...records.get(r.path), ...data }); }
    return result;
  }};
  const money = n => Math.round(Number(n || 0) * 100) / 100;
  const context = vm.createContext({ console, db, prepareQuickDelivery, quickDeliveryFare, planFare, isSpecialFoodDestination: t => /martinho\s*prado|tujuguaba|iate/i.test(t), protectedDelivery, assertCompanyDelivery,
    cleanText: s => String(s || '').trim(), onlyDigits: s => String(s || '').replace(/\D/g, ''), normalizeText: s => String(s || '').toLowerCase(), money,
    admin: { firestore: { FieldValue: { serverTimestamp: () => Date.now(), delete: () => null } } },
    companyBalance: d => ({ saldo: d.saldo, reservado: d.reservado, disponivel: d.saldo - d.reservado }),
    ledgerRef: () => ref('ledger/event'), isPricedDeliveryType: t => !!t,
    bairroFromAddress: () => '',
    isFixedFoodDelivery: t => /lanche|farmacia|acai/i.test(t), isDailyPlanDelivery: t => String(t).toLowerCase() === 'plano diario motoja pro',
    isHalfPlanDelivery: t => String(t).toLowerCase() .includes('meio periodo motoja'), halfPlanActiveUntil: (c = {}) => Number(c.meioPeriodoExpiraEmMs || 0) > Date.now() ? Number(c.meioPeriodoExpiraEmMs) : 0, halfPlanInactiveError: (m = 'Meio Periodo inativo') => Object.assign(new Error(m), { status: 403, code: 'plano_diario_inativo' }), HALF_PLAN_DELIVERY_FEE: 5.5, HALF_PLAN_APP_FEE: 1.5,
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
  vm.runInContext(source.slice(source.indexOf('function deliveryDestinations('), source.indexOf('function isPricedDeliveryType(')), context);
  vm.runInContext(source.slice(source.indexOf('const TAXA_AVULSA_LIMITE'), source.indexOf('function halfPlanInactiveError(')), context);
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
  const finishFunctionStart = source.indexOf('async function finishCompanyDelivery(');
  vm.runInContext(source.slice(finishFunctionStart, source.indexOf("app.post('/api/deliveries/:deliveryId/finish'",finishFunctionStart)),context);
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
test('active daily plan reserves R$ 4 in Conchal and R$ 10 in districts without charging the R$ 70 activation again', async () => {
  for (const region of ['conchal','martinho_prado','tujuguaba','iate']) {
    const h = harness();
    const district = region !== 'conchal', total = district ? 30 : 12, app = district ? 6 : 3;
    h.records.set('plans/11999999999/2026-10-04', { status: 'ativo' });
    assert.equal((await h.call({ ...dailyRaw(), regiaoEntrega: region })).status,201);
    const d = h.records.get('entregas/quick-test');
    assert.equal(d.valor,total); assert.equal(d.planoDiarioDia,'2026-10-04');
    assert.equal(h.context.expectedDeliveryFare(0,3,d.tipoEntrega,d),total);
    assert.equal(h.context.deliverySplit(d).appFee,app);
    assert.equal(h.context.deliverySplit(d).driverAmount,total - app);
    assert.equal(h.records.get('empresas/company').saldo,100);
    assert.equal(h.records.get('empresas/company').reservado,total);
    assert.equal(h.reads.filter(p => p.startsWith('plans/')).length,1);
    assert.equal((await h.call({ ...dailyRaw(), regiaoEntrega: region })).data.duplicated,true);
    assert.equal(h.records.get('empresas/company').reservado,total);
  }
});
test('active daily plan does not permit insufficient balance', async () => {
  const h = harness(7);
  h.records.set('plans/11999999999/2026-10-04', { status: 'ativo' });
  assert.equal((await h.call(dailyRaw())).status,402);
  assert.equal(h.writes.length,0); assert.equal(h.notices.length,0);
});
test('legacy finalization debits standard R$ 6.50 and daily R$ 4 batches exactly once and pays the matching driver share', async () => {
  for (const daily of [false,true]) {
    const h = harness();
    if (daily) h.records.set('plans/11999999999/2026-10-04', { status: 'ativo' });
    await h.call(daily ? dailyRaw() : raw());
    const d = h.records.get('entregas/quick-test');
    Object.assign(d,{ confirmacaoEmpresaVersao:0, status:'retirada', motoboyCpf:'12345678901', retiradaConfirmadaEm:Date.now()-60000, motoboyLocalizacao:{serverTimestampMs:Date.now()} });
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
  const ctx = vm.createContext({ todayKeySaoPaulo: () => '2026-10-04', isDailyPlanDelivery: t => t === 'Plano Diario MotoJa Pro', isHalfPlanDelivery: t => t === 'Plano Meio Periodo MotoJa', halfPlanInactiveError: m => Object.assign(new Error(m), { status: 403 }), dailyPlanRef: (phone, day) => `${phone}/${day}` });
  vm.runInContext(source.slice(source.indexOf('async function assertQuickDailyPlanRenewable('), source.indexOf('function isFixedFoodDelivery(')),ctx);
  const tx = { get: async ref => { reads.push(ref); return { exists:active, data:() => ({status:'ativo'}) }; } };
  const d = { ...dailyRaw(), planoDiarioDia:'2026-10-04' };
  await ctx.assertQuickDailyPlanRenewable(tx,d,'11999999999');
  assert.deepEqual(reads,['11999999999/2026-10-04']);
  await assert.rejects(ctx.assertQuickDailyPlanRenewable(tx,{...d,planoDiarioDia:'2026-10-03'},'11999999999'),/venceu/);
  active = false;
  await assert.rejects(ctx.assertQuickDailyPlanRenewable(tx,d,'11999999999'),/nao esta ativo/);
});

test('company summary enables the daily plan (R$ 10 in districts) only when active and driver display uses the same R$ 1 fee', () => {
  const html = fs.readFileSync(new URL('../../empresa.html',import.meta.url),'utf8');
  const fields = { quantidadeLote:{value:'3'},tipoEntrega:{value:'Plano Diario MotoJa Pro'},regiaoLote:{value:'martinho_prado'},resumoLote:{},chamarLote:{} };
  const ctx = vm.createContext({ $:id => fields[id], tipoPlanoDiario:t => t === 'Plano Diario MotoJa Pro', tipoMeioPeriodo:t => t === 'Plano Meio Periodo MotoJa', meioPeriodoAtivo:false, taxaAvulsaLiberada:() => true, mensagemTaxaAvulsa:() => '', comidaFixa:t => /lanche|acai|farmacia/i.test(t), planoDiarioAtivo:false, enviando:false, moeda:n => n.toFixed(2) });
  vm.runInContext(html.slice(html.indexOf('function tipoLotePermitido('),html.indexOf('function selecionarModoEntrega(')),ctx);
  ctx.atualizarResumoLote(); assert.equal(fields.chamarLote.disabled,true);
  ctx.planoDiarioAtivo = true; ctx.atualizarResumoLote();
  assert.equal(fields.chamarLote.disabled,false); assert.match(fields.resumoLote.textContent,/10\.00 = 30\.00/);
  for (const type of ['Encomendas','Roupa / tenis / acessorio','Outro']) { fields.tipoEntrega.value=type; ctx.atualizarResumoLote(); assert.equal(fields.chamarLote.disabled,true); }
  const driver = fs.readFileSync(new URL('../../motoboy.html',import.meta.url),'utf8');
  const dctx = vm.createContext({ dinheiro:Number, planoDiario:c => c.tipoEntrega === 'Plano Diario MotoJa Pro', servicoExclusivo:() => false });
  vm.runInContext(driver.slice(driver.indexOf('function appValorEntrega('),driver.indexOf('function appPercent(')),dctx);
  assert.equal(dctx.appValorEntrega({...dailyRaw(),valor:12}),3);
  assert.equal(dctx.appValorEntrega({...raw(),valor:19.5}),4.5);
});

test('batch finish needs explicit whole-lot confirmation, pickup and fresh GPS; addressed delivery still needs destination proximity', () => {
  const start = source.indexOf('      if (!exclusiveService && !approvalCompanyId) {', source.indexOf('async function finishCompanyDelivery('));
  const end = source.indexOf('      if (protectedDelivery(delivery)', start);
  const context = vm.createContext({ timestampMs: Number, coordinateDistanceKm: () => 100 });
  vm.runInContext(`function validate(delivery, req) { const exclusiveService = false, approvalCompanyId = '', body = req.body; ${source.slice(start, end)} }`, context);
  const d = { entregaNaNota: true, retiradaConfirmadaEm: Date.now() - 60000, motoboyLocalizacao: { serverTimestampMs: Date.now() } };
  assert.throws(() => context.validate(d, { body: {} }), /todas as entregas/);
  assert.doesNotThrow(() => context.validate(d, { body: { confirmarLoteEntregue: true } }));
  assert.throws(() => context.validate({ ...d, retiradaConfirmadaEm: 0 }, { body: { confirmarLoteEntregue: true } }), /retirada/);
  assert.throws(() => context.validate({ ...d, motoboyLocalizacao: {} }, { body: { confirmarLoteEntregue: true } }), /localizacao/);
  assert.throws(() => context.validate({ ...d, entregaNaNota: false }, { body: {} }), /mais perto/);
});

test('finish authorization still rejects another driver, a cancelled batch and repeated debit', () => {
  const route = source.indexOf('async function finishCompanyDelivery(');
  const start = source.indexOf('      const delivery = deliverySnap.data();', route);
  const end = source.indexOf('      if (!exclusiveService && !approvalCompanyId) {', start);
  const ctx = vm.createContext({ protectedDelivery, assertCompanyDelivery, onlyDigits: s => String(s || '').replace(/\D/g, '') });
  vm.runInContext(`function validate(data) { const approvalCompanyId = '', driverCpf = '12345678901', deliverySnap = {data: () => data}; ${source.slice(start,end)} }`, ctx);
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

const halfRaw = () => ({ ...raw(), tipoEntrega: 'Plano Meio Periodo MotoJa', valor: 0.01, meioPeriodo: true, meioPeriodoExpiraEmMs: Date.now() + 9e9 });
test('half period plan is blocked until activated, expired activations do not count and the request cannot forge it', async () => {
  for (const expira of [undefined, Date.now() - 1000]) {
    const h = harness();
    if (expira) h.records.set('empresas/company', { ...h.records.get('empresas/company'), meioPeriodoExpiraEmMs: expira });
    const result = await h.call(halfRaw());
    assert.equal(result.status, 403); assert.equal(h.writes.length, 0); assert.equal(h.notices.length, 0);
  }
});
test('active half period reserves R$ 5,50 in Conchal (R$ 1,50 app / R$ 4,00 driver) and R$ 12 in districts (R$ 2 app / R$ 10 driver)', async () => {
  for (const region of ['conchal','martinho_prado','tujuguaba','iate']) {
    const h = harness();
    const district = region !== 'conchal', total = district ? 36 : 16.5, app = district ? 6 : 4.5;
    const until = Date.now() + 3600000;
    h.records.set('empresas/company', { ...h.records.get('empresas/company'), meioPeriodoExpiraEmMs: until, meioPeriodoAtivacaoId: 'act-1' });
    assert.equal((await h.call({ ...halfRaw(), regiaoEntrega: region })).status, 201);
    const d = h.records.get('entregas/quick-test');
    assert.equal(d.valor, total); assert.equal(d.meioPeriodoExpiraEmMs, until); assert.equal(d.meioPeriodoAtivacaoId, 'act-1');
    assert.equal(h.context.expectedDeliveryFare(0, 3, d.tipoEntrega, d), total);
    assert.equal(h.context.deliverySplit(d).appFee, app);
    assert.equal(h.context.deliverySplit(d).driverAmount, total - app);
    assert.equal(h.records.get('empresas/company').saldo, 100);
    assert.equal(h.records.get('empresas/company').reservado, total);
  }
});
test('half period batch finalization debits R$ 5,50 per delivery and pays the driver R$ 4,00 each', async () => {
  const h = harness();
  h.records.set('empresas/company', { ...h.records.get('empresas/company'), meioPeriodoExpiraEmMs: Date.now() + 3600000 });
  await h.call(halfRaw());
  const d = h.records.get('entregas/quick-test');
  Object.assign(d,{ confirmacaoEmpresaVersao:0, status:'retirada', motoboyCpf:'12345678901', retiradaConfirmadaEm:Date.now()-60000, motoboyLocalizacao:{serverTimestampMs:Date.now()} });
  await h.finish();
  assert.equal(h.records.get('empresas/company').saldo, 83.5);
  assert.equal(h.records.get('empresas/company').reservado, 0);
  assert.equal(h.earnings[0].ganho, 12);
});
test('half period batch renewals stop after the 6 hours expire', async () => {
  const ctx = vm.createContext({ todayKeySaoPaulo: () => '2026-10-04', isDailyPlanDelivery: () => false, isHalfPlanDelivery: t => t === 'Plano Meio Periodo MotoJa', halfPlanInactiveError: m => Object.assign(new Error(m), { status: 403 }), dailyPlanRef: () => '' });
  vm.runInContext(source.slice(source.indexOf('async function assertQuickDailyPlanRenewable('), source.indexOf('function isFixedFoodDelivery(')),ctx);
  const tx = { get: async () => { throw new Error('no read expected'); } };
  await ctx.assertQuickDailyPlanRenewable(tx, { ...halfRaw(), meioPeriodoExpiraEmMs: Date.now() + 1000 }, '11999999999');
  await assert.rejects(ctx.assertQuickDailyPlanRenewable(tx, { ...halfRaw(), meioPeriodoExpiraEmMs: Date.now() - 1 }, '11999999999'), /venceu/);
});
test('half period activation debits R$ 25 once, lasts 6 hours and refuses insufficient balance', async () => {
  const docs = new Map();
  const ref = path => ({ path, id: path.split('/').at(-1), collection: name => ({ doc: id => ref(`${path}/${name}/${id}`) }) });
  const ctx = vm.createContext({ Date, money: n => Math.round(Number(n || 0) * 100) / 100,
    todayKeySaoPaulo: () => '2026-10-04', companyBalance: d => ({ saldo: d.saldo || 0, reservado: d.reservado || 0, disponivel: (d.saldo || 0) - (d.reservado || 0) }),
    ledgerRef: () => ref(`ledger/${docs.size}`), admin: { firestore: { FieldValue: { serverTimestamp: () => 'TIME' } } },
    db: { runTransaction: async fn => { const pending = []; await fn({ get: async r => ({ exists: docs.has(r.path), data: () => docs.get(r.path) }), set: (r, data, opt) => pending.push([r, data, opt]) }); for (const [r, data, opt] of pending) docs.set(r.path, opt?.merge ? { ...docs.get(r.path), ...data } : data); } },
    assertCompany: 0, assertCompanyApproved: 0, createRideLimiter: 0, app: { post: (_p, ...h) => { ctx.handler = h.at(-1); } } });
  for (const name of ['HALF_PLAN_TYPE', 'HALF_PLAN_PRICE', 'HALF_PLAN_DELIVERY_FEE', 'HALF_PLAN_APP_FEE', 'HALF_PLAN_DURATION_MS']) {
    const line = source.split('\n').find(l => l.startsWith(`const ${name} =`)); vm.runInContext(line.replace('const ', 'var '), ctx);
  }
  vm.runInContext(source.slice(source.indexOf('function halfPlanActiveUntil('), source.indexOf('function halfPlanInactiveError(')), ctx);
  const start = source.indexOf("app.post('/api/companies/half-plan/activate'");
  vm.runInContext(source.slice(start, source.indexOf('\napp.post(', start + 1)), ctx);
  const call = async () => { const out = {}; const res = { status: c => { out.status = c; return res; }, json: d => { out.data = d; return res; } };
    let failure; await ctx.handler({ companyId: 'c1', companySnap: { ref: ref('empresas/c1') } }, res, e => { failure = e; }); if (failure) throw failure; return out; };
  docs.set('empresas/c1', { saldo: 20, reservado: 0 });
  assert.equal((await call()).status, 402);
  assert.equal(docs.get('empresas/c1').saldo, 20);
  docs.set('empresas/c1', { saldo: 100, reservado: 10 });
  const before = Date.now();
  const first = await call();
  assert.equal(first.data.active, true); assert.equal(docs.get('empresas/c1').saldo, 75);
  assert.ok(first.data.expiraEmMs >= before + 6 * 3600000 && first.data.expiraEmMs <= Date.now() + 6 * 3600000);
  const second = await call();
  assert.equal(second.data.alreadyActive, true); assert.equal(docs.get('empresas/c1').saldo, 75);
  docs.set('empresas/c1', { ...docs.get('empresas/c1'), meioPeriodoExpiraEmMs: Date.now() - 1 });
  await call();
  assert.equal(docs.get('empresas/c1').saldo, 50);
  assert.equal([...docs.values()].filter(d => d.origem === 'meio_periodo_motoja_ativado').length, 2);
});
test('driver app shows R$ 1,50 app fee for half period deliveries', () => {
  const driver = fs.readFileSync(new URL('../../motoboy.html',import.meta.url),'utf8');
  const dctx = vm.createContext({ dinheiro:Number, planoDiario:c => c.tipoEntrega === 'Plano Diario MotoJa Pro', servicoExclusivo:() => false });
  vm.runInContext(driver.slice(driver.indexOf('function appValorEntrega('),driver.indexOf('function appPercent(')),dctx);
  assert.equal(dctx.appValorEntrega({ ...halfRaw(), valor: 16.5 }), 4.5);
  assert.equal(dctx.appValorEntrega({ tipoEntrega: 'Plano Meio Periodo MotoJa', paradas: 1, valor: 5.5 }), 1.5);
});
test('old half period name from a cached app still prices as Plano Meio Periodo', () => {
  const d = { ...raw(), tipoEntrega: 'Meio Periodo MotoJa' };
  prepareQuickDelivery(d, 2, company, false);
  assert.equal(d.tipoEntrega, 'Plano Meio Periodo MotoJa'); assert.equal(d.valor, 11);
  assert.equal(quickDeliveryFare(d, true), 3);
});

test('plans with addresses charge per stop: Conchal stops at the plan rate and district stops at the district rate', () => {
  const h = harness();
  const route = { entrega: 'Rua A, 10, Conchal', pontosExtras: [{ digitado: 'Rua B, 5, Martinho Prado' }, { digitado: 'Rua C, 1, Tujuguaba' }] };
  assert.equal(h.context.expectedDeliveryFare(12, 3, 'Plano Meio Periodo MotoJa', route), 29.5);
  assert.equal(h.context.expectedDeliveryFare(12, 3, 'Plano Diario MotoJa Pro', route), 24);
  assert.equal(h.context.planDeliveryAmounts({ ...route, paradas: 3, tipoEntrega: 'Plano Meio Periodo MotoJa' }).appFee, 5.5);
  assert.equal(h.context.planDeliveryAmounts({ ...route, paradas: 3, tipoEntrega: 'Plano Diario MotoJa Pro' }).appFee, 5);
  const split = h.context.deliverySplit({ tipoEntrega: 'Plano Meio Periodo MotoJa', paradas: 3, valor: 29.5, planoAppFee: 5.5 });
  assert.equal(split.driverAmount, 24);
});
test('plan deliveries created before the district table keep their original split', () => {
  const h = harness();
  assert.equal(h.context.deliverySplit({ tipoEntrega: 'Plano Diario MotoJa Pro', paradas: 3, valor: 12, regiaoEntrega: 'iate', entregaNaNota: true }).driverAmount, 9);
  assert.equal(h.context.deliverySplit({ tipoEntrega: 'Plano Meio Periodo MotoJa', paradas: 2, valor: 11 }).driverAmount, 8);
});

test('company app prices plan batches and routes with the district rates; driver and owner use the recorded app fee', () => {
  const html = fs.readFileSync(new URL('../../empresa.html',import.meta.url),'utf8');
  const ctx = vm.createContext({ tipoPlanoDiario: t => t === 'Plano Diario MotoJa Pro', tipoMeioPeriodo: t => t === 'Plano Meio Periodo MotoJa', destinoComidaEspecial: t => /martinho|tujuguaba|iate/i.test(t), comidaFixa: () => false, moeda: n => n.toFixed(2), ENTREGA_EMPRESA_VALOR_KM: 2.5 });
  vm.runInContext(html.slice(html.indexOf('function precoEntrega('), html.indexOf('function quantidadePontos(')), ctx);
  vm.runInContext(html.slice(html.indexOf('function tarifaLote('), html.indexOf('function atualizarResumoLote(')), ctx);
  const pontos = ['Rua A, Conchal', 'Rua B, Martinho Prado', 'Rua C, Iate'];
  assert.equal(ctx.precoEntrega(9, 3, 'Plano Meio Periodo MotoJa', pontos), 29.5);
  assert.equal(ctx.precoEntrega(9, 3, 'Plano Diario MotoJa Pro', pontos), 24);
  assert.match(ctx.labelPreco('Plano Meio Periodo MotoJa', 3, pontos), /2 ponto\(s\) em distrito a 12\.00/);
  assert.equal(ctx.tarifaLote('Plano Meio Periodo MotoJa', 'tujuguaba'), 12);
  assert.equal(ctx.tarifaLote('Plano Diario MotoJa Pro', 'iate'), 10);
  assert.equal(ctx.tarifaLote('Plano Diario MotoJa Pro', 'conchal'), 4);
  const driver = fs.readFileSync(new URL('../../motoboy.html',import.meta.url),'utf8');
  const dctx = vm.createContext({ dinheiro:Number, planoDiario:c => c.tipoEntrega === 'Plano Diario MotoJa Pro', servicoExclusivo:() => false });
  vm.runInContext(driver.slice(driver.indexOf('function appValorEntrega('),driver.indexOf('function appPercent(')),dctx);
  assert.equal(dctx.appValorEntrega({ tipoEntrega: 'Plano Meio Periodo MotoJa', paradas: 3, valor: 36, planoAppFee: 6 }), 6);
  assert.equal(dctx.appValorEntrega({ tipoEntrega: 'Plano Diario MotoJa Pro', paradas: 2, valor: 20, planoAppFee: 4 }), 4);
});

test('taxa avulsa: 5 deliveries are allowed, then R$ 6,50/R$ 16 stay blocked until a plan is activated, no matter the date', async () => {
  const h = harness();
  assert.equal((await h.call({ ...raw(), clientRequestId: 'a1', paradas: 3 })).status, 201);
  assert.equal(h.records.get('empresas/company').taxaAvulsaUsadas, 3);
  const partial = await h.call({ ...raw(), clientRequestId: 'a2', paradas: 3 });
  assert.equal(partial.status, 403); assert.equal(partial.data.error, 'taxa_avulsa_bloqueada'); assert.match(partial.data.message, /Restam 2/);
  assert.equal((await h.call({ ...raw(), clientRequestId: 'a3', paradas: 2, regiaoEntrega: 'martinho_prado' })).status, 201);
  assert.equal(h.records.get('empresas/company').taxaAvulsaUsadas, 5);
  const writes = h.writes.length;
  for (const region of ['conchal', 'martinho_prado', 'tujuguaba']) {
    const blocked = await h.call({ ...raw(), clientRequestId: `b-${region}`, paradas: 1, regiaoEntrega: region });
    assert.equal(blocked.status, 403); assert.match(blocked.data.message, /ja usou as 5 entregas/);
  }
  assert.equal(h.writes.length, writes);
  // Days later, still blocked: the counter has no date.
  h.records.set('empresas/company', { ...h.records.get('empresas/company'), planoDiarioAtivoDia: '2026-09-01' });
  assert.equal((await h.call({ ...raw(), clientRequestId: 'c1', paradas: 1 })).status, 403);
});
test('taxa avulsa: with a plan active, fixed fares are allowed and do not consume the 5; plan deliveries never count', async () => {
  for (const plan of [{ planoDiarioAtivoDia: '2026-10-04' }, { meioPeriodoExpiraEmMs: Date.now() + 3600000 }]) {
    const h = harness();
    h.records.set('empresas/company', { ...h.records.get('empresas/company'), taxaAvulsaUsadas: 5, ...plan });
    if (plan.planoDiarioAtivoDia) h.records.set('plans/11999999999/2026-10-04', { status: 'ativo' });
    assert.equal((await h.call({ ...raw(), clientRequestId: 'p1', paradas: 3 })).status, 201);
    assert.equal(h.records.get('empresas/company').taxaAvulsaUsadas, 5);
    assert.equal(h.records.get('entregas/p1').taxaAvulsaContada, undefined);
    const planType = plan.planoDiarioAtivoDia ? dailyRaw() : halfRaw();
    assert.equal((await h.call({ ...planType, clientRequestId: 'p2' })).status, 201);
    assert.equal(h.records.get('empresas/company').taxaAvulsaUsadas, 5);
  }
});
test('taxa avulsa: activating either plan resets the counter and opens a new cycle', async () => {
  const docs = new Map();
  const ref = path => ({ path, id: path.split('/').at(-1), collection: name => ({ doc: id => ref(`${path}/${name}/${id}`) }) });
  const ctx = vm.createContext({ Date, money: n => Math.round(Number(n || 0) * 100) / 100,
    todayKeySaoPaulo: () => '2026-10-04', companyBalance: d => ({ saldo: d.saldo || 0, reservado: d.reservado || 0, disponivel: (d.saldo || 0) - (d.reservado || 0) }),
    ledgerRef: () => ref(`ledger/${docs.size}`), admin: { firestore: { FieldValue: { serverTimestamp: () => 'TIME' } } },
    dailyPlanRef: (id, day) => ref(`empresas/${id}/planosDiarios/${day}`),
    db: { runTransaction: async fn => { const pending = []; await fn({ get: async r => ({ exists: docs.has(r.path), data: () => docs.get(r.path) }), set: (r, data, opt) => pending.push([r, data, opt]) }); for (const [r, data, opt] of pending) docs.set(r.path, opt?.merge ? { ...docs.get(r.path), ...data } : data); } },
    assertCompany: 0, assertCompanyApproved: 0, createRideLimiter: 0, app: { post: (path, ...h) => { ctx.handlers[path] = h.at(-1); } }, handlers: {} });
  for (const name of ['DAILY_PLAN_TYPE', 'DAILY_PLAN_PRICE', 'DAILY_PLAN_DELIVERY_FEE', 'DAILY_PLAN_APP_FEE', 'HALF_PLAN_TYPE', 'HALF_PLAN_PRICE', 'HALF_PLAN_DELIVERY_FEE', 'HALF_PLAN_APP_FEE', 'HALF_PLAN_DURATION_MS']) {
    const line = source.split('\n').find(l => l.startsWith(`const ${name} =`)); vm.runInContext(line.replace('const ', 'var '), ctx);
  }
  vm.runInContext(source.slice(source.indexOf('function halfPlanActiveUntil('), source.indexOf('const TAXA_AVULSA_LIMITE')), ctx);
  vm.runInContext(source.slice(source.indexOf('function taxaAvulsaResetFields('), source.indexOf('function halfPlanInactiveError(')), ctx);
  for (const route of ["app.post('/api/companies/daily-plan/activate'", "app.post('/api/companies/half-plan/activate'"]) {
    const start = source.indexOf(route); vm.runInContext(source.slice(start, source.indexOf('\napp.', start + 1)), ctx);
  }
  const call = async path => { const res = { status: () => res, json: () => res }; let failure;
    await ctx.handlers[path]({ companyId: 'c1', companySnap: { ref: ref('empresas/c1') } }, res, e => { failure = e; }); if (failure) throw failure; };
  docs.set('empresas/c1', { saldo: 200, reservado: 0, taxaAvulsaUsadas: 5, taxaAvulsaCiclo: 2 });
  await call('/api/companies/half-plan/activate');
  assert.equal(docs.get('empresas/c1').taxaAvulsaUsadas, 0); assert.equal(docs.get('empresas/c1').taxaAvulsaCiclo, 3);
  docs.set('empresas/c1', { ...docs.get('empresas/c1'), taxaAvulsaUsadas: 5 });
  await call('/api/companies/daily-plan/activate');
  assert.equal(docs.get('empresas/c1').taxaAvulsaUsadas, 0); assert.equal(docs.get('empresas/c1').taxaAvulsaCiclo, 4);
});

test('company app blocks R$ 6,50/R$ 16 after the 5 taxa avulsa deliveries unless a plan is active', () => {
  const html = fs.readFileSync(new URL('../../empresa.html',import.meta.url),'utf8');
  const ctx = vm.createContext({ planoDiarioAtivo:false, meioPeriodoAtivo:false, taxaAvulsa:{ usadas:3, limite:5, restantes:2 },
    comidaFixa:t => /lanche|acai|farmacia/i.test(t), tipoPlanoDiario:t => t === 'Plano Diario MotoJa Pro', tipoMeioPeriodo:t => t === 'Plano Meio Periodo MotoJa' });
  vm.runInContext(html.slice(html.indexOf('function planoAtivoAgora('), html.indexOf('function definirTaxaAvulsa(')), ctx);
  assert.equal(ctx.taxaAvulsaLiberada('Lanche / pizza / pastel / marmita', 2), true);
  assert.equal(ctx.taxaAvulsaLiberada('Lanche / pizza / pastel / marmita', 3), false);
  assert.match(ctx.mensagemTaxaAvulsa(3), /Restam 2/);
  ctx.taxaAvulsa = { usadas:5, limite:5, restantes:0 };
  assert.equal(ctx.taxaAvulsaLiberada('Farmacia', 1), false);
  assert.match(ctx.mensagemTaxaAvulsa(1), /5 entregas/);
  assert.equal(ctx.taxaAvulsaLiberada('Encomendas', 1), true);
  assert.equal(ctx.taxaAvulsaLiberada('Plano Diario MotoJa Pro', 3), true);
  ctx.meioPeriodoAtivo = true;
  assert.equal(ctx.taxaAvulsaLiberada('Farmacia', 4), true);
});
