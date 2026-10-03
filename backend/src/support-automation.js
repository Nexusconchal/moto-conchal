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
  const phoneJid = jid.endsWith('@lid') ? String(data.key.remoteJidAlt || data.key.senderPn || data.senderPn || '') : jid;
  if (!phoneJid.endsWith('@s.whatsapp.net')) return null; // Never interpret a LID as a phone.
  const phone = brazilPhone(phoneJid.split('@')[0]);
  const time = Number(data.messageTimestamp?.low ?? data.messageTimestamp) * 1000;
  if (!phone || !Number.isFinite(time) || now - time > 5 * 60000 || time > now + 60000) return null;
  const rawMessage = data.message || {};
  const message = rawMessage.ephemeralMessage?.message || rawMessage.viewOnceMessage?.message || rawMessage;
  const text = String(message.conversation || message.extendedTextMessage?.text || message.buttonsResponseMessage?.selectedButtonId || message.listResponseMessage?.singleSelectReply?.selectedRowId || '').slice(0, 2000);
  if (!text && !message.audioMessage && !message.imageMessage && !message.locationMessage && !message.documentMessage) return null;
  return { id: String(data.key.id).slice(0, 160), phone, fromMe: data.key.fromMe === true, text };
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

const MENU = '1 • Pedir corrida\n2 • Acompanhar corrida\n3 • Endereço ou erro no app\n4 • Pagamento e troco\n5 • Falar com uma pessoa';
const FOOTER = '\n\nDigite MENU para ver as opções ou ATENDENTE para falar com uma pessoa.';
export function supportIntent(text) {
  const t = plain(text).trim();
  if (/^(menu|inicio|voltar|0)$/.test(t)) return 'menu';
  if (t === '5' || /\b(humano|pessoa|atendente|reclamacao|reclamar|acidente|emergencia|nao responde|nao tem troco)\b/.test(t)) return 'human';
  if (t === '3' || /endereco|localizacao|gps|cosmopolis|calcular|calcula|mapa|erro|nao consigo|nao conseguindo|nao funciona/.test(t)) return 'address';
  if (t === '4' || /pagamento|pagar|pix|dinheiro|troco|cartao|valor|preco|quanto/.test(t)) return 'payment';
  if (t === '2' || requestedRideId(text) || /acompanhar|aguard|esper|aceit|demor|motorista|motoboy|confirmar/.test(t)) return 'status';
  if (t === '1' || /pedir|chamar|preciso|quero.*corrida|solicitar|como.*corrida/.test(t)) return 'request';
  if (/^(oi|ola|opa|bom dia|boa tarde|boa noite|tudo bem)[!?.\s]*$/.test(t)) return 'greeting';
  if (/^(obrigad[oa]|valeu|vlw|ok|certo|beleza)[!?.\s]*$/.test(t)) return 'thanks';
  return 'other';
}
export function supportAnswer(text, ride, expireMs, now = Date.now(), context = {}) {
  const t = plain(text);
  const intent = supportIntent(text);
  if (intent === 'human') return { human: true, topic: 'human', text: 'Registrei seu pedido para uma pessoa do suporte. Qual é o problema? Pode escrever aqui; sua mensagem ficará junto do pedido. O retorno depende de alguém disponível.\n\nEnquanto aguarda, digite MENU se quiser voltar à ajuda automática.' };
  if (!String(text).trim()) return { text: 'Sou o atendimento automático da Nexus MotoJá. Ainda não interpreto áudio, imagem ou localização recebida aqui. Escreva sua dúvida ou o código da corrida. Para uma pessoa, escreva ATENDENTE.' };
  if (intent === 'menu' || intent === 'greeting') return { topic: 'menu', text: `Olá! Sou o atendimento automático da Nexus MotoJá. Posso ajudar com sua corrida. O que você precisa?\n\n${MENU}\n\nPode responder com o número ou escrever sua dúvida.` };
  if (intent === 'thanks') return { topic: context.topic || 'menu', text: `Por nada! Se precisar de mais ajuda, é só escolher uma opção.\n\n${MENU}` };
  if (intent === 'request') return { topic: 'request', text: `Vamos lá! Abra ${APP}\n\n1. Informe o endereço de saída ou use sua localização.\n2. Coloque rua, número e cidade do destino.\n3. Calcule, confira o valor e o mapa e toque em “Chamar motoboy”.\n\nA corrida fica confirmada quando um motorista aceitar. Você está com dificuldade no endereço ou já pediu e está esperando?${FOOTER}` };
  if (intent === 'address' || (intent === 'other' && context.topic === 'address')) return { topic: 'address', text: `${context.topic === 'address' ? 'Obrigado pelo detalhe. ' : ''}O problema é no endereço de saída, no destino ou aparece alguma mensagem de erro?\n\nNo app, escreva rua, número e cidade. Confira o ponto no mapa antes de pedir. Se o GPS estiver errado, digite a saída manualmente. Para outra cidade, inclua o nome dela no destino.\n\nSe continuar falhando, envie o texto do erro e escreva ATENDENTE para o suporte verificar. Enviar o endereço aqui não cria uma corrida.${FOOTER}` };
  if (intent === 'payment') return { topic: 'payment', text: `O preço é calculado no app antes de chamar. Confira as formas de pagamento disponíveis nele.\n\nSe for pagar em dinheiro e precisar de troco, informe para quanto nas observações e confirme com o motorista após o aceite. Não tenho como garantir que ele terá troco.\n\nSe houve cobrança indevida ou dificuldade com o pagamento, escreva ATENDENTE e explique o que aconteceu. Não envie senha, código de confirmação ou dados de cartão aqui.${FOOTER}` };
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
  if (intent === 'other' && !ride) return { topic: 'menu', text: `Posso te ajudar a pedir ou acompanhar uma corrida, resolver endereço e tirar dúvidas de pagamento. Qual dessas opções combina com o que você precisa?\n\n${MENU}\n\nApp: ${APP}` };
  return { topic: 'status', text: `${status}\n\nApp: ${APP}${FOOTER}` };
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

// This assistant never creates bookings, changes fares or accepts a job.
export function createSupportAutomation({ db, sendText, encrypt, decrypt = () => '', generateReply = async () => null, instance, rideExpireMs, deliveryExpireMs, sendTelegram, isSystemOutgoing = () => false, now = () => Date.now() }) {
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
    if (Array.isArray(body?.data)) {
      const results = [];
      for (const data of body.data.slice(0, 50)) results.push(await handle({ ...body, data }));
      return { replied: results.some(result => result.replied), processed: results.length };
    }
    const event = parseSupportMessage(body, instance, now());
    if (!event) return { ignored: true };
    const intent = supportIntent(event.text);
    const wantsHuman = !event.fromMe && intent === 'human';
    const resumes = !event.fromMe && intent === 'menu';
    const chatRef = db.collection('supportAutomationChats').doc(hash(event.phone));
    const messageRef = db.collection('supportAutomationEvents').doc(hash(`${instance}:${event.id}`));
    let claim = false, context = {}, waitingHuman = false;
    await db.runTransaction(async tx => {
      claim = false;
      const [message, chat] = await Promise.all([tx.get(messageRef), tx.get(chatRef)]);
      if (message.exists) return;
      const state = chat.data() || {};
      context = state;
      tx.set(messageRef, { createdAt: now(), expiresAt: new Date(now() + 86400000) });
      if (event.fromMe) {
        if (!isSystemOutgoing(event) && !(state.outgoingHash === hash(event.text) && state.outgoingUntil > now()) && event.id !== state.outgoingId) tx.set(chatRef, { pausedUntil: now() + 30 * 60000, pauseReason: 'manual' }, { merge: true });
        return;
      }
      if (state.pausedUntil > now() && !resumes) { waitingHuman = state.pauseReason === 'human' || state.topic === 'human'; return; }
      if ((!wantsHuman && !resumes && state.lastReplyAt > now() - 2000 && state.lastIncomingHash === hash(event.text)) || state.busyUntil > now()) return;
      tx.set(chatRef, { busyUntil: now() + 60000, ...(resumes ? { pausedUntil: 0, pauseReason: '', aiContextCriptografado: '', aiContextUntil: 0 } : {}), expiresAt: new Date(now() + 7 * 86400000) }, { merge: true });
      claim = true;
    });
    if (!claim) {
      if (waitingHuman && event.text.trim()) await db.collection('supportAutomationTickets').doc(hash(event.phone)).set({ ultimaMensagemCriptografada: encrypt(event.text), updatedAt: now() }, { merge: true });
      return { ignored: true };
    }
    try {
      // Greetings and help must work even when the ride lookup is unavailable.
      const ride = ['status', 'human', 'other'].includes(intent) ? await findRide(event.phone, event.text).catch(() => null) : null;
      let answer = supportAnswer(event.text, ride, rideExpireMs, now(), context);
      // Customer complaints can request a real group notice, never an AI action.
      // Ownership is checked by findRide and notify rechecks the live job before sending.
      if (intent === 'status' && ride?.status === 'pendente' && /demor|aguard|esper|nao.*aceit|ninguem.*aceit/.test(plain(event.text)) && settings.groupAlerts) {
        const ref = db.collection('corridas').doc(ride.id);
        const results = [];
        if (settings.driverGroupJid) results.push(await notify(ref, 'corridas', 'customer', 'whatsapp', settings).catch(() => ({ channel: 'whatsapp', status: 'failed' })));
        results.push(await notify(ref, 'corridas', 'customer', 'telegram', settings).catch(() => ({ channel: 'telegram', status: 'failed' })));
        const current = await ref.get().catch(() => null);
        const freshRide = current?.exists ? { ...current.data(), id: current.id } : null;
        answer = current ? supportAnswer(event.text, freshRide, rideExpireMs, now(), context) : { topic: 'status', text: `Não consegui confirmar a etapa atual da corrida agora. Confira pelo app ou escreva ATENDENTE para uma pessoa verificar.${FOOTER}` };
        const stillPending = freshRide?.status === 'pendente' && now() - ms(freshRide.criadaEm) < rideExpireMs;
        if (stillPending) {
          const labels = { whatsapp: 'grupo dos motoboys no WhatsApp', telegram: 'Telegram' };
          const sent = results.filter(result => result.status === 'sent').map(result => labels[result.channel]);
          const recent = results.filter(result => result.status === 'recent').map(result => labels[result.channel]);
          const failed = results.some(result => result.status === 'failed');
          const detail = sent.length ? `Enviei um reforço ao ${sent.join(' e ao ')}. ` : '';
          const previous = recent.length ? `Já há um aviso recente no ${recent.join(' e no ')}. ` : '';
          const failure = failed ? 'Não consegui confirmar o envio em todos os grupos. ' : '';
          answer.text = `Sua corrida ainda está aguardando aceite. ${detail}${previous}${failure}Não consigo garantir um motoboy ou horário de chegada. Você pode acompanhar pelo app ou escrever ATENDENTE para uma pessoa verificar.${FOOTER}`;
        }
      }
      let aiState = { aiContextCriptografado: '', aiContextUntil: 0 };
      // Booking facts, media, explicit handoff and numeric menu choices stay deterministic.
      if (event.text.trim() && !['status', 'human', 'menu'].includes(intent) && !/^[0-5]$/.test(event.text.trim())) {
        let history = [];
        try { if (context.aiContextUntil > now() && context.aiContextCriptografado) history = JSON.parse(decrypt(context.aiContextCriptografado)); } catch { /* Ignore expired or unreadable history. */ }
        const generated = await generateReply({ text: event.text, history: Array.isArray(history) ? history : [], topic: context.topic || 'menu' }, settings).catch(() => null);
        if (generated?.answer?.human) answer = supportAnswer('ATENDENTE', ride, rideExpireMs, now(), context);
        else if (generated?.answer?.text) {
          const introduction = !context.lastReplyAt || context.lastReplyAt < now() - 30 * 60000 ? 'Sou o atendimento automático da Nexus MotoJá.\n\n' : '';
          answer = { topic: generated.answer.topic, text: introduction + generated.answer.text + FOOTER };
          aiState = { aiContextCriptografado: encrypt(JSON.stringify(generated.history || [])), aiContextUntil: now() + 30 * 60000 };
        }
      }
      // Record fingerprint before sending because the provider can echo before POST returns.
      await chatRef.set({ ...aiState, outgoingHash: hash(answer.text), outgoingUntil: now() + 120000, lastIncomingHash: hash(event.text), topic: answer.topic || context.topic || 'menu', lastReplyAt: now(), ...(answer.human ? { pausedUntil: now() + 30 * 60000, pauseReason: 'human' } : {}) }, { merge: true });
      if (answer.human) await db.collection('supportAutomationTickets').doc(hash(event.phone)).set({ telefoneCriptografado: encrypt(event.phone), ultimaMensagemCriptografada: encrypt(event.text), rideId: ride?.id || '', status: 'aguardando', requestedAt: now(), expiresAt: null }, { merge: true });
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
    if (!pendingNotice(job, kind, stage, expire, now())) return { channel, status: 'ignored' };
    const marker = db.collection('supportAutomationNotices').doc(hash(`${kind}:${job.id}:${ms(job.criadaEm)}:${stage}:${channel}`));
    const lastMarker = db.collection('supportAutomationNotices').doc(hash(`${kind}:${job.id}:${ms(job.criadaEm)}:last:${channel}`));
    let claim = false, status = 'ignored';
    await db.runTransaction(async tx => {
      claim = false; status = 'ignored';
      // Include legacy initial/reminder markers when upgrading an existing deployment.
      const [previous, ...notices] = await Promise.all([tx.get(marker), tx.get(lastMarker), ...['initial', 'reminder'].map(value => tx.get(db.collection('supportAutomationNotices').doc(hash(`${kind}:${job.id}:${ms(job.criadaEm)}:${value}:${channel}`))))]);
      if (previous.exists) { status = previous.data().status === 'sent' ? 'recent' : previous.data().status === 'failed' ? 'failed' : 'sending'; return; }
      if (stage === 'customer' || stage.startsWith('reminder')) {
        const active = notices.map(snap => snap.data()).find(data => data && ['claimed', 'sent'].includes(data.status) && ms(data.createdAt) > now() - 60000);
        if (active) { status = active.status === 'sent' ? 'recent' : 'sending'; return; }
      }
      tx.set(marker, { createdAt: now(), expiresAt: new Date(now() + 7 * 86400000), status: 'claimed' });
      tx.set(lastMarker, { createdAt: now(), expiresAt: new Date(now() + 7 * 86400000), status: 'claimed' });
      claim = true;
    });
    if (!claim) return { channel, status };
    const current = await ref.get();
    const fresh = { ...current.data(), id: current.id };
    const text = ms(fresh.criadaEm) === ms(job.criadaEm) && pendingNotice(fresh, kind, stage, expire, now());
    if (!text) return { channel, status: 'ignored' };
    // At most one attempt: an ambiguous network timeout must not spam a group.
    try {
      const sent = channel === 'whatsapp' ? await sendText(settings.driverGroupJid, text) : await sendTelegram(fresh, text);
      await marker.set({ status: sent.sent ? 'sent' : 'failed', completedAt: now() }, { merge: true });
      await lastMarker.set({ status: sent.sent ? 'sent' : 'failed', completedAt: now() }, { merge: true });
      return { channel, status: sent.sent ? 'sent' : 'failed' };
    } catch {
      await marker.set({ status: 'failed', completedAt: now() }, { merge: true });
      await lastMarker.set({ status: 'failed', completedAt: now() }, { merge: true });
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
          if (settings.driverGroupJid) {
            await notify(doc.ref, kind, 'initial', 'whatsapp', settings);
            for (const stage of reminders) await notify(doc.ref, kind, stage, 'whatsapp', settings);
          }
          for (const stage of reminders) await notify(doc.ref, kind, stage, 'telegram', settings);
        }
      }
      if (now() - lastPrune >= 3600000) {
        lastPrune = now();
        for (const name of ['supportAutomationEvents', 'supportAutomationChats', 'supportAutomationNotices', 'supportAutomationTickets']) {
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
  return { config, saveConfig, handle, tick };
}
