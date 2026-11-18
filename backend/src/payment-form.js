// Como o cliente pagou a corrida (o dono ve na lista): Pix, cartao de credito/debito,
// saldo do Mercado Pago ou boleto. Vem do pagamento do Mercado Pago (payment_type_id).
export function mpPaymentForm(payment = {}) {
  const method = String(payment?.payment_method_id || '').toLowerCase().slice(0, 30);
  const type = String(payment?.payment_type_id || '').toLowerCase();
  const final = String(payment?.card?.last_four_digits || '').replace(/\D/g, '').slice(-4);
  let forma = '';
  if (method === 'pix' || type === 'bank_transfer') forma = 'pix';
  else if (type === 'credit_card') forma = 'cartao_credito';
  else if (type === 'debit_card' || type === 'prepaid_card') forma = 'cartao_debito';
  else if (type === 'account_money') forma = 'saldo_mercadopago';
  else if (type === 'ticket') forma = 'boleto';
  else if (type || method) forma = 'outro';
  const out = {};
  if (forma) out.forma = forma;
  if (forma.startsWith('cartao') && /^[a-z0-9_]+$/.test(method)) out.bandeira = method;
  if (final) out.cartaoFinal = final;
  return out;
}
