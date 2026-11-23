import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { liveJobs, activeJobsSnapshot } from './live-jobs-off.js';

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const slice = (start, end) => { const i = source.indexOf(start); assert.ok(i >= 0, start); const j = source.indexOf(end, i + 1); assert.ok(j > i, end); return source.slice(i, j); };
const onlyDigits = (v) => String(v || '').replace(/\D/g, '');
const cleanText = (v, n = 200) => String(v || '').trim().slice(0, n);

function sosHarness({ grupo = '120363@g.us', envioFalha = false, job = null } = {}) {
  const enviados = [], gravados = [], routes = {};
  const driver = { nome: 'João Silva', telefone: '19988887777', motoModelo: 'Honda CG 160', motoPlaca: 'ABC1D23', cidadeGps: 'fora' };
  const ctx = vm.createContext({
    Map, Date, Math, Number, String, Object, JSON, console, onlyDigits, cleanText, liveJobs, activeJobsSnapshot,
    DRIVER_GROUP_CITIES: ['conchal', 'aguai', 'engenheiro_coelho'], DRIVER_CITY_KM: 15, ESTIVA_GERBI_CENTER: { lat: -22.27, lon: -46.94 },
    coordinateDistanceKm: () => 99,
    servedCityWithin: (p) => (p.lat > -22.25 ? 'aguai' : p.lat > -22.4 ? 'conchal' : ''),
    rideCityLabel: (c) => ({ conchal: 'Conchal', aguai: 'Aguaí', engenheiro_coelho: 'Eng. Coelho' })[c] || c,
    isStandaloneDelivery: () => false,
    getDriverWithProof: async () => driver,
    supportAutomation: { config: async () => ({ driverGroupJid: grupo }) },
    whatsappGroupFor: async (city, settings) => (city === 'conchal' ? settings.driverGroupJid : ''),
    sendEvolutionText: async (numero, texto) => { if (envioFalha && numero.endsWith('@g.us')) throw new Error('falhou'); enviados.push({ numero, texto }); return { sent: true }; },
    OWNER_WHATSAPP: '5519992306488',
    db: {
      collection: (nome) => ({
        add: async (dados) => { gravados.push([nome, dados]); },
        where: () => ({ where: () => ({ limit: () => ({ get: async () => ({ docs: job && nome === 'corridas' ? [{ data: () => job }] : [] }) }) }) })
      })
    },
    app: { post: (path, ...h) => { routes[path] = h.at(-1); } }
  });
  vm.runInContext(slice('// ---------- SOS do motoboy', '// ---------- Perfil do motoboy: trocar a foto'), ctx);
  const call = async (body) => {
    const out = {}; let falha;
    const res = { status: (c) => { out.status = c; return res; }, json: (d) => { out.data = d; return res; } };
    await routes['/api/drivers/:cpf/sos']({ params: { cpf: '52998224725' }, body }, res, (e) => { falha = e; });
    if (falha) throw falha;
    return { status: out.status || 200, data: out.data };
  };
  return { call, enviados, gravados, ctx };
}

test('SOS manda no grupo da cidade onde ele esta, com nome, WhatsApp dele, moto, mapa e o servico (sem telefone do cliente)', async () => {
  const h = sosHarness({ job: { motoboyCpf: '52998224725', status: 'aceita', origem: 'Centro', destino: 'Rodoviária', telefoneCliente: '19911112222' } });
  const r = await h.call({ lat: -22.33, lon: -47.17, accuracy: 12 });
  assert.equal(r.status, 200);
  assert.equal(r.data.cidade, 'conchal');
  assert.match(r.data.message, /grupo de Conchal/);
  assert.equal(h.enviados.length, 1);
  assert.equal(h.enviados[0].numero, '120363@g.us');
  const t = h.enviados[0].texto;
  assert.match(t, /SOS/);
  assert.match(t, /João Silva · WhatsApp \(19\) 98888-7777/);
  assert.match(t, /Honda CG 160 · placa ABC1D23/);
  assert.match(t, /https:\/\/maps\.google\.com\/\?q=-22\.330000,-47\.170000 \(precisão ~12 m\)/);
  assert.match(t, /Em corrida: Centro → Rodoviária/);
  assert.match(t, /190/);
  assert.doesNotMatch(t, /19911112222|99111-2222/, 'nunca o telefone do cliente');
  assert.equal(h.gravados[0][0], 'sosMotoboys');
  // Segundo SOS logo em seguida: nao repete no grupo.
  const de_novo = await h.call({ lat: -22.33, lon: -47.17 });
  assert.equal(de_novo.status, 429);
  assert.equal(h.enviados.length, 1);
  // "Estou bem": avisa o mesmo grupo.
  const ok = await h.call({ acao: 'ok' });
  assert.equal(ok.status, 200);
  assert.match(h.enviados[1].texto, /João Silva avisou pelo app que está tudo bem/);
  assert.equal(h.enviados[1].numero, '120363@g.us');
  assert.equal((await h.call({ acao: 'ok' })).status, 409, 'sem SOS aberto');
});

