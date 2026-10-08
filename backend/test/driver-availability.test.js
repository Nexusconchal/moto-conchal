import test from 'node:test';
import assert from 'node:assert/strict';
import { createDriverAvailability, observeAvailabilityJob } from '../src/driver-availability.js';
const cpf = '12345678901', other = '10987654321', cities = { conchal: true, aguai: false, engenheiro_coelho: false };
function harness(options = {}) { let clock = 100000; const p = createDriverAvailability({ now: () => clock, ...options }); return { p, tick: n => clock += n }; }
function ready(p, who = cpf, id = 'tab1', enabled = cities) { p.connect(who, id, enabled); p.initializeJobs(who, []); p.set(who, id, true); }
test('starts unavailable and requires both a verified connection and completed job initialization', () => {
  const { p } = harness(); p.connect(cpf, 'tab1', cities);
  assert.equal(p.publicCounts().counts.conchal, 0); p.set(cpf, 'tab1', true);
  assert.equal(p.publicCounts().counts.conchal, 0); p.initializeJobs(cpf, []);
  assert.equal(p.publicCounts().counts.conchal, 1);
});
test('two tabs count once, share preference, and disconnecting one does not remove the other', () => {
  const { p } = harness(); ready(p); p.connect(cpf, 'tab2', cities);
  assert.equal(p.publicCounts().counts.conchal, 1); p.disconnect(cpf, 'tab1');
  assert.equal(p.publicCounts().counts.conchal, 1); p.set(cpf, 'tab2', false);
  assert.equal(p.state(cpf).desired, false); assert.equal(p.publicCounts().counts.conchal, 0);
});
test('closed last tab disappears immediately and a lost heartbeat expires after 90 seconds', () => {
  const { p, tick } = harness(); ready(p); p.disconnect(cpf, 'tab1'); assert.equal(p.publicCounts().counts.conchal, 0);
  p.connect(cpf, 'tab2', cities); assert.equal(p.publicCounts().counts.conchal, 1);
  tick(90000); assert.equal(p.publicCounts().counts.conchal, 0); assert.throws(() => p.heartbeat(cpf, 'tab2'));
});
test('only server supplied service cities are counted, and city changes update counts', () => {
  const { p } = harness(); ready(p); ready(p, other, 'other', { conchal: true, aguai: true });
  assert.deepEqual(p.publicCounts().counts, { conchal: 2, aguai: 1, engenheiro_coelho: 0 });
  p.cities(other, cities); assert.equal(p.publicCounts().counts.aguai, 0);
});
test('initial ongoing rides and deliveries exclude a driver until all of them finish', () => {
  const { p } = harness(); p.connect(cpf, 'tab1', cities); p.initializeJobs(cpf, ['rides:a', 'deliveries:b']); p.set(cpf, 'tab1', true);
  assert.equal(p.publicCounts().counts.conchal, 0); p.job('rides', 'a', 'finalizada'); assert.equal(p.publicCounts().counts.conchal, 0);
  p.job('deliveries', 'b', 'cancelada'); assert.equal(p.publicCounts().counts.conchal, 1);
});
test('a new acceptance marks busy; toggling available cannot override occupancy', () => {
  const { p } = harness(); ready(p); p.job('rides', 'a', 'aceita', cpf); p.set(cpf, 'tab1', true);
  assert.equal(p.publicCounts().counts.conchal, 0); assert.equal(p.state(cpf).busy, true);
  p.job('rides', 'a', 'pendente'); assert.equal(p.publicCounts().counts.conchal, 1);
});
test('completion racing the initial database read cannot restore an already finished job', () => {
  const { p } = harness(); p.connect(cpf, 'tab1', cities); p.job('rides', 'a', 'finalizada'); p.initializeJobs(cpf, ['rides:a']); p.set(cpf, 'tab1', true);
  assert.equal(p.publicCounts().counts.conchal, 1);
});
test('acceptance racing initial read remains busy even when the snapshot was empty', () => {
  const { p } = harness(); p.connect(cpf, 'tab1', cities); p.job('rides', 'a', 'aceita', cpf); p.initializeJobs(cpf, []); p.set(cpf, 'tab1', true);
  assert.equal(p.publicCounts().counts.conchal, 0);
});
test('unavailable and disconnected drivers retain accepted job tracking', () => {
  const { p } = harness(); ready(p); p.job('deliveries', 'x', 'aceita', cpf); p.set(cpf, 'tab1', false); p.disconnect(cpf, 'tab1');
  assert.equal(p.state(cpf).busy, true); assert.equal(p.publicCounts().counts.conchal, 0);
});
test('invalid boolean, unknown session, session flooding and driver capacity are rejected', () => {
  const { p } = harness({ maxSessions: 2, maxDrivers: 1 }); ready(p); assert.throws(() => p.set(cpf, 'tab1', 'true'));
  assert.throws(() => p.set(cpf, 'attacker', true)); p.connect(cpf, 'tab2', cities); assert.throws(() => p.connect(cpf, 'tab3', cities));
  assert.throws(() => p.connect(other, 'tab', cities)); assert.throws(() => p.connect('invalid', 'tab', cities));
});
test('blocked driver removal and process restart produce zero, never stale restored counts', () => {
  const { p } = harness(); ready(p); p.remove(cpf); assert.equal(p.publicCounts().counts.conchal, 0); assert.throws(() => p.set(cpf, 'tab1', true));
  assert.equal(createDriverAvailability().publicCounts().counts.conchal, 0);
});
test('public response contains only numeric aggregate and freshness; no driver identifiers or jobs', () => {
  const { p } = harness(); ready(p); const json = JSON.stringify(p.publicCounts());
  assert.ok(!json.includes(cpf)); assert.deepEqual(Object.keys(p.publicCounts()), ['ok', 'counts', 'updatedAt', 'expiresInMs']);
});
test('response observer ignores failed accepts, unrelated payment approval and pending company completion', () => {
  const { p } = harness(); ready(p);
  observeAvailabilityJob(p, '/api/rides/a/accept', 409, { ok: true }, cpf); assert.equal(p.state(cpf).busy, false);
  observeAvailabilityJob(p, '/api/rides/a/accept', 200, { ok: true }, cpf); assert.equal(p.state(cpf).busy, true);
  observeAvailabilityJob(p, '/api/admin/rides/a/payment/presential/approve', 200, { ok: true }); assert.equal(p.state(cpf).busy, true);
  observeAvailabilityJob(p, '/api/rides/a/finish', 200, { ok: true, pendingApproval: true }); assert.equal(p.state(cpf).busy, true);
  observeAvailabilityJob(p, '/api/admin/rides/a/force-finish', 200, { ok: true }); assert.equal(p.state(cpf).busy, false);
});
test('company approval, owner rejection and support completion release exactly their own job', () => {
  const { p } = harness(); ready(p);
  for (const path of ['/api/companies/me/deliveries/a/approve-completion', '/api/admin/deliveries/a/deny-completion', '/api/support/operations/entrega/a/finish']) {
    p.job('deliveries', 'a', 'retirada', cpf); p.job('rides', 'keep', 'aceita', cpf);
    observeAvailabilityJob(p, path, 200, { ok: true }); assert.equal(p.state(cpf).busy, true);
    p.job('rides', 'keep', 'cancelada'); assert.equal(p.state(cpf).busy, false);
  }
});
