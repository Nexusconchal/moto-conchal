import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Server } from 'socket.io';
import { io as client } from 'socket.io-client';
import { createDriverAvailability } from '../src/driver-availability.js';
import { attachDriverAvailability } from '../src/driver-availability-socket.js';
const cpf = '12345678901';
const proof = { driverCpf: cpf, driverCnh: '12345678901', driverTelefone: '19999999999' };
async function setup(t, opts = {}) {
  let now = Date.now(), verifies = 0, loads = 0;
  const http = createServer(); const io = new Server(http); const presence = createDriverAvailability({ now: () => now, ...opts });
  io.use((_socket, next) => next(new Error('root_private')));
  const control = attachDriverAvailability(io, presence, {
    now: () => now,
    verifyDriver: async (id, body) => { verifies++; if (id !== cpf || body.driverCnh !== proof.driverCnh || body.driverTelefone !== proof.driverTelefone) throw new Error('unauthorized'); return { cidadesAtivas: { conchal: true } }; },
    enabledCities: driver => driver.cidadesAtivas,
    loadJobs: async () => { loads++; return []; }
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const url = `http://127.0.0.1:${http.address().port}/driver-availability`;
  const sockets = []; t.after(async () => { sockets.forEach(s => s.disconnect()); await new Promise(resolve => io.close(resolve)); });
  function open(auth = proof) { const s = client(url, { auth, transports: ['websocket'], forceNew: true, reconnection: false }); sockets.push(s); return s; }
  return { presence, control, io, open, tick: ms => now += ms, stats: () => ({ verifies, loads }) };
}
async function connected(s) { const data = await Promise.race([once(s, 'availability:state'), once(s, 'connect_error').then(([e]) => { throw e; })]); return data[0]; }
function emit(s, name, body) { return new Promise((resolve, reject) => s.timeout(2000).emit(name, body, (error, data) => error ? reject(error) : resolve(data))); }
test('namespace verifies proof, does not bypass private root rooms, and counts only after deliberate availability', async t => {
  const h = await setup(t); const s = h.open(); const initial = await connected(s);
  assert.equal(initial.desired, false); assert.equal(h.io.sockets.sockets.size, 0);
  assert.equal(initial.preferenceMissing, true);
  assert.equal(h.presence.publicCounts().counts.conchal, 0);
  assert.equal((await emit(s, 'availability:set', { available: true, driverCpf: '99999999999', cities: { aguai: true } })).ok, true);
  assert.deepEqual(h.presence.publicCounts().counts, { conchal: 1, aguai: 0, engenheiro_coelho: 0 });
  assert.equal((await emit(s, 'availability:set', { available: 'true' })).ok, false);
});
test('incorrect credentials never create a public online driver', async t => {
  const h = await setup(t); const s = h.open({ ...proof, driverCnh: 'wrong' });
  const [error] = await once(s, 'connect_error'); assert.equal(error.message, 'disponibilidade_nao_autorizada');
  assert.equal(h.presence.publicCounts().counts.conchal, 0);
});
test('simultaneous tabs deduplicate job initialization and synchronize the same voluntary setting', async t => {
  const h = await setup(t); const a = h.open(), b = h.open(); await Promise.all([connected(a), connected(b)]);
  assert.equal(h.stats().loads, 1); await emit(a, 'availability:set', { available: true });
  assert.equal(h.presence.publicCounts().counts.conchal, 1); await emit(b, 'availability:set', { available: false });
  assert.equal(h.presence.state(cpf).desired, false);
});
test('heartbeats have no additional job reads and revalidate credentials only every five minutes', async t => {
  const h = await setup(t); const s = h.open(); await connected(s); await emit(s, 'availability:set', { available: true });
  h.tick(30000); await emit(s, 'availability:heartbeat', {}); assert.deepEqual(h.stats(), { verifies: 1, loads: 1 });
  for (let i = 0; i < 10; i++) { h.tick(30000); await emit(s, 'availability:heartbeat', {}); }
  assert.deepEqual(h.stats(), { verifies: 2, loads: 1 });
});
test('fresh reconnection is announced after expiry while a retained server preference stays authoritative', async t => {
  const h = await setup(t); const a = h.open(); await connected(a);
  await emit(a, 'availability:set', { available: true });
  const b = h.open(); const retained = await connected(b);
  assert.equal(retained.preferenceMissing, false); assert.equal(retained.desired, true);
  await emit(b, 'availability:set', { available: false });
  const disconnected = [...h.io.of('/driver-availability').sockets.values()].map(s => once(s, 'disconnect'));
  a.disconnect(); b.disconnect(); await Promise.all(disconnected);
  h.tick(120000); const c = h.open(); const fresh = await connected(c);
  assert.equal(fresh.preferenceMissing, true); assert.equal(fresh.desired, false);
  assert.equal(h.presence.publicCounts().counts.conchal, 0); assert.equal(h.stats().loads, 2);
  // Restoring the UI preference still uses the normal authenticated, rate-limited setter.
  assert.equal((await emit(c, 'availability:set', { available: true })).ok, true);
  assert.equal(h.presence.publicCounts().counts.conchal, 1);
});
test('owner revocation immediately removes presence and disconnects authenticated tabs', async t => {
  const h = await setup(t); const s = h.open(); await connected(s); await emit(s, 'availability:set', { available: true });
  const disconnected = once(s, 'disconnect'); h.control.revoke(cpf); await disconnected;
  assert.equal(h.presence.publicCounts().counts.conchal, 0);
});
test('a fifth connected tab is rejected instead of multiplying identities or reads', async t => {
  const h = await setup(t, { maxSessions: 2 }); const a = h.open(), b = h.open(); await Promise.all([connected(a), connected(b)]);
  const c = h.open(); const [error] = await once(c, 'connect_error'); assert.equal(error.message, 'disponibilidade_nao_autorizada');
  assert.equal(h.stats().loads, 1);
});
test('excessive toggle events are rate limited and cannot keep changing the accepted state', async t => {
  const h = await setup(t); const s = h.open(); await connected(s);
  for (let i = 0; i < 20; i++) assert.equal((await emit(s, 'availability:set', { available: false })).ok, true);
  assert.equal((await emit(s, 'availability:set', { available: true })).ok, false);
  assert.equal(h.presence.state(cpf).desired, false);
});
