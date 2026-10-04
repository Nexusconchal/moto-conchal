import test from 'node:test';
import assert from 'node:assert/strict';
import { brazilPhone, parseSupportMessage, enrichSupportMessage, requestedRideId, supportAnswer, supportIntent, chooseDriverGroup, pendingNotice, createSupportAutomation } from '../src/support-automation.js';

const NOW = 1800000000000;
function message(overrides = {}, id = 'message1') {
  return { instance: 'support', event: 'messages.upsert', data: { key: { id, remoteJid: '5519999990000@s.whatsapp.net', fromMe: false, ...overrides }, messageTimestamp: NOW / 1000, message: { conversation: 'Minha corrida está aguardando' } } };
}
function harness(isSystemOutgoing = () => false, generateReply = async () => null, failures = {}) {
  const records = new Map([['configuracoes/atendimentoAutomatico', { enabled: true, groupAlerts: true, driverGroupJid: '123@g.us' }]]);
  const sent = [], telegram = [];
  let time = NOW, lock = Promise.resolve(), beforeRead;
  const usage = { reads: 0, writes: 0 };
  const snapshot = ref => ({ id: ref.id, ref, exists: records.has(ref.path), data: () => records.get(ref.path) });
  const ref = path => ({ path, id: path.split('/').at(-1), async get() { usage.reads++; if (beforeRead) beforeRead(path); return snapshot(this); }, async set(data, options) { usage.writes++; records.set(path, options?.merge ? { ...records.get(path), ...data } : data); } });
  const collection = name => ({ doc: id => ref(`${name}/${id}`), where: (key, op, value) => {
    let max = Infinity;
    const query = { limit(count) { max = count; return query; }, async get() {
      const docs = [...records.keys()].filter(path => path.startsWith(`${name}/`) && (op === '<' ? records.get(path)[key] < value : records.get(path)[key] === value)).slice(0, max).map(path => snapshot(ref(path)));
      usage.reads += Math.max(1, docs.length);
      return { docs, empty: !docs.length };
    } }; return query;
  } });
  const db = { collection, batch() { const deletions = []; return { delete: ref => deletions.push(ref.path), commit: async () => { deletions.forEach(path => records.delete(path)); } }; }, runTransaction(callback) { const work = lock.then(() => callback({ get: ref => ref.get(), set: (ref, value, options) => ref.set(value, options) })); lock = work.catch(() => {}); return work; } };
  const service = createSupportAutomation({ db, instance: 'support', isSystemOutgoing, generateReply, encrypt: value => `encrypted:${value}`, decrypt: value => value.slice('encrypted:'.length), now: () => time, rideExpireMs: 300000, deliveryExpireMs: 900000, sendText: async (phone, text) => { sent.push({ phone, text }); return { sent: !(failures.whatsapp && phone.endsWith('@g.us')), id: `reply${sent.length}` }; }, sendTelegram: async (job, text) => { telegram.push({ job, text }); return { sent: !failures.telegram }; } });
  return { service, records, sent, telegram, usage, advance: delta => { time += delta; }, beforeRead: callback => { beforeRead = callback; } };
}

test('Brazil numbers preserve national digits and reject a LID without phone mapping', () => {
  assert.equal(brazilPhone('(19) 99999-0000'), '5519999990000');
  assert.equal(brazilPhone('5519999990000'), '5519999990000');
  assert.equal(parseSupportMessage(message({ remoteJid: '123456789123456@lid' }), 'support', NOW), null);
  assert.equal(parseSupportMessage(message({ remoteJid: '123456789123456@lid', remoteJidAlt: '5519999990000@s.whatsapp.net' }), 'support', NOW).phone, '5519999990000');
});

test('ignore groups, broadcasts, unrelated instances and old message backlog', () => {
  for (const jid of ['123@g.us', 'status@broadcast', '123@newsletter']) assert.equal(parseSupportMessage(message({ remoteJid: jid }), 'support', NOW), null);
  assert.equal(parseSupportMessage(message(), 'other', NOW), null);
  assert.equal(parseSupportMessage(message(), 'support', NOW + 300001), null);
  const event = message(); event.event = 'messages.update'; assert.equal(parseSupportMessage(event, 'support', NOW), null);
});

