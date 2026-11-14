// Ligacao de voz pelo app (cliente <-> motoboy), sem mostrar o numero de ninguem.
// O audio vai direto de celular para celular (WebRTC); o servidor so troca os "convites"
// (oferta e resposta SDP) e guarda o estado da chamada em memoria, por poucos minutos.
export const CALL_RING_MS = 45 * 1000;
export const CALL_MAX_MS = 30 * 60 * 1000;
const KEEP_ENDED_MS = 60 * 1000;
const MAX_SDP = 20000;

const other = (role) => (role === 'cliente' ? 'motoboy' : 'cliente');

export function createCallStore({ now = Date.now, randomId = () => Math.random().toString(36).slice(2, 12) } = {}) {
  const calls = new Map();

  function tidy(rideId) {
    const call = calls.get(rideId);
    if (!call) return null;
    const at = now();
    if (call.status === 'chamando' && at - call.createdAt > CALL_RING_MS) Object.assign(call, { status: 'encerrada', motivo: 'sem_resposta', endedAt: at });
    if (call.status === 'atendida' && at - call.createdAt > CALL_MAX_MS) Object.assign(call, { status: 'encerrada', motivo: 'tempo_maximo', endedAt: at });
    if (call.status === 'encerrada' && at - call.endedAt > KEEP_ENDED_MS) { calls.delete(rideId); return null; }
    return call;
  }

  function fail(message, status = 409, code = 'ligacao_invalida') {
    return Object.assign(new Error(message), { status, code });
  }

  function validSdp(sdp, type) {
    return sdp && typeof sdp === 'object' && sdp.type === type && typeof sdp.sdp === 'string' && sdp.sdp.length > 10 && sdp.sdp.length <= MAX_SDP;
  }

  return {
    start(rideId, role, offer) {
      if (!['cliente', 'motoboy'].includes(role)) throw fail('Ligacao nao autorizada.', 403, 'ligacao_nao_autorizada');
      if (!validSdp(offer, 'offer')) throw fail('Convite de ligacao invalido.', 400);
      const current = tidy(rideId);
      if (current && current.status !== 'encerrada') {
        if (current.from === role && current.status === 'chamando') { current.offer = offer; current.updatedAt = now(); return current; }
        throw fail('Ja tem uma ligacao em andamento nesta corrida.', 409, 'linha_ocupada');
      }
      if (calls.size > 2000) calls.delete(calls.keys().next().value);
      const call = { id: randomId(), from: role, to: other(role), status: 'chamando', offer, answer: null, motivo: '', createdAt: now(), updatedAt: now(), answeredAt: 0, endedAt: 0, endedBy: '' };
      calls.set(rideId, call);
      return call;
    },
    answer(rideId, role, callId, answer) {
      const call = tidy(rideId);
      if (!call || call.id !== callId) throw fail('Esta ligacao ja terminou.', 409, 'ligacao_encerrada');
      if (call.to !== role) throw fail('So quem recebeu a ligacao pode atender.', 403, 'ligacao_nao_autorizada');
      if (call.status !== 'chamando') throw fail('Esta ligacao ja terminou.', 409, 'ligacao_encerrada');
      if (!validSdp(answer, 'answer')) throw fail('Resposta de ligacao invalida.', 400);
      Object.assign(call, { status: 'atendida', answer, answeredAt: now(), updatedAt: now() });
      return call;
    },
    end(rideId, role, callId, motivo = '') {
      const call = tidy(rideId);
      if (!call || (callId && call.id !== callId) || call.status === 'encerrada') return call;
      if (![call.from, call.to].includes(role)) throw fail('Ligacao nao autorizada.', 403, 'ligacao_nao_autorizada');
      const reason = call.status === 'chamando' ? (role === call.to ? 'recusada' : 'cancelada') : 'encerrada';
      Object.assign(call, { status: 'encerrada', motivo: ['ocupado', 'sem_microfone'].includes(motivo) ? motivo : reason, endedBy: role, endedAt: now(), updatedAt: now() });
      return call;
    },
    // O que cada lado ve: quem liga recebe a resposta; quem recebe ve o convite.
    view(rideId, role) {
      const call = tidy(rideId);
      if (!call || ![call.from, call.to].includes(role)) return null;
      return {
        id: call.id, from: call.from, status: call.status, motivo: call.motivo,
        souEu: call.from === role, createdAt: call.createdAt, answeredAt: call.answeredAt,
        offer: call.to === role && call.status === 'chamando' ? call.offer : null,
        answer: call.from === role && call.status === 'atendida' ? call.answer : null
      };
    },
    clear(rideId) { calls.delete(rideId); },
    size() { return calls.size; }
  };
}
