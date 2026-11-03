import crypto from 'node:crypto';

// Avisos de chamada no Telegram PRIVADO de cada motoboy. O app do Telegram e nativo,
// entao a notificacao chega mesmo com o celular bloqueado (o que o web app nao garante).
// Vinculo: o app gera um link t.me/<robo>?start=<codigo>; o motoboy toca em Iniciar e o
// robo grava o chat dele. O codigo vale 15 minutos e serve uma vez so.
const LINK_TTL_MS = 15 * 60 * 1000;

export function createDriverTelegram({ db, token, fetchImpl = fetch, now = Date.now, username = '' }) {
  const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
  let botUsername = String(username || '').replace(/^@/, '');

  async function api(method, body) {
    if (!token) throw Object.assign(new Error('telegram_nao_configurado'), { status: 503 });
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(10000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw Object.assign(new Error(data.description || `telegram_${response.status}`), { status: 502, code: data.error_code });
    return data.result;
  }

  async function username_() {
    if (botUsername) return botUsername;
    const me = await api('getMe');
    botUsername = String(me?.username || '');
    return botUsername;
  }

  async function createLink(cpf) {
    const code = crypto.randomBytes(18).toString('hex');
    const expiresAtMs = now() + LINK_TTL_MS;
    await db.collection('telegramVinculos').doc(hash(code)).set({ cpf, expiresAtMs, criadoEmMs: now() });
    const name = await username_();
    if (!name) throw Object.assign(new Error('telegram_sem_usuario_do_robo'), { status: 503 });
    return { link: `https://t.me/${name}?start=${code}`, expiresAtMs };
  }

  async function sendTo(chatId, text) {
    if (!chatId) return { sent: false, reason: 'sem_telegram' };
    try {
      await api('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
      return { sent: true };
    } catch (error) {
      return { sent: false, reason: error.message, blocked: error.code === 403 };
    }
  }

  // Mensagem recebida pelo robo (webhook): /start <codigo> vincula, /parar desvincula.
  async function handleUpdate(update = {}) {
    const message = update.message || {};
    const chat = message.chat || {};
    if (chat.type !== 'private' || !chat.id) return { handled: false };
    const text = String(message.text || '').trim();
    const start = text.match(/^\/start(?:@\w+)?\s+([a-f0-9]{36})$/i);
    if (start) {
      const linkRef = db.collection('telegramVinculos').doc(hash(start[1].toLowerCase()));
      const linkSnap = await linkRef.get();
      const link = linkSnap.exists ? linkSnap.data() || {} : null;
      if (!link || Number(link.expiresAtMs || 0) < now()) {
        await sendTo(chat.id, 'Este link expirou. Abra o app MotoJá do motoboy e toque de novo em "Receber chamadas no meu Telegram".');
        return { handled: true, linked: false };
      }
      const driverRef = db.collection('motoboys').doc(link.cpf);
      const driverSnap = await driverRef.get();
      if (!driverSnap.exists) return { handled: true, linked: false };
      await driverRef.set({ telegramChatId: String(chat.id), telegramVinculadoEmMs: now() }, { merge: true });
      await linkRef.delete();
      await sendTo(chat.id, `✅ Pronto, ${driverSnap.data()?.nome || 'motoboy'}! As chamadas da MotoJá vão chegar aqui no seu Telegram.\n\nDica: abra esta conversa, toque no nome do robô e escolha um toque alto só para ele. Para parar, envie /parar.`);
      return { handled: true, linked: true, cpf: link.cpf };
    }
    if (/^\/(parar|stop)\b/i.test(text)) {
      const snapshot = await db.collection('motoboys').where('telegramChatId', '==', String(chat.id)).limit(5).get();
      await Promise.all(snapshot.docs.map((doc) => doc.ref.set({ telegramChatId: '', telegramDesvinculadoEmMs: now() }, { merge: true })));
      await sendTo(chat.id, 'Você não vai mais receber chamadas aqui. Para voltar, toque em "Receber chamadas no meu Telegram" no app.');
      return { handled: true, unlinked: snapshot.docs.length };
    }
    if (/^\/start\b/i.test(text)) {
      await sendTo(chat.id, 'Olá! Para receber as chamadas aqui, abra o app MotoJá do motoboy e toque em "Receber chamadas no meu Telegram".');
      return { handled: true };
    }
    return { handled: false };
  }

  // Envia a mesma chamada para varios motoboys vinculados (sem dados pessoais do cliente).
  async function notifyDrivers(driverDocs, text) {
    const chats = [...new Set(driverDocs.map((doc) => String(doc.data?.()?.telegramChatId || '')).filter(Boolean))];
    let sent = 0;
    for (const chatId of chats) {
      const result = await sendTo(chatId, text);
      if (result.sent) sent += 1;
    }
    return { sent, linked: chats.length };
  }

  async function setWebhook(url, secretToken) {
    return api('setWebhook', { url, secret_token: secretToken, allowed_updates: ['message'], drop_pending_updates: true });
  }

  return { createLink, handleUpdate, notifyDrivers, sendTo, setWebhook, username: username_ };
}
