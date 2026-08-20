import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import admin from 'firebase-admin';
import rateLimit from 'express-rate-limit';

const PORT = Number(process.env.PORT || 10000);
const DRIVER_PERCENT = Number(process.env.DRIVER_PERCENT || 0.7);
const APP_PERCENT = Number(process.env.APP_PERCENT || 0.3);
const PENDING_EXPIRE_MS = Number(process.env.PENDING_EXPIRE_MINUTES || 5) * 60 * 1000;
const ACCEPTED_NOTICE_MS = Number(process.env.ACCEPTED_NOTICE_MINUTES || 3) * 60 * 1000;
const MP_API = 'https://api.mercadopago.com';
const BACKEND_BASE_URL = String(process.env.BACKEND_BASE_URL || '').replace(/\/$/, '');

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function serviceAccount() {
  const raw = requiredEnv('FIREBASE_SERVICE_ACCOUNT_JSON');
  return JSON.parse(raw);
}

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function expectedFare(km) {
  const distance = Number(km || 0);
  if (!Number.isFinite(distance) || distance <= 0) return 0;
  if (distance <= 3) return 4.5;
  if (distance <= 5) return 7.5;
  if (distance <= 8) return 12;
  return Math.ceil(distance * 2);
}

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function timestampMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts.seconds === 'number') return ts.seconds * 1000;
  return 0;
}

function assertAdmin(req, res, next) {
  const key = process.env.ADMIN_API_KEY;
  if (!key || req.header('x-admin-key') !== key) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return next();
}

function appUrl(path) {
  return `${String(process.env.APP_BASE_URL || '').replace(/\/$/, '')}${path}`;
}

function whatsappLink(phone, message) {
  const digits = onlyDigits(phone);
  if (!digits) return '';
  const withCountry = digits.startsWith('55') ? digits : `55${digits}`;
  return `https://api.whatsapp.com/send?phone=${withCountry}&text=${encodeURIComponent(message)}`;
}

function ridePublicData(ride) {
  return {
    clientRequestId: String(ride.clientRequestId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80),
    nome: String(ride.nome || ''),
    telefoneCliente: onlyDigits(ride.telefoneCliente),
    origem: String(ride.origem || ''),
    destino: String(ride.destino || ''),
    destinoEncontrado: String(ride.destinoEncontrado || ride.destino || ''),
    km: Number(ride.km || 0),
    valor: money(ride.valor),
    precoLabel: String(ride.precoLabel || ''),
    origemMapa: String(ride.origemMapa || '')
  };
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount())
});

const db = admin.firestore();
const app = express();
app.set('trust proxy', 1);

const allowedOrigins = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));
app.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false
}));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Origin not allowed'));
  }
}));

async function mpFetch(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${MP_API}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.message || data.error || `Mercado Pago error ${response.status}`;
    throw new Error(message);
  }
  return data;
}

async function createPaymentPreference(rideId, ride, driverCpf) {
  const driverSnap = await db.collection('motoboys').doc(driverCpf).get();
  const driver = driverSnap.data() || {};
  const sellerToken = driver.mercadoPago?.accessToken;
  if (!sellerToken) {
    const error = new Error('Motoboy ainda nao conectou Mercado Pago.');
    error.status = 409;
    error.code = 'motoboy_sem_mercado_pago';
    throw error;
  }

  const total = money(ride.valor);
  const appFee = money(total * APP_PERCENT);
  const driverAmount = money(total * DRIVER_PERCENT);

  const preference = await mpFetch('/checkout/preferences', {
    token: sellerToken,
    method: 'POST',
    body: {
      external_reference: rideId,
      marketplace_fee: appFee,
      notification_url: `${BACKEND_BASE_URL}/api/mercadopago/webhook`,
      back_urls: {
        success: appUrl('/index.html?pagamento=ok'),
        failure: appUrl('/index.html?pagamento=erro'),
        pending: appUrl('/index.html?pagamento=pendente')
      },
      auto_return: 'approved',
      items: [{
        id: rideId,
        title: `Corrida MotoJa Conchal - ${ride.nome || 'cliente'}`,
        description: `${ride.origem || '-'} para ${ride.destino || '-'}`,
        quantity: 1,
        currency_id: 'BRL',
        unit_price: total
      }],
      metadata: {
        ride_id: rideId,
        driver_cpf: driverCpf,
        app_percent: APP_PERCENT,
        driver_percent: DRIVER_PERCENT
      }
    }
  });

  return {
    preferenceId: preference.id,
    initPoint: preference.init_point,
    sandboxInitPoint: preference.sandbox_init_point,
    total,
    appFee,
    driverAmount
  };
}

