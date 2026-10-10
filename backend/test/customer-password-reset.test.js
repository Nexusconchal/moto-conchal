import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const cpf = '52998224725', phone = '19999990000', device = 'device-abcdef1234567890';
const hash = v => crypto.createHash('sha256').update(String(v)).digest('hex');
function harness({ sent = true } = {}) {
  const records = new Map(), messages = [], routes = {};
  const ref = path => ({ path, id: path.split('/').at(-1), get: async () => snap(path), set: async (data, opt) => records.set(path, opt?.merge ? { ...records.get(path), ...data } : data) });
  const snap = path => ({ exists: records.has(path), data: () => records.get(path), ref: ref(path), id: path.split('/').at(-1) });
  const db = {
    collection: name => ({ doc: id => ref(`${name}/${id}`), where: (field, _op, value) => ({ limit: () => ({ get: async () => {
      const docs = [...records.entries()].filter(([p, d]) => p.startsWith(`${name}/`) && p.split('/').length === 2 && d[field] === value).map(([p]) => snap(p));
      return { empty: !docs.length, docs };
    } }) }) }),
    runTransaction: async fn => { const pending = []; await fn({ get: async r => snap(r.path), set: (r, d, o) => pending.push(['set', r, d, o]), delete: r => pending.push(['delete', r]) });
      for (const [kind, r, d, o] of pending) {
        if (kind === 'delete') { records.delete(r.path); continue; }
        const prev = records.get(r.path) || {};
        const data = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v?.inc ? Number(prev[k] || 0) + v.inc : v]));
        records.set(r.path, o?.merge ? { ...prev, ...data } : data);
      } }
  };
  const ctx = vm.createContext({ db, crypto, Date, Number, String, CUSTOMER_OTP_MS: 600000,
    hashSecret: hash, onlyDigits: v => String(v || '').replace(/\D/g, ''), validCpf: v => v === cpf || v === '11144477735', validDeviceId: v => String(v || '').length >= 16 ? String(v) : '',
    customerProfileComplete: c => !!c.nome, safeEqual: (a, b) => a === b,
    passwordHash: p => ({ salt: 's', hash: hash(`s:${p}`) }),
    sendEvolutionText: async (to, text) => { messages.push({ to, text }); return { sent }; },
    issueCustomerSession: async r => { await r.set({ sessionTokenHash: 'new' }, { merge: true }); return 'token-1'; },
    publicCustomer: (d, id) => ({ id, nome: d.nome }),
    admin: { firestore: { FieldValue: { serverTimestamp: () => 'TS', increment: n => ({ inc: n }) } } },
    customerOtpLimiter: 0, authLimiter: 0, app: { post: (path, ...h) => { routes[path] = h.at(-1); } } });
  const start = source.indexOf('function customerPasswordResetRef(');
  vm.runInContext(source.slice(start, source.indexOf("app.post('/api/customers/logout'", start)), ctx);
  async function call(path, body) {
    let out = { status: 200 }, failure; const res = { status: c => { out.status = c; return res; }, json: d => { out.data = d; return res; } };
    await routes[path]({ body }, res, e => { failure = e; }); if (failure) throw failure; return out;
  }
  records.set(`clientes/${phone}`, { nome: 'Cliente', telefoneCliente: phone, cpfHash: hash(cpf), passwordSalt: 's', passwordHash: hash('s:antiga'), sessionTokenHash: 'old' });
  return { records, messages, call };
}
const codeFrom = h => h.messages.at(-1).text.match(/\d{6}/)[0];
test('the code goes only to the WhatsApp saved on the account and the new password replaces the old one', async () => {
  const h = harness();
  const r = await h.call('/api/customers/password-reset/request', { cpf, deviceId: device, telefoneCliente: '11988887777' });
  assert.equal(r.data.ok, true); assert.equal(h.messages.length, 1); assert.equal(h.messages[0].to, `55${phone}`);
  const ok = await h.call('/api/customers/password-reset/confirm', { cpf, deviceId: device, code: codeFrom(h), password: 'novaSenha1' });
  assert.equal(ok.data.ok, true); assert.equal(ok.data.token, 'token-1');
  const saved = h.records.get(`clientes/${phone}`);
  assert.equal(saved.passwordHash, hash('s:novaSenha1')); assert.equal(saved.sessionTokenHash, 'new');
  // The code cannot be reused.
  const again = await h.call('/api/customers/password-reset/confirm', { cpf, deviceId: device, code: codeFrom(h), password: 'outra123' });
  assert.equal(again.status, 400); assert.equal(h.records.get(`clientes/${phone}`).passwordHash, hash('s:novaSenha1'));
});
test('unknown CPF gets the same answer and no message; wrong codes are limited to 5 attempts', async () => {
  const h = harness();
  const unknown = await h.call('/api/customers/password-reset/request', { cpf: '11144477735', deviceId: device });
  assert.equal(unknown.status, 200); assert.equal(h.messages.length, 0);
  await h.call('/api/customers/password-reset/request', { cpf, deviceId: device });
  const real = codeFrom(h), wrong = real === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await h.call('/api/customers/password-reset/confirm', { cpf, deviceId: device, code: wrong, password: 'novaSenha1' })).data.error, 'codigo_incorreto');
  const locked = await h.call('/api/customers/password-reset/confirm', { cpf, deviceId: device, code: real, password: 'novaSenha1' });
  assert.equal(locked.data.error, 'codigo_expirado'); assert.equal(h.records.get(`clientes/${phone}`).passwordHash, hash('s:antiga'));
});
test('another device, a short password or WhatsApp outage never change the password', async () => {
  const h = harness();
  await h.call('/api/customers/password-reset/request', { cpf, deviceId: device });
  const other = await h.call('/api/customers/password-reset/confirm', { cpf, deviceId: 'other-device-123456789', code: codeFrom(h), password: 'novaSenha1' });
  assert.equal(other.status, 400);
  assert.equal((await h.call('/api/customers/password-reset/confirm', { cpf, deviceId: device, code: codeFrom(h), password: '123' })).data.error, 'senha_invalida');
  assert.equal(h.records.get(`clientes/${phone}`).passwordHash, hash('s:antiga'));
  const down = harness({ sent: false });
  assert.equal((await down.call('/api/customers/password-reset/request', { cpf, deviceId: device })).status, 503);
  assert.equal([...down.records.keys()].some(k => k.startsWith('customerPasswordReset/')), false);
});
