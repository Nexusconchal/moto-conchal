import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { deliveryReportQuantity, buildCompanyDeliveryReport } from '../src/delivery-report.js';
const require = createRequire(import.meta.url);
const money = n => Math.round(Number(n || 0) * 100) / 100;
const reportStart = Date.parse('2026-10-04T00:00:00-03:00');
const jobs = [
  { id: 'lot-3', status: 'finalizada', entregaNaNota: true, regiaoEntrega: 'conchal', paradas: 3, valor: 19.5, ganhoMotoboy: 15, ganhoApp: 4.5, motoboy: 'José', criadaEm: reportStart + 10, motoboyCpf: 'secret', telefoneRecebedor: 'secret' },
  { id: 'pending-2', status: 'pendente', paradas: 2, valor: 13, saldoReservado: 13, criadaEm: reportStart + 20 },
  { id: 'daily-3', status: 'aceita', entregaNaNota: true, regiaoEntrega: 'iate', paradas: 3, valor: 12, saldoReservado: 12, motoboy: 'Maria', criadaEm: reportStart + 30 },
  { id: 'cancel-4', status: 'cancelada', paradas: 4, valor: 26, saldoReservado: 26, criadaEm: reportStart + 40 },
  { id: 'expired', status: 'expirada', valor: 6.5, saldoReservado: 6.5, criadaEm: reportStart + 50 },
  { id: 'address', status: 'finalizada', paradas: 1, valor: 6.5, ganhoMotoboy: 5, ganhoApp: 1.5, criadaEm: reportStart + 60 }
];
const helpers = { timestampMs: Number, money, deliverySplit: () => ({ driverAmount: 5, appFee: 1.5 }), bairroFromAddress: () => 'Centro' };
const report = () => buildCompanyDeliveryReport(jobs, [{ dia: '2026-10-04', status: 'ativo', valor: 70 }], helpers, { empresa: 'Loja Áçaí', sinceMs: reportStart, untilMs: reportStart + 86399999 });
const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
function extract(name, next) {
  const start = source.indexOf('function ' + name + '('), end = source.indexOf('\n' + next, start);
  return source.slice(source.slice(start - 6, start) === 'async ' ? start - 6 : start, end);
}

test('report counts calls and deliveries separately, only completed amounts as charged, daily activation separately', () => {
  const d = report();
  assert.equal(d.totalChamadas, 6); assert.equal(d.totalEntregas, 14); assert.equal(d.chamadasConcluidas, 2); assert.equal(d.entregasConcluidas, 4);
  assert.equal(d.totalGasto, 26); assert.equal(d.totalReservado, 25); assert.equal(d.totalDiarias, 70); assert.equal(d.totalDebitado, 96);
  assert.equal(d.totalMotoboy, 20); assert.equal(d.totalApp, 6); assert.equal(d.chamadasCanceladas, 1); assert.equal(d.chamadasExpiradas, 1);
  const batch = d.ultimas.find(row => row.id === 'lot-3');
  assert.equal(batch.motoboy, 'José'); assert.equal(batch.quantidade, 3); assert.equal(batch.bairroEntrega, 'Conchal urbano');
  assert.equal(d.ultimas.find(row => row.id === 'daily-3').cobrado, 0);
  assert.equal(d.ultimas.find(row => row.id === 'cancel-4').reservado, 0);
  assert.equal('motoboyCpf' in batch, false); assert.equal('telefoneRecebedor' in batch, false);
  const multi = buildCompanyDeliveryReport([{ ...jobs[5], paradas: 2, pontosExtras: [{ ordem: 2, digitado: 'Rua São Paulo, 100', telefoneRecebedor: 'private' }] }], [], helpers, { sinceMs: reportStart, untilMs: reportStart + 86399999 });
  assert.equal(multi.ultimas[0].pontosExtras[0].digitado,'Rua São Paulo, 100');
  assert.equal('telefoneRecebedor' in multi.ultimas[0].pontosExtras[0],false);
});
test('quantity guards old jobs, normal multi-stop deliveries and exclusive totals', () => {
  for (const paradas of [0, -1, 31, 2.5, 'wrong']) assert.equal(deliveryReportQuantity({ paradas }), 1);
  assert.equal(deliveryReportQuantity({ paradas: 5 }), 5);
  assert.equal(deliveryReportQuantity({ tipo: 'servico_exclusivo', quantidadeEntregasExclusivo: 8 }), 8);
});