async function getDriverWithMercadoPago(driverCpf) {
  const driverSnap = await db.collection('motoboys').doc(driverCpf).get();
  if (!driverSnap.exists) {
    const error = new Error('Motoboy nao cadastrado.');
    error.status = 404;
    error.code = 'motoboy_nao_cadastrado';
    throw error;
  }
  const driver = driverSnap.data();
  if (!driver.mercadoPago?.accessToken) {
    const error = new Error('Motoboy ainda nao conectou Mercado Pago.');
    error.status = 409;
    error.code = 'motoboy_sem_mercado_pago';
    throw error;
  }
  return driver;
}

async function notifyDriversAboutRide(rideId, ride) {
  const drivers = await db.collection('motoboys').where('status', '==', 'ativo').get();
  const tokens = [];

  drivers.forEach((doc) => {
    const data = doc.data();
    const saved = data.fcmTokens || {};
    Object.entries(saved).forEach(([token, info]) => {
      if (info?.ativo !== false) tokens.push(token);
    });
  });

  if (!tokens.length) return { sent: 0, failed: 0 };

  const response = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: {
      title: 'Nova corrida MotoJa Conchal',
      body: `${ride.nome || 'Cliente'} - ${money(ride.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`
    },
    webpush: {
      fcmOptions: {
        link: appUrl('/motoboy.html')
      }
    },
    data: {
      rideId,
      tipo: 'nova_corrida'
    }
  });

  return {
    sent: response.successCount,
    failed: response.failureCount
  };
}

async function cleanupRides() {
  const now = Date.now();
  const batch = db.batch();
  let updated = 0;

  const pending = await db.collection('corridas').where('status', '==', 'pendente').get();
  pending.forEach((doc) => {
    const data = doc.data();
    const createdAt = timestampMs(data.criadaEm);
    if (createdAt && now - createdAt > PENDING_EXPIRE_MS) {
      batch.update(doc.ref, {
        status: 'expirada',
        expiradaEm: admin.firestore.FieldValue.serverTimestamp(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      });
      updated += 1;
    }
  });

  const accepted = await db.collection('corridas').where('status', '==', 'aceita').get();
  accepted.forEach((doc) => {
    const data = doc.data();
    const acceptedAt = timestampMs(data.aceitaEm);
    if (acceptedAt && !data.clienteAvisadoEm && now - acceptedAt > ACCEPTED_NOTICE_MS) {
      batch.update(doc.ref, {
        status: 'pendente',
        motoboy: '',
        motoboyCpf: '',
        motoboyCnh: '',
        motoboyTelefone: '',
        aceitaEm: null,
        reabertaEm: admin.firestore.FieldValue.serverTimestamp(),
        motivoReabertura: 'Backend reabriu: motoboy aceitou e nao avisou o cliente em 3 minutos',
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      });
      updated += 1;
    }
  });

  if (updated > 0) await batch.commit();
  return { updated };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'motoja-conchal-backend' });
});

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'motoja-conchal-backend',
    site: process.env.APP_BASE_URL || null
  });
});

