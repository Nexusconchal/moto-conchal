import test from 'node:test';
import assert from 'node:assert/strict';
import { buscarResumoFood } from '../src/food-summary.js';

test('resumo do Food: sem configuração não chama ninguém', async () => {
  let chamou = false;
  const r = await buscarResumoFood({ env: {}, fetcher: async () => { chamou = true; } });
  assert.deepEqual(r, { configurado: false });
  assert.equal(chamou, false);
});

test('resumo do Food: manda a chave, respeita o período e repassa os números', async () => {
  let pedido;
  const fetcher = async (url, opcoes) => { pedido = { url, opcoes }; return { ok: true, status: 200, json: async () => ({ money: { platform: 419 } }) }; };
  const r = await buscarResumoFood({ dias: '7', env: { FOOD_URL: 'https://food.example.com/', FOOD_PLATFORM_KEY: 'chave-secreta' }, fetcher });
  assert.equal(pedido.url, 'https://food.example.com/api/platform/summary?days=7');
  assert.equal(pedido.opcoes.headers['x-motoja-key'], 'chave-secreta');
  assert.equal(r.configurado, true);
  assert.equal(r.money.platform, 419);
  await buscarResumoFood({ dias: '999', env: { FOOD_URL: 'https://f.example', FOOD_PLATFORM_KEY: 'k' }, fetcher });
  assert.match(pedido.url, /days=30$/);
});

test('resumo do Food: erro do Food vira erro 502 com a mensagem dele', async () => {
  const fetcher = async () => ({ ok: false, status: 403, json: async () => ({ message: 'Chave da plataforma inválida.' }) });
  await assert.rejects(() => buscarResumoFood({ env: { FOOD_URL: 'https://f.example', FOOD_PLATFORM_KEY: 'k' }, fetcher }), (e) => e.status === 502 && /Chave/.test(e.message));
});
