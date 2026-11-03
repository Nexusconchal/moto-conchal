import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html = fs.readFileSync(new URL('../../motoboy.html', import.meta.url), 'utf8');
const startMark = 'lista.querySelectorAll("[data-avisar]").forEach(';
const start = html.indexOf('(btn.onclick = async () => {', html.indexOf(startMark));
const end = html.indexOf('lista.querySelectorAll("[data-point]")', start);
const handlerSource = html.slice(start, html.lastIndexOf('}),', end) + 2).replace(/^\(btn\.onclick = /, '(');
function harness({ gps, notify = { ok: true, body: { ok: true, whatsapp: 'https://wa.me/551999' } } }) {
  const calls = [], alerts = [], events = [];
  const btn = { dataset: { avisar: 'ride1' }, disabled: false, textContent: 'Avisar cliente e iniciar corrida com GPS' };
  const location = { href: '' };
  const ctx = vm.createContext({
    btn, CONFIG: { backend: 'https://api' }, driverProof: () => ({ driverCpf: '12345678901' }),
    limparCache: () => calls.push('limparCache'), ouvir: () => calls.push('ouvir'), alert: m => alerts.push(m),
    CustomEvent: class { constructor(name, init) { this.name = name; this.detail = init.detail; } },
    window: { dispatchEvent: e => events.push(e.name), location },
    navigator: { geolocation: { getCurrentPosition: (ok, fail) => gps(ok, fail, calls) } },
    fetch: async (url) => { calls.push(url.replace('https://api', '')); return url.includes('notify-client') ? { ok: notify.ok, json: async () => notify.body } : { ok: true, json: async () => ({}) }; },
    setTimeout, Promise
  });
  const handler = vm.runInContext(handlerSource, ctx);
  return { run: handler, btn, calls, alerts, events, location };
}
test('client is notified first even when the GPS is blocked; the panel keeps trying the GPS', async () => {
  const h = harness({ gps: (_ok, fail) => setTimeout(() => fail({ code: 1 }), 5) });
  await h.run();
  assert.equal(h.calls[0], '/api/rides/ride1/notify-client');
  assert.deepEqual(h.events, ['motoja:ride-gps-start']);
  assert.match(h.alerts[0], /Cliente avisado, mas a localizacao esta bloqueada/);
  assert.equal(h.location.href, 'https://wa.me/551999');
  assert.equal(h.btn.textContent, 'Cliente avisado - GPS ativo');
});
test('a slow GPS does not delay the notice; the first position is sent after it answers', async () => {
  let release;
  const h = harness({ gps: (ok) => { release = () => ok({ coords: { latitude: -22.3, longitude: -47.1, accuracy: 8 }, timestamp: 1 }); } });
  const running = h.run();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(h.calls[0], '/api/rides/ride1/notify-client');
  release(); await running;
  assert.ok(h.calls.includes('/api/rides/ride1/location'));
  assert.equal(h.alerts.length, 0); assert.equal(h.location.href, 'https://wa.me/551999');
});
test('a ride that already returned to pending shows a clear message and the button can be used again', async () => {
  const h = harness({ gps: (ok) => ok({ coords: { latitude: 1, longitude: 1 } }), notify: { ok: false, body: { error: 'corrida_nao_pertence_ao_motoboy' } } });
  await h.run();
  assert.match(h.alerts[0], /nao esta mais com voce/);
  assert.equal(h.btn.disabled, false); assert.deepEqual(h.events, []);
});
