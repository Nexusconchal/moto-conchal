import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { streetNumber } from '../src/address-search.js';

const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const backend = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(html.slice(html.indexOf('function coordenadasDoTexto('), html.indexOf('async function geocodificar(')), ctx);

test('coordinates pasted from Google Maps become the ride point', () => {
  assert.deepEqual({ ...ctx.coordenadasDoTexto('22,28896° S, 46,96437° O') }, { lat: -22.28896, lon: -46.96437, texto: '-22.28896, -46.96437' });
  assert.equal(ctx.coordenadasDoTexto('-22.28896, -46.96437').lon, -46.96437);
  assert.equal(ctx.coordenadasDoTexto('22.28896 S 46.96437 W').lat, -22.28896);
  assert.equal(ctx.coordenadasDoTexto('https://www.google.com/maps/@-22.2889647,-46.9643712,17z').lat, -22.2889647);
});

test('street addresses are not mistaken for coordinates', () => {
  assert.equal(ctx.coordenadasDoTexto('Rua dos Pianca, 71'), null);
  assert.equal(ctx.coordenadasDoTexto('Rua Sete de Setembro, 100, Estiva Gerbi'), null);
  assert.equal(ctx.coordenadasDoTexto('Rua 4, 12,500'), null);
  // Fora da regiao atendida.
  assert.equal(ctx.coordenadasDoTexto('48.85661, 2.35222'), null);
});

test('the server accepts a ride whose origin was typed as coordinates', () => {
  const normalizeText = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const sctx = vm.createContext({ streetNumber, normalizeText });
  vm.runInContext(backend.slice(backend.indexOf('function requestedPlaceHint('), backend.indexOf('function ensureDistantRouteIsPlausible(')), sctx);
  assert.doesNotThrow(() => sctx.ensureResolvedPlaceMatches('22,28896° S, 46,96437° O', '-22.28896, -46.96437', 'Origem da corrida'));
  assert.doesNotThrow(() => sctx.ensureResolvedAddressIsSpecific('22,28896° S, 46,96437° O', '-22.28896, -46.96437', 'Origem da corrida'));
});
