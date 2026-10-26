import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  createDriverSessions, driverSessionValid, legacyProofAllowed, withNewSession, maskPhone,
  newDriverToken, DRIVER_LEGACY_UNTIL_MS, MAX_DRIVER_SESSIONS
} from '../src/driver-sessions.js';

const hashSecret = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const safeEqual = (a, b) => String(a) === String(b);
const CPF = '12345678901';

function setup(records = {}) {
  const store = new Map(Object.entries(records));
  const ref = path => ({ path, get: async () => snap(path), set: async (data, opts) => write(path, data, opts) });
  const snap = path => ({ exists: store.has(path), data: () => store.get(path), ref: ref(path) });
  function write(path, data, opts) { store.set(path, opts?.merge ? { ...(store.get(path) || {}), ...data } : { ...data }); }
  let queue = Promise.resolve();
  const db = {
    collection: name => ({ doc: id => ref(`${name}/${id}`) }),
    runTransaction: fn => {
      const run = queue.then(async () => {
        const writes = [];
        const r = await fn({ get: async x => snap(x.path), set: (x, d, o) => writes.push(['set', x.path, d, o]), delete: x => writes.push(['del', x.path]) });
        writes.forEach(([op, path, d, o]) => (op === 'del' ? store.delete(path) : write(path, d, o)));
        return r;
      });
      queue = run.catch(() => {});
      return run;
    }
  };
  const sent = [];
  let t = Date.UTC(2026, 9, 27, 15);
  let delivered = true;
  const api = createDriverSessions({
    db, admin: {}, hashSecret, safeEqual,
    sendText: async (number, text) => { sent.push({ number, text }); return { sent: delivered }; },
    now: () => t
  });
  const lastCode = () => sent.at(-1)?.text.match(/\*(\d{6})\*/)?.[1];
  return { store, api, sent, lastCode, tick: ms => { t += ms; }, failDelivery: () => { delivered = false; } };
}

const motoboy = (over = {}) => ({ 'motoboys/12345678901': { nome: 'Joao Silva', cpf: CPF, cnh: '11122233344', telefone: '19988887777', status: 'ativo', ...over } });

test('helpers: masked phone, token shape and at most 5 phones', () => {
  assert.equal(maskPhone('19988887777'), '(19) 9••••-7777');
  assert.match(newDriverToken(), /^md1\.[a-f0-9]{64}$/);
  let driver = {};
  for (let i = 0; i < 7; i += 1) driver = { sessoesApp: withNewSession(driver, `h${i}`, { now: i }) };
  assert.equal(driver.sessoesApp.length, MAX_DRIVER_SESSIONS);
  assert.equal(driver.sessoesApp[0].hash, 'h6', 'o mais novo primeiro');
  assert.equal(legacyProofAllowed({}, DRIVER_LEGACY_UNTIL_MS - 1), true);
  assert.equal(legacyProofAllowed({}, DRIVER_LEGACY_UNTIL_MS), false, 'acabou a transicao');
  assert.equal(legacyProofAllowed({ sessoesApp: [{ hash: 'x' }] }, 0), false, 'ja tem chave');
});

test('a registered motoboy gets the code on the registered WhatsApp, never on a typed number', async () => {
  const h = setup(motoboy());
  const r = await h.api.requestCode({ cpf: CPF, telefone: '11900000000' });
  assert.equal(r.para, '(19) 9••••-7777');
  assert.equal(h.sent[0].number, '5519988887777');
  await assert.rejects(h.api.requestCode({ cpf: CPF }), { code: 'aguarde_codigo' });
  await assert.rejects(h.api.verifyCode({ cpf: CPF, code: '000000' }), { code: 'codigo_incorreto' });
  const ok = await h.api.verifyCode({ cpf: CPF, code: h.lastCode(), aparelho: 'Android' });
  assert.equal(ok.novo, false);
  const driver = h.store.get('motoboys/12345678901');
  assert.equal(driverSessionValid(driver, ok.driverToken, hashSecret, safeEqual), true);
  assert.ok(!JSON.stringify(driver).includes(ok.driverToken), 'so o hash fica guardado');
  assert.match(h.sent.at(-1).text, /acesso foi aberto/);
  await assert.rejects(h.api.verifyCode({ cpf: CPF, code: '123456' }), { code: 'codigo_expirado' }, 'codigo de uso unico');
});

test('codes expire, lock after 5 wrong tries and are limited per hour', async () => {
  const h = setup(motoboy());
  await h.api.requestCode({ cpf: CPF });
  for (let i = 0; i < 5; i += 1) await assert.rejects(h.api.verifyCode({ cpf: CPF, code: '000000' }), { code: 'codigo_incorreto' });
  await assert.rejects(h.api.verifyCode({ cpf: CPF, code: h.lastCode() }), { code: 'codigo_expirado' }, 'travado apos 5 erros');
  h.tick(61000);
  await h.api.requestCode({ cpf: CPF });
  h.tick(11 * 60000);
  await assert.rejects(h.api.verifyCode({ cpf: CPF, code: h.lastCode() }), { code: 'codigo_expirado' }, 'venceu em 10 min');
  for (let i = 0; i < 3; i += 1) { h.tick(61000); await h.api.requestCode({ cpf: CPF }); }
  h.tick(61000);
  await assert.rejects(h.api.requestCode({ cpf: CPF }), { code: 'muitos_codigos' });
});

