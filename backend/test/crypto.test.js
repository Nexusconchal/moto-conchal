import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('function encryptionKeySources()'), source.indexOf('\nfunction passwordHash('));
function harness(env = {}) {
  const context = vm.createContext({ crypto, Buffer, process: { env }, ownerPasswordValue: () => env.OWNER_PASSWORD || '' });
  vm.runInContext(code, context);
  return context;
}
function legacyEncrypt(text, secret) {
  const key = crypto.createHash('sha256').update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((b) => b.toString('base64')).join('.');
}

test('existing records and old readers remain compatible, including Unicode', () => {
  const env = { DATA_ENCRYPTION_KEY: 'test-only-secret' };
  const h = harness(env), text = 'CPF e integração: ação 🔐';
  assert.equal(h.decryptSecret(legacyEncrypt(text, env.DATA_ENCRYPTION_KEY)), text);
  const encrypted = h.encryptSecret(text), [iv, tag, data] = encrypted.split('.').map((v) => Buffer.from(v, 'base64'));
  const oldReader = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(env.DATA_ENCRYPTION_KEY).digest(), iv);
  oldReader.setAuthTag(tag);
  assert.equal(Buffer.concat([oldReader.update(data), oldReader.final()]).toString('utf8'), text);
  assert.notEqual(encrypted, h.encryptSecret(text));
});

test('key rotation reads historical records but always writes with the current key', () => {
  const h = harness({ DATA_ENCRYPTION_KEY: 'new-test-key', DATA_ENCRYPTION_PREVIOUS_KEYS: JSON.stringify(['old-test-key']) });
  assert.equal(h.decryptSecret(legacyEncrypt('saved', 'old-test-key')), 'saved');
  assert.equal(harness({ DATA_ENCRYPTION_KEY: 'new-test-key' }).decryptSecret(h.encryptSecret('new')), 'new');
  assert.throws(() => harness({ DATA_ENCRYPTION_KEY: 'old-test-key' }).decryptSecret(h.encryptSecret('new')));
});

test('rejects altered IV, tag, ciphertext, truncated tags and extra fields', () => {
  const h = harness({ DATA_ENCRYPTION_KEY: 'test-only-secret' }), valid = h.encryptSecret('private data');
  for (let i = 0; i < 3; i++) {
    const parts = valid.split('.'), bytes = Buffer.from(parts[i], 'base64');
    bytes[0] ^= 1; parts[i] = bytes.toString('base64');
    assert.throws(() => h.decryptSecret(parts.join('.')));
  }
  const short = valid.split('.'); short[1] = Buffer.from(short[1], 'base64').subarray(0, 8).toString('base64');
  assert.throws(() => h.decryptSecret(short.join('.')));
  assert.throws(() => h.decryptSecret(valid + '.extra'));
  assert.throws(() => h.decryptSecret('not-base64.tag.data'));
});

test('keeps owner-key fallback and missing-value behavior; malformed optional config does not break valid reads', () => {
  const h = harness({ OWNER_PASSWORD: 'owner-test-key', DATA_ENCRYPTION_PREVIOUS_KEYS: '{invalid' });
  assert.equal(h.decryptSecret(legacyEncrypt('saved', 'owner-test-key')), 'saved');
  assert.equal(h.decryptSecret(''), '');
  assert.equal(h.encryptSecret(''), '');
  assert.equal(harness().encryptSecret('value'), '');
  assert.equal(harness().decryptSecret('value'), '');
});
