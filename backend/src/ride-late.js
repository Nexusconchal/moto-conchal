// Motoboy atrasado: se ele aceitou a corrida e nao chegou ao cliente em 15 minutos,
// o cliente pode cancelar o motoboy (chamar outro ou cancelar a corrida).
// "Chegou" = o motoboy tocou em "Cheguei no local" ou o GPS dele ficou perto da saida.
export const LATE_CANCEL_MS = 15 * 60 * 1000;
export const ARRIVAL_RADIUS_M = 150;

function distanceMeters(aLat, aLon, bLat, bLon) {
  const values = [aLat, aLon, bLat, bLon].map(Number);
  if (!values.every(Number.isFinite) || (values[2] === 0 && values[3] === 0)) return Infinity;
  const [lat1, lon1, lat2, lon2] = values;
  const rad = (degrees) => degrees * Math.PI / 180;
  const h = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// GPS do motoboy perto do ponto de saida (descontando a impressao do GPS, ate 50 m).
export function reachedPickup(ride = {}, location = {}) {
  const slack = Math.min(50, Math.max(0, Number(location.accuracy || 0)));
  return distanceMeters(location.latitude, location.longitude, ride.origemLat, ride.origemLon) <= ARRIVAL_RADIUS_M + slack;
}

// Situacao do botao "Cancelar motoboy" para o cliente.
export function lateCancelState(ride = {}, acceptedAtMs = 0, now = Date.now()) {
  if (ride.status !== 'aceita' || !acceptedAtMs || ride.motoboyChegouEm) return { liberaEmMs: 0, pode: false };
  const liberaEmMs = acceptedAtMs + LATE_CANCEL_MS;
  return { liberaEmMs, pode: now >= liberaEmMs, pagoOnline: ride.pagamento?.status === 'approved' };
}

// Motivo para recusar o cancelamento pedido pelo cliente (null = pode).
export function lateCancelBlocker(ride = {}, acceptedAtMs = 0, now = Date.now()) {
  const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
  if (ride.status !== 'aceita') return fail('corrida_nao_aceita', 'Esta corrida não está mais esperando o motoboy.');
  if (ride.motoboyChegouEm) return fail('motoboy_chegou', 'O motoboy já chegou ao local de embarque.');
  const state = lateCancelState(ride, acceptedAtMs, now);
  if (!state.pode) return fail('ainda_no_prazo', 'O motoboy ainda está dentro dos 15 minutos para chegar.');
  if (state.pagoOnline) return fail('corrida_paga', 'Você já pagou esta corrida online. Fale com o suporte para trocar de motoboy e receber o valor de volta.');
  return null;
}