test('recognizes codes from customer screenshots', () => {
  assert.equal(requestedRideId('Código da corrida: c59de63b4-39799232'), 'c59de63b4-39799232');
});

test('reports expiry even before cleanup and never promises a driver or creates a booking', () => {
  const result = supportAnswer('esperando', { status: 'pendente', criadaEm: NOW - 300001 }, 300000, NOW);
  assert.match(result.text, /expirou sem aceite/);
  assert.match(result.text, /Não renovei nem criei/);
  assert.match(supportAnswer('esperando', { status: 'pendente', criadaEm: NOW - 1000 }, 300000, NOW).text, /Ainda não há motorista confirmado/);
  assert.match(supportAnswer('esperando', { status: 'aceita' }, 300000, NOW).text, /já foi aceita/);
});

test('auto group selection requires one exact name and valid group JID', () => {
  const correct = { subject: 'Nexus MotoJá - MOTORISTA', id: '123@g.us' };
  assert.deepEqual(chooseDriverGroup([correct, { subject: 'Clientes', id: '456@g.us' }]), correct);
  assert.equal(chooseDriverGroup([correct, { ...correct, id: '456@g.us' }]), null);
  assert.equal(chooseDriverGroup([{ ...correct, id: '5519@s.whatsapp.net' }]), null);
});

test('notices exclude accepted, expired and future jobs, and personal addresses', () => {
  const job = { id: 'ride', status: 'pendente', criadaEm: NOW - 1000, valor: 12, origem: 'private street', telefoneCliente: '19999990000' };
  const text = pendingNotice(job, 'corridas', 'initial', 300000, NOW);
  assert.ok(text); assert.ok(!text.includes(job.origem)); assert.ok(!text.includes(job.telefoneCliente));
  assert.equal(pendingNotice({ ...job, status: 'aceita' }, 'corridas', 'initial', 300000, NOW), '');
  assert.equal(pendingNotice({ ...job, criadaEm: NOW - 300001 }, 'corridas', 'reminder', 300000, NOW), '');
  assert.equal(pendingNotice({ ...job, criadaEm: NOW + 1 }, 'corridas', 'initial', 300000, NOW), '');
});

test('duplicate and concurrent webhook deliveries generate one reply', async () => {
  const h = harness(); await Promise.all([h.service.handle(message()), h.service.handle(message())]);
  assert.equal(h.sent.length, 1);
  await h.service.handle(message({}, 'another')); assert.equal(h.sent.length, 1);
});

test('explicit code never reveals another customer ride', async () => {
  const h = harness(); h.records.set('corridas/c59de63b4-39799232', { status: 'aceita', telefoneCliente: '19888880000', criadaEm: NOW });
  const event = message(); event.data.message.conversation = 'Código da corrida: c59de63b4-39799232';
  await h.service.handle(event); assert.match(h.sent[0].text, /Não encontrei/); assert.doesNotMatch(h.sent[0].text, /já foi aceita/);
});

test('looks up current ride by authenticated sender phone', async () => {
  const h = harness(); h.records.set('corridas/current', { status: 'aceita', telefoneCliente: '19999990000', criadaEm: NOW });
  await h.service.handle(message()); assert.match(h.sent[0].text, /já foi aceita/);
});

test('manual outgoing message pauses bot without sending a response', async () => {
  const h = harness(); await h.service.handle(message({ fromMe: true }));
  await h.service.handle(message({}, 'customerNext')); assert.equal(h.sent.length, 0);
  h.advance(31 * 60000); const event = message({}, 'customerLater'); event.data.messageTimestamp += 31 * 60;
  await h.service.handle(event); assert.equal(h.sent.length, 1);
});

test('outgoing bot echo does not pause next conversation', async () => {
  const h = harness(); await h.service.handle(message());
  const echo = message({ fromMe: true }, 'reply1'); echo.data.message.conversation = h.sent[0].text;
  await h.service.handle(echo); h.advance(16000);
  const next = message({}, 'next'); next.data.messageTimestamp += 16;
  await h.service.handle(next); assert.equal(h.sent.length, 2);
});

