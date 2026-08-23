import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import admin from 'firebase-admin';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';

const PORT = Number(process.env.PORT || 10000);
const DRIVER_PERCENT = Number(process.env.DRIVER_PERCENT || 0.7);
const APP_PERCENT = Number(process.env.APP_PERCENT || 0.3);
const PENDING_EXPIRE_MS = Number(process.env.PENDING_EXPIRE_MINUTES || 5) * 60 * 1000;
const ACCEPTED_NOTICE_MS = Number(process.env.ACCEPTED_NOTICE_MINUTES || 3) * 60 * 1000;
const DUPLICATE_RIDE_MS = Number(process.env.DUPLICATE_RIDE_SECONDS || 45) * 1000;
const MP_API = 'https://api.mercadopago.com';
const BACKEND_BASE_URL = String(process.env.BACKEND_BASE_URL || '').replace(/\/$/, '');
const OWNER_WHATSAPP = onlyDigits(process.env.OWNER_WHATSAPP || process.env.SUPPORT_PHONE || '5519992306488');
const GEOAPIFY_API_KEY = process.env.GEOAPIFY_API_KEY || '1361a528dcbe484e8143a19929527781';

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

function rideSplit(km) {
  const distance = Number(km || 0);
  const appPercent = distance > 8 ? 0.2 : 0.25;
  return {
    appPercent,
    driverPercent: money(1 - appPercent)
  };
}

function isOutOfConchal(value) {
  const text = normalizeText(value);
  return !!text && !text.includes('conchal');
}

function isFixedFoodDelivery(type) {
  return /lanche|comida|pizza|pastel|acai|sorvete|marmita/i.test(String(type || ''));
}

function deliverySplit(delivery = {}) {
  const total = money(delivery.valor);
  if (isFixedFoodDelivery(delivery.tipoEntrega)) {
    const appFee = money(1.5 * deliveryStopCount(delivery.paradas));
    return {
      appFee: money(Math.min(total, appFee)),
      driverAmount: money(Math.max(0, total - appFee)),
      appPercent: total ? money(appFee / total) : 0,
      driverPercent: total ? money((total - appFee) / total) : 0
    };
  }
  const appPercent = isOutOfConchal(delivery.entregaEncontrada || delivery.entrega) ? 0.2 : 0.25;
  return {
    appFee: money(total * appPercent),
    driverAmount: money(total * (1 - appPercent)),
    appPercent,
    driverPercent: money(1 - appPercent)
  };
}

function isPricedDeliveryType(type) {
  const value = normalizeText(type);
  return !!value && value !== 'delivery / encomendas';
}

function expectedDeliveryFare(distanceKm, stops = 1, type = '') {
  const distance = Number(distanceKm || 0);
  const deliveryStops = deliveryStopCount(stops);
  if (!Number.isFinite(distance) || distance <= 0) return 0;

  if (isFixedFoodDelivery(type)) {
    return money(5.5 * deliveryStops);
  }

  return money(Math.ceil(distance * 2));
}

function deliveryStopCount(stops = 1) {
  const count = Math.floor(Number(stops || 1));
  if (!Number.isFinite(count)) return 1;
  return Math.min(30, Math.max(1, count));
}

function validCoordinate(point) {
  return point
    && Number.isFinite(Number(point.lat))
    && Number.isFinite(Number(point.lon))
    && Math.abs(Number(point.lat)) <= 90
    && Math.abs(Number(point.lon)) <= 180;
}

async function calculateRouteDistanceKm(points = []) {
  if (!GEOAPIFY_API_KEY) throw new Error('Geoapify nao configurado no backend.');
  if (!Array.isArray(points) || points.length < 2 || points.some((point) => !validCoordinate(point))) {
    const error = new Error('Coordenadas invalidas para conferir a rota.');
    error.status = 400;
    error.code = 'coordenadas_invalidas';
    throw error;
  }

  const waypoints = points.map((point) => `${Number(point.lat)},${Number(point.lon)}`).join('|');
  const url = `https://api.geoapify.com/v1/routing?waypoints=${encodeURIComponent(waypoints)}&mode=drive&apiKey=${GEOAPIFY_API_KEY}`;
  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error('Nao consegui conferir a rota no servidor. Tente novamente.');
    error.status = 502;
    error.code = 'rota_backend_falhou';
    throw error;
  }
  const data = await response.json();
  const meters = data.features?.[0]?.properties?.distance;
  if (!Number.isFinite(Number(meters)) || Number(meters) <= 0) {
    const error = new Error('Rota nao encontrada para os pontos informados.');
    error.status = 400;
    error.code = 'rota_backend_nao_encontrada';
    throw error;
  }
  return money(Number(meters) / 1000);
}

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function cleanText(value, max = 200) {
  return String(value || '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function bairroFromAddress(value) {
  const parts = String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 3) return parts[2].slice(0, 80);
  if (parts.length >= 2) return parts[1].replace(/\d+/g, '').trim().slice(0, 80) || 'Nao informado';
  return 'Nao informado';
}

function timestampMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts.seconds === 'number') return ts.seconds * 1000;
  return 0;
}

function serializeFirestore(value) {
  if (!value) return value;
  if (typeof value.toDate === 'function') {
    return { seconds: Math.floor(value.toDate().getTime() / 1000) };
  }
  if (Array.isArray(value)) return value.map(serializeFirestore);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializeFirestore(item)]));
  }
  return value;
}

async function collectionState(name, limit = 500) {
  const snapshot = await db.collection(name).limit(limit).get();
  return snapshot.docs
    .map((docSnap) => serializeFirestore({ id: docSnap.id, ...docSnap.data() }))
    .sort((a, b) => timestampMs(b.finalizadaEm || b.aceitaEm || b.criadaEm || b.ultimoAcesso) - timestampMs(a.finalizadaEm || a.aceitaEm || a.criadaEm || a.ultimoAcesso));
}