test('SOS sem grupo na cidade ou com o grupo fora do ar vai para o WhatsApp do dono; sem GPS pede para ligar', async () => {
  const semGrupo = sosHarness({ grupo: '' });
  const r = await semGrupo.call({});
  assert.equal(r.status, 200);
  assert.equal(r.data.destino, 'dono');
  assert.equal(semGrupo.enviados[0].numero, '5519992306488');
  assert.match(semGrupo.enviados[0].texto, /Sem GPS no celular dele agora: ligue para ele/);
  assert.equal(r.data.cidade, 'conchal', 'fora da area e sem GPS: grupo principal (Conchal)');
  const falhou = sosHarness({ envioFalha: true });
  const r2 = await falhou.call({ lat: -22.33, lon: -47.17 });
  assert.equal(r2.data.destino, 'dono');
});

test('SOS em Aguaí vai para o grupo de Aguaí', () => {
  const h = sosHarness();
  assert.equal(h.ctx.sosCity({ lat: -22.2, lon: -46.98 }, {}), 'aguai');
  assert.equal(h.ctx.sosCity(null, { cidadeGps: 'engenheiro_coelho' }), 'engenheiro_coelho');
  assert.equal(h.ctx.sosCity(null, { cidadeGps: 'fora', cidadesAtivas: { aguai: true } }), 'aguai');
});

function perfilHarness(driver) {
  const routes = {}, gravado = [];
  const ctx = vm.createContext({
    Date, onlyDigits, cleanText, Object, String,
    admin: { firestore: { FieldValue: { serverTimestamp: () => 'TS' } } },
    authLimiter: 'limit', adminStateCache: {}, markAdminRefetch: () => {}, clearDriverProofCache: () => {},
    validDriverPhoto: (v) => (/^data:image\/jpeg;base64,/.test(v) ? v : ''),
    validDriverDocument: (v) => (/^data:image\/jpeg;base64,/.test(v) ? v : ''),
    driverBlockedResponse: () => ({ error: 'motoboy_bloqueado' }),
    assertDriverProof: (d, body, opts) => { if (!opts?.requireSession || body.driverToken !== 'chave') throw Object.assign(new Error('Entre de novo'), { status: 401 }); },
    db: { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => driver }), set: async (dados) => gravado.push(dados) }) }) },
    app: { post: (path, ...h) => { routes[path] = h.at(-1); } }
  });
  vm.runInContext(slice('// ---------- Perfil do motoboy: trocar a foto', "app.post('/api/drivers/:cpf/earnings/summary'"), ctx);
  const call = async (body) => {
    const out = {}; let falha;
    const res = { status: (c) => { out.status = c; return res; }, json: (d) => { out.data = d; return res; } };
    await routes['/api/drivers/:cpf/perfil']({ params: { cpf: '52998224725' }, body }, res, (e) => { falha = e; });
    if (falha) return { status: falha.status || 500, data: { message: falha.message } };
    return { status: out.status || 200, data: out.data };
  };
  return { call, gravado };
}

