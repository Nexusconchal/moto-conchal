import crypto from 'node:crypto';

// Cartao salvo no app do cliente ("Meus cartoes"), cobrado na conta Mercado Pago da MotoJa.
//
// Seguranca:
// - o numero do cartao nunca passa por aqui: o app gera um token no Mercado Pago e manda so
//   o token; o cartao fica guardado no Mercado Pago (Customers API) e aqui so o final,
//   a bandeira, a validade e o CPF do titular (hash);
// - para pagar, o cliente digita o CPF do titular e o codigo de seguranca: o CPF e conferido
//   aqui (5 erros em 30 min bloqueiam o cartao por 30 min) e o codigo vai direto ao Mercado Pago;
// - so a conta que pediu a corrida paga, so com a corrida aceita, uma cobranca por vez e com
//   o valor calculado no servidor;
// - o Mercado Pago so guarda cartao na conta de quem cobra, entao a corrida no cartao cai na
//   conta da MotoJa e vira um repasse "a pagar" para o motoboy (repassesMotoboy).
//   Quando o Mercado Pago liberar o split 1:N, a cobranca passa a dividir sozinha.

export const MAX_CARDS = 5;
export const CPF_MAX_ERRORS = 5;
export const CPF_LOCK_MS = 30 * 60000;
export const PAY_LOCK_MS = 90 * 1000;
export const ATTEMPTS_PER_10_MIN = 6;
export const ADDS_PER_HOUR = 5;

const digits = value => String(value || '').replace(/\D/g, '');
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const round = value => Math.round(Number(value || 0) * 100) / 100;

export function publicCard(card = {}) {
  return {
    id: String(card.id || ''),
    final: digits(card.final).slice(-4),
    bandeira: String(card.bandeira || ''),
    bandeiraNome: String(card.bandeiraNome || card.bandeira || 'Cartão'),
    tipo: card.tipo === 'debit_card' ? 'debito' : 'credito',
    validade: String(card.validade || ''),
    titular: String(card.titular || ''),
    cpfFinal: digits(card.cpfFinal).slice(-2)
  };
}

// Cartao devolvido pelo Mercado Pago (POST /v1/customers/:id/cards) no formato guardado aqui.
export function storedCard(mpCard = {}, cpf, hashSecret, now = Date.now()) {
  const month = String(mpCard.expiration_month || '').padStart(2, '0');
  const year = String(mpCard.expiration_year || '');
  return {
    id: String(mpCard.id || ''),
    final: digits(mpCard.last_four_digits).slice(-4),
    bandeira: String(mpCard.payment_method?.id || ''),
    bandeiraNome: String(mpCard.payment_method?.name || mpCard.payment_method?.id || ''),
    tipo: String(mpCard.payment_method?.payment_type_id || 'credit_card'),
    issuerId: mpCard.issuer?.id ? String(mpCard.issuer.id) : '',
    validade: month && year ? `${month}/${year}` : '',
    titular: String(mpCard.cardholder?.name || '').slice(0, 60),
    cpfHash: hashSecret(cpf),
    cpfFinal: cpf.slice(-2),
    criadoEmMs: now
  };
}

export function cardExpired(card = {}, now = Date.now()) {
  const [month, year] = String(card.validade || '').split('/').map(Number);
  if (!month || !year) return false;
  return now >= Date.UTC(year, month, 1) + 3 * 3600000;
}

