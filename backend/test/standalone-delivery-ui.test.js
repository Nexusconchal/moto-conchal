import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../../motoboy.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function section(start, end) {
  const a = html.indexOf(start), b = html.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start); return html.slice(a, b);
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness({ cached = true, cardPresent = true } = {}) {
  const job = { id: 'delivery-test', modalidade: 'entrega_avulsa', status: 'aceita', clienteAvisadoEm: 1, nomeRecebedor: 'Pessoa de teste' };
  const dialogs = [], requests = [], timers = [], alerts = [], nav = { config: null, closed: false };
  const button = { dataset: { finalizar: job.id }, disabled: false, textContent: 'Finalizar entrega com codigo', isConnected: true };
  class Element {
    constructor() { this.style = {}; this.fields = new Map(); this.listeners = {}; this.hidden = true; this.value = ''; this.focused = false; this.disabled = false; }
    querySelector(selector) { if (!this.fields.has(selector)) this.fields.set(selector, new Element()); return this.fields.get(selector); }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    focus() { this.focused = true; }
    remove() { const at = dialogs.indexOf(this); if (at >= 0) dialogs.splice(at, 1); }
    click() { if (!this.disabled) return this.onclick?.({ currentTarget: this }); }
  }
  const document = { createElement: () => new Element(), body: { appendChild: element => dialogs.push(element) },
    querySelector: () => cardPresent ? button : null };
  const jobsCache = new Map(cached ? [['rides:mine', { jobs: [job] }]] : []);
  let answer = () => new Promise(() => {}), active = { id: job.id, etapa: 'levar' };
  const context = vm.createContext({ document, console, Date, Map, Promise, String, Number, Math, Object, JSON,
    codigoEntregaDialogo: null, jobsCache, modo: 'minhas', navAbertaEm: 0, navRestaurada: false, ESPERA_CLIENTE_MS: 600000,
    lista: { querySelectorAll: () => [button] }, docs: [{ id: job.id, data: job }], servico: 'corrida',
    jobPorId: id => id === job.id ? { ...job, __kind: 'rides' } : null,
    setTimeout: fn => { timers.push(fn); return fn; }, clearTimeout() {},
    fetch: (...args) => { requests.push(args); return answer(...args); },
    CONFIG: { backend: 'https://fixture.invalid' }, driverProof: () => ({ driverCpf: 'test-only' }),
    entregaAvulsa: j => j?.modalidade === 'entrega_avulsa', servicoExclusivo: () => false, servicoEhEntrega: () => false,
    escSeguro: value => String(value || ''), etapaServico: () => 'levar', pontosServico: () => ({ coleta: {}, destino: {} }),
    recursoAtual: () => 'rides', nomeServico: () => 'corrida', atualizarAbas() {}, tempoAvisoRestante: () => '', chegadaLocal: () => 0,
    fotoClienteSegura: () => '', chatNaoLido: () => false, lerNavAtiva: () => active, salvarNavAtiva: value => active = value,
    limparCache: () => jobsCache.clear(), ouvir: async (silencioso = false) => { nav.forceRefresh = !silencioso; }, chaveLista: () => 'rides:mine', sincronizarTelaMapa() {},
    avisarPagamentoDinheiro: async () => ({ aguardandoDono: true }), alert: message => alerts.push(message), confirm: () => true,
    window: { MotoNav: { idAtual: () => nav.closed ? '' : job.id, fechar: () => nav.closed = true,
      abrirNavegacao: config => { nav.config = config; }, ocupado: () => false } }
  });
  vm.runInContext([
    section('function botaoDoCard(', '// Retirada pela tela do mapa'),
    section('function jobAtualizado(', '// Tela para digitar'),
    section('function pedirCodigoEntrega(', '// Cliente pagou em dinheiro (ou Pix direto):'),
    section('function acaoDoCard(', '// Mantem a tela de GPS/oferta'),
    section('lista.querySelectorAll("[data-finalizar]")', 'if (modoMinhas() && !modoEntrega()) avisarPagamentosAprovados')
  ].join('\n'), context);
  return { context, job, button, dialogs, requests, alerts, nav, jobsCache, timers, document,
    respond: handler => answer = handler };
}

test('delivery card opens the code immediately even while the list cache is being refreshed', () => {
  const h = harness({ cached: false }); h.button.onclick();
  assert.equal(h.dialogs.length, 1, 'O card conserva os dados da entrega exibida.');
  assert.equal(h.requests.length, 0, 'Nenhuma finalização é enviada antes de digitar o código.');
});

test('the code input receives focus during the original tap, without a delayed timer', () => {
  const h = harness(); h.button.onclick();
  assert.equal(h.dialogs[0].querySelector('[data-codigo]').focused, true);
});

