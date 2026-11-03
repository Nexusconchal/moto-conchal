import crypto from 'node:crypto';

const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const plain = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const ms = value => typeof value?.toMillis === 'function' ? value.toMillis() : Number(value || 0);
export const SUPPORT_PHONE = '5519992306488';
export const DRIVER_GROUP_NAME = 'Nexus MotoJá - MOTORISTA';
const APP = 'https://nexusmotoja.com.br/';
const SHARED_APP = `${APP}?origem=suporte&v=202`;
const DRIVER_APP = `${APP}motoboy.html`;

export function brazilPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  let national = digits.startsWith('55') && digits.length > 11 ? digits.slice(2) : digits;
  // WhatsApp still identifies some older mobiles without the 9th digit (DDD + 8 digits);
  // the app stores them with it, so the ride lookup and OTP echoes must match.
  if (/^\d{2}[6-9]\d{7}$/.test(national)) national = `${national.slice(0, 2)}9${national.slice(2)}`;
  return /^\d{10,11}$/.test(national) ? `55${national}` : '';
}

// The free Render instances sleep; when they wake, WhatsApp delivers the backlog late.
// Answer it (with an apology) instead of leaving the customer without a reply.
const MAX_MESSAGE_AGE_MS = 30 * 60000;
export function parseSupportMessage(body, instance, now = Date.now()) {
  if (body?.instance !== instance || !['messages.upsert', 'MESSAGES_UPSERT', 'send.message', 'SEND_MESSAGE'].includes(body?.event)) return null;
  const data = body.data;
  if (!data || Array.isArray(data) || !data.key?.id) return null;
  const jid = String(data.key.remoteJid || '');
  if (!/@(?:s\.whatsapp\.net|lid)$/.test(jid)) return null;
  const phoneJid = jid.endsWith('@lid') ? String(data.key.remoteJidAlt || data.key.senderPn || data.senderPn || '') : jid;
  // Never interpret a LID as a phone. Without a mapping the customer still gets an answer
  // through the LID itself, only without ride lookup.
  const phone = phoneJid.endsWith('@s.whatsapp.net') ? brazilPhone(phoneJid.split('@')[0]) : '';
  const fromMe = data.key.fromMe === true;
  if (!phone && (fromMe || !jid.endsWith('@lid'))) return null;
  const time = Number(data.messageTimestamp?.low ?? data.messageTimestamp) * 1000;
  if (!Number.isFinite(time) || now - time > MAX_MESSAGE_AGE_MS || time > now + 60000) return null;
  const rawMessage = data.message || {};
  const unwrapped = rawMessage.ephemeralMessage?.message || rawMessage.viewOnceMessage?.message || rawMessage.viewOnceMessageV2?.message || rawMessage;
  const message = unwrapped.documentWithCaptionMessage?.message || unwrapped;
  if (message.reactionMessage || message.protocolMessage || message.stickerMessage) return null;
  const text = String(message.conversation || message.extendedTextMessage?.text || message.imageMessage?.caption || message.videoMessage?.caption || message.documentMessage?.caption
    || message.buttonsResponseMessage?.selectedButtonId || message.templateButtonReplyMessage?.selectedId || message.listResponseMessage?.singleSelectReply?.selectedRowId || '').slice(0, 2000);
  const place = message.locationMessage || message.liveLocationMessage;
  const lat = Number(place?.degreesLatitude);
  const lon = Number(place?.degreesLongitude);
  const location = place && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat !== 0 || lon !== 0) ? { lat, lon } : null;
  if (!text && !location && !message.audioMessage && !message.imageMessage && !message.videoMessage && !message.locationMessage && !message.liveLocationMessage && !message.documentMessage && !message.contactMessage) return null;
  return { id: String(data.key.id).slice(0, 160), phone, jid, replyTo: phone || jid, fromMe, text, location, name: String(data.pushName || '').slice(0, 60), ageMs: Math.max(0, now - time) };
}

// Some Evolution webhook payloads omit the LID mapping present in stored messages.
// Only a matching provider message ID AND JID can supply a phone; never guess it.
export async function enrichSupportMessage(body, instance, findMessages) {
  if (body?.instance !== instance || !['messages.upsert', 'MESSAGES_UPSERT', 'send.message', 'SEND_MESSAGE'].includes(body?.event)) return body;
  if (Array.isArray(body.data)) {
    const data = [];
    for (const item of body.data.slice(0, 50)) data.push((await enrichSupportMessage({ ...body, data: item }, instance, findMessages)).data);
    return { ...body, data };
  }
  const key = body.data?.key;
  if (!key?.id || !/^\d+@lid$/.test(String(key.remoteJid)) || String(key.remoteJidAlt || key.senderPn || body.data.senderPn || '').endsWith('@s.whatsapp.net')) return body;
  const result = await findMessages(String(key.id)).catch(() => null);
  const records = result?.messages?.records || result?.records || [];
  const matches = records.filter(item => item.key?.id === key.id && (item.key.remoteJid === key.remoteJid || item.key.remoteJidAlt === key.remoteJid));
  const phones = [...new Set(matches.flatMap(item => [item.key.remoteJid, item.key.remoteJidAlt]).filter(jid => /^\d+@s\.whatsapp\.net$/.test(String(jid))))];
  if (phones.length !== 1) return body;
  return { ...body, data: { ...body.data, key: { ...key, remoteJidAlt: phones[0] } } };
}