function publicPendingJob(job = {}) {
  const copy = { ...job };
  delete copy.telefoneCliente;
  delete copy.telefoneEmpresa;
  delete copy.telefoneRecebedor;
  delete copy.motoboyCpf;
  delete copy.motoboyCnh;
  delete copy.motoboyTelefone;
  return copy;
}

function sortJobs(items = []) {
  return items.sort((a, b) => timestampMs(b.finalizadaEm || b.aceitaEm || b.criadaEm) - timestampMs(a.finalizadaEm || a.aceitaEm || a.criadaEm));
}

function assertAdmin(req, res, next) {
  const key = process.env.ADMIN_API_KEY;
  if (!key || req.header('x-admin-key') !== key) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return next();
}

function ownerPasswordValue() {
  return process.env.OWNER_PASSWORD || process.env.ADMIN_PANEL_PASSWORD || '';
}

function driverPasswordValues() {
  const configured = String(process.env.DRIVER_PASSWORD || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return Array.from(new Set(['moto123', ...configured]));
}

function isValidDriverPassword(password) {
  const typed = String(password || '');
  return driverPasswordValues().some((allowed) => safeEqual(typed, allowed));
}

function assertOwner(req, res, next) {
  const ownerPassword = ownerPasswordValue();
  const password = String(req.header('x-owner-password') || req.body.password || '');
  if (!ownerPassword) {
    return res.status(503).json({ error: 'owner_password_not_configured' });
  }
  if (!safeEqual(password, ownerPassword)) {
    return res.status(401).json({ error: 'senha_incorreta' });
  }
  return next();
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function assertDriverProof(driver = {}, body = {}) {
  const expectedCnh = onlyDigits(driver.cnh);
  const expectedPhone = onlyDigits(driver.telefone);
  const givenCnh = onlyDigits(body.driverCnh);
  const givenPhone = onlyDigits(body.driverTelefone);

  if (!expectedCnh || !expectedPhone || expectedCnh !== givenCnh || expectedPhone !== givenPhone) {
    const error = new Error('Dados do motoboy nao conferem. Entre novamente no painel.');
    error.status = 401;
    error.code = 'dados_motoboy_nao_conferem';
    throw error;
  }
}

async function getDriverWithProof(driverCpf, body = {}) {
  const driverSnap = await db.collection('motoboys').doc(driverCpf).get();
  if (!driverSnap.exists) {
    const error = new Error('Motoboy nao cadastrado.');
    error.status = 404;
    error.code = 'motoboy_nao_cadastrado';
    throw error;
  }

  const driver = driverSnap.data() || {};
  assertDriverProof(driver, body);
  return driver;
}

function companyRefFromPhone(phone) {
  const id = onlyDigits(phone);
  if (id.length < 10 || id.length > 11) return null;
  return db.collection('empresas').doc(id);
}

function companyBalance(data = {}) {
  const saldo = money(data.saldo || 0);
  const reservado = money(data.reservado || 0);
  return {
    saldo,
    reservado,
    disponivel: money(saldo - reservado)
  };
}

function ledgerRef(companyId) {
  return db.collection('empresas').doc(companyId).collection('movimentacoes').doc();
}

function depositPublicData(body) {
  return {
    empresa: String(body.empresa || '').slice(0, 120).trim(),
    responsavel: String(body.responsavel || '').slice(0, 120).trim(),
    telefoneEmpresa: onlyDigits(body.telefoneEmpresa),
    valor: money(body.valor)
  };
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

function escapeTelegram(text) {
  return String(text || '').replace(/[&<>]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;'
  }[char]));
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

function deliveryPublicData(delivery) {
  return {
    clientRequestId: String(delivery.clientRequestId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80),
    empresa: String(delivery.empresa || '').slice(0, 120).trim(),
    responsavel: String(delivery.responsavel || '').slice(0, 120).trim(),
    telefoneEmpresa: onlyDigits(delivery.telefoneEmpresa),
    tipoEntrega: String(delivery.tipoEntrega || 'Delivery / encomendas').slice(0, 80).trim(),
    retirada: String(delivery.retirada || '').slice(0, 300).trim(),
    retiradaLat: Number(delivery.retiradaLat || 0),
    retiradaLon: Number(delivery.retiradaLon || 0),
    entrega: String(delivery.entrega || '').slice(0, 300).trim(),
    entregaLat: Number(delivery.entregaLat || 0),
    entregaLon: Number(delivery.entregaLon || 0),
    entregaEncontrada: String(delivery.entregaEncontrada || delivery.entrega || '').slice(0, 300).trim(),
    recebedor: String(delivery.recebedor || '').slice(0, 120).trim(),
    telefoneRecebedor: onlyDigits(delivery.telefoneRecebedor).slice(0, 13),
    enderecosExtras: String(delivery.enderecosExtras || '').slice(0, 1200).trim(),
    pontosExtras: Array.isArray(delivery.pontosExtras) ? delivery.pontosExtras.slice(0, 29).map((p, index) => ({
      ordem: Number(p.ordem || index + 2),
      digitado: String(p.digitado || '').slice(0, 180).trim(),
      encontrado: String(p.encontrado || '').slice(0, 220).trim(),
      lat: Number(p.lat || 0),
      lon: Number(p.lon || 0),
      mapa: String(p.mapa || '').slice(0, 260).trim(),
    })) : [],
    descricao: String(delivery.descricao || '').slice(0, 500).trim(),
    observacao: String(delivery.observacao || '').slice(0, 500).trim(),
    paradas: deliveryStopCount(delivery.paradas),
    km: Number(delivery.km || 0),
    valor: money(delivery.valor),
    precoLabel: String(delivery.precoLabel || ''),
    retiradaMapa: String(delivery.retiradaMapa || '')
  };
}

async function notifyTelegramAboutRide(rideId, ride) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { sent: false, skipped: true };

  const value = money(ride.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const km = Number(ride.km || 0).toFixed(2).replace('.', ',');
  const appLink = process.env.APP_BASE_URL
    ? appUrl('/motoboy.html')
    : 'https://nexusconchal.github.io/moto-conchal/motoboy.html';
  const originMap = ride.origemMapa ? `\nMapa origem: ${ride.origemMapa}` : '';
  const message = [
    '<b>NOVA CORRIDA TOCANDO</b>',
    '',
    `<b>Cliente:</b> ${escapeTelegram(ride.nome || 'Cliente')}`,
    `<b>Valor:</b> ${escapeTelegram(value)}`,
    `<b>Distancia:</b> ${escapeTelegram(km)} km`,
    `<b>Origem:</b> ${escapeTelegram(ride.origem || '-')}${escapeTelegram(originMap)}`,
    `<b>Destino:</b> ${escapeTelegram(ride.destino || '-')}`,
    '',
    '<b>Expira em:</b> 5 minutos',
    '',
    `Abra o app do motorista para aceitar:\n${escapeTelegram(appLink)}`,
    '',
    `Codigo: <code>${escapeTelegram(rideId)}</code>`
  ].join('\n');

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.description || `Telegram error ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return { sent: true, messageId: data.result?.message_id || null };
}

async function notifyTelegramAboutDelivery(deliveryId, delivery) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { sent: false, skipped: true };

  const value = money(delivery.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const km = Number(delivery.km || 0).toFixed(2).replace('.', ',');
  const appLink = process.env.APP_BASE_URL
    ? appUrl('/motoboy.html')
    : 'https://nexusconchal.github.io/moto-conchal/motoboy.html';
  const pickupMap = delivery.retiradaMapa ? `\nMapa retirada: ${delivery.retiradaMapa}` : '';
  const message = [
    '<b>NOVA ENTREGA EMPRESARIAL</b>',
    '',
    `<b>Empresa:</b> ${escapeTelegram(delivery.empresa || '-')}`,
    `<b>Responsavel:</b> ${escapeTelegram(delivery.responsavel || '-')}`,
    `<b>Tipo:</b> ${escapeTelegram(delivery.tipoEntrega || 'Delivery / encomendas')}`,
    `<b>Valor:</b> ${escapeTelegram(value)}`,
    `<b>Distancia:</b> ${escapeTelegram(km)} km`,
    `<b>Paradas:</b> ${escapeTelegram(delivery.paradas || 1)}`,
    `<b>Retirada:</b> ${escapeTelegram(delivery.retirada || '-')}${escapeTelegram(pickupMap)}`,
    `<b>Entrega:</b> ${escapeTelegram(delivery.entrega || '-')}`,
    Array.isArray(delivery.pontosExtras) && delivery.pontosExtras.length ? `<b>Pontos extras:</b>\n${delivery.pontosExtras.map((p) => `${escapeTelegram(p.ordem || '')}. ${escapeTelegram(p.digitado || '')}${p.mapa ? `\nMapa: ${escapeTelegram(p.mapa)}` : ''}`).join('\n')}` : (delivery.enderecosExtras ? `<b>Pontos extras:</b> ${escapeTelegram(delivery.enderecosExtras)}` : ''),
    delivery.recebedor ? `<b>Recebedor:</b> ${escapeTelegram(delivery.recebedor)}` : '',
    delivery.telefoneRecebedor ? `<b>WhatsApp recebedor:</b> ${escapeTelegram(delivery.telefoneRecebedor)}` : '',
    delivery.descricao ? `<b>Pedido:</b> ${escapeTelegram(delivery.descricao)}` : '',
    delivery.observacao ? `<b>Obs:</b> ${escapeTelegram(delivery.observacao)}` : '',
    '',
    '<b>Expira em:</b> 5 minutos',
    '',
    `Abra o app do motorista para aceitar:\n${escapeTelegram(appLink)}`,
    '',
    `Codigo: <code>${escapeTelegram(deliveryId)}</code>`
  ].filter(Boolean).join('\n');

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.description || `Telegram error ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return { sent: true, messageId: data.result?.message_id || null };
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount())
});

