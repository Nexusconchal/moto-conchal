import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, companyId, driverCpf } from './financial-harness.js';

const planDelivery = (extra = {}) => ({
  tipo: 'entrega_empresarial', confirmacaoEmpresaVersao: 1, status: 'pendente', empresaId: companyId, telefoneEmpresa: companyId,
  empresa: 'Lachonete Stocco', retirada: 'Rua A, 10', entrega: 'Rua B, 20', paradas: 1, valor: 4, saldoReservado: 4,
  tipoEntrega: 'Plano Diario MotoJa Pro', motoboyExclusivoCpf: driverCpf, motoboyExclusivoNome: 'Joao', ...extra
});

function setup(delivery = planDelivery(), driver = { nome: 'Joao Pedro', telefone: '19988887777', status: 'ativo' }) {
  const h = harness({ [`empresas/${companyId}`]: { saldo: 100, reservado: 4 }, [`motoboys/${driverCpf}`]: driver, 'entregas/d': delivery });
  const timers = [];
  const sent = { telegram: [], whatsapp: [] };
  Object.assign(h.context, {
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; }, clearTimeout: () => {},
    escapeTelegram: (value) => String(value), AbortSignal: { timeout: () => undefined },
    process: { env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: 'group' } },
    fetch: async (_url, options) => { sent.telegram.push(JSON.parse(options.body).text); return { ok: true, json: async () => ({ result: { message_id: 1 } }) }; },
    sendEvolutionText: async (number, text) => { sent.whatsapp.push({ number, text }); return { sent: true }; }
  });
  const collection = h.context.db.collection;
  h.context.db.collection = (name) => ({
    ...collection(name),
    where: (field, _op, value) => ({ limit: () => ({ get: async () => ({
      docs: [...h.records.keys()]
        .filter((key) => key.startsWith(`${name}/`) && key.split('/').length === 2 && h.records.get(key)[field] != null && h.records.get(key)[field] <= value)
        .map((key) => ({ id: key.split('/')[1], ref: h.ref(key) }))
    }) }) })
  });
  h.fn('finishCompanyDelivery');
  h.run('const PLAN_AUTO_FINISH_MS', 'function clientWhatsappNumber(');
  h.fn('notifyTelegramAboutDelivery');
  return { ...h, timers, sent };
}

test('the fixed plan motoboy accepts on his own and only he is told (WhatsApp), nothing goes to the group', async () => {
  const h = setup();
  const before = Date.now();
  const auto = await h.context.autoAcceptPlanDelivery('d');
  assert.equal(auto.accepted, true);
  const delivery = h.records.get('entregas/d');
  assert.equal(delivery.status, 'aceita');
  assert.equal(delivery.motoboyCpf, driverCpf);
  assert.equal(delivery.motoboy, 'Joao Pedro');
  assert.equal(delivery.aceiteAutomaticoPlano, true);
  assert.ok(delivery.autoFinalizarEmMs >= before + 60000 && delivery.autoFinalizarEmMs <= Date.now() + 60000);
  assert.deepEqual(h.timers.map((timer) => timer.ms), [60000]);
  assert.equal(h.sent.telegram.length, 0);
  assert.equal(h.sent.whatsapp[0].number, '5519988887777');
  assert.match(h.sent.whatsapp[0].text, /Rua B, 20/);
  assert.match(h.sent.whatsapp[0].text, /Ver ganhos/);

  const again = await h.context.autoAcceptPlanDelivery('d');
  assert.deepEqual({ ...again }, { accepted: false, reason: 'entrega_nao_pendente' });
  assert.equal(h.sent.telegram.length, 0);
  assert.equal(h.sent.whatsapp.length, 1);
});

