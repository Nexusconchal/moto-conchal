import test from 'node:test';
import assert from 'node:assert/strict';
import { eventoGanhoFood, pushChatFood } from '../src/food-bridge.js';

test('entrega do Food finalizada vira ganho de entrega no extrato, uma por pedido', () => {
  const e = eventoGanhoFood({ id: 'ped-1', code: '518824', storeName: 'Cantinho da Nana', at: '2026-11-27T13:40:00.000Z', share: 500, payment: 'dinheiro', collector: 'motoboy' }, '2026-11-27');
  assert.equal(e.serviceId, 'food-ped-1', 'mesmo id sempre: não conta duas vezes');
  assert.equal(e.tipo, 'entrega');
  assert.equal(e.ganhoCentavos, 500);
  assert.equal(e.quantidadeEntregas, 1);
  assert.equal(e.dia, '2026-11-27');
  assert.equal(e.finalizadaEmMs, Date.parse('2026-11-27T13:40:00.000Z'));
  assert.equal(e.forma, 'dinheiro');
  assert.match(e.titulo, /Cantinho da Nana · MotoJÁ Food/);
  const pago = eventoGanhoFood({ id: 'ped-2', share: 650, payment: 'pix', collector: 'motoja' }, '2026-11-27');
  assert.equal(pago.forma, 'app');
  assert.equal(pago.recebedor, 'motoja');
  assert.equal(eventoGanhoFood({ id: 'ped-3', share: 0 }, '2026-11-27').ganhoCentavos, 0, 'sem ganho não registra');
});

test('aviso de mensagem do chat do Food não leva o texto nem dados do cliente', () => {
  const p = pushChatFood({ orderId: 'ped-1', code: '518824', from: 'cliente' }, ['t1'], 'https://nexusmotoja.com.br/motoboy.html?aba=food');
  assert.match(p.notification.title, /Mensagem do cliente · pedido #518824/);
  assert.equal(p.data.tipo, 'chat_food');
  assert.equal(p.data.foodOrderId, 'ped-1');
  assert.match(pushChatFood({ orderId: 'x', from: 'loja' }, ['t'], '').notification.title, /da loja/);
});
