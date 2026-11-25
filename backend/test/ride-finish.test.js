import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { provaPorGps, mensagemSemProva, tempoMinimoSegundos, embarqueGpsMs, CODIGO_CHEGADA_TENTATIVAS } from '../src/ride-finish.js';

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
function slice(a, b) { const i = source.indexOf(a); const j = source.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, a); return source.slice(i, j); }
const DRIVER = '11111111111';
const AGORA = Date.UTC(2026, 10, 25, 15, 0, 0);
// Embarque no centro de Conchal e destino ~2,4 km dali.
const ORIGEM = { origemLat: -22.3300, origemLon: -47.1730 };
const DESTINO = { destinoLat: -22.3480, destinoLon: -47.1600 };
const noDestino = { latitude: -22.3482, longitude: -47.1601, accuracy: 10, serverTimestampMs: AGORA - 5000 };
const noEmbarque = { latitude: -22.3301, longitude: -47.1731, accuracy: 10, serverTimestampMs: AGORA - 5000 };

const corrida = (extra = {}) => ({
  status: 'aceita', modalidade: 'corrida', motoboyCpf: DRIVER, clienteAvisadoEm: 1, km: 2.8, ...ORIGEM, ...DESTINO,
  codigoChegada: '5093', pagamento: { status: 'approved', total: 12 }, ...extra
});

test('GPS prova a corrida so com embarque, destino perto e tempo de viagem possivel', () => {
  const feita = corrida({ embarqueGpsEmMs: AGORA - 10 * 60 * 1000 });
  assert.deepEqual(provaPorGps(feita, noDestino, AGORA), { ok: true, distanciaM: 25 });

  // O golpe da foto: aceitou, o cliente ja pagou, e finalizou sem ir ao embarque nem ao destino.
  assert.equal(provaPorGps(corrida(), noEmbarque, AGORA).motivo, 'sem_embarque_gps');
  // Passou no embarque mas finalizou ainda la.
  const longe = provaPorGps(corrida({ embarqueGpsEmMs: AGORA - 60000 }), noEmbarque, AGORA);
  assert.equal(longe.motivo, 'longe_do_destino');
  assert.ok(longe.distanciaM > 2000);
  assert.match(mensagemSemProva(longe), /você está a 2,\d km do destino/);
  // No destino, mas rapido demais para 2,8 km (minimo 144 s a 70 km/h).
  assert.equal(tempoMinimoSegundos(feita), 144);
  assert.equal(provaPorGps(corrida({ embarqueGpsEmMs: AGORA - 60000 }), noDestino, AGORA).motivo, 'rapido_demais');
  // GPS parado ha mais de 3 min nao vale.
  assert.equal(provaPorGps(feita, { ...noDestino, serverTimestampMs: AGORA - 4 * 60 * 1000 }, AGORA).motivo, 'gps_sem_sinal');
  assert.equal(provaPorGps(feita, null, AGORA).motivo, 'gps_sem_sinal');
  // Sem destino no mapa: so com o codigo do cliente.
  assert.equal(provaPorGps(corrida({ destinoLat: 0, destinoLon: 0, embarqueGpsEmMs: 1 }), noDestino, AGORA).motivo, 'destino_sem_mapa');
  // Corridas antigas: a chegada marcada pelo GPS conta como embarque; marcada no botao, nao.
  assert.equal(embarqueGpsMs({ motoboyChegouPor: 'gps', motoboyChegouEmMs: 123 }), 123);
  assert.equal(embarqueGpsMs({ motoboyChegouPor: 'motoboy', motoboyChegouEmMs: 123 }), 0);
});

