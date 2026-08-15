// db/database.js
// Conexao SQLite + criacao automatica das tabelas.
// Troque facilmente para PostgreSQL depois (ex: usando 'pg') mantendo as mesmas queries em SQL padrao.

const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

const dbFile = process.env.DB_FILE || path.join(__dirname, 'moto_conchal.sqlite');
const db = new Database(dbFile);

db.pragma('journal_mode = WAL');

// ==================== TABELA: corridas ====================
// status possiveis (maquina de estados):
// PENDING            -> corrida criada, aguardando pagamento
// PAID               -> pix pago (webhook confirmado), aguardando VALIDACAO HUMANA na central
// REJECTED           -> atendente recusou (dado incoerente / possivel fraude) -> estorno manual
// APPROVED           -> atendente validou o trajeto/valor, corrida liberada para o grupo
// DISPATCHED         -> corrida enviada ao grupo oficial de motoboys no WhatsApp
// ACCEPTED           -> um motoboy aceitou a corrida
// COMPLETED          -> corrida finalizada
// CANCELLED          -> cancelada (timeout, cliente desistiu, etc.)

db.exec(`
CREATE TABLE IF NOT EXISTS corridas (
  id TEXT PRIMARY KEY,
  cliente_nome TEXT NOT NULL,
  cliente_telefone TEXT NOT NULL,
  origem_endereco TEXT NOT NULL,
  destino_endereco TEXT NOT NULL,
  distancia_km REAL NOT NULL,
  faixa_km TEXT NOT NULL,          -- '2km' | '4km' | '5km' | 'acima_5km'
  valor_centavos INTEGER NOT NULL,
  observacoes TEXT,

  status TEXT NOT NULL DEFAULT 'PENDING',

  pix_payment_id TEXT,             -- id da cobranca no Mercado Pago
  pix_qr_code TEXT,                -- copia e cola
  pix_qr_code_base64 TEXT,         -- imagem do QR
  pago_em TEXT,

  validado_por TEXT,               -- nome/telefone do atendente que aprovou/rejeitou
  validado_em TEXT,
  motivo_rejeicao TEXT,

  motoboy_id TEXT,
  aceito_em TEXT,
  finalizado_em TEXT,

  criado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS motoboys (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  telefone TEXT NOT NULL,
  chave_pix TEXT,                  -- usada no repasse (split)
  mp_collector_id TEXT,            -- id da conta Mercado Pago do motoboy (se usar split nativo do MP)
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS repasses (
  id TEXT PRIMARY KEY,
  corrida_id TEXT NOT NULL REFERENCES corridas(id),
  motoboy_id TEXT REFERENCES motoboys(id),
  valor_total_centavos INTEGER NOT NULL,
  comissao_percentual REAL NOT NULL,
  comissao_centavos INTEGER NOT NULL,
  repasse_centavos INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDENTE', -- PENDENTE | PAGO
  criado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
`);

// Log de auditoria: toda mudanca de status fica registrada (essencial p/ disputa de fraude)
db.exec(`
CREATE TABLE IF NOT EXISTS corrida_eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  corrida_id TEXT NOT NULL REFERENCES corridas(id),
  status_anterior TEXT,
  status_novo TEXT NOT NULL,
  ator TEXT,                      -- 'sistema' | 'webhook_mp' | telefone/nome do atendente
  detalhe TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
`);

module.exports = db;
