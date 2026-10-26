import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
function slice(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}

test('the owner panel never receives Mercado Pago tokens, password hashes or device ids', () => {
  const context = vm.createContext({});
  vm.runInContext(slice('const OWNER_HIDDEN_KEY', 'async function collectionState('), context);
  const motoboy = {
    nome: 'Joao', cpf: '12345678901', cnh: '999', telefone: '19999990000',
    mercadoPago: { userId: 77, accessToken: 'APP_USR-segredo', refreshToken: 'TG-segredo', publicKey: 'APP_USR-publica', liveMode: true },
    fcmTokens: { abc: { ativo: true } }
  };
  const payload = context.withoutSecrets({
    ok: true,
    motoboys: [motoboy],
    corridas: [{ id: 'r1', clienteDeviceId: 'aparelho-1', pagamento: { status: 'approved', initPoint: 'https://mp' } }],
    clientes: [{ passwordHash: 'h', passwordSalt: 's', sessionTokenHashes: ['x'], cpfEncrypted: 'e', cpfHash: 'c', nome: 'Ana' }]
  });
  const text = JSON.stringify(payload);
  for (const secret of ['APP_USR-segredo', 'TG-segredo', 'aparelho-1', 'passwordHash', 'passwordSalt', 'sessionTokenHashes', 'cpfEncrypted', 'cpfHash', 'fcmTokens']) {
    assert.ok(!text.includes(secret), secret);
  }
  assert.equal(payload.motoboys[0].mercadoPago.userId, 77);
  assert.equal(payload.motoboys[0].mercadoPago.publicKey, 'APP_USR-publica');
  assert.equal(payload.motoboys[0].cnh, '999', 'o dono continua vendo o cadastro');
  assert.equal(payload.corridas[0].pagamento.initPoint, 'https://mp');
  assert.match(source, /const payload = withoutSecrets\(\{ ok: true, corridas/);
});

test('wrong owner passwords are limited on every owner route, not only on login', () => {
  const context = vm.createContext({
    Map, Date, String, Buffer, crypto,
    process: { env: { OWNER_PASSWORD: 'senha-forte-do-dono' } }
  });
  vm.runInContext(slice('function ownerPasswordValue()', 'function driverPasswordValues()'), context);
  vm.runInContext(slice('function safeEqual(a, b)', 'function hashSecret('), context);
  vm.runInContext(slice('const OWNER_FAIL_WINDOW_MS', 'function safeEqual(a, b)'), context);
  const call = (password, ip = '1.2.3.4') => {
    let status = 200;
    let passed = false;
    const res = { status: (s) => { status = s; return res; }, json: () => res };
    context.assertOwner({ ip, header: () => password, body: {} }, res, () => { passed = true; });
    return passed ? 200 : status;
  };
  for (let i = 0; i < 10; i += 1) assert.equal(call('chute'), 401);
  assert.equal(call('senha-forte-do-dono'), 429, 'bloqueado mesmo com a senha certa depois de 10 erros');
  assert.equal(call('senha-forte-do-dono', '5.6.7.8'), 200, 'outro IP continua entrando');
  assert.match(slice("app.post('/api/admin/login'", '});'), /checkOwnerPassword/);
});
