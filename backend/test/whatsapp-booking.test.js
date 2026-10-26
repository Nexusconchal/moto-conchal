import test from 'node:test';
import assert from 'node:assert/strict';
import { createWhatsappBooking, bookingReply, validName, cityChoice, suggestionText, MAX_RIDES_PER_DAY, MAX_QUOTES_PER_HOUR } from '../src/whatsapp-booking.js';

const PHONE = '5519999338422';
const NOW = 1800000000000;
const AZALEIAS = { gps: false, lat: -22.3322, lon: -47.1774, texto: 'Rua das Azaleias 65', encontrado: 'Rua das Azaleias, 65 - Centro, Conchal - SP', cidade: 'conchal' };
const ZANCHETA = { gps: false, lat: -22.3401, lon: -47.1652, texto: 'rua dos zancheta 128', encontrado: 'Rua dos Zancheta, 128 - Jardim Bela Vista, Conchal - SP', cidade: 'conchal' };

function fakeDb() {
  const docs = new Map();
  const ref = (path) => ({
    path, id: path.split('/').at(-1),
    get: async () => ({ exists: docs.has(path), id: path.split('/').at(-1), data: () => docs.get(path) }),
    set: async (data, options) => { docs.set(path, options?.merge ? { ...docs.get(path), ...data } : { ...data }); }
  });
  return {
    docs,
    collection: (name) => ({
      doc: (id) => ref(`${name}/${id}`),
      where: (field, _op, value) => ({ limit: () => ({ get: async () => ({ docs: [...docs].filter(([k, v]) => k.startsWith(`${name}/`) && v[field] === value).map(([k]) => ({ id: k.split('/')[1], ref: ref(k), data: () => docs.get(k) })) }) }) })
    }),
    runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, d, o) => r.set(d, o) })
  };
}

function setup(overrides = {}) {
  const db = fakeDb();
  let time = NOW;
  const calls = { resolve: [], quote: 0, create: [], cancel: [], renew: [] };
  const deps = {
    lookupCustomer: async () => null,
    resolvePlace: async (args) => {
      calls.resolve.push(args);
      if (args.location) return { ok: true, lugar: { ...AZALEIAS, gps: true, lat: args.location.lat, lon: args.location.lon, texto: 'Localização enviada pelo WhatsApp' } };
      if (/azaleias/i.test(args.text)) return { ok: true, lugar: AZALEIAS };
      if (/zancheta/i.test(args.text)) return { ok: true, lugar: ZANCHETA };
      return { ok: false };
    },
    quote: async () => { calls.quote += 1; return { km: 2.07, valor: 6.5, periodo: 'dia', cidade: 'conchal' }; },
    createRide: async (data) => { calls.create.push(data); return { rideId: `ride${calls.create.length}`, duplicated: false }; },
    findOpenRide: async () => null,
    cancelRide: async (phone, rideId) => { calls.cancel.push(rideId); return { status: 'cancelada' }; },
    renewRide: async (phone, rideId) => { calls.renew.push(rideId); return 'renovada'; },
    ...overrides
  };
  const booking = createWhatsappBooking({ db, encrypt: (v) => `enc(${Buffer.from(v).toString('base64')})`, decrypt: (v) => Buffer.from(v.slice(4, -1), 'base64').toString(), now: () => time, rideExpireMs: 600000, ...deps });
  const say = (text, intent = 'other', extra = {}) => booking.handle({ phone: PHONE, text, ...extra }, intent);
  return { db, booking, calls, say, advance: (ms) => { time += ms; } };
}

test('replies, names and cities are understood the way customers write them', () => {
  assert.equal(bookingReply('Sim'), 'yes');
  assert.equal(bookingReply('pode chamar!'), 'yes');
  assert.equal(bookingReply('NÃO'), 'no');
  assert.equal(bookingReply('cancelar o pedido'), 'cancel');
  assert.equal(bookingReply('de novo'), 'again');
  assert.equal(bookingReply('Rua das Azaleias 65'), '');
  assert.equal(validName('rafael souza'), 'Rafael Souza');
  assert.equal(validName('MARIA DA SILVA'), 'Maria da Silva');
  assert.equal(validName('Rua das Azaleias 65'), '');
  assert.equal(validName('a'), '');
  assert.equal(validName('sim'), '');
  assert.equal(validName('Cancelar'), '');
  assert.equal(cityChoice('2'), 'aguai');
  assert.equal(cityChoice('Eng. Coelho'), 'engenheiro_coelho');
  assert.equal(cityChoice('Limeira'), '');
  assert.equal(suggestionText('Rua das Acacias - Jardim Sao Paulo', 'rua acacia 120'), 'Rua das Acacias, 120, Jardim Sao Paulo');
});

