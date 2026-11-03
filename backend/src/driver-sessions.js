import crypto from 'node:crypto';

// Login seguro do motoboy: cada celular recebe uma chave propria (sessao), guardada so
// como hash no cadastro do motoboy. Celular novo ou cadastro novo: codigo de 6 numeros
// pelo WhatsApp da empresa, enviado para o WhatsApp cadastrado (ou, no cadastro, para o
// numero digitado). CPF, CNH e telefone sozinhos deixam de abrir o app.
//
// Transicao: ate DRIVER_LEGACY_UNTIL_MS, o app antigo (que manda CNH + telefone) ainda
// funciona e troca isso por uma chave na primeira abertura - mas so enquanto o motoboy
// ainda nao tem nenhuma chave. Depois da primeira chave, o jeito antigo para de valer
// para ele. Passada a data, so vale a chave.

export const DRIVER_LEGACY_UNTIL_MS = Date.UTC(2026, 10, 10, 3); // 10/11/2026 00:00 (Brasilia)
export const MAX_DRIVER_SESSIONS = 5;
export const DRIVER_OTP_MS = 10 * 60000;
export const DRIVER_OTP_COOLDOWN_MS = 60000;
export const DRIVER_OTP_MAX_ATTEMPTS = 5;
export const DRIVER_OTP_PER_HOUR = 5;
export const DRIVER_VERIFICATION_MS = 30 * 60000;
// Conta de teste (testadores do Google Play): varios celulares na mesma conta.
export const REVIEW_MAX_SESSIONS = 60;

// DRIVER_REVIEW_LOGIN="CPF:CODIGO" (varios separados por virgula), so no Render.
// Essa conta entra com um codigo fixo de 6 numeros, sem WhatsApp. Nunca no codigo publico.
export function reviewLogins(value = '') {
  const map = new Map();
  for (const item of String(value || '').split(',')) {
    const [cpf, code] = item.split(':').map(part => digits(part));
    if (cpf && cpf.length === 11 && code && code.length === 6) map.set(cpf, code);
  }
  return map;
}

const digits = value => String(value || '').replace(/\D/g, '');

export function maskPhone(phone) {
  const d = digits(phone);
  if (d.length < 10) return '';
  return `(${d.slice(0, 2)}) ${d.length === 11 ? `${d[2]}••••-` : '••••-'}${d.slice(-4)}`;
}

export function newDriverToken() {
  return `md1.${crypto.randomBytes(32).toString('hex')}`;
}

export function validTokenShape(token) {
  return /^md1\.[a-f0-9]{64}$/.test(String(token || ''));
}

export function driverSessions(driver = {}) {
  return Array.isArray(driver.sessoesApp) ? driver.sessoesApp.filter(item => item && item.hash) : [];
}

export function driverSessionValid(driver, token, hashSecret, safeEqual) {
  if (!validTokenShape(token)) return false;
  const hash = hashSecret(token);
  return driverSessions(driver).some(item => safeEqual(item.hash, hash));
}

export function legacyProofAllowed(driver = {}, now = Date.now(), until = DRIVER_LEGACY_UNTIL_MS) {
  return now < until && driverSessions(driver).length === 0;
}

// Nova sessao no topo; guarda no maximo 5 celulares (o mais antigo sai).
export function withNewSession(driver, hash, { now = Date.now(), aparelho = '', max = MAX_DRIVER_SESSIONS } = {}) {
  const current = driverSessions(driver).filter(item => item.hash !== hash);
  return [{ hash, criadoEmMs: now, aparelho: String(aparelho || '').slice(0, 80) }, ...current].slice(0, max);
}

