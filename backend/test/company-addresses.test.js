import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { addressSearchVariants, addressFeatureMatches, streetNumber } from '../src/address-search.js';

const company = fs.readFileSync(new URL('../../empresa.html', import.meta.url), 'utf8');
const ctx = vm.createContext({});
function load(name, next) { vm.runInContext(company.slice(company.indexOf(`function ${name}(`), company.indexOf(`function ${next}(`)).replace(/\basync\s*$/, ''), ctx); }
load('textoBusca', 'cidadesAtendidas'); load('cidadesAtendidas', 'dicaLocal'); load('dicaLocal', 'mensagemErroAmigavel');
load('resultadoEnderecoConfiavel', 'destinoComidaEspecial'); load('textoMapa', 'precoEntrega');

const submitted = 'rua idalina antunes orsola 256 jd dos palmeiras';
const correct = { street: 'Rua Idalina Antunes Orsola', housenumber: '256', city: 'Conchal', result_type: 'building', formatted: 'Rua Idalina Antunes Orsola 256, Conchal - SP, Brasil' };

test('company and backend isolate street and number before unpunctuated neighborhood text', () => {
  assert.equal(ctx.tentativasGeocode(submitted)[0].texto, 'rua idalina antunes orsola, 256, Conchal, SP, Brasil');
  assert.equal(addressSearchVariants(submitted)[0], ctx.tentativasGeocode(submitted)[0].texto);
  for (const text of ['Rua João Dias 256 jd são paulo', 'Rua Avelino Stivão, 100, Jardim São Paulo, Conchal']) {
    assert.ok(!/jardim|\bjd\b/i.test(ctx.tentativasGeocode(text)[0].texto));
    assert.equal((ctx.tentativasGeocode(text)[0].texto.match(/Conchal/g) || []).length, 1);
  }
});

test('company and backend reject live provider wrong houses, wrong streets and generic city pins', () => {
  for (const number of ['739', '707', '691']) {
    const props = { ...correct, housenumber: number };
    assert.equal(ctx.resultadoEnderecoConfiavel(submitted, props, props.formatted), false);
    assert.equal(addressFeatureMatches(submitted, props), false);
  }
  for (const props of [{ ...correct, street: 'Rua Idalina Colombo' }, { ...correct, result_type: 'city' }]) {
    assert.equal(ctx.resultadoEnderecoConfiavel(submitted, props, props.formatted), false);
    assert.equal(addressFeatureMatches(submitted, props), false);
  }
  assert.equal(ctx.resultadoEnderecoConfiavel(submitted, correct, correct.formatted), true);
  assert.equal(addressFeatureMatches(submitted, correct), true);
});

test('numeric street names, abbreviations and house suffixes remain intact', () => {
  assert.deepEqual(streetNumber('Rua 15 de Novembro 256 Jardim São Paulo'), { street: 'Rua 15 de Novembro', number: '256' });
  assert.equal(addressFeatureMatches('Rua 15 de Novembro 256 Jardim São Paulo', { ...correct, street: 'Rua 15 de Novembro' }), true);
  assert.equal(addressFeatureMatches('Av. Centenário Dr. Paulo de A. Nogueira, 421, Cosmópolis', { ...correct, street: 'Avenida Centenario Do Doutor Paulo De Almeida Nogueira', housenumber: '421' }), true);
  assert.equal(addressFeatureMatches('Rua João Dias 256A jd são paulo', { ...correct, street: 'Rua João Dias', housenumber: '256A' }), true);
});

const backend = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const importedAddress = 'Rua Vereador Abílio Pinto , 88 — Casa — Jd São Paulo - Conchal — Ref: Zé Adão lanches';
const importedCorrect = { ...correct, street: 'Rua Vereador Abilio Pinto', housenumber: '88', formatted: 'Rua Vereador Abilio Pinto 88, Conchal - SP, Brasil' };

test('imported order complements and dash separators do not replace house 88 with house 3', () => {
  for (const text of [importedAddress, importedAddress.replaceAll('—', '–'), importedAddress.replaceAll('—', ' - '), 'Rua Vereador Abílio Pinto 88 Casa, Conchal']) {
    const query = 'Rua Vereador Abílio Pinto, 88, Conchal, SP, Brasil';
    assert.equal(addressSearchVariants(text)[0], query);
    assert.equal(ctx.tentativasGeocode(text)[0].texto, query);
    for (const number of ['3', '19', '96', '88']) {
      const props = { ...importedCorrect, housenumber: number };
      assert.equal(addressFeatureMatches(text, props), number === '88');
      assert.equal(ctx.resultadoEnderecoConfiavel(text, props, props.formatted), number === '88');
    }
  }
});

test('server selects the correct imported order house even when provider lists house 3 first', async () => {
  const h = backendHarness([[{ ...importedCorrect, housenumber: '3' }, importedCorrect]]);
  const result = await h.context.geocodeCapturedAddress(importedAddress);
  assert.equal(result.text, importedCorrect.formatted);
  assert.deepEqual(h.requests, ['Rua Vereador Abílio Pinto, 88, conchal, SP, Brasil']);
});

function backendHarness(responses) {
  const requests = [];
  const context = vm.createContext({ GEOAPIFY_API_KEY: 'test-only', URLSearchParams, addressSearchVariants, addressFeatureMatches,
    cleanText: v => String(v || '').trim(), normalizeText: v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(),
    validCoordinate: p => Number.isFinite(p?.lat) && Number.isFinite(p?.lon), coordinateDistanceKm: (a,b) => Math.hypot(a.lat-b.lat,a.lon-b.lon),
    fetch: async url => { requests.push(new URL(url).searchParams.get('text')); return { ok: true, json: async () => ({ features: (responses[requests.length - 1] || []).map(properties => ({ properties, geometry: { coordinates: [-47.154961, -22.329893] } })) }) }; }
  });
  vm.runInContext(backend.slice(backend.indexOf('function requestedPlaceHint('), backend.indexOf('function ensureDistantRouteIsPlausible(')), context);
  vm.runInContext(backend.slice(backend.indexOf('async function geocodeCapturedAddress('), backend.indexOf('async function dispatchCapturedOrder(')), context);
  return { context, requests };
}

test('server verification uses the same normalized address without changing the target to house 739', async () => {
  const h = backendHarness([[correct]]);
  const result = await h.context.geocodeCapturedAddress(submitted, { lat: -22.325698, lon: -47.156255 });
  assert.match(result.text, /256/); assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0], 'rua idalina antunes orsola, 256, Conchal, SP, Brasil');
});

test('server never selects a wrong house or city when no matching result exists', async () => {
  for (const props of [{ ...correct, housenumber: '739' }, { ...correct, city: 'Mogi-Guaçu' }, { ...correct, result_type: 'city' }]) {
    const h = backendHarness([[props], [props]]);
    await assert.rejects(h.context.geocodeCapturedAddress(submitted), /Nao consegui confirmar/);
    assert.equal(h.requests.length, 2);
  }
});

test('server retains original full address as a bounded fallback and supports district destinations', async () => {
  const h = backendHarness([[], [correct]]);
  assert.match((await h.context.geocodeCapturedAddress(submitted)).text, /256/);
  assert.equal(h.requests.length, 2);
  const district = backendHarness([[{ ...correct, city: 'Mogi-Guaçu', formatted: 'Rua Idalina Antunes Orsola 256, Martinho Prado, Mogi-Guaçu' }]]);
  assert.ok(await district.context.geocodeCapturedAddress('Rua Idalina Antunes Orsola 256, Martinho Prado'));
});