app.post('/api/drivers/:cpf/push-token', async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.params.cpf);
    const token = String(req.body.token || '').trim();
    if (driverCpf.length !== 11 || !token) {
      return res.status(400).json({ error: 'dados_invalidos' });
    }

    await db.collection('motoboys').doc(driverCpf).set({
      fcmTokens: {
        [token]: {
          ativo: true,
          userAgent: String(req.body.userAgent || '').slice(0, 300),
          atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
        }
      },
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/rides', async (req, res, next) => {
  try {
    const ride = ridePublicData(req.body);
    if (!ride.nome || !ride.origem || !ride.destino || ride.telefoneCliente.length < 10 || ride.telefoneCliente.length > 11) {
      return res.status(400).json({ error: 'preencha_nome_telefone_origem_destino' });
    }
    if (!ride.valor || ride.valor <= 0) {
      return res.status(400).json({ error: 'valor_invalido' });
    }
    if (money(ride.valor) !== expectedFare(ride.km)) {
      return res.status(400).json({ error: 'valor_nao_confere_com_tabela' });
    }

    const ref = ride.clientRequestId
      ? db.collection('corridas').doc(ride.clientRequestId)
      : db.collection('corridas').doc();
    let created = false;

    await db.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      if (existing.exists) return;

      tx.set(ref, {
        ...ride,
        status: 'pendente',
        pagamento: 'mercadopago_apos_aceite',
        criadaEm: admin.firestore.FieldValue.serverTimestamp(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      });
      created = true;
    });

    if (!created) {
      return res.status(200).json({ rideId: ref.id, duplicated: true, push: { sent: 0, failed: 0 } });
    }

    const push = await notifyDriversAboutRide(ref.id, ride).catch((error) => {
      console.error('driver push failed', error);
      return { sent: 0, failed: 0 };
    });

    res.status(201).json({ rideId: ref.id, push });
  } catch (error) {
    next(error);
  }
});