const REJECTIONS = {
  cc_rejected_bad_filled_security_code: 'Código de segurança errado. Confira os 3 números atrás do cartão.',
  cc_rejected_bad_filled_date: 'Data de validade do cartão errada. Remova o cartão e cadastre de novo.',
  cc_rejected_bad_filled_card_number: 'Número do cartão errado. Remova o cartão e cadastre de novo.',
  cc_rejected_bad_filled_other: 'Algum dado do cartão está errado. Remova o cartão e cadastre de novo.',
  cc_rejected_insufficient_amount: 'O cartão não tem limite ou saldo para esta corrida.',
  cc_rejected_call_for_authorize: 'O banco pediu para você autorizar este pagamento. Ligue para o banco ou use outro cartão.',
  cc_rejected_card_disabled: 'Este cartão está bloqueado. Ligue para o banco ou use outro cartão.',
  cc_rejected_duplicated_payment: 'Este pagamento já foi feito. Confira seu extrato antes de tentar de novo.',
  cc_rejected_max_attempts: 'Muitas tentativas com este cartão. Use outro cartão ou o Pix.',
  cc_rejected_high_risk: 'O Mercado Pago recusou por segurança. Use outro cartão ou pague pelo Pix.',
  cc_rejected_blacklist: 'O Mercado Pago recusou este cartão. Use outro cartão ou pague pelo Pix.',
  cc_rejected_card_type_not_allowed: 'Este tipo de cartão não é aceito. Use outro cartão ou o Pix.',
  cc_amount_rate_limit_exceeded: 'O cartão passou do limite de valor. Use outro cartão ou o Pix.'
};

export function rejectionMessage(statusDetail = '') {
  return REJECTIONS[statusDetail] || 'O pagamento não foi aprovado. Tente outro cartão ou pague pelo Pix.';
}

// Repasse do motoboy quando a corrida foi paga na conta da MotoJa (cartao salvo ou link
// da conta MotoJa). Devolve o que gravar em repassesMotoboy/{rideId}, ou null.
export function repasseUpdate(existing, { rideId, ride = {}, payment = {}, valido, driverAmount, now = Date.now() }) {
  const driverCpf = digits(ride.motoboyCpf);
  if (!driverCpf) return null;
  const status = String(payment.status || '');
  if (status === 'approved' && valido) {
    if (existing) return null;
    return {
      motoboyCpf: driverCpf,
      motoboyNome: String(ride.motoboy || '').slice(0, 80),
      rideId,
      paymentId: String(payment.id || ''),
      valor: round(driverAmount),
      valorCorrida: round(payment.transaction_amount),
      origem: ride.pagamento?.metodo === 'cartao_app' ? 'cartao_app' : 'conta_motoja',
      status: 'a_pagar',
      criadoEmMs: now
    };
  }
  if (['refunded', 'charged_back', 'cancelled'].includes(status) && existing
    && String(existing.paymentId || '') === String(payment.id || '')) {
    if (existing.status === 'a_pagar') return { status: 'estornado', estornadoEmMs: now };
    if (existing.status === 'pago' && !existing.estornoAposPagamento) return { estornoAposPagamento: true, estornadoEmMs: now };
  }
  return null;
}

