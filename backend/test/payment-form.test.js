import test from 'node:test';
import assert from 'node:assert/strict';
import { mpPaymentForm } from '../src/payment-form.js';

test('o dono ve se a corrida foi paga por Pix, cartao de credito ou debito', () => {
  assert.deepEqual(mpPaymentForm({ payment_method_id: 'pix', payment_type_id: 'bank_transfer' }), { forma: 'pix' });
  assert.deepEqual(mpPaymentForm({ payment_method_id: 'master', payment_type_id: 'credit_card', card: { last_four_digits: '1234' } }),
    { forma: 'cartao_credito', bandeira: 'master', cartaoFinal: '1234' });
  assert.deepEqual(mpPaymentForm({ payment_method_id: 'debvisa', payment_type_id: 'debit_card' }), { forma: 'cartao_debito', bandeira: 'debvisa' });
  assert.deepEqual(mpPaymentForm({ payment_method_id: 'account_money', payment_type_id: 'account_money' }), { forma: 'saldo_mercadopago' });
  assert.deepEqual(mpPaymentForm({ payment_method_id: 'bolbradesco', payment_type_id: 'ticket' }), { forma: 'boleto' });
  // Pagamento sem os dados (ex.: pagamento antigo): nao inventa forma.
  assert.deepEqual(mpPaymentForm({}), {});
  assert.deepEqual(mpPaymentForm(null), {});
});
