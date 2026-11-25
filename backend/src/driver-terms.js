// Termo do Motoboy Parceiro (motoboy-termo.html): versao atual, se o motoboy ja aceitou e o
// registro do aceite, que serve de prova (data, versao, IP e aparelho).
// Mudou o texto? Troque a versao aqui e em motoboy-termo.html: todo motoboy aceita de novo.
export const DRIVER_TERMS_VERSION = '2026-11-25';
export const DRIVER_TERMS_URL = 'motoboy-termo.html';

// Ate esta data o servidor ainda deixa aceitar chamada sem o termo (so o app pede o aceite),
// para quem esta com o app aberto na versao antiga nao perder corrida no dia da troca.
// 01/12/2026 00:00 no horario de Brasilia.
export const DRIVER_TERMS_REQUIRED_FROM = Date.parse('2026-12-01T03:00:00Z');

export function driverTermsAccepted(driver = {}) {
  return String(driver?.termoVersao || '') === DRIVER_TERMS_VERSION;
}

export function driverTermsStatus(driver = {}) {
  return { versao: DRIVER_TERMS_VERSION, aceito: driverTermsAccepted(driver), url: DRIVER_TERMS_URL };
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