test('whole conversation: name, pickup, destination, summary and a ride only after SIM', async () => {
  const h = setup();
  assert.match((await h.say('quero uma moto', 'request')).text, /Qual é o seu nome/);
  assert.match((await h.say('rafael')).text, /Prazer, Rafael![\s\S]*Onde você está/);
  assert.match((await h.say('Rua das Azaleias 65')).text, /Saída: Rua das Azaleias, 65 - Centro, Conchal - SP[\s\S]*Para onde você vai/);
  const summary = (await h.say('rua dos zancheta 128')).text;
  assert.match(summary, /Confere o seu pedido, Rafael/);
  assert.match(summary, /2,1 km · 💰 R\$\s?6,50/);
  assert.match(summary, /Responda \*SIM\*/);
  assert.equal(h.calls.create.length, 0, 'nothing is created before the SIM');
  const sent = (await h.say('sim'));
  assert.match(sent.text, /Pedido enviado, Rafael! Estou chamando os motoboys de Conchal/);
  assert.equal(h.calls.create.length, 1);
  const created = h.calls.create[0];
  assert.equal(created.phone, PHONE);
  assert.equal(created.nome, 'Rafael');
  assert.equal(created.destino.encontrado, ZANCHETA.encontrado);
  assert.match(created.requestId, /^wa-[a-f0-9]{40}$/);
  // A second SIM does not create another ride.
  assert.equal(await h.say('sim'), null);
  assert.equal(h.calls.create.length, 1);
});

test('names and addresses are stored encrypted, never as plain text', async () => {
  const h = setup();
  await h.say('quero uma moto', 'request');
  await h.say('Rafael');
  await h.say('Rua das Azaleias 65');
  const stored = JSON.stringify([...h.db.docs.values()]);
  assert.ok(!stored.includes('Rafael') && !stored.includes('Azaleias'), stored);
  assert.ok(![...h.db.docs.keys()].some((key) => key.includes(PHONE)), 'the phone is not the document id');
});

test('a registered customer skips the name; a location starts the order as the pickup', async () => {
  const h = setup({ lookupCustomer: async () => ({ nome: 'rafael souza' }) });
  const first = await h.say('', 'other', { location: { lat: -22.3322, lon: -47.1774 } });
  assert.match(first.text, /Oi, Rafael! Vamos pedir a sua moto[\s\S]*Recebi sua localização[\s\S]*Para onde você vai/);
  assert.equal(h.calls.resolve[0].role, 'origem');
  assert.match((await h.say('rua dos zancheta 128')).text, /Confere o seu pedido, Rafael/);
});

test('a location sent while asking the name is kept as the pickup', async () => {
  const h = setup();
  await h.say('1', 'request');
  assert.match((await h.say('', 'other', { location: { lat: -22.33, lon: -47.17 } })).text, /Qual é o seu nome/);
  assert.match((await h.say('Ana')).text, /Prazer, Ana![\s\S]*Saída: Rua das Azaleias[\s\S]*Para onde você vai/);
});

test('greetings or a new request are not taken as the name', async () => {
  const h = setup();
  await h.say('quero uma moto', 'request');
  assert.match((await h.say('quero uma moto', 'request')).text, /Me diga só o seu nome/);
  assert.match((await h.say('oi', 'greeting')).text, /Me diga só o seu nome/);
});

test('an address found in more than one city asks the city once and then uses it', async () => {
  const h = setup({
    resolvePlace: async (args) => {
      if (!args.city && /sete de setembro/i.test(args.text)) return { ok: false, pedirCidade: true };
      if (args.city === 'aguai') return { ok: true, lugar: { ...AZALEIAS, encontrado: 'Rua Sete de Setembro, 100 - Centro, Aguaí - SP', cidade: 'aguai' } };
      return { ok: true, lugar: ZANCHETA };
    }
  });
  await h.say('quero uma moto', 'request');
  await h.say('Rafael');
  assert.match((await h.say('rua sete de setembro 100')).text, /Em qual cidade fica esse endereço/);
  assert.match((await h.say('banana')).text, /Em qual cidade/);
  assert.match((await h.say('2')).text, /Saída: Rua Sete de Setembro, 100 - Centro, Aguaí - SP/);
});

