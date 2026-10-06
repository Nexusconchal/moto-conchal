import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeocodeSearch } from '../src/geocode-search.js';
import { addressFeatureMatches, addressSearchVariants, streetNumber } from '../src/address-search.js';

const feature = properties => ({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: [-47.17, -22.33] } });
const city = feature({ result_type: 'city', city: 'Conchal' });
const house = feature({ result_type: 'building', street: 'Rua Idalina Antunes Orsola', housenumber: '256', city: 'Conchal' });

test('street dates and verified spelling aliases match without admitting unrelated roads or houses', () => {
  for (const [input, street] of [['Rua 15 de Novembro', 'Rua XV de Novembro'], ['Rua 9 de Julho', 'Rua Nove de Julho'], ['Rua 7 de Setembro', 'Rua Sete de Setembro'], ['Rua Benedito Novo', 'Rua Bendito Novo'], ['Rua Visconde de Indaiatuba', 'Rua Visconde Indatuba'], ['Travessa Tiradentes', 'Travessa Tirandentes']]) {
    assert.equal(addressFeatureMatches(input + ' 100 Centro', { street, housenumber: '100', result_type: 'building' }), true);
    assert.equal(addressFeatureMatches(input + ' 100 Centro', { street, housenumber: '101', result_type: 'building' }), false);
    assert.equal(addressFeatureMatches(input + ' 100 Centro', { street: 'Rua das Azaleias', housenumber: '100', result_type: 'building' }), false);
  }
});

test('numbered road names are never treated as a house on a road named only Rua', () => {
  assert.equal(streetNumber('Rua 1, Jardim Santana, Conchal'), null);
  assert.equal(addressFeatureMatches('Rua 1, Jardim Santana, Conchal', { street: 'Rua dos Roncato', result_type: 'street' }), false);
  assert.deepEqual(streetNumber('Rua 1 100 Centro'), { street: 'Rua 1', number: '100' });
});

test('a shared surname does not authorize a different road with an extra first name', () => {
  assert.equal(addressFeatureMatches('Rua dos Martha, Conchal', { street: 'Rua Narciso Martha', result_type: 'street' }), false);
  assert.equal(addressFeatureMatches('Rua Vereador Narciso Martha, Conchal', { street: 'Rua Narciso Martha', result_type: 'street' }), true);
  assert.equal(addressFeatureMatches('Rua Abílio Pinto, Conchal', { street: 'Rua Vereador Abílio Pinto', result_type: 'street' }), true);
});

test('common neighborhoods after house numbers preserve the house and bounded precise query', () => {
  for (const neighborhood of ['Centro', 'Residencial Monte Real', 'Conjunto Sol Nascente', 'Terra Nobre', 'Santa Rita']) {
    assert.equal(addressSearchVariants('Rua João Dias 100 ' + neighborhood)[0], 'Rua João Dias, 100, Conchal, SP, Brasil');
  }
});

test('structured fallback preserves house and city when free text returns only the city', async () => {
  const calls = [];
  const search = createGeocodeSearch({ fetchImpl: async url => {
    const params = new URL(url).searchParams; calls.push(params);
    return { ok: true, json: async () => ({ features: params.has('street') ? [house] : [city] }) };
  } });
  const result = await search({ text: 'Rua Idalina Antunes Orsola, 256, Conchal, SP', apiKey: 'test-only' });
  assert.equal(result.features[0].properties.housenumber, '256');
  assert.equal(calls.length, 2); assert.equal(calls[1].get('housenumber'), '256'); assert.equal(calls[1].get('city'), 'Conchal');
  assert.equal(calls[1].has('text'), false);
});

test('fallback cannot admit a different house or street, and failures stay briefly cached', async () => {
  let calls = 0, time = 0;
  const search = createGeocodeSearch({ now: () => time, fetchImpl: async () => ({ ok: true, json: async () => ({ features: ++calls % 2 ? [city] : [feature({ ...house.properties, housenumber: '739' })] }) }) });
  const args = { text: 'Rua Idalina Antunes Orsola, 256, Conchal', apiKey: 'test-only' };
  assert.equal((await search(args)).features[0].properties.result_type, 'city');
  await search(args); assert.equal(calls, 2);
  time = 61000; await search(args); assert.equal(calls, 4);
});

test('same concurrent requests share provider calls, successful lookups expire, and upstream errors are not cached', async () => {
  let calls = 0, time = 0;
  const search = createGeocodeSearch({ now: () => time, fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ features: [house] }) }; } });
  const args = { text: 'Rua Idalina Antunes Orsola, 256, Conchal', apiKey: 'test-only' };
  await Promise.all([search(args), search(args), search(args)]); assert.equal(calls, 1);
  time = 30 * 60 * 1000 + 1; await search(args); assert.equal(calls, 2);
  let failures = 0;
  const failing = createGeocodeSearch({ fetchImpl: async () => { failures++; return { ok: false }; } });
  await assert.rejects(failing(args)); await assert.rejects(failing(args)); assert.equal(failures, 2);
});

test('a matching street in another city triggers fallback and never replaces the requested city', async () => {
  let calls = 0;
  const wrongCity = feature({ ...house.properties, city: 'Limeira' });
  const search = createGeocodeSearch({ fetchImpl: async () => ({ ok: true, json: async () => ({ features: [++calls === 1 ? wrongCity : house] }) }) });
  const result = await search({ text: 'Rua Idalina Antunes Orsola, 256, Conchal', apiKey: 'test-only' });
  assert.equal(calls, 2); assert.equal(result.features[0].properties.city, 'Conchal');
});
