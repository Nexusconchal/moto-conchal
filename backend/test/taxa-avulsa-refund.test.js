import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,companyId} from './financial-harness.js';
const job=(extra={})=>({tipo:'entrega_empresarial',status:'pendente',empresaId:companyId,telefoneEmpresa:companyId,paradas:2,valor:13,saldoReservado:13,
  tipoEntrega:'Lanche / pizza / pastel / marmita',taxaAvulsaContada:2,taxaAvulsaCiclo:1,...extra});
function setup(company,delivery) {
  const h=harness({[`empresas/${companyId}`]:company,'entregas/d':delivery});
  h.fn('releaseDeliveryReservation');
  return h;
}
test('cancelling a taxa avulsa delivery gives the deliveries back once, in the same cycle',async()=>{
  const h=setup({saldo:100,reservado:13,taxaAvulsaUsadas:5,taxaAvulsaCiclo:1},job());
  await h.context.releaseDeliveryReservation(h.ref('entregas/d'),'cancelada');
  assert.equal(h.records.get(`empresas/${companyId}`).taxaAvulsaUsadas,3);
  assert.equal(h.records.get(`empresas/${companyId}`).reservado,0);
  await h.context.releaseDeliveryReservation(h.ref('entregas/d'),'cancelada');
  assert.equal(h.records.get(`empresas/${companyId}`).taxaAvulsaUsadas,3);
});
test('expired deliveries keep the count; a cancel after a plan reset does not give extra deliveries',async()=>{
  const expired=setup({saldo:100,reservado:13,taxaAvulsaUsadas:5,taxaAvulsaCiclo:1},job());
  await expired.context.releaseDeliveryReservation(expired.ref('entregas/d'),'expirada');
  assert.equal(expired.records.get(`empresas/${companyId}`).taxaAvulsaUsadas,5);
  // Expired then cancelled (balance already released): still refunds in the same cycle.
  await expired.context.releaseDeliveryReservation(expired.ref('entregas/d'),'cancelada');
  assert.equal(expired.records.get(`empresas/${companyId}`).taxaAvulsaUsadas,3);
  const reset=setup({saldo:100,reservado:13,taxaAvulsaUsadas:1,taxaAvulsaCiclo:2},job());
  await reset.context.releaseDeliveryReservation(reset.ref('entregas/d'),'cancelada');
  assert.equal(reset.records.get(`empresas/${companyId}`).taxaAvulsaUsadas,1);
});
