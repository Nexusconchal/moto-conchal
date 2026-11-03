import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

test('Finalizar expediente fecha o Plano Diario na hora, sem devolver a diaria, e marca a ativacao como encerrada', async () => {
  const docs = new Map();
  const ref = path => ({ path, id: path.split('/').at(-1), collection: name => ({ doc: id => ref(`${path}/${name}/${id}`) }) });
  const ctx = vm.createContext({ Date, String, Number, onlyDigits: v => String(v || '').replace(/\D/g, ''), todayKeySaoPaulo: () => '2026-11-03',
    admin: { firestore: { FieldValue: { serverTimestamp: () => 'TIME' } } },
    db: { collection: name => ({ doc: id => ref(`${name}/${id}`) }), runTransaction: async fn => { const pending = []; await fn({ get: async r => ({ exists: docs.has(r.path), data: () => docs.get(r.path) }), set: (r, data, opt) => pending.push([r, data, opt]) }); for (const [r, data, opt] of pending) docs.set(r.path, opt?.merge ? { ...docs.get(r.path), ...data } : data); } },
    assertCompany: 0, app: { post: (_p, ...h) => { ctx.handler = h.at(-1); } } });
  vm.runInContext(source.slice(source.indexOf('function dailyPlanActivation('), source.indexOf('function dailyPlanInactiveError(')), ctx);
  vm.runInContext(source.slice(source.indexOf('function planActivationKey('), source.indexOf('function mirrorPlanActivation(')), ctx);
  const start = source.indexOf("app.post('/api/companies/daily-plan/finish'");
  vm.runInContext(source.slice(start, source.indexOf('\napp.post(', start + 1)), ctx);
  const call = async () => { const out = {}; const res = { status: c => { out.status = c; return res; }, json: d => { out.data = d; return res; } }; let failure;
    await ctx.handler({ companyId: '19999990000', companySnap: { ref: ref('empresas/19999990000') } }, res, e => { failure = e; }); if (failure) throw failure; return out; };

  const plano = '2026-11-03-pro-1';
  docs.set('empresas/19999990000', { saldo: 130, planoDiarioExpiraEmMs: Date.now() + 5 * 3600000, planoDiarioAtivacaoId: plano });
  docs.set(`empresas/19999990000/planosDiarios/${plano}`, { status: 'ativo' });
  const r = await call();
  assert.equal(r.data.closed, true);
  const company = docs.get('empresas/19999990000');
  assert.equal(company.saldo, 130);
  assert.ok(company.planoDiarioExpiraEmMs <= Date.now());
  assert.equal(ctx.dailyPlanActivation(company), null);
  assert.equal(docs.get(`empresas/19999990000/planosDiarios/${plano}`).status, 'encerrado');
  assert.ok(docs.get(`planosAtivados/19999990000_${plano}`).encerradoEmMs);
  // Sem expediente aberto: nada muda.
  assert.equal((await call()).data.closed, false);
});