const db = admin.firestore();
const app = express();
app.set('trust proxy', 1);

const DEFAULT_ALLOWED_ORIGINS = 'https://nexusconchal.github.io,https://motoboy-conchal.onrender.com';
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS)
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

const createRideLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'muitas_tentativas', message: 'Aguarde um pouco antes de pedir outra corrida.' }
});

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
  const split = rideSplit(ride.km);
  const appFee = money(total * split.appPercent);
  const driverAmount = money(total * split.driverPercent);

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
        app_percent: split.appPercent,
        driver_percent: split.driverPercent
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
  let batchUpdated = 0;

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
      batchUpdated += 1;
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
      batchUpdated += 1;
    }
  });

  const pendingDeliveries = await db.collection('entregas').where('status', '==', 'pendente').get();
  for (const doc of pendingDeliveries.docs) {
    const data = doc.data();
    const createdAt = timestampMs(data.criadaEm);
    if (createdAt && now - createdAt > PENDING_EXPIRE_MS) {
      await releaseDeliveryReservation(doc.ref, 'expirada', {
        expiradaEm: admin.firestore.FieldValue.serverTimestamp(),
      });
      updated += 1;
    }
  }

  if (batchUpdated > 0) await batch.commit();
  return { updated };
}

async function findRecentDuplicateRide(ride) {
  const now = Date.now();
  const snapshot = await db.collection('corridas')
    .where('telefoneCliente', '==', ride.telefoneCliente)
    .where('status', 'in', ['pendente', 'aceita'])
    .limit(10)
    .get();

  const origem = normalizeText(ride.origem);
  const destino = normalizeText(ride.destino);

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const createdAt = timestampMs(data.criadaEm);
    if (!createdAt || now - createdAt > DUPLICATE_RIDE_MS) continue;
    if (normalizeText(data.origem) === origem && normalizeText(data.destino) === destino) {
      return doc.id;
    }
  }

  return '';
}

