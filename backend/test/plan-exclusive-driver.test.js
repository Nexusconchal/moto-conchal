import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const A = '11111111111', B = '22222222222', company = '19999990000';
function slice(startText, endText) { const a = source.indexOf(startText); const b = source.indexOf(endText, a + 1); assert.ok(a >= 0 && b > a, startText); return source.slice(a, b); }
function makeDb(records) {
  const ref = path => ({ path, id: path.split('/').at(-1), get: async () => snap(path), set: async (d, o) => apply(path, d, o), collection: name => ({ doc: id => ref(`${path}/${name}/${id}`) }) });
  const snap = path => ({ exists: records.has(path), data: () => records.get(path), ref: ref(path), id: path.split('/').at(-1) });
  const apply = (path, d, o) => records.set(path, Object.fromEntries(Object.entries(o?.merge ? { ...records.get(path), ...d } : d).filter(([, v]) => v !== 'DELETE')));
  return {
    batch: () => { const ops = []; return { set: (r, d, o) => ops.push([r, d, o]), commit: async () => ops.forEach(([r, d, o]) => apply(r.path, d, o)) }; },
    collection: name => ({ doc: id => ref(`${name}/${id}`), where: (field, _op, value) => ({ limit: () => ({ get: async () => {
      const docs = [...records.keys()].filter(p => p.startsWith(`${name}/`) && p.split('/').length === 2 && records.get(p)[field] === value).map(snap);
      return { docs, forEach: fn => docs.forEach(fn) };
    } }) }) }),
    runTransaction: async fn => { const pending = []; const r = await fn({ get: async x => snap(x.path), update: (x, d) => pending.push([x, d]), set: (x, d, o) => pending.push([x, d, o]) }); pending.forEach(([x, d, o]) => apply(x.path, d, o ?? { merge: true })); return r; }
  };
}
function context(records, extra = {}) {
  const routes = {};
  const ctx = vm.createContext({ db: makeDb(records), console, Date, Number, String, Object, Array,
    admin: { firestore: { FieldValue: { serverTimestamp: () => 'TS', delete: () => 'DELETE' } } },
    onlyDigits: v => String(v || '').replace(/\D/g, ''), cleanText: v => String(v || '').trim(),
    getDriverWithProof: async cpf => ({ nome: cpf === A ? 'Ana' : 'Bruno' }), driverRideCities: () => ({ conchal: true }), rideOperatingCity: () => 'conchal', deliveryOperatingCity: () => 'conchal', rideCityLabel: () => 'Conchal',
    serializeFirestore: v => v, publicPendingJob: v => v, privateDriverJob: v => v, sortJobs: v => v, emitDeliveryTracking: () => {},
    assertOwner: 0, adminStateCache: null, app: { post: (path, ...h) => { routes[path] = h.at(-1); } }, ...extra });
  vm.runInContext(slice('function planActivationKey(', 'function halfPlanInactiveError('), ctx);
  return { ctx, routes };
}
async function call(handler, req) {
  const out = { status: 200 }; let failure;
  const res = { status: c => { out.status = c; return res; }, json: d => { out.data = d; return res; } };
  await handler(req, res, e => { failure = e; }); if (failure) throw failure; return out;
}
test('a delivery reserved for the plan motoboy only appears for him; others still see open deliveries', async () => {
  const records = new Map([
    ['entregas/d1', { status: 'pendente', motoboyExclusivoCpf: B, empresa: 'Deck' }],
    ['entregas/d2', { status: 'pendente', empresa: 'Outra loja' }]]);
  const { ctx, routes } = context(records);
  vm.runInContext(slice("app.post('/api/drivers/:cpf/jobs'", "\napp.post("), ctx);
  const list = async cpf => (await call(routes['/api/drivers/:cpf/jobs'], { params: { cpf }, body: { kind: 'deliveries' } })).data.jobs.map(j => j.id);
  assert.deepEqual(await list(A), ['d2']);
  assert.deepEqual(await list(B), ['d1', 'd2']);
});
test('only the chosen motoboy can accept a reserved plan delivery', async () => {
  const records = new Map([['entregas/d1', { status: 'pendente', motoboyExclusivoCpf: B, empresaId: company }]]);
  const { ctx, routes } = context(records);
  vm.runInContext(slice("app.post('/api/deliveries/:deliveryId/accept'", "\napp."), ctx);
  const accept = cpf => call(routes['/api/deliveries/:deliveryId/accept'], { params: { deliveryId: 'd1' }, body: { driverCpf: cpf } });
  await assert.rejects(accept(A), err => err.code === 'entrega_reservada_motoboy_plano');
  assert.equal(records.get('entregas/d1').status, 'pendente');
  assert.equal((await accept(B)).data.ok, true);
  assert.equal(records.get('entregas/d1').motoboyCpf, B);
});
test('owner chooses the motoboy: plan, mirror and waiting deliveries follow; clearing opens them again', async () => {
  const key = `${company}_2026-10-12`;
  const records = new Map([
    [`planosAtivados/${key}`, { empresaId: company, planoDocId: '2026-10-12', empresa: 'Deck', tipo: 'diario' }],
    [`empresas/${company}/planosDiarios/2026-10-12`, { status: 'ativo' }],
    ['motoboys/' + B, { nome: 'Bruno', telefone: '19988887777', status: 'ativo' }],
    ['motoboys/' + A, { nome: 'Ana', status: 'bloqueado' }],
    ['entregas/p1', { status: 'pendente', planoAtivacaoChave: key }],
    ['entregas/p2', { status: 'aceita', planoAtivacaoChave: key, motoboyCpf: A }]]);
  const autoAccepted = [];
  const { ctx, routes } = context(records, { autoAcceptPlanDelivery: async id => { autoAccepted.push(id); return { accepted: true, delivery: {} }; }, notifyDriversAboutDelivery: async () => ({}) });
  vm.runInContext(slice("app.post('/api/admin/plans/:key/driver'", "\napp.post("), ctx);
  const choose = cpf => call(routes['/api/admin/plans/:key/driver'], { params: { key }, body: { cpf } });
  assert.equal((await choose(A)).status, 409);
  const ok = await choose(B);
  assert.equal(ok.data.entregasAtualizadas, 1);
  assert.equal(ok.data.entregasAceitas, 1);
  assert.deepEqual(autoAccepted, ['p1']);
  assert.equal(records.get(`planosAtivados/${key}`).motoboyExclusivoCpf, B);
  assert.equal(records.get(`empresas/${company}/planosDiarios/2026-10-12`).motoboyExclusivoCpf, B);
  assert.equal(records.get('entregas/p1').motoboyExclusivoCpf, B);
  assert.equal(records.get('entregas/p2').motoboyExclusivoCpf, undefined);
  await choose('');
  assert.deepEqual(autoAccepted, ['p1']);
  assert.equal(records.get('entregas/p1').motoboyExclusivoCpf, undefined);
  assert.equal(records.get(`planosAtivados/${key}`).motoboyExclusivoCpf, undefined);
  assert.equal((await call(routes['/api/admin/plans/:key/driver'], { params: { key: '../x' }, body: {} })).status, 400);
});
test('new plan deliveries copy the reserved motoboy from the active plan', () => {
  const { ctx } = context(new Map());
  const d = {}; ctx.applyPlanDriver(d, company, '2026-10-12', { motoboyExclusivoCpf: B, motoboyExclusivoNome: 'Bruno' });
  assert.equal(d.planoAtivacaoChave, `${company}_2026-10-12`); assert.equal(d.motoboyExclusivoCpf, B);
  const open = {}; ctx.applyPlanDriver(open, company, '2026-10-12', {});
  assert.equal(open.motoboyExclusivoCpf, undefined);
  assert.equal(ctx.deliveryReservedForOther(d, A), true); assert.equal(ctx.deliveryReservedForOther(d, B), false); assert.equal(ctx.deliveryReservedForOther(open, A), false);
});
test('motoboy app lists only the active plans where the owner chose him', async () => {
  const now = Date.now();
  const records = new Map([
    ['planosAtivados/a', { motoboyExclusivoCpf: B, empresa: 'Deck', tipo: 'diario', ativadoEmMs: now - 3600e3, expiraEmMs: now + 8 * 3600e3 }],
    ['planosAtivados/b', { motoboyExclusivoCpf: B, empresa: 'Antiga', tipo: 'diario', expiraEmMs: now - 1000 }],
    ['planosAtivados/c', { motoboyExclusivoCpf: A, empresa: 'Outra', tipo: 'meio_periodo', expiraEmMs: now + 3600e3 }]]);
  const { ctx, routes } = context(records);
  vm.runInContext(slice("app.post('/api/drivers/:cpf/plans'", "\napp.post("), ctx);
  const out = await call(routes['/api/drivers/:cpf/plans'], { params: { cpf: B }, body: {} });
  assert.deepEqual(out.data.plans.map(p => p.empresa), ['Deck']);
  assert.equal(out.data.plans[0].tipo, 'diario');
});
test('countdown text in the company and motoboy apps', () => {
  for (const [file, fn] of [['empresa.html', 'tempoRestante'], ['motoboy.html', 'tempoRestantePlano']]) {
    const html = fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    const start = html.indexOf(`function ${fn}(`);
    const body = html.slice(start, html.indexOf('\n      }\n', start) + 8);
    const ctx = vm.createContext({ Date, Math, String, Number });
    vm.runInContext(body, ctx);
    const now = Date.now();
    assert.equal(ctx[fn](now + (8 * 60 + 42) * 60000 - 1000), '8h 42min');
    assert.equal(ctx[fn](now + 5 * 60000 - 1000), '5 min');
    assert.equal(ctx[fn](now - 1000), '0 min');
  }
});
