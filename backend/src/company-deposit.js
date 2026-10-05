// Only provider-fetched payments can reach the accounting transaction.
const digits = value => String(value || '').replace(/\D/g, '');
const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
function fail(code, message) { const error = new Error(message); error.code = code; error.status = 409; throw error; }

export function safeDepositCheckout(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && ['www.mercadopago.com.br', 'www.mercadopago.com', 'mercadopago.com.br', 'mercadopago.com'].includes(url.hostname)
      && url.pathname.startsWith('/checkout/') ? url.href : '';
  } catch { return ''; }
}

export function assertDepositPayment(payment, depositId, source = 'owner') {
  if (!/^[\w-]{1,100}$/.test(depositId) || !/^\d+$/.test(String(payment.id || '')))
    fail('deposito_mercadopago_nao_autentico', 'Pagamento inválido.');
  if (source !== 'owner' || payment.metadata?.payment_kind !== 'company_deposit'
    || payment.external_reference !== `deposit:${depositId}` || payment.metadata?.deposit_id !== depositId
    || String(payment.currency_id || '').toUpperCase() !== 'BRL')
    fail('deposito_mercadopago_nao_autentico', 'Pagamento não corresponde à recarga.');
}

export function assertDepositCompany(payment, deposit, companyId) {
  if (deposit.metodo !== 'mercadopago' || digits(payment.metadata?.company_id) !== companyId)
    fail('deposito_empresa_divergente', 'Pagamento não pertence a esta empresa.');
  if ((deposit.aprovadoEm || deposit.creditoEstornadoEm || deposit.status === 'aprovado')
    && deposit.mercadoPago?.paymentId && String(deposit.mercadoPago.paymentId) !== String(payment.id))
    fail('deposito_pagamento_adicional', 'Outra cobrança desta recarga precisa ser conferida pelo suporte.');
}

export function depositPaymentAmounts(payment) {
  const gross = Number(payment.transaction_amount);
  const fees = Array.isArray(payment.fee_details)
    ? payment.fee_details.reduce((sum, fee) => sum + Number(fee.amount || 0), 0)
    : Number(payment.marketplace_fee || 0);
  const rawNet = payment.transaction_details?.net_received_amount;
  const net = rawNet !== undefined && rawNet !== null ? Number(rawNet) : gross - fees;
  if (![gross, fees, net].every(Number.isFinite) || gross <= 0 || fees < 0 || net < 0 || net > gross + 0.01)
    fail('deposito_valores_invalidos', 'Não foi possível conferir os valores do pagamento.');
  return { totalPago: money(gross), taxaMercadoPago: money(gross - net), valorLiquido: money(net) };
}

export function companyDepositView(id, deposit = {}) {
  const paid = !!deposit.aprovadoEm || deposit.status === 'aprovado';
  const reversed = !!deposit.creditoEstornadoEm || deposit.status === 'credito_estornado';
  return {
    id, status: reversed ? 'credito_estornado' : paid ? 'aprovado' : deposit.status || 'aguardando_pagamento',
    valor: Number(deposit.valor || 0), valorBruto: Number(deposit.valorBruto ?? deposit.mercadoPago?.totalPago ?? 0),
    taxaMercadoPago: Number(deposit.taxaMercadoPago ?? deposit.mercadoPago?.taxaMercadoPago ?? 0),
    valorCreditado: Number(deposit.valorCreditado || 0),
    checkoutUrl: !paid && !reversed ? safeDepositCheckout(deposit.mercadoPago?.initPoint) : '',
    creditado: paid && !reversed
  };
}