test('a misspelled street shows the suggestions, and a number picks one keeping the house number', async () => {
  const seen = [];
  const h = setup({
    resolvePlace: async (args) => {
      seen.push(args.text);
      if (args.text === 'rua azaleia 65') return { ok: false, sugestoes: ['Rua das Azaleias', 'Rua das Acacias - Jardim Sao Paulo'] };
      return { ok: true, lugar: AZALEIAS };
    }
  });
  await h.say('quero uma moto', 'request');
  await h.say('Rafael');
  const answer = (await h.say('rua azaleia 65')).text;
  assert.match(answer, /Será algum destes\?\n1 • Rua das Azaleias\n2 • Rua das Acacias - Jardim Sao Paulo/);
  assert.match((await h.say('1')).text, /Saída: Rua das Azaleias, 65/);
  assert.equal(seen.at(-1), 'Rua das Azaleias, 65');
});

test('the name is remembered for the next order', async () => {
  const h = setup();
  await h.say('quero uma moto', 'request'); await h.say('Rafael'); await h.say('cancelar');
  assert.match((await h.say('quero uma moto', 'request')).text, /Oi, Rafael![\s\S]*Onde você está/);
});

test('CANCELAR during the conversation drops the order; ATENDENTE and MENU hand back to support', async () => {
  const h = setup();
  await h.say('quero uma moto', 'request');
  assert.match((await h.say('cancelar')).text, /cancelei este pedido/);
  assert.equal(await h.say('Rafael'), null);
  await h.say('quero uma moto', 'request');
  assert.equal(await h.say('ATENDENTE', 'human'), null);
  assert.equal(await h.say('Rafael'), null);
});

test('NÃO on the summary asks the addresses again, keeping the name', async () => {
  const h = setup();
  await h.say('quero uma moto', 'request'); await h.say('Rafael'); await h.say('Rua das Azaleias 65'); await h.say('rua dos zancheta 128');
  assert.match((await h.say('não')).text, /vamos corrigir[\s\S]*Onde você está/);
  await h.say('Rua das Azaleias 65');
  assert.match((await h.say('rua dos zancheta 128')).text, /Confere o seu pedido, Rafael/);
});

test('an old quote is recalculated: same price creates, a changed price asks again', async () => {
  let price = 6.5;
  const h = setup({ quote: async () => ({ km: 2.07, valor: price, periodo: price > 6.5 ? 'noite' : 'dia', cidade: 'conchal' }) });
  await h.say('quero uma moto', 'request'); await h.say('Rafael'); await h.say('Rua das Azaleias 65'); await h.say('rua dos zancheta 128');
  h.advance(11 * 60000);
  price = 8;
  const changed = (await h.say('sim')).text;
  assert.match(changed, /O valor foi atualizado[\s\S]*R\$\s?8,00 \(tarifa da noite\)/);
  assert.equal(h.calls.create.length, 0);
  assert.match((await h.say('sim')).text, /Pedido enviado/);
  assert.equal(h.calls.create[0].cotacao.valor, 8);
});

test('if the server price no longer matches the table, the customer confirms the new value', async () => {
  let first = true;
  const h = setup({ createRide: async () => { if (first) { first = false; throw Object.assign(new Error('x'), { code: 'valor_nao_confere_com_tabela' }); } return { rideId: 'r', duplicated: false }; } });
  await h.say('quero uma moto', 'request'); await h.say('Rafael'); await h.say('Rua das Azaleias 65'); await h.say('rua dos zancheta 128');
  assert.match((await h.say('sim')).text, /O valor foi atualizado[\s\S]*Responda \*SIM\*/);
  assert.match((await h.say('sim')).text, /Pedido enviado/);
});

test('a route the server refuses asks the destination again with the reason', async () => {
  const h = setup({ quote: async () => { throw Object.assign(new Error('x'), { publicMessage: 'Essa viagem passa de 60 km.' }); } });
  await h.say('quero uma moto', 'request'); await h.say('Rafael'); await h.say('Rua das Azaleias 65');
  assert.match((await h.say('rua dos zancheta 128')).text, /Essa viagem passa de 60 km[\s\S]*Para onde você vai/);
});

