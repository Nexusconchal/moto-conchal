import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  DRIVER_TERMS_VERSION, DRIVER_TERMS_REQUIRED_FROM, driverTermsError, driverTermsMissing, driverTermsRecord, driverTermsStatus
} from '../src/driver-terms.js';

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const page = fs.readFileSync(new URL('../../motoboy-termo.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../../motoboy.html', import.meta.url), 'utf8');
const sw = fs.readFileSync(new URL('../../sw.js', import.meta.url), 'utf8');
const CPF = '11122233344';

function block(start) {
  const i = source.indexOf(start);
  assert.ok(i >= 0, `nao achei: ${start}`);
  return source.slice(i, source.indexOf('\n}\n', i) + 3);
}
function route(path) {
  const i = source.indexOf(`app.post('${path}'`);
  assert.ok(i >= 0, `rota nao encontrada: ${path}`);
  return source.slice(i, source.indexOf('\n});\n', i) + 5);
}

function harness({ driver = null, records = new Map() } = {}) {
  if (driver) records.set(`motoboys/${CPF}`, driver);
  const writes = [];
  const refetch = [];
  const routes = new Map();
  const db = {
    collection: (name) => ({
      doc: (id) => ({
        get: async () => ({ exists: records.has(`${name}/${id}`), data: () => records.get(`${name}/${id}`) }),
        set: async (data, opts) => {
          writes.push(`${name}/${id}`);
          records.set(`${name}/${id}`, opts?.merge ? { ...(records.get(`${name}/${id}`) || {}), ...data } : { ...data });
        },
      }),
    }),
  };
  const ctx = vm.createContext({
    db, String, Object, JSON, Date,
    app: { post: (p, ...h) => routes.set(p, h.at(-1)) },
    admin: { firestore: { FieldValue: { serverTimestamp: () => 'AGORA' } } },
    onlyDigits: (v) => String(v || '').replace(/\D/g, ''),
    authLimiter: (_q, _r, n) => n(),
    clearDriverProofCache: () => {},
    getDriverWithProof: async (cpf, body) => {
      if (body.driverToken !== 'chave') { const e = new Error('sessao'); e.status = 401; e.code = 'sessao_motoboy_invalida'; throw e; }
      return records.get(`motoboys/${cpf}`);
    },
    DRIVER_TERMS_VERSION, driverTermsRecord, driverTermsStatus,
    adminStateCache: { payload: 'velho' },
    markAdminRefetch: (name, id) => refetch.push(`${name}/${id}`),
  });
  vm.runInContext(block('async function saveDriverTermsAcceptance('), ctx);
  vm.runInContext(route('/api/drivers/:cpf/termo'), ctx);
  const call = async (body, headers = {}) => {
    const out = { status: 200 }; let failure;
    const res = { status: (c) => { out.status = c; return res; }, json: (d) => { out.data = d; return res; } };
    const req = { params: { cpf: CPF }, body, ip: '200.1.2.3', get: (h) => headers[h.toLowerCase()] || '' };
    await routes.get('/api/drivers/:cpf/termo')(req, res, (e) => { failure = e; });
    if (failure) { out.status = failure.status || 500; out.data = { error: failure.code }; }
    return out;
  };
  return { call, records, writes, refetch, ctx };
}

test('o termo diz o que o dono pediu: autonomo, sem horario, proibido por fora e contato pessoal, sem multa', () => {
  assert.match(page, /<article id="termo" data-versao="2026-11-25-v2">/);
  assert.equal(page.match(/data-versao="([^"]+)"/)[1], DRIVER_TERMS_VERSION, 'versao da pagina = versao do servidor');
  for (const trecho of [
    /autônomo/, /sem vínculo de emprego/, /Não existe horário obrigatório/, /Recusar uma chamada[^.]*não gera punição/,
    /outros apps/, /proibido aceitar corrida ou entrega por fora/, /proibido oferecer o seu contato pessoal/,
    /Disponível[^.]*guardamos só a cidade/, /Conchal \(SP\)/, /MP|Medida Provisória 2\.200-2/,
  ]) assert.match(page, trecho);
  // Versão 2: sem multa, banimento ou prazo de 6 meses; seções 6 e 7 antigas saíram.
  for (const fora of [/multa de R\$/i, /banimento/i, /6 meses/, /<h2>9\./, /<h2>10\./]) assert.doesNotMatch(page, fora);
});

