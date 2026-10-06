import test from 'node:test';
import assert from 'node:assert/strict';
import { conchalGazetteer, parseAddressInput } from '../src/conchal-gazetteer.js';
import { createGeocodeSearch } from '../src/geocode-search.js';
import { addressFeatureMatches, streetNumber } from '../src/address-search.js';

const gazetteer = conchalGazetteer();
const found = text => gazetteer.search(text).features[0]?.properties;
const near = (props, lat, lon, meters = 60) => {
  const distance = Math.hypot((props.lat - lat) * 111000, (props.lon - lon) * 103000);
  assert.ok(distance <= meters, `${props.formatted} ficou a ${Math.round(distance)} m de ${lat},${lon}`);
};

test('cadastro local cobre todas as ruas de Conchal do IBGE', () => {
  assert.ok(gazetteer.size >= 600, `apenas ${gazetteer.size} ruas carregadas`);
});

test('erro de grafia da empresa ainda acha a rua certa de Conchal', () => {
  const colleta = found('rua dos coletta , esperança 2, Conchal, SP, Brasil');
  assert.equal(colleta.street, 'Rua dos Colleta');
  assert.equal(colleta.city, 'Conchal');
  assert.equal(colleta.housenumber, undefined, 'o 2 de "Esperança 2" e do bairro, nao da casa');
  assert.equal(colleta.match_confirmed, true);
  for (const [input, street] of [
    ['rua antonio kamer 300', 'Rua Antônio Kammer'],
    ['rua zanchetta 100', 'Rua dos Zancheta'],
    ['rua dos zanoqueta 64', 'Rua dos Zancheta'],
    ['rua guelly 189', 'Rua dos Gelly'],
    ['Rua 15 de Novembro 300', 'Rua XV de Novembro'],
    ['rua 9 de julho 290', 'Rua Nove de Julho'],
    ['Rua Visconde de Indaiatuba 300', 'Rua Visconde de Indaiatuba'],
    ['rua tiradentes 51', 'Travessa Tiradentes'],
    ['r. joão dias 200', 'Rua João Dias'],
    ['Rua Maria B Fernandes 300', 'Rua Professora Maria Benedita Fernandes'],
    ['Rua São Paulo 745, Centro', 'Rua São Paulo'],
    ['Rua Araras 1038', 'Rua Araras'],
    ['Rua Mogi Mirim 613', 'Rua Mogi Mirim'],
    ['rua das pamlas 200', 'Rua das Palmas']
  ]) assert.equal(found(input)?.street, street, input);
});

test('numero da casa usa a posicao real dos enderecos do IBGE', () => {
  near(found('Rua Nove de Julho, 290'), -22.33295, -47.17534, 5);
  near(found('rua dos colleta 120'), -22.3327, -47.1574);
  assert.equal(found('Rua Pedro Corte 336').match_precision, 'numero');
  assert.equal(found('av joao paulo 2, 250').housenumber, '250');
  assert.equal(found('av joao paulo 2, 250').street, 'Avenida João Paulo II');
});

test('Tujuguaba e Iate Clube sao Conchal; outras cidades ficam com o mapa externo', () => {
  assert.match(found('rua da liberdade 100 tujuguaba').formatted, /Tujuguaba/);
  assert.match(found('rua rio negro 50 iate').formatted, /Iate Clube/);
  assert.equal(gazetteer.search('Rua Sete de Setembro 100, Mogi Guaçu').features.length, 0);
  assert.equal(gazetteer.search('Rua João Pessoa 100, Araras, SP').features.length, 0);
});

test('nome incompleto que serve para duas ruas pede o nome completo em vez de chutar', () => {
  const result = gazetteer.search('rua megiato 70');
  assert.equal(result.features.length, 0);
  assert.equal(result.ambiguous, true);
  assert.deepEqual(result.suggestions, ['Rua João Megiato', 'Rua Nelson Megiatto']);
  assert.equal(gazetteer.search('rua 1, jardim santana').features.length, 0);
  assert.equal(found('rua dos martha 100').street, 'Rua dos Martha');
  assert.equal(gazetteer.search('rua inexistente da silva 10').features.length, 0);
  assert.equal(gazetteer.search('Supermercado Avenida').features.length, 0);
});

test('separador de endereco nao confunde numero do bairro com numero da casa', () => {
  assert.deepEqual(parseAddressInput('rua dos coletta , esperança 2, Conchal, SP, Brasil').number, '');
  assert.equal(parseAddressInput('Rua X 120 Jardim Y').number, '120');
  assert.equal(parseAddressInput('Rua 15 de Novembro 300').street, 'Rua 15 de Novembro');
  assert.equal(parseAddressInput('Rodovia SP 191, 100').street, 'Rodovia SP 191');
  assert.equal(streetNumber('rua dos coletta , esperança 2'), null);
});

test('busca do servidor responde pelo cadastro local sem gastar o Geoapify', async () => {
  let calls = 0;
  const search = createGeocodeSearch({ fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ features: [] }) }; } });
  const data = await search({ text: 'rua dos coletta , esperança, 2, Conchal, SP, Brasil', original: 'rua dos coletta , esperança 2', apiKey: 'x' });
  assert.equal(calls, 0);
  assert.equal(data.features[0].properties.street, 'Rua dos Colleta');
  assert.equal(addressFeatureMatches('rua dos coletta', data.features[0].properties), true);
  const ambiguous = await search({ text: 'rua megiato, 70, Conchal, SP, Brasil', apiKey: 'x' });
  assert.equal(calls, 0);
  assert.match(ambiguous.message, /Rua João Megiato/);
  const missing = await search({ text: 'rua inventada, 10, Conchal, SP, Brasil', apiKey: 'x' });
  assert.ok(calls >= 1, 'rua fora do cadastro ainda tenta o mapa externo');
  assert.match(missing.message, /Nao achei essa rua em Conchal/);
});

test('confirmacao local nao pode ser forjada por resultado comum do mapa', () => {
  assert.equal(addressFeatureMatches('Rua dos Colleta 10', { street: 'Rua Outra', housenumber: '10', match_confirmed: true }), false);
});
