import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { parseRating, ratingBlocker, ratingSummary, driverRatingView, RATING_TAGS } from '../src/ride-rating.js';

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const DRIVER = '11111111111', DEVICE = 'device-client-1234567890';
const DAY = 86400000;

function slice(a, b) { const i = source.indexOf(a); const j = source.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, a); return source.slice(i, j); }

// Aplica set com merge, incrementos e mapas aninhados (notaDist).
function merge(base = {}, data = {}) {
  const out = { ...base };
  for (const [key, value] of Object.entries(data)) {
    if (value?.inc) out[key] = Number(out[key] || 0) + value.inc;
    else if (value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).some((v) => v?.inc)) out[key] = merge(out[key], value);
    else out[key] = value;
  }
  return out;
}

function harness(ride) {
  const records = new Map([['corridas/r1', ride], [`motoboys/${DRIVER}`, { nome: 'Bruno' }]]);
  const ref = (path) => ({ path, id: path.split('/').at(-1), get: async () => snap(path),
    collection: (name) => ({ doc: (id) => ref(`${path}/${name}/${id}`), orderBy: () => ({ limit: () => ({ get: async () => ({ docs: [...records.keys()].filter((k) => k.startsWith(`${path}/${name}/`)).map(snap).sort((a, b) => b.data().criadoEmMs - a.data().criadoEmMs) }) }) }) }) });
  const snap = (path) => ({ id: path.split('/').at(-1), exists: records.has(path), data: () => records.get(path) });
  const write = (r, d, o) => records.set(r.path, o?.merge ? merge(records.get(r.path), d) : d);
  const db = { collection: (name) => ({ doc: (id) => ref(`${name}/${id}`) }),
    runTransaction: async (fn) => { const ops = []; await fn({ get: (r) => r.get(), set: (r, d, o) => ops.push([r, d, o]) }); ops.forEach((op) => write(...op)); } };
  const routes = {};
  const ctx = vm.createContext({ db, Date, Math, Number, String, Object, Array, Set, Map, console,
    admin: { firestore: { FieldValue: { increment: (n) => ({ inc: n }) } } },
    parseRating, ratingBlocker, ratingSummary, driverRatingView, RATING_TAGS,
    maskChatText: (v) => String(v || '').replace(/\d{8,}/g, '[número oculto]'),
    cleanText: (v, n = 200) => String(v || '').trim().slice(0, n), onlyDigits: (v) => String(v || '').replace(/\D/g, ''),
    hashSecret: hash, timestampMs: (v) => Number(v || 0), rideStatusCache: new Map(), adminStateCache: {}, createRideLimiter: 0,
    getDriverWithProof: async (_cpf, body) => { if (body.driverCnh !== 'ok') throw Object.assign(new Error('prova'), { status: 401 }); return {}; },
    canReadRideTracking: async (req, access) => !!req.header('x-customer-device') && hash(req.header('x-customer-device')) === access.deviceHash,
    app: { get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[p] = h.at(-1); } } });
  vm.runInContext(slice('// Avaliacao do motoboy pelo cliente', "app.post('/api/rides/:rideId/renew'"), ctx);
  const call = async (path, { body = {}, device = '', cpf = DRIVER } = {}) => {
    const out = { status: 200 }; let failure;
    const res = { status: (c) => { out.status = c; return res; }, json: (d) => { out.data = d; return res; } };
    await routes[path]({ params: { rideId: 'r1', cpf }, body, header: (n) => (n === 'x-customer-device' ? device : '') }, res, (e) => { failure = e; });
    if (failure) { out.status = failure.status || 500; out.data = { error: failure.code, message: failure.message }; }
    return out;
  };
  return { records, call };
}

const finished = (extra = {}) => ({ status: 'finalizada', finalizadaEm: Date.now() - 60000, motoboyCpf: DRIVER, motoboy: 'Bruno', nome: 'Ana Cliente', clienteDeviceId: DEVICE, ...extra });

