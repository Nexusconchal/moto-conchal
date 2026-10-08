import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { isUnsentLegacyImport, integrationDeliveryId } from '../src/integration-state.js';

test('legacy accepted marker can be retried, but unknown records cannot', () => {
  assert.equal(isUnsentLegacyImport({ aceitoEmMs: 1 }), true);
  for (const record of [null, {}, { aceitoEmMs: 1, entregaId: 'a' }, { aceitoEmMs: 1, deliveryId: 'b' }, { aceitoEmMs: 1, status: 'cancelado' }, { aceitoEmMs: 1, status: 'enviado_motoboy' }, { aceitoEmMs: 1, canceladoEmMs: 2 }]) assert.equal(isUnsentLegacyImport(record), false);
});
test('delivery keys isolate stores and providers even with identical order numbers', () => {
  const a = integrationDeliveryId('store1', 'PediPlus', '1110');
  assert.equal(a, integrationDeliveryId('store1', 'PediPlus', '1110'));
  assert.notEqual(a, integrationDeliveryId('store2', 'PediPlus', '1110'));
  assert.notEqual(a, integrationDeliveryId('store1', 'Cardapio Web', '1110'));
});

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const dispatchSource = source.slice(source.indexOf('async function dispatchCapturedOrder('), source.indexOf('\nfunction normalizeText('));
function harness(record, balance = 20, linked = null) {
  const docs = new Map([['empresas/store', { saldo: balance, reservado: 0, status: 'aprovada' }]]);
  if (record) docs.set('empresas/store/integracaoPedidos/PediPlus_1110', record);
  if (linked) docs.set('entregas/old', linked);
  const ref = (path) => ({ path, id: path.split('/').at(-1) });
  const orderRef = ref('empresas/store/integracaoPedidos/PediPlus_1110');
  const notices = [];
  const context = vm.createContext({
    console, isUnsentLegacyImport, companyStatus: (c) => c.status,
    capturedOrderMissing: () => [], isPricedDeliveryType: () => true,
    geocodeCapturedAddress: async () => ({ lat: -22, lon: -47, text: 'Rua teste' }),
    calculateRouteDistanceKm: async () => 1.5, ensureDistantRouteIsPlausible: () => {},
    deliveryPublicData: (d) => d, expectedDeliveryFare: () => 6.5, isFixedFoodDelivery: () => true,
    companyBalance: (c) => ({ ...c, disponivel: c.saldo - c.reservado }), isDailyPlanDelivery: () => false, isHalfPlanDelivery: () => false,
    money: (v) => v, ledgerRef: () => ref('ledger/reservation'), bairroFromAddress: () => 'Centro', capturedOrderAmounts: () => ({}),
    emitSupportOperationsRefresh: () => {}, notifyTelegramAboutDelivery: async (id) => { assert.ok(docs.has(`entregas/${id}`)); notices.push(id); }, notifyDriversAboutDelivery: async () => {},
    admin: { firestore: { FieldValue: { serverTimestamp: () => 'TIME' } } },
    db: {
      collection: (name) => ({ doc: (id) => ref(`${name}/${id}`) }),
      runTransaction: async (callback) => {
        const writes = [];
        await callback({
          get: async (r) => ({ ref: r, exists: docs.has(r.path), data: () => docs.get(r.path) }),
          set: (r, data, options) => writes.push([r.path, options?.merge ? { ...docs.get(r.path), ...data } : data])
        });
        writes.forEach(([key, value]) => docs.set(key, value));
      }
    }
  });
  vm.runInContext(dispatchSource, context);
  return { docs, notices, run: () => context.dispatchCapturedOrder('store', { retirada: 'Rua loja' }, orderRef,
    { items: [], address: 'Rua destino', platform: 'PediPlus', externalId: '1110', customer: 'Cliente', phone: '', orderTotal: 10 },
    { deliveryType: 'Acai', clientRequestId: 'api_test', integrationPreview: true }) };
}
test('stuck legacy import creates delivery and reserves once, repeat does not charge or notify twice', async () => {
  const h = harness({ aceitoEmMs: 1 });
  assert.equal((await h.run()).created, true);
  assert.equal(h.docs.get('empresas/store').reservado, 6.5);
  assert.equal(h.docs.get('entregas/api_test').status, 'pendente');
  assert.equal((await h.run()).created, false);
  assert.equal(h.docs.get('empresas/store').reservado, 6.5);
  assert.equal(h.notices.length, 1);
});
test('insufficient balance leaves import recoverable and sends no notification', async () => {
  const h = harness({ aceitoEmMs: 1 }, 2);
  await assert.rejects(h.run(), /Saldo insuficiente/);
  assert.equal(h.docs.has('entregas/api_test'), false);
  assert.equal(h.docs.get('empresas/store').reservado, 0);
  assert.equal(h.notices.length, 0);
});
test('cancelled import is never resurrected', async () => {
  const h = harness({ aceitoEmMs: 1, status: 'cancelado' });
  await assert.rejects(h.run(), /cancelado/);
  assert.equal(h.docs.has('entregas/api_test'), false);
});
test('existing legacy delivery link returns actual id without reserving balance', async () => {
  const h = harness({ entregaId: 'old', status: 'enviado_motoboy' }, 20, { empresaId: 'store', status: 'finalizada' });
  assert.equal((await h.run()).deliveryId, 'old');
  assert.equal(h.docs.get('empresas/store').reservado, 0);
  assert.equal(h.notices.length, 0);
});
test('broken delivery link requires review instead of risking double charge', async () => {
  const h = harness({ entregaId: 'missing', status: 'enviado_motoboy' });
  await assert.rejects(h.run(), /inconsistente/);
  assert.equal(h.docs.get('empresas/store').reservado, 0);
});
