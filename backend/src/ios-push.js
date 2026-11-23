// App de iPhone (Capacitor): o aviso precisa do bloco "apns" para tocar o som de chamada e
// passar pelo modo Foco ("Time Sensitive"). No Android e no navegador este bloco é ignorado,
// então ele pode ir junto em todas as mensagens sem mudar nada para quem não é iPhone.
//
// O iPhone não deixa um aviso tocar sem parar: cada som dura no máximo 30 segundos. O "alerta
// insistente" do servidor (offer-alert.js) reenvia a chamada enquanto ninguém aceita; com o mesmo
// "collapse-id" o iPhone troca o aviso anterior pelo novo (toca de novo, sem encher a tela).
export const IOS_CALL_SOUND = 'chamada.wav';

export function iosAlert(tag, { urgent = true, sound = IOS_CALL_SOUND } = {}) {
  const id = String(tag || 'motoja').replace(/[^\w-]/g, '_').slice(0, 64);
  return {
    headers: { 'apns-priority': '10', 'apns-push-type': 'alert', 'apns-collapse-id': id },
    payload: { aps: { sound, threadId: id, ...(urgent ? { 'interruption-level': 'time-sensitive', 'relevance-score': 1 } : {}) } }
  };
}

// Plataforma do aparelho do motoboy: Android do app, iPhone do app ou navegador.
export function driverPlatform(value) {
  return value === 'android_nativo' || value === 'ios_nativo' ? value : 'web';
}
