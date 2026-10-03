import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const context = vm.createContext({});
function load(name, next) { vm.runInContext(source.slice(source.indexOf(`function ${name}(`), source.indexOf(`function ${next}(`)).replace(/\basync\s*$/, ''), context); }
load('textoBusca', 'cidadesAtendidas'); load('cidadesAtendidas', 'dicaLocal'); load('dicaLocal', 'localEsperado');
load('resultadoEnderecoConfiavel', 'rotaDistantePlausivel'); load('rotaDistantePlausivel', 'textoMapa');
load('textoMapa', 'variantesEnderecoMapa'); load('variantesEnderecoMapa', 'tentativasGeocode');
load('buscaCidadeExplicitada', 'mensagemErroAmigavel'); load('tentativasGeocode', 'geocodificar');
vm.runInContext('const CIDADES_OPERACAO = {conchal:{nome:"Conchal",local:"rect:local",bias:"proximity:conchal"}}', context);
test('explicit city starts with the precise street and number, without duplicate city or generic CEP', () => {
  const attempts = context.tentativasGeocode('Av. Centenário Dr. Paulo de A. Nogueira, 421, Cosmópolis - SP, 13150-000');
  assert.equal(attempts[0].texto, 'Av. Centenário Dr. Paulo de A. Nogueira, 421, Cosmopolis, SP, Brasil');
  assert.equal(attempts[0].esperado, 'cosmopolis');
  assert.ok(attempts.every(item => !/cosmopolis.*cosmopolis/i.test(item.texto.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))));
});
test('fallback geocoding preserves Dr. and A. abbreviations and the street number', () => {
  const variants = context.variantesEnderecoMapa('Av. Centenário Dr. Paulo de A. Nogueira, 421, Cosmópolis - SP, 13150-000');
  assert.ok(variants.includes('Av. Centenário Dr. Paulo de A. Nogueira, 421'));
});
test('Cosmópolis is recognized instead of appending Conchal to its address', () => {
  assert.equal(context.dicaLocal('Av. Centenário Dr. Paulo de A. Nogueira, 421, Cosmópolis'), 'cosmopolis');
});
test('abbreviated screenshot destination matches the official avenue name', () => {
  assert.equal(context.resultadoEnderecoConfiavel('Av. Centenário Dr. Paulo de A. Nogueira, 421, Cosmópolis - SP, 13150-000', { result_type: 'building', street: 'Avenida Centenario Do Doutor Paulo De Almeida Nogueira', housenumber: '421' }), true);
  assert.equal(context.resultadoEnderecoConfiavel('Rua Antônio Coraini, 610, Terra Nobre, Conchal', { result_type: 'building', street: 'Rua Antonio Coraini' }), true);
});
test('wrong streets and city centroids remain rejected', () => {
  assert.equal(context.resultadoEnderecoConfiavel('Av. Centenário Dr. Paulo de A. Nogueira, 421, Cosmópolis', { result_type: 'amenity', street: 'Avenida Centenario Do Doutor Paulo De Almeida Nogueira', housenumber: '327' }), false);
  assert.equal(context.resultadoEnderecoConfiavel('Rua Antônio Coraini, 610, Conchal', { result_type: 'street', street: 'Rua das Azaleias' }), false);
  assert.equal(context.resultadoEnderecoConfiavel('Rodoviária de Cosmópolis', { result_type: 'city', name: 'Cosmópolis' }), false);
  assert.throws(() => context.rotaDistantePlausivel(2, 'Cosmópolis'), /curta demais/);
  assert.doesNotThrow(() => context.rotaDistantePlausivel(50, 'Cosmópolis'));
});
test('backend refuses geocoded destinations in another city', () => {
  const backend = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const ctx = vm.createContext({ normalizeText: value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() });
  vm.runInContext(backend.slice(backend.indexOf('function requestedPlaceHint('), backend.indexOf('function isGpsOrigin(')), ctx);
  assert.equal(ctx.requestedPlaceHint('Cosmópolis'), 'cosmopolis');
  assert.throws(() => ctx.ensureResolvedPlaceMatches('Cosmópolis', 'Capivari'), /nao conferiu/);
  assert.doesNotThrow(() => ctx.ensureResolvedPlaceMatches('Cosmópolis', 'Avenida Centenário, Cosmópolis'));
});
