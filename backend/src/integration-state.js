import crypto from 'node:crypto';

// Only the old accept endpoint wrote this shape without creating a delivery.
export function isUnsentLegacyImport(record) {
  return !!record && !!(record.aceitoEmMs || record.aceitoEm) &&
    !record.deliveryId && !record.entregaId && !record.status &&
    !record.canceladoEm && !record.canceladoEmMs && !record.dispatchedAtMs;
}

export function integrationDeliveryId(companyId, source, orderId) {
  return `api_${crypto.createHash('sha256').update(JSON.stringify([companyId, source, orderId])).digest('hex')}`;
}
