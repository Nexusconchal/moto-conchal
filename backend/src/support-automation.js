import crypto from 'node:crypto';

const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const plain = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const ms = value => typeof value?.toMillis === 'function' ? value.toMillis() : Number(value || 0);
export const SUPPORT_PHONE = '5519992306488';
export const DRIVER_GROUP_NAME = 'Nexus MotoJá - MOTORISTA';
const APP = 'https://nexusmotoja.com.br/';
const DRIVER_APP = `${APP}motoboy.html`;

export function brazilPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  const national = digits.startsWith('55') && digits.length > 11 ? digits.slice(2) : digits;
  return /^\d{10,11}$/.test(national) ? `55${national}` : '';
}

export function parseSupportMessage(body, instance, now = Date.now()) {
  if (body?.instance !== instance || !['messages.upsert', 'MESSAGES_UPSERT', 'send.message', 'SEND_MESSAGE'].includes(body?.event)) return null;
  const data = body.data;
  if (!data || Array.isArray(data) || !data.key?.id) return null;
  const jid = String(data.key.remoteJid || '');
  if (!/@(?:s\.whatsapp\.net|lid)$/.test(jid)) return null;
  const phoneJid = jid.endsWith('@lid') ? String(data.key.remoteJidAlt || '') : jid;
  if (!phoneJid.endsWith('@s.whatsapp.net')) return null; // Never interpret a LID as a phone.
  const phone = brazilPhone(phoneJid.split('@')[0]);
  const time = Number(data.messageTimestamp?.low ?? data.messageTimestamp) * 1000;
  if (!phone || !Number.isFinite(time) || now - time > 5 * 60000 || time > now + 60000) return null;
  const message = data.message || {};
  const text = String(message.conversation || message.extendedTextMessage?.text || '').slice(0, 2000);
  if (!text && !message.audioMessage && !message.imageMessage && !message.locationMessage && !message.documentMessage) return null;
  return { id: String(data.key.id).slice(0, 160), phone, fromMe: data.key.fromMe === true, text };
}

