// services/whatsapp.js
// Integracao com Evolution API (mesma stack usada no VoltaCliente Conchal).
// Responsavel por:
//   1) Enviar a corrida PAGA para o WhatsApp da CENTRAL, pedindo validacao humana.
//   2) Enviar a corrida APROVADA para o grupo oficial dos motoboys.

const fetch = require('node-fetch');
require('dotenv').config();

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE;
const WHATSAPP_CENTRAL_NUMERO = process.env.WHATSAPP_CENTRAL_NUMERO;
const WHATSAPP_GRUPO_MOTOBOYS_ID = process.env.WHATSAPP_GRUPO_MOTOBOYS_ID;

async function enviarMensagemTexto(numeroOuGrupoId, texto) {
  const url = `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: EVOLUTION_API_KEY,
    },
    body: JSON.stringify({
      number: numeroOuGrupoId,
      text: texto,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error('Erro ao enviar mensagem WhatsApp:', errText);
    throw new Error('Falha ao enviar mensagem via Evolution API.');
  }

  return resp.json();
}

/**
 * PASSO CRUCIAL DO ANTI-FRAUDE.
 * Envia para a CENTRAL os dados da corrida recem-paga, para um atendente humano
 * conferir se a distância informada bate com o trajeto real, ANTES de liberar
 * para os motoboys. Inclui o link direto do painel para aprovar/rejeitar.
 */
async function notificarCentralParaValidacao(corrida) {
  const linkPainel = `${process.env.BASE_URL.replace('/api', '')}/admin/#corrida-${corrida.id}`;

  const texto =
    `🔔 *NOVA CORRIDA PAGA - VALIDAR* 🔔\n\n` +
    `*Cliente:* ${corrida.cliente_nome}\n` +
    `*Tel:* ${corrida.cliente_telefone}\n\n` +
    `*Origem:* ${corrida.origem_endereco}\n` +
    `*Destino:* ${corrida.destino_endereco}\n\n` +
    `*Distância informada pelo cliente:* ${corrida.distancia_km} km\n` +
    `*Faixa cobrada:* ${corrida.faixa_km}\n` +
    `*Valor PAGO:* R$ ${(corrida.valor_centavos / 100).toFixed(2)}\n\n` +
    (corrida.observacoes ? `*Obs:* ${corrida.observacoes}\n\n` : '') +
    `⚠️ Confira se a distância real bate com o valor pago antes de liberar!\n\n` +
    `✅ Para APROVAR, responda:\n*APROVAR ${corrida.id.slice(0, 8)}*\n\n` +
    `❌ Para REJEITAR (endereço não bate / suspeita), responda:\n*REJEITAR ${corrida.id.slice(0, 8)} <motivo>*\n\n` +
    `Ou acesse o painel: ${linkPainel}`;

  return enviarMensagemTexto(WHATSAPP_CENTRAL_NUMERO, texto);
}

/**
 * Envia a corrida já APROVADA pelo atendente para o grupo oficial de motoboys.
 */
async function despacharParaGrupoMotoboys(corrida) {
  const texto =
    `🏍️ *CORRIDA DISPONÍVEL* 🏍️\n\n` +
    `*Origem:* ${corrida.origem_endereco}\n` +
    `*Destino:* ${corrida.destino_endereco}\n` +
    `*Distância aprox.:* ${corrida.distancia_km} km\n` +
    `*Valor da corrida:* R$ ${(corrida.valor_centavos / 100).toFixed(2)}\n\n` +
    `💰 Pagamento já confirmado via Pix — corrida garantida, sem calote!\n\n` +
    `Responda *ACEITAR ${corrida.id.slice(0, 8)}* para pegar essa corrida.`;

  return enviarMensagemTexto(WHATSAPP_GRUPO_MOTOBOYS_ID, texto);
}

/**
 * Notifica o cliente sobre o andamento da corrida (opcional, mas melhora a experiência).
 */
async function notificarCliente(corrida, mensagem) {
  return enviarMensagemTexto(corrida.cliente_telefone, mensagem);
}

module.exports = {
  notificarCentralParaValidacao,
  despacharParaGrupoMotoboys,
  notificarCliente,
  enviarMensagemTexto,
};