test('driver event and real aggregate writes count a batch once with N deliveries, retries add no earnings', async () => {
  const records = new Map(), increments = [], written = [];
  const ref = path => ({ path });
  const context = vm.createContext({ deliveryReportQuantity, onlyDigits: s => String(s), cleanText: s => String(s || ''), money, Date,
    dateKeySaoPaulo: () => '2026-10-04', deliverySplit: () => ({ driverAmount: 15 }),
    admin: { firestore: { FieldValue: { increment: n => n, serverTimestamp: () => 'stamp' } } },
    driverEarningEventRef: () => ref('event'), driverEarningsRef: () => ref('total'), driverEarningsDayRef: () => ref('day')
  });
  vm.runInContext(extract('driverEarningEvent', 'function manualDeliveryPerformedAtMs') + '\n' + extract('recordDriverEarning', 'function addDriverEarningToSummary'), context);
  const event = context.driverEarningEvent('entrega', 'lot-3', jobs[0]);
  assert.equal(event.quantidadeEntregas, 3); assert.equal(event.ganhoCentavos, 1500); assert.equal(event.entregaNaNota, true);
  const tx = { get: async r => ({ exists: records.has(r.path) }), set: (r, value) => { records.set(r.path, value); written.push(r.path); if (r.path !== 'event') increments.push(value); } };
  assert.equal(await context.recordDriverEarning(tx, '12345678901', event), true);
  assert.equal(increments[0].servicos, 1); assert.equal(increments[0].entregas, 3); assert.equal(increments[1].entregas, 3);
  assert.equal(await context.recordDriverEarning(tx, '12345678901', event), false); assert.equal(written.length, 3);
});

test('legacy batch repair changes only counts once, never money or number of calls', async () => {
  const event = { dia: '2026-10-04', ganhoCentavos: 1500 }, writes = [];
  const query = { where: () => query, limit: () => query, get: async () => ({ docs: [{ id: 'lot-3', data: () => jobs[0] }] }) };
  const context = vm.createContext({ deliveryReportQuantity,
    db: { collection: () => query, runTransaction: async fn => fn({ get: async () => ({ exists: true, data: () => event }), set: (r, d) => { writes.push([r,d]); if (r === 'event') Object.assign(event,d); } }) },
    admin: { firestore: { FieldValue: { increment: n => n, serverTimestamp: () => 'stamp' } } },
    driverEarningEventRef: () => 'event', driverEarningsRef: () => 'total', driverEarningsDayRef: () => 'day'
  });
  const start = source.indexOf('async function repairQuickDeliveryEarnings('), end = source.indexOf('async function initializeDriverEarnings(', start);
  vm.runInContext(source.slice(start, end), context);
  await context.repairQuickDeliveryEarnings('12345678901'); await context.repairQuickDeliveryEarnings('12345678901');
  assert.equal(writes.length, 3); assert.equal(writes[1][1].entregas, 2); assert.equal(event.quantidadeEntregas, 3); assert.equal(event.ganhoCentavos, 1500);
  assert.equal('ganhoCentavos' in writes[1][1], false); assert.equal('servicos' in writes[1][1], false);
});

