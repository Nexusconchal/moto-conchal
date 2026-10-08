import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../../driver-availability.js', import.meta.url), 'utf8');
const cpf = '12345678901', key = `motoja:availability:${cpf}`;
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness(storage = new Map(), { now = 100000, driverCpf = cpf, unavailableStorage = false } = {}) {
  const events = {}, sockets = [], alerts = [], intervals = new Set();
  const buttons = ['true','false'].map(value => ({ dataset: { available: value }, attributes: {}, setAttribute(name, v) { this.attributes[name] = v; } }));
  const label = {}, root = { dataset: {}, querySelectorAll: () => buttons, querySelector: () => label };
  const document = { visibilityState: 'visible', getElementById: () => root, addEventListener: (name, fn) => events[name] = fn };
  const localStorage = { getItem: name => { if (unavailableStorage) throw Error('blocked'); return storage.get(name); }, setItem: (name, value) => { if (unavailableStorage) throw Error('blocked'); storage.set(name, value); }, removeItem: name => storage.delete(name) };
  const window = { addEventListener: (name, fn) => events[name] = fn, io: (_url, options) => {
    const handlers = {}, emissions = [];
    options.auth(proof => assert.equal(proof.driverCpf, driverCpf));
    const s = { id: `session-${sockets.length}`, connected: true, disconnects: 0, connects: 0, emissions,
      on(name, fn) { handlers[name] = fn; }, timeout() { return this; },
      emit(name, body, callback) { emissions.push({ name, body, callback }); },
      connect() { this.connected = true; this.id += '-reconnected'; this.connects++; },
      disconnect() { this.connected = false; this.disconnects++; handlers.disconnect?.(); },
      receive(value) { handlers['availability:state']?.(value); },
      reply(index, value, error = null) { emissions[index].callback(error, value); }
    }; sockets.push(s); return s;
  } };
  vm.runInContext(source, vm.createContext({ window, document, localStorage, Date: { now: () => now }, alert: value => alerts.push(value), setTimeout, clearTimeout, setInterval: fn => { intervals.add(fn); return fn; }, clearInterval: fn => intervals.delete(fn) }));
  const api = window.MotojaDriverAvailability;
  const start = () => api.start({ backend: 'https://example.test', getProof: () => ({ driverCpf }), onChange: () => {} });
  start();
  return { api, start, sockets, root, label, buttons, events, storage, document, alerts, tick: ms => now += ms, heartbeat: () => [...intervals].forEach(fn => fn()) };
}
const state = (desired = false, extra = {}) => ({ connected: true, desired, available: desired, busy: false, ...extra });
async function available(h) {
  await settle(); const s = h.sockets.at(-1); s.receive(state(false, { preferenceMissing: true }));
  h.buttons[0].onclick(); s.reply(s.emissions.length - 1, { ok: true, ...state(true) }); return s;
}
test('switching to WhatsApp does not disconnect or erase availability; background heartbeat still renews presence', async () => {
  const h = harness(); const s = await available(h);
  h.document.visibilityState = 'hidden'; h.events.visibilitychange();
  assert.equal(s.disconnects, 0); assert.equal(h.buttons[0].attributes['aria-pressed'], 'true');
  h.heartbeat(); assert.equal(s.emissions.at(-1).name, 'availability:heartbeat');
  s.reply(s.emissions.length - 1, { ok: true, ...state(true) });
  h.document.visibilityState = 'visible'; h.events.visibilitychange();
  assert.equal(h.api.canReceive(), true); assert.equal(s.disconnects, 0);
});
test('closing and reopening restores a confirmed choice only after a fresh authenticated server state', async () => {
  const storage = new Map(), first = harness(storage); await available(first); first.events.pagehide();
  assert.equal(first.api.canReceive(), false);
  const h = harness(storage); await settle(); const s = h.sockets[0];
  assert.equal(h.api.canReceive(), false); assert.equal(s.emissions.length, 0);
  s.receive(state(false, { preferenceMissing: true }));
  assert.equal(s.emissions.at(-1).body.available, true);
  assert.equal(h.buttons[0].disabled, true);
  s.reply(0, { ok: true, ...state(true, { busy: true, available: false }) });
  assert.match(h.label.textContent, /Em atendimento/); assert.equal(h.buttons[0].attributes['aria-pressed'], 'true');
});
test('a deliberate unavailable state from another tab wins over the remembered available choice', async () => {
  const storage = new Map(), first = harness(storage); await available(first);
  const h = harness(storage); await settle(); const s = h.sockets[0];
  s.receive(state(false, { preferenceMissing: false }));
  assert.equal(s.emissions.length, 0); assert.equal(h.buttons[1].attributes['aria-pressed'], 'true');
  assert.equal(JSON.parse(storage.get(key)).desired, false);
});
test('resume after expired presence restores the choice without keeping a disconnected client in the count', async () => {
  const h = harness(); const s = await available(h); s.disconnect(); h.tick(120000);
  assert.equal(h.api.canReceive(), false); assert.equal(h.buttons[0].attributes['aria-pressed'], 'true');
  h.events.pageshow(); await settle(); s.receive(state(false, { preferenceMissing: true }));
  assert.equal(s.emissions.at(-1).body.available, true); s.reply(s.emissions.length - 1, { ok: true, ...state(true) });
  assert.equal(h.api.canReceive(), true);
});
test('closing the app for several days does not expire the choice, including the old timestamp format', async () => {
  const storage = new Map(), first = harness(storage); await available(first); first.events.pagehide();
  const h = harness(storage, { now: 30 * 24 * 60 * 60 * 1000 }); await settle(); const s = h.sockets[0]; s.receive(state(false, { preferenceMissing: true }));
  assert.equal(s.emissions.at(-1).body.available, true); assert.equal(h.buttons[0].attributes['aria-pressed'], 'true');
  const legacy = harness(new Map([[key, JSON.stringify({ desired: true, at: -90000000 })]])); await settle(); legacy.sockets[0].receive(state(false, { preferenceMissing: true }));
  assert.equal(legacy.sockets[0].emissions.at(-1).body.available, true);
});
test('invalid and other driver preferences cannot silently enable a new driver', async () => {
  for (const stored of [{ desired: 'true' }, { desired: 1 }, { available: true }]) {
    const h = harness(new Map([[key, JSON.stringify(stored)]])); await settle(); const s = h.sockets[0]; s.receive(state(false, { preferenceMissing: true })); assert.equal(s.emissions.length, 0);
  }
  const h = harness(new Map([[key, JSON.stringify({ desired: true, at: 100000 })]]), { driverCpf: '10987654321' }); await settle(); h.sockets[0].receive(state(false, { preferenceMissing: true })); assert.equal(h.sockets[0].emissions.length, 0);
});
test('leaving the panel or editing the profile preserves the choice, and manual unavailable remains saved', async () => {
  const h = harness(); await available(h); h.api.stop(); assert.equal(JSON.parse(h.storage.get(key)).desired, true);
  h.start(); await settle(); const s = h.sockets.at(-1); s.receive(state(true, { preferenceMissing: false }));
  h.buttons[1].onclick(); s.reply(s.emissions.length - 1, { ok: true, ...state(false) });
  h.events.pagehide(); const reopened = harness(h.storage); await settle(); const next = reopened.sockets[0]; next.receive(state(false, { preferenceMissing: true }));
  assert.equal(next.emissions.length, 0); assert.equal(reopened.buttons[1].attributes['aria-pressed'], 'true');
});
test('explicit preference reset forgets availability and late acknowledgements cannot restore the old account', async () => {
  const h = harness(); const s = await available(h); h.buttons[1].onclick(); const pending = s.emissions.length - 1;
  h.api.stop({ forgetPreference: true }); assert.equal(h.storage.has(key), false); s.reply(pending, { ok: true, ...state(true) });
  assert.equal(h.root.hidden, true); assert.equal(h.storage.has(key), false); assert.equal(h.api.canReceive(), null);
});
test('blocked local storage does not crash the panel and in-tab resume still remembers the confirmed choice', async () => {
  const h = harness(new Map(), { unavailableStorage: true }); await available(h); h.start(); await settle();
  const s = h.sockets.at(-1); s.receive(state(false, { preferenceMissing: true })); assert.equal(s.emissions.at(-1).body.available, true);
});

