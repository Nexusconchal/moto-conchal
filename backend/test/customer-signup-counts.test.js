import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
test('owner sees total customer accounts and new signups today, 7 and 30 days (Sao Paulo time)', async () => {
  const day = 86400000, now = Date.parse('2026-10-10T15:00:00-03:00');
  const signups = [now - 3600000, now - 2 * day, now - 10 * day, now - 40 * day];
  const queries = [];
  const db = { collection: name => ({
    count: () => ({ get: async () => ({ data: () => ({ count: name === 'customerCpf' ? signups.length : 0 }) }) }),
    where: (field, op, ts) => { queries.push([name, field, op]); return { count: () => ({ get: async () => ({ data: () => ({ count: signups.filter(ms => ms >= ts).length }) }) }) }; }
  }) };
  const ctx = vm.createContext({ db, Date, admin: { firestore: { Timestamp: { fromMillis: ms => ms } } },
    dateKeySaoPaulo: d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d) });
  const start = source.indexOf('async function customerSignupCounts(');
  vm.runInContext(source.slice(start, source.indexOf("app.get('/api/admin/state'", start)), ctx);
  const counts = await ctx.customerSignupCounts(now);
  assert.deepEqual({ ...counts }, { total: 4, hoje: 1, ultimos7: 2, ultimos30: 3 });
  assert.ok(queries.every(([name, field, op]) => name === 'clientes' && field === 'cadastradaEm' && op === '>='));
});
test('owner dashboard card shows the totals and degrades when counts are unavailable', () => {
  const js = fs.readFileSync(new URL('../../owner-dashboard.js', import.meta.url), 'utf8');
  const ctx = vm.createContext({});
  vm.runInContext(`const number = v => String(v);${js.slice(js.indexOf('function metric('), js.indexOf('function alertItem('))}; this.customerMetric = customerMetric;`, ctx);
  assert.match(ctx.customerMetric({ total: 120, hoje: 3, ultimos7: 15, ultimos30: 40 }), /Clientes cadastrados<\/span><strong>120<\/strong><small>\+3 hoje · \+15 em 7 dias · \+40 em 30 dias/);
  assert.match(ctx.customerMetric(null), /indisponível/);
});
