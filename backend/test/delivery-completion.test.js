import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,companyId,driverCpf,source} from './financial-harness.js';
import {protectedDelivery,completionReason} from '../src/delivery-completion.js';
const initial=()=>({tipo:'entrega_empresarial',confirmacaoEmpresaVersao:1,status:'retirada',empresaId:companyId,telefoneEmpresa:companyId,
  motoboyCpf:driverCpf,motoboy:'Motorista',paradas:3,valor:19.5,saldoReservado:19.5,entregaNaNota:true,
  retiradaLiberadaEm:Date.now()-60000,retiradaConfirmadaEm:Date.now()-60000,motoboyLocalizacao:{serverTimestampMs:Date.now()}});
function setup(job=initial()) {
  const h=harness({[`empresas/${companyId}`]:{saldo:100,reservado:29.5},'entregas/d':job});
  h.fn('finishCompanyDelivery');h.fn('releaseDeliveryReservation');h.fn('emitCompletionChange');h.fn('contestCompanyDelivery');
  h.run("const deliveryConfirmationLimiter =",'async function finishCompanyDelivery(');
  h.run("app.post('/api/deliveries/:deliveryId/pickup'","\napp.post(");
  h.run("app.post('/api/admin/deliveries/:deliveryId/force-finish'",'const deliveryConfirmationLimiter =');
  return h;
}
test('server controls the new policy, excludes exclusive shifts and preserves existing delivery behavior',()=>{
  assert.ok(source.includes('delivery.confirmacaoEmpresaVersao = 1;'));
  assert.equal(protectedDelivery({}),false);assert.equal(protectedDelivery({confirmacaoEmpresaVersao:1,tipo:'servico_exclusivo'}),false);
  assert.throws(()=>completionReason('ok'));assert.throws(()=>completionReason('<img src=x onerror=foo()>'));
});
test('driver cannot self-authorize pickup; only the owning company approves it and duplicate clicks create one audit event',async()=>{
  const h=setup({...initial(),status:'aceita',retiradaLiberadaEm:null});
  await assert.rejects(h.call('POST','/api/deliveries/:deliveryId/pickup',{driverCpf}),/loja/);
  await assert.rejects(h.call('POST','/api/companies/me/deliveries/:deliveryId/confirm-pickup',{}, {companyId:'other'}),/conta/);
  await h.call('POST','/api/companies/me/deliveries/:deliveryId/confirm-pickup');
  const approved=h.records.get('entregas/d').retiradaLiberadaEm;
  await h.call('POST','/api/companies/me/deliveries/:deliveryId/confirm-pickup');assert.equal(h.records.get('entregas/d').retiradaLiberadaEm,approved);
  await h.call('POST','/api/deliveries/:deliveryId/pickup',{driverCpf});assert.equal(h.records.get('entregas/d').status,'retirada');
  assert.equal(h.records.get(`empresas/${companyId}`).saldo,100);
});
test('requesting completion holds money and earnings; retries do not reset evidence or produce extra financial writes',async()=>{
  const h=setup();const ref=h.ref('entregas/d');
  await assert.rejects(h.context.finishCompanyDelivery(ref,'different',{confirmarLoteEntregue:true}),/nao pertence/);
  const result=await h.context.finishCompanyDelivery(ref,driverCpf,{confirmarLoteEntregue:true});assert.equal(result.pendingApproval,true);
  assert.equal(h.records.get(`empresas/${companyId}`).saldo,100);assert.equal(h.records.get(`empresas/${companyId}`).reservado,29.5);
  assert.equal([...h.records.keys()].some(key=>key.startsWith('earnings/')),false);
  const submitted=h.records.get('entregas/d').conclusaoSolicitadaEm;
  await h.context.finishCompanyDelivery(ref,driverCpf,{confirmarLoteEntregue:true});assert.equal(h.records.get('entregas/d').conclusaoSolicitadaEm,submitted);
});
test('company approval records standard and daily batch shares once, preserving other reserved calls even on concurrent retries',async()=>{
  for(const daily of [false,true]) {
    const job={...initial(),...(daily?{valor:12,saldoReservado:12,tipoEntrega:'Plano Diario MotoJa Pro'}:{})};const h=setup(job);
    await h.context.finishCompanyDelivery(h.ref('entregas/d'),driverCpf,{confirmarLoteEntregue:true});
    h.records.set(`empresas/${companyId}`,{saldo:100,reservado:job.valor+10});
    await assert.rejects(h.call('POST','/api/companies/me/deliveries/:deliveryId/approve-completion',{}, {companyId:'other'}),/conta/);
    await Promise.all([h.call('POST','/api/companies/me/deliveries/:deliveryId/approve-completion'),h.call('POST','/api/companies/me/deliveries/:deliveryId/approve-completion')]);
    assert.equal(h.records.get(`empresas/${companyId}`).saldo,100-job.valor);assert.equal(h.records.get(`empresas/${companyId}`).reservado,10);
    assert.equal(h.records.get(`earnings/${driverCpf}/d`).ganho,daily?9:15);
    assert.equal([...h.records.keys()].filter(key=>key.startsWith('ledger/')).length,1);
  }
});
test('a contested delivery keeps its reserve and cannot be approved by the company or cancelled by the driver',async()=>{
  const h=setup();await h.context.contestCompanyDelivery(h.ref('entregas/d'),'Cliente não recebeu os pedidos',`empresa:${companyId}`,companyId);
  await assert.rejects(h.call('POST','/api/companies/me/deliveries/:deliveryId/approve-completion'),/Contestações/);
  await assert.rejects(h.context.releaseDeliveryReservation(h.ref('entregas/d'),'cancelada'),/reservado/);
  assert.equal(h.records.get(`empresas/${companyId}`).saldo,100);assert.equal(h.records.get(`empresas/${companyId}`).reservado,29.5);
});
test('owner can finish forgotten approval, debits the fixed reserved value once, and cannot alter price or finish again',async()=>{
  const h=setup({...initial(),conclusaoStatus:'aguardando_empresa'});
  await assert.rejects(h.call('POST','/api/admin/deliveries/:deliveryId/force-finish',{reason:'Entrega confirmada com ambas as partes',valor:1}),/valor reservado/);
  await h.call('POST','/api/admin/deliveries/:deliveryId/force-finish',{reason:'Entrega confirmada com ambas as partes',valor:19.5});
  assert.equal(h.records.get(`empresas/${companyId}`).saldo,80.5);assert.equal(h.records.get(`empresas/${companyId}`).reservado,10);
  assert.equal(h.records.get('entregas/d').conclusaoStatus,'resolvida_dono');assert.equal(h.records.get(`earnings/${driverCpf}/d`).ganho,15);
  await assert.rejects(h.call('POST','/api/admin/deliveries/:deliveryId/force-finish',{reason:'Entrega confirmada com ambas as partes'}),/ja foi/);
});
test('owner denial releases only the disputed reserve and never credits a driver; denied service cannot be charged later',async()=>{
  const h=setup({...initial(),conclusaoStatus:'contestada'});
  await h.call('POST','/api/admin/deliveries/:deliveryId/deny-completion',{reason:'Confirmado que os pedidos não foram entregues'});
  assert.equal(h.records.get(`empresas/${companyId}`).saldo,100);assert.equal(h.records.get(`empresas/${companyId}`).reservado,10);
  assert.equal([...h.records.keys()].some(key=>key.startsWith('earnings/')),false);
  await assert.rejects(h.call('POST','/api/admin/deliveries/:deliveryId/deny-completion',{reason:'Confirmado que os pedidos não foram entregues'}));
  await assert.rejects(h.call('POST','/api/admin/deliveries/:deliveryId/force-finish',{reason:'Outro pedido de conclusão'}),/disponível/);
});
test('approval cannot spend another reservation or a balance reduced by a payment reversal',async()=>{
  const h=setup({...initial(),conclusaoStatus:'aguardando_empresa'});h.records.set(`empresas/${companyId}`,{saldo:10,reservado:29.5});
  await assert.rejects(h.call('POST','/api/companies/me/deliveries/:deliveryId/approve-completion'),/reserva/);
  await assert.rejects(h.call('POST','/api/admin/deliveries/:deliveryId/force-finish',{reason:'Serviço confirmado pelo suporte'}),/Saldo/);
  assert.equal(h.records.get(`empresas/${companyId}`).saldo,10);
});