test('existing automatic OTP sender does not pause customer support', async () => {
  const h = harness(event => event.id === 'otp-system-message');
  await h.service.handle(message({ fromMe: true }, 'otp-system-message'));
  await h.service.handle(message({}, 'customer-followup')); assert.equal(h.sent.length, 1);
});

test('ATENDENTE writes encrypted callback phone and keeps helping while a human is unavailable', async () => {
  const h = harness(); const event = message(); event.data.message.conversation = 'quero atendente';
  await h.service.handle(event);
  assert.match(h.sent[0].text, /Qual é o problema/);
  const ticket = [...h.records.entries()].find(([path]) => path.startsWith('supportAutomationTickets/'))[1];
  assert.equal(ticket.telefoneCriptografado, 'encrypted:5519999990000');
  assert.equal(ticket.telefone, undefined);
  await h.service.handle(message({}, 'again')); assert.equal(h.sent.length, 2);
  assert.match(h.sent[0].text, /continuar ajudando/);
});

test('human handoff is accepted immediately after an automatic answer', async () => {
  const h = harness(); await h.service.handle(message());
  const event = message({}, 'human-immediate'); event.data.message.conversation = 'ATENDENTE';
  await h.service.handle(event); assert.equal(h.sent.length, 2); assert.match(h.sent[1].text, /pessoa do suporte/);
  assert.ok([...h.records.keys()].some(path => path.startsWith('supportAutomationTickets/')));
});

test('new customers get a useful greeting and immediate menu choice', async () => {
  const h = harness(); const greeting = message(); greeting.data.message.conversation = 'Boa noite';
  await h.service.handle(greeting); assert.match(h.sent[0].text, /1 • Pedir corrida/);
  const choice = message({}, 'choice'); choice.data.message.conversation = '1';
  await h.service.handle(choice); assert.equal(h.sent.length, 2); assert.match(h.sent[1].text, /Chamar motoboy/);
  const customer = message({ remoteJid: '5519888887777@s.whatsapp.net' }, 'other-customer'); customer.data.message.conversation = 'Olá';
  await h.service.handle(customer); assert.match(h.sent[2].text, /5 • Falar com uma pessoa/);
});

test('human queue stores the problem encrypted; MENU resumes without removing ticket', async () => {
  const h = harness(); const event = message(); event.data.message.conversation = 'atendente';
  await h.service.handle(event);
  const detail = message({}, 'detail'); detail.data.message.conversation = 'Motorista não apareceu';
  await h.service.handle(detail); assert.equal(h.sent.length, 2);
  const ticket = [...h.records.values()].find(item => item.status === 'aguardando');
  assert.equal(ticket.ultimaMensagemCriptografada, 'encrypted:Motorista não apareceu');
  const menu = message({}, 'resume'); menu.data.message.conversation = 'MENU';
  await h.service.handle(menu); assert.equal(h.sent.length, 3); assert.match(h.sent[2].text, /1 • Pedir corrida/);
  assert.equal([...h.records.values()].find(item => item.status === 'aguardando').ultimaMensagemCriptografada, 'encrypted:Motorista não apareceu');
  assert.equal(ticket.status, 'aguardando');
});

test('recognizes payment, address, thanks and preserves address topic for follow-up', () => {
  assert.equal(supportIntent('quanto custa?'), 'payment');
  assert.match(supportAnswer('preciso de troco', null, 300000, NOW).text, /confirme com o motorista/);
  assert.match(supportAnswer('GPS errado', null, 300000, NOW).text, /saída, no destino/);
  assert.equal(supportAnswer('Rua das Flores 22', null, 300000, NOW, { topic: 'address' }).topic, 'address');
  assert.match(supportAnswer('valeu', null, 300000, NOW).text, /Por nada/);
});