async function findRecentDuplicateDelivery(delivery) {
  const now = Date.now();
  const snapshot = await db.collection('entregas')
    .where('telefoneEmpresa', '==', delivery.telefoneEmpresa)
    .where('status', 'in', ['pendente', 'aceita'])
    .limit(10)
    .get();

  const retirada = normalizeText(delivery.retirada);
  const entrega = normalizeText(delivery.entrega);

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const createdAt = timestampMs(data.criadaEm);
    if (!createdAt || now - createdAt > DUPLICATE_RIDE_MS) continue;
    if (normalizeText(data.retirada) === retirada && normalizeText(data.entrega) === entrega) {
      return doc.id;
    }
  }

  return '';
}

async function releaseDeliveryReservation(deliveryRef, status, extra = {}) {
  let released = false;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(deliveryRef);
    if (!snap.exists) return;
    const delivery = snap.data();
    if (delivery.status === 'finalizada') return;

    const valor = money(delivery.saldoReservado || delivery.valor || 0);
    const companyRef = companyRefFromPhone(delivery.empresaId || delivery.telefoneEmpresa);
    const updates = {
      status,
      ...extra,
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    };

    if (valor > 0 && !delivery.saldoLiberadoEm && !delivery.saldoDebitadoEm && companyRef) {
      const companySnap = await tx.get(companyRef);
      const balance = companyBalance(companySnap.exists ? companySnap.data() : {});
      const nextReserved = money(Math.max(0, balance.reservado - valor));
      tx.set(companyRef, {
        reservado: nextReserved,
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      tx.set(ledgerRef(companyRef.id), {
        tipo: 'liberacao_reserva',
        origem: status,
        entregaId: deliveryRef.id,
        valor,
        saldoAntes: balance.saldo,
        saldoDepois: balance.saldo,
        reservadoAntes: balance.reservado,
        reservadoDepois: nextReserved,
        criadoEm: admin.firestore.FieldValue.serverTimestamp()
      });
      updates.saldoLiberadoEm = admin.firestore.FieldValue.serverTimestamp();
      released = true;
    }

    tx.update(deliveryRef, updates);
  });
  return released;
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

app.post('/api/admin/login', (req, res) => {
  const ownerPassword = ownerPasswordValue();
  const password = String(req.body.password || '');
  if (!ownerPassword) {
    return res.status(503).json({ error: 'owner_password_not_configured' });
  }
  if (!safeEqual(password, ownerPassword)) {
    return res.status(401).json({ error: 'senha_incorreta' });
  }
  return res.json({ ok: true });
});

app.get('/api/admin/state', assertOwner, async (_req, res, next) => {
  try {
    const [corridas, entregas, motoboys, depositos] = await Promise.all([
      collectionState('corridas'),
      collectionState('entregas'),
      collectionState('motoboys'),
      collectionState('depositos')
    ]);
    return res.json({ ok: true, corridas, entregas, motoboys, depositos });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/admin/rides/:rideId/cancel', assertOwner, async (req, res, next) => {
  try {
    const rideId = String(req.params.rideId || '').trim();
    const motivo = cleanText(req.body.reason || req.body.motivo, 180);
    if (!rideId || !motivo) return res.status(400).json({ error: 'motivo_obrigatorio' });
    await db.collection('corridas').doc(rideId).update({
      status: 'cancelada',
      motivoCancelamento: motivo,
      canceladoPor: 'Dono',
      canceladoEm: admin.firestore.FieldValue.serverTimestamp(),
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/drivers/register', async (req, res, next) => {
  try {
    const password = String(req.body.password || '');
    const nome = cleanText(req.body.nome, 80);
    const cpf = onlyDigits(req.body.cpf);
    const cnh = onlyDigits(req.body.cnh);
    const telefone = onlyDigits(req.body.telefone);

    if (!isValidDriverPassword(password)) {
      return res.status(401).json({ error: 'senha_incorreta' });
    }
    if (!nome || cpf.length !== 11 || cnh.length !== 11 || telefone.length < 10 || telefone.length > 11) {
      return res.status(400).json({ error: 'dados_invalidos' });
    }

    const driverRef = db.collection('motoboys').doc(cpf);
    const driverSnap = await driverRef.get();
    if (driverSnap.exists) {
      const driver = driverSnap.data() || {};
      const savedCnh = onlyDigits(driver.cnh);
      const savedPhone = onlyDigits(driver.telefone);
      if ((savedCnh && savedCnh !== cnh) || (savedPhone && savedPhone !== telefone)) {
        return res.status(409).json({
          error: 'cadastro_ja_existe',
          message: 'CPF ja cadastrado com outros dados. Fale com o dono para conferir.'
        });
      }
    }

    await driverRef.set({
      nome,
      cpf,
      cnh,
      telefone,
      status: 'ativo',
      ultimoAcesso: admin.firestore.FieldValue.serverTimestamp(),
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/drivers/:cpf/jobs', async (req, res, next) => {
  try {
    await cleanupRides();
    const driverCpf = onlyDigits(req.params.cpf);
    const kind = req.body.kind === 'deliveries' ? 'deliveries' : 'rides';
    const scope = req.body.scope === 'mine' ? 'mine' : 'pending';
    const collectionName = kind === 'deliveries' ? 'entregas' : 'corridas';
    if (driverCpf.length !== 11) return res.status(400).json({ error: 'driverCpf_invalido' });
    await getDriverWithProof(driverCpf, req.body);

    const queryRef = scope === 'mine'
      ? db.collection(collectionName).where('motoboyCpf', '==', driverCpf).limit(100)
      : db.collection(collectionName).where('status', '==', 'pendente').limit(100);
    const snapshot = await queryRef.get();
    const jobs = sortJobs(snapshot.docs.map((docSnap) => {
      const item = serializeFirestore({ id: docSnap.id, ...docSnap.data() });
      return scope === 'pending' ? publicPendingJob(item) : item;
    }));
    return res.json({ ok: true, jobs });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/companies/:phone/balance', async (req, res, next) => {
  try {
    const companyRef = companyRefFromPhone(req.params.phone);
    if (!companyRef) return res.status(400).json({ error: 'telefone_empresa_invalido' });

    const snap = await companyRef.get();
    const data = snap.exists ? snap.data() : {};
    res.json({ ok: true, telefoneEmpresa: companyRef.id, ...companyBalance(data) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/companies/:phone/delivery-report', async (req, res, next) => {
  try {
    const phone = onlyDigits(req.params.phone);
    if (phone.length < 10 || phone.length > 11) return res.status(400).json({ error: 'telefone_empresa_invalido' });

    const snapshot = await db.collection('entregas')
      .where('telefoneEmpresa', '==', phone)
      .limit(200)
      .get();

    const sinceMs = Number(req.query.sinceMs || 0);
    const untilMs = Number(req.query.untilMs || 0);
    const deliveries = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => timestampMs(b.criadaEm) - timestampMs(a.criadaEm));
    const scopedDeliveries = deliveries.filter((item) => {
      const created = timestampMs(item.criadaEm);
      if (sinceMs && created < sinceMs) return false;
      if (untilMs && created > untilMs) return false;
      return true;
    });
    const billable = scopedDeliveries.filter((item) => item.status !== 'cancelada' && item.status !== 'expirada');
    const byNeighborhood = {};

    billable.forEach((item) => {
      const bairro = item.bairroEntrega || bairroFromAddress(item.entregaEncontrada || item.entrega);
      const split = deliverySplit(item);
      byNeighborhood[bairro] ??= { bairro, quantidade: 0, total: 0 };
      byNeighborhood[bairro].quantidade += 1;
      byNeighborhood[bairro].total = money(byNeighborhood[bairro].total + money(item.valor));
      byNeighborhood[bairro].motoboy = money((byNeighborhood[bairro].motoboy || 0) + split.driverAmount);
      byNeighborhood[bairro].app = money((byNeighborhood[bairro].app || 0) + split.appFee);
    });
    const totalMotoboy = money(billable.reduce((sum, item) => sum + deliverySplit(item).driverAmount, 0));
    const totalApp = money(billable.reduce((sum, item) => sum + deliverySplit(item).appFee, 0));

    res.json({
      ok: true,
      totalEntregas: scopedDeliveries.length,
      faturaveis: billable.length,
      totalGasto: money(billable.reduce((sum, item) => sum + money(item.valor), 0)),
      totalMotoboy,
      totalApp,
      porBairro: Object.values(byNeighborhood).sort((a, b) => b.quantidade - a.quantidade),
      ultimas: scopedDeliveries.slice(0, 20).map((item) => ({
        id: item.id,
        status: item.status || '',
        tipoEntrega: item.tipoEntrega || '',
        entrega: item.entrega || '',
        enderecosExtras: item.enderecosExtras || '',
        pontosExtras: item.pontosExtras || [],
        bairroEntrega: item.bairroEntrega || bairroFromAddress(item.entregaEncontrada || item.entrega),
        valor: money(item.valor),
        criadaEm: timestampMs(item.criadaEm)
      }))
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/companies/deposit-request', createRideLimiter, async (req, res, next) => {
  try {
    const deposit = depositPublicData(req.body);
    if (!deposit.empresa || !deposit.responsavel || deposit.telefoneEmpresa.length < 10 || deposit.telefoneEmpresa.length > 11) {
      return res.status(400).json({ error: 'preencha_empresa_responsavel_telefone' });
    }
    if (!deposit.valor || deposit.valor < 10 || deposit.valor > 5000) {
      return res.status(400).json({ error: 'valor_deposito_invalido', message: 'Deposito deve ser entre R$ 10,00 e R$ 5.000,00.' });
    }

    const companyRef = companyRefFromPhone(deposit.telefoneEmpresa);
    const depositRef = db.collection('depositos').doc();
    await db.runTransaction(async (tx) => {
      tx.set(companyRef, {
        empresa: deposit.empresa,
        responsavel: deposit.responsavel,
        telefoneEmpresa: deposit.telefoneEmpresa,
        saldo: admin.firestore.FieldValue.increment(0),
        reservado: admin.firestore.FieldValue.increment(0),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      tx.set(depositRef, {
        ...deposit,
        empresaId: deposit.telefoneEmpresa,
        status: 'pendente',
        criadaEm: admin.firestore.FieldValue.serverTimestamp(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    const msg = `Pedido de deposito Nexus MotoJa\n\nEmpresa: ${deposit.empresa}\nResponsavel: ${deposit.responsavel}\nWhatsApp: ${deposit.telefoneEmpresa}\nValor: ${deposit.valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}\nCodigo: ${depositRef.id}\n\nDepois que o pagamento cair, aprove esse deposito no painel do dono para liberar saldo.`;
    res.status(201).json({
      ok: true,
      depositId: depositRef.id,
      status: 'pendente',
      whatsapp: whatsappLink(OWNER_WHATSAPP, msg)
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/deposits/:depositId/approve', assertOwner, async (req, res, next) => {
  try {
    const depositRef = db.collection('depositos').doc(String(req.params.depositId || ''));
    let result = null;

    await db.runTransaction(async (tx) => {
      const depositSnap = await tx.get(depositRef);
      if (!depositSnap.exists) {
        const error = new Error('Deposito nao encontrado.');
        error.status = 404;
        throw error;
      }

      const deposit = depositSnap.data();
      if (deposit.status !== 'pendente') {
        const error = new Error('Deposito ja foi processado.');
        error.status = 409;
        throw error;
      }

      const companyRef = companyRefFromPhone(deposit.telefoneEmpresa);
      if (!companyRef) {
        const error = new Error('Telefone da empresa invalido no deposito.');
        error.status = 400;
        throw error;
      }

      const companySnap = await tx.get(companyRef);
      const before = companyBalance(companySnap.exists ? companySnap.data() : {});
      const valor = money(deposit.valor);
      const afterSaldo = money(before.saldo + valor);

      tx.set(companyRef, {
        empresa: deposit.empresa || '',
        responsavel: deposit.responsavel || '',
        telefoneEmpresa: deposit.telefoneEmpresa,
        saldo: afterSaldo,
        reservado: before.reservado,
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      tx.set(ledgerRef(deposit.telefoneEmpresa), {
        tipo: 'credito',
        origem: 'deposito_aprovado',
        depositoId: depositRef.id,
        valor,
        saldoAntes: before.saldo,
        saldoDepois: afterSaldo,
        criadoEm: admin.firestore.FieldValue.serverTimestamp()
      });

      tx.update(depositRef, {
        status: 'aprovado',
        aprovadoEm: admin.firestore.FieldValue.serverTimestamp(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      });

      result = { saldo: afterSaldo, reservado: before.reservado, disponivel: money(afterSaldo - before.reservado) };
    });

    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/deposits/:depositId/reject', assertOwner, async (req, res, next) => {
  try {
    const reason = String(req.body.reason || '').trim().slice(0, 250);
    const depositRef = db.collection('depositos').doc(String(req.params.depositId || ''));
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(depositRef);
      if (!snap.exists) {
        const error = new Error('Deposito nao encontrado.');
        error.status = 404;
        throw error;
      }
      if (snap.data().status !== 'pendente') {
        const error = new Error('Deposito ja foi processado.');
        error.status = 409;
        throw error;
      }
      tx.update(depositRef, {
        status: 'recusado',
        motivoRecusa: reason || 'Recusado pelo dono',
        recusadoEm: admin.firestore.FieldValue.serverTimestamp(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/drivers/:cpf/push-token', async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.params.cpf);
    const token = String(req.body.token || '').trim();
    if (driverCpf.length !== 11 || !token) {
      return res.status(400).json({ error: 'dados_invalidos' });
    }

    await getDriverWithProof(driverCpf, req.body);

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

app.get('/api/drivers/:cpf/mercadopago/status', async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.params.cpf);
    if (driverCpf.length !== 11) return res.status(400).json({ error: 'driverCpf_invalido' });

    const snap = await db.collection('motoboys').doc(driverCpf).get();
    const driver = snap.exists ? snap.data() : {};
    const connected = !!driver?.mercadoPago?.accessToken;
    res.json({
      ok: true,
      connected,
      userId: connected ? driver.mercadoPago.userId || null : null,
      liveMode: connected ? !!driver.mercadoPago.liveMode : null,
      connectedAt: connected ? driver.mercadoPago.conectadoEm || null : null
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/rides', createRideLimiter, async (req, res, next) => {
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

    const duplicateRideId = await findRecentDuplicateRide(ride);
    if (duplicateRideId) {
      return res.status(200).json({
        rideId: duplicateRideId,
        duplicated: true,
        message: 'Corrida igual ja foi enviada agora. Aguarde a resposta dos motoboys.',
        push: { sent: 0, failed: 0 },
        telegram: { sent: false, skipped: true }
      });
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
    const telegram = await notifyTelegramAboutRide(ref.id, ride).catch((error) => {
      console.error('telegram notify failed', error);
      return { sent: false, failed: true };
    });

    res.status(201).json({ rideId: ref.id, push, telegram });
  } catch (error) {
    next(error);
  }
});

app.post('/api/deliveries', createRideLimiter, async (req, res, next) => {
  try {
    const delivery = deliveryPublicData(req.body);
    if (!delivery.empresa || !delivery.responsavel || !delivery.retirada || !delivery.entrega || !delivery.recebedor || delivery.telefoneEmpresa.length < 10 || delivery.telefoneEmpresa.length > 11 || delivery.telefoneRecebedor.length < 10 || delivery.telefoneRecebedor.length > 11) {
      return res.status(400).json({ error: 'preencha_empresa_responsavel_telefones_retirada_entrega_recebedor' });
    }
    if (!isPricedDeliveryType(delivery.tipoEntrega)) {
      return res.status(400).json({ error: 'tipo_entrega_sem_preco', message: 'Selecione um tipo de entrega com preco definido.' });
    }
    if (delivery.paradas > 1 && !delivery.enderecosExtras) {
      return res.status(400).json({ error: 'enderecos_extras_obrigatorios', message: 'Informe os enderecos dos pontos extras.' });
    }
    const pontosExtras = Array.isArray(delivery.pontosExtras) ? delivery.pontosExtras : [];
    if (delivery.paradas > 1 && pontosExtras.length !== delivery.paradas - 1) {
      return res.status(400).json({ error: 'pontos_extras_invalidos', message: `Informe exatamente ${delivery.paradas - 1} ponto(s) extra(s).` });
    }
    if (pontosExtras.some((p) => !String(p.digitado || '').trim() || !validCoordinate(p))) {
      return res.status(400).json({ error: 'pontos_extras_invalidos', message: 'Confira os enderecos extras antes de chamar o motoboy.' });
    }
    if (!isFixedFoodDelivery(delivery.tipoEntrega)) {
      const serverKm = await calculateRouteDistanceKm([
        { lat: delivery.retiradaLat, lon: delivery.retiradaLon },
        { lat: delivery.entregaLat, lon: delivery.entregaLon },
        ...pontosExtras.map((point) => ({ lat: point.lat, lon: point.lon }))
      ]);
      delivery.km = serverKm;
    }
    if (!delivery.valor || delivery.valor <= 0) {
      return res.status(400).json({ error: 'valor_invalido' });
    }
    if (money(delivery.valor) !== expectedDeliveryFare(delivery.km, delivery.paradas, delivery.tipoEntrega)) {
      return res.status(400).json({ error: 'valor_nao_confere_com_tabela_entrega' });
    }

    const duplicateDeliveryId = await findRecentDuplicateDelivery(delivery);
    if (duplicateDeliveryId) {
      return res.status(200).json({
        deliveryId: duplicateDeliveryId,
        duplicated: true,
        message: 'Entrega igual ja foi enviada agora. Aguarde a resposta dos motoboys.',
        telegram: { sent: false, skipped: true }
      });
    }

    const ref = delivery.clientRequestId
      ? db.collection('entregas').doc(delivery.clientRequestId)
      : db.collection('entregas').doc();
    let created = false;

    await db.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      if (existing.exists) return;

      const companyRef = companyRefFromPhone(delivery.telefoneEmpresa);
      const companySnap = await tx.get(companyRef);
      const balance = companyBalance(companySnap.exists ? companySnap.data() : {});
      if (balance.disponivel < delivery.valor) {
        const error = new Error('Saldo insuficiente. Faca um deposito e aguarde aprovacao do dono antes de chamar motoboy.');
        error.status = 402;
        error.code = 'saldo_insuficiente';
        error.balance = balance;
        throw error;
      }
      const nextReserved = money(balance.reservado + delivery.valor);

      tx.set(companyRef, {
        empresa: delivery.empresa,
        responsavel: delivery.responsavel,
        telefoneEmpresa: delivery.telefoneEmpresa,
        saldo: balance.saldo,
        reservado: nextReserved,
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      tx.set(ledgerRef(delivery.telefoneEmpresa), {
        tipo: 'reserva',
        origem: 'entrega_criada',
        entregaId: ref.id,
        valor: delivery.valor,
        saldoAntes: balance.saldo,
        saldoDepois: balance.saldo,
        reservadoAntes: balance.reservado,
        reservadoDepois: nextReserved,
        criadoEm: admin.firestore.FieldValue.serverTimestamp()
      });

      tx.set(ref, {
        ...delivery,
        empresaId: delivery.telefoneEmpresa,
        bairroEntrega: bairroFromAddress(delivery.entregaEncontrada || delivery.entrega),
        tipo: 'entrega_empresarial',
        status: 'pendente',
        pagamento: 'saldo_pre_pago_empresa',
        saldoReservado: delivery.valor,
        criadaEm: admin.firestore.FieldValue.serverTimestamp(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      });
      created = true;
    });

    if (!created) {
      return res.status(200).json({ deliveryId: ref.id, duplicated: true });
    }

    const telegram = await notifyTelegramAboutDelivery(ref.id, delivery).catch((error) => {
      console.error('telegram delivery notify failed', error);
      return { sent: false, failed: true };
    });

    res.status(201).json({ deliveryId: ref.id, telegram });
  } catch (error) {
    if (error.code === 'saldo_insuficiente') {
      return res.status(error.status || 402).json({
        error: 'saldo_insuficiente',
        message: error.message,
        balance: error.balance || null
      });
    }
    next(error);
  }
});

app.post('/api/rides/:rideId/accept', async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.body.driverCpf);
    if (driverCpf.length !== 11) return res.status(400).json({ error: 'driverCpf_invalido' });

    const driver = await getDriverWithMercadoPago(driverCpf);
    assertDriverProof(driver, req.body);
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

app.post('/api/deliveries/:deliveryId/accept', async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.body.driverCpf);
    if (driverCpf.length !== 11) return res.status(400).json({ error: 'driverCpf_invalido' });

    const driver = await getDriverWithProof(driverCpf, req.body);
    const deliveryRef = db.collection('entregas').doc(req.params.deliveryId);

    await db.runTransaction(async (tx) => {
      const deliverySnap = await tx.get(deliveryRef);
      if (!deliverySnap.exists) {
        const error = new Error('Entrega nao encontrada.');
        error.status = 404;
        throw error;
      }

      const delivery = deliverySnap.data();
      if (delivery.status !== 'pendente') {
        const error = new Error(`Entrega ja foi aceita por ${delivery.motoboy || 'outro motoboy'}.`);
        error.status = 409;
        throw error;
      }

      tx.update(deliveryRef, {
        status: 'aceita',
        motoboy: driver.nome || req.body.driverName || '',
        motoboyCpf: driverCpf,
        motoboyCnh: driver.cnh || '',
        motoboyTelefone: driver.telefone || '',
        aceitaEm: admin.firestore.FieldValue.serverTimestamp(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/rides/:rideId/notify-client', async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.body.driverCpf);
    if (driverCpf.length !== 11) return res.status(400).json({ error: 'driverCpf_invalido' });
    await getDriverWithProof(driverCpf, req.body);

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
    await getDriverWithProof(driverCpf, req.body);

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

app.post('/api/deliveries/:deliveryId/cancel', async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.body.driverCpf);
    const reason = String(req.body.reason || '').trim().slice(0, 300);
    if (driverCpf.length !== 11 || !reason) {
      return res.status(400).json({ error: 'cpf_e_motivo_obrigatorios' });
    }
    await getDriverWithProof(driverCpf, req.body);

    const deliveryRef = db.collection('entregas').doc(req.params.deliveryId);
    const deliverySnap = await deliveryRef.get();
    if (!deliverySnap.exists) return res.status(404).json({ error: 'entrega_nao_encontrada' });

    const delivery = deliverySnap.data();
    if (onlyDigits(delivery.motoboyCpf) !== driverCpf) {
      return res.status(409).json({ error: 'entrega_nao_pertence_ao_motoboy' });
    }
    if (delivery.status === 'finalizada') {
      return res.status(409).json({ error: 'entrega_ja_finalizada' });
    }

    await releaseDeliveryReservation(deliveryRef, 'cancelada', {
      motivoCancelamento: reason,
      canceladoPor: delivery.motoboy || '',
      canceladoPorCpf: driverCpf,
      canceladoEm: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/rides/:rideId/finish', async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.body.driverCpf);
    if (driverCpf.length !== 11) return res.status(400).json({ error: 'driverCpf_invalido' });
    await getDriverWithProof(driverCpf, req.body);

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

    const split = rideSplit(ride.km);
    await rideRef.set({
      status: 'finalizada',
      finalizadaEm: admin.firestore.FieldValue.serverTimestamp(),
      ganhoMotoboy: split.driverPercent,
      ganhoApp: split.appPercent,
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/deliveries/:deliveryId/finish', async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.body.driverCpf);
    if (driverCpf.length !== 11) return res.status(400).json({ error: 'driverCpf_invalido' });
    await getDriverWithProof(driverCpf, req.body);

    const deliveryRef = db.collection('entregas').doc(req.params.deliveryId);
    await db.runTransaction(async (tx) => {
      const deliverySnap = await tx.get(deliveryRef);
      if (!deliverySnap.exists) {
        const error = new Error('Entrega nao encontrada.');
        error.status = 404;
        throw error;
      }

      const delivery = deliverySnap.data();
      if (onlyDigits(delivery.motoboyCpf) !== driverCpf) {
        const error = new Error('Entrega nao pertence ao motoboy.');
        error.status = 409;
        error.code = 'entrega_nao_pertence_ao_motoboy';
        throw error;
      }
      if (delivery.status === 'cancelada') {
        const error = new Error('Entrega cancelada.');
        error.status = 409;
        error.code = 'entrega_cancelada';
        throw error;
      }
      if (delivery.status !== 'aceita') {
        const error = new Error('Entrega nao esta em andamento.');
        error.status = 409;
        error.code = 'entrega_nao_esta_em_andamento';
        throw error;
      }
      if (delivery.saldoDebitadoEm) {
        const error = new Error('Entrega ja foi debitada.');
        error.status = 409;
        error.code = 'entrega_ja_debitada';
        throw error;
      }

      const valor = money(delivery.saldoReservado || delivery.valor || 0);
      const split = deliverySplit(delivery);
      const companyRef = companyRefFromPhone(delivery.empresaId || delivery.telefoneEmpresa);
      if (!companyRef || valor <= 0) {
        const error = new Error('Dados de saldo da empresa invalidos.');
        error.status = 409;
        error.code = 'saldo_empresa_invalido';
        throw error;
      }

      const companySnap = await tx.get(companyRef);
      const balance = companyBalance(companySnap.exists ? companySnap.data() : {});
      const nextSaldo = money(Math.max(0, balance.saldo - valor));
      const nextReserved = money(Math.max(0, balance.reservado - valor));

      tx.set(companyRef, {
        saldo: nextSaldo,
        reservado: nextReserved,
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      tx.set(ledgerRef(companyRef.id), {
        tipo: 'debito',
        origem: 'entrega_finalizada',
        entregaId: deliveryRef.id,
        valor,
        motoboy: delivery.motoboy || '',
        motoboyCpf: driverCpf,
        saldoAntes: balance.saldo,
        saldoDepois: nextSaldo,
        reservadoAntes: balance.reservado,
        reservadoDepois: nextReserved,
        criadoEm: admin.firestore.FieldValue.serverTimestamp()
      });

      tx.update(deliveryRef, {
        status: 'finalizada',
        finalizadaEm: admin.firestore.FieldValue.serverTimestamp(),
        saldoDebitadoEm: admin.firestore.FieldValue.serverTimestamp(),
        ganhoMotoboy: split.driverAmount,
        ganhoApp: split.appFee,
        percentualMotoboy: split.driverPercent,
        percentualApp: split.appPercent,
        valorMotoboy: split.driverAmount,
        valorApp: split.appFee,
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      });
    });

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
    if (req.query.error) {
      const detail = String(req.query.error_description || req.query.error || 'Autorizacao recusada pelo Mercado Pago.').slice(0, 400);
      return res.status(400).send(`
        <html><body style="font-family:Arial,sans-serif;background:#090911;color:#fff;padding:24px">
          <h1>Mercado Pago nao conectou</h1>
          <p>${detail}</p>
          <p>Confira se a aplicacao do Mercado Pago esta ativa em producao, com a URL de redirecionamento exatamente igual a configurada no Render.</p>
          <a style="color:#ff9a00" href="${appUrl('/motoboy.html')}">Voltar para o painel do motoboy</a>
        </body></html>
      `);
    }

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
    const token = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = token.message || token.error_description || token.error || 'Falha ao autorizar Mercado Pago';
      return res.status(response.status).send(`
        <html><body style="font-family:Arial,sans-serif;background:#090911;color:#fff;padding:24px">
          <h1>Mercado Pago nao conectou</h1>
          <p>${String(detail).slice(0, 400)}</p>
          <p>Confira credenciais, Client Secret e Redirect URI da aplicacao Mercado Pago.</p>
          <a style="color:#ff9a00" href="${appUrl('/motoboy.html')}">Voltar para o painel do motoboy</a>
        </body></html>
      `);
    }

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
