import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { GAZETTEER_CITIES, gazetteerFor } from '../src/conchal-gazetteer.js';

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const slice = (a, b) => { const i = source.indexOf(a); const j = source.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, a); return source.slice(i, j); };

function harness() {
  const docs = new Map();
  const routes = {};
  let reads = 0;
  const db = { collection: () => ({
    limit: () => ({ get: async () => { reads += 1; return { docs: [...docs].map(([id, data]) => ({ id, data: () => data })) }; } }),
    doc: (id = `d${docs.size + 1}`) => ({ id, set: async (d) => docs.set(id, d), delete: async () => docs.delete(id) })
  }) };
  const normalizeText = (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
  const ctx = vm.createContext({ db, GAZETTEER_CITIES, gazetteerFor, normalizeText, console, Object, Number, String, Date, Array, Math,
    cleanText: (v, n) => String(v || '').trim().slice(0, n), assertOwner: (_q, _s, next) => next(),
    validCoordinate: (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon) && (p.lat || p.lon),
    coordinateDistanceKm: (a, b) => Math.hypot(a.lat - b.lat, a.lon - b.lon) * 111,
    RIDE_CITY_CENTERS: { conchal: { lat: -22.3308, lon: -47.1724 }, aguai: { lat: -22.0572, lon: -46.9781 }, engenheiro_coelho: { lat: -22.48805, lon: -47.21572 } },
    mapLimiter: () => {}, app: { get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); } } });
  vm.runInContext(slice('// ---------- Lugares conhecidos', "app.get('/api/maps/geocode',"), ctx);
  const call = async (key, { body = {}, params = {}, query = {} } = {}) => {
    let status = 200, out;
    const res = { status: (s) => { status = s; return res; }, json: (d) => { out = d; return res; }, set: () => res };
    await routes[key]({ body, params, query }, res, (e) => { status = 500; out = { error: e.message }; });
    return { status, body: out };
  };
  return { ctx, call, docs, reads: () => reads };
}

test('dono cadastra um lugar pelo endereco e o cliente acha pelo nome (na memoria, sem ler o banco)', async () => {
  const h = harness();
  const novo = await h.call('POST /api/admin/places', { body: { nomes: 'Farmácia Central; Drogaria Central', endereco: 'Rua Mogi Mirim, 500', cidade: 'conchal' } });
  assert.equal(novo.status, 200);
  assert.match(novo.body.lugar.endereco, /Rua Mogi Mirim, 500/);
  const antes = h.reads();
  const achado = h.ctx.findKnownPlace('pro drogaria central por favor');
  assert.equal(achado.nomes[0], 'Farmácia Central');
  assert.equal(h.reads(), antes);
  assert.equal(h.ctx.findKnownPlace('drogaria central', 'aguai'), null, 'lugar de Conchal nao aparece na busca de Aguai');
  const f = h.ctx.knownPlaceFeature(achado).properties;
  assert.equal(f.match_source, 'manual'); assert.equal(f.match_confirmed, true);
  assert.match(f.formatted, /Farmácia Central - Rua Mogi Mirim, 500/);
  // Consulta das cidades conta o lugar.
  const cidades = await h.call('GET /api/maps/geocode-cities', { query: { text: 'drogaria central' } });
  assert.equal(cidades.body.cidades[0].cidade, 'conchal');
  // Coordenada colada do Google Maps tambem vale; endereco que nao existe e recusado.
  assert.equal((await h.call('POST /api/admin/places', { body: { nomes: 'Hospital', coordenada: '-22.3350, -47.1700', cidade: 'conchal' } })).status, 200);
  assert.equal((await h.call('POST /api/admin/places', { body: { nomes: 'Lugar X', endereco: 'Rua Que Nao Existe Nunca, 1', cidade: 'conchal' } })).status, 400);
  assert.equal((await h.call('POST /api/admin/places', { body: { nomes: 'Longe', coordenada: '-23.5, -46.6', cidade: 'conchal' } })).status, 400);
  // Ao ligar o servidor, carrega do banco; apagar tira da memoria.
  await h.ctx.loadKnownPlaces();
  assert.equal((await h.call('GET /api/admin/places')).body.lugares.length, 2);
  await h.call('POST /api/admin/places/:id/delete', { params: { id: novo.body.lugar.id } });
  assert.equal(h.ctx.findKnownPlace('drogaria central'), null);
});

test('rua com nome de cidade (Rua Mogi Mirim, Rua Araras) nao vira "corrida para outra cidade"', () => {
  const ctx = vm.createContext({ normalizeText: (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\s+/g, ' ') });
  const i = source.indexOf('function ensureDistantRouteIsPlausible('); vm.runInContext(source.slice(i, source.indexOf('\n}\n', i) + 3), ctx);
  const ok = (km, ...t) => { try { ctx.ensureDistantRouteIsPlausible(km, ...t); return true; } catch { return false; } };
  assert.equal(ok(1.6, { origem: 'Conchal' }, 'supermercado são roque', 'Supermercado São Roque - Rua Mogi Mirim, 417 - Centro, Conchal - SP'), true);
  assert.equal(ok(1.6, 'Rua Araras, 130', 'Rua Araras, 130 - Centro, Conchal - SP'), true);
  assert.equal(ok(1, 'Rua Clemente Ferreira, 10'), true, '"Clemente" nao e a cidade de Leme');
  assert.equal(ok(2, 'Rua Vereador Antonio Leme de Arruda, 50'), true);
  // Outra cidade de verdade com rota curta continua sendo barrada.
  assert.equal(ok(3, 'Rua Tiradentes, 10, Araras', 'Rua Tiradentes, 10 - Centro, Araras - SP'), false);
});
