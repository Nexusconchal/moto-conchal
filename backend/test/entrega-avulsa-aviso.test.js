import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { iosAlert } from '../src/ios-push.js';

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const slice = (a, b) => { const i = source.indexOf(a); const j = source.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, a); return source.slice(i, j); };
const sent = [];
const ctx = vm.createContext({
  process: { env: { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: 'g' } }, JSON, Number, String,
  money: (v) => Math.round(Number(v || 0) * 100) / 100, RIDE_EXPIRE_MINUTES: 10,
  driverGainText: () => 'R$ 5,00',
  rideOperatingCity: () => 'conchal', rideCityLabel: () => 'Conchal', telegramGroupChat: () => 'g',
  appUrl: (p) => `https://site${p}`, escapeTelegram: (v) => String(v), androidCallConfig: () => ({}), iosAlert,
  fetch: async (_url, init) => { sent.push(JSON.parse(init.body).text); return { ok: true, json: async () => ({ result: { message_id: 1 } }) }; }
});
vm.runInContext(slice('function isStandaloneDelivery(', 'function standaloneDeliveryData(') + slice('async function notifyTelegramAboutRide(', 'async function notifyTelegramAboutDelivery(') + slice('function rideOfferPush(', '// App Android com alerta continuo'), ctx);

const avulsa = { modalidade: 'entrega_avulsa', nome: 'Ana', valor: 6.5, km: 2, origem: 'Rua A, 10', destino: 'Rua B, 20', itemEntrega: 'Documentos', nomeRecebedor: 'Joao' };

test('entrega avulsa toca como ENTREGA (leve a bag), nao como corrida', async () => {
  await ctx.notifyTelegramAboutRide('r1', avulsa);
  assert.match(sent.at(-1), /NOVA ENTREGA AVULSA TOCANDO/);
  assert.match(sent.at(-1), /Leve a bag/);
  assert.match(sent.at(-1), /Levar:<\/b> Documentos/);
  assert.match(sent.at(-1), /Quem recebe:<\/b> Joao/);
  assert.doesNotMatch(sent.at(-1), /NOVA CORRIDA/);
  const push = ctx.rideOfferPush('r1', avulsa, ['tk']);
  assert.match(push.notification.title, /Nova entrega avulsa/);
  assert.match(push.notification.body, /Leve a bag/);
  // So o ganho do motoboy aparece; o valor cobrado do cliente (R$ 6,50) nao.
  assert.match(sent.at(-1), /Você recebe:<\/b> R\$ 5,00/);
  assert.doesNotMatch(sent.at(-1), /6,50/);
  assert.match(push.notification.body, /você recebe R\$ 5,00/);
  assert.doesNotMatch(push.notification.body, /6,50/);
  // Corrida normal continua igual.
  await ctx.notifyTelegramAboutRide('r2', { ...avulsa, modalidade: 'corrida' });
  assert.match(sent.at(-1), /NOVA CORRIDA TOCANDO/);
  assert.match(ctx.rideOfferPush('r2', { ...avulsa, modalidade: 'corrida' }, ['tk']).notification.title, /Nova corrida/);
});
