// Trava para finalizar a corrida de mototaxi: o motoboy so recebe por uma corrida que fez.
// Vale uma de duas provas:
// 1) GPS: passou no local de embarque, esta perto do destino agora e deu tempo de fazer o trajeto;
// 2) codigo de chegada: 4 numeros que so o cliente ve no app (ou no link de acompanhamento).
import crypto from 'node:crypto';

export const DESTINO_RAIO_M = 300;
export const GPS_FRESCO_MS = 3 * 60 * 1000;
export const VELOCIDADE_MAX_KMH = 70;
export const TEMPO_MINIMO_S = 45;
export const CODIGO_CHEGADA_TENTATIVAS = 5;

function coordenada(lat, lon) {
  const a = Number(lat);
  const b = Number(lon);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) > 0.1 && Math.abs(b) > 0.1 ? { lat: a, lon: b } : null;
}

export function metrosEntre(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function codigoChegada() {
  return String(crypto.randomInt(1000, 10000));
}

// Quando o GPS do motoboy passou no embarque (corridas antigas: a chegada marcada pelo GPS).
export function embarqueGpsMs(ride = {}) {
  return Number(ride.embarqueGpsEmMs || 0) || (ride.motoboyChegouPor === 'gps' ? Number(ride.motoboyChegouEmMs || 0) : 0);
}

// Tempo minimo do embarque ate o destino, como se a moto fosse a 70 km/h o caminho todo.
export function tempoMinimoSegundos(ride = {}) {
  let km = Number(ride.km);
  if (!(km > 0)) {
    const origem = coordenada(ride.origemLat, ride.origemLon);
    const destino = coordenada(ride.destinoLat, ride.destinoLon);
    km = origem && destino ? (metrosEntre(origem, destino) / 1000) * 1.3 : 0;
  }
  return Math.max(TEMPO_MINIMO_S, Math.round((km / VELOCIDADE_MAX_KMH) * 3600));
}

// location: ultima posicao do motoboy ({ latitude, longitude, accuracy, serverTimestampMs }).
export function provaPorGps(ride = {}, location = null, agora = Date.now()) {
  const embarque = embarqueGpsMs(ride);
  if (!embarque) return { ok: false, motivo: 'sem_embarque_gps' };
  const destino = coordenada(ride.destinoLat, ride.destinoLon);
  if (!destino) return { ok: false, motivo: 'destino_sem_mapa' };
  const eu = location ? coordenada(location.latitude, location.longitude) : null;
  if (!eu || agora - Number(location.serverTimestampMs || 0) > GPS_FRESCO_MS) return { ok: false, motivo: 'gps_sem_sinal' };
  const folga = Math.min(50, Math.max(0, Number(location.accuracy || 0)));
  const distanciaM = Math.round(metrosEntre(eu, destino));
  if (distanciaM > DESTINO_RAIO_M + folga) return { ok: false, motivo: 'longe_do_destino', distanciaM };
  if ((agora - embarque) / 1000 < tempoMinimoSegundos(ride)) return { ok: false, motivo: 'rapido_demais', distanciaM };
  return { ok: true, distanciaM };
}

function distanciaTexto(metros) {
  return metros >= 1000 ? `${(metros / 1000).toFixed(1).replace('.', ',')} km` : `${Math.max(10, Math.round(metros / 10) * 10)} m`;
}

export function mensagemSemProva(prova = {}) {
  const codigo = 'peça ao cliente o código de chegada que aparece no app dele e digite aqui.';
  switch (prova.motivo) {
    case 'longe_do_destino':
      return `Pelo GPS você está a ${distanciaTexto(prova.distanciaM)} do destino. Leve o cliente até o destino para finalizar. Se ele quis descer antes, ${codigo}`;
    case 'rapido_demais':
      return `A corrida está terminando rápido demais para a distância. Para finalizar, ${codigo}`;
    case 'sem_embarque_gps':
      return `O GPS não registrou você no local de embarque. Para finalizar, ${codigo}`;
    case 'destino_sem_mapa':
      return `Esta corrida não tem o destino no mapa. Para finalizar, ${codigo}`;
    default:
      return `Sem sinal do seu GPS agora. Para finalizar, ${codigo}`;
  }
}