export function requestedRideId(text) {
  return String(text).match(/\b[a-f0-9]{8,12}-\d{6,12}\b/i)?.[0]
    || String(text).match(/(?:codigo(?: da corrida)?|corrida|pedido)\s*[:#]\s*([a-zA-Z0-9_-]{8,80})\b/i)?.[1] || '';
}

const MENU = '1 • Pedir corrida\n2 • Acompanhar corrida ou entrega\n3 • Endereço ou erro no app\n4 • Pagamento e troco\n5 • Falar com uma pessoa\n6 • Empresas: pedir entrega\n7 • Quero trabalhar como motoboy';
const FOOTER = '\n\nSe preferir falar com uma pessoa, é só escrever ATENDENTE.';
const GREETING_WORDS = new Set(['oi', 'oie', 'ola', 'opa', 'eai', 'eae', 'e', 'ai', 'salve', 'bom', 'boa', 'dia', 'tarde', 'noite', 'tudo', 'td', 'bem', 'blz', 'beleza', 'como', 'vai', 'esta', 'ta', 'vc', 'voce', 'voces', 'vcs', 'gente', 'pessoal', 'amigo', 'amiga', 'moco', 'moca', 'senhor', 'senhora', 'ok', 'hello', 'hi']);
// Customers write the same thing many ways ("oiii", "qro uma moto", "tem moto?"):
// collapse repeated letters and match the common Brazilian spellings.
export function supportIntent(text) {
  const t = plain(text).trim().replace(/([a-z])\1{2,}/g, '$1');
  const words = t.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (/^(menu|inicio|voltar|0)$/.test(words)) return 'menu';
  if (t === '5' || /\b(humano|pessoa|atendente|reclamacao|reclamar|acidente|emergencia|nao responde|nao tem troco|falar com (alguem|o dono|voce))\b/.test(t)) return 'human';
  if (requestedRideId(text)) return 'status';
  if (t === '7' || /\b(quero|queria|como|posso|da pra)\b.{0,25}\b(trabalhar|ser motoboy|ser motorista|rodar|me cadastrar como motoboy)|\b(vaga|vagas|cadastro de motoboy|cadastrar minha moto)\b/.test(words)) return 'driver';
  if (/\bcancel/.test(words)) return 'cancel';
  if (/\b(horario|que horas|aberto|funciona(m|ndo)? (agora|hoje|de madrugada|domingo|feriado)|24 ?h|madrugada)\b/.test(words)) return 'hours';
  if (/\b(atende|atendem|atendimento em|funciona em|chega em|vai ate|tem em|cidades?)\b/.test(words) && !/\b(endereco|erro|mapa|gps)\b/.test(words)) return 'coverage';
  if (t === '3' || /endereco|localizacao|gps|cosmopolis|calcular|calcula|mapa|erro|nao consigo|nao conseguindo|nao funciona/.test(t)) return 'address';
  if (t === '4' || /pagamento|pagar|pix|dinheiro|troco|cartao|valor|preco|quanto/.test(t)) return 'payment';
  if (/\b(preciso|quero|qro|queria|tem|manda|mande|chama|arruma|consegue|pode)\b.{0,20}\b(moto|motos|motoboy|mototaxi|moto taxi|corrida|levar|me buscar)\b|\b(me leva|me levar|vir me buscar)\b/.test(words) && !/\b(cade|demor|ainda|aguard|esper|nao chegou)\b/.test(words)) return 'request';
  if (t === '2' || /acompanhar|aguard|esper|aceit|demor|motorista|motoboy|confirmar|cade|nao chegou/.test(t)) return 'status';
  if (t === '6' || /entrega|empresa|comercio|lojista|restaurante/.test(t)) return 'delivery';
  if (t === '1' || /pedir|chamar|preciso|quero.*corrida|solicitar|como.*corrida/.test(t)) return 'request';
  if (words && words.split(' ').length <= 6 && words.split(' ').every(word => GREETING_WORDS.has(word) || GREETING_WORDS.has(word.replace(/([a-z])\1+/g, '$1')))) return 'greeting';
  if (/^(obrigad[oa]|obg|brigad[oa]|valeu|vlw|ok|okay|certo|beleza|blz|show|top|perfeito)( (mesmo|demais|viu))?[!?.\s]*$/.test(t)) return 'thanks';
  return 'other';
}
function greetingFor(now, name) {
  const hour = Number(new Intl.DateTimeFormat('pt-BR', { hour: 'numeric', hour12: false, timeZone: 'America/Sao_Paulo' }).format(new Date(now))) % 24;
  const period = hour < 5 ? 'Boa noite' : hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  const first = String(name || '').trim().split(/\s+/)[0].replace(/[^\p{L}'-]/gu, '').slice(0, 20);
  return first.length >= 2 ? `${period}, ${first[0].toUpperCase()}${first.slice(1).toLowerCase()}!` : `${period}!`;
}
export function supportAnswer(text, ride, expireMs, now = Date.now(), context = {}) {
  const t = plain(text);
  const intent = supportIntent(text);
  if (intent === 'human') return { human: true, topic: 'human', text: 'Registrei seu pedido para uma pessoa do suporte. Qual é o problema? Pode escrever aqui; sua mensagem ficará junto do pedido. O retorno depende de alguém disponível.\n\nEnquanto aguarda, posso continuar ajudando com suas dúvidas. Quando uma pessoa responder, deixo a conversa com ela. Digite MENU para ver as opções.' };
  if (!String(text).trim()) return { text: 'Sou o atendimento automático da Nexus MotoJá. Ainda não interpreto áudio, imagem ou localização recebida aqui. Escreva sua dúvida ou o código da corrida. Para uma pessoa, escreva ATENDENTE.' };
  if (intent === 'menu' || intent === 'greeting') return { topic: 'menu', text: `${greetingFor(now, context.name)} Sou o atendimento automático da Nexus MotoJá. Posso ajudar mesmo se você ainda não pediu uma corrida. O que você precisa?\n\n${MENU}\n\nPode responder com o número ou escrever sua dúvida. Digite ATENDENTE se quiser uma pessoa do suporte.\n\nApp: ${SHARED_APP}` };
  if (intent === 'thanks') return { topic: context.topic || 'menu', text: `Por nada! Se precisar de mais ajuda, é só escolher uma opção.\n\n${MENU}` };
  if (intent === 'driver') return { topic: 'driver', text: `Que bom que quer trabalhar com a gente! O cadastro de motoboy é feito pelo app do motoboy: ${DRIVER_APP}\n\nPreencha seus dados e envie os documentos pedidos. Depois que o cadastro for aprovado, você já consegue ficar online e receber corridas pelo app.\n\nSe travar em alguma etapa do cadastro, escreva ATENDENTE e conte onde parou.${FOOTER}` };
  if (intent === 'cancel') return { topic: 'status', text: `Para cancelar, abra a sua corrida no app e use a opção de cancelar na tela da corrida: ${APP}\n\nPor aqui eu não consigo cancelar. Se o motoboy já aceitou, avise ele também. Se não estiver conseguindo cancelar, escreva ATENDENTE e mande o código da corrida.${FOOTER}` };
  if (intent === 'hours') return { topic: 'request', text: `Você pode fazer o pedido pelo app a qualquer momento: ${APP}\n\nA corrida é confirmada quando um motoboy disponível aceitar. Em horários de pouco movimento, como de madrugada, o aceite pode demorar mais.${FOOTER}` };
  if (intent === 'coverage') return { topic: 'address', text: `Atendemos Conchal e região. O jeito mais rápido de saber se o seu endereço é atendido é colocar a saída e o destino no app: ${APP}\n\nSe a região for atendida, ele calcula o valor na hora. Se aparecer algum erro, me mande o texto do erro.${FOOTER}` };
  if (intent === 'delivery') return { topic: 'delivery', text: `Para pedir uma entrega, entre no app das empresas: ${APP}empresa.html\n\nInforme o endereço de entrega, calcule o pedido e confira o valor e o mapa antes de chamar o motoboy. O aceite deve ser acompanhado no app.\n\nO problema acontece ao entrar, calcular o endereço ou chamar o motoboy?${FOOTER}` };
  if (intent === 'request') return { topic: 'request', text: `Vamos lá! Abra ${APP}\n\n1. Informe o endereço de saída ou use sua localização.\n2. Coloque rua, número e cidade do destino.\n3. Calcule, confira o valor e o mapa e toque em “Chamar motoboy”.\n\nA corrida fica confirmada quando um motorista aceitar. Você está com dificuldade no endereço ou já pediu e está esperando?${FOOTER}` };
  if (intent === 'address' || (intent === 'other' && context.topic === 'address')) return { topic: 'address', text: `${context.topic === 'address' ? 'Obrigado pelo detalhe. ' : ''}O problema é no endereço de saída, no destino ou aparece alguma mensagem de erro?\n\nNo app, escreva rua, número e cidade. Confira o ponto no mapa antes de pedir. Se o GPS estiver errado, digite a saída manualmente. Para outra cidade, inclua o nome dela no destino.\n\nSe continuar falhando, envie o texto do erro e escreva ATENDENTE para o suporte verificar. Enviar o endereço aqui não cria uma corrida.${FOOTER}` };
  if (intent === 'payment') return { topic: 'payment', text: `O preço é calculado no app antes de chamar. Confira as formas de pagamento disponíveis nele.\n\nSe for pagar em dinheiro e precisar de troco, informe para quanto nas observações e confirme com o motorista após o aceite. Não tenho como garantir que ele terá troco.\n\nSe houve cobrança indevida ou dificuldade com o pagamento, escreva ATENDENTE e explique o que aconteceu. Não envie senha, código de confirmação ou dados de cartão aqui.${FOOTER}` };
  let status = '';
  const sorry = WAITING_COMPLAINT.test(t) ? empathy(context.name) : '';
  if (ride) {
    const expired = ride.status === 'pendente' && now - ms(ride.criadaEm) >= expireMs;
    if (expired || ride.status === 'expirada') status = `${sorry}Sua solicitação expirou sem aceite: nenhum motoboy pegou a tempo. No app você pode renovar ou pedir de novo. Não renovei nem criei outra corrida por aqui.`;
    else if (ride.status === 'pendente') status = `${sorry}Sua corrida está aguardando um motoboy aceitar. Ainda não há motorista confirmado. Os motoboys estão sendo avisados, mas não consigo garantir quem pega nem o horário de chegada.`;
    else if (ACTIVE.includes(ride.status)) status = `${sorry}Sua corrida já foi aceita! No app você vê os dados do motoboy, acompanha onde ele está ao vivo e fala com ele pelo chat da corrida. Não tenho uma previsão de chegada confirmada.`;
    else if (ride.status === 'cancelada') status = 'Sua corrida está cancelada. Se ainda precisar, é só pedir uma nova pelo app.';
    else if (['finalizada', 'concluida'].includes(ride.status)) status = 'Sua corrida consta como finalizada. Se aconteceu algum problema nela, me conta ou escreva ATENDENTE.';
    else status = 'Encontrei sua solicitação. Confira a etapa atual no app ou escreva ATENDENTE.';
  } else status = `${sorry}Não encontrei uma corrida recente pelo número deste WhatsApp. Às vezes o pedido foi feito com outro número. Me manda o código da corrida (aparece no app, na tela da corrida) que eu confiro agora pra você.`;
  if (intent === 'other' && !ride) return { topic: 'menu', text: `Posso te ajudar a pedir ou acompanhar uma corrida, resolver endereço e tirar dúvidas de pagamento. Qual dessas opções combina com o que você precisa?\n\n${MENU}\n\nApp: ${APP}` };
  if (ride?.kind === 'entregas') status = status.replace(/Sua corrida/g, 'Sua entrega').replace(/corrida/g, 'entrega').replace(/motorista/g, 'motoboy');
  // The app link only helps when there is a ride to open; otherwise it is just a big card.
  return { topic: ride?.kind === 'entregas' ? 'delivery' : 'status', text: `${status}${ride ? `\n\nApp: ${ride.kind === 'entregas' ? `${APP}empresa.html` : APP}` : ''}${FOOTER}` };
}

export function chooseDriverGroup(groups) {
  const matches = (Array.isArray(groups) ? groups : []).filter(group => plain(group.subject).replace(/\s+/g, ' ').trim() === plain(DRIVER_GROUP_NAME) && /^\d+@g\.us$/.test(group.id));
  return matches.length === 1 ? matches[0] : null;
}

export function pendingNotice(job, kind, stage, expireMs, now = Date.now()) {
  const age = now - ms(job.criadaEm);
  const reminderMinutes = stage === 'reminder' ? 2 : Number(stage.match(/^reminder-(\d+)m$/)?.[1] || 0);
  if (job.status !== 'pendente' || !ms(job.criadaEm) || age < reminderMinutes * 60000 || (stage === 'initial' && age >= 120000) || age >= expireMs) return '';
  const value = Number(job.valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  return `${stage === 'customer' ? 'ATENÇÃO, MOTOBOYS: cliente pediu ajuda porque está aguardando aceite' : reminderMinutes ? `ATENÇÃO, MOTOBOYS: solicitação aguardando há pelo menos ${reminderMinutes} minutos` : 'NOVA SOLICITAÇÃO NEXUS MOTOJÁ'}\n${kind === 'corridas' ? 'Corrida' : 'Entrega'} disponível: ${value}.\nQuem estiver disponível, confira e aceite no app:\n${DRIVER_APP}\nCódigo: ${job.id}\nA disponibilidade deve ser conferida no app. Não confirme pelo grupo.`;
}

const ACTIVE = ['aceita', 'iniciada', 'em_andamento'];
const WAITING_COMPLAINT = /demor|atras|aguard|esper|nao chegou|cade|ninguem|nao aceit|nao veio|nao aparec|nao responde/;
function empathy(name) {
  const first = String(name || '').trim().split(/\s+/)[0].replace(/[^\p{L}'-]/gu, '').slice(0, 20);
  return `Poxa${first.length >= 2 ? `, ${first[0].toUpperCase()}${first.slice(1).toLowerCase()}` : ''}, sinto muito pela espera! `;
}
// What the AI may know about the ride: written by the system, no phone, address, code or names.
export function rideFacts(ride, phoneKnown, looked, expireMs, now = Date.now()) {
  if (!looked) return 'não consultada (o cliente não falou de um pedido)';
  if (!phoneKnown) return 'não foi possível identificar o número deste WhatsApp; para consultar é preciso o código da corrida que aparece no app';
  if (!ride) return 'nenhuma corrida ou entrega recente encontrada pelo número deste WhatsApp (pode ter sido pedida com outro número)';
  const kind = ride.kind === 'entregas' ? 'entrega' : 'corrida';
  const minutes = Math.max(0, Math.round((now - ms(ride.criadaEm)) / 60000));
  const expired = ride.status === 'expirada' || (ride.status === 'pendente' && now - ms(ride.criadaEm) >= expireMs);
  const label = expired ? 'expirou sem nenhum motoboy aceitar (o cliente pode renovar ou pedir de novo no app)'
    : ride.status === 'pendente' ? 'aguardando um motoboy aceitar; ainda não há motoboy confirmado'
    : ACTIVE.includes(ride.status) ? 'já aceita por um motoboy; o cliente acompanha a localização ao vivo e fala com ele pelo chat da corrida no app'
    : ride.status === 'cancelada' ? 'cancelada'
    : ['finalizada', 'concluida'].includes(ride.status) ? 'finalizada' : 'em andamento (etapa não identificada)';
  return `${kind} ${label}; pedida há cerca de ${minutes} minutos.`;
}

// The assistant never changes fares or accepts a job. Ride requests go through `booking`
// (whatsapp-booking.js), which asks and confirms every detail before the server creates the ride.
export function createSupportAutomation({ db, sendText, encrypt, decrypt = () => '', generateReply = async () => null, booking = null, instance, rideExpireMs, deliveryExpireMs, sendTelegram, isSystemOutgoing = () => false, markRead = async () => {}, typing = async () => {}, groupFor = async (job, kind, settings) => settings.driverGroupJid || '', now = () => Date.now() }) {
  const configRef = db.collection('configuracoes').doc('atendimentoAutomatico');
  let cache, cacheUntil = 0, ticking = false, lastPrune = 0;
  const completedNotices = new Map(), outgoingEchoes = new Map(), queuedChats = new Set();
  // Ultimo aviso no grupo do WhatsApp, para o painel mostrar se esta chegando ou o motivo da falha.
  let lastGroupNotice = null;
  function recordGroupNotice(status, error = '') {
    lastGroupNotice = { at: now(), status, error: String(error || '').slice(0, 200) };
    if (status !== 'sent') console.error('support automation whatsapp group notice failed', lastGroupNotice.error || status);
  }
  function remember(map, key, value, lifetime = 120000) {
    if (map.size >= 2000) { for (const [id, entry] of map) if (entry.until <= now()) map.delete(id); }
    if (map.size >= 2000) map.delete(map.keys().next().value);
    map.set(key, { value, until: now() + lifetime });
  }
  async function config(refresh = false) {
    if (!refresh && cache && cacheUntil > now()) return cache;
    cache = (await configRef.get()).data() || {};
    cacheUntil = now() + 60000;
    return cache;
  }
  async function saveConfig(data) {
    await configRef.set(data, { merge: true }); cacheUntil = 0;
  }
  // The human queue keeps the last few messages, so the person who picks it up sees the story.
  async function appendTicket(ticketRef, text) {
    const current = (await ticketRef.get()).data() || {};
    let previous = '';
    try { previous = current.ultimaMensagemCriptografada ? decrypt(current.ultimaMensagemCriptografada) : ''; } catch { previous = ''; }
    if (previous.length < 30 && supportIntent(previous) === 'human') previous = ''; // Just the word ATENDENTE.
    await ticketRef.set({ ultimaMensagemCriptografada: encrypt(`${previous ? `${previous}\n` : ''}${text}`.slice(-1000)), updatedAt: now() }, { merge: true });
  }
  // Private nudge to the driver who accepted the customer's own ride, at most once per 10 minutes.
  async function nudgeDriver(ride, kind) {
    const phone = brazilPhone(ride.motoboyTelefone);
    if (!phone) return 'failed';
    const marker = db.collection('supportAutomationNotices').doc(hash(`${kind}:${ride.id}:avisar_motoboy`));
    let claim = false, recent = false;
    await db.runTransaction(async tx => {
      claim = false; recent = false;
      const previous = (await tx.get(marker)).data();
      if (previous && ms(previous.createdAt) > now() - 10 * 60000) { recent = true; return; }
      tx.set(marker, { createdAt: now(), expiresAt: new Date(now() + 86400000), status: 'claimed' });
      claim = true;
    });
    if (recent) return 'recent';
    if (!claim) return 'failed';
    const text = `Nexus MotoJá: o cliente da ${kind === 'entregas' ? 'entrega' : 'corrida'} ${ride.id} está te aguardando e perguntou sobre a chegada. Confira o chat da ${kind === 'entregas' ? 'entrega' : 'corrida'} no app e dê um retorno para ele por lá. Obrigado!`;
    // Our own message comes back as an echo; it must not pause the bot as a manual reply.
    remember(outgoingEchoes, hash(`${phone}:${text}`), true);
    const sent = await sendText(phone, text);
    await marker.set({ status: sent.sent ? 'sent' : 'failed', completedAt: now() }, { merge: true });
    return sent.sent ? 'sent' : 'failed';
  }
  async function findRide(phone, text, context = {}) {
    const id = requestedRideId(text);
    if (id) {
      const snap = await db.collection('corridas').doc(id).get();
      const ride = snap.data();
      if (ride) return brazilPhone(ride.telefoneCliente) === phone ? { ...ride, kind: 'corridas', id: snap.id } : null;
      const deliverySnap = await db.collection('entregas').doc(id).get();
      const delivery = deliverySnap.data();
      return delivery && brazilPhone(delivery.telefoneEmpresa) === phone ? { ...delivery, kind: 'entregas', id: deliverySnap.id } : null;
    }
    const kind = /entrega|pedido|empresa|comercio|lojista|restaurante/.test(plain(text)) || context.topic === 'delivery' ? 'entregas' : 'corridas';
    const result = await db.collection(kind).where(kind === 'entregas' ? 'telefoneEmpresa' : 'telefoneCliente', '==', phone.slice(2)).get();
    const rides = result.docs.map(snap => ({ ...snap.data(), id: snap.id })).filter(ride => now() - ms(ride.criadaEm) < 86400000).sort((a, b) => ms(b.criadaEm) - ms(a.criadaEm));
    const active = rides.filter(ride => ['pendente', 'aceita', 'iniciada', 'em_andamento'].includes(ride.status));
    if (active.length > 1) return null;
    const job = active[0] || rides[0];
    return job ? { ...job, kind } : null;
  }
  async function handle(body) {
    const settings = await config();
    if (!settings.enabled) return { ignored: true };
    if (Array.isArray(body?.data)) {
      const results = [];
      for (const data of body.data.slice(0, 50)) results.push(await handle({ ...body, data }));
      return { replied: results.some(result => result.replied), processed: results.length };
    }
    const event = parseSupportMessage(body, instance, now());
    if (!event) return { ignored: true };
    const echo = outgoingEchoes.get(hash(`${event.phone}:${event.text}`));
    if (event.fromMe && (isSystemOutgoing(event) || echo?.until > now())) return { ignored: true };
    return processEvent(event, settings);
  }
  async function processEvent(event, settings) {
    const intent = supportIntent(event.text);
    const wantsHuman = !event.fromMe && intent === 'human';
    const resumes = !event.fromMe && intent === 'menu';
    // A LID without phone mapping still has its own conversation, keyed by the LID.
    const contact = event.phone || event.jid;
    const chatRef = db.collection('supportAutomationChats').doc(hash(contact));
    const ticketRef = db.collection('supportAutomationTickets').doc(hash(contact));
    const messageRef = db.collection('supportAutomationEvents').doc(hash(`${instance}:${event.id}`));
    let claim = false, queued = false, context = {}, waitingHuman = false;
    await db.runTransaction(async tx => {
      claim = false; queued = false;
      const [message, chat] = await Promise.all([tx.get(messageRef), tx.get(chatRef)]);
      if (message.exists) return;
      const state = chat.data() || {};
      context = state;
      tx.set(messageRef, { createdAt: now(), expiresAt: new Date(now() + 86400000) });
      if (event.fromMe) {
        if (!isSystemOutgoing(event) && !(state.outgoingHash === hash(event.text) && state.outgoingUntil > now()) && event.id !== state.outgoingId) tx.set(chatRef, { pausedUntil: now() + 30 * 60000, pauseReason: 'manual', awaitingHuman: false }, { merge: true });
        return;
      }
      waitingHuman = state.awaitingHuman === true || state.pauseReason === 'human';
      if (state.pausedUntil > now() && state.pauseReason !== 'human' && !resumes) return;
      if (!wantsHuman && !resumes && state.lastReplyAt > now() - 2000 && state.lastIncomingHash === hash(event.text)) return;
      if (state.busyUntil > now()) {
        // Customers often send "oi" and the question right after. Keep what arrives while
        // the first answer is being sent and answer it next, instead of dropping it.
        if (event.text.trim()) {
          let pending = '';
          try { pending = state.pendingTextCriptografado ? decrypt(state.pendingTextCriptografado) : ''; } catch { pending = ''; }
          tx.set(chatRef, { pendingTextCriptografado: encrypt(`${pending ? `${pending}\n` : ''}${event.text}`.slice(-2000)), pendingName: event.name || '' }, { merge: true });
          queued = true;
        }
        if (event.location) {
          tx.set(chatRef, { pendingLocationCriptografada: encrypt(JSON.stringify(event.location)), pendingName: event.name || '' }, { merge: true });
          queued = true;
        }
        return;
      }
      tx.set(chatRef, { busyUntil: now() + 60000, ...(resumes || state.pauseReason === 'human' ? { pausedUntil: 0, pauseReason: '', ...(waitingHuman ? { awaitingHuman: true } : {}) } : {}), ...(resumes ? { aiContextCriptografado: '', aiContextUntil: 0 } : {}), expiresAt: new Date(now() + 7 * 86400000) }, { merge: true });
      claim = true;
    });
    if (!claim) {
      if (queued) queuedChats.add(chatRef.id);
      if (waitingHuman && event.text.trim() && !['menu', 'greeting', 'thanks'].includes(intent)) await ticketRef.set({ ultimaMensagemCriptografada: encrypt(event.text), updatedAt: now() }, { merge: true });
      return { ignored: true, ...(queued ? { queued: true } : {}) };
    }
    markRead(event).catch(() => {});
    let result;
    try {
      context = { ...context, name: event.name || context.pendingName || '' };
      const noted = waitingHuman && event.text.trim() && !['menu', 'greeting', 'thanks'].includes(intent);
      if (noted) await appendTicket(ticketRef, event.text);
      // Pedido de corrida por etapas (nome, saida, destino, SIM). Fora dele, o atendimento segue igual.
      const booked = booking && settings.pedidoWhatsapp !== false
        ? await booking.handle(event, intent).catch((error) => {
          console.error('whatsapp booking failed', String(error?.message || '').slice(0, 160));
          return { text: 'Tive um problema para registrar o seu pedido agora 😕 Tente de novo em instantes, peça pelo app: https://nexusmotoja.com.br/ ou escreva ATENDENTE.' };
        })
        : null;
      // Greetings and help must work even when the ride lookup is unavailable.
      const ride = !booked && event.phone && ['status', 'human', 'other', 'cancel', 'payment'].includes(intent) ? await findRide(event.phone, event.text, context).catch(() => null) : null;
      const jobKind = ride?.kind || 'corridas';
      const jobExpireMs = jobKind === 'entregas' ? deliveryExpireMs : rideExpireMs;
      const complaint = WAITING_COMPLAINT.test(plain(event.text));
      let answer = booked ? { topic: 'pedido', text: booked.text } : supportAnswer(event.text, ride, jobExpireMs, now(), context);
      let action = 'none', aiState = { aiContextCriptografado: '', aiContextUntil: 0 }, fromAi = false;
      // The AI talks with the customer like a person, now knowing the ride situation (no phone,
      // address or code). Menu choices and an explicit ATENDENTE stay deterministic.
      if (!booked && event.text.trim() && !['human', 'menu', 'greeting'].includes(intent) && !/^[0-7]$/.test(event.text.trim())) {
        let history = [];
        try { if (context.aiContextUntil > now() && context.aiContextCriptografado) history = JSON.parse(decrypt(context.aiContextCriptografado)); } catch { /* Ignore expired or unreadable history. */ }
        const facts = rideFacts(ride, !!event.phone, ['status', 'other', 'cancel', 'payment'].includes(intent), jobExpireMs, now());
        const generated = await generateReply({ text: event.text, history: Array.isArray(history) ? history : [], topic: context.topic || 'menu', facts, name: context.name }, settings).catch(() => null);
        if (generated?.answer?.human) { answer = supportAnswer('ATENDENTE', ride, rideExpireMs, now(), context); action = 'atendente'; }
        // A reply saying the ride was accepted must match the real ride state.
        else if (generated?.answer?.text && !(/\b(foi|esta|ja esta|ja foi) aceit|motoboy (ja )?aceitou|alguem (ja )?aceitou/.test(plain(generated.answer.text)) && !ACTIVE.includes(ride?.status))) {
          const first =!context.lastReplyAt || context.lastReplyAt < now() - 30 * 60000;
          answer = { topic: generated.answer.topic, text: (first ? 'Aqui é o atendimento automático da Nexus MotoJá.\n\n' : '') + generated.answer.text + (first ? FOOTER : '') };
          action = generated.answer.action || 'none';
          aiState = { aiContextCriptografado: encrypt(JSON.stringify(generated.history || [])), aiContextUntil: now() + 30 * 60000 };
          fromAi = true;
        }
      }
      // Without AI, a waiting complaint still triggers the same help a person would give.
      if (!booked && !fromAi && action === 'none' && complaint && ride) action = ride.status === 'pendente' ? 'reforco_motoboys' : ACTIVE.includes(ride.status) ? 'avisar_motoboy_da_corrida' : 'none';
      // Every action is checked here: owned ride (findRide), live state and rate limits.
      const notes = [];
      if (action === 'reforco_motoboys' && ride?.status === 'pendente' && settings.groupAlerts) {
        const ref = db.collection(jobKind).doc(ride.id);
        const results = [];
        results.push(await notify(ref, jobKind, 'customer', 'whatsapp', settings).catch(() => ({ channel: 'whatsapp', status: 'failed' })));
        results.push(await notify(ref, jobKind, 'customer', 'telegram', settings).catch(() => ({ channel: 'telegram', status: 'failed' })));
        const current = await ref.get().catch(() => null);
        const freshRide = current?.exists ? { ...current.data(), kind: jobKind, id: current.id } : null;
        const stillPending = freshRide?.status === 'pendente' && now() - ms(freshRide.criadaEm) < jobExpireMs;
        const labels = { whatsapp: 'grupo dos motoboys no WhatsApp', telegram: 'Telegram' };
        const sent = results.filter(result => result.status === 'sent').map(result => labels[result.channel]);
        const recent = results.filter(result => result.status === 'recent').map(result => labels[result.channel]);
        const failed = results.some(result => result.status === 'failed');
        const detail = `${sent.length ? `Enviei um reforço ao ${sent.join(' e ao ')}. ` : ''}${recent.length ? `Já há um aviso recente no ${recent.join(' e no ')}. ` : ''}${failed ? 'Não consegui confirmar o envio em todos os grupos. ' : ''}`.trim();
        if (!current) notes.push('Não consegui confirmar a etapa atual do pedido agora. Confira pelo app ou escreva ATENDENTE para uma pessoa verificar.');
        else if (!stillPending) {
          if (fromAi) notes.push(ACTIVE.includes(freshRide?.status) ? `Boa notícia: sua ${jobKind === 'entregas' ? 'entrega' : 'corrida'} acabou de ser aceita! Confira os dados do motoboy no app.` : 'Acabei de conferir e a etapa do pedido mudou. Confira no app.');
          else answer = supportAnswer(event.text, freshRide, jobExpireMs, now(), context);
        } else if (fromAi) notes.push(detail || 'Vou deixar o pedido em destaque para os motoboys.');
        else answer = { topic: jobKind === 'entregas' ? 'delivery' : 'status', text: `${empathy(context.name)}Sua ${jobKind === 'entregas' ? 'entrega' : 'corrida'} ainda está aguardando aceite. ${detail ? `${detail} ` : ''}Não consigo garantir um motoboy ou horário de chegada, mas assim que alguém aceitar você vê no app.${FOOTER}` };
      } else if (action === 'avisar_motoboy_da_corrida' && ride && ACTIVE.includes(ride.status)) {
        const result = await nudgeDriver(ride, jobKind).catch(() => 'failed');
        notes.push(result === 'sent' ? 'Dei um toque no motoboy da sua corrida avisando que você está esperando. Pelo app você acompanha onde ele está e fala com ele no chat da corrida.'
          : result === 'recent' ? 'O motoboy já foi avisado há poucos minutos. Pelo app você acompanha onde ele está e fala com ele no chat da corrida.'
          : 'Não consegui avisar o motoboy agora. Fale com ele pelo chat da corrida no app ou escreva ATENDENTE.');
      } else if (action === 'atendente' && !answer.human) {
        answer.human = true;
        notes.push('Passei sua conversa para uma pessoa da equipe. O retorno depende de alguém disponível, mas sigo por aqui com você enquanto isso.');
      }
      if (noted) notes.unshift('Anotei sua mensagem no pedido de atendimento, para a equipe ver.');
      if (notes.length) answer.text = fromAi || !answer.text ? `${answer.text}\n\n${notes.join('\n\n')}` : `${notes.join('\n\n')}\n\n${answer.text}`;
      // Record fingerprint before sending because the provider can echo before POST returns.
      answer.text = answer.text.replace(/https:\/\/nexusmotoja\.com\.br\/(?:empresa\.html)?(?:\?origem=suporte&v=202)?(?=\s|$)/g, url => url.includes('empresa.html') ? `${APP}empresa.html?origem=suporte&v=202` : SHARED_APP);
      if (event.ageMs > 2 * 60000) answer.text = `Desculpe a demora para responder!\n\n${answer.text}`;
      remember(outgoingEchoes, hash(`${event.phone}:${answer.text}`), true);
      await chatRef.set({ ...aiState, outgoingHash: hash(answer.text), outgoingUntil: now() + 120000, lastIncomingHash: hash(event.text), topic: answer.topic || context.topic || 'menu', lastReplyAt: now(), ...(answer.human ? { awaitingHuman: true, pausedUntil: 0, pauseReason: '' } : {}) }, { merge: true });
      if (answer.human) await ticketRef.set({ telefoneCriptografado: encrypt(contact), ultimaMensagemCriptografada: encrypt(event.text), rideId: ride?.id || '', status: 'aguardando', requestedAt: now(), expiresAt: null }, { merge: true });      // "digitando..." like a person would, without blocking the answer if it fails.
      await typing(event.replyTo).catch(() => {});
      const sent = await sendText(event.replyTo, answer.text);
      await chatRef.set({ outgoingId: sent.id || '', busyUntil: 0 }, { merge: true });
      result = { replied: !!sent.sent, human: !!answer.human };
    } catch (error) {
      await chatRef.set({ busyUntil: 0 }, { merge: true });
      throw error;
    }
    // Answer what the customer sent while the previous reply was going out.
    if (!queuedChats.delete(chatRef.id)) return result;
    const after = (await chatRef.get()).data() || {};
    if (after.pendingTextCriptografado || after.pendingLocationCriptografada) {
      let pendingText = '', pendingLocation = null;
      try { pendingText = after.pendingTextCriptografado ? decrypt(after.pendingTextCriptografado) : ''; } catch { pendingText = ''; }
      try { pendingLocation = after.pendingLocationCriptografada ? JSON.parse(decrypt(after.pendingLocationCriptografada)) : null; } catch { pendingLocation = null; }
      await chatRef.set({ pendingTextCriptografado: '', pendingLocationCriptografada: '', pendingName: '' }, { merge: true });
      if (pendingText.trim() || pendingLocation) {
        const next = await processEvent({ ...event, id: `${event.id}:seguinte`.slice(0, 160), text: pendingText, location: pendingLocation, ageMs: 0 }, settings);
        result = { ...result, followUp: !!next.replied };
      }
    }
    return result;
  }
  async function notify(ref, kind, stage, channel, settings, snapshotData) {
    const initial = snapshotData ? { data: () => snapshotData, id: ref.id } : await ref.get();
    const job = { ...initial.data(), id: initial.id };
    const expire = kind === 'corridas' ? rideExpireMs : deliveryExpireMs;
    if (!pendingNotice(job, kind, stage, expire, now())) return { channel, status: 'ignored' };
    // Each city has its own drivers group; without one, nothing is sent (never another city's group).
    const target = channel === 'whatsapp' ? await groupFor(job, kind, settings).catch(() => '') : '';
    if (channel === 'whatsapp' && !target) return { channel, status: 'ignored' };
    const marker = db.collection('supportAutomationNotices').doc(hash(`${kind}:${job.id}:${ms(job.criadaEm)}:${stage}:${channel}`));
    const memo = completedNotices.get(marker.id);
    if (memo?.until > now()) return { channel, status: memo.value };
    const lastMarker = db.collection('supportAutomationNotices').doc(hash(`${kind}:${job.id}:${ms(job.criadaEm)}:last:${channel}`));
    let claim = false, status = 'ignored', completed = false;
    await db.runTransaction(async tx => {
      claim = false; status = 'ignored'; completed = false;
      // Include legacy initial/reminder markers when upgrading an existing deployment.
      const [previous, ...notices] = await Promise.all([tx.get(marker), tx.get(lastMarker), ...['initial', 'reminder'].map(value => tx.get(db.collection('supportAutomationNotices').doc(hash(`${kind}:${job.id}:${ms(job.criadaEm)}:${value}:${channel}`))))]);
      if (previous.exists) { completed = true; status = previous.data().status === 'sent' ? 'recent' : previous.data().status === 'failed' ? 'failed' : 'sending'; return; }
      if (stage === 'customer' || stage.startsWith('reminder')) {
        const active = notices.map(snap => snap.data()).find(data => data && ['claimed', 'sent'].includes(data.status) && ms(data.createdAt) > now() - 60000);
        if (active) { status = active.status === 'sent' ? 'recent' : 'sending'; return; }
      }
      tx.set(marker, { createdAt: now(), expiresAt: new Date(now() + 7 * 86400000), status: 'claimed' });
      tx.set(lastMarker, { createdAt: now(), expiresAt: new Date(now() + 7 * 86400000), status: 'claimed' });
      claim = true;
    });
    if (!claim) {
      if (['recent', 'failed'].includes(status)) remember(completedNotices, marker.id, status, completed ? expire : 30000);
      return { channel, status };
    }
    const current = await ref.get();
    const fresh = { ...current.data(), id: current.id };
    const text = ms(fresh.criadaEm) === ms(job.criadaEm) && pendingNotice(fresh, kind, stage, expire, now());
    if (!text) return { channel, status: 'ignored' };
    // At most one attempt: an ambiguous network timeout must not spam a group.
    try {
      const sent = channel === 'whatsapp' ? await sendText(target, text) : await sendTelegram(fresh, text, kind);
      if (channel === 'whatsapp') recordGroupNotice(sent.sent ? 'sent' : 'failed', sent.sent ? '' : sent.reason || 'envio_nao_confirmado');
      await marker.set({ status: sent.sent ? 'sent' : 'failed', completedAt: now() }, { merge: true });
      await lastMarker.set({ status: sent.sent ? 'sent' : 'failed', completedAt: now() }, { merge: true });
      remember(completedNotices, marker.id, sent.sent ? 'recent' : 'failed', expire);
      return { channel, status: sent.sent ? 'sent' : 'failed' };
    } catch (error) {
      if (channel === 'whatsapp') recordGroupNotice('failed', error?.message || 'erro_desconhecido');
      await marker.set({ status: 'failed', completedAt: now() }, { merge: true });
      await lastMarker.set({ status: 'failed', completedAt: now() }, { merge: true });
      remember(completedNotices, marker.id, 'failed', expire);
      return { channel, status: 'failed' };
    }
  }
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const settings = await config();
      if (!settings.enabled || !settings.groupAlerts) return;
      for (const kind of ['corridas', 'entregas']) {
        const pending = await db.collection(kind).where('status', '==', 'pendente').get();
        for (const doc of pending.docs) {
          const reminders = kind === 'corridas' ? Array.from({ length: Math.max(0, Math.ceil(rideExpireMs / 120000) - 1) }, (_, index) => index === 0 ? 'reminder' : `reminder-${(index + 1) * 2}m`) : ['reminder'];
          await notify(doc.ref, kind, 'initial', 'whatsapp', settings, doc.data());
          for (const stage of reminders) await notify(doc.ref, kind, stage, 'whatsapp', settings, doc.data());
          for (const stage of reminders) await notify(doc.ref, kind, stage, 'telegram', settings, doc.data());
        }
      }
      if (now() - lastPrune >= 3600000) {
        lastPrune = now();
        for (const name of ['supportAutomationEvents', 'supportAutomationChats', 'supportAutomationNotices', 'supportAutomationTickets', 'whatsappPedidos']) {
          const expired = await db.collection(name).where('expiresAt', '<', new Date(now())).limit(100).get();
          if (!expired.empty) {
            const batch = db.batch();
            expired.docs.forEach(doc => { if (name !== 'supportAutomationTickets' || doc.data().status === 'resolvido') batch.delete(doc.ref); });
            await batch.commit();
          }
        }
      }
    } finally { ticking = false; }
  }
  return { config, saveConfig, handle, tick, groupNoticeStatus: () => lastGroupNotice, recordGroupNotice };
}
