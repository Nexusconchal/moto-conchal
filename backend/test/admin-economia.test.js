import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const i = source.indexOf('// ---------- Painel do dono: economia do banco');
const j = source.indexOf('async function collectionState(', i);

test('painel do dono: le tudo uma vez e depois so o que mudou (e o documento que o dono alterou)', async () => {
  let reads = 0, now = 1_000_000;
  const docs = new Map(Array.from({ length: 400 }, (_, k) => [`r${k}`, { status: 'finalizada', criadaEm: { seconds: k }, atualizadaEm: { ms: 900_000 } }]));
  const snap = (list) => { reads += list.length; return { docs: list.map(([id, data]) => ({ id, exists: true, data: () => data })) }; };
  const collection = () => ({
    orderBy: () => ({ limit: (n) => ({ get: async () => snap([...docs].slice(0, n)) }) }),
    limit: (n) => ({ get: async () => snap([...docs].slice(0, n)) }),
    where: (_f, _op, value) => ({ limit: () => ({ get: async () => snap([...docs].filter(([, d]) => d.atualizadaEm.ms > value.ms)) }) }),
    doc: (id) => ({ get: async () => { reads += 1; return { id, exists: docs.has(id), data: () => docs.get(id) }; } })
  });
  const ctx = vm.createContext({ db: { collection }, Date: { now: () => now }, Map, Set, Promise, Number, String, Math,
    admin: { firestore: { Timestamp: { fromMillis: (ms) => ({ ms }) } } },
    serializeFirestore: (v) => v, timestampMs: (v) => Number(v?.seconds || 0) * 1000 });
  vm.runInContext(source.slice(i, j), ctx);

  const first = await ctx.adminCollection('corridas', { limit: 500, orderField: 'criadaEm', updatedField: 'atualizadaEm' });
  assert.equal(first.length, 400); assert.equal(reads, 400);
  // Painel aberto de novo 1 min depois, com 2 corridas mudadas: le so as 2.
  now += 60_000;
  docs.set('r5', { ...docs.get('r5'), status: 'cancelada', atualizadaEm: { ms: now - 1000 } });
  docs.set('novo', { status: 'pendente', criadaEm: { seconds: 999 }, atualizadaEm: { ms: now - 500 } });
  reads = 0;
  const second = await ctx.adminCollection('corridas', { limit: 500, orderField: 'criadaEm', updatedField: 'atualizadaEm' });
  assert.equal(reads, 2);
  assert.equal(second.length, 401);
  assert.equal(second.find((c) => c.id === 'r5').status, 'cancelada');
  assert.equal(second[0].id, 'novo', 'a mais recente vem primeiro');
  // O dono mexeu numa corrida: a proxima carga rele so ela.
  now += 60_000; reads = 0;
  docs.set('r7', { ...docs.get('r7'), status: 'aceita' });
  ctx.markAdminRefetch('corridas', 'r7');
  const third = await ctx.adminCollection('corridas', { limit: 500, orderField: 'criadaEm', updatedField: 'atualizadaEm' });
  assert.ok(reads <= 3, `leu ${reads}`); // a alterada pelo dono + as que mudaram nos ultimos 15 s (margem de seguranca)
  assert.equal(third.find((c) => c.id === 'r7').status, 'aceita');
});