test('greetings with emoji always show the menu without AI or booking reads', async () => {
  const h = harness(() => false, async () => { throw Error('Greeting must not use AI'); });
  const greeting = message(); greeting.data.message.conversation = 'Bom dia, tudo bem? 😊';
  await h.service.handle(greeting);
  assert.match(h.sent[0].text, /ATENDENTE/);
  assert.match(h.sent[0].text, /6 • Empresas/);
  assert.match(h.sent[0].text, /\?origem=suporte&v=202/);
  assert.doesNotMatch(h.sent[0].text, /v=202\?/);
  assert.equal(h.usage.reads, 3); // Config plus two deduplication reads; no ride lookup.
});

test('payment text with a ride code returns owned status instead of asking to book again', async () => {
  const h = harness(() => false, async () => { throw Error('Status must not use AI'); });
  h.records.set('corridas/c41053bd0-39800856', { status: 'aceita', telefoneCliente: '19999990000', criadaEm: NOW });
  const event = message(); event.data.message.conversation = 'pagamento efetuado antes de iniciar a corrida. Pode confirmar? Código da corrida: c41053bd0-39800856';
  await h.service.handle(event);
  assert.match(h.sent[0].text, /já foi aceita/);
  assert.doesNotMatch(h.sent[0].text, /Informe o endereço/);
});

test('human queue continues AI until actual manual reply takes over', async () => {
  let calls = 0;
  const h = harness(() => false, async () => { calls++; return { answer: { text: 'O erro aparece ao entrar na conta ou ao calcular o pedido?', topic: 'address' } }; });
  const human = message(); human.data.message.conversation = 'ATENDENTE'; await h.service.handle(human);
  const detail = message({}, 'waiting-detail'); detail.data.message.conversation = 'Sou empresa e dá erro no aplicativo'; await h.service.handle(detail);
  assert.equal(calls, 1); assert.match(h.sent[1].text, /entrar na conta/);
  const manual = message({ fromMe: true }, 'real-person'); manual.data.message.conversation = 'Olá, sou do suporte e estou verificando'; await h.service.handle(manual);
  const next = message({}, 'after-human'); next.data.message.conversation = 'Ainda aparece erro'; await h.service.handle(next);
  assert.equal(calls, 1); assert.equal(h.sent.length, 2);
});

test('known outgoing echoes incur no extra Firestore reads or writes', async () => {
  const h = harness(); const event = message(); event.data.message.conversation = 'Bom dia'; await h.service.handle(event);
  const baseline = { ...h.usage };
  const echo = message({ fromMe: true }, 'echo'); echo.data.message.conversation = h.sent[0].text;
  await h.service.handle(echo); assert.deepEqual(h.usage, baseline);
});

test('completed reminders reuse memory and only reread the two live queues', async () => {
  const h = harness(); h.records.set('corridas/cache', { status: 'pendente', criadaEm: NOW - 130000, valor: 12 });
  await h.service.tick(); const baseline = { ...h.usage };
  await h.service.tick(); assert.equal(h.usage.reads - baseline.reads, 2); assert.equal(h.usage.writes, baseline.writes);
  assert.equal(h.sent.length, 1); assert.equal(h.telegram.length, 1);
});

test('business menu has a valid URL and delivery lookup enforces company phone ownership', async () => {
  const h = harness(); const event = message(); event.data.message.conversation = '6'; await h.service.handle(event);
  assert.match(h.sent[0].text, /https:\/\/nexusmotoja.com.br\/empresa.html\?origem=suporte&v=202/);
  assert.doesNotMatch(h.sent[0].text, /v=202empresa/);
  h.records.set('entregas/c41053bd0-39800856', { status: 'aceita', telefoneEmpresa: '19999990000', criadaEm: NOW });
  const status = message({}, 'delivery-code'); status.data.message.conversation = 'Código do pedido: c41053bd0-39800856'; await h.service.handle(status);
  assert.match(h.sent[1].text, /Sua entrega já foi aceita/);
  const stranger = message({ remoteJid: '5519888887777@s.whatsapp.net' }, 'stranger-delivery'); stranger.data.message.conversation = status.data.message.conversation; await h.service.handle(stranger);
  assert.doesNotMatch(h.sent[2].text, /já foi aceita/);
});

