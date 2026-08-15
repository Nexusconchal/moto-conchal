// routes/webhook.js
// Recebe a notificação do Mercado Pago quando o Pix é pago.
// Regra de ouro do sistema: ESTE WEBHOOK NUNCA DESPACHA A CORRIDA DIRETO PARA OS MOTOBOYS.
// Ele apenas muda o status para PAID e aciona a notificação da CENTRAL para validação humana.

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const mp = require('../services/mercadopago');
const whatsapp = require('../services/whatsapp');

function registrarEvento(corridaId, statusAnterior, statusNovo, ator, detalhe = null) {
  db.prepare(
    `INSERT INTO corrida_eventos (corrida_id, status_anterior, status_novo, ator, detalhe)
     VALUES (?, ?, ?, ?, ?)`
  ).run(corridaId, statusAnterior, statusNovo, ator, detalhe);
}

// POST /api/webhook/mercadopago
router.post('/mercadopago', async (req, res) => {
  try {
    // O Mercado Pago manda notificações de vários tipos (payment, merchant_order, etc).
    // Respondemos 200 rápido para qualquer coisa que não seja 'payment' e ignoramos.
    const { type, data, action } = req.body;

    // Responde IMEDIATAMENTE 200 pro Mercado Pago não ficar reenviando (boas práticas de webhook).
    res.status(200).json({ recebido: true });

    const isPaymentEvent = type === 'payment' || action === 'payment.updated' || action === 'payment.created';
    if (!isPaymentEvent || !data?.id) return;

    // Consulta o pagamento completo na API do MP (o webhook só manda o ID, nunca confiamos só no payload)
    const pagamento = await mp.consultarPagamento(data.id);

    if (pagamento.status !== 'approved') {
      console.log(`Webhook: pagamento ${data.id} com status ${pagamento.status} (ainda não aprovado).`);
      return;
    }

    const corridaId = pagamento.external_reference;
    if (!corridaId) {
      console.warn('Webhook: pagamento aprovado sem external_reference (corrida_id).');
      return;
    }

    const corrida = db.prepare('SELECT * FROM corridas WHERE id = ?').get(corridaId);
    if (!corrida) {
      console.warn(`Webhook: corrida ${corridaId} não encontrada.`);
      return;
    }

    // Idempotência: se já processamos esse pagamento antes, não faz nada de novo
    if (corrida.status !== 'PENDING') {
      console.log(`Webhook: corrida ${corridaId} já está em status ${corrida.status}, ignorando.`);
      return;
    }

    // Confere se o valor pago bate com o valor esperado (proteção extra contra manipulação)
    const valorPagoCentavos = Math.round(pagamento.transaction_amount * 100);
    if (valorPagoCentavos < corrida.valor_centavos) {
      console.warn(`Webhook: valor pago (${valorPagoCentavos}) menor que o esperado (${corrida.valor_centavos}) para corrida ${corridaId}.`);
      // Não libera - fica pendente para análise manual da central via painel
      return;
    }

    // 1) Marca como PAID (aguardando validação humana)
    db.prepare(
      `UPDATE corridas SET status = 'PAID', pago_em = datetime('now','localtime'), atualizado_em = datetime('now','localtime')
       WHERE id = ?`
    ).run(corridaId);
    registrarEvento(corridaId, 'PENDING', 'PAID', 'webhook_mp', `Pagamento aprovado. payment_id=${data.id}`);

    console.log(`✅ Corrida ${corridaId} PAGA. Enviando para validação humana da central...`);

    // 2) Envia para a CENTRAL no WhatsApp para validação humana (NUNCA despacha automático)
    const corridaAtualizada = db.prepare('SELECT * FROM corridas WHERE id = ?').get(corridaId);
    await whatsapp.notificarCentralParaValidacao(corridaAtualizada);
  } catch (err) {
    console.error('Erro ao processar webhook do Mercado Pago:', err);
    // Já respondemos 200 antes, então só logamos - o MP não vai reenviar por causa disso.
    // Importante monitorar esses logs para não perder nenhuma corrida paga.
  }
});

module.exports = router;