test('prazo: ate domingo 29/11 quem ja e cadastrado trabalha sem o termo; a partir de segunda, nao', () => {
  const antes = DRIVER_TERMS_REQUIRED_FROM - 1;
  assert.deepEqual(driverTermsStatus({}, antes), { versao: DRIVER_TERMS_VERSION, aceito: false, url: 'motoboy-termo.html', prazoMs: DRIVER_TERMS_REQUIRED_FROM, obrigatorio: false });
  assert.equal(driverTermsStatus({}, DRIVER_TERMS_REQUIRED_FROM).obrigatorio, true);
  assert.equal(driverTermsStatus({ termoVersao: DRIVER_TERMS_VERSION }).aceito, true);
  assert.equal(driverTermsStatus({ termoVersao: '2020-01-01' }).aceito, false, 'versao antiga pede de novo');
  assert.equal(driverTermsStatus({ termoVersao: '2026-11-25' }).aceitouAntigo, true, 'quem aceitou a versao 1 ve o que mudou');
  assert.equal(driverTermsStatus({ termoVersao: DRIVER_TERMS_VERSION }).aceitouAntigo, undefined);
  assert.equal(driverTermsMissing({}, DRIVER_TERMS_REQUIRED_FROM - 1), false);
  assert.equal(driverTermsMissing({}, DRIVER_TERMS_REQUIRED_FROM), true);
  assert.equal(driverTermsMissing({ termoVersao: DRIVER_TERMS_VERSION }, DRIVER_TERMS_REQUIRED_FROM + 1), false);
  const e = driverTermsError();
  assert.equal(e.status, 428);
  assert.equal(e.code, 'termo_motoboy_pendente');
  assert.equal(new Date(DRIVER_TERMS_REQUIRED_FROM).toISOString(), '2026-11-30T03:00:00.000Z', 'segunda 30/11 00:00 em Brasilia');
  const ultimoDia = new Date(DRIVER_TERMS_REQUIRED_FROM - 1).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
  assert.equal(ultimoDia, 'domingo, 29/11', 'o aviso do app mostra este dia');
});

test('aceite pelo app: guarda a prova (versao, IP, aparelho) e marca o cadastro', async () => {
  const h = harness({ driver: { nome: 'Ze', status: 'ativo' } });
  const r = await h.call({ driverToken: 'chave', versao: DRIVER_TERMS_VERSION }, { 'user-agent': 'MotoJaMotorista Android' });
  assert.equal(r.status, 200);
  assert.equal(r.data.termo.aceito, true);
  assert.deepEqual(h.records.get(`termosMotoboy/${CPF}_${DRIVER_TERMS_VERSION}`), {
    cpf: CPF, versao: DRIVER_TERMS_VERSION, ip: '200.1.2.3', aparelho: 'MotoJaMotorista Android', origem: 'app', aceitoEm: 'AGORA',
  });
  assert.equal(h.records.get(`motoboys/${CPF}`).termoVersao, DRIVER_TERMS_VERSION);
  assert.equal(h.records.get(`motoboys/${CPF}`).nome, 'Ze', 'nao apaga o resto do cadastro');
  assert.equal(h.writes.length, 2, 'so duas gravacoes no banco');
  assert.equal(h.ctx.adminStateCache, null, 'o painel do dono nao fica com o guardado velho');
  assert.deepEqual(h.refetch, [`motoboys/${CPF}`], 'o painel rele so este motoboy');
  const de_novo = await h.call({ driverToken: 'chave', versao: DRIVER_TERMS_VERSION });
  assert.equal(de_novo.status, 200);
  assert.equal(h.writes.length, 2, 'aceitar de novo nao grava nada');
});