test('client rates the motoboy once; tags must match the stars and the comment hides phone numbers', async () => {
  const h = harness(finished());
  const stranger = await h.call('/api/rides/:rideId/rating', { body: { nota: 5 }, device: 'outro-aparelho-123456789' });
  assert.equal(stranger.status, 403);

  const ok = await h.call('/api/rides/:rideId/rating', { device: DEVICE, body: { nota: 5, tags: ['Ótima direção', 'Direção perigosa', 'inventada'], comentario: 'Muito bom! me chama 19999998888' } });
  assert.equal(ok.status, 200);
  const saved = h.records.get('corridas/r1').avaliacao;
  assert.deepEqual([...saved.tags], ['Ótima direção']);
  assert.equal(saved.comentario, 'Muito bom! me chama [número oculto]');
  const owner = h.records.get('avaliacoesMotoboy/r1');
  assert.equal(owner.clienteNome, 'Ana Cliente');
  assert.equal(owner.motoboyCpf, DRIVER);
  const mine = h.records.get(`motoboys/${DRIVER}/avaliacoes/r1`);
  assert.equal(mine.clienteNome, undefined);
  assert.equal(mine.rideId, undefined);
  const driver = h.records.get(`motoboys/${DRIVER}`);
  assert.equal(driver.notaSoma, 5);
  assert.equal(driver.notaQtd, 1);
  assert.equal(driver.notaDist[5], 1);

  const again = await h.call('/api/rides/:rideId/rating', { device: DEVICE, body: { nota: 1 } });
  assert.equal(again.status, 409);
  assert.equal(again.data.error, 'corrida_ja_avaliada');
  assert.equal(h.records.get(`motoboys/${DRIVER}`).notaQtd, 1);
});

test('only finished rides with a motoboy, up to 7 days, with 1 to 5 stars', async () => {
  for (const [ride, body, error] of [
    [finished({ status: 'aceita' }), { nota: 4 }, 'corrida_nao_finalizada'],
    [finished({ motoboyCpf: '' }), { nota: 4 }, 'corrida_sem_motoboy'],
    [finished({ finalizadaEm: Date.now() - 8 * DAY }), { nota: 4 }, 'avaliacao_expirada'],
    [finished(), { nota: 6 }, 'nota_invalida'],
    [finished(), { nota: 0 }, 'nota_invalida']
  ]) {
    const out = await harness(ride).call('/api/rides/:rideId/rating', { device: DEVICE, body });
    assert.equal(out.data.error, error);
  }
});

test('motoboy sees average, distribution and recent feedback without client name or ride', async () => {
  const h = harness(finished());
  await h.call('/api/rides/:rideId/rating', { device: DEVICE, body: { nota: 4, tags: ['Rota ruim'], comentario: 'Errou o caminho' } });
  h.records.set(`motoboys/${DRIVER}`, { ...h.records.get(`motoboys/${DRIVER}`), notaSoma: 9, notaQtd: 2, notaDist: { 4: 1, 5: 1 } });
  const denied = await h.call('/api/drivers/:cpf/ratings', { body: { driverCnh: 'x' } });
  assert.equal(denied.status, 401);
  const out = await h.call('/api/drivers/:cpf/ratings', { body: { driverCnh: 'ok' } });
  assert.equal(out.data.media, 4.5);
  assert.equal(out.data.total, 2);
  assert.equal(out.data.distribuicao[4], 1);
  assert.equal(out.data.recentes.length, 1);
  assert.deepEqual(Object.keys(out.data.recentes[0]).sort(), ['comentario', 'dia', 'nota', 'tags']);
  assert.equal(out.data.recentes[0].comentario, 'Errou o caminho');
});

test('rating helpers', () => {
  assert.deepEqual(ratingSummary({}), { media: 0, total: 0, distribuicao: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 } });
  assert.equal(ratingSummary({ notaSoma: 14, notaQtd: 3 }).media, 4.67);
  assert.deepEqual(parseRating({ nota: '3', tags: RATING_TAGS.elogio }).tags, []);
  assert.equal(parseRating({ nota: 2, comentario: 'x'.repeat(900) }).comentario.length, 300);
  assert.equal(ratingBlocker(finished(), Date.now()), null);
  assert.equal(driverRatingView({ nota: 5, criadoEmMs: Date.UTC(2026, 9, 22, 15) }).dia, '22/10/2026');
  // O motoboy nao ve a nota de cada corrida na lista de servicos dele.
  assert.match(slice('function privateDriverJob(', 'function supportAlertVersion('), /delete copy\.avaliacao;/);
});

test('the client app offers exactly the tags the server accepts', () => {
  const front = fs.readFileSync(new URL('../../ride-rating.js', import.meta.url), 'utf8');
  const block = front.slice(front.indexOf('const TAGS = {'), front.indexOf('};', front.indexOf('const TAGS = {')) + 2);
  const tags = vm.runInNewContext(`(${block.replace('const TAGS = ', '').replace(/;$/, '')})`);
  assert.deepEqual(JSON.parse(JSON.stringify(tags)), RATING_TAGS);
});
