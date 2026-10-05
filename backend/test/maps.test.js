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

test('passenger street search isolates house and ignores unpunctuated neighborhoods and references',()=>{
  for(const [text,first] of [
    ['rua idalina antunes orsola 256 jd dos palmeiras','rua idalina antunes orsola, 256, Conchal, SP, Brasil'],
    ['Rua Vereador Abílio Pinto , 88 — Casa — Jd São Paulo - Conchal — Ref: Zé Adão lanches','Rua Vereador Abílio Pinto, 88, Conchal, SP, Brasil'],
    ['Rua 15 de Novembro 256 Jardim São Paulo','Rua 15 de Novembro, 256, Conchal, SP, Brasil']
  ]) {
    assert.equal(context.tentativasGeocode(text)[0].texto,first);
    const street=text.startsWith('rua idalina')?'Rua Idalina Antunes Orsola':text.includes('Abílio')?'Rua Vereador Abilio Pinto':'Rua 15 de Novembro';
    const number=text.includes('88')?'88':'256';
    assert.equal(context.resultadoEnderecoConfiavel(text,{result_type:'building',street,housenumber:number}),true);
    assert.equal(context.resultadoEnderecoConfiavel(text,{result_type:'building',street,housenumber:'739'}),false);
    assert.equal(context.resultadoEnderecoConfiavel(text,{result_type:'building',street:'Rua das Azaleias',housenumber:number}),false);
  }
});

function gpsHarness(fixes) {
  const calls=[];let index=0;
  const ctx=vm.createContext({window:{isSecureContext:true},Date,mostrarStatus(){},navigator:{geolocation:{getCurrentPosition(ok,err,options){calls.push(options);const fix=fixes[index++];if(fix.error)err(fix.error);else ok(fix);}}}});
  vm.runInContext(source.slice(source.indexOf('      function pegarGps('),source.indexOf('      async function calcularRota(')),ctx);
  return {ctx,calls};
}
const fix=(change={})=>({timestamp:Date.now(),coords:{latitude:-22.33,longitude:-47.17,accuracy:15},...change});
test('passenger GPS rejects inaccurate or stale positions instead of silently placing the pickup elsewhere',async()=>{
  for(const bad of [fix({coords:{latitude:-22.33,longitude:-47.17,accuracy:1500}}),fix({timestamp:Date.now()-120000}),fix({coords:{latitude:-22.33,longitude:-47.17,accuracy:null}}),fix({coords:{latitude:NaN,longitude:-47.17,accuracy:15}})]) {
    const h=gpsHarness([bad]);await assert.rejects(h.ctx.pegarGps(),/aproximado ou desatualizado/);
  }
  const h=gpsHarness([fix()]);const result=await h.ctx.pegarGps();assert.equal(result.accuracy,15);assert.equal(result.lat,-22.33);
});
test('fallback can use a fresh accurate position but cannot reuse a two-minute-old position',async()=>{
  const h=gpsHarness([{error:{code:3}},fix()]);assert.equal((await h.ctx.pegarGpsComFallback()).accuracy,15);assert.equal(h.calls[1].maximumAge,0);
  const bad=gpsHarness([{error:{code:3}},fix({timestamp:Date.now()-120000})]);await assert.rejects(bad.ctx.pegarGpsComFallback(),/aproximado ou desatualizado/);
});