test('aceite com versao velha ou sem a chave do celular nao grava nada', async () => {
  const h = harness({ driver: { nome: 'Ze', status: 'ativo' } });
  const velha = await h.call({ driverToken: 'chave', versao: '2020-01-01' });
  assert.equal(velha.status, 409);
  assert.equal(velha.data.error, 'termo_desatualizado');
  const semChave = await h.call({ versao: DRIVER_TERMS_VERSION });
  assert.equal(semChave.status, 401);
  assert.equal(h.writes.length, 0);
});

test('servidor: cadastro novo exige o aceite antes de gastar o codigo, /me devolve o termo e aceitar chamada confere', () => {
  const cadastro = route('/api/drivers/register');
  const exige = cadastro.indexOf("String(req.body.aceiteTermo || '') !== DRIVER_TERMS_VERSION");
  assert.ok(exige > 0);
  assert.ok(exige < cadastro.indexOf('consumeVerification'), 'confere o termo antes de usar o codigo do WhatsApp');
  assert.match(cadastro, /saveDriverTermsAcceptance\(cpf, req, 'cadastro'\)/);
  assert.match(block('function driverAppProfile('), /termo: driverTermsStatus\(driver\)/);
  for (const r of ['/api/rides/:rideId/accept', '/api/deliveries/:deliveryId/accept']) {
    assert.match(route(r), /const driver = await getDriverWithProof\(driverCpf, req\.body\);\n    if \(driverTermsMissing\(driver\)\) throw driverTermsError\(\);/, r);
  }
});

