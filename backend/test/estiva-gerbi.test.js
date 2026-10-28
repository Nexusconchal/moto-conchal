import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { streetNumber } from '../src/address-search.js';

const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const backend = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const normalizeText = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const estiva = { lat: -22.2708, lon: -46.9478 };

test('client app searches the address in Estiva Gerbi instead of appending Conchal', () => {
  const ctx = vm.createContext({});
  const load = (name, next) => vm.runInContext(html.slice(html.indexOf(`function ${name}(`), html.indexOf(`function ${next}(`)), ctx);
  load('textoBusca', 'cidadesAtendidas'); load('cidadesAtendidas', 'dicaLocal'); load('dicaLocal', 'localEsperado');
  load('textoMapa', 'variantesEnderecoMapa'); load('buscaCidadeExplicitada', 'mensagemErroAmigavel');
  assert.equal(ctx.dicaLocal('Rua Sete de Setembro, 100, Centro, Estiva Gerbi'), 'estiva gerbi');
  assert.equal(ctx.buscaCidadeExplicitada('Rua Sete de Setembro, 100, Estiva Gerbi - SP'), true);
});

test('client app sends rides that start in Estiva Gerbi to the Conchal motoboys', () => {
  const ctx = vm.createContext({});
  const load = (name, next) => vm.runInContext(html.slice(html.indexOf(`function ${name}(`), html.indexOf(`function ${next}(`)), ctx);
  load('distanciaKmMapa', 'cidadeOperacaoPorTexto'); load('textoBusca', 'cidadesAtendidas');
  load('cidadeOperacaoPorTexto', 'cidadeMapaPorTexto');
  vm.runInContext('function coordenadaValida(p){return !!p&&Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lon))}', ctx);
  // Pelo GPS, Estiva fica um pouco mais perto do centro de Aguai do que de Conchal.
  assert.equal(ctx.cidadeOperacaoPorOrigem({ ...estiva, texto: 'Minha localizacao' }), 'conchal');
  assert.equal(ctx.cidadeOperacaoPorOrigem({}, 'Rua Sete de Setembro, 100, Estiva Gerbi'), 'conchal');
  assert.equal(ctx.cidadeOperacaoPorOrigem({ lat: -22.0572, lon: -46.9781 }), 'aguai');
});

test('server keeps Estiva Gerbi results and puts those rides in Conchal', () => {
  const ctx = vm.createContext({ streetNumber, normalizeText, Math, Number, Object });
  vm.runInContext(backend.slice(backend.indexOf('function requestedPlaceHint('), backend.indexOf('function ensureResolvedPlaceMatches(')), ctx);
  vm.runInContext(backend.slice(backend.indexOf('const RIDE_CITY_CENTERS = {'), backend.indexOf('function normalizedPersonName(')), ctx);
  assert.equal(ctx.requestedPlaceHint('Rua Sete de Setembro, 100, Centro, Estiva Gerbi'), 'estiva gerbi');
  assert.equal(ctx.inferNewRideOperatingCity({ origemLat: estiva.lat, origemLon: estiva.lon, origem: 'Minha localizacao' }), 'conchal');
  assert.equal(ctx.inferNewRideOperatingCity({ origem: 'Rua Sete de Setembro, 100, Estiva Gerbi - SP' }, 'aguai'), 'conchal');
  assert.equal(ctx.inferNewRideOperatingCity({ origemLat: -22.0572, origemLon: -46.9781 }), 'aguai');
});

test('a ride from outside the served cities goes to the motoboys of the destination city', () => {
  const ctx = vm.createContext({ streetNumber, normalizeText, Math, Number, Object });
  vm.runInContext(backend.slice(backend.indexOf('const RIDE_CITY_CENTERS = {'), backend.indexOf('function normalizedPersonName(')), ctx);
  // Uniararas (Araras) fica a uns 20 km de Eng. Coelho e de Conchal; o destino e Conchal.
  const araras = { origemLat: -22.3744441, origemLon: -47.3692512, origem: 'Minha localização atual pelo GPS' };
  assert.equal(ctx.inferNewRideOperatingCity({ ...araras, destino: 'Rua Benedito novo, 838, novo horizonte Conchal' }, 'engenheiro_coelho'), 'conchal');
  assert.equal(ctx.inferNewRideOperatingCity({ ...araras, destinoLat: -22.3308, destinoLon: -47.1724, destino: 'Rua X' }), 'conchal');
  assert.equal(ctx.inferNewRideOperatingCity({ ...araras, destinoLat: -22.48805, destinoLon: -47.21572, destino: 'Centro' }), 'engenheiro_coelho');
  // Corrida que sai de dentro de Conchal continua em Conchal, mesmo indo para fora.
  assert.equal(ctx.inferNewRideOperatingCity({ origemLat: -22.335, origemLon: -47.17, destino: 'Uniararas, Araras' }), 'conchal');
});
