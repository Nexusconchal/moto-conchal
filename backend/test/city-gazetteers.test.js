import test from 'node:test';
import assert from 'node:assert/strict';
import { gazetteerCityKey, gazetteerFor } from '../src/conchal-gazetteer.js';
import { createGeocodeSearch } from '../src/geocode-search.js';

const aguai = gazetteerFor('aguai');
const coelho = gazetteerFor('engenheiro_coelho');
const found = (gazetteer, text) => gazetteer.search(text).features[0]?.properties;

test('Aguai and Engenheiro Coelho have their own street files', () => {
  assert.ok(aguai.size >= 700, `Aguai: ${aguai.size} ruas`);
  assert.ok(coelho.size >= 350, `Engenheiro Coelho: ${coelho.size} ruas`);
});

test('the typed place picks the city file; Tujuguaba and Iate stay in Conchal', () => {
  assert.equal(gazetteerCityKey(''), 'conchal');
  assert.equal(gazetteerCityKey('Tujuguaba'), 'conchal');
  assert.equal(gazetteerCityKey('Aguaí'), 'aguai');
  assert.equal(gazetteerCityKey('engenheiro coelho'), 'engenheiro_coelho');
  assert.equal(gazetteerCityKey('limeira'), null);
});

test('an Aguai street with number and city name is confirmed in Aguai', () => {
  const props = found(aguai, 'rua sete de setembro 100, aguai');
  assert.equal(props.city, 'Aguaí');
  assert.equal(props.housenumber, '100');
  assert.equal(props.match_confirmed, true);
  assert.match(props.formatted, /Aguaí - SP, 138/);
  assert.equal(found(aguai, 'Rua Sete de Setembro 100, Conchal'), undefined);
});

test('an Engenheiro Coelho street is confirmed there with its own CEP', () => {
  const props = found(coelho, 'Rua Antonio Batistela 36, Eng. Coelho');
  assert.equal(props.city, 'Engenheiro Coelho');
  assert.match(props.postcode, /^13445/);
});

test('search uses the local file of the requested city before the external map', async () => {
  let external = 0;
  const search = createGeocodeSearch({ fetchImpl: async () => { external++; return { ok: true, json: async () => ({ features: [] }) }; } });
  const result = await search({ text: 'Rua Sete de Setembro, 100, Aguaí, SP, Brasil', original: 'rua sete de setembro 100', apiKey: 'test-only', city: 'aguai' });
  assert.equal(result.features[0].properties.city, 'Aguaí');
  assert.equal(external, 0);
  const missing = await search({ text: 'Rua Inexistente da Silva, 10, Aguaí, SP, Brasil', apiKey: 'test-only', city: 'aguai' });
  assert.match(missing.message || '', /Aguaí/);
});

test('new streets and places typed by hand (Residencial Monte Real) are found in Conchal', async () => {
  const { conchalGazetteer } = await import('../src/conchal-gazetteer.js');
  const conchal = conchalGazetteer();
  const street = found(conchal, 'R. Eduardo Rogério Barbosa, 84 - Conchal Velho, Conchal - SP, 13835-000');
  assert.equal(street.street, 'Rua Eduardo Rogério Barbosa');
  assert.equal(street.housenumber, '84');
  assert.equal(street.match_source, 'manual');
  const place = found(conchal, 'portaria do condomínio monte real');
  assert.equal(place.name, 'Residencial Monte Real');
  assert.equal(place.match_confirmed, true);
  assert.ok(Math.abs(place.lat + 22.3267) < 0.001 && Math.abs(place.lon + 47.1702) < 0.001);
  assert.equal(found(conchal, 'condominio monte real, limeira'), undefined);
  // Rua conhecida continua vencendo o lugar.
  assert.equal(found(conchal, 'Rua das Azaleias, 65, Residencial Monte Real').street, 'Rua das Azaleias');
});

test('Engenheiro Coelho EC road codes are part of the road name, not the house number', () => {
  const props = found(coelho, 'Estrada Ec 400, 50');
  assert.match(props.street, /Ec 400/);
  assert.equal(props.housenumber, '50');
  assert.ok(coelho.search('Estrada EC 100').suggestions.every(name => /Ec 100/.test(name)));
});

test('road numbers 100 and 110 are different roads', () => {
  assert.match(found(coelho, 'Estrada Ec 100, Bode Branco').street, /Ec 100$/);
  assert.match(found(coelho, 'Estrada Ec 110, Bode Branco').street, /Ec 110$/);
});

test('the exact neighborhood typed decides a rural road that crosses similar ones', () => {
  assert.equal(found(aguai, 'Rodovia Sp 340, Barra Do Jaguari').suburb, 'Barra do Jaguari');
  assert.equal(found(aguai, 'Rodovia Sp 340, Fazenda Barra Do Jaguari').suburb, 'Fazenda Barra do Jaguari');
  assert.equal(aguai.search('Rodovia Sp 340').ambiguous, true);
});