test('one open ride per number: a new request shows the current ride instead of creating another', async () => {
  const h = setup({ findOpenRide: async () => ({ id: 'aberta', status: 'pendente' }) });
  assert.match((await h.say('quero uma moto', 'request')).text, /ainda está chamando os motoboys/);
  assert.match((await h.say('cancelar')).text, /cancelei a sua corrida/);
  assert.deepEqual(h.calls.cancel, ['aberta']);
});

test('daily ride limit and hourly quote limit protect against abuse', async () => {
  const h = setup();
  for (let i = 0; i < MAX_RIDES_PER_DAY; i += 1) {
    await h.say('quero uma moto', 'request'); if (i === 0) await h.say('Rafael');
    await h.say('Rua das Azaleias 65'); await h.say('rua dos zancheta 128');
    assert.match((await h.say('sim')).text, /Pedido enviado/);
    await h.say('cancelar');
  }
  await h.say('quero uma moto', 'request'); await h.say('Rafael'); await h.say('Rua das Azaleias 65'); await h.say('rua dos zancheta 128');
  assert.match((await h.say('sim')).text, /vários pedidos por aqui hoje/);
  assert.equal(h.calls.create.length, MAX_RIDES_PER_DAY);

  const q = setup();
  await q.say('quero uma moto', 'request'); await q.say('Rafael');
  let last = '';
  for (let i = 0; i <= MAX_QUOTES_PER_HOUR; i += 1) {
    await q.say('Rua das Azaleias 65');
    last = (await q.say('rua dos zancheta 128'))?.text || '';
    if (/Muitas tentativas/.test(last)) break;
    await q.say('não');
  }
  assert.match(last, /Muitas tentativas/);
  assert.equal(q.calls.quote, MAX_QUOTES_PER_HOUR);
});

test('a WhatsApp ID without a phone number never books; the free-ride rule blocks politely', async () => {
  const h = setup();
  assert.equal(await h.booking.handle({ phone: '', jid: '123@lid', text: 'quero uma moto' }, 'request'), null);
  const blocked = setup({ registrationBlock: async () => 'Faça seu cadastro no app.' });
  assert.equal((await blocked.say('quero uma moto', 'request')).text, 'Faça seu cadastro no app.');
  assert.equal(blocked.calls.create.length, 0);
});

test('a conversation idle for 30 minutes is forgotten', async () => {
  const h = setup();
  await h.say('quero uma moto', 'request'); await h.say('Rafael'); await h.say('Rua das Azaleias 65'); await h.say('rua dos zancheta 128');
  h.advance(31 * 60000);
  assert.equal(await h.say('sim'), null);
  assert.equal(h.calls.create.length, 0);
});

test('after nobody accepted, SIM calls the drivers again; after acceptance CANCELAR is refused politely', async () => {
  const h = setup();
  await h.say('quero uma moto', 'request'); await h.say('Rafael'); await h.say('Rua das Azaleias 65'); await h.say('rua dos zancheta 128'); await h.say('sim');
  // The tick marks the ride as expired for this phone.
  h.db.docs.set('corridas/ride1', { telefoneCliente: '19999338422', status: 'expirada', whatsappAcompanhar: true });
  const sent = [];
  await h.booking.tick({ sendText: async (phone, text) => { sent.push({ phone, text }); return { sent: true }; } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].phone, PHONE);
  assert.match(sent[0].text, /Nenhum motoboy aceitou/);
  assert.match((await h.say('sim')).text, /chamei os motoboys de novo/);
  assert.deepEqual(h.calls.renew, ['ride1']);

  const accepted = setup({ cancelRide: async () => ({ status: 'aceita', motoboy: 'João' }) });
  await accepted.say('quero uma moto', 'request'); await accepted.say('Rafael'); await accepted.say('Rua das Azaleias 65'); await accepted.say('rua dos zancheta 128'); await accepted.say('sim');
  assert.match((await accepted.say('cancelar')).text, /O motoboy João já aceitou/);
});

