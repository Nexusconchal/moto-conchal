import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const DELETE = { del: true };

function setup() {
  const docs = new Map([['clientes/19999338422', { nome: 'Rafael' }]]);
  const apply = (path, data) => {
    const next = { ...(docs.get(path) || {}) };
    for (const [k, v] of Object.entries(data)) {
      if (v === DELETE) delete next[k];
      else if (v?.union) next[k] = [...new Set([...(next[k] || []), ...v.union])];
      else if (v?.remove) next[k] = (next[k] || []).filter((x) => !v.remove.includes(x));
      else next[k] = v;
    }
    docs.set(path, next);
  };
  const ref = (path) => ({ path, get: async () => ({ data: () => docs.get(path) }), set: async (data) => apply(path, data) });
  const db = { collection: (name) => ({
    doc: (id) => ref(`${name}/${id}`),
    where: (field, op, value) => ({ limit: () => ({ get: async () => {
      const found = [...docs].filter(([k, v]) => k.startsWith(`${name}/`) && (op === '==' ? v[field] === value : (v[field] || []).includes(value)));
      return { empty: !found.length, docs: found.map(([k, v]) => ({ id: k.split('/')[1], data: () => v, ref: ref(k) })) };
    } }) })
  }) };
  let n = 0;
  const ctx = vm.createContext({ db, Date, Number, Array, Set, Math, String,
    crypto: { randomBytes: () => ({ toString: () => `tok${++n}` }) },
    hashSecret: (v) => `h:${v}`,
    admin: { firestore: { FieldValue: { delete: () => DELETE, serverTimestamp: () => 'TS', arrayUnion: (...v) => ({ union: v }), arrayRemove: (...v) => ({ remove: v }) } } } });
  const slice = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
  vm.runInContext(slice('const CUSTOMER_MAX_SESSIONS', 'async function issueCarCustomerSession('), ctx);
  vm.runInContext(slice('async function findCustomerSession(', 'function carCustomerProfileComplete('), ctx);
  return { docs, ctx, ref };
}

test('the customer stays logged in on several phones and the login does not expire', async () => {
  const h = setup();
  const conta = h.ref('clientes/19999338422');
  const celular1 = await h.ctx.issueCustomerSession(conta);
  const celular2 = await h.ctx.issueCustomerSession(conta);
  assert.ok(await h.ctx.findCustomerSession(celular1), 'logging in on the second phone keeps the first');
  assert.ok(await h.ctx.findCustomerSession(celular2));
  assert.equal(h.docs.get('clientes/19999338422').sessionExpiresAtMs, undefined);
});

test('an old 90-day login still valid becomes permanent; an expired one is refused', async () => {
  const h = setup();
  h.docs.set('clientes/19999338422', { nome: 'Rafael', sessionTokenHash: 'h:velho', sessionExpiresAtMs: Date.now() + 1000 });
  assert.ok(await h.ctx.findCustomerSession('velho'));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.docs.get('clientes/19999338422').sessionExpiresAtMs, undefined);
  h.docs.set('clientes/19999338422', { nome: 'Rafael', sessionTokenHash: 'h:vencido', sessionExpiresAtMs: Date.now() - 1 });
  assert.equal(await h.ctx.findCustomerSession('vencido'), null);
});

test('a password reset disconnects the other phones', async () => {
  const h = setup();
  const conta = h.ref('clientes/19999338422');
  const antigo = await h.ctx.issueCustomerSession(conta);
  const novo = await h.ctx.issueCustomerSession(conta, { revokeOthers: true });
  assert.equal(await h.ctx.findCustomerSession(antigo), null);
  assert.ok(await h.ctx.findCustomerSession(novo));
});
