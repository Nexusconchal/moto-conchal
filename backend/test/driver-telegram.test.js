import test from 'node:test';
import assert from 'node:assert/strict';
import { createDriverTelegram } from '../src/driver-telegram.js';

function memoryDb() {
  const records = new Map();
  const ref = (path) => ({
    path,
    get: async () => ({ exists: records.has(path), data: () => records.get(path) }),
    set: async (data, opts) => records.set(path, opts?.merge ? { ...records.get(path), ...data } : data),
    delete: async () => records.delete(path)
  });
  return {
    records,
    collection: (name) => ({
      doc: (id) => ref(`${name}/${id}`),
      where: (field, _op, value) => ({ limit: () => ({ get: async () => ({ docs: [...records.keys()].filter((k) => k.startsWith(`${name}/`) && records.get(k)[field] === value).map((k) => ({ ref: ref(k) })) }) }) })
    })
  };
}

function setup(now = () => 1000) {
  const db = memoryDb();
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const method = url.split('/').at(-1);
    const body = JSON.parse(opts.body);
    calls.push([method, body]);
    if (method === 'getMe') return { ok: true, json: async () => ({ ok: true, result: { username: 'MotoJaBot' } }) };
    if (body.chat_id === 'bloqueou') return { ok: false, status: 403, json: async () => ({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }) };
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  };
  const tg = createDriverTelegram({ db, token: 'T', fetchImpl, now });
  return { db, calls, tg };
}

test('the app link links the motoboy private chat once and expires', async () => {
  let clock = 1000;
  const { db, calls, tg } = setup(() => clock);
  db.records.set('motoboys/11111111111', { nome: 'Bruno', status: 'ativo' });
  const { link } = await tg.createLink('11111111111');
  const code = link.match(/^https:\/\/t\.me\/MotoJaBot\?start=([a-f0-9]{36})$/)[1];
  assert.ok(![...db.records.keys()].some((key) => key.includes(code)), 'o codigo e guardado so como hash');

  const first = await tg.handleUpdate({ message: { chat: { id: 555, type: 'private' }, text: `/start ${code}` } });
  assert.equal(first.linked, true);
  assert.equal(db.records.get('motoboys/11111111111').telegramChatId, '555');
  assert.match(calls.at(-1)[1].text, /Pronto, Bruno/);

  const reused = await tg.handleUpdate({ message: { chat: { id: 999, type: 'private' }, text: `/start ${code}` } });
  assert.equal(reused.linked, false);
  assert.equal(db.records.get('motoboys/11111111111').telegramChatId, '555');

  const second = await tg.createLink('11111111111');
  clock += 16 * 60 * 1000;
  const late = await tg.handleUpdate({ message: { chat: { id: 777, type: 'private' }, text: `/start ${second.link.split('=')[1]}` } });
  assert.equal(late.linked, false);
  assert.match(calls.at(-1)[1].text, /expirou/);
});

test('group messages are ignored and /parar unlinks', async () => {
  const { db, tg } = setup();
  db.records.set('motoboys/11111111111', { nome: 'Bruno', telegramChatId: '555' });
  assert.equal((await tg.handleUpdate({ message: { chat: { id: -1, type: 'group' }, text: '/parar' } })).handled, false);
  const out = await tg.handleUpdate({ message: { chat: { id: 555, type: 'private' }, text: '/parar' } });
  assert.equal(out.unlinked, 1);
  assert.equal(db.records.get('motoboys/11111111111').telegramChatId, '');
});

test('a call goes once to each linked chat and a blocked bot does not break the others', async () => {
  const { calls, tg } = setup();
  const doc = (data) => ({ data: () => data });
  const result = await tg.notifyDrivers([doc({ telegramChatId: '1' }), doc({ telegramChatId: '1' }), doc({ telegramChatId: 'bloqueou' }), doc({}), doc({ telegramChatId: '2' })], 'Nova corrida');
  assert.deepEqual(result, { sent: 2, linked: 3 });
  assert.deepEqual(calls.map(([, body]) => body.chat_id), ['1', 'bloqueou', '2']);
  assert.equal((await tg.sendTo('bloqueou', 'x')).blocked, true);
});
