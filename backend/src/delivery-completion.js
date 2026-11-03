export function protectedDelivery(delivery) {
  return Number(delivery.confirmacaoEmpresaVersao || 0) === 1 && delivery.tipo !== 'servico_exclusivo';
}
export function deliveryHeld(delivery) {
  return protectedDelivery(delivery) && !!(delivery.retiradaLiberadaEm || delivery.conclusaoStatus);
}
export function completionReason(value) {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (reason.length < 10 || reason.length > 500 || /[<>\x00-\x08\x0b\x0c\x0e-\x1f]/.test(reason)) {
    const error = new Error('Descreva o problema ou a decisão em 10 a 500 caracteres.'); error.status = 400; throw error;
  }
  return reason;
}
export function assertCompanyDelivery(delivery, companyId) {
  const owner = String(delivery.empresaId || delivery.telefoneEmpresa || '').replace(/\D/g, '');
  if (!protectedDelivery(delivery) || owner !== companyId) {
    const error = new Error('Entrega não encontrada nesta conta ou sem este fluxo de confirmação.'); error.status = 404; throw error;
  }
}