test('a failed restore (slow network) never erases Disponivel and is retried on the next heartbeat', async () => {
  const storage = new Map(), first = harness(storage); await available(first); first.events.pagehide();
  const h = harness(storage); await settle(); const s = h.sockets[0];
  s.receive(state(false, { preferenceMissing: true }));
  assert.equal(s.emissions.at(-1).body.available, true);
  s.reply(s.emissions.length - 1, null, new Error('timeout'));
  // A broadcast and a heartbeat saying unavailable must not overwrite the saved choice.
  s.receive(state(false));
  h.heartbeat(); const hb = s.emissions.length - 1; assert.equal(s.emissions[hb].name, 'availability:heartbeat');
  s.reply(hb, { ok: true, ...state(false) });
  assert.equal(JSON.parse(storage.get(key)).desired, true);
  assert.equal(s.emissions.at(-1).name, 'availability:set'); assert.equal(s.emissions.at(-1).body.available, true);
  s.reply(s.emissions.length - 1, { ok: true, ...state(true) });
  assert.equal(h.api.canReceive(), true); assert.equal(h.alerts.length, 0);
});
test('a deliberate click on Indisponivel is saved and not undone by the retry', async () => {
  const storage = new Map(), first = harness(storage); await available(first); first.events.pagehide();
  const h = harness(storage); await settle(); const s = h.sockets[0];
  s.receive(state(false, { preferenceMissing: true })); s.reply(s.emissions.length - 1, null, new Error('timeout'));
  h.buttons[1].onclick(); s.reply(s.emissions.length - 1, { ok: true, ...state(false) });
  assert.equal(JSON.parse(storage.get(key)).desired, false);
  h.heartbeat(); s.reply(s.emissions.length - 1, { ok: true, ...state(false) });
  assert.equal(s.emissions.at(-1).name, 'availability:heartbeat');
});