export function requestedRideId(text) {
  return String(text).match(/\b[a-f0-9]{8,12}-\d{6,12}\b/i)?.[0]
    || String(text).match(/(?:codigo(?: da corrida)?|corrida|pedido)\s*[:#]\s*([a-zA-Z0-9_-]{8,80})\b/i)?.[1] || '';
}

export function supportAnswer(text, ride, expireMs, now = Date.now()) {
  const t = plain(text);
  const human = /\b(humano|pessoa|atendente|reclamacao|reclamar|acidente|emergencia|nao responde|nao tem troco)\b/.test(t);
  if (human) return { human: true, text: 'Sou o atendimento automático da Nexus MotoJá. Registrei seu pedido de atendimento humano. Vou pausar as respostas automáticas por 30 minutos. O retorno depende da disponibilidade do suporte; não consigo garantir um prazo.' };
  if (!String(text).trim()) return { text: 'Sou o atendimento automático da Nexus MotoJá. Ainda não interpreto áudio, imagem ou localização recebida aqui. Escreva sua dúvida ou o código da corrida. Para uma pessoa, escreva ATENDENTE.' };
  let status = '';
  if (ride) {
    const expired = ride.status === 'pendente' && now - ms(ride.criadaEm) >= expireMs;
    if (expired || ride.status === 'expirada') status = 'Sua solicitação expirou sem aceite. Abra o app e confira a opção de renovar ou pedir novamente. Não renovei nem criei outra corrida por aqui.';
    else if (ride.status === 'pendente') status = 'Sua corrida está aguardando um motoboy aceitar. Ainda não há motorista confirmado. Os avisos são enviados aos grupos habilitados, mas não consigo garantir disponibilidade ou horário de chegada.';
    else if (['aceita', 'em_andamento', 'iniciada'].includes(ride.status)) status = 'Sua corrida já foi aceita. Confira no app os dados do motoboy e a etapa do atendimento. Não tenho uma previsão de chegada confirmada.';
    else if (ride.status === 'cancelada') status = 'Sua corrida está cancelada. Para uma nova solicitação, abra o app.';
    else if (['finalizada', 'concluida'].includes(ride.status)) status = 'Sua corrida consta como finalizada. Para falar sobre o atendimento, escreva ATENDENTE.';
    else status = 'Encontrei sua solicitação. Confira a etapa atual no app ou escreva ATENDENTE.';
  } else status = 'Não encontrei uma corrida recente vinculada a este WhatsApp. Use no app o mesmo número desta conversa. Se já pediu, envie o código da corrida; se precisar de ajuda, escreva ATENDENTE.';
  if (/endereco|localizacao|gps|cosmopolis|calcular|calcula|mapa|erro|nao consigo|nao conseguindo/.test(t)) status += '\n\nPara calcular, informe rua, número e cidade no destino (ex.: Av. Centenário Dr. Paulo de A. Nogueira, 421, Cosmópolis). Confira o ponto no mapa. Se o GPS da origem estiver incorreto, digite o endereço de saída. Enviar endereço aqui não solicita a corrida.';
  return { text: `Sou o atendimento automático da Nexus MotoJá.\n\n${status}\n\nApp: ${APP}\nPara atendimento humano, escreva ATENDENTE.` };
}

export function chooseDriverGroup(groups) {
  const matches = (Array.isArray(groups) ? groups : []).filter(group => plain(group.subject).replace(/\s+/g, ' ').trim() === plain(DRIVER_GROUP_NAME) && /^\d+@g\.us$/.test(group.id));
  return matches.length === 1 ? matches[0] : null;
}

export function pendingNotice(job, kind, stage, expireMs, now = Date.now()) {
  const age = now - ms(job.criadaEm);
  if (job.status !== 'pendente' || !ms(job.criadaEm) || age < (stage === 'reminder' ? 120000 : 0) || (stage === 'initial' && age >= 120000) || age >= expireMs) return '';
  const value = Number(job.valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  return `${stage === 'reminder' ? 'ATENÇÃO, MOTOBOYS: solicitação aguardando há pelo menos 2 minutos' : 'NOVA SOLICITAÇÃO NEXUS MOTOJÁ'}\n${kind === 'corridas' ? 'Corrida' : 'Entrega'} disponível: ${value}.\nQuem estiver disponível, confira e aceite no app:\n${DRIVER_APP}\nCódigo: ${job.id}\nA disponibilidade deve ser conferida no app. Não confirme pelo grupo.`;
}

// This assistant never creates bookings, changes fares or accepts a job.
export function createSupportAutomation({ db, sendText, encrypt, instance, rideExpireMs, deliveryExpireMs, sendTelegram, now = () => Date.now() }) {
  const configRef = db.collection('configuracoes').doc('atendimentoAutomatico');
  let cache, cacheUntil = 0, ticking = false, lastPrune = 0;
  async function config(refresh = false) {
    if (!refresh && cache && cacheUntil > now()) return cache;
    cache = (await configRef.get()).data() || {};
    cacheUntil = now() + 60000;
    return cache;
  }
  async function saveConfig(data) {
    await configRef.set(data, { merge: true }); cacheUntil = 0;
  }
  async function findRide(phone, text) {
    const id = requestedRideId(text);
    if (id) {
      const snap = await db.collection('corridas').doc(id).get();
      const ride = snap.data();
      return ride && brazilPhone(ride.telefoneCliente) === phone ? { ...ride, id: snap.id } : null;
    }
    const result = await db.collection('corridas').where('telefoneCliente', '==', phone.slice(2)).get();
    const rides = result.docs.map(snap => ({ ...snap.data(), id: snap.id })).filter(ride => now() - ms(ride.criadaEm) < 86400000).sort((a, b) => ms(b.criadaEm) - ms(a.criadaEm));
    const active = rides.filter(ride => ['pendente', 'aceita', 'iniciada', 'em_andamento'].includes(ride.status));
    if (active.length > 1) return null;
    return active[0] || rides[0] || null;
  }
  async function handle(body) {
    const settings = await config();
    if (!settings.enabled) return { ignored: true };
    const event = parseSupportMessage(body, instance, now());
    if (!event) return { ignored: true };
    const wantsHuman = !event.fromMe && supportAnswer(event.text, null, rideExpireMs, now()).human === true;
    const chatRef = db.collection('supportAutomationChats').doc(hash(event.phone));
    const messageRef = db.collection('supportAutomationEvents').doc(hash(`${instance}:${event.id}`));
    let claim = false;
    await db.runTransaction(async tx => {
      claim = false;
      const [message, chat] = await Promise.all([tx.get(messageRef), tx.get(chatRef)]);
      if (message.exists) return;
      const state = chat.data() || {};
      tx.set(messageRef, { createdAt: now(), expiresAt: new Date(now() + 86400000) });
      if (event.fromMe) {
        if (!(state.outgoingHash === hash(event.text) && state.outgoingUntil > now()) && event.id !== state.outgoingId) tx.set(chatRef, { pausedUntil: now() + 30 * 60000 }, { merge: true });
        return;
      }
      if (state.pausedUntil > now() || (!wantsHuman && state.lastReplyAt > now() - 15000) || state.busyUntil > now()) return;
      tx.set(chatRef, { busyUntil: now() + 60000, expiresAt: new Date(now() + 7 * 86400000) }, { merge: true });
      claim = true;
    });
    if (!claim) return { ignored: true };
    try {
      const ride = await findRide(event.phone, event.text);
      const answer = supportAnswer(event.text, ride, rideExpireMs, now());
      // Record fingerprint before sending because the provider can echo before POST returns.
      await chatRef.set({ outgoingHash: hash(answer.text), outgoingUntil: now() + 120000, lastReplyAt: now(), ...(answer.human ? { pausedUntil: now() + 30 * 60000 } : {}) }, { merge: true });
      if (answer.human) await db.collection('supportAutomationTickets').doc(hash(event.phone)).set({ telefoneCriptografado: encrypt(event.phone), rideId: ride?.id || '', status: 'aguardando', requestedAt: now() }, { merge: true });
      const sent = await sendText(event.phone, answer.text);
      await chatRef.set({ outgoingId: sent.id || '', busyUntil: 0 }, { merge: true });
      return { replied: !!sent.sent, human: !!answer.human };
    } catch (error) {
      await chatRef.set({ busyUntil: 0 }, { merge: true });
      throw error;
    }
  }
  async function notify(ref, kind, stage, channel, settings) {
    const initial = await ref.get();
    const job = { ...initial.data(), id: initial.id };
    const expire = kind === 'corridas' ? rideExpireMs : deliveryExpireMs;
    if (!pendingNotice(job, kind, stage, expire, now())) return;
    const marker = db.collection('supportAutomationNotices').doc(hash(`${kind}:${job.id}:${ms(job.criadaEm)}:${stage}:${channel}`));
    let claim = false;
    await db.runTransaction(async tx => {
      claim = false;
      const previous = await tx.get(marker);
      if (previous.exists) return;
      tx.set(marker, { createdAt: now(), expiresAt: new Date(now() + 7 * 86400000), status: 'claimed' });
      claim = true;
    });
    if (!claim) return;
    const current = await ref.get();
    const fresh = { ...current.data(), id: current.id };
    const text = ms(fresh.criadaEm) === ms(job.criadaEm) && pendingNotice(fresh, kind, stage, expire, now());
    if (!text) return;
    // At most one attempt: an ambiguous network timeout must not spam a group.
    try {
      const sent = channel === 'whatsapp' ? await sendText(settings.driverGroupJid, text) : await sendTelegram(fresh, text);
      await marker.set({ status: sent.sent ? 'sent' : 'failed', completedAt: now() }, { merge: true });
    } catch {
      await marker.set({ status: 'failed', completedAt: now() }, { merge: true });
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
          if (settings.driverGroupJid) {
            await notify(doc.ref, kind, 'initial', 'whatsapp', settings);
            await notify(doc.ref, kind, 'reminder', 'whatsapp', settings);
          }
          await notify(doc.ref, kind, 'reminder', 'telegram', settings);
        }
      }
      if (now() - lastPrune >= 3600000) {
        lastPrune = now();
        for (const name of ['supportAutomationEvents', 'supportAutomationChats', 'supportAutomationNotices', 'supportAutomationTickets']) {
          const expired = await db.collection(name).where('expiresAt', '<', new Date(now())).limit(100).get();
          if (!expired.empty) {
            const batch = db.batch();
            expired.docs.forEach(doc => batch.delete(doc.ref));
            await batch.commit();
          }
        }
      }
    } finally { ticking = false; }
  }
  return { config, saveConfig, handle, tick };
}