test('ride notices go out once each: driver arrived, finished; a cancelled ride stops being followed', async () => {
  const h = setup();
  h.db.docs.set('corridas/a', { telefoneCliente: '19999338422', status: 'aceita', motoboy: 'João', motoboyChegouEm: 1, whatsappAcompanhar: true });
  h.db.docs.set('corridas/b', { telefoneCliente: '19988887777', status: 'finalizada', whatsappAcompanhar: true });
  h.db.docs.set('corridas/c', { telefoneCliente: '19977776666', status: 'cancelada', whatsappAcompanhar: true });
  h.db.docs.set('corridas/d', { telefoneCliente: '19966665555', status: 'pendente', whatsappAcompanhar: true });
  const sent = [];
  const sendText = async (phone, text) => { sent.push({ phone, text }); return { sent: true }; };
  await h.booking.tick({ sendText });
  await h.booking.tick({ sendText });
  assert.deepEqual(sent.map((item) => item.phone).sort(), ['5519988887777', '5519999338422']);
  assert.match(sent.find((item) => item.phone === PHONE).text, /O motoboy João chegou ao local de embarque/);
  assert.match(sent.find((item) => item.phone === '5519988887777').text, /Corrida finalizada/);
  assert.equal(h.db.docs.get('corridas/b').whatsappAcompanhar, false);
  assert.equal(h.db.docs.get('corridas/c').whatsappAcompanhar, false);
  assert.equal(h.db.docs.get('corridas/d').whatsappAcompanhar, true);
});

test('address lookups are limited per hour (protects the map quota)', async () => {
  const h = setup({ resolvePlace: async () => ({ ok: false }) });
  await h.say('quero uma moto', 'request'); await h.say('Rafael');
  let last = '';
  for (let i = 0; i < 31; i += 1) last = (await h.say(`rua errada ${i} numero`)).text;
  assert.match(last, /Muitas buscas de endereço/);
});

test('if the server refuses an address when creating, nothing is booked and the addresses are asked again', async () => {
  const h = setup({ createRide: async () => { throw Object.assign(new Error('Destino da corrida nao conferiu'), { status: 400, code: 'endereco_nao_confere_com_local_digitado' }); } });
  await h.say('quero uma moto', 'request'); await h.say('Rafael'); await h.say('Rua das Azaleias 65'); await h.say('rua dos zancheta 128');
  assert.match((await h.say('sim')).text, /mapa não confirmou um dos endereços[\s\S]*Onde você está/);
});

test('after "nobody accepted", only an explicit SIM calls again ("ok" does not)', async () => {
  const h = setup();
  await h.say('quero uma moto', 'request'); await h.say('Rafael'); await h.say('Rua das Azaleias 65'); await h.say('rua dos zancheta 128'); await h.say('sim');
  h.db.docs.set('corridas/ride1', { telefoneCliente: '19999338422', status: 'expirada', whatsappAcompanhar: true });
  await h.booking.tick({ sendText: async () => ({ sent: true }) });
  assert.equal(await h.say('ok', 'thanks'), null);
  assert.equal(h.calls.renew.length, 0);
  assert.match((await h.say('sim')).text, /chamei os motoboys de novo/);
});

test('the expiry notice does not disturb a new order already being made', async () => {
  const h = setup();
  await h.say('quero uma moto', 'request'); await h.say('Rafael');
  h.db.docs.set('corridas/velha', { telefoneCliente: '19999338422', status: 'expirada', whatsappAcompanhar: true });
  const sent = [];
  await h.booking.tick({ sendText: async (phone, text) => { sent.push(text); return { sent: true }; } });
  assert.equal(sent.length, 0);
  assert.match((await h.say('Rua das Azaleias 65')).text, /Para onde você vai/);
});

test('after 2 addresses not found in a row, the app link is sent too (the customer never gets stuck)', async () => {
  const h = setup();
  await h.say('quero uma moto', 'request'); await h.say('Rafael');
  assert.doesNotMatch((await h.say('rua que nao existe 10')).text, /nexusmotoja\.com\.br/);
  assert.match((await h.say('outra rua errada 20')).text, /faça o pedido pelo app: https:\/\/nexusmotoja\.com\.br\//);
  // Achou o endereco: zera a contagem.
  await h.say('Rua das Azaleias 65');
  assert.doesNotMatch((await h.say('destino errado 30')).text, /nexusmotoja\.com\.br/);
});