test('business waiting complaint uses delivery expiry and notifies both driver channels', async () => {
  const h = harness(); h.records.set('entregas/c41053bd0-39800856', { status: 'pendente', telefoneEmpresa: '19999990000', criadaEm: NOW - 350000, valor: 12 });
  const event = message(); event.data.message.conversation = 'Minha entrega está demorando, pedido: c41053bd0-39800856'; await h.service.handle(event);
  assert.match(h.sent[0].text, /Entrega disponível/); assert.equal(h.telegram.length, 1);
  assert.match(h.sent[1].text, /Sua entrega ainda está aguardando/);
  h.records.set('entregas/c41053bd0-39800856', { status: 'aceita', telefoneEmpresa: '19999990000', criadaEm: NOW - 350000 });
  const next = message({}, 'delivery-followup'); next.data.message.conversation = 'E a entrega, já foi aceita?'; await h.service.handle(next);
  assert.match(h.sent.at(-1).text, /Sua entrega já foi aceita/);
});

test('batch webhook deliveries and ephemeral text are processed, not discarded', async () => {
  const h = harness(); const event = message(); event.data.message = { ephemeralMessage: { message: { conversation: 'Olá' } } };
  await h.service.handle({ ...event, data: [event.data] }); assert.match(h.sent[0].text, /Pedir corrida/);
  const mapped = message({ remoteJid: '123456789123456@lid', senderPn: '5519999990000@s.whatsapp.net' });
  assert.equal(parseSupportMessage(mapped, 'support', NOW).phone, '5519999990000');
});

test('missing LID mapping is resolved only from the same provider message and JID', async () => {
  const event = message({ remoteJid: '123456789123456@lid' });
  const source = { messages: { records: [{ key: { id: 'message1', remoteJid: '123456789123456@lid', remoteJidAlt: '5519999990000@s.whatsapp.net' } }] } };
  const enriched = await enrichSupportMessage(event, 'support', async id => { assert.equal(id, 'message1'); return source; });
  assert.equal(parseSupportMessage(enriched, 'support', NOW).phone, '5519999990000');
  for (const key of [{ ...source.messages.records[0].key, id: 'other' }, { ...source.messages.records[0].key, remoteJid: '999@lid' }]) {
    const unsafe = await enrichSupportMessage(event, 'support', async () => ({ records: [{ key }] }));
    assert.equal(parseSupportMessage(unsafe, 'support', NOW), null);
  }
  const failed = await enrichSupportMessage(event, 'support', async () => { throw Error('offline'); });
  assert.equal(parseSupportMessage(failed, 'support', NOW), null);
});

test('reopening a resolved ticket clears its previous expiration', async () => {
  const h = harness(); const event = message(); event.data.message.conversation = 'ATENDENTE'; await h.service.handle(event);
  const ticketPath = [...h.records.keys()].find(path => path.startsWith('supportAutomationTickets/'));
  h.records.set(ticketPath, { ...h.records.get(ticketPath), status: 'resolvido', expiresAt: new Date(NOW - 1) });
  const menu = message({}, 'menu'); menu.data.message.conversation = 'MENU'; await h.service.handle(menu);
  await h.service.handle({ ...event, data: { ...event.data, key: { ...event.data.key, id: 'new-human' } } });
  await h.service.tick(); assert.equal(h.records.get(ticketPath).status, 'aguardando');
});

test('AI conversation keeps encrypted short history per customer, without phone or ride data', async () => {
  const inputs = [];
  const h = harness(() => false, async input => {
    inputs.push(input); assert.equal(input.phone, undefined); assert.equal(input.ride, undefined);
    return { answer: { text: 'Vamos conferir o problema no aplicativo. O erro acontece antes de calcular?', topic: 'address' }, history: [{ role: 'user', text: input.text }, { role: 'model', text: 'Ajuda sobre o aplicativo.' }] };
  });
  const event = message(); event.data.message.conversation = 'Quero ajuda com o GPS'; await h.service.handle(event);
  assert.match(h.sent[0].text, /Vamos conferir/); assert.match(h.sent[0].text, /ATENDENTE/);
  const state = [...h.records.values()].find(x => x.aiContextCriptografado);
  assert.ok(state.aiContextCriptografado.startsWith('encrypted:'));
  const next = message({}, 'followup'); next.data.message.conversation = 'Sim, antes de calcular'; await h.service.handle(next);
  assert.equal(inputs[1].history.length, 2);
  const other = message({ remoteJid: '5519888887777@s.whatsapp.net' }, 'different-phone'); other.data.message.conversation = 'Quero ajuda'; await h.service.handle(other);
  assert.deepEqual(inputs[2].history, []);
});

