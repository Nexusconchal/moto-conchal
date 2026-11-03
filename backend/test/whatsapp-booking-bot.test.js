import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupportAutomation, parseSupportMessage } from '../src/support-automation.js';
import { createWhatsappBooking } from '../src/whatsapp-booking.js';

// O pedido pelo WhatsApp passando pelo atendimento de verdade (webhook, fila, IA, pausa).
const NOW = 1800000000000;
const AZALEIAS = { gps: false, lat: -22.3322, lon: -47.1774, texto: 'Rua das Azaleias 65', encontrado: 'Rua das Azaleias, 65 - Centro, Conchal - SP', cidade: 'conchal' };
const ZANCHETA = { gps: false, lat: -22.3401, lon: -47.1652, texto: 'rua dos zancheta 128', encontrado: 'Rua dos Zancheta, 128 - Jardim Bela Vista, Conchal - SP', cidade: 'conchal' };

function harness({ settings = {}, remoteJid = '5519999338422@s.whatsapp.net' } = {}) {
  const records = new Map([['configuracoes/atendimentoAutomatico', { enabled: true, groupAlerts: false, ...settings }]]);
  const sent = [], created = [], ai = [];
  let time = NOW, seq = 0, lock = Promise.resolve();
  const snapshot = (ref) => ({ id: ref.id, ref, exists: records.has(ref.path), data: () => records.get(ref.path) });
  const ref = (path) => ({ path, id: path.split('/').at(-1), async get() { return snapshot(this); }, async set(data, options) { records.set(path, options?.merge ? { ...records.get(path), ...data } : data); } });
  const db = {
    collection: (name) => ({ doc: (id) => ref(`${name}/${id}`), where: (key, op, value) => ({ limit: () => ({ async get() { const docs = [...records.keys()].filter((p) => p.startsWith(`${name}/`) && (op === '<' ? records.get(p)[key] < value : records.get(p)[key] === value)).map((p) => snapshot(ref(p))); return { docs, empty: !docs.length }; } }), async get() { const docs = [...records.keys()].filter((p) => p.startsWith(`${name}/`) && records.get(p)[key] === value).map((p) => snapshot(ref(p))); return { docs, empty: !docs.length }; } }) }),
    batch() { return { delete() {}, commit: async () => {} }; },
    runTransaction(callback) { const work = lock.then(() => callback({ get: (r) => r.get(), set: (r, v, o) => r.set(v, o) })); lock = work.catch(() => {}); return work; }
  };
  const encrypt = (v) => `encrypted:${v}`;
  const decrypt = (v) => v.slice('encrypted:'.length);
  const booking = createWhatsappBooking({
    db, encrypt, decrypt, now: () => time,
    lookupCustomer: async () => null,
    resolvePlace: async ({ text, location }) => (location ? { ok: true, lugar: { ...AZALEIAS, gps: true } } : /azaleias/i.test(text) ? { ok: true, lugar: AZALEIAS } : /zancheta/i.test(text) ? { ok: true, lugar: ZANCHETA } : { ok: false }),
    quote: async () => ({ km: 2.07, valor: 6.5, periodo: 'dia', cidade: 'conchal' }),
    createRide: async (data) => { created.push(data); return { rideId: 'ride1', duplicated: false }; },
    findOpenRide: async () => null,
    cancelRide: async () => ({ status: 'cancelada' }),
    renewRide: async () => 'renovada'
  });
  const service = createSupportAutomation({
    db, instance: 'support', encrypt, decrypt, booking, now: () => time, rideExpireMs: 600000, deliveryExpireMs: 900000,
    generateReply: async (input) => { ai.push(input); return null; },
    sendText: async (phone, text) => { sent.push({ phone, text }); return { sent: true, id: `reply${sent.length}` }; },
    sendTelegram: async () => ({ sent: true })
  });
  const webhook = (message) => {
    seq += 1; time += 3000;
    return { instance: 'support', event: 'messages.upsert', data: { key: { id: `m${seq}`, remoteJid, fromMe: false }, pushName: 'Rafa', messageTimestamp: Math.floor(time / 1000), message } };
  };
  const say = (text) => service.handle(webhook({ conversation: text }));
  const pin = (lat, lon) => service.handle(webhook({ locationMessage: { degreesLatitude: lat, degreesLongitude: lon } }));
  return { service, records, sent, created, ai, say, pin, webhook, last: () => sent.at(-1)?.text || '' };
}

test('the WhatsApp location message is read as coordinates (and ignored when invalid)', () => {
  const base = { instance: 'support', event: 'messages.upsert', data: { key: { id: 'x', remoteJid: '5519999338422@s.whatsapp.net' }, messageTimestamp: NOW / 1000 } };
  const ok = parseSupportMessage({ ...base, data: { ...base.data, message: { locationMessage: { degreesLatitude: -22.33, degreesLongitude: -47.17 } } } }, 'support', NOW);
  assert.deepEqual(ok.location, { lat: -22.33, lon: -47.17 });
  assert.equal(ok.text, '');
  const bad = parseSupportMessage({ ...base, data: { ...base.data, message: { locationMessage: { degreesLatitude: 999, degreesLongitude: 0 } } } }, 'support', NOW);
  assert.equal(bad.location, null);
});

test('menu option 1 books a ride through the bot, step by step, without using the AI', async () => {
  const h = harness();
  await h.say('1');
  assert.match(h.last(), /Vamos pedir a sua moto![\s\S]*Qual é o seu nome/);
  await h.say('Rafael');
  assert.match(h.last(), /Onde você está/);
  await h.pin(-22.3322, -47.1774);
  assert.match(h.last(), /Saída: Rua das Azaleias[\s\S]*Para onde você vai/);
  await h.say('rua dos zancheta 128');
  assert.match(h.last(), /Confere o seu pedido, Rafael[\s\S]*R\$\s?6,50/);
  await h.say('sim');
  assert.match(h.last(), /Pedido enviado/);
  assert.equal(h.created.length, 1);
  assert.equal(h.ai.length, 0, 'the AI never answers during the order');
  assert.ok(h.sent.every((item) => item.phone === '5519999338422'));
});

test('outside the order, the bot keeps answering as before (status, AI, menu)', async () => {
  const h = harness();
  await h.say('quanto custa uma corrida?');
  assert.equal(h.created.length, 0);
  assert.equal(h.ai.length, 1, 'normal questions still go to the AI');
  await h.say('menu');
  assert.match(h.last(), /1 • Pedir corrida/);
});

test('when the WhatsApp order is switched off, option 1 explains the app as before', async () => {
  const h = harness({ settings: { pedidoWhatsapp: false } });
  await h.say('1');
  assert.match(h.last(), /Chamar motoboy/);
  assert.doesNotMatch(h.last(), /Qual é o seu nome/);
});

test('a WhatsApp ID without phone number gets the app instructions, never an order', async () => {
  const h = harness({ remoteJid: '123456789012345@lid' });
  await h.say('quero uma moto');
  assert.doesNotMatch(h.last(), /Qual é o seu nome/);
  assert.equal(h.created.length, 0);
});

test('a location sent while the previous answer is still going out is queued, not lost', async () => {
  const h = harness();
  await Promise.all([h.say('1'), h.pin(-22.3322, -47.1774)]);
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1].text, /Anotado![\s\S]*Qual é o seu nome/);
  await h.say('Rafael');
  assert.match(h.last(), /Saída: Rua das Azaleias[\s\S]*Para onde você vai/);
});
