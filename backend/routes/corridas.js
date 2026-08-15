// routes/corridas.js
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const pricing = require('../services/pricing');
const mp = require('../services/mercadopago');

function registrarEvento(corridaId, statusAnterior, statusNovo, ator, detalhe = null) {
  db.prepare(
    `INSERT INTO corrida_eventos (corrida_id, status_anterior, status_novo, ator, detalhe)
     VALUES (?, ?, ?, ?, ?)`
  ).run(corridaId, statusAnterior, statusNovo, ator, detalhe);
}

// GET /api/corridas/faixas -> tabela de preços para o front exibir
router.get('/faixas', (req, res) => {
  res.json({ faixas: pricing.listarFaixas() });
});

// POST /api/corridas -> cria a corrida (status PENDING) + gera a cobrança Pix
router.post('/', async (req, res) => {
  try {
    const {
      cliente_nome,
      cliente_telefone,
      origem_endereco,
      destino_endereco,
      distancia_km,
      observacoes,
      cliente_email,
      cliente_cpf,
    } = req.body;

    if (!cliente_nome || !cliente_telefone || !origem_endereco || !destino_endereco || !distancia_km) {
      return res.status(400).json({ erro: 'Preencha todos os campos obrigatórios.' });
    }

    const distKm = Number(distancia_km);
    if (isNaN(distKm) || distKm <= 0) {
      return res.status(400).json({ erro: 'Distância inválida.' });
    }

    const { faixa, valor_centavos } = pricing.calcularValorCorrida(distKm);
    const id = uuidv4();

    db.prepare(
      `INSERT INTO corridas
        (id, cliente_nome, cliente_telefone, origem_endereco, destino_endereco,
         distancia_km, faixa_km, valor_centavos, observacoes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`
    ).run(id, cliente_nome, cliente_telefone, origem_endereco, destino_endereco, distKm, faixa, valor_centavos, observacoes || null);

    registrarEvento(id, null, 'PENDING', 'sistema', 'Corrida criada pelo cliente no app.');

    // Gera a cobrança Pix no Mercado Pago
    const cobranca = await mp.criarCobrancaPix({
      corridaId: id,
      valorCentavos: valor_centavos,
      clienteNome: cliente_nome,
      clienteEmail: cliente_email,
      clienteCpf: cliente_cpf,
    });

    db.prepare(
      `UPDATE corridas SET pix_payment_id = ?, pix_qr_code = ?, pix_qr_code_base64 = ?, atualizado_em = datetime('now','localtime')
       WHERE id = ?`
    ).run(cobranca.paymentId, cobranca.qrCode, cobranca.qrCodeBase64, id);

    res.status(201).json({
      corrida_id: id,
      faixa_km: faixa,
      valor_centavos,
      valor_reais: pricing.centavosParaReais(valor_centavos),
      pix: {
        qr_code: cobranca.qrCode,
        qr_code_base64: cobranca.qrCodeBase64,
        payment_id: cobranca.paymentId,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao criar corrida.', detalhe: err.message });
  }
});

// GET /api/corridas/:id -> usado pelo app do cliente para fazer polling do status
router.get('/:id', (req, res) => {
  const corrida = db.prepare('SELECT * FROM corridas WHERE id = ?').get(req.params.id);
  if (!corrida) return res.status(404).json({ erro: 'Corrida não encontrada.' });

  // Não expor dados sensíveis internos ao cliente (ex: quem validou)
  const { pix_qr_code_base64, validado_por, motivo_rejeicao, ...publico } = corrida;
  res.json({
    ...publico,
    pix_qr_code_base64: corrida.status === 'PENDING' ? pix_qr_code_base64 : undefined,
    motivo_rejeicao: corrida.status === 'REJECTED' ? motivo_rejeicao : undefined,
  });
});

module.exports = router;
