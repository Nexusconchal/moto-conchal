import test from 'node:test';
import assert from 'node:assert/strict';
import { addressKeys, createLearnedAddresses, learnedPoint, newlyDelivered, sanitizeStops, stopsSummary } from '../src/delivery-stops.js';

test('only well-formed stops are stored, with GPS kept just for delivered ones', () => {
  const stops = sanitizeStops([
    { id: 'a1', texto: 'Rua das Azaleias, 65', lat: -22.33, lon: -47.17, entregue: true, entregueEm: 5, gpsEntrega: { lat: -22.3301, lon: -47.1701, precisao: 12 } },
    { id: 'a1', texto: 'duplicada' },
    { id: 'b2', texto: 'Rua X 10', status: 'nao_encontrado', problema: 'ninguem_atende', gpsEntrega: { lat: 1, lon: 1 } },
    { id: 'c3', texto: 'Rua Y 20', status: 'qualquer', problema: 'inventado' },
    { id: '<script>', texto: 'ok ok' },
    { id: 'd4', texto: 'x' }
  ]);
  assert.deepEqual(stops.map(s => [s.id, s.status, s.problema]), [['a1', 'entregue', ''], ['b2', 'nao_encontrado', 'ninguem_atende'], ['c3', 'pendente', ''], ['script', 'pendente', '']]);
  assert.equal(stops[0].gpsEntrega.precisao, 12);
  assert.equal(stops[1].gpsEntrega, null);
  assert.deepEqual(stopsSummary(stops, 5), { total: 5, adicionados: 4, entregues: 1, problemas: 1 });
  assert.deepEqual(newlyDelivered([{ id: 'a1', status: 'pendente' }], stops).map(s => s.id), ['a1']);
  assert.deepEqual(newlyDelivered(stops, stops), []);
});

test('the same house written in different ways shares the street+number key', () => {
  const a = addressKeys('R. das Azaleias, nº 65 - Centro, Conchal/SP');
  const b = addressKeys('rua azaleias 65, jd sao paulo');
  assert.ok(a.includes('conchal:rua azaleias#65') && b.includes('conchal:rua azaleias#65'));
  assert.deepEqual(addressKeys('portaria do condomínio monte real'), ['conchal:portaria condominio monte real']);
  assert.notDeepEqual(addressKeys('Rua X 10', 'aguai'), addressKeys('Rua X 10', 'conchal'));
});

test('a learned point needs the deliveries to agree', () => {
  assert.ok(learnedPoint({ pontos: [{ lat: -22.3, lon: -47.1 }] }));
  assert.equal(learnedPoint({ pontos: [{ lat: -22.3, lon: -47.1 }, { lat: -22.31, lon: -47.1 }] }), null);
  const three = learnedPoint({ pontos: [{ lat: -22.3, lon: -47.1 }, { lat: -22.30005, lon: -47.10005 }, { lat: -22.4, lon: -47.1 }] });
  assert.equal(three.confirmacoes, 2);
});

function fakeDb() {
  const docs = new Map();
  const collection = () => ({
    doc: id => ({ id, get: async () => ({ data: () => docs.get(id) }) }),
    limit: () => ({ get: async () => ({ docs: [...docs.values()].map(data => ({ data: () => data })) }) })
  });
  return { docs, collection, runTransaction: async fn => fn({ get: ref => ref.get(), set: (ref, data) => docs.set(ref.id, data) }) };
}

test('a delivery with good GPS teaches the address; a bad GPS does not', async () => {
  const db = fakeDb();
  const learned = createLearnedAddresses({ db });
  assert.equal(await learned.learn({ texto: 'Rua Nova 12, Monte Real', city: 'conchal', gps: { lat: -22.3261, lon: -47.1702, precisao: 400 } }), false);
  assert.equal(await learned.lookup('rua nova 12', 'conchal'), null);
  assert.equal(await learned.learn({ texto: 'Rua Nova 12, Monte Real', city: 'conchal', gps: { lat: -22.3261, lon: -47.1702, precisao: 15 } }), true);
  const found = await learned.lookup('R. Nova, 12', 'conchal');
  assert.equal(found.lat, -22.3261);
  assert.equal(await learned.lookup('R. Nova, 12', 'aguai'), null);
  // Um servidor novo le o que ficou salvo.
  const fresh = createLearnedAddresses({ db });
  assert.ok(await fresh.lookup('rua nova 12 monte real', 'conchal'));
});