test('GPS opens the code without waiting for a hidden card or any backend request', () => {
  const h = harness({ cached: false, cardPresent: false });
  h.context.abrirNavegacaoServico(h.job); h.nav.config.principal.acao();
  assert.equal(h.dialogs.length, 1, 'O GPS tem os dados e abre a confirmação no mesmo toque.');
  assert.equal(h.requests.length, 0);
});

test('wrong code stays editable, a verified success closes it, and a repeated tap reuses the same dialog', async () => {
  const h = harness(); const first = h.context.pedirCodigoEntrega(h.job, async code => {
    if (code !== '4821') throw Object.assign(new Error('Código incorreto'), { code: 'codigo_entrega_invalido' });
    return { ok: true };
  });
  const second = h.context.pedirCodigoEntrega(h.job, () => { throw Error('Não deve criar outro envio'); });
  assert.equal(h.dialogs.length, 1); assert.equal(first, second);
  const dialog = h.dialogs[0], field = dialog.querySelector('[data-codigo]');
  field.value = '1111'; await dialog.querySelector('[data-confirmar]').click();
  assert.equal(h.dialogs.length, 1); assert.equal(dialog.querySelector('[data-erro]').textContent, 'Código incorreto');
  field.value = '4821'; await dialog.querySelector('[data-confirmar]').click();
  assert.equal((await first).ok, true); assert.equal(h.dialogs.length, 0);
});

test('cancelling from the GPS restores the action and the next tap opens the code again', async () => {
  const h = harness({ cached: false, cardPresent: false });
  h.context.abrirNavegacaoServico(h.job);
  const waiting = h.nav.config.principal.acao();
  h.dialogs[0].querySelector('[data-voltar]').click(); await waiting;
  assert.equal(h.dialogs.length, 0); assert.equal(h.nav.closed, false);
  h.nav.config.principal.acao(); assert.equal(h.dialogs.length, 1); assert.equal(h.requests.length, 0);
});

test('GPS closes only after the entered code has been accepted by the server', async () => {
  const h = harness({ cached: false, cardPresent: false });
  h.respond(async () => ({ ok: true, json: async () => ({ ok: true }) }));
  h.context.abrirNavegacaoServico(h.job); const waiting = h.nav.config.principal.acao();
  assert.equal(h.nav.closed, false);
  const dialog = h.dialogs[0]; dialog.querySelector('[data-codigo]').value = '4821';
  await dialog.querySelector('[data-confirmar]').click(); await waiting;
  assert.equal(h.nav.closed, true); assert.equal(h.context.lerNavAtiva(), null);
  assert.equal(h.nav.forceRefresh, true, 'Uma atualização anterior não pode repor o card já finalizado.');
  assert.equal(h.requests[0][0], 'https://fixture.invalid/api/rides/delivery-test/finish');
  assert.equal(JSON.parse(h.requests[0][1].body).codigoEntrega, '4821');
});

test('pending payment stays in the code dialog and reporting cash still waits for the owner', async () => {
  const h = harness({ cached: false, cardPresent: false });
  h.respond(async () => ({ ok: false, json: async () => ({ error: 'pagamento_ainda_nao_aprovado', message: 'Código certo. Falta pagamento.' }) }));
  h.context.abrirNavegacaoServico(h.job); const waiting = h.nav.config.principal.acao();
  const dialog = h.dialogs[0]; dialog.querySelector('[data-codigo]').value = '4821';
  await dialog.querySelector('[data-confirmar]').click();
  assert.equal(h.dialogs.length, 1); assert.equal(h.nav.closed, false);
  assert.equal(dialog.querySelector('[data-dinheiro]').hidden, false);
  await dialog.querySelector('[data-dinheiro]').click(); await waiting;
  assert.equal(h.nav.closed, false); assert.notEqual(h.context.lerNavAtiva(), null);
});

test('a short code never sends a request and another delivery cannot reuse the open confirmation', async () => {
  const h = harness();
  h.context.pedirCodigoEntrega(h.job, () => { throw Error('Não deveria enviar'); });
  const dialog = h.dialogs[0]; dialog.querySelector('[data-codigo]').value = '12';
  await dialog.querySelector('[data-confirmar]').click();
  assert.equal(dialog.querySelector('[data-erro]').textContent, 'O código tem 4 números.');
  assert.equal(h.requests.length, 0);
  await assert.rejects(h.context.pedirCodigoEntrega({ id: 'another-delivery' }, () => {}), /outra entrega/);
  assert.equal(h.dialogs.length, 1);
});

test('a normal taxi ride keeps its finish flow without requesting a delivery code', async () => {
  const h = harness({ cached: false }); h.job.modalidade = 'corrida';
  h.respond(async () => ({ ok: true, json: async () => ({ ok: true }) }));
  await h.button.onclick(); await settle();
  assert.equal(h.dialogs.length, 0); assert.equal(h.requests.length, 1);
  assert.equal(JSON.parse(h.requests[0][1].body).codigoEntrega, undefined);
});
