import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const i = source.indexOf('function brWhatsappDigits(');
const j = source.indexOf("app.post('/api/rides', createRideLimiter", i);
const ctx = vm.createContext({ onlyDigits: (v) => String(v || '').replace(/\D/g, '') });
vm.runInContext(source.slice(i, j), ctx);

test('WhatsApp do cliente: tira o 55 do pais e barra numero cortado', () => {
  assert.equal(ctx.brWhatsappDigits('+55 (19) 99822-8123'), '19998228123');
  assert.equal(ctx.brWhatsappDigits('(19) 99822-8123'), '19998228123');
  assert.equal(ctx.validBrWhatsapp('19998228123'), true);
  assert.equal(ctx.validBrWhatsapp('1932221234'), true, 'fixo com DDD');
  // O caso da Daniella: digitou com 55 e o campo cortou o final.
  assert.equal(ctx.validBrWhatsapp(ctx.brWhatsappDigits('55199982281')), false);
  assert.equal(ctx.validBrWhatsapp('0199822812'), false);
  assert.equal(ctx.validBrWhatsapp('199982'), false);
});