app.post('/api/rides/:rideId/accept', async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.body.driverCpf);
    if (driverCpf.length !== 11) return res.status(400).json({ error: 'driverCpf_invalido' });

    const driver = await getDriverWithMercadoPago(driverCpf);
    let acceptedRide = null;
    const rideRef = db.collection('corridas').doc(req.params.rideId);

    await db.runTransaction(async (tx) => {
      const rideSnap = await tx.get(rideRef);
      if (!rideSnap.exists) {
        const error = new Error('Corrida nao encontrada.');
        error.status = 404;
        throw error;
      }

      const ride = rideSnap.data();
      if (ride.status !== 'pendente') {
        const error = new Error(`Corrida ja foi aceita por ${ride.motoboy || 'outro motoboy'}.`);
        error.status = 409;
        throw error;
      }

      acceptedRide = ride;
      tx.update(rideRef, {
        status: 'aceita',
        motoboy: driver.nome || req.body.driverName || '',
        motoboyCpf: driverCpf,
        motoboyCnh: driver.cnh || '',
        motoboyTelefone: driver.telefone || '',
        aceitaEm: admin.firestore.FieldValue.serverTimestamp(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    const payment = await createPaymentPreference(req.params.rideId, acceptedRide, driverCpf);
    await rideRef.set({
      pagamento: {
        provider: 'mercadopago',
        preferenceId: payment.preferenceId,
        initPoint: payment.initPoint,
        sandboxInitPoint: payment.sandboxInitPoint,
        status: 'preference_created',
        total: payment.total,
        appFee: payment.appFee,
        driverAmount: payment.driverAmount,
        criadoEm: admin.firestore.FieldValue.serverTimestamp()
      },
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({ ok: true, payment });
  } catch (error) {
    next(error);
  }
});

app.post('/api/rides/:rideId/notify-client', async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.body.driverCpf);
    const rideRef = db.collection('corridas').doc(req.params.rideId);
    const rideSnap = await rideRef.get();
    if (!rideSnap.exists) return res.status(404).json({ error: 'corrida_nao_encontrada' });

    const ride = rideSnap.data();
    if (ride.status !== 'aceita' || onlyDigits(ride.motoboyCpf) !== driverCpf) {
      return res.status(409).json({ error: 'corrida_nao_pertence_ao_motoboy' });
    }
    if (!ride.pagamento?.initPoint) {
      return res.status(409).json({ error: 'pagamento_nao_criado' });
    }

    const message = `Ola, ${ride.nome || 'cliente'}! Seu motoboy ${ride.motoboy || 'MotoJa Conchal'} aceitou a corrida.\n\nValor: ${money(ride.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}\nOrigem: ${ride.origem || '-'}\nDestino: ${ride.destino || '-'}\n\nPague por este link Mercado Pago:\n${ride.pagamento.initPoint}\n\nDepois do pagamento aprovado, envie o comprovante aqui se quiser e mostre ao motoboy antes de iniciar a corrida.`;

    await rideRef.set({
      clienteAvisadoEm: admin.firestore.FieldValue.serverTimestamp(),
      clienteAvisadoPor: ride.motoboy || '',
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({ ok: true, whatsapp: whatsappLink(ride.telefoneCliente, message) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/rides/:rideId/cancel', async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.body.driverCpf);
    const reason = String(req.body.reason || '').trim().slice(0, 300);
    if (driverCpf.length !== 11 || !reason) {
      return res.status(400).json({ error: 'cpf_e_motivo_obrigatorios' });
    }

    const rideRef = db.collection('corridas').doc(req.params.rideId);
    const rideSnap = await rideRef.get();
    if (!rideSnap.exists) return res.status(404).json({ error: 'corrida_nao_encontrada' });

    const ride = rideSnap.data();
    if (onlyDigits(ride.motoboyCpf) !== driverCpf) {
      return res.status(409).json({ error: 'corrida_nao_pertence_ao_motoboy' });
    }
    if (ride.status === 'finalizada') {
      return res.status(409).json({ error: 'corrida_ja_finalizada' });
    }

    await rideRef.set({
      status: 'cancelada',
      motivoCancelamento: reason,
      canceladoPor: ride.motoboy || '',
      canceladoPorCpf: driverCpf,
      canceladoEm: admin.firestore.FieldValue.serverTimestamp(),
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    const message = `Ola, ${ride.nome || 'cliente'}. O motoboy ${ride.motoboy || 'MotoJa Conchal'} cancelou a corrida.\n\nMotivo: ${reason}\n\nPor favor, peca uma nova corrida pelo app.`;
    res.json({ ok: true, whatsapp: whatsappLink(ride.telefoneCliente, message) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/rides/:rideId/finish', async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.body.driverCpf);
    if (driverCpf.length !== 11) return res.status(400).json({ error: 'driverCpf_invalido' });

    const rideRef = db.collection('corridas').doc(req.params.rideId);
    const rideSnap = await rideRef.get();
    if (!rideSnap.exists) return res.status(404).json({ error: 'corrida_nao_encontrada' });

    const ride = rideSnap.data();
    if (onlyDigits(ride.motoboyCpf) !== driverCpf) {
      return res.status(409).json({ error: 'corrida_nao_pertence_ao_motoboy' });
    }
    if (!ride.clienteAvisadoEm) {
      return res.status(409).json({ error: 'avise_o_cliente_antes_de_finalizar' });
    }
    if (ride.pagamento?.status !== 'approved') {
      return res.status(409).json({ error: 'pagamento_ainda_nao_aprovado' });
    }
    if (ride.status === 'cancelada') {
      return res.status(409).json({ error: 'corrida_cancelada' });
    }

    await rideRef.set({
      status: 'finalizada',
      finalizadaEm: admin.firestore.FieldValue.serverTimestamp(),
      ganhoMotoboy: DRIVER_PERCENT,
      ganhoApp: APP_PERCENT,
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/mercadopago/oauth/start', (req, res) => {
  const driverCpf = onlyDigits(req.query.driverCpf);
  if (driverCpf.length !== 11) {
    return res.status(400).json({ error: 'driverCpf invalido' });
  }

  const params = new URLSearchParams({
    client_id: requiredEnv('MP_CLIENT_ID'),
    response_type: 'code',
    platform_id: 'mp',
    state: driverCpf,
    redirect_uri: requiredEnv('MP_REDIRECT_URI')
  });

  return res.redirect(`https://auth.mercadopago.com.br/authorization?${params.toString()}`);
});

app.get('/api/mercadopago/oauth/callback', async (req, res, next) => {
  try {
    const code = String(req.query.code || '');
    const driverCpf = onlyDigits(req.query.state);
    if (!code || driverCpf.length !== 11) {
      return res.status(400).send('Autorizacao invalida.');
    }

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: requiredEnv('MP_CLIENT_ID'),
      client_secret: requiredEnv('MP_CLIENT_SECRET'),
      code,
      redirect_uri: requiredEnv('MP_REDIRECT_URI')
    });

    const response = await fetch(`${MP_API}/oauth/token`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: params
    });
    const token = await response.json();
    if (!response.ok) throw new Error(token.message || 'Falha ao autorizar Mercado Pago');

    await db.collection('motoboys').doc(driverCpf).set({
      mercadoPago: {
        userId: token.user_id || null,
        accessToken: token.access_token,
        refreshToken: token.refresh_token || null,
        publicKey: token.public_key || null,
        liveMode: !!token.live_mode,
        scope: token.scope || null,
        expiresIn: token.expires_in || null,
        conectadoEm: admin.firestore.FieldValue.serverTimestamp()
      },
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return res.redirect(appUrl('/motoboy.html?mp=ok'));
  } catch (error) {
    return next(error);
  }
});

app.post('/api/rides/:rideId/payment/preference', assertAdmin, async (req, res, next) => {
  try {
    const rideRef = db.collection('corridas').doc(req.params.rideId);
    const rideSnap = await rideRef.get();
    if (!rideSnap.exists) return res.status(404).json({ error: 'corrida_nao_encontrada' });

    const ride = rideSnap.data();
    const driverCpf = onlyDigits(req.body.driverCpf || ride.motoboyCpf);
    if (driverCpf.length !== 11) return res.status(400).json({ error: 'motoboy_sem_cpf' });

    const preference = await createPaymentPreference(rideSnap.id, ride, driverCpf);

    await rideRef.set({
      pagamento: {
        provider: 'mercadopago',
        preferenceId: preference.preferenceId,
        initPoint: preference.initPoint,
        sandboxInitPoint: preference.sandboxInitPoint,
        status: 'preference_created',
        total: preference.total,
        appFee: preference.appFee,
        driverAmount: preference.driverAmount,
        criadoEm: admin.firestore.FieldValue.serverTimestamp()
      },
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({
      ...preference
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/mercadopago/webhook', async (req, res, next) => {
  try {
    const paymentId = req.query.id || req.body?.data?.id;
    const topic = req.query.topic || req.query.type || req.body?.type;
    if (!paymentId || !String(topic).includes('payment')) {
      return res.status(200).json({ ignored: true });
    }

    const payment = await mpFetch(`/v1/payments/${paymentId}`, {
      token: requiredEnv('MP_OWNER_ACCESS_TOKEN')
    });
    const rideId = payment.external_reference || payment.metadata?.ride_id;
    if (!rideId) return res.status(200).json({ ignored: true });

    await db.collection('corridas').doc(String(rideId)).set({
      pagamento: {
        provider: 'mercadopago',
        paymentId: String(payment.id),
        status: payment.status,
        statusDetail: payment.status_detail || null,
        totalPago: money(payment.transaction_amount),
        appFee: money(payment.marketplace_fee || 0),
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
      },
      pagamentoConfirmadoEm: payment.status === 'approved'
        ? admin.firestore.FieldValue.serverTimestamp()
        : null,
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/jobs/cleanup', assertAdmin, async (_req, res, next) => {
  try {
    res.json(await cleanupRides());
  } catch (error) {
    next(error);
  }
});

setInterval(() => {
  cleanupRides().catch((error) => console.error('cleanup failed', error));
}, 30 * 1000);

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({
    error: error.code || 'internal_error',
    message: error.message
  });
});

app.listen(PORT, () => {
  console.log(`MotoJa Conchal backend listening on ${PORT}`);
});