function routeHarness(count = 1) {
  let handler, reads = 0; const clauses = [], cache = new Map();
  const query = { where: (...args) => { clauses.push(args); return query; }, orderBy: (...args) => { clauses.push(args); return query; }, limit: limit => { clauses.push(['limit', limit]); return query; },
    doc: () => ({ collection: () => query }), get: async () => { reads++; return { docs: Array.from({ length: count }, (_, i) => ({ id: 'row-' + i, data: () => ({ ...jobs[0], criadaEm: reportStart + i }) })) }; } };
  const context = vm.createContext({ Map, Date, Number, buildCompanyDeliveryReport, ...helpers, todayKeySaoPaulo: () => '2026-10-04', dateKeySaoPaulo: d => d.toISOString().slice(0,10),
    onlyDigits: s => String(s).replace(/\D/g,''), db: { collection: () => query }, admin: { firestore: { Timestamp: { fromMillis: n => n } } }, assertCompany: 'auth',
    rateLimit: () => 'rate', app: { get: (_url, auth, limiter, fn) => { assert.equal(auth,'auth'); assert.equal(limiter,'rate'); handler = fn; } }
  });
  const start = source.indexOf('const companyReportCache ='), end = source.indexOf("app.post('/api/companies/deposit-request'",start);
  vm.runInContext(source.slice(start,end), context);
  async function call(params = {}) {
    let status = 200, result, error;
    await handler({ companyId: '19999990000', company: { empresa: 'Teste' }, params: { phone: '19999990000', ...params.phone }, query: params.query || {} },
      { status: n => { status=n; return { json: d => { result=d; } }; }, set: () => {}, json: d => { result=d; } }, e => { error=e; });
    if (error) throw error; return { status, result };
  }
  return { call, clauses, reads: () => reads, cache };
}
test('report authenticates ownership, bounds range/query, includes every visible row and reuses cache for downloads', async () => {
  const h = routeHarness(35);
  const d = await h.call(); assert.equal(d.status,200); assert.equal(d.result.ultimas.length,35); assert.equal(d.result.parcial,false);
  const reads = h.reads(); await h.call(); assert.equal(h.reads(),reads);
  assert.ok(h.clauses.some(c => c[0] === 'telefoneEmpresa' && c[2] === '19999990000'));
  assert.ok(h.clauses.some(c => c[0] === 'criadaEm' && c[1] === '>=')); assert.ok(h.clauses.some(c => c[0] === 'limit' && c[1] === 501));
  assert.equal((await h.call({ phone: { phone:'19888880000' } })).status,403);
  assert.equal((await h.call({ query:{sinceMs:'NaN',untilMs:'1'} })).status,400);
  assert.equal((await h.call({ query:{sinceMs:reportStart,untilMs:reportStart+32*86400000} })).status,400);
});
test('reports do not silently claim a complete total if the bounded query overflows', async () => {
  const h = routeHarness(501), d = (await h.call()).result;
  assert.equal(d.ultimas.length,500); assert.equal(d.parcial,true); assert.match(d.aviso,/500/);
});

const exportSource = fs.readFileSync(new URL('../../report-export.js', import.meta.url), 'utf8');
const context = vm.createContext({ Intl, Date, Number, Map, String, globalThis: {} }); vm.runInContext(exportSource, context);
const exporter = context.globalThis.MotojaReportExport;
test('real Excel export preserves numeric currency/counts, accents, full rows and formula-like names as text', () => {
  const XLSX = require('../../vendor/xlsx-0.20.3.min.js');
  const d = report(); d.ultimas[0].motoboy = '=WEBSERVICE("https://example.invalid")';
  const workbook = exporter.excelWorkbook(d,XLSX);
  const bytes = XLSX.write(workbook, { type:'buffer', bookType:'xlsx' });
  const restored = XLSX.read(bytes, { type:'buffer' });
  assert.deepEqual(restored.SheetNames, ['Resumo','Chamadas','Diárias']);
  assert.equal(restored.Sheets.Chamadas.K2.t,'n'); assert.equal(restored.Sheets.Chamadas.F2.t,'n');
  assert.equal(restored.Sheets.Chamadas.A2.t,'n'); assert.match(restored.Sheets.Chamadas.A2.w,/04\/10\/2026/);
  assert.equal(restored.Sheets.Chamadas.H2.t,'s'); assert.equal(restored.Sheets.Chamadas.H2.f,undefined);
  assert.equal(restored.Sheets.Resumo.B1.v,'Loja Áçaí'); assert.equal(restored.Sheets.Diárias.B2.v,70);
  assert.equal(XLSX.utils.sheet_to_json(restored.Sheets.Chamadas).length,6);
  d.ultimas[0].pontosExtras=[{ ordem:2,digitado:'Rua São Paulo, 100' }];
  assert.match(exporter.excelWorkbook(d,XLSX).Sheets.Chamadas.Q2.v,/Rua São Paulo, 100/);
  assert.throws(() => exporter.excelWorkbook({ ...d,parcial:true },XLSX));
});

