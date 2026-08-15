// services/mercadopago.js
// Integracao com Mercado Pago para gerar cobranca Pix e fazer o split (comissao x repasse motoboy).
//
// IMPORTANTE SOBRE O SPLIT:
// O Mercado Pago oferece split "nativo" apenas via API de Marketplace/Split de Pagamentos,
// que exige que CADA motoboy tenha uma conta Mercado Pago propria conectada via OAuth
// (application_fee no momento da criacao do pagamento). Isso e o ideal a longo prazo.
//
// Para o MVP do Moto Conchal (mais simples e rapido de operar), este arquivo implementa
// o modelo "Split Financeiro Manual Assistido":
//   1. O cliente paga o valor INTEGRO da corrida para a conta Mercado Pago da EMPRESA (Moto Conchal).
//   2. O sistema calcula automaticamente comissao_centavos e repasse_centavos e grava na tabela `repasses`.
//   3. O repasse ao motoboy e feito via Pix (chave pix cadastrada do motoboy) - pode ser automatizado
//      depois com a API de Pix Out do Mercado Pago/Asaas, ou feito manualmente pelo operador a partir
//      do painel administrativo (rota /admin/repasses).
//
// Ambos os caminhos (nativo com application_fee, ou financeiro assistido) estao documentados abaixo.
// Trocar de Mercado Pago para Asaas exige apenas reescrever este arquivo — as rotas do server nao mudam.

const fetch = require('node-fetch');
require('dotenv').config();

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_API_BASE = 'https://api.mercadopago.com';

/**
 * Cria uma cobranca Pix no Mercado Pago para uma corrida.
 * @param {object} params
 * @param {string} params.corridaId
 * @param {number} params.valorCentavos
 * @param {string} params.clienteNome
 * @param {string} params.clienteEmail - Mercado Pago exige email no payer (pode ser um email genérico)
 * @param {string} params.clienteCpf - opcional, melhora aprovação
 */
async function criarCobrancaPix({ corridaId, valorCentavos, clienteNome, clienteEmail, clienteCpf }) {
  const valorReais = Number((valorCentavos / 100).toFixed(2));

  const body = {
    transaction_amount: valorReais,
    description: `Corrida Moto Conchal #${corridaId.slice(0, 8)}`,
    payment_method_id: 'pix',
    payer: {
      email: clienteEmail || 'cliente@motoconchal.com.br',
      first_name: clienteNome?.split(' ')[0] || 'Cliente',
      last_name: clienteNome?.split(' ').slice(1).join(' ') || 'MotoConchal',
      ...(clienteCpf ? { identification: { type: 'CPF', number: clienteCpf } } : {}),
    },
    // notification_url -> onde o Mercado Pago vai chamar nosso webhook quando o Pix for pago
    notification_url: `${process.env.BASE_URL}/api/webhook/mercadopago`,
    external_reference: corridaId, // usamos para casar o pagamento com a corrida no webhook
  };

  const resp = await fetch(`${MP_API_BASE}/v1/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      // Chave de idempotencia evita cobranca duplicada em caso de retry de rede
      'X-Idempotency-Key': `corrida-${corridaId}`,
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json();

  if (!resp.ok) {
    console.error('Erro ao criar cobrança Pix no Mercado Pago:', data);
    throw new Error(data.message || 'Falha ao criar cobrança Pix.');
  }

  const pointOfInteraction = data.point_of_interaction?.transaction_data;

  return {
    paymentId: String(data.id),
    status: data.status, // 'pending' normalmente
    qrCode: pointOfInteraction?.qr_code,             // copia e cola
    qrCodeBase64: pointOfInteraction?.qr_code_base64, // imagem em base64 (PNG)
    ticketUrl: pointOfInteraction?.ticket_url,
  };
}

/**
 * Consulta o status atual de um pagamento (usado como fallback/confirmação, além do webhook).
 */
async function consultarPagamento(paymentId) {
  const resp = await fetch(`${MP_API_BASE}/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
  });
  if (!resp.ok) throw new Error('Falha ao consultar pagamento no Mercado Pago.');
  return resp.json();
}

/**
 * Calcula o split financeiro (comissão da plataforma x repasse do motoboy).
 * Não move dinheiro sozinho no modelo assistido — apenas calcula os valores
 * que serão gravados na tabela `repasses` para pagamento manual/automatizado depois.
 */
function calcularSplit(valorCentavos) {
  const percentual = Number(process.env.PLATAFORMA_COMISSAO_PERCENTUAL || 0.2);
  const comissao_centavos = Math.round(valorCentavos * percentual);
  const repasse_centavos = valorCentavos - comissao_centavos;
  return { percentual, comissao_centavos, repasse_centavos };
}

module.exports = {
  criarCobrancaPix,
  consultarPagamento,
  calcularSplit,
};
