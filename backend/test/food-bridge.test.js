import test from 'node:test';
import { reconcileCallOffers } from '../src/driver-call-alerts.js';
import assert from 'node:assert/strict';
import { FOOD_OFFER_MS, idOfertaFood, pedidoDaOferta, avaliacaoFood, avisoFood, chamarFood, chaveFoodConfere, foodConfigurado, motoboyParaFood, pushEntregaFood } from '../src/food-bridge.js';

const CHAVE = 'chave-de-teste-da-plataforma-123456';
const env = { FOOD_URL: 'https://food.example.com/', FOOD_PLATFORM_KEY: CHAVE };

test('ponte Food: desligada sem endereço ou com chave curta', () => {
  assert.equal(foodConfigurado({}), false);
  assert.equal(foodConfigurado({ FOOD_URL: 'https://f.example', FOOD_PLATFORM_KEY: 'curta' }), false);
  assert.equal(foodConfigurado(env), true);
});

test('ponte Food: cidade do GPS vira a cidade do Food; com Entregas desligado não recebe novas', () => {
  assert.deepEqual(motoboyParaFood('52998224725', { nome: 'João' }, { cidade: 'engenheiro_coelho' }), { cpf: '52998224725', name: 'João', cities: ['engenheiro-coelho'] });
  assert.deepEqual(motoboyParaFood('52998224725', { nome: 'João' }, { cidade: 'conchal', recebeEntregas: false }).cities, []);
});

test('ponte Food: chama o Food com a chave e repassa erro do motoboy com a mensagem dele', async () => {
  let pedido;
  const ok = async (url, opcoes) => { pedido = { url, opcoes }; return { ok: true, status: 200, json: async () => ({ deliveries: [{ id: 'a1' }] }) }; };
  const r = await chamarFood('deliveries/a1/accept', { cpf: '52998224725' }, { env, fetcher: ok });
  assert.equal(pedido.url, 'https://food.example.com/api/platform/deliveries/a1/accept');
  assert.equal(pedido.opcoes.headers['x-motoja-key'], CHAVE);
  assert.equal(JSON.parse(pedido.opcoes.body).cpf, '52998224725');
  assert.equal(r.deliveries[0].id, 'a1');
  const codigo = async () => ({ ok: false, status: 422, json: async () => ({ error: 'code_invalid', message: 'Código incorreto.' }) });
  await assert.rejects(() => chamarFood('deliveries/a1/deliver', {}, { env, fetcher: codigo }), (e) => e.status === 422 && e.code === 'code_invalid' && /Código/.test(e.message));
  const caiu = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(() => chamarFood('deliveries', {}, { env, fetcher: caiu }), (e) => e.status === 502);
});

test('ponte Food: aviso de pedido pronto confere a chave e não leva dados do cliente', () => {
  assert.equal(chaveFoodConfere(CHAVE, env), true);
  assert.equal(chaveFoodConfere('outra-chave-de-teste-da-plataforma-1', env), false);
  assert.equal(chaveFoodConfere('', { FOOD_PLATFORM_KEY: '' }), false);
  assert.equal(avisoFood({ orderId: 'x', city: 'sao-paulo' }), null);
  const aviso = avisoFood({ orderId: 'abc-1', city: 'engenheiro-coelho', storeName: 'Burger', district: 'Centro', fee: 750, earning: 600, distanceKm: 3.4, phone: '19999990000' });
  assert.deepEqual(aviso, { orderId: 'abc-1', cidade: 'engenheiro_coelho', loja: 'Burger', bairro: 'Centro', frete: 600, km: 3.4 });
  const push = pushEntregaFood(aviso, ['t1'], 'https://nexusmotoja.com.br/motoboy.html?aba=food');
  assert.match(push.notification.body, /Burger • Centro • 3,4 km • você ganha R\$\s?6,00/);
  assert.equal(push.data.foodOrderId, 'abc-1');
  assert.deepEqual(push.tokens, ['t1']);
});

test('ponte Food: nota do motoboy confere CPF, nota de 1 a 5 e o pedido', () => {
  assert.equal(avaliacaoFood({ cpf: '123', nota: 5, orderId: 'a1' }), null);
  assert.equal(avaliacaoFood({ cpf: '52998224725', nota: 6, orderId: 'a1' }), null);
  assert.equal(avaliacaoFood({ cpf: '52998224725', nota: 4, orderId: '../x' }), null);
  const a = avaliacaoFood({ cpf: '529.982.247-25', nota: 4, orderId: 'abc-1', comentario: 'Rápido', loja: 'Burger', cidade: 'engenheiro-coelho' });
  assert.deepEqual(a, { cpf: '52998224725', nota: 4, orderId: 'abc-1', comentario: 'Rápido', loja: 'Burger', cidade: 'engenheiro_coelho' });
});

test('ponte Food: entrega do Food toca no alerta contínuo como "deliveries" com id food-<pedido>', async () => {
  assert.equal(idOfertaFood('abc-1'), 'food-abc-1');
  assert.equal(pedidoDaOferta('food-abc-1'), 'abc-1');
  assert.equal(pedidoDaOferta('abc-1'), null);
  assert.equal(pedidoDaOferta('food-../x'), null);
  // O app Android 1.0.5 só aceita rides/deliveries com id [a-zA-Z0-9_-]{1,120}.
  assert.match(idOfertaFood('3f2a9c1e-1b2c-4d5e-8f90-123456789abc'), /^[a-zA-Z0-9_-]{1,120}$/);
  const abertas = new Set(['p1']);
  const now = Date.now();
  const load = async (kind, id) => { const pedido = pedidoDaOferta(id); return pedido && abertas.has(pedido) ? { status: 'pendente', expiraEmMs: now + FOOD_OFFER_MS, food: true } : null; };
  const offers = await reconcileCallOffers([{ kind: 'deliveries', id: 'food-p1' }, { kind: 'deliveries', id: 'food-p2' }], { load, allowed: (kind, job) => job.food === true, now });
  assert.deepEqual(offers.map((o) => o.id), ['food-p1'], 'pedido aceito por outro para de tocar');
});