function harness(ride, { location = null } = {}) {
  const records = new Map([['corridas/r1', ride]]);
  const apply = (path, d) => records.set(path, { ...records.get(path), ...Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v?.inc ? Number(records.get(path)?.[k] || 0) + v.inc : v])) });
  const ref = (path) => ({ path, id: path.split('/').at(-1), get: async () => ({ exists: records.has(path), data: () => records.get(path) }), set: async (d) => apply(path, d) });
  const db = { collection: (name) => ({ doc: (id) => ref(`${name}/${id}`) }),
    runTransaction: async (fn) => { const ops = []; await fn({ get: (r) => r.get(), set: (r, d) => ops.push([r, d]) }); for (const [r, d] of ops) await r.set(d); } };
  const routes = {};
  const earnings = [];
  const RealDate = Date;
  const FakeDate = class extends RealDate { static now() { return AGORA; } };
  const ctx = vm.createContext({ db, Math, Number, String, Date: FakeDate,
    admin: { firestore: { FieldValue: { serverTimestamp: () => 'TS', increment: (n) => ({ inc: n }), delete: () => undefined } } },
    onlyDigits: (v) => String(v || '').replace(/\D/g, ''), timestampMs: () => AGORA,
    getDriverWithProof: async () => ({}), isStandaloneDelivery: (r) => r.modalidade === 'entrega_avulsa', STANDALONE_DELIVERY_CODE_MAX_ATTEMPTS: 5,
    rideSplitAmounts: () => ({ driverAmount: 9.24, appFee: 2.76, driverPercent: 0.77, appPercent: 0.23 }),
    driverEarningEvent: () => ({}), recordDriverEarning: async () => { earnings.push(1); },
    provaPorGps: (r, l) => provaPorGps(r, l, AGORA), mensagemSemProva, codigoChegada: () => '7777', CODIGO_CHEGADA_TENTATIVAS,
    liveLocationFor: () => location, rideStatusCache: new Map(),
    app: { post: (p, ...h) => { routes[p] = h.at(-1); } } });
  vm.runInContext(slice("app.post('/api/rides/:rideId/finish'", "app.post('/api/admin/deliveries/:deliveryId/force-finish'"), ctx);
  const call = async (body = {}) => {
    const out = { status: 200 }; let failure;
    const res = { status: (c) => { out.status = c; return res; }, json: (d) => { out.data = d; return res; } };
    await routes['/api/rides/:rideId/finish']({ params: { rideId: 'r1' }, body: { driverCpf: DRIVER, ...body } }, res, (e) => { failure = e; });
    if (failure) { out.status = failure.status || 500; out.data = { error: failure.code, message: failure.message }; }
    return out;
  };
  return { records, call, earnings };
}

test('corrida paga nao finaliza sem ir ao destino: precisa do GPS ou do codigo do cliente', async () => {
  const golpe = harness(corrida(), { location: noEmbarque });
  const tentativa = await golpe.call();
  assert.equal(tentativa.status, 409);
  assert.equal(tentativa.data.error, 'confirme_chegada_no_destino');
  assert.equal(tentativa.data.precisaCodigoChegada, true);
  assert.equal(golpe.records.get('corridas/r1').status, 'aceita');
  assert.equal(golpe.earnings.length, 0, 'nenhum ganho registrado');

  const chute = await golpe.call({ codigoChegada: '1234' });
  assert.equal(chute.data.error, 'codigo_chegada_invalido');
  assert.equal(chute.data.tentativasRestantes, 4);
  assert.equal(golpe.records.get('corridas/r1').tentativasCodigoChegada, 1);
  assert.equal(golpe.records.get('corridas/r1').status, 'aceita');

  // O cliente desceu antes e passou o codigo: finaliza, marcado como "codigo_chegada".
  const certo = await golpe.call({ codigoChegada: '5093' });
  assert.equal(certo.status, 200);
  const salva = golpe.records.get('corridas/r1');
  assert.equal(salva.status, 'finalizada');
  assert.equal(salva.finalizadaPor, 'codigo_chegada');
  assert.equal(golpe.earnings.length, 1);
});

test('com o GPS no destino a corrida finaliza sozinha, sem pedir codigo', async () => {
  const feita = harness(corrida({ embarqueGpsEmMs: AGORA - 12 * 60 * 1000 }), { location: noDestino });
  const ok = await feita.call();
  assert.equal(ok.status, 200);
  assert.equal(feita.records.get('corridas/r1').finalizadaPor, 'gps');
  assert.equal(feita.records.get('corridas/r1').distanciaDestinoFinalM, 25);
});

test('corrida aceita antes da trava ganha o codigo na hora; tentativas esgotadas bloqueiam', async () => {
  const antiga = harness(corrida({ codigoChegada: undefined }), { location: null });
  const primeira = await antiga.call({ codigoChegada: '5093' });
  assert.equal(primeira.data.error, 'confirme_chegada_no_destino');
  assert.equal(antiga.records.get('corridas/r1').codigoChegada, '7777');
  assert.equal((await antiga.call({ codigoChegada: '7777' })).status, 200);

  const bloqueada = harness(corrida({ tentativasCodigoChegada: 5 }), { location: noEmbarque });
  const resposta = await bloqueada.call({ codigoChegada: '5093' });
  assert.equal(resposta.status, 423);
  assert.equal(resposta.data.error, 'codigo_chegada_bloqueado');
});

test('o codigo de chegada nunca vai para o app do motoboy', () => {
  for (const nome of ['function publicPendingJob(', 'function privateDriverJob(']) {
    const corpo = slice(nome, '\n}\n');
    assert.match(corpo, /delete copy\.codigoChegada;/, nome);
    assert.match(corpo, /delete copy\.tentativasCodigoChegada;/, nome);
  }
});