test('app do motoboy: pede o termo no cadastro, ao entrar e antes de ficar Disponivel', () => {
  assert.equal(app.match(/const TERMO_VERSAO = "([^"]+)"/)[1], DRIVER_TERMS_VERSION, 'versao do app = versao do servidor');
  assert.match(app, /id="aceiteTermo"/);
  assert.match(app, /aceiteTermo: termoAceitoNoCadastro/);
  assert.match(app, /async function garantirTermo\(/);
  assert.match(app, /\/api\/drivers\/\$\{motoboyCpf\}\/termo/);
  assert.match(app, /beforeAvailable: async \(\) => \(await garantirTermo\(\)\) && confirmarCidadePeloGps\(\)/);
  assert.match(app, /termo_motoboy_pendente/);
  // Aviso fixo com o prazo; antes do prazo so pergunta (Agora nao deixa trabalhar), depois bloqueia.
  for (const trecho of [
    'function mostrarAvisoTermo()',
    'Aceite até <strong>${diaLimiteTermo()}</strong>. Depois disso, só recebe corridas e entregas quem aceitou o termo.',
    'if (!obrigatorio && !perguntar) return true;',
    'return !obrigatorio;',
    'Date.now() >= prazo',
    'mostrarAvisoTermo();\n        if (termoMotoboy && !termoMotoboy.aceito)',
  ]) assert.ok(app.replace(/\r\n/g, '\n').includes(trecho), trecho);
  assert.match(sw, /'\.\/motoboy-termo\.html'/);
});

const dono = fs.readFileSync(new URL('../../dono.html', import.meta.url), 'utf8');
function painelTermo({ agora, motoboys = [] }) {
  const i = dono.indexOf('function termoAceito(');
  assert.ok(i >= 0, 'painel do dono sem as funcoes do termo');
  const Relogio = class extends Date { static now() { return agora; } };
  const ctx = vm.createContext({
    Date: Relogio, Number, String, encodeURIComponent, motoboys, filtroTermo: 'todos',
    termoMotoboyAtual: driverTermsStatus({}), dataTxt: () => '25/11/2026, 20:00:00',
  });
  vm.runInContext(dono.slice(i, dono.indexOf('function renderMotoboys(', i)), ctx);
  return ctx;
}

test('painel do dono: coluna Termo mostra quem aceitou, quem aceitou o antigo e quem falta, com aviso no WhatsApp', () => {
  const antes = DRIVER_TERMS_REQUIRED_FROM - 60000;
  const p = painelTermo({ agora: antes, motoboys: [{ termoVersao: DRIVER_TERMS_VERSION }, { termoVersao: '2026-11-25' }, {}] });
  const aceitou = p.termoCelula({ termoVersao: DRIVER_TERMS_VERSION, termoAceitoEm: { _seconds: 1 } });
  assert.match(aceitou, /✅ Aceitou/);
  assert.match(aceitou, /em 25\/11\/2026, 20:00:00/);
  const antigo = p.termoCelula({ termoVersao: '2026-11-25', nome: 'Zé Silva', telefone: '(19) 99999-0000' });
  assert.match(antigo, /⚠️ Aceitou o antigo, falta o novo/);
  const msg = decodeURIComponent(antigo.match(/wa\.me\/5519999990000\?text=([^"]+)"/)[1]);
  assert.match(msg, /^Oi Zé! Aqui é da MotoJá\. Mudamos o termo do motoboy: tiramos a multa e o banimento\./);
  assert.match(msg, /Ler e aceitar o termo" até domingo, 29\/11\. Depois disso, só recebe chamadas quem aceitou\.$/);
  const nunca = p.termoCelula({ nome: 'Ana', telefone: '19988887777' });
  assert.match(nunca, /❌ Não aceitou/);
  assert.match(decodeURIComponent(nunca.match(/text=([^"]+)"/)[1]), /autônomo, faz seu horário e pode recusar chamadas/);
  assert.doesNotMatch(p.termoCelula({ nome: 'Sem fone' }), /wa\.me/);
  const filtro = p.filtroTermoHtml();
  for (const t of ['Termo novo (aceitar até domingo, 29/11):', 'Todos (3)', '✅ Aceitaram (1)', '❌ Faltam aceitar (2)', 'data-filtro-termo="falta"']) assert.ok(filtro.includes(t), t);
  // Depois do prazo o aviso pede o aceite para voltar a receber chamadas.
  const depois = painelTermo({ agora: DRIVER_TERMS_REQUIRED_FROM + 1 }).termoCelula({ termoVersao: '2026-11-25', telefone: '19999990000' });
  assert.match(decodeURIComponent(depois.match(/text=([^"]+)"/)[1]), /Ler e aceitar o termo" para voltar a receber chamadas\.$/);
});

test('painel do dono: servidor manda a versao do termo e a tabela tem a coluna e o filtro', () => {
  assert.match(source, /const termoMotoboy = driverTermsStatus\(\{\}\);\n    const payload = withoutSecrets\(\{[^}]*, termoMotoboy \}\);/);
  for (const t of [
    "termoMotoboyAtual=d.termoMotoboy&&typeof d.termoMotoboy==='object'?d.termoMotoboy:{};",
    '<th>Mercado Pago</th><th>Termo</th>', '<td>${mpCelula(m)}</td><td>${termoCelula(m)}</td>',
    "filter(m=>filtroTermo==='todos'||(filtroTermo==='aceitou')===termoAceito(m))", '${filtroTermoHtml()}',
    "if(ft){filtroTermo=ft.dataset.filtroTermo;renderMotoboys()}",
  ]) assert.ok(dono.includes(t), t);
});

test('app do motoboy: quem aceitou a versao antiga ve que sairam a multa e o banimento', () => {
  assert.match(app, /termoMotoboy\.aceitouAntigo \? "O termo mudou: saíram a multa e o banimento\. " : ""\}Aceite até <strong>/);
  assert.match(app, /termoMotoboy\.aceitouAntigo\n\s+\? `O termo mudou: saíram a multa e o banimento\. Agora só é proibido pegar corrida ou entrega por fora e passar seu contato pessoal/);
});