test('perfil: troca so a foto sem pedir CPF/CNH; placa nova vai para o dono conferir sem bloquear', async () => {
  const driver = { status: 'ativo', nome: 'João', motoModelo: 'CG', motoAno: '2019', motoPlaca: 'ABC1D23', crlvFoto: 'x' };
  const h = perfilHarness(driver);
  assert.equal((await h.call({ fotoMotoboy: 'data:image/jpeg;base64,AA' })).status, 401, 'precisa da chave do celular');
  const foto = await h.call({ driverToken: 'chave', fotoMotoboy: 'data:image/jpeg;base64,AA' });
  assert.equal(foto.status, 200);
  assert.equal(h.gravado[0].fotoMotoboy, 'data:image/jpeg;base64,AA');
  assert.equal(h.gravado[0].motoAlteracaoPendente, undefined);
  assert.equal(h.gravado[0].status, undefined, 'nao mexe no status (continua rodando)');
  const mesma = await h.call({ driverToken: 'chave', moto: { modelo: 'CG 160 Fan', ano: '2020', placa: 'abc1d23' } });
  assert.equal(mesma.data.conferencia, false, 'mesma placa: so atualiza');
  const nova = await h.call({ driverToken: 'chave', moto: { modelo: 'Factor 150', ano: '2022', placa: 'XYZ9K88' } });
  assert.equal(nova.data.conferencia, true);
  assert.equal(h.gravado.at(-1).motoAlteracaoPendente, true);
  assert.deepEqual({ ...h.gravado.at(-1).motoAnterior }, { modelo: 'CG', ano: '2019', placa: 'ABC1D23' });
  assert.equal((await h.call({ driverToken: 'chave', moto: { modelo: 'X', ano: '20', placa: 'AB' } })).status, 400);
  assert.equal((await h.call({ driverToken: 'chave' })).status, 400, 'nada para salvar');
});

test('extrato do motoboy: forma de pagamento (dinheiro, Pix, cartao, empresa) e taxa do app', () => {
  const ctx = vm.createContext({ onlyDigits, cleanText, Math, Number, String, money: (n) => Math.round(Number(n || 0) * 100) / 100 });
  vm.runInContext(slice('function earningPaymentForm(', 'function driverEarningEvent('), ctx);
  vm.runInContext(slice('function earningHistoryItem(', '\n}\n') + '\n}', ctx);
  const f = (job) => vm.runInContext(`earningPaymentFields('corrida', ${JSON.stringify(job)})`, ctx);
  assert.deepEqual({ ...f({ pagoEmDinheiro: true }) }, { forma: 'dinheiro', recebedor: '' });
  assert.deepEqual({ ...f({ pagamento: { status: 'approved', forma: 'pix', receiver: 'motoja_owner' } }) }, { forma: 'pix', recebedor: 'motoja' });
  assert.deepEqual({ ...f({ pagamento: { status: 'approved', forma: 'cartao_credito' } }) }, { forma: 'cartao', recebedor: 'mercadopago' });
  assert.deepEqual({ ...f({ pagamento: { status: 'pending', forma: 'pix' } }) }, { forma: '', recebedor: '' }, 'sem pagamento aprovado ainda');
  assert.equal(vm.runInContext(`earningPaymentFields('entrega', {}).forma`, ctx), 'empresa');
  const item = ctx.earningHistoryItem({ id: 'corrida_1', data: () => ({ tipo: 'corrida', ganhoCentavos: 500, valorCobradoCentavos: 650, forma: 'dinheiro', finalizadaEmMs: 1 }) });
  assert.equal(item.forma, 'dinheiro');
  assert.equal(item.taxaApp, 1.5);
  assert.equal(item.valorCobrado, 6.5);
  // Pagamento confirmado depois: update (nunca cria registro de ganho pela metade).
  assert.match(source, /driverEarningEventRef\(cpf, 'corrida', rideId\)\.update\(campos\)/);
  assert.match(source, /driverEarningEvent\('corrida', ref\.id, \{ \.\.\.ride, pagoEmDinheiro: true, ganhoMotoboy: split\.driverAmount \}, agora\)/);
});