test('new sign-up: code goes to the typed number and the verification only works once, for that number', async () => {
  const h = setup();
  await assert.rejects(h.api.requestCode({ cpf: CPF }), { code: 'motoboy_nao_cadastrado' });
  await h.api.requestCode({ cpf: CPF, telefone: '(19) 97777-6666' });
  assert.equal(h.sent[0].number, '5519977776666');
  const v = await h.api.verifyCode({ cpf: CPF, code: h.lastCode() });
  assert.equal(v.novo, true);
  await assert.rejects(h.api.consumeVerification(CPF, v.verificationToken, '19911112222'), { code: 'whatsapp_nao_confirmado' }, 'outro numero');
  assert.equal(await h.api.consumeVerification(CPF, v.verificationToken, '19977776666'), true);
  await assert.rejects(h.api.consumeVerification(CPF, v.verificationToken, '19977776666'), { code: 'whatsapp_nao_confirmado' }, 'uso unico');
});

test('if WhatsApp is down the motoboy can ask again right away', async () => {
  const h = setup(motoboy());
  h.failDelivery();
  await assert.rejects(h.api.requestCode({ cpf: CPF }), { code: 'whatsapp_indisponivel' });
  await assert.rejects(h.api.requestCode({ cpf: CPF }), { code: 'whatsapp_indisponivel' }, 'sem esperar 1 minuto');
});

test('the old app trades CNH + phone for a key once, only during the transition', async () => {
  const h = setup(motoboy());
  const legacy = (driver, body) => { if (body.driverCnh !== driver.cnh || body.driverTelefone !== driver.telefone) { const e = new Error('x'); e.status = 401; throw e; } };
  await assert.rejects(h.api.upgradeLegacy(CPF, { driverCnh: '000', driverTelefone: '19988887777' }, { assertLegacyProof: legacy }), { status: 401 });
  const r = await h.api.upgradeLegacy(CPF, { driverCnh: '11122233344', driverTelefone: '19988887777' }, { assertLegacyProof: legacy });
  assert.match(r.driverToken, /^md1\./);
  assert.match(h.sent.at(-1).text, /login seguro/);
  await assert.rejects(h.api.upgradeLegacy(CPF, { driverCnh: '11122233344', driverTelefone: '19988887777' }, { assertLegacyProof: legacy }), { code: 'sessao_motoboy_obrigatoria' }, 'depois da primeira chave, nao vale mais');
  await h.api.revokeAll(CPF);
  assert.deepEqual(h.store.get('motoboys/12345678901').sessoesApp, []);
});

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
function slice(start, end) { const a = source.indexOf(start); const b = source.indexOf(end, a + start.length); assert.ok(a >= 0 && b > a, start); return source.slice(a, b); }

test('the server accepts the phone key, and CNH + phone only for motoboys without a key during the transition', () => {
  const context = vm.createContext({ onlyDigits: v => String(v || '').replace(/\D/g, ''), hashSecret, safeEqual, driverSessionValid, legacyProofAllowed, Error, String });
  vm.runInContext(slice('function assertDriverProof(', 'async function getDriverWithProof('), context);
  const token = newDriverToken();
  const withKey = { cnh: '111', telefone: '222', sessoesApp: [{ hash: hashSecret(token) }] };
  const old = { cnh: '111', telefone: '222' };
  assert.doesNotThrow(() => context.assertDriverProof(withKey, { driverToken: token }));
  assert.throws(() => context.assertDriverProof(withKey, { driverToken: newDriverToken() }), { code: 'sessao_motoboy_invalida' });
  assert.throws(() => context.assertDriverProof(withKey, { driverCnh: '111', driverTelefone: '222' }), { code: 'sessao_motoboy_obrigatoria' }, 'quem tem chave nao entra mais com CNH + telefone');
  if (Date.now() < DRIVER_LEGACY_UNTIL_MS) assert.doesNotThrow(() => context.assertDriverProof(old, { driverCnh: '111', driverTelefone: '222' }));
  assert.throws(() => context.assertDriverProof(old, { driverCnh: '111', driverTelefone: '222' }, { requireSession: true }), { code: 'sessao_motoboy_obrigatoria' });
});

test('sign-up and payment account changes are closed to CPF-only access', () => {
  const register = slice("app.post('/api/drivers/register'", "app.post('/api/drivers/:cpf/car/status'");
  assert.doesNotMatch(register, /req\.body\.cnh \|\| savedDriver\.cnh/, 'CNH nunca vem do cadastro salvo para quem nao tem chave');
  assert.doesNotMatch(register, /req\.body\.telefone \|\| savedDriver\.telefone/);
  assert.match(register, /consumeVerification\(cpf, req\.body\.verificationToken, telefone\)/);
  const oauth = slice("app.post('/api/drivers/:cpf/mercadopago/oauth-link'", "app.post('/api/rides/:rideId/location'");
  assert.match(oauth, /getDriverWithProof\(driverCpf, req\.body, \{ requireSession: true \}\)/);
  const me = slice("app.post('/api/drivers/:cpf/me'", "app.post('/api/admin/drivers/:cpf/sessions/revoke'");
  assert.match(me, /requireSession: true/);
  assert.doesNotMatch(slice('function driverAppProfile(', 'function driverBlockedResponse('), /mercadoPago|sessoesApp|accessToken/);
});
