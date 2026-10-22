import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { publicDriverCard, publicDriverId, sortPublicDrivers, shortName, referralCode, normalizeReferralCode, monthKey } from '../src/customer-menu.js';

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
function slice(a, b) { const i = source.indexOf(a); const j = source.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, a); return source.slice(i, j); }

test('the public motoboy card never carries personal data', () => {
  const card = publicDriverCard('12345678901', { nome: 'rafael aparecido de souza', telefone: '19999990000', cnh: '123', motoPlaca: 'ABC1D23', cpf: '12345678901', motoModelo: 'Honda CG 160', fotoMotoboy: 'data:image/png;base64,AA', notaSoma: 14, notaQtd: 3, cidadesAtivas: { aguai: true } }, { available: true });
  assert.deepEqual(Object.keys(card).sort(), ['avaliacoes', 'cidades', 'id', 'media', 'moto', 'nome', 'online', 'temFoto']);
  assert.equal(card.nome, 'Rafael S.');
  assert.equal(card.media, 4.7);
  assert.equal(card.online, true);
  assert.deepEqual([...card.cidades], ['conchal', 'aguai']);
  assert.ok(!JSON.stringify(card).includes('12345678901'));
  assert.equal(card.id, publicDriverId('12345678901'));
  assert.equal(shortName(''), 'Motoboy');
  const sorted = sortPublicDrivers([{ nome: 'B', online: false, media: 5, avaliacoes: 9 }, { nome: 'A', online: true, media: 4, avaliacoes: 1 }, { nome: 'C', online: false, media: 5, avaliacoes: 20 }]);
  assert.deepEqual(sorted.map((d) => d.nome), ['A', 'C', 'B']);
});

test('referral codes are short, readable and stable', () => {
  const code = referralCode('19999990000');
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(referralCode('19999990000'), code);
  assert.notEqual(referralCode('19999990000', 1), code);
  assert.equal(normalizeReferralCode(` ${code.toLowerCase()} `), code);
  assert.equal(normalizeReferralCode('AB0OI1'), '');
  assert.equal(monthKey(Date.UTC(2026, 9, 31, 12)), '2026-10');
  assert.equal(monthKey(Date.UTC(2026, 10, 1, 2)), '2026-10', 'horario de Sao Paulo');
});

function referralHarness(records) {
  const ref = (path) => ({ path, id: path.split('/').at(-1), get: async () => snap(path) });
  const snap = (path) => ({ id: path.split('/').at(-1), exists: records.has(path), data: () => records.get(path), ref: ref(path) });
  const query = (name, filters) => ({
    where: (f, _o, v) => query(name, [...filters, [f, v]]),
    limit: () => ({ get: async () => { const docs = [...records.keys()].filter((k) => k.startsWith(`${name}/`) && k.split('/').length === 2 && filters.every(([f, v]) => records.get(k)[f] === v)).map(snap); return { empty: !docs.length, docs }; } })
  });
  const db = { collection: (name) => ({ doc: (id) => ref(`${name}/${id}`), where: (f, o, v) => query(name, [[f, v]]) }),
    runTransaction: async (fn) => { const ops = []; const out = await fn({ get: (r) => r.get(), set: (r, d, o) => ops.push([r, d, o]) }); ops.forEach(([r, d, o]) => { const base = o?.merge ? { ...records.get(r.path) } : {}; for (const [k, v] of Object.entries(d)) base[k] = v?.inc ? Number(base[k] || 0) + v.inc : v; records.set(r.path, base); }); return out; } };
  const ctx = vm.createContext({ db, Date, Number, String, console, monthKey,
    admin: { firestore: { FieldValue: { increment: (n) => ({ inc: n }) } } },
    cleanText: (v, n = 80) => String(v || '').slice(0, n), onlyDigits: (v) => String(v || '').replace(/\D/g, '') });
  vm.runInContext(slice('// Amigo indicado fez a primeira corrida finalizada', '// Tela "Indique e ganhe"'), ctx);
  return ctx;
}

test('the friend counts once, only after the first finished ride', async () => {
  const records = new Map([
    ['clientes/111', { nome: 'Ana Indicadora' }],
    ['clientes/222', { nome: 'Bruno Amigo', indicadoPor: '111' }],
    ['corridas/c1', { telefoneCliente: '222', status: 'cancelada' }]
  ]);
  const ctx = referralHarness(records);
  assert.equal(await ctx.qualifyReferral('222'), false);
  records.set('corridas/c2', { telefoneCliente: '222', status: 'finalizada' });
  await ctx.qualifyReferralFromRide('c2');
  assert.ok(records.get('clientes/222').indicacaoQualificadaEmMs);
  assert.equal(records.get('clientes/111').indicacoesQualificadas, 1);
  assert.equal(records.get('indicacoes/222').indicadorId, '111');
  assert.equal(records.get('indicacoes/222').indicadoFinal, '222'.slice(-4));
  assert.equal(await ctx.qualifyReferral('222'), false);
  assert.equal(records.get('clientes/111').indicacoesQualificadas, 1);
  // Cliente sem indicacao nao gera nada.
  records.set('clientes/333', { nome: 'Sem link' });
  assert.equal(await ctx.qualifyReferral('333'), false);
});

test('signup keeps who referred only for a new account and never for yourself', () => {
  const register = slice("app.post('/api/customers/register'", "app.post('/api/customers/login'");
  assert.match(register, /normalizeReferralCode\(req\.body\.indicacao\)/);
  assert.match(register, /referrerId !== telefoneCliente && firstSignup && !customerSnap\.data\(\)\?\.indicadoPor/);
  // A primeira corrida finalizada em qualquer caminho de finalizar dispara a qualificacao.
  assert.match(source, /qualifyReferralFromRide\(rideFinished\[1\]\)/);
});
