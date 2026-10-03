import test from 'node:test';
import assert from 'node:assert/strict';
import { brazilPhone, parseSupportMessage, requestedRideId, supportAnswer, chooseDriverGroup, pendingNotice, createSupportAutomation } from '../src/support-automation.js';

const NOW = 1800000000000;
function message(overrides = {}, id = 'message1') {
  return { instance: 'support', event: 'messages.upsert', data: { key: { id, remoteJid: '5519999990000@s.whatsapp.net', fromMe: false, ...overrides }, messageTimestamp: NOW / 1000, message: { conversation: 'Minha corrida está aguardando' } } };
}
function harness() {
  const records = new Map([['configuracoes/atendimentoAutomatico', { enabled: true, groupAlerts: true, driverGroupJid: '123@g.us' }]]);
  const sent = [], telegram = [];
  let time = NOW, lock = Promise.resolve(), beforeRead;
  const snapshot = ref => ({ id: ref.id, ref, exists: records.has(ref.path), data: () => records.get(ref.path) });
  const ref = path => ({ path, id: path.split('/').at(-1), async get() { if (beforeRead) beforeRead(path); return snapshot(this); }, async set(data, options) { records.set(path, options?.merge ? { ...records.get(path), ...data } : data); } });
  const collection = name => ({ doc: id => ref(`${name}/${id}`), where: (key, op, value) => {
    let max = Infinity;
    const query = { limit(count) { max = count; return query; }, async get() {
      const docs = [...records.keys()].filter(path => path.startsWith(`${name}/`) && (op === '<' ? records.get(path)[key] < value : records.get(path)[key] === value)).slice(0, max).map(path => snapshot(ref(path)));
      return { docs, empty: !docs.length };
    } }; return query;
  } });
  const db = { collection, batch() { const deletions = []; return { delete: ref => deletions.push(ref.path), commit: async () => { deletions.forEach(path => records.delete(path)); } }; }, runTransaction(callback) { const work = lock.then(() => callback({ get: ref => ref.get(), set: (ref, value, options) => ref.set(value, options) })); lock = work.catch(() => {}); return work; } };
  const service = createSupportAutomation({ db, instance: 'support', encrypt: value => `encrypted:${value}`, now: () => time, rideExpireMs: 300000, deliveryExpireMs: 900000, sendText: async (phone, text) => { sent.push({ phone, text }); return { sent: true, id: `reply${sent.length}` }; }, sendTelegram: async (job, text) => { telegram.push({ job, text }); return { sent: true }; } });
  return { service, records, sent, telegram, advance: delta => { time += delta; }, beforeRead: callback => { beforeRead = callback; } };
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

test('ATENDENTE writes encrypted callback phone and pauses further auto responses', async () => {
  const h = harness(); const event = message(); event.data.message.conversation = 'quero atendente';
  await h.service.handle(event);
  assert.match(h.sent[0].text, /30 minutos/);
  const ticket = [...h.records.entries()].find(([path]) => path.startsWith('supportAutomationTickets/'))[1];
  assert.equal(ticket.telefoneCriptografado, 'encrypted:5519999990000');
  assert.equal(ticket.telefone, undefined);
  await h.service.handle(message({}, 'again')); assert.equal(h.sent.length, 1);
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
  let reads = 0; h.beforeRead(path => { if (path === 'corridas/ride' && ++reads === 2) h.records.set(path, { status: 'aceita', criadaEm: NOW - 121000 }); });
  await h.service.tick(); assert.equal(h.sent.length, 0); assert.equal(h.telegram.length, 0);
});

test('retention clears expired metadata but preserves unresolved human tickets', async () => {
  const h = harness(); h.records.set('supportAutomationEvents/old', { expiresAt: new Date(NOW - 1) });
  h.records.set('supportAutomationTickets/open', { status: 'aguardando' });
  h.records.set('supportAutomationTickets/closed', { status: 'resolvido', expiresAt: new Date(NOW - 1) });
  await h.service.tick(); assert.equal(h.records.has('supportAutomationEvents/old'), false);
  assert.equal(h.records.has('supportAutomationTickets/open'), true);
  assert.equal(h.records.has('supportAutomationTickets/closed'), false);
});