test('owner dashboard and detail report use actual fees and batch quantities for every fixed region and daily plan', () => {
  const owner = fs.readFileSync(new URL('../../dono.html', import.meta.url), 'utf8');
  const dashboard = fs.readFileSync(new URL('../../owner-dashboard.js', import.meta.url), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(owner.slice(owner.indexOf('function entregaExclusiva('),owner.indexOf('function appEntrega(')),context);
  vm.runInContext(owner.slice(owner.indexOf('function appEntrega('),owner.indexOf('function escRelatorio(')) + '\n' + owner.slice(owner.indexOf('function qtdEntregas('),owner.indexOf('function renderProducaoMotoboys(')),context);
  const start = dashboard.indexOf('  function isSpecialDestination('), end = dashboard.indexOf('  function periodLabel(',start);
  vm.runInContext(dashboard.slice(start,end),context);
  for (const region of ['conchal','martinho_prado','tujuguaba','iate']) {
    const job = { entregaNaNota:true, regiaoEntrega:region, paradas:3, valor:region==='conchal'?19.5:48, tipoEntrega:'Farmacia' };
    assert.equal(context.qtdEntregas(job),3);
    assert.equal(context.appEntrega(job),region==='conchal'?4.5:6);
    assert.equal(context.deliveryAppValue(job),region==='conchal'?4.5:6);
    job.tipoEntrega='Plano Diário MotoJa Pro'; job.valor=12;
    assert.equal(context.appEntrega(job),3); assert.equal(context.deliveryAppValue(job),3);
    job.ganhoApp=2.5; assert.equal(context.appEntrega(job),2.5); assert.equal(context.deliveryAppValue(job),2.5);
  }
});
test('real PDF export generates complete paginated documents and rejects partial reports', () => {
  const { jsPDF } = require('../../vendor/jspdf-4.2.1.min.js');
  const d = report(), pdf = exporter.pdfDocument(d,jsPDF,null);
  const output = pdf.output('arraybuffer'); assert.ok(output.byteLength > 1000); assert.ok(pdf.getNumberOfPages() >= 2);
  const many = { ...d, ultimas: Array.from({length:80},(_,i)=>({ ...d.ultimas[0], id:'job-'+i })) };
  const manyPdf = exporter.pdfDocument(many,jsPDF,null); assert.ok(manyPdf.getNumberOfPages() > 10);
  assert.throws(() => exporter.pdfDocument({ ...d,parcial:true },jsPDF,null));
});

test('company UI escapes names, disables partial exports and ignores a response arriving after account change', async () => {
  const fields = Object.fromEntries(['relatorioEmpresa','periodoRelatorio','inicioRelatorio','fimRelatorio','verRelatorioDia','baixarRelatorioExcel','baixarRelatorioPdf'].map(id=>[id,{ value:id==='periodoRelatorio'?'today':'', disabled:false, textContent:'' }]));
  const uiContext = vm.createContext({ window:{}, document:{getElementById:id=>fields[id]}, Intl, Date, Number });
  vm.runInContext(fs.readFileSync(new URL('../../company-reports.js',import.meta.url),'utf8'),uiContext);
  let account = 'first', release;
  const controller = uiContext.window.MotojaCompanyReports.create({ fetchReport:()=>new Promise(resolve=>{release=resolve;}), identity:()=>account,
    escapeHtml:v=>String(v??'').replace(/</g,'&lt;').replace(/>/g,'&gt;'), money:n=>String(n) });
  assert.equal(fields.baixarRelatorioExcel.disabled,true);
  const d=report(); d.ultimas[0].motoboy='<img src=x onerror=alert(1)>';
  controller.render(d); assert.equal(fields.baixarRelatorioExcel.disabled,false); assert.match(fields.relatorioEmpresa.innerHTML,/&lt;img/);
  controller.render({...d,parcial:true,aviso:'Partial'}); assert.equal(fields.baixarRelatorioPdf.disabled,true);
  const pending=controller.load(); account='second'; controller.reset(); release(d); await pending;
  assert.equal(fields.baixarRelatorioExcel.disabled,true); assert.equal(fields.relatorioEmpresa.textContent,'Escolha o período e clique em Ver relatório.');
});
