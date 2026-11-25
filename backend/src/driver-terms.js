// Termo do Motoboy Parceiro (motoboy-termo.html): versao atual, se o motoboy ja aceitou e o
// registro do aceite, que serve de prova (data, versao, IP e aparelho).
// Mudou o texto? Troque a versao aqui e em motoboy-termo.html: todo motoboy aceita de novo.
export const DRIVER_TERMS_VERSION = '2026-11-25-v2';
export const DRIVER_TERMS_URL = 'motoboy-termo.html';

// Prazo para quem ja e cadastrado: aceita ate domingo, 29/11/2026. Ate la ele trabalha normal e o
// app mostra o aviso com o prazo; a partir de segunda 30/11 00:00 (Brasilia) so trabalha quem aceitou
// (o app nao deixa ficar Disponivel e o servidor recusa aceitar corrida ou entrega).
export const DRIVER_TERMS_REQUIRED_FROM = Date.parse('2026-11-30T03:00:00Z');

export function driverTermsAccepted(driver = {}) {
  return String(driver?.termoVersao || '') === DRIVER_TERMS_VERSION;
}

export function driverTermsStatus(driver = {}, now = Date.now()) {
  const status = {
    versao: DRIVER_TERMS_VERSION,
    aceito: driverTermsAccepted(driver),
    url: DRIVER_TERMS_URL,
    prazoMs: DRIVER_TERMS_REQUIRED_FROM,
    obrigatorio: now >= DRIVER_TERMS_REQUIRED_FROM
  };
  // Aceitou uma versao anterior: o app conta o que mudou ao pedir o aceite de novo.
  if (!status.aceito && driver?.termoVersao) status.aceitouAntigo = true;
  return status;
}

export function driverTermsMissing(driver = {}, now = Date.now()) {
  return now >= DRIVER_TERMS_REQUIRED_FROM && !driverTermsAccepted(driver);
}

export function driverTermsError() {
  const error = new Error('Para receber chamadas, aceite o Termo do Motoboy Parceiro. Feche e abra o app para ler e aceitar.');
  error.status = 428;
  error.code = 'termo_motoboy_pendente';
  return error;
}

// O que fica guardado como prova do aceite (uma gravacao por motoboy por versao).
export function driverTermsRecord({ cpf = '', ip = '', aparelho = '', origem = 'app' } = {}) {
  return {
    cpf: String(cpf || '').replace(/\D/g, '').slice(0, 11),
    versao: DRIVER_TERMS_VERSION,
    ip: String(ip || '').slice(0, 64),
    aparelho: String(aparelho || '').slice(0, 300),
    origem: origem === 'cadastro' ? 'cadastro' : 'app'
  };
}