export function createCustomerCards({
  db, admin, fetchImpl = fetch, mpApi = 'https://api.mercadopago.com',
  ownerToken, publicKey, hashSecret, safeEqual, validCpf, rideAmounts, webhookUrl,
  expireRidePreference = async () => {}, now = () => Date.now()
}) {
  const recent = new Map();

  function limited(key, max, windowMs) {
    const t = now();
    const list = (recent.get(key) || []).filter(at => t - at < windowMs);
    if (list.length >= max) return true;
    list.push(t);
    recent.set(key, list);
    if (recent.size > 5000) recent.delete(recent.keys().next().value);
    return false;
  }

  function fail(status, code, message) {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
  }

  async function mp(path, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetchImpl(`${mpApi}${path}`, {
      method,
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${ownerToken()}`, ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.message || `Mercado Pago ${response.status}`);
      error.status = response.status >= 500 ? 503 : 400;
      error.code = 'mercadopago_recusou';
      error.mpStatus = response.status;
      throw error;
    }
    return data;
  }

  const enabled = () => !!(publicKey() && ownerToken());

  function config() {
    return { ativo: enabled(), publicKey: enabled() ? publicKey() : '' };
  }

  function list(customer = {}) {
    return (customer.cartoesMp || []).map(publicCard);
  }

  async function mpCustomerId(session) {
    if (session.customer.mpCustomerId) return session.customer.mpCustomerId;
    const email = `c${sha(`motoja:${session.customerId}`).slice(0, 20)}@clientes.nexusmotoja.com.br`;
    const found = await mp(`/v1/customers/search?email=${encodeURIComponent(email)}`);
    let id = found.results?.[0]?.id;
    if (!id) {
      const created = await mp('/v1/customers', {
        method: 'POST',
        body: { email, first_name: String(session.customer.nome || 'Cliente').split(' ')[0].slice(0, 40), description: 'Cliente Nexus MotoJá' }
      });
      id = created.id;
    }
    if (!id) throw fail(503, 'mercadopago_indisponivel', 'Não consegui falar com o Mercado Pago agora. Tente de novo.');
    await session.customerSnap.ref.set({ mpCustomerId: String(id) }, { merge: true });
    session.customer.mpCustomerId = String(id);
    return String(id);
  }

  async function add(session, body = {}) {
    if (!enabled()) throw fail(503, 'cartao_desativado', 'Pagamento com cartão no app ainda não está disponível.');
    const token = String(body.token || '').trim();
    const cpf = digits(body.cpf);
    if (!/^[A-Za-z0-9]{16,64}$/.test(token)) throw fail(400, 'token_cartao_invalido', 'Não consegui ler o cartão. Confira os dados e tente de novo.');
    if (!validCpf(cpf)) throw fail(400, 'cpf_titular_invalido', 'Digite o CPF de quem é dono do cartão.');
    if ((session.customer.cartoesMp || []).length >= MAX_CARDS) throw fail(409, 'limite_cartoes', `Você pode salvar até ${MAX_CARDS} cartões. Remova um para adicionar outro.`);
    if (limited(`add:${session.customerId}`, ADDS_PER_HOUR, 3600000)) throw fail(429, 'muitos_cartoes', 'Muitas tentativas de salvar cartão. Tente de novo daqui a 1 hora.');
    const customerId = await mpCustomerId(session);
    let mpCard;
    try {
      mpCard = await mp(`/v1/customers/${encodeURIComponent(customerId)}/cards`, { method: 'POST', body: { token } });
    } catch (error) {
      if (error.mpStatus && error.mpStatus < 500) throw fail(400, 'cartao_recusado', 'O Mercado Pago não aceitou este cartão. Confira número, validade, código e CPF.');
      throw error;
    }
    const mpCpf = digits(mpCard.cardholder?.identification?.number);
    if (mpCpf.length === 11 && mpCpf !== cpf) throw fail(400, 'cpf_titular_divergente', 'O CPF não confere com o do cartão.');
    const card = storedCard(mpCard, cpf, hashSecret, now());
    if (!card.id || !card.final || !card.bandeira) throw fail(503, 'mercadopago_indisponivel', 'O Mercado Pago não devolveu o cartão. Tente de novo.');
    const ref = session.customerSnap.ref;
    let cards = [];
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      cards = (snap.data()?.cartoesMp || []).filter(item => item.id !== card.id);
      cards = [card, ...cards].slice(0, MAX_CARDS);
      tx.set(ref, { cartoesMp: cards, atualizadaEm: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });
    return { cartao: publicCard(card), cartoes: cards.map(publicCard) };
  }

  async function remove(session, cardId) {
    const id = String(cardId || '');
    const ref = session.customerSnap.ref;
    let found = false;
    let cards = [];
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current = snap.data()?.cartoesMp || [];
      found = current.some(item => item.id === id);
      cards = current.filter(item => item.id !== id);
      if (found) tx.set(ref, { cartoesMp: cards, atualizadaEm: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });
    if (!found) throw fail(404, 'cartao_nao_encontrado', 'Cartão não encontrado.');
    if (session.customer.mpCustomerId) {
      await mp(`/v1/customers/${encodeURIComponent(session.customer.mpCustomerId)}/cards/${encodeURIComponent(id)}`, { method: 'DELETE' })
        .catch(error => console.warn('mercado pago card delete failed', error.message));
    }
    return { cartoes: cards.map(publicCard) };
  }

  // CPF do titular: confere aqui, conta os erros e bloqueia o cartao por 30 min depois de 5.
  async function checkHolder(session, card, cpf) {
    const ref = session.customerSnap.ref;
    const lock = session.customer.cartaoCpfBloqueio || {};
    const t = now();
    if (Number(lock.ateMs || 0) > t) throw fail(423, 'cartao_bloqueado', 'CPF errado muitas vezes. Tente de novo em 30 minutos.');
    if (safeEqual(hashSecret(cpf), card.cpfHash || '')) {
      if (lock.erros) await ref.set({ cartaoCpfBloqueio: { erros: 0, desdeMs: 0, ateMs: 0 } }, { merge: true });
      return;
    }
    const fresh = t - Number(lock.desdeMs || 0) < CPF_LOCK_MS;
    const erros = (fresh ? Number(lock.erros || 0) : 0) + 1;
    await ref.set({ cartaoCpfBloqueio: { erros, desdeMs: fresh ? Number(lock.desdeMs) : t, ateMs: erros >= CPF_MAX_ERRORS ? t + CPF_LOCK_MS : 0 } }, { merge: true });
    throw fail(403, 'cpf_titular_errado', erros >= CPF_MAX_ERRORS
      ? 'CPF errado muitas vezes. Tente de novo em 30 minutos.'
      : 'O CPF não confere com o do dono do cartão.');
  }

  async function payRide(session, rideId, body = {}, { deviceSessionId = '' } = {}) {
    if (!enabled()) throw fail(503, 'cartao_desativado', 'Pagamento com cartão no app ainda não está disponível.');
    const id = String(rideId || '').trim();
    const token = String(body.token || '').trim();
    const cpf = digits(body.cpf);
    if (!id || id.length > 80) throw fail(400, 'corrida_invalida', 'Corrida inválida.');
    if (!/^[A-Za-z0-9]{16,64}$/.test(token)) throw fail(400, 'token_cartao_invalido', 'Digite o código de segurança do cartão.');
    const card = (session.customer.cartoesMp || []).find(item => item.id === String(body.cardId || ''));
    if (!card) throw fail(404, 'cartao_nao_encontrado', 'Cartão não encontrado. Cadastre de novo em Meus cartões.');
    if (cardExpired(card, now())) throw fail(409, 'cartao_vencido', 'Este cartão está vencido. Cadastre outro em Meus cartões.');
    if (limited(`pay:${session.customerId}`, ATTEMPTS_PER_10_MIN, 600000)) throw fail(429, 'muitas_tentativas_cartao', 'Muitas tentativas. Espere 10 minutos ou pague pelo Pix.');
    await checkHolder(session, card, cpf);

    const rideRef = db.collection('corridas').doc(id);
    let ride = null;
    let attempt = 0;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(rideRef);
      if (!snap.exists) throw fail(404, 'corrida_nao_encontrada', 'Corrida não encontrada.');
      ride = snap.data() || {};
      if (!ride.customerId || ride.customerId !== session.customerId) throw fail(403, 'corrida_de_outra_conta', 'Esta corrida não é da sua conta.');
      if (ride.status !== 'aceita') throw fail(409, 'corrida_sem_motoboy', 'Dá para pagar depois que o motoboy aceitar a corrida.');
      if (ride.pagamento?.status === 'approved') throw fail(409, 'corrida_ja_paga', 'Esta corrida já está paga.');
      if (Number(ride.pagamento?.cartaoProcessandoAteMs || 0) > now()) throw fail(409, 'pagamento_em_andamento', 'Já tem um pagamento em andamento. Espere um pouco.');
      attempt = Number(ride.pagamento?.tentativasCartao || 0) + 1;
      tx.set(rideRef, { pagamento: { ...(ride.pagamento || {}), cartaoProcessandoAteMs: now() + PAY_LOCK_MS, tentativasCartao: attempt } }, { merge: true });
    });

    const amounts = rideAmounts(ride);
    const total = round(amounts.total);
    let payment;
    try {
      payment = await mp('/v1/payments', {
        method: 'POST',
        headers: {
          'X-Idempotency-Key': sha(`motoja-card:${id}:${attempt}`),
          ...(/^[A-Za-z0-9.:_-]{8,160}$/.test(deviceSessionId) ? { 'X-meli-session-id': deviceSessionId } : {})
        },
        body: {
          transaction_amount: total,
          token,
          description: 'Corrida Nexus MotoJá',
          installments: 1,
          payment_method_id: card.bandeira,
          ...(card.issuerId ? { issuer_id: Number(card.issuerId) || card.issuerId } : {}),
          payer: { type: 'customer', id: session.customer.mpCustomerId },
          external_reference: id,
          notification_url: webhookUrl({ rideId: id, receiver: 'owner' }),
          statement_descriptor: 'MOTOJA',
          binary_mode: true,
          metadata: {
            ride_id: id,
            driver_cpf: digits(ride.motoboyCpf),
            payment_kind: 'ride_card_owner',
            app_fee: round(amounts.appFee),
            driver_amount: round(amounts.driverAmount)
          },
          additional_info: {
            items: [{ id, title: 'Corrida Nexus MotoJá', quantity: 1, unit_price: total, category_id: 'travels' }],
            payer: { first_name: String(session.customer.nome || '').split(' ')[0].slice(0, 40) }
          }
        }
      });
    } catch (error) {
      await rideRef.set({ pagamento: { cartaoProcessandoAteMs: 0 } }, { merge: true }).catch(() => {});
      if (error.mpStatus && error.mpStatus < 500) throw fail(400, 'cartao_recusado', 'O Mercado Pago não aceitou o cartão. Confira o código de segurança.');
      throw error;
    }

    const status = String(payment.status || '');
    const paid = round(payment.transaction_amount);
    const valido = status === 'approved' && Math.abs(paid - total) <= 0.01;
    const usageRef = db.collection('mercadoPagoPagamentos').doc(hashSecret(String(payment.id)));
    const repasseRef = db.collection('repassesMotoboy').doc(id);
    await db.runTransaction(async (tx) => {
      const [snap, repasseSnap] = await Promise.all([tx.get(rideRef), tx.get(repasseRef)]);
      const current = snap.data() || {};
      if (status !== 'approved') {
        // Recusado: o link de pagamento continua valendo; so registra a recusa.
        tx.set(rideRef, {
          pagamento: {
            cartaoProcessandoAteMs: 0,
            cartaoUltimaRecusa: { paymentId: String(payment.id || ''), status, statusDetail: payment.status_detail || null, final: card.final, emMs: now() }
          }
        }, { merge: true });
        return;
      }
      const pagamento = {
        ...(current.pagamento || {}),
        provider: 'mercadopago',
        receiver: 'motoja_owner',
        metodo: 'cartao_app',
        cartaoFinal: card.final,
        cartaoBandeira: card.bandeiraNome || card.bandeira,
        paymentId: String(payment.id || ''),
        status,
        statusDetail: payment.status_detail || null,
        total,
        totalPago: paid,
        valorEsperado: total,
        appFee: round(amounts.appFee),
        driverAmount: round(amounts.driverAmount),
        valido,
        cartaoProcessandoAteMs: 0,
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
      };
      if (current.pagamento?.status === 'approved' && current.pagamento?.paymentId && current.pagamento.paymentId !== pagamento.paymentId) {
        // Pagou pelo link enquanto o cartao processava: guarda para o dono estornar um deles.
        tx.set(rideRef, {
          pagamentoDuplicadoEm: admin.firestore.FieldValue.serverTimestamp(),
          pagamentosDuplicados: { [String(payment.id)]: { status, total: paid, metodo: 'cartao_app' } }
        }, { merge: true });
        return;
      }
      tx.set(usageRef, { target: `ride:${id}`, paymentId: String(payment.id), status, atualizadoEm: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      tx.set(rideRef, {
        pagamento,
        ...(valido ? { pagamentoConfirmadoEm: admin.firestore.FieldValue.serverTimestamp() } : {}),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      const repasse = repasseUpdate(repasseSnap.exists ? repasseSnap.data() : null, {
        rideId: id, ride: { ...current, pagamento }, payment, valido, driverAmount: amounts.driverAmount, now: now()
      });
      if (repasse) tx.set(repasseRef, repasse, { merge: true });
    });

    if (valido) {
      // O link do motoboy deixa de aceitar pagamento (evita pagar duas vezes).
      await expireRidePreference({ ...ride, id }).catch(error => console.warn('ride preference expire failed', error.message));
      return { ok: true, aprovado: true, message: `Pagamento aprovado no cartão final ${card.final}! ✅` };
    }
    return { ok: false, aprovado: false, status, message: rejectionMessage(payment.status_detail) };
  }

  return { config, list, add, remove, payRide, enabled };
}
