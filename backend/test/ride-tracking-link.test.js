import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
function slice(a, b) { const i = source.indexOf(a); const j = source.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, a); return source.slice(i, j); }
const hash = (v) => crypto.createHash('sha256').update(String(v || '')).digest('hex');

test('the WhatsApp tracking link opens on the MotoJa site and only its own ride', async () => {
  const ctx = vm.createContext({ process: { env: { DATA_ENCRYPTION_KEY: 'segredo' } }, hashSecret: hash, ownerPasswordValue: () => '', BACKEND_BASE_URL: 'https://api',
    appUrl: (p) => p, encodeURIComponent, String,
    safeEqual: (a, b) => a === b, validDeviceId: () => '', findCustomerSession: async () => null });
  vm.runInContext(slice('function rideLinkToken(', 'function clientWhatsappNumber(') + slice('async function canReadRideTracking(', "app.get('/api/rides/:rideId/status'"), ctx);
  const url = new URL(ctx.rideTrackingUrl('r1'));
  assert.equal(url.origin + url.pathname, 'https://nexusmotoja.com.br/acompanhar.html');
  assert.equal(url.searchParams.get('c'), 'r1');
  const token = url.searchParams.get('t');
  assert.match(token, /^[a-f0-9]{32}$/);
  const req = (link) => ({ header: (n) => (n === 'x-ride-link' ? link : '') });
  assert.equal(await ctx.canReadRideTracking(req(token), { rideId: 'r1' }), true);
  assert.equal(await ctx.canReadRideTracking(req(token), { rideId: 'r2' }), false, 'a chave de uma corrida nao abre outra');
  assert.equal(await ctx.canReadRideTracking(req(token), {}), false, 'chat e avaliacao nao aceitam o link');
  assert.equal(await ctx.canReadRideTracking(req(''), { rideId: 'r1' }), false);
  // As mensagens do WhatsApp usam o link novo, nao o endereco do servidor.
  assert.equal((source.match(/rideTrackingUrl\(/g) || []).length >= 3, true);
  assert.doesNotMatch(source, /\$\{BACKEND_BASE_URL\}\/corrida\//);
});
