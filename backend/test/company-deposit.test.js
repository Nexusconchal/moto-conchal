import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,companyId} from './financial-harness.js';
import {safeDepositCheckout,depositPaymentAmounts,companyDepositView} from '../src/company-deposit.js';
const payment=(changes={})=>({id:123,status:'approved',transaction_amount:100,currency_id:'BRL',external_reference:'deposit:deposit1',
  metadata:{payment_kind:'company_deposit',deposit_id:'deposit1',company_id:companyId},transaction_details:{net_received_amount:95},fee_details:[{amount:5}],...changes});
const initial=()=>({valor:100,metodo:'mercadopago',empresaId:companyId,telefoneEmpresa:companyId,status:'aguardando_pagamento',mercadoPago:{initPoint:'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref'}});
function setup() {
  const h=harness({[`empresas/${companyId}`]:{saldo:20,reservado:10,mercadoPagoEmpresa:{ultimoDepositoId:'deposit1'}},'depositos/deposit1':initial()});
  h.fn('applyCompanyDepositPayment');
  h.run('const companyDepositLimiter =',"app.post('/api/admin/deposits/:depositId/approve'");
  return h;
}
test('checkout only accepts official HTTPS Mercado Pago endpoints, never javascript, lookalike hosts or user credentials',()=>{
  assert.ok(safeDepositCheckout(initial().mercadoPago.initPoint));
  for(const value of ['javascript:alert(1)','https://mercadopago.com.br.evil.com/checkout/v1','https://evil.com/checkout/','http://www.mercadopago.com.br/checkout/','https://user:pass@www.mercadopago.com.br/checkout/']) assert.equal(safeDepositCheckout(value),'');
});
test('net credit is computed from provider amounts, handles explicit zero safely and refuses impossible values',()=>{
  assert.deepEqual(depositPaymentAmounts(payment()),{totalPago:100,taxaMercadoPago:5,valorLiquido:95});
  assert.equal(depositPaymentAmounts(payment({transaction_details:{net_received_amount:0}})).valorLiquido,0);
  assert.equal(depositPaymentAmounts(payment({transaction_details:{}})).valorLiquido,95);
  for(const details of [{net_received_amount:-1},{net_received_amount:1000},{net_received_amount:'NaN'}]) assert.throws(()=>depositPaymentAmounts(payment({transaction_details:details})));
});
test('approved payment credits net once, webhook retries preserve reserve, older pending notifications cannot downgrade an approved receipt',async()=>{
  const h=setup(); await Promise.all([h.context.applyCompanyDepositPayment(payment(),'deposit1'),h.context.applyCompanyDepositPayment(payment(),'deposit1')]);
  assert.equal(h.records.get(`empresas/${companyId}`).saldo,115);assert.equal(h.records.get(`empresas/${companyId}`).reservado,10);
  assert.equal([...h.records.keys()].filter(key=>key.startsWith('ledger/')).length,1);
  await h.context.applyCompanyDepositPayment(payment({status:'pending'}),'deposit1');
  assert.equal(h.records.get('depositos/deposit1').status,'aprovado');assert.equal(h.records.get('depositos/deposit1').mercadoPago.status,'approved');
});
test('forged currency, company, reference, source, kind and amount cannot credit another account',async()=>{
  for(const [changes,source] of [[{currency_id:'USD'}],[{metadata:{...payment().metadata,company_id:'another'}}],[{external_reference:'deposit:other'}],[{},'driver'],[{metadata:{...payment().metadata,payment_kind:'ride'}}]]) {
    const h=setup();await assert.rejects(h.context.applyCompanyDepositPayment(payment(changes),'deposit1',source)); assert.equal(h.records.get(`empresas/${companyId}`).saldo,20);
  }
  const h=setup();await h.context.applyCompanyDepositPayment(payment({transaction_amount:200,transaction_details:{net_received_amount:190}}),'deposit1');
  assert.equal(h.records.get(`empresas/${companyId}`).saldo,20);assert.equal(h.records.get('depositos/deposit1').status,'pagamento_divergente');
});
test('refund reverses the original credited amount once, never recredits later notifications or another payment against the same deposit',async()=>{
  const h=setup();await h.context.applyCompanyDepositPayment(payment(),'deposit1');
  await assert.rejects(h.context.applyCompanyDepositPayment(payment({id:999}),'deposit1'),/Outra cobrança/);
  await h.context.applyCompanyDepositPayment(payment({status:'refunded'}),'deposit1');
  await h.context.applyCompanyDepositPayment(payment({status:'refunded'}),'deposit1');
  await h.context.applyCompanyDepositPayment(payment(),'deposit1');
  assert.equal(h.records.get(`empresas/${companyId}`).saldo,20);assert.equal(h.records.get('depositos/deposit1').status,'credito_estornado');
});
test('company receipt is minimal, does not reveal credentials and rejects a deposit belonging to another company',async()=>{
  const h=setup();h.records.set('depositos/other',{...initial(),empresaId:'other',telefoneEmpresa:'other'});
  await assert.rejects(h.call('GET','/api/companies/me/deposit',{}, {query:{id:'other'}}),/nesta conta/);
  const response=await h.call('GET','/api/companies/me/deposit');assert.equal(response.data.deposit.id,'deposit1');
  assert.equal('empresaId' in companyDepositView('id',{...initial(),accessToken:'secret'}),false);
  assert.deepEqual(h.routes.get('GET /api/companies/me/deposit').slice(0,3),['auth','approved','rate-limit']);
});
test('manual verification recovers a missing webhook from the authoritative payment and cooldown prevents repeated provider calls',async()=>{
  const h=setup();h.context.provider=path=>path.includes('/search?')?{results:[payment()]}:payment();
  const first=await h.call('POST','/api/companies/me/deposit/verify',{depositId:'deposit1'});assert.equal(first.data.deposit.creditado,true);
  assert.equal(first.data.balance.saldo,115);await h.call('POST','/api/companies/me/deposit/verify',{depositId:'deposit1'});
  assert.equal(h.calls.length,2);
  const pending=setup();pending.context.provider=()=>({results:[]});await pending.call('POST','/api/companies/me/deposit/verify',{depositId:'deposit1'});await pending.call('POST','/api/companies/me/deposit/verify',{depositId:'deposit1'});assert.equal(pending.calls.length,1);
});
test('simultaneous retries with the same company request create one preference; another value cannot change an existing checkout',async()=>{
  const h=setup(), body={valor:30,requestId:'12345678-1234-1234-1234-123456789012'};
  const results=await Promise.all([h.call('POST','/api/companies/deposit-preference',body),h.call('POST','/api/companies/deposit-preference',body)]);
  assert.equal(h.calls.filter(item=>item.preference).length,1);assert.ok(results.some(result=>result.status===201));
  const repeat=await h.call('POST','/api/companies/deposit-preference',body);assert.equal(repeat.data.reused,true);
  const changed=await h.call('POST','/api/companies/deposit-preference',{...body,valor:100});assert.equal(changed.status,409);
  assert.equal(h.records.get(`empresas/${companyId}`).saldo,20);
});
