// routes/admin.js
// Rotas usadas pelo PAINEL DO OPERADOR (atendente/gestor da central).
// Protegidas por um token simples via header 'x-admin-token' (troque por auth real em produção,
// ex: login com senha por atendente, JWT, etc).

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const whatsapp = require('../services/whatsapp');
const mp = require('../services/mercadopago');

function registrarEvento(corridaId, statusAnterior, statusNovo, ator, detalhe = null) {
  db.prepare(
    `INSERT INTO corrida_eventos (corrida_id, status_anterior, status_novo, ator, detalhe)
     VALUES (?, ?, ?, ?, ?)`
  ).run(corridaId, statusAnterior, statusNovo, ator, detalhe);
}

// Middleware simples de autenticação do painel
function checarAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ erro: 'Não autorizado.' });
  }
  next();
}
router.use(checarAdmin);

// GET /api/admin/corridas/fila -> corridas PAGAS aguardando validação humana
router.get('/corridas/fila', (req, res) => {
  const corridas = db
    .prepare(`SELECT * FROM corridas WHERE status = 'PAID' ORDER BY pago_em ASC`)
    .all();
  res.json({ corridas });
});

// GET /api/admin/corridas -> lista geral (com filtro opcional de status) p/ dashboard
router.get('/corridas', (req, res) => {
  const { status } = req.query;
  const corridas = status
    ? db.prepare(`SELECT * FROM corridas WHERE status = ? ORDER BY criado_em DESC LIMIT 200`).all(status)
    : db.prepare(`SELECT * FROM corridas ORDER BY criado_em DESC LIMIT 200`).all();
  res.json({ corridas });
});

// POST /api/admin/corridas/:id/aprovar
// >>> ESTE É O PASSO HUMANO CRUCIAL <<<
// O atendente confirma que a distância/endereço bate com o valor pago e libera a corrida.
router.post('/corridas/:id/aprovar', async (req, res) => {
  try {
    const { atendente } = req.body; // nome ou telefone de quem aprovou (auditoria)
    const corrida = db.prepare('SELECT * FROM corridas WHERE id = ?').get(req.params.id);

    if (!corrida) return res.status(404).json({ erro: 'Corrida não encontrada.' });
    if (corrida.status !== 'PAID') {
      return res.status(400).json({ erro: `Corrida está em status ${corrida.status}, só pode aprovar corridas PAID.` });
    }

    db.prepare(
      `UPDATE corridas SET status = 'APPROVED', validado_por = ?, validado_em = datetime('now','localtime'),
       atualizado_em = datetime('now','localtime') WHERE id = ?`
    ).run(atendente || 'atendente', corrida.id);
    registrarEvento(corrida.id, 'PAID', 'APPROVED', atendente || 'atendente', 'Validação humana: dados conferem.');

    // Calcula o split (comissão x repasse) agora que a corrida foi validada
    const { percentual, comissao_centavos, repasse_centavos } = mp.calcularSplit(corrida.valor_centavos);
    db.prepare(
      `INSERT INTO repasses (id, corrida_id, valor_total_centavos, comissao_percentual, comissao_centavos, repasse_centavos)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(uuidv4(), corrida.id, corrida.valor_centavos, percentual, comissao_centavos, repasse_centavos);

    // Despacha para o grupo oficial dos motoboys
    const corridaAtualizada = db.prepare('SELECT * FROM corridas WHERE id = ?').get(corrida.id);
    await whatsapp.despacharParaGrupoMotoboys(corridaAtualizada);

    db.prepare(
      `UPDATE corridas SET status = 'DISPATCHED', atualizado_em = datetime('now','localtime') WHERE id = ?`
    ).run(corrida.id);
    registrarEvento(corrida.id, 'APPROVED', 'DISPATCHED', 'sistema', 'Enviado ao grupo de motoboys no WhatsApp.');

    // Avisa o cliente (opcional)
    await whatsapp
      .notificarCliente(corridaAtualizada, `✅ Seu pagamento foi confirmado e sua corrida já foi liberada! Um motoboy vai aceitar em instantes.`)
      .catch(() => {});

    res.json({ ok: true, status: 'DISPATCHED' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao aprovar corrida.', detalhe: err.message });
  }
});

// POST /api/admin/corridas/:id/rejeitar
// Usado quando o atendente percebe que a distância informada não bate com o valor pago
// (ex: cliente disse 2km mas o endereço real é 10km) -> corrida NÃO é despachada.
router.post('/corridas/:id/rejeitar', async (req, res) => {
  try {
    const { atendente, motivo } = req.body;
    const corrida = db.prepare('SELECT * FROM corridas WHERE id = ?').get(req.params.id);

    if (!corrida) return res.status(404).json({ erro: 'Corrida não encontrada.' });
    if (corrida.status !== 'PAID') {
      return res.status(400).json({ erro: `Corrida está em status ${corrida.status}, só pode rejeitar corridas PAID.` });
    }

    db.prepare(
      `UPDATE corridas SET status = 'REJECTED', validado_por = ?, validado_em = datetime('now','localtime'),
       motivo_rejeicao = ?, atualizado_em = datetime('now','localtime') WHERE id = ?`
    ).run(atendente || 'atendente', motivo || 'Distância/endereço não confere com o valor pago.', corrida.id);
    registrarEvento(corrida.id, 'PAID', 'REJECTED', atendente || 'atendente', motivo);

    const corridaAtualizada = db.prepare('SELECT * FROM corridas WHERE id = ?').get(corrida.id);

    // Avisa o cliente que a corrida foi recusada e que o estorno será feito
    // (o estorno em si deve ser processado manualmente no painel do Mercado Pago,
    // ou automatizado depois via API de refunds: POST /v1/payments/:id/refunds)
    await whatsapp
      .notificarCliente(
        corridaAtualizada,
        `⚠️ Identificamos uma divergência entre a distância informada e o endereço da corrida.\n` +
          `Nossa equipe vai entrar em contato para ajustar o valor ou estornar o pagamento.\nMotivo: ${motivo || 'a confirmar'}`
      )
      .catch(() => {});

    res.json({ ok: true, status: 'REJECTED' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao rejeitar corrida.', detalhe: err.message });
  }
});

// GET /api/admin/corridas/:id/eventos -> histórico/auditoria de uma corrida
router.get('/corridas/:id/eventos', (req, res) => {
  const eventos = db
    .prepare('SELECT * FROM corrida_eventos WHERE corrida_id = ? ORDER BY criado_em ASC')
    .all(req.params.id);
  res.json({ eventos });
});

// GET /api/admin/repasses -> valores a pagar/pagos aos motoboys
router.get('/repasses', (req, res) => {
  const repasses = db
    .prepare(
      `SELECT r.*, c.cliente_nome, c.origem_endereco, c.destino_endereco
       FROM repasses r JOIN corridas c ON c.id = r.corrida_id
       ORDER BY r.criado_em DESC LIMIT 200`
    )
    .all();
  res.json({ repasses });
});

module.exports = router;
