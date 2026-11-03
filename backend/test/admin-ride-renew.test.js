import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

test('dono chama de novo uma corrida expirada: volta para pendente com prazo novo e avisa os motoboys', async () => {
  const docs = new Map(), avisos = [];
  const ref = path => ({ path, id: path.split('/').at(-1) });
  const ctx = vm.createContext({ Date, Math, Number, String, console, rideStatusCache: new Map([['r1', {}]]),
    admin: { firestore: { FieldValue: { serverTimestamp: () => 'TIME' } } },
    db: { collection: name => ({ doc: id => ref(`${name}/${id}`) }), runTransaction: async fn => fn({ get: async r => ({ exists: docs.has(r.path), data: () => docs.get(r.path) }), update: (r, data) => docs.set(r.path, { ...docs.get(r.path), ...data }) }) },
    notifyDriversAboutRide: async (id, ride) => { avisos.push(['push', id, ride]); return { sent: 1 }; },
    notifyTelegramAboutRide: async (id) => { avisos.push(['telegram', id]); return { sent: true }; },
    assertOwner: 0, app: { post: (_p, ...h) => { ctx.handler = h.at(-1); } } });
  const start = source.indexOf("app.post('/api/admin/rides/:rideId/renew'");
  vm.runInContext(source.slice(start, source.indexOf('\napp.post(', start + 1)), ctx);
  const call = async id => { const out = {}; let failure; const res = { status: c => { out.status = c; return res; }, json: d => { out.data = d; return res; } };
    await ctx.handler({ params: { rideId: id } }, res, e => { failure = e; }); return failure ? { error: failure } : out; };

  docs.set('corridas/r1', { status: 'expirada', renovacoes: 1, criadaEm: { seconds: 1 } });
  const ok = await call('r1');
  assert.equal(ok.data.ok, true);
  assert.equal(docs.get('corridas/r1').status, 'pendente');
  assert.equal(docs.get('corridas/r1').renovacoes, 2);
  assert.equal(ctx.rideStatusCache.has('r1'), false);
  assert.deepEqual(avisos.map(a => a[0]), ['push', 'telegram']);
  assert.ok(avisos[0][2].criadaEm.seconds > Date.now() / 1000 - 5);

  docs.set('corridas/r2', { status: 'finalizada' });
  assert.equal((await call('r2')).error.status, 409);
  assert.equal((await call('nao-existe')).error.status, 404);
});
