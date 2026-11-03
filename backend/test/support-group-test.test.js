import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
function routeContext({ groupJid = '123@g.us', sendFails = false, state = 'open' } = {}) {
  const calls = [], notices = [];
  const ctx = vm.createContext({ console, String,
    supportInstancePath: 'support', authLimiter: 0, assertOwner: 0,
    supportAutomation: { config: async () => ({ driverGroupJid: groupJid }), recordGroupNotice: (status, error) => notices.push({ status, error }) },
    supportEvolution: async (path, method, body) => {
      calls.push({ path, body });
      if (path.startsWith('/instance/connectionState')) return { instance: { state } };
      if (sendFails) throw new Error('whatsapp_integracao_400');
      return { key: { id: 'x' } };
    },
    app: { post: (_p, ...h) => { ctx.handler = h.at(-1); } } });
  vm.runInContext(source.slice(source.indexOf('async function supportWhatsappConnection('), source.indexOf("app.get('/api/admin/support-automation'")), ctx);
  const start = source.indexOf("app.post('/api/admin/support-automation/test-group'");
  vm.runInContext(source.slice(start, source.indexOf("\napp.post(", start + 1)), ctx);
  const call = async () => { const out = { status: 200 }; const res = { status: c => { out.status = c; return res; }, json: d => { out.data = d; return res; } }; await ctx.handler({}, res); return out; };
  return { call, calls, notices, ctx };
}
test('owner test message goes to the drivers group and reports success', async () => {
  const h = routeContext();
  const out = await h.call();
  assert.equal(out.data.ok, true);
  assert.equal(h.calls[0].body.number, '123@g.us');
  assert.equal(h.notices.length, 1); assert.equal(h.notices[0].status, 'sent');
  assert.deepEqual({ ...(await h.ctx.supportWhatsappConnection()) }, { state: 'open', connected: true });
});
test('a failed test explains whether WhatsApp is disconnected or the group send failed', async () => {
  const disconnected = routeContext({ sendFails: true, state: 'close' });
  const a = await disconnected.call();
  assert.equal(a.status, 503); assert.match(a.data.message, /desconectado/); assert.equal(disconnected.notices[0].status, 'failed');
  const connected = routeContext({ sendFails: true, state: 'open' });
  assert.match((await connected.call()).data.message, /esta conectado, mas o envio no grupo falhou/);
  assert.equal((await routeContext({ groupJid: '' }).call()).status, 409);
});
