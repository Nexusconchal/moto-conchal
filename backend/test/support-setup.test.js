import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { chooseDriverGroup, brazilPhone, SUPPORT_PHONE } from '../src/support-automation.js';

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const route = source.slice(source.indexOf("app.post('/api/admin/support-automation/setup'"), source.indexOf("app.post('/api/admin/support-automation/pause'"));
async function run({ previous = null, owner = SUPPORT_PHONE, groups = [{ id: '123@g.us', subject: 'Nexus MotoJÁ - MOTORISTA' }], discardHeaders = false } = {}) {
  let handler, providerWebhook, status = 200, body;
  const config = {}, writes = [];
  const ctx = vm.createContext({
    app: { post(_path, ...callbacks) { handler = callbacks.at(-1); } }, authLimiter: null, assertOwner: null,
    supportInstance: 'support', supportInstancePath: 'support', BACKEND_BASE_URL: 'https://backend.example', SUPPORT_PHONE, brazilPhone, chooseDriverGroup, crypto,
    encryptSecret: value => `encrypted:${value}`, decryptSecret: value => value.slice('encrypted:'.length),
    supportAutomation: { config: async () => config, saveConfig: async data => { Object.assign(config, data); } },
    async supportEvolution(path, method, data) {
      if (path.includes('fetchInstances')) return [{ name: 'support', connectionStatus: 'open', ownerJid: `${owner}@s.whatsapp.net` }];
      if (path.includes('fetchAllGroups')) return groups;
      if (path.includes('/webhook/find')) return providerWebhook || previous;
      if (path.includes('/webhook/set')) { writes.push(data); providerWebhook = { ...data.webhook, ...(discardHeaders ? { headers: {} } : {}) }; return {}; }
      throw new Error('unexpected path');
    }
  });
  vm.runInContext(route, ctx);
  const res = { status(code) { status = code; return res; }, json(data) { body = data; return res; } };
  await handler({}, res); return { status, body, writes, config };
}
test('an unconfigured provider returns null and setup safely creates and verifies webhook', async () => {
  const result = await run(); assert.equal(result.status, 200); assert.equal(result.config.enabled, true);
  assert.equal(result.writes.length, 1); assert.equal(result.writes[0].webhook.base64, false);
  assert.equal(result.writes[0].webhook.headers['x-motoja-webhook-secret'].length, 64);
});
test('preserves an existing unrelated integration and rejects the wrong account', async () => {
  for (const options of [{ previous: { enabled: true, url: 'https://other.example' } }, { owner: '5519888880000' }]) {
    const result = await run(options); assert.equal(result.status, 409); assert.equal(result.writes.length, 0); assert.notEqual(result.config.enabled, true);
  }
});
test('requires an unambiguous driver group and verified authentication header before enabling', async () => {
  const missing = await run({ groups: [] }); assert.equal(missing.status, 409); assert.equal(missing.writes.length, 0);
  const insecure = await run({ discardHeaders: true }); assert.equal(insecure.status, 503); assert.notEqual(insecure.config.enabled, true);
});
