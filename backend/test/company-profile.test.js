import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { companyProfileUpdate } from '../src/company-profile.js';
const draft = () => ({ empresa: 'Loja São Paulo', responsavel: 'José', retirada: 'Rua Idalina, 256, Conchal', telefoneContato: '(19) 99999-0000' });
const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

test('profile accepts only bounded profile fields; account identity, balance and credentials cannot be changed', () => {
  const profile = companyProfileUpdate({ ...draft(), saldo: 9999, reservado: 0, status: 'aprovada', telefoneEmpresa: 'other-account', email: 'other', senha: 'other', token: 'other' });
  assert.deepEqual(profile, { ...draft(), telefoneContato: '19999990000' });
  assert.equal(companyProfileUpdate({ ...draft(), telefoneContato: '+55 (19) 99999-0000' }).telefoneContato, '19999990000');
  for (const body of [{ ...draft(), empresa: '' }, { ...draft(), responsavel: '<img src=x onerror=alert(1)>' }, { ...draft(), retirada: 'a'.repeat(301) }, { ...draft(), telefoneContato: '123' }, { ...draft(), telefoneContato: '19999990000abc' }, { ...draft(), empresa: {} }]) assert.throws(() => companyProfileUpdate(body), /Preencha|Confira|Informe/);
});

test('authenticated save targets only the session account, performs one merge and skips unchanged saves', async () => {
  let handler; const writes = [];
  const company = { ...draft(), telefoneEmpresa: '19888880000', telefoneContato: '19888880000', saldo: 400, reservado: 20 };
  const ctx = vm.createContext({ companyProfileUpdate, rateLimit: config => { assert.equal(config.keyGenerator({ companyId: 'mine' }), 'mine'); return 'limit'; },
    assertCompany: 'auth', assertCompanyApproved: 'approved', publicCompany: (value,id) => ({ ...value,id }), admin: { firestore: { FieldValue: { serverTimestamp: () => 'timestamp' } } },
    app: { post: (url,...middleware) => { assert.equal(url, '/api/companies/me/profile'); assert.deepEqual(middleware.slice(0,3), ['auth','approved','limit']); handler = middleware.at(-1); } }
  });
  const start = server.indexOf('const companyProfileLimiter ='), end = server.indexOf("app.get('/api/companies/me/order-integrations'", start);
  vm.runInContext(server.slice(start,end),ctx);
  let result, status = 200, failure;
  const req = { companyId: '19888880000', company, companySnap: { ref: { set: async (value,options) => writes.push({ value,options }) } }, body: { ...draft(), saldo: 9999, telefoneEmpresa: 'other' } };
  const res = { set: () => {}, status: n => { status=n; return res; }, json: value => { result=value; return res; } };
  await handler(req,res,error => { failure=error; });
  assert.equal(failure,undefined); assert.equal(status,200); assert.equal(writes.length,1); assert.equal(writes[0].options.merge,true);
  assert.deepEqual(Object.keys(writes[0].value).sort(),['atualizadaEm','empresa','responsavel','retirada','telefoneContato']);
  assert.equal(result.company.telefoneEmpresa,'19888880000'); assert.equal(result.company.saldo,400); assert.equal(result.company.reservado,20);
  req.company = result.company;
  await handler(req,res,error => { failure=error; }); assert.equal(writes.length,1); assert.equal(result.changed,false);
  req.body.telefoneContato='bad'; await handler(req,res,error => { failure=error; }); assert.equal(status,400); assert.equal(writes.length,1);
});

function uiHarness() {
  const ids = ['empresa','responsavel','telefoneContato','retirada','cadastroFeedback','cadastroLoja','salvarCadastroLoja','cancelarCadastroLoja','editarCadastroLoja'];
  const elements = Object.fromEntries(ids.map(id => [id, { value: '', textContent: '', style: {}, disabled: false, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, setAttribute() {}, classList: { hidden: true, add() { this.hidden = true; }, remove() { this.hidden = false; }, contains() { return this.hidden; } } }]));
  const ctx = vm.createContext({ window: {}, document: { getElementById: id => elements[id] } });
  vm.runInContext(fs.readFileSync(new URL('../../company-profile.js', import.meta.url),'utf8'),ctx);
  let identity = 'session', resolveSave, calls = 0, saved = 0; const notices = [];
  const profile = ctx.window.MotojaCompanyProfile.create({ identity: () => identity, changed: () => {}, notice: message => notices.push(message), saved: () => saved++, save: () => { calls++; return new Promise(resolve => { resolveSave=resolve; }); } });
  const company = { ...draft(), telefoneContato:'19999990000', telefoneEmpresa:'19888880000' };
  profile.sync(company);
  return { elements, profile, company, notices, get calls() { return calls; }, get saved() { return saved; }, resolve: c => resolveSave(c), switchAccount: () => { identity='different'; } };
}

test('cancel restores saved draft, prevents unsaved requests; saves lock duplicate clicks and commit only after success', async () => {
  const h=uiHarness(); h.elements.editarCadastroLoja.onclick(); h.elements.responsavel.value='Draft'; h.elements.responsavel.listeners.input();
  assert.equal(h.profile.canRequest(),false); assert.ok(h.notices.length);
  h.elements.cancelarCadastroLoja.onclick(); assert.equal(h.elements.responsavel.value,'José'); assert.equal(h.profile.canRequest(),true); assert.equal(h.calls,0);
  h.elements.editarCadastroLoja.onclick(); h.elements.responsavel.value='Novo responsável';
  const saving=h.elements.salvarCadastroLoja.onclick(); await h.elements.salvarCadastroLoja.onclick(); assert.equal(h.calls,1); assert.equal(h.elements.cancelarCadastroLoja.disabled,true);
  h.resolve({ ...h.company,responsavel:'Novo responsável' }); await saving; assert.equal(h.saved,1); assert.equal(h.profile.canRequest(),true); assert.equal(h.elements.cancelarCadastroLoja.disabled,false);
});

test('a delayed save cannot apply one account profile after the session changes', async () => {
  const h=uiHarness(); h.elements.responsavel.value='Draft'; const saving=h.elements.salvarCadastroLoja.onclick();
  h.switchAccount(); h.resolve({ ...h.company,responsavel:'Other account response' }); await saving; assert.equal(h.saved,0); assert.notEqual(h.elements.responsavel.value,'Other account response');
});

test('contact phone is stripped from public pending jobs and server owns new delivery contact', () => {
  const ctx = vm.createContext({}); const start=server.indexOf('function publicPendingJob('), end=server.indexOf('\nfunction ',start+1);
  vm.runInContext(server.slice(start,end),ctx);
  const job=ctx.publicPendingJob({ telefoneEmpresa:'private',telefoneContato:'private', telefoneRecebedor:'private', status:'pendente' });
  assert.equal('telefoneContato' in job,false);
  assert.ok(server.includes('delivery.telefoneContato = onlyDigits(req.company.telefoneContato || req.companyId)'));
});
