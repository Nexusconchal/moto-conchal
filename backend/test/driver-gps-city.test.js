import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const backend = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const normalizeText = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function load() {
  const ctx = vm.createContext({ normalizeText, Math, Number, Object });
  const slice = (from, to) => vm.runInContext(backend.slice(backend.indexOf(from), backend.indexOf(to)), ctx);
  slice('const RIDE_CITY_CENTERS', 'function rideCityLabel(');
  slice('function driverRideCities(', 'function rideOperatingCity(');
  slice('function coordinateDistanceKm(', 'function inferNewRideOperatingCity(');
  slice('// Cidade atendida mais proxima', 'function normalizedPersonName(');
  return ctx;
}

test('the motoboy GPS picks the nearest served city, Estiva Gerbi counts as Conchal, far away is outside', () => {
  const ctx = load();
  assert.equal(ctx.cityForPoint({ lat: -22.3308, lon: -47.1724 }), 'conchal');
  assert.equal(ctx.cityForPoint({ lat: -22.06, lon: -46.98 }), 'aguai');
  assert.equal(ctx.cityForPoint({ lat: -22.49, lon: -47.21 }), 'engenheiro_coelho');
  assert.equal(ctx.cityForPoint({ lat: -22.2708, lon: -46.9478 }), 'conchal');
  assert.equal(ctx.cityForPoint({ lat: -23.55, lon: -46.63 }), ''); // Sao Paulo
});

test('a motoboy receives services only from the GPS city; without GPS yet it is Conchal', () => {
  const ctx = load();
  assert.deepEqual({ ...ctx.driverRideCities({ cidadeGps: 'aguai', cidadesAtivas: { conchal: true } }) }, { conchal: false, aguai: true, engenheiro_coelho: false });
  assert.deepEqual({ ...ctx.driverRideCities({ cidadesAtivas: { aguai: true } }) }, { conchal: true, aguai: false, engenheiro_coelho: false });
});

test('deliveries get a city from the pickup point, or Conchal for old ones', () => {
  const ctx = load();
  assert.equal(ctx.deliveryOperatingCity({ retiradaLat: -22.06, retiradaLon: -46.98 }), 'aguai');
  assert.equal(ctx.deliveryOperatingCity({ cidadeOperacao: 'engenheiro_coelho', retiradaLat: -22.06, retiradaLon: -46.98 }), 'engenheiro_coelho');
  assert.equal(ctx.deliveryOperatingCity({}), 'conchal');
});

test('rides saved as engenheiro_coelho stay in Engenheiro Coelho (they used to fall back to Conchal)', () => {
  const ctx = vm.createContext({ normalizeText: value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ') });
  vm.runInContext(backend.slice(backend.indexOf('function canonicalRideCity('), backend.indexOf('function rideCityLabel(')), ctx);
  vm.runInContext(backend.slice(backend.indexOf('function rideOperatingCity('), backend.indexOf('function coordinateDistanceKm(')), ctx);
  assert.equal(ctx.rideOperatingCity({ cidadeOperacao: 'engenheiro_coelho' }), 'engenheiro_coelho');
  assert.equal(ctx.rideOperatingCity({ cidadeOperacao: 'aguai' }), 'aguai');
  assert.equal(ctx.rideOperatingCity({}), 'conchal');
});
