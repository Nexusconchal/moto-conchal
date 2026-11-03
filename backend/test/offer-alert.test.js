import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfferAlerts } from '../src/offer-alert.js';

function harness({ pending = () => true, maxRepeats = 3 } = {}) {
  const timers = [];
  const sent = [];
  const alerts = createOfferAlerts({
    intervalMs: 20000,
    maxRepeats,
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
    loadPending: async (kind, id) => (pending(kind, id) ? { id } : null),
    send: async (kind, id, job, count) => { sent.push(`${kind}:${id}:${count}`); },
    onError: () => {}
  });
  const run = async () => { const fn = timers.shift(); if (fn) await fn(); };
  return { alerts, timers, sent, run };
}

test('repeats the alert while the call stays pending, up to the limit', async () => {
  const { alerts, sent, run, timers } = harness({ maxRepeats: 3 });
  alerts.start('rides', 'r1');
  await run(); await run(); await run();
  assert.deepEqual(sent, ['rides:r1:1', 'rides:r1:2', 'rides:r1:3']);
  assert.equal(timers.length, 0);
  assert.equal(alerts.size(), 0);
});

test('stops as soon as the call is no longer pending', async () => {
  let pending = true;
  const { alerts, sent, run, timers } = harness({ pending: () => pending, maxRepeats: 8 });
  alerts.start('deliveries', 'd1');
  await run();
  pending = false;
  await run();
  assert.deepEqual(sent, ['deliveries:d1:1']);
  assert.equal(timers.length, 0);
  assert.equal(alerts.size(), 0);
});

test('stop() cancels a scheduled repeat and start() restarts the count', async () => {
  const { alerts, sent, run } = harness({ maxRepeats: 8 });
  alerts.start('rides', 'r2');
  alerts.stop('rides', 'r2');
  await run();
  assert.deepEqual(sent, []);
  alerts.start('rides', 'r2');
  await run();
  assert.deepEqual(sent, ['rides:r2:1']);
});

test('a send failure does not stop the next repeat', async () => {
  const timers = [];
  let calls = 0;
  const alerts = createOfferAlerts({
    maxRepeats: 2,
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
    loadPending: async () => ({}),
    send: async () => { calls += 1; if (calls === 1) throw new Error('fcm down'); },
    onError: () => {}
  });
  alerts.start('rides', 'r3');
  await timers.shift()();
  await timers.shift()();
  assert.equal(calls, 2);
});
