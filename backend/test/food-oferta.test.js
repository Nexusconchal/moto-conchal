import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { avisoFood, pushEntregaFood, textoGrupoFood, idOfertaFood, FOOD_OFFER_MS } from '../src/food-bridge.js';

const aviso = avisoFood({ orderId: 'ped-1', city: 'conchal', storeName: 'Cantinho da Nana', district: 'Jardim das Palmeiras', fee: 650, earning: 500, distanceKm: 0.89 });

test('grupo do Food mostra só o que o motoboy ganha, a loja e o bairro', () => {
  const texto = textoGrupoFood(aviso, 'https://nexusmotoja.com.br/motoboy.html?aba=food');
  assert.match(texto, /você recebe R\$\s?5,00/);
  assert.match(texto, /Loja: Cantinho da Nana/);
  assert.match(texto, /bairro: Jardim das Palmeiras/);
  assert.match(texto, /0,89 km/);
  assert.doesNotMatch(texto, /6,50/, 'nunca o valor cheio do frete');
});

// Roda a rota /api/food/notify do server.js de verdade com push, grupos e chave falsos.
function rotaNotify() {
  // O checkout no Windows pode estar com CRLF: normaliza para achar os trechos.
  const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8').split(String.fromCharCode(13)).join('');
  const ini = source.indexOf("app.post('/api/food/notify'");
  const fim = source.indexOf('\n});', ini) + 4;
  const fn = source.indexOf('const foodGruposAvisados');
  const fnFim = source.indexOf('\n}\n', source.indexOf('async function avisarGruposFood')) + 3;
  const enviados = { push: [], telegram: [], whatsapp: [] };
  const routes = {};
  const ctx = vm.createContext({
    app: { post: (p, h) => { routes[p] = h; } }, console, Date, Map, Promise, JSON, String, AbortSignal,
    process: { env: { TELEGRAM_BOT_TOKEN: 'tok', APP_BASE_URL: '' } },
    chaveFoodConfere: (k) => k === 'chave', avisoFood, pushEntregaFood, textoGrupoFood, idOfertaFood, FOOD_OFFER_MS,
    availableDriverTokens: async () => ['t1'], driverWantsDeliveryIn: () => true, appUrl: (p) => p,
    androidCallConfig: (tag) => ({ notification: { sound: 'chamada', tag } }), iosAlert: (tag) => ({ payload: { aps: { sound: 'chamada.wav' } }, tag }),
    callPush: { offer: async (msg, meta) => { enviados.push.push({ msg, meta }); return { successCount: 1 }; } },
    telegramGroupChat: () => '-100', fetch: async (url, opts) => { enviados.telegram.push(JSON.parse(opts.body)); return { ok: true }; },
    supportAutomation: { config: async () => ({ enabled: true, groupAlerts: true }) },
    whatsappGroupFor: async () => 'grupo@g.us', sendEvolutionText: async (to, text) => { enviados.whatsapp.push({ to, text }); return { sent: true }; },
  });
  vm.runInContext(source.slice(fn, fnFim) + source.slice(ini, fim), ctx);
  return { handler: routes['/api/food/notify'], enviados };
}

const PRAZO = Date.now() + 15 * 60000;
test('aviso do Food: toca como chamada e vai aos grupos do Telegram e do WhatsApp uma vez só', async () => {
  const { handler, enviados } = rotaNotify();
  const chamar = async () => { const out = {}; const res = { status: (c) => { out.status = c; return res; }, json: (d) => { out.data = d; return res; } }; await handler({ get: () => 'chave', body: { orderId: 'ped-1', city: 'conchal', storeName: 'Cantinho da Nana', district: 'Centro', fee: 650, earning: 500, callUntil: PRAZO } }, res, (e) => { throw e; }); return out; };
  const r = await chamar();
  await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(r.data.sent, 1);
  assert.equal(enviados.push[0].msg.android.notification.sound, 'chamada', 'Android toca o som de chamada');
  assert.equal(enviados.push[0].msg.apns.payload.aps.sound, 'chamada.wav', 'iPhone toca o som de chamada');
  assert.equal(enviados.push[0].meta.id, 'food-ped-1');
  assert.equal(enviados.telegram.length, 1);
  assert.match(enviados.telegram[0].text, /você recebe R\$\s?5,00/);
  assert.equal(enviados.whatsapp.length, 1);
  assert.equal(enviados.whatsapp[0].to, 'grupo@g.us');
  await chamar();
  await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(enviados.telegram.length, 1, 'o mesmo pedido não repete no grupo');
  assert.equal(enviados.whatsapp.length, 1);
});
