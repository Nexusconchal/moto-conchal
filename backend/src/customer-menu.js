import crypto from 'node:crypto';

// Funcoes do menu do cliente: lista publica de motoboys e programa "Indique e ganhe".
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

// Identificador publico do motoboy (nunca o CPF).
export function publicDriverId(cpf) {
  return hash(`motoboy-publico:${cpf}`).slice(0, 20);
}

// Nome curto: primeiro nome + inicial do sobrenome ("Rafael S.").
export function shortName(nome = '') {
  const parts = String(nome).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Motoboy';
  const cap = (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  const last = parts.length > 1 ? parts[parts.length - 1] : '';
  return last ? `${cap(parts[0])} ${last.charAt(0).toUpperCase()}.` : cap(parts[0]);
}

// O que o cliente ve de cada motoboy: sem telefone, CPF, CNH ou placa.
export function publicDriverCard(cpf, data = {}, presence = {}) {
  const total = Math.max(0, Number(data.notaQtd || 0));
  const media = total ? Math.round((Number(data.notaSoma || 0) / total) * 10) / 10 : 0;
  const cidades = data.cidadesAtivas || {};
  return {
    id: publicDriverId(cpf),
    nome: shortName(data.nome),
    moto: String(data.motoModelo || '').slice(0, 40),
    temFoto: !!data.fotoMotoboy,
    media,
    avaliacoes: total,
    online: presence.available === true,
    cidades: ['conchal', 'aguai', 'engenheiro_coelho'].filter((city) => city === 'conchal' ? cidades.conchal !== false : cidades[city] === true)
  };
}

// Ordem da lista: online primeiro, depois melhor media e mais avaliacoes.
export function sortPublicDrivers(cards = []) {
  return [...cards].sort((a, b) => Number(b.online) - Number(a.online) || b.media - a.media || b.avaliacoes - a.avaliacoes || a.nome.localeCompare(b.nome, 'pt-BR'));
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// Codigo de indicacao do cliente (6 letras/numeros, sem 0/O/1/I para nao confundir).
export function referralCode(customerId, attempt = 0) {
  const digest = hash(`indicacao:${customerId}:${attempt}`);
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[parseInt(digest.slice(i * 2, i * 2 + 2), 16) % CODE_ALPHABET.length];
  return code;
}

export function normalizeReferralCode(value) {
  const code = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-HJ-NP-Z2-9]{6}$/.test(code) ? code : '';
}

export function monthKey(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}`;
}
