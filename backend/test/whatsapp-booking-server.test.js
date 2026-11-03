import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { streetNumber } from '../src/address-search.js';
import { GAZETTEER_CITIES, gazetteerCityKey, gazetteerFor } from '../src/conchal-gazetteer.js';
import { BOOKING_CITIES } from '../src/whatsapp-booking.js';

// O pedido do WhatsApp passa pelas MESMAS conferencias do app (funcoes reais do servidor):
// endereco confere com o mapa, rota plausivel, preco da tabela e pedido repetido.
const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const slice = (a, b) => { const i = source.indexOf(a); const j = source.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, a); return source.slice(i, j); };
const normalizeText = (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function setup({ km = 2.07, geocode, cityForPoint = () => 'conchal' } = {}) {
  const docs = new Map();
  const queries = [], created = [], notified = [];
  const ref = (path) => ({ path, id: path.split('/').at(-1), get: async () => ({ exists: docs.has(path), id: path.split('/').at(-1), data: () => docs.get(path) }) });
  let auto = 0;
  const ctx = vm.createContext({
    console, Date, Math, Number, String, Object, Array, JSON, Promise, URLSearchParams, AbortSignal,
    streetNumber, normalizeText, GAZETTEER_CITIES, gazetteerCityKey, gazetteerFor, BOOKING_CITIES,
    GEOAPIFY_API_KEY: 'test-only', RIDE_EXPIRE_MS: 600000, CUSTOMER_REGISTRATION_ENFORCED: false, CUSTOMER_FREE_RIDES: 3,
    cleanText: (v, max = 500) => String(v || '').trim().slice(0, max),
    onlyDigits: (v) => String(v || '').replace(/\D/g, ''),
    validCoordinate: (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180,
    validDeviceId: () => '', canonicalRideCity: (v, d) => v || d, validDriverPhoto: () => '',
    timestampMs: (v) => Number(v || 0), customerProfileComplete: (c) => !!c.nome,
    cityForPoint, inferNewRideOperatingCity: (ride, fallback) => fallback || 'conchal',
    learnedAddresses: { lookup: async () => null },
    geocodeCapturedAddress: async (query) => { queries.push(query); if (geocode) return geocode(query); throw new Error('nao achei'); },
    searchMapAddress: async () => ({ suggestions: ['Rua das Azaleias', 'Rua das Acacias - Jardim Sao Paulo'] }),
    calculateRouteDistanceKm: async () => km,
    findRecentDuplicateRide: async () => '',
    notifyDriversAboutRide: async (id) => { notified.push(id); return { sent: 1, failed: 0 }; },
    notifyTelegramAboutRide: async () => ({ sent: true }),
    rideStatusCache: new Map(),
    db: {
      collection: (name) => ({ doc: (id) => ref(`${name}/${id || `auto${++auto}`}`), where: () => ({ where: () => ({ limit: () => ({ get: async () => ({ size: 0, docs: [] }) }) }), limit: () => ({ get: async () => ({ docs: [] }) }) }) }),
      runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, data) => { docs.set(r.path, data); created.push(data); }, update: (r, data) => docs.set(r.path, { ...docs.get(r.path), ...data }) })
    },
    admin: { firestore: { FieldValue: { serverTimestamp: () => 'TS', delete: () => 'DEL' } } }
  });
  vm.runInContext(slice('function money(value)', 'function nightRideActive('), ctx);
  vm.runInContext(slice('function expectedFare(km)', 'function rideSplit('), ctx);
  vm.runInContext(slice('function requestedPlaceHint(', 'function deliveryDestinations('), ctx);
  vm.runInContext(slice('function ridePublicData(ride)', 'function carRidePublicData('), ctx);
  vm.runInContext(slice('async function createRideRecord(', "app.post('/api/rides', createRideLimiter"), ctx);
  vm.runInContext(slice('// ---------- Pedido de corrida pelo WhatsApp da empresa ----------', 'const whatsappBooking = createWhatsappBooking('), ctx);
  return { ctx, docs, queries, created, notified };
}

test('a typed pickup without city uses the only city where the street exists; otherwise the bot asks', async () => {
  const h = setup({ geocode: (query) => ({ lat: -22.3322, lon: -47.1774, text: 'Rua das Azaleias, 65 - Centro, Conchal - SP' }) });
  const azaleias = await h.ctx.resolveBookingPlace({ text: 'Rua das Azaleias 65', role: 'origem' });
  assert.equal(azaleias.ok, true);
  assert.equal(azaleias.lugar.cidade, 'conchal');
  assert.equal(h.queries.at(-1), 'Rua das Azaleias 65, Conchal');
  // Rua que nao existe em nenhuma das tres cidades: pergunta a cidade em vez de chutar Conchal.
  const unknown = await h.ctx.resolveBookingPlace({ text: 'Rua Inexistente da Silva 10', role: 'origem' });
  assert.equal(unknown.pedirCidade, true);
});

test('the destination uses the pickup city unless another city is written', async () => {
  const h = setup({ geocode: (query) => ({ lat: -22.05, lon: -46.97, text: `${query} - SP` }) });
  await h.ctx.resolveBookingPlace({ text: 'Rua Sete de Setembro 300', city: 'aguai', role: 'destino' });
  assert.equal(h.queries.at(-1), 'Rua Sete de Setembro 300, Aguaí');
  await h.ctx.resolveBookingPlace({ text: 'Rua Dorival Pradela 140 Limeira', city: 'conchal', role: 'destino' });
  assert.equal(h.queries.at(-1), 'Rua Dorival Pradela 140, Limeira');
  assert.equal(h.ctx.bookingAddressText('Rua Mogi Mirim 100 Centro'), 'Rua Mogi Mirim 100 Centro');
  assert.equal(h.ctx.bookingAddressText('Rua 15 de Novembro 300 Limeira'), 'Rua 15 de Novembro 300, Limeira');
  assert.equal(h.ctx.bookingAddressText('Rua das Azaleias, 65, Conchal'), 'Rua das Azaleias, 65, Conchal');
});