test('one minute later it finishes by itself: company is debited and the motoboy earning is recorded once', async () => {
  const h = setup();
  await h.context.autoAcceptPlanDelivery('d');
  await h.timers[0].fn();
  const delivery = h.records.get('entregas/d');
  assert.equal(delivery.status, 'finalizada');
  assert.equal(delivery.finalizadaAutomaticamentePlano, true);
  assert.equal(delivery.autoFinalizarEmMs, null);
  assert.equal(delivery.ganhoMotoboy, 3);
  assert.equal(h.records.get(`empresas/${companyId}`).saldo, 96);
  assert.equal(h.records.get(`empresas/${companyId}`).reservado, 0);
  assert.equal([...h.records.keys()].filter((key) => key.startsWith(`earnings/${driverCpf}/`)).length, 1);

  await h.context.autoFinishPlanDelivery('d');
  assert.equal(h.records.get(`empresas/${companyId}`).saldo, 96);
});

test('auto finish only works for deliveries the server accepted for the plan motoboy', async () => {
  const h = setup(planDelivery({ status: 'aceita', motoboyCpf: driverCpf }));
  await assert.rejects(h.context.finishCompanyDelivery(h.ref('entregas/d'), driverCpf, {}, '', { planAuto: true }), /automaticamente/);
  await h.context.autoAcceptPlanDelivery('d');
  assert.equal(h.records.get('entregas/d').aceiteAutomaticoPlano, undefined);
});

test('a blocked plan motoboy does not take the delivery', async () => {
  const h = setup(planDelivery(), { nome: 'Joao', status: 'bloqueado' });
  const auto = await h.context.autoAcceptPlanDelivery('d');
  assert.equal(auto.reason, 'motoboy_do_plano_indisponivel');
  assert.equal(h.records.get('entregas/d').status, 'pendente');
});

test('after a restart the sweep finishes overdue ones and drops cancelled ones from the queue', async () => {
  const h = setup(planDelivery({ status: 'aceita', motoboyCpf: driverCpf, aceiteAutomaticoPlano: true, autoFinalizarEmMs: Date.now() - 5000 }));
  h.records.set('entregas/c', planDelivery({ status: 'cancelada', aceiteAutomaticoPlano: true, autoFinalizarEmMs: Date.now() - 5000 }));
  h.records.set('entregas/later', planDelivery({ status: 'aceita', aceiteAutomaticoPlano: true, autoFinalizarEmMs: Date.now() + 30000 }));
  assert.equal(await h.context.runPlanAutoFinishTick(), 2);
  assert.equal(h.records.get('entregas/d').status, 'finalizada');
  assert.equal(h.records.get('entregas/c').autoFinalizarEmMs, null);
  assert.equal(h.records.get('entregas/later').status, 'aceita');
});

test('a failed auto finish leaves the queue instead of retrying forever', async () => {
  const h = setup(planDelivery({ status: 'aceita', motoboyCpf: driverCpf, aceiteAutomaticoPlano: true, autoFinalizarEmMs: Date.now() - 5000, saldoReservado: 50 }));
  assert.equal(await h.context.autoFinishPlanDelivery('d'), null);
  assert.equal(h.records.get('entregas/d').status, 'aceita');
  assert.equal(h.records.get('entregas/d').autoFinalizarEmMs, null);
  assert.match(h.records.get('entregas/d').autoFinalizarErro, /reserva/);
});

test('new plan delivery never goes to the Telegram group: it is accepted for the fixed motoboy and only he gets WhatsApp', async () => {
  const h = setup();
  const telegram = await h.context.notifyTelegramAboutDelivery('d', planDelivery());
  assert.equal(telegram.skipped, 'entrega_do_plano_so_para_o_motoboy_fixo');
  assert.equal(h.sent.telegram.length, 0);
  assert.equal(h.sent.whatsapp.length, 1);
  assert.equal(h.records.get('entregas/d').status, 'aceita');
  assert.equal((await h.context.notifyTelegramAboutDelivery('d', planDelivery())).skipped, 'entrega_nao_pendente');
  assert.equal(h.sent.telegram.length, 0);
  assert.equal(h.sent.whatsapp.length, 1);
});
