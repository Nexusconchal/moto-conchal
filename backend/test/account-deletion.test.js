import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Roda as duas rotas de exclusao de conta do server.js real, contra um Firestore falso.
const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

function extractRoute(path) {
  const start = source.indexOf(`app.post('${path}'`);
  if (start < 0) throw new Error(`rota nao encontrada: ${path}`);
  const end = source.indexOf('\n});\n', start) + '\n});\n'.length;
  return source.slice(start, end);
}

function fakeFirestore(records) {
  const matches = (value, op, expected) => {
    if (op === '==') return value === expected;
    if (op === 'in') return expected.includes(value);
    throw new Error(`operador nao suportado: ${op}`);
  };
  const collection = name => ({
    doc: id => ({
      id,
      path: `${name}/${id}`,
      get: async () => ({ id, exists: records.has(`${name}/${id}`), data: () => records.get(`${name}/${id}`), ref: null }),
      set: async (data, opts) => {
        const cur = records.get(`${name}/${id}`) || {};
        records.set(`${name}/${id}`, opts?.merge ? { ...cur, ...data } : { ...data });
      },
      delete: async () => { records.delete(`${name}/${id}`); },
    }),
    where: (field, op, value) => query(name, [{ field, op, value }]),
  });
  const query = (name, filters) => ({
    where: (field, op, value) => query(name, [...filters, { field, op, value }]),
    limit: () => query(name, filters),
    get: async () => {
      const docs = [...records.entries()]
        .filter(([key]) => key.startsWith(`${name}/`))
        .map(([key, data]) => ({ id: key.split('/')[1], data: () => data }))
        .filter(doc => filters.every(f => matches(records.get(`${name}/${doc.id}`)?.[f.field], f.op, f.value)));
      return { empty: docs.length === 0, docs };
    },
  });
  return { collection };
}

function build({ records, purgeAccount = async () => {}, getDriverWithProof = async () => ({}), findCustomerSession = async () => null }) {
  const routes = new Map();
  const db = fakeFirestore(records);
  const context = vm.createContext({
    app: { post: (url, ...handlers) => routes.set(url, handlers) },
    db,
    admin: { firestore: { FieldValue: { serverTimestamp: () => 0 } } },
    onlyDigits: v => String(v || '').replace(/\D/g, ''),
    authLimiter: (_req, _res, next) => next(),
    createRideLimiter: (_req, _res, next) => next(),
    driverProofCache: { clear() {} },
    adminStateCache: null,
    getDriverWithProof,
    findCustomerSession,
    clearCarDriverCache: () => {},
    customerCards: { purgeAccount },
    console,
  });
  vm.runInContext(extractRoute('/api/drivers/:cpf/excluir-conta'), context);
  vm.runInContext(extractRoute('/api/customers/me/excluir-conta'), context);
  return routes;
}

async function call(routes, url, { params = {}, body = {}, token = '' } = {}) {
  const handlers = routes.get(url);
  let status = 200;
  let data;
  const res = { status(v) { status = v; return res; }, json(v) { data = v; return res; } };
  let error;
  const req = { params, body, header: name => (name === 'authorization' && token ? `Bearer ${token}` : '') };
  for (const handler of handlers) {
    let advanced = false;
    await handler(req, res, err => { advanced = true; error = err; });
    if (!advanced) break;
  }
  if (error) throw error;
  return { status, data };
}

const DRIVER = '12345678901';
const CUSTOMER_ID = '19999990000';

test('motoboy sem corrida nem repasse: exclui o cadastro', async () => {
  const records = new Map([[`motoboys/${DRIVER}`, { nome: 'Teste' }]]);
  const routes = build({ records });
  const r = await call(routes, '/api/drivers/:cpf/excluir-conta', { params: { cpf: DRIVER }, body: {} });
  assert.equal(r.status, 200);
  assert.equal(records.has(`motoboys/${DRIVER}`), false);
});

test('motoboy com corrida aceita: nao exclui', async () => {
  const records = new Map([
    [`motoboys/${DRIVER}`, { nome: 'Teste' }],
    ['corridas/c1', { motoboyCpf: DRIVER, status: 'aceita' }],
  ]);
  const routes = build({ records });
  const r = await call(routes, '/api/drivers/:cpf/excluir-conta', { params: { cpf: DRIVER }, body: {} });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'exclusao_bloqueada');
  assert.equal(records.has(`motoboys/${DRIVER}`), true);
});

test('motoboy com repasse a pagar: nao exclui', async () => {
  const records = new Map([
    [`motoboys/${DRIVER}`, { nome: 'Teste' }],
    ['repassesMotoboy/r1', { motoboyCpf: DRIVER, status: 'a_pagar' }],
  ]);
  const routes = build({ records });
  const r = await call(routes, '/api/drivers/:cpf/excluir-conta', { params: { cpf: DRIVER }, body: {} });
  assert.equal(r.status, 409);
  assert.equal(records.has(`motoboys/${DRIVER}`), true);
});