test('critical ride facts, menu and human handoff never invoke the AI', async () => {
  let calls = 0; const h = harness(() => false, async () => { calls++; throw Error('must not call'); });
  for (const [i, text] of ['2', 'MENU', 'ATENDENTE'].entries()) {
    const event = message({}, `critical-${i}`); event.data.message.conversation = text; await h.service.handle(event);
  }
  assert.equal(calls, 0); assert.equal(h.sent.length, 3);
});

test('AI failure preserves the deterministic answer and AI handoff writes the same protected ticket', async () => {
  const failed = harness(() => false, async () => { throw Error('provider offline'); });
  const event = message(); event.data.message.conversation = 'GPS está errado'; await failed.service.handle(event);
  assert.match(failed.sent[0].text, /saída, no destino/);
  const human = harness(() => false, async () => ({ answer: { human: true, text: 'Untrusted generated promise', topic: 'human' } }));
  await human.service.handle(event); assert.doesNotMatch(human.sent[0].text, /Untrusted/);
  assert.ok([...human.records.values()].some(ticket => ticket.status === 'aguardando' && ticket.telefoneCriptografado));
});

test('paused automation ignores customer messages and does not alert groups', async () => {
  const h = harness(); await h.service.saveConfig({ enabled: false }); await h.service.handle(message()); await h.service.tick(); assert.equal(h.sent.length, 0);
});

test('group reminders are once per generation and channel; renewal can alert again', async () => {
  const h = harness(); h.records.set('corridas/ride', { status: 'pendente', criadaEm: NOW - 121000, valor: 12 });
  await h.service.tick(); await h.service.tick(); assert.equal(h.sent.length, 1); assert.equal(h.telegram.length, 1);
  h.records.set('corridas/ride', { status: 'pendente', criadaEm: NOW - 500, valor: 12 });
  await h.service.tick(); assert.equal(h.sent.length, 2); assert.equal(h.telegram.length, 1);
});

test('rechecks acceptance between claim and sending group notice', async () => {
  const h = harness(); h.records.set('corridas/ride', { status: 'pendente', criadaEm: NOW - 121000 });
  h.beforeRead(path => { if (path.startsWith('supportAutomationNotices/')) h.records.set('corridas/ride', { status: 'aceita', criadaEm: NOW - 121000 }); });
  await h.service.tick(); assert.equal(h.sent.length, 0); assert.equal(h.telegram.length, 0);
});

test('customer waiting complaint alerts both groups once and confirms actual delivery without personal details', async () => {
  const h = harness();
  h.records.set('corridas/current', { status: 'pendente', criadaEm: NOW - 180000, telefoneCliente: '19999990000', origem: 'Rua privada, 123', valor: 12 });
  await h.service.handle(message());
  const group = h.sent.find(item => item.phone === '123@g.us');
  assert.match(group.text, /cliente pediu ajuda/); assert.doesNotMatch(group.text, /Rua privada|19999990000/);
  assert.equal(h.telegram.length, 1);
  assert.match(h.sent.find(item => item.phone === '5519999990000').text, /Enviei um reforço ao grupo dos motoboys no WhatsApp e ao Telegram/);
  h.advance(16000); const next = message({}, 'repeated-delay'); next.data.messageTimestamp += 16;
  next.data.message.conversation = 'Por que está demorando tanto?'; await h.service.handle(next);
  assert.equal(h.sent.filter(item => item.phone === '123@g.us').length, 1); assert.equal(h.telegram.length, 1);
  assert.match(h.sent.at(-1).text, /Já há um aviso recente/);
});