export function createDriverSessions({
  db, admin, hashSecret, safeEqual, sendText, now = () => Date.now(), legacyUntil = () => DRIVER_LEGACY_UNTIL_MS,
  reviewLogin = () => ''
}) {
  const reviewCode = cpf => reviewLogins(reviewLogin()).get(digits(cpf)) || '';
  function fail(status, code, message) {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
  }

  const otpRef = cpf => db.collection('motoboyOtp').doc(hashSecret(`motoboy-otp:${cpf}`));

  async function notify(phone, text) {
    const d = digits(phone);
    if (d.length < 10) return;
    try { await sendText(`55${d}`, text); } catch (error) { console.warn('driver notice failed', error.message); }
  }

  // Pede o codigo. Motoboy ja cadastrado: vai para o WhatsApp do cadastro (o numero
  // digitado e ignorado). Cadastro novo: vai para o numero digitado.
  async function requestCode({ cpf, telefone }) {
    const id = digits(cpf);
    if (id.length !== 11) throw fail(400, 'cpf_invalido', 'Digite o CPF com 11 números.');
    if (reviewCode(id)) return { ok: true, para: 'da conta de teste', novo: false, teste: true };
    const driverSnap = await db.collection('motoboys').doc(id).get();
    const driver = driverSnap.exists ? driverSnap.data() || {} : null;
    const destino = driver ? digits(driver.telefone) : digits(telefone);
    if (driver && destino.length < 10) throw fail(409, 'motoboy_sem_whatsapp', 'Seu cadastro está sem WhatsApp. Fale com o dono para corrigir.');
    if (!driver && (destino.length < 10 || destino.length > 11)) throw fail(404, 'motoboy_nao_cadastrado', 'CPF sem cadastro. Faça o cadastro do motoboy primeiro.');
    if (driver?.status === 'bloqueado' && driver.motivoBloqueio && !driver.aguardandoAprovacaoEm) {
      throw fail(403, 'motoboy_bloqueado', 'Seu cadastro está bloqueado pelo dono. Fale com o suporte MotoJá.');
    }
    const ref = otpRef(id);
    const t = now();
    const code = String(crypto.randomInt(100000, 1000000));
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const old = snap.exists ? snap.data() || {} : {};
      if (Number(old.enviadoEmMs || 0) + DRIVER_OTP_COOLDOWN_MS > t) {
        throw fail(429, 'aguarde_codigo', 'Já enviamos um código. Espere 1 minuto para pedir outro.');
      }
      const janela = t - Number(old.janelaDesdeMs || 0) < 3600000;
      const envios = (janela ? Number(old.enviosHora || 0) : 0) + 1;
      if (envios > DRIVER_OTP_PER_HOUR) throw fail(429, 'muitos_codigos', 'Muitos códigos pedidos. Tente de novo daqui a 1 hora.');
      tx.set(ref, {
        cpfFinal: id.slice(-3),
        telefone: destino,
        novo: !driver,
        codeHash: hashSecret(`${id}:${code}`),
        expiresAtMs: t + DRIVER_OTP_MS,
        tentativas: 0,
        enviadoEmMs: t,
        janelaDesdeMs: janela ? Number(old.janelaDesdeMs) : t,
        enviosHora: envios,
        verificacaoHash: null,
        verificacaoAteMs: 0
      });
    });
    const delivery = await sendText(`55${destino}`, `🏍️ Nexus MotoJá: seu código de acesso é *${code}*.\nVale por 10 minutos. Não passe para ninguém, nem para quem disser que é da MotoJá.`);
    if (!delivery?.sent) {
      await ref.set({ enviadoEmMs: 0 }, { merge: true }).catch(() => {});
      throw fail(503, 'whatsapp_indisponivel', 'Não consegui enviar o código pelo WhatsApp agora. Tente de novo em alguns minutos.');
    }
    return { ok: true, para: maskPhone(destino), novo: !driver };
  }

  // Confere o codigo. Ja cadastrado: devolve a chave do celular. Novo: devolve uma
  // verificacao (30 min) para enviar junto com o cadastro.
  async function verifyCode({ cpf, code, aparelho }) {
    const id = digits(cpf);
    const typed = digits(code);
    if (id.length !== 11 || typed.length !== 6) throw fail(400, 'codigo_invalido', 'Digite o código de 6 números.');
    if (reviewCode(id)) {
      if (!safeEqual(hashSecret(`${id}:${typed}`), hashSecret(`${id}:${reviewCode(id)}`))) throw fail(400, 'codigo_incorreto', 'Código errado.');
      const session = await issueSession(id, { aparelho });
      return { ok: true, novo: false, driverToken: session.token, driver: session.driver };
    }
    const ref = otpRef(id);
    let result = null;
    let error = null;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() || {} : {};
      if (!snap.exists || !data.codeHash || Number(data.expiresAtMs || 0) < now() || Number(data.tentativas || 0) >= DRIVER_OTP_MAX_ATTEMPTS) {
        error = fail(400, 'codigo_expirado', 'Código vencido. Peça um novo.');
        return;
      }
      if (!safeEqual(hashSecret(`${id}:${typed}`), data.codeHash)) {
        tx.set(ref, { tentativas: Number(data.tentativas || 0) + 1 }, { merge: true });
        error = fail(400, 'codigo_incorreto', 'Código errado. Confira a mensagem no WhatsApp.');
        return;
      }
      if (data.novo) {
        const verification = crypto.randomBytes(32).toString('hex');
        tx.set(ref, { codeHash: null, verificacaoHash: hashSecret(verification), verificacaoAteMs: now() + DRIVER_VERIFICATION_MS }, { merge: true });
        result = { ok: true, novo: true, verificationToken: verification, telefone: data.telefone };
        return;
      }
      tx.set(ref, { codeHash: null }, { merge: true });
      result = { ok: true, novo: false };
    });
    if (error) throw error;
    if (result.novo) return result;
    const session = await issueSession(id, { aparelho, aviso: 'novo_celular' });
    return { ok: true, novo: false, driverToken: session.token, driver: session.driver };
  }

  // Cadastro novo: confere a verificacao do WhatsApp (uso unico) e o numero confirmado.
  async function consumeVerification(cpf, verificationToken, telefone) {
    const id = digits(cpf);
    const ref = otpRef(id);
    let ok = false;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() || {} : {};
      ok = !!(data.verificacaoHash && Number(data.verificacaoAteMs || 0) > now()
        && safeEqual(hashSecret(String(verificationToken || '')), data.verificacaoHash)
        && digits(data.telefone) === digits(telefone));
      if (ok) tx.delete(ref);
    });
    if (!ok) throw fail(401, 'whatsapp_nao_confirmado', 'Confirme o WhatsApp com o código antes de enviar o cadastro.');
    return true;
  }

  async function issueSession(cpf, { aparelho = '', aviso = '' } = {}) {
    const id = digits(cpf);
    const ref = db.collection('motoboys').doc(id);
    const token = newDriverToken();
    let driver = null;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw fail(404, 'motoboy_nao_cadastrado', 'Motoboy não cadastrado.');
      driver = snap.data() || {};
      tx.set(ref, {
        sessoesApp: withNewSession(driver, hashSecret(token), { now: now(), aparelho, max: reviewCode(id) ? REVIEW_MAX_SESSIONS : MAX_DRIVER_SESSIONS }),
        ultimoNovoAparelhoEmMs: now()
      }, { merge: true });
    });
    const hora = new Date(now()).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    if (aviso === 'novo_celular') {
      await notify(driver.telefone, `🔐 Nexus MotoJá: seu acesso foi aberto em um celular (${hora}).\nSe não foi você, avise o dono agora para bloquear.`);
    } else if (aviso === 'atualizacao') {
      await notify(driver.telefone, `🔐 Nexus MotoJá: seu app agora tem login seguro neste celular (${hora}). Você não precisa fazer nada.\nSe você não abriu o app agora, avise o dono.`);
    }
    return { token, driver };
  }

  // App antigo (CNH + telefone) troca pela chave, so na transicao e so sem chave ainda.
  async function upgradeLegacy(cpf, body, { assertLegacyProof, aparelho }) {
    const id = digits(cpf);
    const snap = await db.collection('motoboys').doc(id).get();
    if (!snap.exists) throw fail(404, 'motoboy_nao_cadastrado', 'Motoboy não cadastrado.');
    const driver = snap.data() || {};
    // Conta de teste: cada celular dos testadores troca pela propria chave (mesmo ja tendo outras).
    const allowed = reviewCode(id) ? now() < legacyUntil() : legacyProofAllowed(driver, now(), legacyUntil());
    if (!allowed) {
      throw fail(401, 'sessao_motoboy_obrigatoria', 'Entre de novo: toque em "Já sou cadastrado" e receba o código no WhatsApp.');
    }
    assertLegacyProof(driver, body);
    const session = await issueSession(id, { aparelho, aviso: reviewCode(id) ? '' : 'atualizacao' });
    return { ok: true, driverToken: session.token };
  }

  async function revokeAll(cpf) {
    await db.collection('motoboys').doc(digits(cpf)).set({ sessoesApp: [], sessoesRevogadasEmMs: now() }, { merge: true });
  }

  return { requestCode, verifyCode, consumeVerification, issueSession, upgradeLegacy, revokeAll, notify };
}