test('a pickup outside the served cities is refused; an unknown street returns the suggestions', async () => {
  const far = setup({ geocode: () => ({ lat: -23.55, lon: -46.63, text: 'Rua X, 10 - Sao Paulo - SP' }), cityForPoint: () => '' });
  assert.equal((await far.ctx.resolveBookingPlace({ text: 'Rua das Azaleias 65', role: 'origem' })).motivo, 'fora_da_area');
  assert.equal((await far.ctx.resolveBookingPlace({ location: { lat: -23.55, lon: -46.63 }, role: 'origem' })).motivo, 'fora_da_area');
  const h = setup();
  const missing = await h.ctx.resolveBookingPlace({ text: 'Rua das Azaleias 65', role: 'origem' });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.sugestoes, ['Rua das Azaleias', 'Rua das Acacias - Jardim Sao Paulo']);
});

test('the ride created from WhatsApp passes the same checks as the app and carries the WhatsApp markers', async () => {
  const h = setup();
  const quote = await h.ctx.quoteBookingRide({ ...{ lat: -22.3322, lon: -47.1774, encontrado: 'Rua das Azaleias, 65 - Centro, Conchal - SP', cidade: 'conchal' } }, { lat: -22.34, lon: -47.16, texto: 'rua dos zancheta 128', encontrado: 'Rua dos Zancheta, 128 - Jardim Bela Vista, Conchal - SP' });
  assert.equal(quote.valor, h.ctx.expectedFare(2.07));
  const result = await h.ctx.createBookingRide({
    phone: '5519999338422', nome: 'Rafael', requestId: 'wa-abc',
    origem: { gps: true, lat: -22.3322, lon: -47.1774, texto: 'Localização enviada pelo WhatsApp', encontrado: 'Rua das Azaleias, 65 - Centro, Conchal - SP', cidade: 'conchal' },
    destino: { gps: false, lat: -22.34, lon: -47.16, texto: 'rua dos zancheta 128', encontrado: 'Rua dos Zancheta, 128 - Jardim Bela Vista, Conchal - SP' },
    cotacao: quote
  });
  assert.equal(result.duplicated, false);
  assert.equal(result.rideId, 'wa-abc');
  const ride = h.created[0];
  assert.equal(ride.status, 'pendente');
  assert.equal(ride.telefoneCliente, '19999338422');
  assert.equal(ride.origemPedido, 'whatsapp');
  assert.equal(ride.whatsappAcompanhar, true);
  assert.match(ride.origem, /GPS/);
  assert.equal(ride.valor, quote.valor);
  assert.deepEqual(h.notified, ['wa-abc'], 'the drivers are called exactly as for the app');
});

test('a price that no longer matches the table is refused by the server (never trusted from the chat)', async () => {
  const h = setup({ km: 6 });
  await assert.rejects(h.ctx.createBookingRide({
    phone: '5519999338422', nome: 'Rafael', requestId: 'wa-x',
    origem: { gps: true, lat: -22.33, lon: -47.17, texto: 'GPS', encontrado: 'Rua A, 1 - Conchal - SP', cidade: 'conchal' },
    destino: { gps: false, lat: -22.34, lon: -47.16, texto: 'rua b 2', encontrado: 'Rua B, 2 - Conchal - SP' },
    cotacao: { km: 2, valor: h.ctx.expectedFare(2), periodo: 'dia', cidade: 'conchal' }
  }), (error) => error.code === 'valor_nao_confere_com_tabela');
  assert.equal(h.created.length, 0);
});

test('too long or zero-length trips are refused with a clear message', async () => {
  await assert.rejects(setup({ km: 75 }).ctx.quoteBookingRide({ lat: 1, lon: 1, encontrado: 'A', cidade: 'conchal' }, { lat: 2, lon: 2, texto: 'b', encontrado: 'B' }), /60 km/);
  await assert.rejects(setup({ km: 0 }).ctx.quoteBookingRide({ lat: 1, lon: 1, encontrado: 'A', cidade: 'conchal' }, { lat: 1, lon: 1, texto: 'b', encontrado: 'B' }), /mesmo lugar/);
});

test('the app keeps the same answers from the shared creation (201 new, 200 duplicated)', async () => {
  const h = setup();
  const base = { clientRequestId: 'app-1', nome: 'Cliente', telefoneCliente: '19999990000', origem: 'Localização atual pelo GPS', origemDigitada: 'Localização atual pelo GPS', origemEncontrada: 'Rua A, 1 - Conchal - SP', origemLat: -22.33, origemLon: -47.17, destino: 'Rua B 2', destinoEncontrado: 'Rua B, 2 - Conchal - SP', destinoLat: -22.34, destinoLon: -47.16, valor: h.ctx.expectedFare(2.07), cidadeOperacao: 'conchal' };
  const first = await h.ctx.createRideRecord({ ...base });
  assert.equal(first.httpStatus, 201);
  assert.deepEqual(Object.keys(first.body).sort(), ['push', 'rideId', 'telegram']);
  const again = await h.ctx.createRideRecord({ ...base });
  assert.equal(again.httpStatus, 200);
  assert.equal(JSON.stringify(again.body), JSON.stringify({ rideId: 'app-1', duplicated: true, push: { sent: 0, failed: 0 } }));
});