test('automatic waiting reminders repeat every two minutes and stop on acceptance or expiry', async () => {
  for (const stop of ['accepted', 'expired']) {
    const h = harness(); h.records.set('corridas/ride', { status: 'pendente', criadaEm: NOW - 121000 });
    await h.service.tick(); h.advance(120000); await h.service.tick(); await h.service.tick();
    assert.equal(h.sent.length, 2); assert.equal(h.telegram.length, 2); assert.match(h.sent[1].text, /4 minutos/);
    if (stop === 'accepted') h.records.set('corridas/ride', { status: 'aceita', criadaEm: NOW - 121000 });
    h.advance(60000); await h.service.tick(); assert.equal(h.sent.length, 2); assert.equal(h.telegram.length, 2);
  }
});

test('customer notice never confirms a failed group send', async () => {
  const h = harness(() => false, async () => null, { whatsapp: true, telegram: true });
  h.records.set('corridas/current', { status: 'pendente', criadaEm: NOW - 180000, telefoneCliente: '19999990000' });
  await h.service.handle(message());
  assert.match(h.sent.at(-1).text, /Não consegui confirmar o envio/); assert.doesNotMatch(h.sent.at(-1).text, /Enviei um reforço/);
});

test('customer group requests require an owned, unexpired pending ride and enabled alerts', async () => {
  for (const state of ['aceita', 'cancelada', 'expirada', 'expired-pending', 'unowned', 'disabled']) {
    const h = harness(); h.records.set('corridas/c59de63b4-39799232', { status: ['unowned', 'disabled', 'expired-pending'].includes(state) ? 'pendente' : state, criadaEm: NOW - (state === 'expired-pending' ? 300001 : 180000), telefoneCliente: state === 'unowned' ? '19888880000' : '19999990000' });
    if (state === 'disabled') await h.service.saveConfig({ groupAlerts: false });
    const event = message(); event.data.message.conversation = 'Minha corrida c59de63b4-39799232 está demorando'; await h.service.handle(event);
    assert.equal(h.sent.filter(item => item.phone.endsWith('@g.us')).length, 0); assert.equal(h.telegram.length, 0);
  }
});

test('a recent automatic notice avoids a duplicate customer reminder; acceptance race returns current status', async () => {
  const recent = harness(); recent.records.set('corridas/current', { status: 'pendente', criadaEm: NOW - 121000, telefoneCliente: '19999990000' });
  await recent.service.tick(); await recent.service.handle(message());
  assert.equal(recent.sent.filter(item => item.phone.endsWith('@g.us')).length, 1); assert.equal(recent.telegram.length, 1);
  assert.match(recent.sent.at(-1).text, /Já há um aviso recente/);
  const raced = harness(); raced.records.set('corridas/current', { status: 'pendente', criadaEm: NOW - 180000, telefoneCliente: '19999990000' });
  let reads = 0; raced.beforeRead(path => { if (path === 'corridas/current' && ++reads === 2) raced.records.set(path, { status: 'aceita', criadaEm: NOW - 180000, telefoneCliente: '19999990000' }); });
  await raced.service.handle(message()); assert.equal(raced.telegram.length, 0);
  assert.equal(raced.sent.length, 1); assert.match(raced.sent[0].text, /já foi aceita/); assert.doesNotMatch(raced.sent[0].text, /Enviei um reforço/);
});

test('retention clears expired metadata but preserves unresolved human tickets', async () => {
  const h = harness(); h.records.set('supportAutomationEvents/old', { expiresAt: new Date(NOW - 1) });
  h.records.set('supportAutomationTickets/open', { status: 'aguardando' });
  h.records.set('supportAutomationTickets/closed', { status: 'resolvido', expiresAt: new Date(NOW - 1) });
  await h.service.tick(); assert.equal(h.records.has('supportAutomationEvents/old'), false);
  assert.equal(h.records.has('supportAutomationTickets/open'), true);
  assert.equal(h.records.has('supportAutomationTickets/closed'), false);
});