test('CPF invalido: 400 e nada apagado', async () => {
  const records = new Map([[`motoboys/${DRIVER}`, { nome: 'Teste' }]]);
  const routes = build({ records });
  const r = await call(routes, '/api/drivers/:cpf/excluir-conta', { params: { cpf: '123' }, body: {} });
  assert.equal(r.status, 400);
  assert.equal(records.has(`motoboys/${DRIVER}`), true);
});

test('cliente com corrida pendente: nao exclui e nao toca nos cartoes', async () => {
  const records = new Map([
    [`clientes/${CUSTOMER_ID}`, { nome: 'Cliente' }],
    ['corridas/c2', { telefoneCliente: CUSTOMER_ID, status: 'pendente' }],
  ]);
  let purged = false;
  const routes = build({
    records,
    purgeAccount: async () => { purged = true; },
    findCustomerSession: async () => ({ customerId: CUSTOMER_ID, customer: {}, customerSnap: { ref: { delete: async () => {} } } }),
  });
  const r = await call(routes, '/api/customers/me/excluir-conta', { token: 'tok' });
  assert.equal(r.status, 409);
  assert.equal(purged, false);
  assert.equal(records.has(`clientes/${CUSTOMER_ID}`), true);
});

test('cliente sem corrida ativa: apaga cartoes, CPF e cadastro', async () => {
  const records = new Map([
    [`clientes/${CUSTOMER_ID}`, { nome: 'Cliente', cpfHash: 'abc' }],
    ['customerCpf/abc', { telefoneCliente: CUSTOMER_ID }],
  ]);
  let purged = false;
  const routes = build({
    records,
    purgeAccount: async () => { purged = true; },
    findCustomerSession: async () => ({
      customerId: CUSTOMER_ID,
      customer: { cpfHash: 'abc' },
      customerSnap: { ref: { delete: async () => { records.delete(`clientes/${CUSTOMER_ID}`); } } },
    }),
  });
  const r = await call(routes, '/api/customers/me/excluir-conta', { token: 'tok' });
  assert.equal(r.status, 200);
  assert.equal(purged, true);
  assert.equal(records.has(`customerCpf/abc`), false);
  assert.equal(records.has(`clientes/${CUSTOMER_ID}`), false);
});

test('motoboy com corrida de carro em andamento: nao exclui', async () => {
  const records = new Map([
    [`motoboys/${DRIVER}`, { nome: 'Teste' }],
    ['corridasCarro/k1', { motoristaCpf: DRIVER, status: 'em_andamento' }],
  ]);
  const routes = build({ records });
  const r = await call(routes, '/api/drivers/:cpf/excluir-conta', { params: { cpf: DRIVER }, body: {} });
  assert.equal(r.status, 409);
  assert.equal(records.has(`motoboys/${DRIVER}`), true);
});

test('motoboy excluido: cadastro do CarroJa do mesmo CPF sai junto', async () => {
  const records = new Map([
    [`motoboys/${DRIVER}`, { nome: 'Teste' }],
    [`carroMotoristas/${DRIVER}`, { placa: 'ABC1D23' }],
    ['corridasCarro/k2', { motoristaCpf: DRIVER, status: 'finalizada' }],
  ]);
  const routes = build({ records });
  const r = await call(routes, '/api/drivers/:cpf/excluir-conta', { params: { cpf: DRIVER }, body: {} });
  assert.equal(r.status, 200);
  assert.equal(records.has(`carroMotoristas/${DRIVER}`), false);
  assert.equal(records.has('corridasCarro/k2'), true);
});

test('sessao do motoboy invalida: nada e apagado', async () => {
  const records = new Map([[`motoboys/${DRIVER}`, { nome: 'Teste' }]]);
  const routes = build({
    records,
    getDriverWithProof: async () => { const e = new Error('sessao'); e.status = 401; throw e; },
  });
  await assert.rejects(call(routes, '/api/drivers/:cpf/excluir-conta', { params: { cpf: DRIVER }, body: { driverToken: 'x' } }), /sessao/);
  assert.equal(records.has(`motoboys/${DRIVER}`), true);
});

test('cliente sem login: 401 e nada apagado', async () => {
  const records = new Map([[`clientes/${CUSTOMER_ID}`, { nome: 'Cliente' }]]);
  const routes = build({ records });
  const r = await call(routes, '/api/customers/me/excluir-conta');
  assert.equal(r.status, 401);
  assert.equal(records.has(`clientes/${CUSTOMER_ID}`), true);
});
