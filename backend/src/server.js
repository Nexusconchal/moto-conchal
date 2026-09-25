import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import admin from 'firebase-admin';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';

const PORT = Number(process.env.PORT || 10000);
const DRIVER_PERCENT = Number(process.env.DRIVER_PERCENT || 0.7);
const APP_PERCENT = Number(process.env.APP_PERCENT || 0.3);
const RIDE_EXPIRE_MINUTES = Number(process.env.RIDE_EXPIRE_MINUTES || process.env.PENDING_EXPIRE_MINUTES || 5);
const DELIVERY_EXPIRE_MINUTES = Number(process.env.DELIVERY_EXPIRE_MINUTES || 15);
const RIDE_EXPIRE_MS = RIDE_EXPIRE_MINUTES * 60 * 1000;
const DELIVERY_EXPIRE_MS = DELIVERY_EXPIRE_MINUTES * 60 * 1000;
const ACCEPTED_NOTICE_MS = Number(process.env.ACCEPTED_NOTICE_MINUTES || 3) * 60 * 1000;
const DUPLICATE_RIDE_MS = Number(process.env.DUPLICATE_RIDE_SECONDS || 45) * 1000;
const MP_API = 'https://api.mercadopago.com';
const BACKEND_BASE_URL = String(process.env.BACKEND_BASE_URL || '').replace(/\/$/, '');
const OWNER_WHATSAPP = onlyDigits(process.env.OWNER_WHATSAPP || process.env.SUPPORT_PHONE || '5519992306488');
const OWNER_PIX_KEY = String(process.env.OWNER_PIX_KEY || '94bff0ce-3c37-4e5e-a911-4512651e3d55').trim();
const GEOAPIFY_API_KEY = process.env.GEOAPIFY_API_KEY || '1361a528dcbe484e8143a19929527781';
const DRIVER_PROOF_CACHE_MS = 5 * 60 * 1000;
const COMPANY_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const SUPPORT_SESSION_MS = 12 * 60 * 60 * 1000;
const CUSTOMER_SESSION_MS = 90 * 24 * 60 * 60 * 1000;
const CUSTOMER_OTP_MS = 10 * 60 * 1000;
const CUSTOMER_VERIFICATION_MS = 20 * 60 * 1000;
const CAR_CUSTOMER_SESSION_MS = 90 * 24 * 60 * 60 * 1000;
const CAR_RIDE_EXPIRE_MS = Number(process.env.CAR_RIDE_EXPIRE_MINUTES || 8) * 60 * 1000;
const CAR_DRIVER_PERCENT = Math.max(0.5, Math.min(0.95, Number(process.env.CAR_DRIVER_PERCENT || 0.8)));
const CUSTOMER_FREE_RIDES = Math.max(1, Number(process.env.CUSTOMER_FREE_RIDES || 3));
const CUSTOMER_REGISTRATION_ENFORCED = String(process.env.CUSTOMER_REGISTRATION_ENFORCED || '').toLowerCase() === 'true';
const MP_OAUTH_STATE_MS = 10 * 60 * 1000;
const driverProofCache = new Map();
const carDriverCache = new Map();
const ADMIN_STATE_CACHE_MS = 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let adminStateCache = null;
let supportOperationsCache = null;
let cleanupRunning = false;
const driverEarningsInitializations = new Map();

// ── Integration constants & minimum balance ──
const MIN_INTEGRATION_BALANCE = 6.50;

// ── Cardápio Web automatic polling (in-memory, zero Firebase cost) ──
const CARDAPIO_WEB_POLL_INTERVAL_MS = 45 * 1000;
const CARDAPIO_WEB_COMPANIES_REFRESH_MS = 5 * 60 * 1000;
const cardapioWebActiveCompanies = new Map(); // companyId → { apiKey, storeCode, tipoEntrega, empresa, retirada, companyData }
const cardapioWebSeenOrders = new Map(); // companyId → Set<externalId>
const cardapioWebPendingOrders = new Map(); // companyId → Map<externalId, orderPreview>
let cardapioWebLastCompanyRefresh = 0;

// ── PediPlus automatic polling (in-memory, zero Firebase cost) ──
const PEDIPLUS_POLL_INTERVAL_MS = 45 * 1000;
const PEDIPLUS_COMPANIES_REFRESH_MS = 5 * 60 * 1000;
const pediplusActiveCompanies = new Map(); // companyId → { apiKey, tipoEntrega, empresa, retirada, cidade, companyData }
const pediplusSeenOrders = new Map(); // companyId → Set<externalId>
const pediplusPendingOrders = new Map(); // companyId → Map<externalId, orderPreview>
let pediplusLastCompanyRefresh = 0;

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
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function saoPauloHour(date = new Date()) {
  const hour = Number(new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    hour12: false
  }).format(date));
  return hour % 24;
}

function rideFarePeriod(date = new Date()) {
  const hour = saoPauloHour(date);
  if (hour >= 0 && hour < 6) return 'madrugada';
  if (hour >= 18) return 'noite';
  return 'dia';
}

function nightRideActive(date = new Date()) {
  return rideFarePeriod(date) === 'madrugada';
}

function expectedFare(km) {
  const distance = Number(km || 0);
  if (!Number.isFinite(distance) || distance <= 0) return 0;
  const period = rideFarePeriod();
  if (period === 'madrugada') {
    if (distance <= 3) return 10;
    if (distance <= 5) return 14;
    if (distance <= 8) return 20;
    return money(Math.ceil(distance) * 3.5);
  }
  if (period === 'noite') {
    if (distance <= 3) return 8;
    if (distance <= 5) return 12;
    if (distance <= 8) return 17;
    return money(Math.ceil(distance) * 3);
  }
  let value;
  if (distance <= 3) value = 6.5;
  else if (distance <= 5) value = 9.5;
  else if (distance <= 8) value = 14;
  else value = Math.ceil(distance) * 2.5;
  return money(value);
}

function rideSplit(km) {
  const distance = Number(km || 0);
  const appPercent = distance > 8 ? 0.2 : 0.25;
  return {
    appPercent,
    driverPercent: money(1 - appPercent)
  };
}

function carFare(km, date = new Date()) {
  const distance = Number(km || 0);
  if (!Number.isFinite(distance) || distance <= 0) {
    return { period: rideFarePeriod(date), rate: 0, total: 0 };
  }
  const period = rideFarePeriod(date);
  const rate = period === 'madrugada' ? 8.2 : period === 'noite' ? 6.2 : 4.2;
  return { period, rate, total: money(distance * rate) };
}

function carFareLabel(fare = {}) {
  const labels = { dia: 'Dia', noite: 'Noite', madrugada: 'Madrugada' };
  return `${labels[fare.period] || 'Dia'} - R$ ${Number(fare.rate || 0).toFixed(2).replace('.', ',')}/km`;
}

function carRideSplit(total) {
  const amount = money(total);
  const driverAmount = money(amount * CAR_DRIVER_PERCENT);
  return {
    driverPercent: CAR_DRIVER_PERCENT,
    appPercent: money(1 - CAR_DRIVER_PERCENT),
    driverAmount,
    appFee: money(Math.max(0, amount - driverAmount))
  };
}

function rideSplitAmounts(total, km) {
  const amount = money(total);
  const split = rideSplit(km);
  const appFee = money(amount * split.appPercent);
  return {
    ...split,
    total: amount,
    appFee,
    driverAmount: money(Math.max(0, amount - appFee))
  };
}

function isOutOfConchal(value) {
  const text = normalizeText(value);
  return !!text && !text.includes('conchal');
}

const DAILY_PLAN_TYPE = 'Plano Diario MotoJa Pro';
const DAILY_PLAN_PRICE = 70;
const DAILY_PLAN_DELIVERY_FEE = 4;
const DAILY_PLAN_APP_FEE = 1;

function todayKeySaoPaulo(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(date);
}

function dailyPlanRef(companyId, dayKey = todayKeySaoPaulo()) {
  return db.collection('empresas').doc(companyId).collection('planosDiarios').doc(dayKey);
}

function isFixedFoodDelivery(type) {
  return /lanche|comida|pizza|pastel|acai|sorvete|marmita|farmacia/i.test(String(type || ''));
}

function isDailyPlanDelivery(type) {
  return normalizeText(type).includes('plano diario motoja pro');
}

function isSpecialFoodDestination(value) {
  const text = normalizeText(value);
  return /martinho\s*prado|tujuguaba|iate/.test(text);
}

function requestedPlaceHint(value) {
  const text = normalizeText(value);
  if (text.includes('arthur nogueira')) return 'artur nogueira';
  return [
    'conchal',
    'aguai',
    'martinho prado',
    'tujuguaba',
    'iate',
    'engenheiro coelho',
    'artur nogueira',
    'mogi mirim',
    'mogi guacu',
    'araras',
    'americana',
    'limeira',
    'leme',
    'pirassununga',
    'rio claro',
    'campinas'
  ].find((hint) => text.includes(hint)) || '';
}

function ensureResolvedPlaceMatches(input, resolved, label = 'Endereco') {
  const expectedPlace = requestedPlaceHint(input);
  if (!expectedPlace) return;
  if (!normalizeText(resolved).includes(expectedPlace)) {
    const error = new Error(`${label} nao conferiu com o local esperado (${expectedPlace}). Digite rua, numero, bairro e cidade e calcule novamente.`);
    error.status = 400;
    error.code = 'endereco_nao_confere_com_local_digitado';
    throw error;
  }
}

function isGpsOrigin(value) {
  return normalizeText(value).includes('gps') || normalizeText(value).includes('localizacao atual');
}

function ensureResolvedAddressIsSpecific(input, resolved, label = 'Endereco') {
  const source = normalizeText(input);
  const found = normalizeText(resolved);
  const requestedStreetOrNumber = /\d|\br\.?\b|rua|avenida|av\.?|estrada|rodovia|travessa/.test(source);
  if (!requestedStreetOrNumber) return;
  const expectedPlace = requestedPlaceHint(input);
  if (!expectedPlace) return;
  if (found.includes(expectedPlace)) return;
  const foundStreetOrNumber = /\d|\br\.?\b|rua|avenida|av\.?|estrada|rodovia|travessa/.test(found);
  if (!foundStreetOrNumber) {
    const error = new Error(`${label} ficou generico no mapa. Digite rua, numero, bairro e cidade para evitar preco errado.`);
    error.status = 400;
    error.code = 'endereco_generico_no_mapa';
    throw error;
  }
}

function ensureDistantRouteIsPlausible(distanceKm, ...texts) {
  const distance = Number(distanceKm || 0);
  const distantPlaces = [
    'martinho prado',
    'tujuguaba',
    'iate',
    'engenheiro coelho',
    'artur nogueira',
    'arthur nogueira',
    'mogi mirim',
    'mogi guacu',
    'araras',
    'americana',
    'limeira',
    'leme',
    'pirassununga',
    'rio claro',
    'campinas'
  ];
  const hasDistantPlace = texts.some((text) => {
    const normalized = normalizeText(text);
    return distantPlaces.some((place) => normalized.includes(place));
  });
  if (hasDistantPlace && Number.isFinite(distance) && distance > 0 && distance < 10) {
    const error = new Error('A rota para outra cidade ficou curta demais. Confira se o endereco encontrado esta correto antes de chamar o motoboy.');
    error.status = 400;
    error.code = 'rota_distante_curta_demais';
    throw error;
  }
}

function fixedFoodDeliveryFare(delivery = {}) {
  const deliveryStops = deliveryStopCount(delivery.paradas);
  const destinations = [
    `${delivery.entrega || ''} ${delivery.entregaEncontrada || ''}`,
    ...(Array.isArray(delivery.pontosExtras)
      ? delivery.pontosExtras.map(point => `${point.digitado || ''} ${point.encontrado || ''}`)
      : [])
  ];

  let total = 0;
  for (let index = 0; index < deliveryStops; index += 1) {
    total += isSpecialFoodDestination(destinations[index] || '') ? 16 : 6.5;
  }
  return money(total);
}

function fixedFoodDeliveryAppFee(delivery = {}) {
  const deliveryStops = deliveryStopCount(delivery.paradas);
  const destinations = [
    `${delivery.entrega || ''} ${delivery.entregaEncontrada || ''}`,
    ...(Array.isArray(delivery.pontosExtras)
      ? delivery.pontosExtras.map(point => `${point.digitado || ''} ${point.encontrado || ''}`)
      : [])
  ];

  let total = 0;
  for (let index = 0; index < deliveryStops; index += 1) {
    total += isSpecialFoodDestination(destinations[index] || '') ? 2 : 1.5;
  }
  return money(total);
}

function deliverySplit(delivery = {}) {
  const total = money(delivery.valor);
  if (delivery.tipo === 'servico_exclusivo' || normalizeText(delivery.tipoEntrega).includes('exclusivo')) {
    return {
      appFee: money(Math.min(total, 20)),
      driverAmount: money(Math.max(0, Math.min(total, 50))),
      appPercent: total ? money(20 / total) : 0,
      driverPercent: total ? money(50 / total) : 0
    };
  }
  if (isDailyPlanDelivery(delivery.tipoEntrega)) {
    const stops = deliveryStopCount(delivery.paradas);
    const appFee = money(Math.min(total, DAILY_PLAN_APP_FEE * stops));
    return {
      appFee,
      driverAmount: money(Math.max(0, total - appFee)),
      appPercent: total ? money(appFee / total) : 0,
      driverPercent: total ? money((total - appFee) / total) : 0
    };
  }
  if (isFixedFoodDelivery(delivery.tipoEntrega)) {
    const appFee = fixedFoodDeliveryAppFee(delivery);
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

function expectedDeliveryFare(distanceKm, stops = 1, type = '', delivery = {}) {
  const distance = Number(distanceKm || 0);
  const deliveryStops = deliveryStopCount(stops);
  if (!Number.isFinite(distance) || distance <= 0) return 0;

  if (isDailyPlanDelivery(type)) {
    return money(DAILY_PLAN_DELIVERY_FEE * deliveryStops);
  }

  if (isFixedFoodDelivery(type)) {
    return fixedFoodDeliveryFare({ ...delivery, paradas: deliveryStops, tipoEntrega: type });
  }

  return money(Math.ceil(distance) * 2);
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

function ensureRoutePoints(points = []) {
  if (!Array.isArray(points) || points.length < 2 || points.some((point) => !validCoordinate(point))) {
    const error = new Error('Coordenadas invalidas para conferir a rota.');
    error.status = 400;
    error.code = 'coordenadas_invalidas';
    throw error;
  }
}

function geoJsonLineToLatLon(geometry = {}) {
  const coordinates = geometry.coordinates || [];
  const line = geometry.type === 'MultiLineString' ? coordinates.flat() : coordinates;
  return Array.isArray(line)
    ? line
      .filter((coord) => Array.isArray(coord) && coord.length >= 2)
      .map(([lon, lat]) => [Number(lat), Number(lon)])
      .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon))
    : [];
}

async function calculateGeoapifyRoute(points = []) {
  if (!GEOAPIFY_API_KEY) {
    const error = new Error('Geoapify nao configurado no backend.');
    error.code = 'geoapify_nao_configurado';
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
  const feature = data.features?.[0] || {};
  const meters = feature.properties?.distance;
  if (!Number.isFinite(Number(meters)) || Number(meters) <= 0) {
    const error = new Error('Rota nao encontrada para os pontos informados.');
    error.status = 400;
    error.code = 'rota_backend_nao_encontrada';
    throw error;
  }
  return { km: money(Number(meters) / 1000), geometry: geoJsonLineToLatLon(feature.geometry), provider: 'geoapify' };
}

async function calculateOsrmRoute(points = []) {
  const coords = points.map((point) => `${Number(point.lon)},${Number(point.lat)}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error('OSRM nao conseguiu conferir a rota agora.');
    error.status = 502;
    error.code = 'osrm_falhou';
    throw error;
  }
  const data = await response.json();
  const route = data.routes?.[0] || {};
  const meters = route.distance;
  if (!Number.isFinite(Number(meters)) || Number(meters) <= 0) {
    const error = new Error('OSRM nao encontrou rota para os pontos informados.');
    error.status = 400;
    error.code = 'osrm_rota_nao_encontrada';
    throw error;
  }
  return { km: money(Number(meters) / 1000), geometry: geoJsonLineToLatLon(route.geometry), provider: 'osrm' };
}

async function calculateRoute(points = []) {
  ensureRoutePoints(points);

  const results = await Promise.allSettled([
    calculateGeoapifyRoute(points),
    calculateOsrmRoute(points)
  ]);
  const geoapify = results[0].status === 'fulfilled' ? results[0].value : null;
  const osrm = results[1].status === 'fulfilled' ? results[1].value : null;
  if (geoapify) return { ...geoapify, fallbackAvailable: !!osrm };
  if (osrm) return { ...osrm, fallbackUsed: true };

  const error = results.find((result) => result.status === 'rejected')?.reason || new Error('Rota nao encontrada.');
  error.status = error.status || 502;
  throw error;
}

async function calculateRouteDistanceKm(points = []) {
  const route = await calculateRoute(points);
  return route.km;
}

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function validCpf(value) {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const digit = (length) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) sum += Number(cpf[index]) * (length + 1 - index);
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };
  return digit(9) === Number(cpf[9]) && digit(10) === Number(cpf[10]);
}

function validBirthDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const birth = new Date(`${text}T12:00:00Z`);
  if (Number.isNaN(birth.getTime()) || birth.toISOString().slice(0, 10) !== text) return null;
  const today = new Date();
  let age = today.getUTCFullYear() - birth.getUTCFullYear();
  const month = today.getUTCMonth() - birth.getUTCMonth();
  if (month < 0 || (month === 0 && today.getUTCDate() < birth.getUTCDate())) age -= 1;
  return age >= 13 && age <= 120 ? { text, age } : null;
}

function validDeviceId(value) {
  const id = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{20,100}$/.test(id) ? id : '';
}

function cleanText(value, max = 200) {
  return String(value || '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function parseBrazilianMoney(value) {
  const raw = String(value || '').replace(/[^0-9,.-]/g, '');
  if (!raw) return 0;
  const normalized = raw.includes(',')
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw;
  return money(normalized);
}

function incomingOrderText(body = {}) {
  const candidates = [
    body.text,
    body.message,
    body.data?.message?.conversation,
    body.data?.message?.extendedTextMessage?.text,
    body.data?.message?.imageMessage?.caption,
    body.payload?.text
  ];
  const text = candidates.find((value) => typeof value === 'string' && value.trim());
  return String(text || '').replace(/\r/g, '').trim().slice(0, 12000);
}

function parseMessageOrder(text) {
  const source = String(text || '').replace(/\r/g, '').trim();
  const lines = source.split('\n').map((line) => line.trim()).filter(Boolean);
  const findValue = (labels) => {
    const pattern = new RegExp(`^(?:${labels})\\s*[:#-]?\\s*(.+)$`, 'i');
    const found = lines.map((line) => line.match(pattern)).find(Boolean);
    return cleanText(found?.[1] || '', 400);
  };
  const moneyMatches = [...source.matchAll(/(?:total(?:\s+do\s+pedido)?|valor(?:\s+do\s+pedido)?)\s*[:=-]?\s*R?\$?\s*([0-9.]+(?:,[0-9]{1,2})?)/gi)];
  const total = parseBrazilianMoney(moneyMatches.at(-1)?.[1] || '');
  const itemLines = lines.filter((line) => /^\d+\s*[xX]\s+/.test(line) || /^[-*]\s+\d+\s*[xX]?\s*/.test(line));
  const orderId = findValue('pedido|n[uú]mero(?:\s+do\s+pedido)?|order') || cleanText(source.match(/#\s*([A-Za-z0-9_-]{2,40})/)?.[1] || '', 80);
  const customer = findValue('cliente|nome') || '';
  const address = findValue('endere[cç]o(?:\s+de\s+entrega)?|entrega|destino') || '';
  const neighborhood = findValue('bairro') || '';
  const phone = onlyDigits(findValue('telefone|whatsapp|celular')).slice(-11);
  const deliveryFee = parseBrazilianMoney(findValue('taxa(?:\s+de\s+entrega)?|frete'));
  const storeFee = parseBrazilianMoney(findValue('taxa(?:\s+da\s+loja|\s+da\s+plataforma)|comiss[aã]o'));
  return {
    orderId,
    customer,
    phone,
    address,
    neighborhood,
    items: itemLines.map((line) => cleanText(line.replace(/^[-*]\s*/, ''), 250)).slice(0, 80),
    total,
    deliveryFee,
    storeFee,
    rawText: source.slice(0, 12000),
    valid: !!(address && total > 0),
    missing: [!address ? 'endereco' : '', total <= 0 ? 'valor_total' : ''].filter(Boolean)
  };
}

function orderAmounts(total, commissionPercent) {
  const gross = money(total);
  const percent = Math.max(0, Math.min(100, Number(commissionPercent || 0)));
  const commission = money(gross * percent / 100);
  return { gross, commissionPercent: percent, commission, net: money(Math.max(0, gross - commission)) };
}

function formatMessageOrder(order, amounts, companyName) {
  return [
    '*NOVO PEDIDO - NEXUS MOTOJA*',
    companyName ? `Empresa: ${companyName}` : '',
    order.orderId ? `Pedido: ${order.orderId}` : '',
    order.customer ? `Cliente: ${order.customer}` : '',
    order.phone ? `WhatsApp: ${order.phone}` : '',
    `Endereco: ${order.address}`,
    order.items.length ? `Itens:\n${order.items.map((item) => `- ${item}`).join('\n')}` : '',
    `Total: ${amounts.gross.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`,
    `Taxa da empresa (${amounts.commissionPercent.toLocaleString('pt-BR')}%): -${amounts.commission.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`,
    `Valor liquido: ${amounts.net.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`
  ].filter(Boolean).join('\n\n');
}

async function sendEvolutionText(number, text) {
  const baseUrl = String(process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
  const apiKey = String(process.env.EVOLUTION_API_KEY || '').trim();
  const instance = String(process.env.EVOLUTION_INSTANCE || '').trim();
  if (!baseUrl || !apiKey || !instance || !number) {
    return { sent: false, reason: 'evolution_nao_configurada' };
  }
  const response = await fetch(`${baseUrl}/message/sendText/${encodeURIComponent(instance)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: apiKey },
    body: JSON.stringify({ number, text })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || data.error || `Evolution API respondeu ${response.status}.`);
    error.status = 502;
    error.code = 'evolution_envio_falhou';
    throw error;
  }
  return { sent: true, id: data.key?.id || data.messageId || '' };
}

async function sendEvolutionGroupMessage(groupJid, text) {
  return sendEvolutionText(groupJid, text);
}

const CAPTURE_PLATFORMS = new Set(['anotaai', 'beefood', 'ifood']);
const CAPTURE_SOURCES = new Set(['whatsapp', 'extension', 'print']);

function capturePlatform(value) {
  const platform = normalizeText(value).replace(/[^a-z]/g, '');
  return CAPTURE_PLATFORMS.has(platform) ? platform : '';
}

function captureSource(value, platform) {
  const source = normalizeText(value).replace(/[^a-z]/g, '');
  if (CAPTURE_SOURCES.has(source)) return source;
  return platform === 'anotaai' ? 'whatsapp' : 'extension';
}

function defaultCaptureConfig(platform) {
  return {
    active: false,
    autoDispatch: false,
    commissionPercent: 0,
    deliveryType: 'Lanche / pizza / pastel / marmita',
    captureMode: platform === 'anotaai' ? 'whatsapp' : 'extension',
    connected: false,
    updatedAtMs: 0
  };
}

function companyCaptureConfig(company = {}, platform) {
  const saved = company.captureIntegrations?.[platform] || {};
  return {
    ...defaultCaptureConfig(platform),
    active: saved.active === true,
    autoDispatch: saved.autoDispatch === true,
    commissionPercent: Math.max(0, Math.min(100, Number(saved.commissionPercent || 0))),
    deliveryType: cleanText(saved.deliveryType || 'Lanche / pizza / pastel / marmita', 80),
    captureMode: captureSource(saved.captureMode, platform),
    connected: saved.connected === true,
    instanceName: cleanText(saved.instanceName || '', 120),
    updatedAtMs: Number(saved.updatedAtMs || 0)
  };
}

function captureSecretField(platform, source) {
  return `${platform}_${source}`.replace(/[^a-z_]/g, '');
}

function captureSecretHash(company = {}, platform, source) {
  return company.captureSecretHashes?.[captureSecretField(platform, source)] || '';
}

function normalizeCapturedOrder(platform, source, body = {}) {
  const supplied = body.order && typeof body.order === 'object' ? body.order : body;
  const parsed = parseMessageOrder(incomingOrderText(body) || supplied.rawText || '');
  const items = Array.isArray(supplied.items)
    ? supplied.items.slice(0, 80).map((item) => cleanText(typeof item === 'string' ? item : `${item.quantity || item.quantidade || 1}x ${item.name || item.nome || ''}`, 250)).filter(Boolean)
    : parsed.items;
  const orderTotal = money(supplied.orderTotal || supplied.total || supplied.valorTotal || parsed.total);
  const externalId = cleanText(supplied.externalId || supplied.orderId || supplied.pedidoId || parsed.orderId || '', 100);
  const customer = cleanText(supplied.customer || supplied.customerName || supplied.cliente || parsed.customer || '', 120);
  const address = cleanText(supplied.address || supplied.deliveryAddress || supplied.endereco || parsed.address || '', 350);
  const neighborhood = cleanText(supplied.neighborhood || supplied.bairro || parsed.neighborhood || '', 120);
  const phone = onlyDigits(supplied.phone || supplied.customerPhone || supplied.telefone || parsed.phone).slice(-11);
  return {
    platform,
    source,
    externalId,
    customer,
    phone,
    address,
    neighborhood,
    items,
    orderTotal,
    platformDeliveryFee: money(supplied.deliveryFee || supplied.taxaEntrega || parsed.deliveryFee),
    declaredStoreFee: money(supplied.storeFee || supplied.taxaLoja || parsed.storeFee),
    rawText: cleanText(supplied.rawText || incomingOrderText(body), 12000),
    receivedAtMs: Date.now()
  };
}

function capturedOrderMissing(order = {}) {
  return [
    !order.customer ? 'nome do cliente' : '',
    onlyDigits(order.phone).length < 10 ? 'WhatsApp do cliente' : '',
    !order.address ? 'endereco de entrega' : '',
    Number(order.orderTotal || 0) <= 0 ? 'valor total' : ''
  ].filter(Boolean);
}

function capturedOrderAmounts(order, config) {
  const amounts = orderAmounts(order.orderTotal, config.commissionPercent);
  return {
    productTotal: amounts.gross,
    companyCommissionPercent: amounts.commissionPercent,
    companyCommission: amounts.commission,
    storeNetAmount: amounts.net,
    platformDeliveryFee: money(order.platformDeliveryFee),
    declaredStoreFee: money(order.declaredStoreFee)
  };
}

function captureFingerprint(companyId, order = {}) {
  const identity = order.externalId
    ? `${order.platform}:${order.externalId}`
    : `${order.platform}:${order.source}:${normalizeText(order.rawText || `${order.customer}|${order.address}|${order.orderTotal}`)}`;
  return crypto.createHash('sha256').update(`${companyId}:${identity}`).digest('hex');
}

function captureOrderRef(companyId, order) {
  return db.collection('empresas').doc(companyId).collection('pedidosCapturados').doc(captureFingerprint(companyId, order));
}

async function geocodeCapturedAddress(value, referencePoint = null) {
  if (!GEOAPIFY_API_KEY) {
    const error = new Error('Mapa nao configurado no servidor.');
    error.status = 503;
    error.code = 'geoapify_nao_configurado';
    throw error;
  }
  const address = cleanText(value, 300);
  const normalizedAddress = address
    .replace(/\bzanochett?a\b/gi, 'Zancheta')
    .replace(/\bzanchett?a\b/gi, 'Zancheta');
  const placeHint = requestedPlaceHint(normalizedAddress);
  const query = placeHint ? normalizedAddress : `${normalizedAddress}, Conchal, SP, Brasil`;
  const params = new URLSearchParams({
    text: query,
    lang: 'pt',
    limit: '5',
    bias: 'proximity:-47.172,-22.330',
    apiKey: GEOAPIFY_API_KEY
  });
  if (!placeHint) params.set('filter', 'rect:-47.45,-22.75,-46.75,-22.15');
  const response = await fetch(`https://api.geoapify.com/v1/geocode/search?${params.toString()}`);
  const data = await response.json().catch(() => ({}));
  const features = Array.isArray(data.features) ? data.features : [];
  if (!response.ok || !features.length) {
    const error = new Error(`Nao consegui localizar o endereco: ${address}. Confira o pedido na fila.`);
    error.status = 422;
    error.code = 'endereco_nao_localizado';
    throw error;
  }

  const candidates = features.map((feature) => {
    const properties = feature.properties || {};
    return {
      lat: Number(properties.lat ?? feature.geometry?.coordinates?.[1]),
      lon: Number(properties.lon ?? feature.geometry?.coordinates?.[0]),
      text: cleanText(properties.formatted || properties.address_line2 || query, 300)
    };
  }).filter(validCoordinate);
  if (!candidates.length) {
    const error = new Error(`O mapa nao devolveu coordenadas validas para: ${address}.`);
    error.status = 422;
    error.code = 'coordenadas_invalidas';
    throw error;
  }

  const matching = candidates.filter((candidate) => {
    try {
      ensureResolvedPlaceMatches(address, candidate.text, 'Endereco');
      ensureResolvedAddressIsSpecific(address, candidate.text, 'Endereco');
      return true;
    } catch {
      return false;
    }
  });
  const usable = matching.length ? matching : candidates;
  const result = validCoordinate(referencePoint)
    ? usable.slice().sort((a, b) => coordinateDistanceKm(referencePoint, a) - coordinateDistanceKm(referencePoint, b))[0]
    : usable[0];
  ensureResolvedPlaceMatches(address, result.text, 'Endereco');
  ensureResolvedAddressIsSpecific(address, result.text, 'Endereco');
  return result;
}

async function dispatchCapturedOrder(companyId, company, orderRef, captured, config) {
  const missing = capturedOrderMissing(captured);
  if (missing.length) {
    const error = new Error(`Confira antes de chamar: ${missing.join(', ')}.`);
    error.status = 422;
    error.code = 'pedido_incompleto';
    throw error;
  }
  if (!company.retirada) {
    const error = new Error('Cadastre o endereco de retirada da empresa antes de ligar o envio automatico.');
    error.status = 422;
    error.code = 'retirada_empresa_obrigatoria';
    throw error;
  }
  if (!isPricedDeliveryType(config.deliveryType)) {
    const error = new Error('Escolha um tipo de entrega com preco definido.');
    error.status = 422;
    error.code = 'tipo_entrega_sem_preco';
    throw error;
  }

  const [pickup, destination] = await Promise.all([
    geocodeCapturedAddress(company.retirada),
    geocodeCapturedAddress(`${captured.address}${captured.neighborhood ? `, ${captured.neighborhood}` : ''}`)
  ]);
  const km = await calculateRouteDistanceKm([pickup, destination]);
  ensureDistantRouteIsPlausible(km, captured.address, destination.text);
  const delivery = deliveryPublicData({
    clientRequestId: `cap_${orderRef.id.slice(0, 60)}`,
    empresa: company.empresa || 'Empresa',
    responsavel: company.responsavel || company.empresa || 'Responsavel',
    telefoneEmpresa: companyId,
    tipoEntrega: config.deliveryType,
    retirada: company.retirada,
    retiradaEncontrada: pickup.text,
    retiradaLat: pickup.lat,
    retiradaLon: pickup.lon,
    retiradaMapa: `https://www.google.com/maps?q=${pickup.lat},${pickup.lon}`,
    entrega: captured.address,
    entregaEncontrada: destination.text,
    entregaLat: destination.lat,
    entregaLon: destination.lon,
    recebedor: captured.customer,
    telefoneRecebedor: captured.phone,
    descricao: captured.items.join(', ').slice(0, 500) || `Pedido ${captured.externalId || captured.platform}`,
    observacao: `Capturado de ${captured.platform}${captured.externalId ? ` - pedido ${captured.externalId}` : ''}`,
    integracaoOrigem: captured.platform,
    integracaoPedidoId: captured.externalId || orderRef.id.slice(0, 70),
    integracaoPedidoRecebidoEm: String(captured.receivedAtMs || Date.now()),
    paradas: 1,
    km
  });
  delivery.valor = expectedDeliveryFare(delivery.km, 1, delivery.tipoEntrega, delivery);
  delivery.precoLabel = isFixedFoodDelivery(delivery.tipoEntrega)
    ? 'Tabela de alimentos Nexus MotoJa'
    : 'R$ 2,00 por km';
  if (!delivery.valor) {
    const error = new Error('Nao consegui calcular o valor da entrega.');
    error.status = 422;
    error.code = 'valor_entrega_invalido';
    throw error;
  }

  const deliveryRef = db.collection('entregas').doc(delivery.clientRequestId);
  let created = false;
  await db.runTransaction(async (tx) => {
    const [existingDelivery, companySnap, capturedSnap] = await Promise.all([
      tx.get(deliveryRef),
      tx.get(db.collection('empresas').doc(companyId)),
      tx.get(orderRef)
    ]);
    if (existingDelivery.exists || capturedSnap.data()?.deliveryId) return;
    const latestCompany = companySnap.data() || {};
    const balance = companyBalance(latestCompany);
    if (balance.disponivel < delivery.valor) {
      const error = new Error('Saldo insuficiente para chamar o motoboy. O pedido ficou na fila para revisao.');
      error.status = 402;
      error.code = 'saldo_insuficiente';
      throw error;
    }
    if (isDailyPlanDelivery(delivery.tipoEntrega)) {
      const planSnap = await tx.get(dailyPlanRef(companyId));
      if (!planSnap.exists || planSnap.data().status !== 'ativo') {
        const error = new Error('O Plano Diario precisa estar ativo hoje. O pedido ficou na fila.');
        error.status = 403;
        error.code = 'plano_diario_inativo';
        throw error;
      }
    }
    const nextReserved = money(balance.reservado + delivery.valor);
    tx.set(companySnap.ref, { reservado: nextReserved, atualizadaEm: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    tx.set(ledgerRef(companyId), {
      tipo: 'reserva', origem: 'pedido_capturado', entregaId: deliveryRef.id, valor: delivery.valor,
      saldoAntes: balance.saldo, saldoDepois: balance.saldo, reservadoAntes: balance.reservado,
      reservadoDepois: nextReserved, criadoEm: admin.firestore.FieldValue.serverTimestamp()
    });
    tx.set(deliveryRef, {
      ...delivery,
      empresaId: companyId,
      bairroEntrega: bairroFromAddress(delivery.entregaEncontrada || delivery.entrega),
      tipo: 'entrega_empresarial', status: 'pendente', pagamento: 'saldo_pre_pago_empresa',
      saldoReservado: delivery.valor,
      pedidoProduto: capturedOrderAmounts(captured, config),
      capturaPedidoId: orderRef.id,
      criadaEm: admin.firestore.FieldValue.serverTimestamp(),
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    });
    tx.set(orderRef, {
      status: 'enviado_motoboy', deliveryId: deliveryRef.id, deliveryFare: delivery.valor,
      routeKm: delivery.km, dispatchedAtMs: Date.now(),
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    created = true;
  });

  if (created) {
    emitSupportOperationsRefresh();
    await Promise.allSettled([
      notifyTelegramAboutDelivery(deliveryRef.id, delivery),
      notifyDriversAboutDelivery(deliveryRef.id, delivery)
    ]);
  }
  return { deliveryId: deliveryRef.id, deliveryFare: delivery.valor, km: delivery.km, created };
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

const RIDE_CITY_CENTERS = {
  conchal: { lat: -22.3308, lon: -47.1724, label: 'Conchal' },
  aguai: { lat: -22.0572, lon: -46.9781, label: 'Aguai' },
  engenheiro_coelho: { lat: -22.48805, lon: -47.21572, label: 'Engenheiro Coelho' }
};

function canonicalRideCity(value, fallback = 'conchal') {
  const city = normalizeText(value);
  if (city.includes('engenheiro coelho') || /\beng\.?\s*coelho\b/.test(city)) return 'engenheiro_coelho';
  if (city.includes('aguai')) return 'aguai';
  if (city.includes('conchal')) return 'conchal';
  return fallback;
}

function rideCityLabel(value) {
  return RIDE_CITY_CENTERS[canonicalRideCity(value)]?.label || 'Conchal';
}

function driverRideCities(driver = {}) {
  const saved = driver.cidadesAtivas && typeof driver.cidadesAtivas === 'object'
    ? driver.cidadesAtivas
    : {};
  return {
    conchal: true,
    aguai: saved.aguai === true,
    engenheiro_coelho: saved.engenheiro_coelho === true
  };
}

function rideOperatingCity(ride = {}) {
  // Corridas antigas nao tinham cidade e pertencem ao mercado original de Conchal.
  return canonicalRideCity(ride.cidadeOperacao, 'conchal');
}

function coordinateDistanceKm(a, b) {
  const lat1 = Number(a?.lat);
  const lon1 = Number(a?.lon);
  const lat2 = Number(b?.lat);
  const lon2 = Number(b?.lon);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;
  const toRad = (degrees) => degrees * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function inferNewRideOperatingCity(ride = {}, requested = '') {
  const originText = normalizeText([
    ride.origem,
    ride.origemDigitada,
    ride.origemEncontrada
  ].filter(Boolean).join(' '));
  const origin = { lat: Number(ride.origemLat), lon: Number(ride.origemLon) };
  if (Number.isFinite(origin.lat) && Number.isFinite(origin.lon) && origin.lat && origin.lon) {
    const nearestCity = Object.entries(RIDE_CITY_CENTERS)
      .map(([city, center]) => ({ city, km: coordinateDistanceKm(origin, center) }))
      .sort((a, b) => a.km - b.km)[0];
    if (nearestCity?.km <= 30) return nearestCity.city;
  }

  if (originText.includes('engenheiro coelho') || /\beng\.?\s*coelho\b/.test(originText)) return 'engenheiro_coelho';
  if (originText.includes('aguai')) return 'aguai';
  if (originText.includes('conchal')) return 'conchal';

  return canonicalRideCity(requested, 'conchal');
}

function normalizedPersonName(value) {
  return normalizeText(value).replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
}

function validDriverPhoto(value) {
  const photo = String(value || '');
  if (!photo) return '';
  if (!/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo)) return '';
  if (photo.length > 220000) return '';
  return photo;
}

function validDriverDocument(value) {
  const photo = String(value || '');
  if (!photo) return '';
  if (!/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo)) return '';
  if (photo.length > 550000) return '';
  return photo;
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

function dateKeySaoPaulo(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(date);
}

function driverEarningsRef(driverCpf) {
  return db.collection('resumosMotoboy').doc(onlyDigits(driverCpf));
}

function driverEarningsDayRef(driverCpf, dayKey) {
  return driverEarningsRef(driverCpf).collection('dias').doc(dayKey);
}

function driverEarningEventRef(driverCpf, kind, serviceId) {
  const safeKind = kind === 'entrega' ? 'entrega' : kind === 'carro' ? 'carro' : 'corrida';
  const safeId = String(serviceId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
  return driverEarningsRef(driverCpf).collection('historico').doc(`${safeKind}_${safeId}`);
}

function driverEarningEvent(kind, serviceId, job = {}, finishedAtMs = Date.now()) {
  const isDelivery = kind === 'entrega';
  const isCar = kind === 'carro';
  const split = isDelivery
    ? deliverySplit(job)
    : isCar
      ? carRideSplit(job.valor)
      : rideSplitAmounts(job.pagamento?.total || job.valor, job.km);
  const driverAmount = money(job.ganhoMotoboy ?? job.valorMotoboy ?? split.driverAmount);
  return {
    serviceId: String(serviceId || '').slice(0, 120),
    tipo: isDelivery ? 'entrega' : 'corrida',
    modalidade: isCar ? 'carro' : isDelivery ? 'entrega' : 'moto',
    titulo: cleanText(isDelivery ? (job.empresa || 'Empresa') : isCar ? (job.passageiroNome || 'Passageiro') : (job.nome || 'Cliente'), 100),
    origem: cleanText(isDelivery ? job.retirada : job.origem, 180),
    destino: cleanText(isDelivery ? job.entrega : job.destino, 180),
    ganhoCentavos: Math.max(0, Math.round(driverAmount * 100)),
    quilometrosMetros: Math.max(0, Math.round(Number(job.km || 0) * 1000)),
    finalizadaEmMs: Number(finishedAtMs || Date.now()),
    dia: dateKeySaoPaulo(new Date(Number(finishedAtMs || Date.now())))
  };
}

function manualDeliveryPerformedAtMs(delivery = {}) {
  return timestampMs(delivery.retiradaConfirmadaEm)
    || timestampMs(delivery.aceitaEm)
    || timestampMs(delivery.criadaEm)
    || timestampMs(delivery.finalizadaEm)
    || Date.now();
}

function driverEarningDayIncrements(event, direction = 1) {
  return {
    ganhoCentavos: admin.firestore.FieldValue.increment(direction * Number(event.ganhoCentavos || 0)),
    servicos: admin.firestore.FieldValue.increment(direction),
    corridas: admin.firestore.FieldValue.increment(direction * (event.tipo === 'corrida' ? 1 : 0)),
    entregas: admin.firestore.FieldValue.increment(direction * (event.tipo === 'entrega' ? 1 : 0)),
    quilometrosMetros: admin.firestore.FieldValue.increment(direction * Number(event.quilometrosMetros || 0)),
    atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
  };
}

async function recordDriverEarning(tx, driverCpf, event) {
  const cpf = onlyDigits(driverCpf);
  if (cpf.length !== 11 || !event?.serviceId || !event?.ganhoCentavos) return false;
  const eventRef = driverEarningEventRef(cpf, event.tipo, event.serviceId);
  const eventSnap = await tx.get(eventRef);
  if (eventSnap.exists) return false;
  const increments = {
    ganhoCentavos: admin.firestore.FieldValue.increment(event.ganhoCentavos),
    servicos: admin.firestore.FieldValue.increment(1),
    corridas: admin.firestore.FieldValue.increment(event.tipo === 'corrida' ? 1 : 0),
    entregas: admin.firestore.FieldValue.increment(event.tipo === 'entrega' ? 1 : 0),
    quilometrosMetros: admin.firestore.FieldValue.increment(event.quilometrosMetros),
    atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
  };
  tx.set(eventRef, {
    ...event,
    criadaEm: admin.firestore.FieldValue.serverTimestamp()
  });
  tx.set(driverEarningsRef(cpf), increments, { merge: true });
  tx.set(driverEarningsDayRef(cpf, event.dia), { ...increments, dia: event.dia }, { merge: true });
  return true;
}

function addDriverEarningToSummary(summary, event) {
  summary.ganhoCentavos += event.ganhoCentavos;
  summary.servicos += 1;
  summary.corridas += event.tipo === 'corrida' ? 1 : 0;
  summary.entregas += event.tipo === 'entrega' ? 1 : 0;
  summary.quilometrosMetros += event.quilometrosMetros;
}

function mergeDriverEarningsSummary(summary, data = {}) {
  summary.ganhoCentavos += Math.max(0, Number(data.ganhoCentavos || 0));
  summary.servicos += Math.max(0, Number(data.servicos || 0));
  summary.corridas += Math.max(0, Number(data.corridas || 0));
  summary.entregas += Math.max(0, Number(data.entregas || 0));
  summary.quilometrosMetros += Math.max(0, Number(data.quilometrosMetros || 0));
}

function emptyDriverEarnings() {
  return { ganhoCentavos: 0, servicos: 0, corridas: 0, entregas: 0, quilometrosMetros: 0 };
}

function publicDriverEarnings(data = {}) {
  const ganhoCentavos = Math.max(0, Number(data.ganhoCentavos || 0));
  const servicos = Math.max(0, Number(data.servicos || 0));
  return {
    ganho: money(ganhoCentavos / 100),
    servicos,
    corridas: Math.max(0, Number(data.corridas || 0)),
    entregas: Math.max(0, Number(data.entregas || 0)),
    quilometros: Math.round(Math.max(0, Number(data.quilometrosMetros || 0)) / 10) / 100,
    mediaPorServico: servicos ? money(ganhoCentavos / 100 / servicos) : 0
  };
}

async function rebuildDriverEarnings(driverCpf) {
  const cpf = onlyDigits(driverCpf);
  const totalRef = driverEarningsRef(cpf);
  const totalSnap = await totalRef.get();
  if (Number(totalSnap.data()?.versaoHistorico || 0) >= 2) return;

  const [ridesSnap, deliveriesSnap, carRidesSnap] = await Promise.all([
    db.collection('corridas').where('motoboyCpf', '==', cpf).where('status', '==', 'finalizada').limit(500).get(),
    db.collection('entregas').where('motoboyCpf', '==', cpf).where('status', '==', 'finalizada').limit(500).get(),
    db.collection('corridasCarro').where('motoristaCpf', '==', cpf).where('status', '==', 'finalizada').limit(500).get()
  ]);
  const events = [];
  ridesSnap.docs.forEach((docSnap) => {
    const job = docSnap.data() || {};
    if (job.status === 'finalizada') events.push(driverEarningEvent('corrida', docSnap.id, job, timestampMs(job.finalizadaEm) || Date.now()));
  });
  deliveriesSnap.docs.forEach((docSnap) => {
    const job = docSnap.data() || {};
    if (job.status === 'finalizada') {
      const finishedAtMs = job.finalizadaPeloDonoEm
        ? manualDeliveryPerformedAtMs(job)
        : timestampMs(job.finalizadaEm) || Date.now();
      events.push(driverEarningEvent('entrega', docSnap.id, job, finishedAtMs));
    }
  });
  carRidesSnap.docs.forEach((docSnap) => {
    const job = docSnap.data() || {};
    if (job.status === 'finalizada') {
      const finishedAtMs = job.finalizadaPeloDonoEm
        ? timestampMs(job.iniciadaEm) || timestampMs(job.aceitaEm) || timestampMs(job.criadaEm) || Date.now()
        : timestampMs(job.finalizadaEm) || Date.now();
      events.push(driverEarningEvent('carro', docSnap.id, job, finishedAtMs));
    }
  });

  const total = emptyDriverEarnings();
  const days = new Map();
  events.forEach((event) => {
    addDriverEarningToSummary(total, event);
    if (!days.has(event.dia)) days.set(event.dia, emptyDriverEarnings());
    addDriverEarningToSummary(days.get(event.dia), event);
  });

  const writes = [
    ...events.map((event) => ({ ref: driverEarningEventRef(cpf, event.tipo, event.serviceId), data: event })),
    ...Array.from(days.entries()).map(([dia, data]) => ({ ref: driverEarningsDayRef(cpf, dia), data: { ...data, dia } }))
  ];
  for (let index = 0; index < writes.length; index += 400) {
    const batch = db.batch();
    writes.slice(index, index + 400).forEach((write) => batch.set(write.ref, write.data, { merge: true }));
    await batch.commit();
  }
  await totalRef.set({
    ...total,
    versaoHistorico: 2,
    historicoImportadoEm: admin.firestore.FieldValue.serverTimestamp(),
    atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

async function initializeDriverEarnings(driverCpf) {
  const cpf = onlyDigits(driverCpf);
  if (driverEarningsInitializations.has(cpf)) return driverEarningsInitializations.get(cpf);
  const task = rebuildDriverEarnings(cpf).catch((error) => {
    driverEarningsInitializations.delete(cpf);
    throw error;
  });
  driverEarningsInitializations.set(cpf, task);
  return task;
}

const MANUAL_DELIVERY_DATE_MIGRATION_ID = 'manual_delivery_operational_date_v1';
let manualDeliveryDateMigrationStatus = { status: 'pending' };

async function repairManualDeliveryEarningDate(deliverySnap) {
  const delivery = deliverySnap.data() || {};
  const driverCpf = onlyDigits(delivery.motoboyCpf);
  const performedAtMs = manualDeliveryPerformedAtMs(delivery);
  const performedAt = admin.firestore.Timestamp.fromMillis(performedAtMs);
  const expectedDay = dateKeySaoPaulo(new Date(performedAtMs));
  let movedDay = false;

  await db.runTransaction(async (tx) => {
    const eventRef = driverCpf.length === 11
      ? driverEarningEventRef(driverCpf, 'entrega', deliverySnap.id)
      : null;
    const eventSnap = eventRef ? await tx.get(eventRef) : null;

    tx.set(deliverySnap.ref, {
      finalizadaEm: performedAt,
      realizadaEm: performedAt,
      dataOperacionalCorrigidaEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    if (!eventSnap?.exists) return;

    const event = eventSnap.data() || {};
    const eventFinishedAtMs = Number(event.finalizadaEmMs || performedAtMs);
    const previousDay = String(event.dia || dateKeySaoPaulo(new Date(eventFinishedAtMs)));
    if (previousDay !== expectedDay) {
      tx.set(driverEarningsDayRef(driverCpf, previousDay), driverEarningDayIncrements(event, -1), { merge: true });
      tx.set(driverEarningsDayRef(driverCpf, expectedDay), {
        ...driverEarningDayIncrements(event, 1),
        dia: expectedDay
      }, { merge: true });
      movedDay = true;
    }

    tx.set(eventRef, {
      dia: expectedDay,
      finalizadaEmMs: performedAtMs,
      dataOperacionalCorrigidaEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });

  return { movedDay };
}

async function migrateManualDeliveryEarningDates() {
  const migrationRef = db.collection('migrations').doc(MANUAL_DELIVERY_DATE_MIGRATION_ID);
  const migrationSnap = await migrationRef.get();
  if (migrationSnap.data()?.completed) return { skipped: true };

  let lastDocument = null;
  let scanned = 0;
  let moved = 0;
  do {
    let query = db.collection('entregas')
      .where('finalizadaPeloDonoEm', '>', admin.firestore.Timestamp.fromMillis(0))
      .orderBy('finalizadaPeloDonoEm')
      .limit(100);
    if (lastDocument) query = query.startAfter(lastDocument);
    const snapshot = await query.get();
    if (snapshot.empty) break;

    for (const deliverySnap of snapshot.docs) {
      const result = await repairManualDeliveryEarningDate(deliverySnap);
      scanned += 1;
      if (result.movedDay) moved += 1;
    }
    lastDocument = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < 100) break;
  } while (lastDocument);

  await migrationRef.set({
    completed: true,
    scanned,
    moved,
    completedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  return { skipped: false, scanned, moved };
}

function externalOrderMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  if (typeof value === 'number') return value > 100000000000 ? value : value * 1000;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function externalOrderDocId(provider, externalId) {
  const source = String(provider || 'api').replace(/[^a-z0-9_-]/gi, '').slice(0, 30) || 'api';
  const id = String(externalId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  return `${source}_${id}`;
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

async function collectionState(name, limit = 500, orderField = '') {
  let query = db.collection(name);
  if (orderField) query = query.orderBy(orderField, 'desc');
  const snapshot = await query.limit(limit).get();
  return snapshot.docs
    .map((docSnap) => serializeFirestore({ id: docSnap.id, ...docSnap.data() }))
    .sort((a, b) => timestampMs(b.finalizadaEm || b.aceitaEm || b.criadaEm || b.ultimoAcesso) - timestampMs(a.finalizadaEm || a.aceitaEm || a.criadaEm || a.ultimoAcesso));
}

function publicPendingJob(job = {}) {
  const copy = { ...job };
  delete copy.telefoneCliente;
  delete copy.telefoneEmpresa;
  delete copy.telefoneRecebedor;
  if (Array.isArray(copy.pontosExtras)) {
    copy.pontosExtras = copy.pontosExtras.map((point) => {
      const publicPoint = { ...point };
      delete publicPoint.telefoneRecebedor;
      return publicPoint;
    });
  }
  delete copy.motoboyCpf;
  delete copy.motoboyCnh;
  delete copy.motoboyTelefone;
  return copy;
}

function sortJobs(items = []) {
  return items.sort((a, b) => {
    const activeA = a.status === 'pendente' || a.status === 'aceita' ? 1 : 0;
    const activeB = b.status === 'pendente' || b.status === 'aceita' ? 1 : 0;
    if (activeA !== activeB) return activeB - activeA;
    return timestampMs(b.finalizadaEm || b.aceitaEm || b.criadaEm) - timestampMs(a.finalizadaEm || a.aceitaEm || a.criadaEm);
  });
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
  return configured.length ? Array.from(new Set(configured)) : ['moto123'];
}

function privateDriverJob(job = {}) {
  const copy = { ...job };
  // A foto do proprio motoboy ja fica salva no perfil. Repeti-la em cada
  // corrida ou entrega torna a listagem muito pesada em conexoes moveis.
  delete copy.motoboyFoto;
  delete copy.motoboyCnh;
  delete copy.crlvFoto;
  return copy;
}

function supportAlertVersion(job = {}) {
  return timestampMs(job.criadaEm) || timestampMs(job.renovadaEm) || timestampMs(job.atualizadaEm);
}

function supportOperation(kind, id, job = {}) {
  const isDelivery = kind === 'entrega';
  const isCar = kind === 'carro';
  const alertVersion = supportAlertVersion(job);
  const receiverPhone = isDelivery ? onlyDigits(job.telefoneRecebedor).slice(0, 11) : '';
  const extraStops = Array.isArray(job.pontosExtras)
    ? job.pontosExtras.slice(0, 8).map((point) => ({
      ordem: Number(point.ordem || 0),
      endereco: cleanText(point.digitado || point.encontrado, 180),
      recebedor: cleanText(point.recebedor, 100),
      telefone: onlyDigits(point.telefoneRecebedor).slice(0, 11)
    }))
    : [];
  return {
    id,
    tipo: isDelivery ? 'entrega' : isCar ? 'carro' : 'corrida',
    status: cleanText(job.status, 30),
    titulo: cleanText(isDelivery ? job.empresa : isCar ? job.passageiroNome : job.nome, 100) || (isDelivery ? 'Empresa' : 'Cliente'),
    responsavel: cleanText(isDelivery ? job.responsavel : isCar ? job.passageiroNome : job.nome, 100),
    telefonePrincipal: onlyDigits(isDelivery ? job.telefoneEmpresa : isCar ? job.passageiroTelefone : job.telefoneCliente).slice(0, 11),
    recebedor: cleanText(job.recebedor, 100),
    telefoneRecebedor: receiverPhone,
    origem: cleanText(isDelivery ? job.retirada : job.origem, 180),
    destino: cleanText(isDelivery ? job.entrega : job.destino, 180),
    tipoEntrega: isDelivery ? cleanText(job.tipoEntrega, 100) : '',
    paradas: isDelivery ? Math.max(1, Number(job.paradas || 1)) : 1,
    pontosExtras: extraStops,
    motoboy: cleanText(isCar ? job.motorista : job.motoboy, 100),
    telefoneMotoboy: onlyDigits(isCar ? job.motoristaTelefone : job.motoboyTelefone).slice(0, 11),
    criadaEm: serializeFirestore(job.criadaEm),
    aceitaEm: serializeFirestore(job.aceitaEm),
    retiradaEm: serializeFirestore(job.retiradaConfirmadaEm),
    alertVersion,
    alertaAssumido: Number(job.suporteAlertaVersao || 0) === alertVersion,
    alertaAssumidoPor: cleanText(job.suporteAssumidoPor, 100),
    alertaAssumidoEm: serializeFirestore(job.suporteAssumidoEm)
  };
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

function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function createCarQuoteToken(payload = {}) {
  const key = process.env.DATA_ENCRYPTION_KEY || ownerPasswordValue();
  if (!key) throw new Error('DATA_ENCRYPTION_KEY nao configurada para assinar tarifas do CarroJa.');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', String(key)).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyCarQuoteToken(token) {
  const key = process.env.DATA_ENCRYPTION_KEY || ownerPasswordValue();
  const [body, signature] = String(token || '').split('.');
  if (!key || !body || !signature) return null;
  const expected = crypto.createHmac('sha256', String(key)).update(body).digest('base64url');
  if (!safeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || Number(payload.expiresAtMs || 0) < Date.now()) return null;
    return payload;
  } catch (_error) {
    return null;
  }
}

function encryptSecret(value) {
  const keySource = process.env.DATA_ENCRYPTION_KEY || ownerPasswordValue();
  if (!keySource || !value) return '';
  const key = crypto.createHash('sha256').update(String(keySource)).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
}

function decryptSecret(value) {
  const keySource = process.env.DATA_ENCRYPTION_KEY || ownerPasswordValue();
  if (!keySource || !value) return '';
  const [ivText, tagText, encryptedText] = String(value).split('.');
  if (!ivText || !tagText || !encryptedText) return '';
  const key = crypto.createHash('sha256').update(String(keySource)).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password || ''), salt, 120000, 32, 'sha256').toString('hex');
  return { salt, hash };
}

function verifyPassword(password, saved = {}) {
  const salt = saved?.passwordSalt || saved?.salt;
  const hash = saved?.passwordHash || saved?.hash;
  if (!salt || !hash) return false;
  const typed = passwordHash(password, salt).hash;
  return safeEqual(typed, hash);
}

function supportPasswordHash(password, salt = crypto.randomBytes(16).toString('hex'), iterations = 600000) {
  const hash = crypto.pbkdf2Sync(String(password || ''), salt, iterations, 32, 'sha256').toString('hex');
  return { salt, hash, iterations };
}

function verifySupportPassword(password, saved = {}) {
  const salt = saved?.passwordSalt;
  const hash = saved?.passwordHash;
  const iterations = Math.min(1000000, Math.max(120000, Number(saved?.passwordIterations || 600000)));
  if (!salt || !hash) return false;
  return safeEqual(supportPasswordHash(password, salt, iterations).hash, hash);
}

function validSupportPassword(password) {
  const value = String(password || '');
  return value.length >= 10
    && value.length <= 128
    && /[a-z]/.test(value)
    && /[A-Z]/.test(value)
    && /\d/.test(value);
}

function decryptSecretSafe(value) {
  try {
    return decryptSecret(value);
  } catch {
    return '';
  }
}

function supportAccountStatus(data = {}) {
  return ['aguardando_aprovacao', 'aprovada', 'bloqueada'].includes(data.status)
    ? data.status
    : 'aguardando_aprovacao';
}

function publicSupportAccount(data = {}, id = '', ownerView = false) {
  const account = {
    id,
    nome: cleanText(data.nome, 100),
    telefone: onlyDigits(data.telefone).slice(0, 11),
    cpfFinal: onlyDigits(data.cpfFinal).slice(-4),
    foto: decryptSecretSafe(data.fotoEncrypted),
    status: supportAccountStatus(data),
    motivoBloqueio: cleanText(data.motivoBloqueio, 250),
    cadastradaEm: serializeFirestore(data.cadastradaEm),
    aprovadaEm: serializeFirestore(data.aprovadaEm),
    bloqueadaEm: serializeFirestore(data.bloqueadaEm),
    ultimoLoginEm: serializeFirestore(data.ultimoLoginEm)
  };
  if (ownerView) {
    account.cpf = onlyDigits(decryptSecretSafe(data.cpfEncrypted));
    account.dataNascimento = decryptSecretSafe(data.dataNascimentoEncrypted);
  }
  return account;
}

async function issueSupportSession(ref) {
  const token = `support.v1.${ref.id}.${crypto.randomBytes(32).toString('hex')}`;
  const tokenHash = hashSecret(token);
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const saved = snapshot.data()?.supportSessions;
    const sessions = saved && typeof saved === 'object' ? saved : {};
    const active = Object.entries(sessions)
      .filter(([, session]) => Number(session?.expiresAtMs || 0) > now)
      .sort((a, b) => Number(b[1]?.issuedAtMs || 0) - Number(a[1]?.issuedAtMs || 0))
      .slice(0, 2);
    const nextSessions = Object.fromEntries(active);
    nextSessions[tokenHash] = { issuedAtMs: now, expiresAtMs: now + SUPPORT_SESSION_MS };
    tx.set(ref, {
      supportSessions: nextSessions,
      ultimoLoginEm: admin.firestore.FieldValue.serverTimestamp(),
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });
  return token;
}

async function findSupportSession(token) {
  const value = String(token || '').trim();
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== 'support' || parts[1] !== 'v1' || !/^[a-f0-9]{64}$/.test(parts[2])) return null;
  const accountSnap = await db.collection('contasSuporte').doc(parts[2]).get();
  if (!accountSnap.exists) return null;
  const account = accountSnap.data() || {};
  const tokenHash = hashSecret(value);
  const session = account.supportSessions?.[tokenHash];
  if (!session || Number(session.expiresAtMs || 0) <= Date.now()) return null;
  return { accountSnap, account, accountId: accountSnap.id, sessionHash: tokenHash };
}

async function assertSupport(req, res, next) {
  try {
    const header = String(req.header('authorization') || '');
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const session = await findSupportSession(token);
    if (!session) return res.status(401).json({ error: 'sessao_suporte_invalida', message: 'Entre novamente no Painel de Suporte.' });
    const status = supportAccountStatus(session.account);
    if (status !== 'aprovada') {
      return res.status(403).json({
        error: status === 'bloqueada' ? 'conta_suporte_bloqueada' : 'conta_suporte_aguardando_aprovacao',
        message: status === 'bloqueada' ? 'Sua conta foi bloqueada pelo administrador.' : 'Sua conta ainda aguarda aprovação.'
      });
    }
    req.supportAccountSnap = session.accountSnap;
    req.supportAccount = session.account;
    req.supportAccountId = session.accountId;
    req.supportSessionHash = session.sessionHash;
    return next();
  } catch (error) {
    return next(error);
  }
}

async function writeSupportAudit(accountId, action, details = {}) {
  const safeDetails = {};
  Object.entries(details).slice(0, 12).forEach(([key, value]) => {
    if (['string', 'number', 'boolean'].includes(typeof value)) safeDetails[cleanText(key, 40)] = typeof value === 'string' ? cleanText(value, 180) : value;
  });
  await db.collection('auditoriaSuporte').add({
    accountId: cleanText(accountId, 80),
    action: cleanText(action, 80),
    details: safeDetails,
    criadaEm: admin.firestore.FieldValue.serverTimestamp()
  });
}

async function issueCompanySession(ref) {
  const token = `v2.${ref.id}.${crypto.randomBytes(32).toString('hex')}`;
  const now = Date.now();
  const tokenHash = hashSecret(token);
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const saved = snapshot.data()?.companySessions;
    const sessions = saved && typeof saved === 'object' ? { ...saved } : {};
    const activeSessions = Object.entries(sessions)
      .filter(([, session]) => Number(session?.expiresAtMs || 0) > now)
      .sort((a, b) => Number(b[1]?.issuedAtMs || 0) - Number(a[1]?.issuedAtMs || 0))
      .slice(0, 4);
    const nextSessions = Object.fromEntries(activeSessions);
    nextSessions[tokenHash] = { issuedAtMs: now, expiresAtMs: now + COMPANY_SESSION_MS };
    tx.set(ref, {
      companySessions: nextSessions,
      ultimoLoginEm: admin.firestore.FieldValue.serverTimestamp(),
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });
  return token;
}

async function issueCustomerSession(ref) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  await ref.set({
    sessionTokenHash: hashSecret(token),
    sessionIssuedAtMs: now,
    sessionExpiresAtMs: now + CUSTOMER_SESSION_MS,
    ultimoLoginEm: admin.firestore.FieldValue.serverTimestamp(),
    atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  return token;
}

async function issueCarCustomerSession(ref) {
  const token = `v2.${ref.id}.${crypto.randomBytes(32).toString('hex')}`;
  const now = Date.now();
  await ref.set({
    sessionTokenHash: hashSecret(token),
    sessionIssuedAtMs: now,
    sessionExpiresAtMs: now + CAR_CUSTOMER_SESSION_MS,
    ultimoLoginEm: admin.firestore.FieldValue.serverTimestamp(),
    atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  return token;
}

function customerProfileComplete(data = {}) {
  return !!(
    data.whatsappVerificadoEm
    && data.cpfHash
    && validBirthDate(data.dataNascimento)
    && validDriverPhoto(data.fotoCliente)
    && data.passwordHash
    && data.passwordSalt
  );
}

async function findCustomerSession(token) {
  const value = String(token || '').trim();
  if (!value) return null;
  const snap = await db.collection('clientes').where('sessionTokenHash', '==', hashSecret(value)).limit(1).get();
  if (snap.empty) return null;
  const customerSnap = snap.docs[0];
  const customer = customerSnap.data() || {};
  const expiresAt = Number(customer.sessionExpiresAtMs || 0);
  if (expiresAt && expiresAt <= Date.now()) return null;
  return { customerSnap, customer, customerId: customerSnap.id };
}

function carCustomerProfileComplete(data = {}) {
  return !!(
    data.whatsappVerificadoEm
    && data.cpfHash
    && validBirthDate(data.dataNascimento)
    && validDriverPhoto(data.fotoCliente)
    && data.passwordHash
    && data.passwordSalt
    && data.status !== 'bloqueada'
  );
}

function publicCarCustomer(data = {}, id = '') {
  return {
    id,
    nome: cleanText(data.nome, 80),
    telefoneCliente: onlyDigits(data.telefoneCliente || id).slice(0, 11),
    fotoCliente: validDriverPhoto(data.fotoCliente) || '',
    cpfFinal: onlyDigits(data.cpfFinal).slice(-4),
    dataNascimento: data.dataNascimento || '',
    cadastroCompleto: carCustomerProfileComplete(data)
  };
}

async function findCarCustomerSession(token) {
  const value = String(token || '').trim();
  if (!value) return null;
  let customerSnap = null;
  const parts = value.split('.');
  if (parts.length === 3 && parts[0] === 'v2' && /^\d{10,11}$/.test(parts[1])) {
    const direct = await db.collection('carroClientes').doc(parts[1]).get();
    if (!direct.exists || !safeEqual(direct.data()?.sessionTokenHash || '', hashSecret(value))) return null;
    customerSnap = direct;
  } else {
    const snap = await db.collection('carroClientes').where('sessionTokenHash', '==', hashSecret(value)).limit(1).get();
    if (snap.empty) return null;
    customerSnap = snap.docs[0];
  }
  const customer = customerSnap.data() || {};
  const expiresAt = Number(customer.sessionExpiresAtMs || 0);
  if ((expiresAt && expiresAt <= Date.now()) || customer.status === 'bloqueada') return null;
  return { customerSnap, customer, customerId: customerSnap.id };
}

async function assertCarCustomer(req, res, next) {
  try {
    const header = String(req.header('authorization') || '');
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const session = await findCarCustomerSession(token);
    if (!session || !carCustomerProfileComplete(session.customer)) {
      return res.status(401).json({ error: 'sessao_carroja_invalida', message: 'Entre novamente no CarroJa.' });
    }
    req.carCustomer = session.customer;
    req.carCustomerId = session.customerId;
    req.carCustomerSnap = session.customerSnap;
    return next();
  } catch (error) {
    return next(error);
  }
}

function carDriverStatus(driver = {}) {
  const car = driver.carro && typeof driver.carro === 'object' ? driver.carro : driver;
  const status = String(car.status || '');
  if (status === 'aprovado' || status === 'bloqueado') return status;
  return car.modelo || car.placa || status ? 'aguardando_aprovacao' : 'nao_cadastrado';
}

function publicCarDriver(driver = {}, cpf = '', carProfile = null) {
  const car = carProfile || driver.carro || {};
  return {
    cpf: onlyDigits(cpf || driver.cpf),
    nome: cleanText(driver.nome, 80),
    telefone: onlyDigits(driver.telefone).slice(0, 11),
    fotoMotoboy: validDriverPhoto(driver.fotoMotoboy) || '',
    status: carDriverStatus(car),
    online: car.online === true && carDriverStatus(car) === 'aprovado',
    modelo: cleanText(car.modelo, 80),
    ano: cleanText(car.ano, 4),
    placa: cleanText(car.placa, 8).toUpperCase(),
    cor: cleanText(car.cor, 40),
    cidadeBase: cleanText(car.cidadeBase, 80),
    fotoCarro: validDriverPhoto(car.fotoCarro) || '',
    crlvCadastrado: !!validDriverDocument(car.crlvFoto),
    motivoBloqueio: cleanText(car.motivoBloqueio, 180)
  };
}

async function getCarDriverProfile(driverCpf, fallbackDriver = null) {
  const cpf = onlyDigits(driverCpf);
  const cached = carDriverCache.get(cpf);
  if (cached && cached.expiresAt > Date.now()) return cached.car;
  const snap = await db.collection('carroMotoristas').doc(cpf).get();
  const car = snap.exists ? snap.data() || {} : fallbackDriver?.carro || {};
  carDriverCache.set(cpf, { car, expiresAt: Date.now() + DRIVER_PROOF_CACHE_MS });
  return car;
}

function clearCarDriverCache(driverCpf = '') {
  const cpf = onlyDigits(driverCpf);
  if (cpf) carDriverCache.delete(cpf);
  else carDriverCache.clear();
}

async function getApprovedCarDriver(driverCpf, body = {}) {
  const driver = await getDriverWithProof(driverCpf, body);
  const car = await getCarDriverProfile(driverCpf, driver);
  const status = carDriverStatus(car);
  if (status !== 'aprovado') {
    const error = new Error(status === 'bloqueado'
      ? 'Seu cadastro de carro foi bloqueado pelo dono.'
      : 'Seu cadastro de carro ainda aguarda aprovacao do dono.');
    error.status = 403;
    error.code = status === 'bloqueado' ? 'carro_bloqueado' : 'carro_aguardando_aprovacao';
    throw error;
  }
  return { ...driver, carro: car };
}

async function completedCustomerRides(deviceId) {
  if (!deviceId) return 0;
  const byDevice = await db.collection('corridas')
    .where('clienteDeviceId', '==', deviceId)
    .where('status', '==', 'finalizada')
    .limit(CUSTOMER_FREE_RIDES)
    .get();
  return byDevice.size;
}

function publicCompany(data = {}, id = '') {
  const status = companyStatus(data);
  return {
    id,
    empresa: data.empresa || '',
    responsavel: data.responsavel || '',
    email: data.email || '',
    telefoneEmpresa: data.telefoneEmpresa || id,
    retirada: data.retirada || '',
    status,
    aprovada: status === 'aprovada',
    bloqueada: status === 'bloqueada',
    pagamentoModo: data.pagamentoModo === 'mercadopago' ? 'mercadopago' : 'pix_manual',
    mercadoPagoEmpresaConectado: !!data.ultimoDepositoMercadoPagoEm,
    integracaoAtiva: !!data.integracaoAtiva,
    integracaoProtegida: !!(data.integracaoProtegida || data.integracaoTokenEncrypted),
    integracaoNome: data.integracaoNome || '',
    integracaoCodigoLoja: data.integracaoCodigoLoja || '',
    integracaoTipoEntrega: data.integracaoTipoEntrega || '',
    pediplusAtivo: !!data.pediplusAtivo,
    pediplusProtegido: !!(data.pediplusProtegido || data.pediplusTokenEncrypted),
    pediplusTipoEntrega: data.pediplusTipoEntrega || '',
    pedidosMensagemAtivos: !!data.pedidosMensagemAtivos,
    pedidosMensagemTaxaPercentual: Number(data.pedidosMensagemTaxaPercentual || 0),
    pedidosMensagemGrupoConfigurado: !!data.pedidosMensagemGrupoJid,
    pedidosMensagemWebhookConfigurado: !!data.pedidosMensagemWebhookSecretHash,
    ...companyBalance(data)
  };
}

function companyStatus(data = {}) {
  const status = String(data.status || '').trim();
  if (status === 'aguardando_aprovacao' || status === 'bloqueada') return status;
  return 'aprovada';
}

function assertCompanyApproved(req, res, next) {
  const status = companyStatus(req.company);
  if (status !== 'aprovada') {
    return res.status(403).json({
      error: status === 'bloqueada' ? 'empresa_bloqueada' : 'empresa_aguardando_aprovacao',
      message: status === 'bloqueada'
        ? 'Esta empresa esta bloqueada pelo dono. Fale com o suporte MotoJa.'
        : 'Cadastro da empresa aguardando aprovacao do dono. Depois de aprovado, voce podera pedir deposito e chamar motoboy.'
    });
  }
  return next();
}

function publicCustomer(data = {}, id = '') {
  return {
    id,
    nome: data.nome || '',
    telefoneCliente: data.telefoneCliente || id,
    origem: data.origem || '',
    fotoCliente: validDriverPhoto(data.fotoCliente) || '',
    cpfFinal: onlyDigits(data.cpfFinal).slice(-4),
    dataNascimento: data.dataNascimento || '',
    cadastroCompleto: customerProfileComplete(data)
  };
}

async function findCompanySession(token) {
  const value = String(token || '').trim();
  if (!value) return null;
  const tokenHash = hashSecret(value);
  const tokenParts = value.split('.');
  if (tokenParts.length === 3 && tokenParts[0] === 'v2' && /^\d{10,11}$/.test(tokenParts[1])) {
    const companySnap = await db.collection('empresas').doc(tokenParts[1]).get();
    if (!companySnap.exists) return null;
    const company = companySnap.data() || {};
    const session = company.companySessions?.[tokenHash];
    if (!session || Number(session.expiresAtMs || 0) <= Date.now()) return null;
    return { companySnap, company, companyId: companySnap.id, sessionHash: tokenHash };
  }
  const snap = await db.collection('empresas').where('sessionTokenHash', '==', tokenHash).limit(1).get();
  if (snap.empty) return null;
  const companySnap = snap.docs[0];
  const company = companySnap.data() || {};
  const expiresAt = Number(company.sessionExpiresAtMs || 0);
  const legacyIssuedAt = timestampMs(company.ultimoLoginEm);
  if ((expiresAt && expiresAt <= Date.now()) || (!expiresAt && (!legacyIssuedAt || Date.now() - legacyIssuedAt > COMPANY_SESSION_MS))) {
    return null;
  }
  return { companySnap, company, companyId: companySnap.id, legacySession: true };
}

async function assertCompany(req, res, next) {
  try {
    const header = String(req.header('authorization') || '');
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    if (!token) return res.status(401).json({ error: 'empresa_login_obrigatorio' });
    const session = await findCompanySession(token);
    if (!session) return res.status(401).json({ error: 'sessao_empresa_invalida' });
    req.companySnap = session.companySnap;
    req.company = session.company;
    req.companyId = session.companyId;
    req.companySessionHash = session.sessionHash || '';
    req.companyLegacySession = session.legacySession === true;
    return next();
  } catch (error) {
    return next(error);
  }
}

function emitDeliveryTracking(companyId, event) {
  const id = onlyDigits(companyId);
  if (!id) return;
  io.to(`company:${id}`).emit('delivery:tracking', serializeFirestore(event));
}

function emitSupportOperationsRefresh() {
  supportOperationsCache = null;
  io.to('support:operations').emit('support:refresh', { at: Date.now() });
}

function disconnectSupportSockets(accountId) {
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.supportAccountId === accountId) socket.disconnect(true);
  }
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
  const cacheKey = `${driverCpf}:${onlyDigits(body.driverCnh)}:${onlyDigits(body.driverTelefone)}`;
  const cached = driverProofCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.driver?.status === 'bloqueado') {
      const error = new Error('Motoboy bloqueado pelo dono. Fale com o suporte MotoJa.');
      error.status = 403;
      error.code = 'motoboy_bloqueado';
      throw error;
    }
    return cached.driver;
  }

  const driverSnap = await db.collection('motoboys').doc(driverCpf).get();
  if (!driverSnap.exists) {
    const error = new Error('Motoboy nao cadastrado.');
    error.status = 404;
    error.code = 'motoboy_nao_cadastrado';
    throw error;
  }

  const driver = driverSnap.data() || {};
  if (driver.status === 'bloqueado') {
    const error = new Error('Motoboy bloqueado pelo dono. Fale com o suporte MotoJa.');
    error.status = 403;
    error.code = 'motoboy_bloqueado';
    throw error;
  }
  assertDriverProof(driver, body);
  driverProofCache.set(cacheKey, { driver, expiresAt: Date.now() + DRIVER_PROOF_CACHE_MS });
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
    valor: money(body.valor),
    metodo: String(body.metodo || 'pix_manual').slice(0, 40).trim()
  };
}

function appUrl(path) {
  return `${String(process.env.APP_BASE_URL || '').replace(/\/$/, '')}${path}`;
}

function backendUrl(path) {
  return `${BACKEND_BASE_URL}${path}`;
}

function mercadoPagoWebhookUrl(params = {}) {
  const query = new URLSearchParams(params);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return backendUrl(`/api/mercadopago/webhook${suffix}`);
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
    origemDigitada: String(ride.origemDigitada || ride.origem || ''),
    origemEncontrada: String(ride.origemEncontrada || ride.origem || ''),
    origemLat: Number(ride.origemLat || 0),
    origemLon: Number(ride.origemLon || 0),
    destino: String(ride.destino || ''),
    destinoEncontrado: String(ride.destinoEncontrado || ride.destino || ''),
    destinoLat: Number(ride.destinoLat || 0),
    destinoLon: Number(ride.destinoLon || 0),
    km: Number(ride.km || 0),
    valor: money(ride.valor),
    precoLabel: String(ride.precoLabel || ''),
    origemMapa: String(ride.origemMapa || ''),
    cidadeOperacao: canonicalRideCity(ride.cidadeOperacao, ''),
    clienteDeviceId: validDeviceId(ride.clienteDeviceId)
  };
}

function carRidePublicData(ride = {}) {
  return {
    clientRequestId: String(ride.clientRequestId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80),
    origem: cleanText(ride.origem, 300),
    origemEncontrada: cleanText(ride.origemEncontrada || ride.origem, 300),
    origemLat: Number(ride.origemLat || 0),
    origemLon: Number(ride.origemLon || 0),
    destino: cleanText(ride.destino, 300),
    destinoEncontrado: cleanText(ride.destinoEncontrado || ride.destino, 300),
    destinoLat: Number(ride.destinoLat || 0),
    destinoLon: Number(ride.destinoLon || 0),
    cidadeOperacao: cleanText(ride.cidadeOperacao, 80),
    observacao: cleanText(ride.observacao, 240),
    pagamentoModo: ['dinheiro', 'pix', 'mercadopago'].includes(String(ride.pagamentoModo || ''))
      ? String(ride.pagamentoModo)
      : 'pix'
  };
}

function carRideForCustomer(id, ride = {}) {
  const car = ride.carro || {};
  return {
    id,
    status: String(ride.status || ''),
    origem: cleanText(ride.origemEncontrada || ride.origem, 300),
    destino: cleanText(ride.destinoEncontrado || ride.destino, 300),
    km: Number(ride.km || 0),
    valor: money(ride.valor),
    tarifaPeriodo: String(ride.tarifaPeriodo || ''),
    tarifaPorKm: Number(ride.tarifaPorKm || 0),
    tarifaLabel: String(ride.tarifaLabel || ''),
    motorista: cleanText(ride.motorista, 80),
    motoristaFoto: validDriverPhoto(ride.motoristaFoto) || '',
    motoristaTelefone: onlyDigits(ride.motoristaTelefone).slice(0, 11),
    carro: ride.motoristaCpf ? {
      modelo: cleanText(car.modelo, 80),
      placa: cleanText(car.placa, 8).toUpperCase(),
      cor: cleanText(car.cor, 40),
      foto: validDriverPhoto(car.fotoCarro) || ''
    } : null,
    motoristaLocalizacao: ['aceita', 'motorista_chegou', 'em_andamento'].includes(ride.status)
      ? serializeFirestore(ride.motoristaLocalizacao || null)
      : null,
    criadaEmMs: timestampMs(ride.criadaEm),
    aceitaEmMs: timestampMs(ride.aceitaEm),
    iniciadaEmMs: timestampMs(ride.iniciadaEm),
    finalizadaEmMs: timestampMs(ride.finalizadaEm)
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
    retiradaEncontrada: String(delivery.retiradaEncontrada || delivery.retirada || '').slice(0, 300).trim(),
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
      recebedor: String(p.recebedor || '').slice(0, 120).trim(),
      telefoneRecebedor: onlyDigits(p.telefoneRecebedor).slice(0, 13),
      lat: Number(p.lat || 0),
      lon: Number(p.lon || 0),
      mapa: String(p.mapa || '').slice(0, 260).trim(),
    })) : [],
    descricao: String(delivery.descricao || '').slice(0, 500).trim(),
    observacao: String(delivery.observacao || '').slice(0, 500).trim(),
    dadosNaNota: delivery.dadosNaNota === true || (
      !String(delivery.recebedor || '').trim()
      && !onlyDigits(delivery.telefoneRecebedor)
      && !String(delivery.descricao || '').trim()
      && !String(delivery.observacao || '').trim()
      && (!Array.isArray(delivery.pontosExtras) || delivery.pontosExtras.every((p) => (
        !String(p?.recebedor || '').trim() && !onlyDigits(p?.telefoneRecebedor)
      )))
    ),
    integracaoOrigem: String(delivery.integracaoOrigem || '').slice(0, 60).trim(),
    integracaoPedidoId: String(delivery.integracaoPedidoId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80),
    integracaoPedidoRecebidoEm: String(delivery.integracaoPedidoRecebidoEm || '').slice(0, 80).trim(),
    paradas: deliveryStopCount(delivery.paradas),
    km: Number(delivery.km || 0),
    valor: money(delivery.valor),
    precoLabel: String(delivery.precoLabel || ''),
    retiradaMapa: String(delivery.retiradaMapa || '')
  };
}

async function notifyTelegramAboutRide(rideId, ride) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const city = rideOperatingCity(ride);
  const chatId = city === 'aguai'
    ? process.env.TELEGRAM_CHAT_ID_AGUAI || process.env.TELEGRAM_CHAT_ID
    : city === 'engenheiro_coelho'
      ? process.env.TELEGRAM_CHAT_ID_ENGENHEIRO_COELHO || process.env.TELEGRAM_CHAT_ID
      : process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { sent: false, skipped: true };

  const value = money(ride.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const km = Number(ride.km || 0).toFixed(2).replace('.', ',');
  const appLink = process.env.APP_BASE_URL
    ? appUrl('/motoboy.html')
    : 'https://nexusmotoja.com.br/motoboy.html';
  const originMap = ride.origemMapa ? `\nMapa origem: ${ride.origemMapa}` : '';
  const message = [
    '<b>NOVA CORRIDA TOCANDO</b>',
    '',
    `<b>Cidade:</b> ${escapeTelegram(rideCityLabel(city))}`,
    `<b>Cliente:</b> ${escapeTelegram(ride.nome || 'Cliente')}`,
    `<b>Valor:</b> ${escapeTelegram(value)}`,
    `<b>Distancia:</b> ${escapeTelegram(km)} km`,
    `<b>Origem:</b> ${escapeTelegram(ride.origem || '-')}${escapeTelegram(originMap)}`,
    `<b>Destino:</b> ${escapeTelegram(ride.destino || '-')}`,
    '',
    `<b>Expira em:</b> ${RIDE_EXPIRE_MINUTES} minutos`,
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
    : 'https://nexusmotoja.com.br/motoboy.html';
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
    Array.isArray(delivery.pontosExtras) && delivery.pontosExtras.length ? `<b>Pontos extras:</b>\n${delivery.pontosExtras.map((p) => `${escapeTelegram(p.ordem || '')}. ${escapeTelegram(p.digitado || '')}\nRecebe: ${escapeTelegram(p.recebedor || '-')}\nWhatsApp: ${escapeTelegram(p.telefoneRecebedor || '-')}${p.mapa ? `\nMapa: ${escapeTelegram(p.mapa)}` : ''}`).join('\n\n')}` : (delivery.enderecosExtras ? `<b>Pontos extras:</b> ${escapeTelegram(delivery.enderecosExtras)}` : ''),
    delivery.recebedor ? `<b>Recebedor:</b> ${escapeTelegram(delivery.recebedor)}` : '',
    delivery.telefoneRecebedor ? `<b>WhatsApp recebedor:</b> ${escapeTelegram(delivery.telefoneRecebedor)}` : '',
    delivery.descricao ? `<b>Pedido:</b> ${escapeTelegram(delivery.descricao)}` : '',
    delivery.observacao ? `<b>Obs:</b> ${escapeTelegram(delivery.observacao)}` : '',
    delivery.dadosNaNota ? '<b>Dados do cliente:</b> conferir na nota impressa' : '',
    '',
    `<b>Expira em:</b> ${DELIVERY_EXPIRE_MINUTES} minutos`,
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
const httpServer = createServer(app);
app.set('trust proxy', 1);

const DEFAULT_ALLOWED_ORIGINS = [
  'https://nexusmotoja.com.br',
  'https://www.nexusmotoja.com.br',
  'https://suporte.nexusmotoja.com.br',
  'https://nexusconchal.github.io',
  'https://motoboy-conchal.onrender.com',
  'http://127.0.0.1:8093',
  'http://localhost:8093'
].join(',');
const allowedOrigins = String(`${DEFAULT_ALLOWED_ORIGINS},${process.env.ALLOWED_ORIGINS || ''}`)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)
  .filter((origin, index, all) => all.indexOf(origin) === index);

const io = new SocketIOServer(httpServer, {
  cors: {
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Origin not allowed'));
    }
  },
  transports: ['websocket', 'polling']
});

io.use(async (socket, next) => {
  try {
    const token = String(socket.handshake.auth?.token || '');
    if (token.startsWith('support.v1.')) {
      const supportSession = await findSupportSession(token);
      if (!supportSession || supportAccountStatus(supportSession.account) !== 'aprovada') {
        return next(new Error('sessao_suporte_invalida'));
      }
      socket.data.supportAccountId = supportSession.accountId;
      return next();
    }
    const session = await findCompanySession(token);
    if (!session || companyStatus(session.company) !== 'aprovada') {
      return next(new Error('sessao_empresa_invalida'));
    }
    socket.data.companyId = session.companyId;
    return next();
  } catch (error) {
    return next(error);
  }
});

io.on('connection', (socket) => {
  if (socket.data.supportAccountId) socket.join('support:operations');
  else socket.join(`company:${socket.data.companyId}`);
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
app.use(helmet());
app.use(express.json({ limit: '8mb' }));
app.use(['/api/support', '/api/admin/support'], (_req, res, next) => {
  res.set('cache-control', 'no-store, max-age=0');
  res.set('pragma', 'no-cache');
  next();
});
app.use('/api/admin', (req, res, next) => {
  if (req.method !== 'GET') {
    res.on('finish', () => {
      if (res.statusCode < 400) adminStateCache = null;
    });
  }
  next();
});
app.use('/api', (req, res, next) => {
  const operationalPath = /^\/(rides|deliveries)(?:\/[^/]+\/(?:renew|accept|pickup|cancel|client-cancel|finish))?$/;
  const ownerOperationalPath = /^\/admin\/(rides|deliveries)\/[^/]+\/(?:renew|cancel|force-finish)$/;
  const companyOperationalPath = /^\/companies\/exclusive-service$/;
  const notifiesSupport = req.method === 'POST' && (operationalPath.test(req.path) || ownerOperationalPath.test(req.path) || companyOperationalPath.test(req.path));
  if (notifiesSupport) {
    res.on('finish', () => {
      if (res.statusCode < 400) emitSupportOperationsRefresh();
    });
  }
  next();
});
morgan.token('safe-url', (req) => {
  try {
    const parsed = new URL(req.originalUrl || req.url, 'https://local.invalid');
    for (const key of ['captureKey', 'token', 'secret', 'code']) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, '[REDACTED]');
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return String(req.path || '/');
  }
});
app.use(morgan(':method :safe-url :status :res[content-length] - :response-time ms'));
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

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'muitas_tentativas_login', message: 'Muitas tentativas. Aguarde 15 minutos antes de tentar novamente.' }
});

const customerOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'muitos_codigos', message: 'Aguarde 15 minutos antes de pedir outro codigo.' }
});

const integrationLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'muitas_tentativas_integracao', message: 'Integracao temporariamente limitada. Tente novamente em um minuto.' }
});

const mapLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 45,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'muitas_tentativas_mapa', message: 'Aguarde um pouco antes de consultar o mapa novamente.' }
});

async function mpFetch(path, { token, method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${MP_API}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...headers
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

  const split = rideSplitAmounts(ride.valor, ride.km);
  const { total, appFee, driverAmount } = split;

  const preference = await mpFetch('/checkout/preferences', {
    token: sellerToken,
    method: 'POST',
    body: {
      external_reference: rideId,
      marketplace_fee: appFee,
      notification_url: mercadoPagoWebhookUrl({ rideId, driverCpf }),
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
        driver_percent: split.driverPercent,
        app_fee: appFee,
        driver_amount: driverAmount
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

async function createOwnerRidePaymentPreference(rideId, ride, driverCpf) {
  const split = rideSplitAmounts(ride.valor, ride.km);
  const { total, appFee, driverAmount } = split;

  const preference = await mpFetch('/checkout/preferences', {
    token: requiredEnv('MP_OWNER_ACCESS_TOKEN'),
    method: 'POST',
    body: {
      external_reference: rideId,
      notification_url: mercadoPagoWebhookUrl({ rideId, receiver: 'owner' }),
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
        payment_kind: 'ride_owner_fallback',
        app_percent: split.appPercent,
        driver_percent: split.driverPercent,
        app_fee: appFee,
        driver_amount: driverAmount
      }
    }
  });

  return {
    preferenceId: preference.id,
    initPoint: preference.init_point,
    sandboxInitPoint: preference.sandbox_init_point,
    total,
    appFee,
    driverAmount,
    ownerFallback: true
  };
}

async function createPointPaymentOrder(rideId, ride, driverCpf) {
  const terminalId = String(process.env.MP_POINT_TERMINAL_ID || '').trim();
  if (!terminalId) {
    const error = new Error('Terminal Mercado Pago Point ainda nao configurado. Defina MP_POINT_TERMINAL_ID no Render.');
    error.status = 503;
    error.code = 'mp_point_terminal_missing';
    throw error;
  }

  const split = rideSplitAmounts(ride.valor, ride.km);
  const externalReference = String(`ride_${rideId}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  const idempotencyKey = crypto.createHash('sha256')
    .update(`${externalReference}:${terminalId}:${money(ride.valor).toFixed(2)}`)
    .digest('hex');
  const order = await mpFetch('/v1/orders', {
    token: requiredEnv('MP_OWNER_ACCESS_TOKEN'),
    method: 'POST',
    headers: {
      'X-Idempotency-Key': idempotencyKey
    },
    body: {
      type: 'point',
      external_reference: externalReference,
      expiration_time: 'PT10M',
      transactions: {
        payments: [{
          amount: split.total.toFixed(2)
        }]
      },
      config: {
        point: {
          terminal_id: terminalId,
          print_on_terminal: 'no_ticket'
        },
        payment_method: {
          default_type: 'credit_card',
          installments_cost: 'seller'
        }
      },
      description: `Corrida MotoJa ${ride.nome || 'cliente'}`.slice(0, 120),
      metadata: {
        ride_id: rideId,
        driver_cpf: driverCpf,
        payment_kind: 'ride_point_tap',
        app_fee: split.appFee,
        driver_amount: split.driverAmount
      }
    }
  });

  return {
    orderId: order.id,
    externalReference,
    terminalId,
    status: order.status || 'created',
    statusDetail: order.status_detail || '',
    total: split.total,
    appFee: split.appFee,
    driverAmount: split.driverAmount
  };
}

function ridePaymentInstructions(ride) {
  return `Pague por este link Mercado Pago:\n${ride.pagamento.initPoint}\n\nDepois de pagar, envie o comprovante aqui. O app libera finalizar quando o Mercado Pago confirmar o pagamento aprovado.`;
}
async function createCompanyDepositPreference(depositId, deposit) {
  const total = money(deposit.valor);
  if (total < 10) {
    const error = new Error('Deposito minimo: R$ 10,00.');
    error.status = 400;
    error.code = 'valor_deposito_invalido';
    throw error;
  }

  const preference = await mpFetch('/checkout/preferences', {
    token: requiredEnv('MP_OWNER_ACCESS_TOKEN'),
    method: 'POST',
    body: {
      external_reference: `deposit:${depositId}`,
      notification_url: `${BACKEND_BASE_URL}/api/mercadopago/webhook`,
      back_urls: {
        success: appUrl('/empresa.html?deposito=ok'),
        failure: appUrl('/empresa.html?deposito=erro'),
        pending: appUrl('/empresa.html?deposito=pendente')
      },
      auto_return: 'approved',
      items: [{
        id: depositId,
        title: `Credito Nexus Entregas - ${deposit.empresa || 'empresa'}`,
        description: `Saldo pre-pago para entregas da empresa ${deposit.empresa || ''}`.trim(),
        quantity: 1,
        currency_id: 'BRL',
        unit_price: total
      }],
      metadata: {
        deposit_id: depositId,
        company_id: deposit.telefoneEmpresa,
        payment_kind: 'company_deposit'
      }
    }
  });

  return {
    preferenceId: preference.id,
    initPoint: preference.init_point,
    sandboxInitPoint: preference.sandbox_init_point,
    total
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
  const city = rideOperatingCity(ride);

  drivers.forEach((doc) => {
    const data = doc.data();
    if (!driverRideCities(data)[city]) return;
    const saved = data.fcmTokens || {};
    Object.entries(saved).forEach(([token, info]) => {
      if (info?.ativo !== false) tokens.push(token);
    });
  });

  if (!tokens.length) return { sent: 0, failed: 0 };

  const response = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: {
      title: `Nova corrida MotoJa ${rideCityLabel(city)}`,
      body: `${ride.nome || 'Cliente'} - ${money(ride.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`
    },
    webpush: {
      fcmOptions: {
        link: appUrl('/motoboy.html')
      }
    },
    data: {
      rideId,
      tipo: 'nova_corrida',
      cidadeOperacao: city
    }
  });

  return {
    sent: response.successCount,
    failed: response.failureCount
  };
}

async function notifyCustomersRideReminder(slot) {
  const customers = await db.collection('clientes').limit(1000).get();
  const tokens = [];

  customers.forEach((doc) => {
    const data = doc.data() || {};
    const saved = data.fcmTokens || {};
    Object.entries(saved).forEach(([token, info]) => {
      if (info?.ativo !== false && info?.tipo === 'cliente_lembrete') tokens.push(token);
    });
  });

  if (!tokens.length) return { sent: 0, failed: 0 };

  const morning = slot === '06:40';
  const response = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: {
      title: 'MotoJa Conchal',
      body: morning ? 'Vai sair hoje? Chame sua MotoJa em poucos segundos.' : 'Precisa de mototaxi em Conchal? A MotoJa esta online.'
    },
    webpush: {
      headers: {
        Urgency: 'high'
      },
      fcmOptions: {
        link: appUrl('/index.html')
      },
      notification: {
        icon: appUrl('/nexus-motoja-icon-192.png'),
        badge: appUrl('/nexus-motoja-icon-192.png'),
        tag: 'cliente_lembrete_' + slot.replace(':', ''),
        renotify: true,
        requireInteraction: true,
        vibrate: [180, 80, 180]
      }
    },
    data: {
      tipo: 'cliente_lembrete',
      slot
    }
  });

  return {
    sent: response.successCount,
    failed: response.failureCount
  };
}

function saoPauloDateTimeParts(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  return {
    day: parts.year + '-' + parts.month + '-' + parts.day,
    time: parts.hour + ':' + parts.minute
  };
}

async function runCustomerReminderTick(date = new Date()) {
  const { day, time } = saoPauloDateTimeParts(date);
  if (time !== '06:40' && time !== '16:50') return;

  const markerRef = db.collection('sistema').doc('cliente_lembrete_' + day + '_' + time.replace(':', ''));
  let shouldSend = false;
  await db.runTransaction(async (tx) => {
    const marker = await tx.get(markerRef);
    if (marker.exists) return;
    tx.set(markerRef, {
      day,
      time,
      criadoEm: admin.firestore.FieldValue.serverTimestamp()
    });
    shouldSend = true;
  });
  if (!shouldSend) return;

  const result = await notifyCustomersRideReminder(time);
  await markerRef.set({
    ...result,
    enviadoEm: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

async function notifyDriversAboutDelivery(deliveryId, delivery) {
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
      title: 'Nova entrega Nexus MotoJa',
      body: `${delivery.empresa || 'Empresa'} - ${money(delivery.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`
    },
    webpush: {
      fcmOptions: {
        link: appUrl('/motoboy.html?aba=entregas')
      }
    },
    data: {
      deliveryId,
      tipo: 'nova_entrega'
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
    if (createdAt && now - createdAt > RIDE_EXPIRE_MS) {
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

  const pendingCarRides = await db.collection('corridasCarro').where('status', '==', 'pendente').get();
  pendingCarRides.forEach((doc) => {
    const data = doc.data() || {};
    const createdAt = timestampMs(data.criadaEm);
    if (createdAt && now - createdAt > CAR_RIDE_EXPIRE_MS) {
      batch.update(doc.ref, {
        status: 'expirada',
        expiradaEm: admin.firestore.FieldValue.serverTimestamp(),
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
    if (createdAt && now - createdAt > DELIVERY_EXPIRE_MS) {
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
      rastreamentoAtivo: false,
      motoboyLocalizacao: admin.firestore.FieldValue.delete(),
      localizacaoAtualizadaEm: admin.firestore.FieldValue.delete(),
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
  res.json({
    ok: true,
    service: 'motoja-conchal-backend',
    release: 'support-console-v177',
    manualDeliveryDateMigration: manualDeliveryDateMigrationStatus
  });
});

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'motoja-conchal-backend',
    site: process.env.APP_BASE_URL || null
  });
});

app.get('/api/maps/geocode', mapLimiter, async (req, res, next) => {
  try {
    if (!GEOAPIFY_API_KEY) {
      res.status(500).json({ error: 'geoapify_nao_configurado', message: 'Mapa nao configurado no servidor.' });
      return;
    }

    const text = cleanText(req.query.text, 220);
    if (!text) {
      res.status(400).json({ error: 'endereco_obrigatorio', message: 'Informe o endereco para localizar.' });
      return;
    }

    const params = new URLSearchParams({
      text,
      lang: 'pt',
      limit: String(Math.min(5, Math.max(1, Number(req.query.limit) || 5))),
      apiKey: GEOAPIFY_API_KEY
    });
    const filter = cleanText(req.query.filter, 80);
    const bias = cleanText(req.query.bias, 80);
    if (/^rect:-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(filter)) params.set('filter', filter);
    if (/^proximity:-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(bias)) params.set('bias', bias);

    const response = await fetch(`https://api.geoapify.com/v1/geocode/search?${params.toString()}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      res.status(502).json({ error: 'geoapify_falhou', message: 'Nao consegui consultar o mapa agora.' });
      return;
    }
    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.get('/api/maps/reverse', mapLimiter, async (req, res, next) => {
  try {
    if (!GEOAPIFY_API_KEY) {
      res.status(500).json({ error: 'geoapify_nao_configurado', message: 'Mapa nao configurado no servidor.' });
      return;
    }

    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!validCoordinate({ lat, lon })) {
      res.status(400).json({ error: 'coordenadas_invalidas', message: 'Coordenadas invalidas para consultar o mapa.' });
      return;
    }

    const params = new URLSearchParams({
      lat: String(lat),
      lon: String(lon),
      lang: 'pt',
      apiKey: GEOAPIFY_API_KEY
    });
    const response = await fetch(`https://api.geoapify.com/v1/geocode/reverse?${params.toString()}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      res.status(502).json({ error: 'geoapify_falhou', message: 'Nao consegui consultar o mapa agora.' });
      return;
    }
    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.post('/api/maps/route', mapLimiter, async (req, res, next) => {
  try {
    const route = await calculateRoute(req.body?.points || []);
    res.json(route);
  } catch (error) {
    next(error);
  }
});

function driverStatusHtml(title, item = {}) {
  const name = cleanText(item.motoboy || 'Motoboy Nexus MotoJa', 80);
  const phone = onlyDigits(item.motoboyTelefone);
  const photo = validDriverPhoto(item.motoboyFoto) || '';
  const service = cleanText(title, 60);
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${service}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#090911;color:#fff;font-family:system-ui,sans-serif}.card{width:min(92vw,390px);padding:24px;border-radius:22px;background:linear-gradient(180deg,#241614,#11121c);border:1px solid rgba(255,154,0,.28);text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.4)}img{width:112px;height:112px;border-radius:50%;object-fit:cover;border:4px solid #ff9a00;background:#1b1b27}.empty{width:112px;height:112px;border-radius:50%;display:grid;place-items:center;margin:0 auto;background:#1b1b27;border:4px solid #ff9a00;color:#ff9a00;font-size:40px;font-weight:900}small{color:#ff9a00;font-weight:900;letter-spacing:1px;text-transform:uppercase}h1{font-size:24px;margin:12px 0 6px}.muted{color:#c8c8d6}.ok{color:#bfffd2;font-weight:800}</style></head><body><main class="card"><small>Nexus MotoJa</small><h1>${service}</h1>${photo ? `<img src="${photo}" alt="Foto do motoboy">` : '<div class="empty">MJ</div>'}<h2>${name}</h2><p class="muted">Este e o motoboy que aceitou o atendimento pelo app.</p>${phone ? `<p class="ok">WhatsApp: ${phone}</p>` : ''}</main></body></html>`;
}

app.get('/corrida/:rideId', async (req, res, next) => {
  try {
    const snap = await db.collection('corridas').doc(String(req.params.rideId || '')).get();
    if (!snap.exists) return res.status(404).send('Corrida nao encontrada.');
    const nonce = crypto.randomBytes(16).toString('base64');
    res.set('content-security-policy', `default-src 'self'; script-src 'self' 'nonce-${nonce}' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: https://*.tile.openstreetmap.org https:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'none'`);
    return res.type('html').send(rideTrackingHtml(snap.id, snap.data() || {}, nonce));
  } catch (error) {
    return next(error);
  }
});

app.get('/entrega/:deliveryId', async (req, res, next) => {
  try {
    const snap = await db.collection('entregas').doc(String(req.params.deliveryId || '')).get();
    if (!snap.exists) return res.status(404).send('Entrega nao encontrada.');
    return res.type('html').send(driverStatusHtml('Motoboy da entrega', snap.data() || {}));
  } catch (error) {
    return next(error);
  }
});

app.post('/api/admin/login', authLimiter, (req, res) => {
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

app.post('/api/support/register', authLimiter, async (req, res, next) => {
  try {
    const nome = cleanText(req.body.nome, 100);
    const cpf = onlyDigits(req.body.cpf);
    const telefone = onlyDigits(req.body.telefone).slice(0, 11);
    const birth = validBirthDate(req.body.dataNascimento);
    const foto = validDriverPhoto(req.body.foto);
    const password = String(req.body.password || '');
    const consentAccepted = req.body.consentAccepted === true;
    if (nome.split(' ').filter(Boolean).length < 2) {
      return res.status(400).json({ error: 'nome_completo_obrigatorio', message: 'Informe nome e sobrenome.' });
    }
    if (!validCpf(cpf)) return res.status(400).json({ error: 'cpf_invalido', message: 'Confira o CPF informado.' });
    if (!birth || birth.age < 18) return res.status(400).json({ error: 'data_nascimento_invalida', message: 'O cadastro de suporte exige idade mínima de 18 anos.' });
    if (telefone.length < 10) return res.status(400).json({ error: 'telefone_invalido', message: 'Informe um WhatsApp com DDD.' });
    if (!foto) return res.status(400).json({ error: 'foto_invalida', message: 'Envie uma foto nítida do rosto.' });
    if (!consentAccepted) return res.status(400).json({ error: 'consentimento_obrigatorio', message: 'Confirme o uso dos dados para identificação e segurança.' });
    if (!validSupportPassword(password)) {
      return res.status(400).json({ error: 'senha_fraca', message: 'Use pelo menos 10 caracteres, com letra maiúscula, minúscula e número.' });
    }

    const accountId = hashSecret(cpf);
    const accountRef = db.collection('contasSuporte').doc(accountId);
    const existing = await accountRef.get();
    if (existing.exists) {
      return res.status(409).json({ error: 'cpf_ja_cadastrado', message: 'Este CPF já possui cadastro. Entre com sua senha ou fale com o dono.' });
    }
    const auth = supportPasswordHash(password);
    const cpfEncrypted = encryptSecret(cpf);
    const birthEncrypted = encryptSecret(birth.text);
    const fotoEncrypted = encryptSecret(foto);
    if (!cpfEncrypted || !birthEncrypted || !fotoEncrypted) {
      return res.status(503).json({ error: 'criptografia_indisponivel', message: 'Cadastro temporariamente indisponível. Fale com o dono.' });
    }

    await accountRef.create({
      nome,
      telefone,
      cpfHash: accountId,
      cpfFinal: cpf.slice(-4),
      cpfEncrypted,
      dataNascimentoEncrypted: birthEncrypted,
      fotoEncrypted,
      passwordSalt: auth.salt,
      passwordHash: auth.hash,
      passwordIterations: auth.iterations,
      status: 'aguardando_aprovacao',
      consentimentoDadosVersao: 'support-access-v1',
      consentimentoDadosEm: admin.firestore.FieldValue.serverTimestamp(),
      cadastradaEm: admin.firestore.FieldValue.serverTimestamp(),
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    });
    await writeSupportAudit(accountId, 'cadastro_enviado').catch((error) => console.error('support audit failed', error));
    return res.status(201).json({
      ok: true,
      pendingApproval: true,
      message: 'Cadastro enviado. Aguarde a aprovação do dono da MotoJÁ antes de entrar.'
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/support/login', authLimiter, async (req, res, next) => {
  try {
    const cpf = onlyDigits(req.body.cpf);
    const password = String(req.body.password || '');
    if (!validCpf(cpf) || !password) return res.status(401).json({ error: 'credenciais_invalidas', message: 'CPF ou senha incorretos.' });
    const accountId = hashSecret(cpf);
    const accountRef = db.collection('contasSuporte').doc(accountId);
    const snapshot = await accountRef.get();
    const account = snapshot.data() || {};
    if (!snapshot.exists || !verifySupportPassword(password, account)) {
      return res.status(401).json({ error: 'credenciais_invalidas', message: 'CPF ou senha incorretos.' });
    }
    const status = supportAccountStatus(account);
    if (status !== 'aprovada') {
      return res.status(403).json({
        error: status === 'bloqueada' ? 'conta_suporte_bloqueada' : 'conta_suporte_aguardando_aprovacao',
        message: status === 'bloqueada' ? 'Conta bloqueada. Fale com o dono da MotoJÁ.' : 'Seu cadastro ainda está aguardando aprovação do dono.'
      });
    }
    const token = await issueSupportSession(accountRef);
    await writeSupportAudit(accountId, 'login_realizado', {
      userAgent: cleanText(req.header('user-agent'), 160)
    }).catch((error) => console.error('support audit failed', error));
    const updated = await accountRef.get();
    return res.json({ ok: true, token, expiresInMs: SUPPORT_SESSION_MS, account: publicSupportAccount(updated.data() || {}, accountId) });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/support/me', assertSupport, (req, res) => {
  return res.json({ ok: true, account: publicSupportAccount(req.supportAccount, req.supportAccountId) });
});

app.post('/api/support/logout', assertSupport, async (req, res, next) => {
  try {
    await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(req.supportAccountSnap.ref);
      const sessions = { ...(snapshot.data()?.supportSessions || {}) };
      delete sessions[req.supportSessionHash];
      tx.set(req.supportAccountSnap.ref, {
        supportSessions: sessions,
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });
    await writeSupportAudit(req.supportAccountId, 'logout_realizado').catch((error) => console.error('support audit failed', error));
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/support/operations', assertSupport, async (req, res, next) => {
  try {
    if (supportOperationsCache && supportOperationsCache.expiresAt > Date.now()) {
      return res.json(supportOperationsCache.payload);
    }
    const activeStatuses = ['pendente', 'aceita', 'retirada'];
    const [ridesSnap, deliveriesSnap, carRidesSnap] = await Promise.all([
      db.collection('corridas').where('status', 'in', activeStatuses).limit(100).get(),
      db.collection('entregas').where('status', 'in', activeStatuses).limit(100).get(),
      db.collection('corridasCarro').where('status', 'in', ['pendente', 'aceita', 'motorista_chegou', 'em_andamento']).limit(100).get()
    ]);
    const operations = [
      ...ridesSnap.docs.map((doc) => supportOperation('corrida', doc.id, doc.data() || {})),
      ...deliveriesSnap.docs.map((doc) => supportOperation('entrega', doc.id, doc.data() || {})),
      ...carRidesSnap.docs.map((doc) => supportOperation('carro', doc.id, doc.data() || {}))
    ].sort((a, b) => Number(b.alertVersion || 0) - Number(a.alertVersion || 0));
    const payload = { ok: true, operations, updatedAtMs: Date.now() };
    supportOperationsCache = { payload, expiresAt: Date.now() + 60 * 1000 };
    return res.json(payload);
  } catch (error) {
    return next(error);
  }
});

app.post('/api/support/alerts/:kind/:jobId/acknowledge', assertSupport, async (req, res, next) => {
  try {
    const kind = ['entrega', 'corrida', 'carro'].includes(req.params.kind) ? req.params.kind : '';
    const jobId = cleanText(req.params.jobId, 120);
    if (!kind || !jobId) return res.status(400).json({ error: 'alerta_invalido' });
    const collection = kind === 'entrega' ? 'entregas' : kind === 'carro' ? 'corridasCarro' : 'corridas';
    const jobRef = db.collection(collection).doc(jobId);
    let result = null;
    await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(jobRef);
      if (!snapshot.exists) {
        const error = new Error('Chamado não encontrado.');
        error.status = 404;
        throw error;
      }
      const job = snapshot.data() || {};
      if (!['pendente', 'aceita', 'retirada', 'motorista_chegou', 'em_andamento'].includes(job.status)) {
        const error = new Error('Este chamado não está mais ativo.');
        error.status = 409;
        throw error;
      }
      const alertVersion = supportAlertVersion(job);
      if (Number(job.suporteAlertaVersao || 0) !== alertVersion) {
        tx.set(jobRef, {
          suporteAlertaVersao: alertVersion,
          suporteAssumidoPorId: req.supportAccountId,
          suporteAssumidoPor: cleanText(req.supportAccount.nome, 100),
          suporteAssumidoEm: admin.firestore.FieldValue.serverTimestamp(),
          atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }
      result = { alertVersion, alreadyAcknowledged: Number(job.suporteAlertaVersao || 0) === alertVersion };
    });
    emitSupportOperationsRefresh();
    await writeSupportAudit(req.supportAccountId, 'alerta_assumido', { kind, jobId, alertVersion: result.alertVersion })
      .catch((error) => console.error('support audit failed', error));
    return res.json({ ok: true, ...result });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/admin/support/accounts', assertOwner, async (_req, res, next) => {
  try {
    const snapshot = await db.collection('contasSuporte').limit(100).get();
    const accounts = snapshot.docs
      .map((doc) => publicSupportAccount(doc.data() || {}, doc.id, true))
      .sort((a, b) => timestampMs(b.cadastradaEm) - timestampMs(a.cadastradaEm));
    return res.json({ ok: true, accounts });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/admin/support/accounts/:accountId/approve', assertOwner, async (req, res, next) => {
  try {
    const accountId = String(req.params.accountId || '');
    if (!/^[a-f0-9]{64}$/.test(accountId)) return res.status(400).json({ error: 'conta_suporte_invalida' });
    const ref = db.collection('contasSuporte').doc(accountId);
    const snapshot = await ref.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'conta_suporte_nao_encontrada' });
    await ref.set({
      status: 'aprovada',
      motivoBloqueio: admin.firestore.FieldValue.delete(),
      supportSessions: admin.firestore.FieldValue.delete(),
      aprovadaEm: admin.firestore.FieldValue.serverTimestamp(),
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    await writeSupportAudit(accountId, 'conta_aprovada_pelo_dono').catch((error) => console.error('support audit failed', error));
    const updated = await ref.get();
    return res.json({ ok: true, account: publicSupportAccount(updated.data() || {}, accountId, true) });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/admin/support/accounts/:accountId/block', assertOwner, async (req, res, next) => {
  try {
    const accountId = String(req.params.accountId || '');
    const reason = cleanText(req.body.reason || 'Acesso encerrado pelo dono', 250);
    if (!/^[a-f0-9]{64}$/.test(accountId)) return res.status(400).json({ error: 'conta_suporte_invalida' });
    const ref = db.collection('contasSuporte').doc(accountId);
    const snapshot = await ref.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'conta_suporte_nao_encontrada' });
    await ref.set({
      status: 'bloqueada',
      motivoBloqueio: reason,
      supportSessions: admin.firestore.FieldValue.delete(),
      bloqueadaEm: admin.firestore.FieldValue.serverTimestamp(),
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    disconnectSupportSockets(accountId);
    await writeSupportAudit(accountId, 'conta_bloqueada_pelo_dono', { reason }).catch((error) => console.error('support audit failed', error));
    const updated = await ref.get();
    return res.json({ ok: true, account: publicSupportAccount(updated.data() || {}, accountId, true) });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/analytics/event', async (req, res, next) => {
  try {
    const type = cleanText(req.body.type || req.body.tipo, 80);
    if (!type) return res.status(400).json({ error: 'tipo_obrigatorio' });

    const campaign = cleanText(req.body.campaign || req.body.campanha || '', 80);
    const source = cleanText(req.body.source || req.body.origem || 'cliente', 40);
    const rideId = cleanText(req.body.rideId || req.body.corridaId || '', 120);
    const details = req.body.details && typeof req.body.details === 'object' ? req.body.details : {};
    const allowedDetails = {};

    Object.entries(details).slice(0, 20).forEach(([key, value]) => {
      if (['string', 'number', 'boolean'].includes(typeof value)) {
        allowedDetails[cleanText(key, 40)] = typeof value === 'string' ? cleanText(value, 160) : value;
      }
    });

    await db.collection('eventosFunil').add({
      type,
      source,
      campaign,
      rideId,
      telefoneCliente: onlyDigits(req.body.telefoneCliente).slice(0, 11),
      sessionId: cleanText(req.body.sessionId, 80),
      page: cleanText(req.body.page || req.header('referer') || '', 220),
      userAgent: cleanText(req.header('user-agent') || req.body.userAgent || '', 260),
      details: allowedDetails,
      dia: dateKeySaoPaulo(),
      criadaEm: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.status(201).json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/admin/state', assertOwner, async (_req, res, next) => {
  try {
    if (adminStateCache && adminStateCache.expiresAt > Date.now()) {
      return res.json(adminStateCache.payload);
    }
    const [corridas, corridasCarro, entregas, motoboys, carroMotoristas, depositos, recuperacoesSenhaEmpresa, empresasRaw, eventosFunil] = await Promise.all([
      collectionState('corridas'),
      collectionState('corridasCarro', 500, 'criadaEm'),
      collectionState('entregas', 500, 'criadaEm'),
      collectionState('motoboys'),
      collectionState('carroMotoristas', 500, 'atualizadoEm'),
      collectionState('depositos'),
      collectionState('recuperacoesSenhaEmpresa'),
      collectionState('empresas'),
      collectionState('eventosFunil', 2000)
    ]);
    const empresas = empresasRaw.map((empresa) => publicCompany(empresa, empresa.id));
    const payload = { ok: true, corridas, corridasCarro, entregas, motoboys, carroMotoristas, depositos, recuperacoesSenhaEmpresa, empresas, eventosFunil };
    adminStateCache = { payload, expiresAt: Date.now() + ADMIN_STATE_CACHE_MS };
    return res.json(payload);
  } catch (error) {
    return next(error);
  }
});

app.post('/api/admin/companies/password-recovery/:requestId/reset', assertOwner, async (req, res, next) => {
  try {
    const requestId = cleanText(req.params.requestId, 120);
    const newPassword = String(req.body.newPassword || req.body.password || '');
    if (!requestId || newPassword.length < 8) {
      return res.status(400).json({ error: 'senha_nova_invalida', message: 'Digite uma senha nova com pelo menos 8 caracteres.' });
    }

    const requestRef = db.collection('recuperacoesSenhaEmpresa').doc(requestId);
    const auth = passwordHash(newPassword);
    let updatedCompany = null;
    await db.runTransaction(async (tx) => {
      const requestSnap = await tx.get(requestRef);
      if (!requestSnap.exists) {
        const error = new Error('Pedido de recuperacao nao encontrado.');
        error.status = 404;
        error.code = 'recuperacao_nao_encontrada';
        throw error;
      }
      const requestData = requestSnap.data() || {};
      if (requestData.status && requestData.status !== 'pendente') {
        const error = new Error('Este pedido de recuperacao ja foi atendido.');
        error.status = 409;
        error.code = 'recuperacao_ja_atendida';
        throw error;
      }
      const companyId = onlyDigits(requestData.companyId || requestData.telefoneEmpresa);
      const companyRef = companyRefFromPhone(companyId);
      if (!companyRef) {
        const error = new Error('Empresa invalida no pedido de recuperacao.');
        error.status = 400;
        error.code = 'empresa_invalida';
        throw error;
      }
      const companySnap = await tx.get(companyRef);
      if (!companySnap.exists) {
        const error = new Error('Conta da empresa nao existe mais.');
        error.status = 404;
        error.code = 'empresa_nao_encontrada';
        throw error;
      }
      updatedCompany = publicCompany(companySnap.data() || {}, companyRef.id);
      tx.set(companyRef, {
        passwordSalt: auth.salt,
        passwordHash: auth.hash,
        companySessions: admin.firestore.FieldValue.delete(),
        sessionTokenHash: admin.firestore.FieldValue.delete(),
        sessionIssuedAtMs: admin.firestore.FieldValue.delete(),
        sessionExpiresAtMs: admin.firestore.FieldValue.delete(),
        senhaAlteradaEm: admin.firestore.FieldValue.serverTimestamp(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      tx.set(requestRef, {
        status: 'concluida',
        concluidaEm: admin.firestore.FieldValue.serverTimestamp(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });

    return res.json({ ok: true, company: updatedCompany });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/admin/companies/:companyId/approve', assertOwner, async (req, res, next) => {
  try {
    const companyRef = companyRefFromPhone(req.params.companyId);
    if (!companyRef) return res.status(400).json({ error: 'empresa_invalida', message: 'Empresa invalida.' });

    const snap = await companyRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'empresa_nao_encontrada', message: 'Empresa nao encontrada.' });

    await companyRef.set({
      status: 'aprovada',
      aprovadaEm: admin.firestore.FieldValue.serverTimestamp(),
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    adminStateCache = null;

    const updated = await companyRef.get();
    return res.json({ ok: true, company: publicCompany(updated.data() || {}, companyRef.id) });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/admin/companies/:companyId/block', assertOwner, async (req, res, next) => {
  try {
    const companyRef = companyRefFromPhone(req.params.companyId);
    if (!companyRef) return res.status(400).json({ error: 'empresa_invalida', message: 'Empresa invalida.' });

    const reason = cleanText(req.body.reason || 'Bloqueada pelo dono', 250);
    const snap = await companyRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'empresa_nao_encontrada', message: 'Empresa nao encontrada.' });

    await companyRef.set({
      status: 'bloqueada',
      motivoBloqueio: reason,
      bloqueadaEm: admin.firestore.FieldValue.serverTimestamp(),
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    adminStateCache = null;

    const updated = await companyRef.get();
    return res.json({ ok: true, company: publicCompany(updated.data() || {}, companyRef.id) });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/admin/companies/:companyId/balance', assertOwner, async (req, res, next) => {
  try {
    const companyRef = companyRefFromPhone(req.params.companyId);
    if (!companyRef) return res.status(400).json({ error: 'empresa_invalida', message: 'Empresa invalida.' });

    const requestedBalance = Number(req.body?.saldo);
    const reason = cleanText(req.body?.reason || req.body?.motivo, 250);
    if (!Number.isFinite(requestedBalance) || requestedBalance < 0 || requestedBalance > 1000000) {
      return res.status(400).json({ error: 'saldo_invalido', message: 'Informe um saldo entre R$ 0,00 e R$ 1.000.000,00.' });
    }
    if (!reason) {
      return res.status(400).json({ error: 'motivo_obrigatorio', message: 'Informe o motivo do ajuste de saldo.' });
    }

    let result;
    await db.runTransaction(async (tx) => {
      const companySnap = await tx.get(companyRef);
      if (!companySnap.exists) {
        const error = new Error('Empresa nao encontrada.');
        error.status = 404;
        error.code = 'empresa_nao_encontrada';
        throw error;
      }

      const before = companyBalance(companySnap.data() || {});
      const nextBalance = money(requestedBalance);
      if (nextBalance < before.reservado) {
        const error = new Error(`O saldo nao pode ficar abaixo do valor reservado de R$ ${before.reservado.toFixed(2).replace('.', ',')}.`);
        error.status = 409;
        error.code = 'saldo_abaixo_do_reservado';
        throw error;
      }

      const difference = money(nextBalance - before.saldo);
      tx.set(companyRef, {
        saldo: nextBalance,
        reservado: before.reservado,
        ultimoAjusteSaldoMotivo: reason,
        ultimoAjusteSaldoEm: admin.firestore.FieldValue.serverTimestamp(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      tx.set(ledgerRef(companyRef.id), {
        tipo: difference >= 0 ? 'credito' : 'debito',
        origem: 'ajuste_manual_dono',
        valor: money(Math.abs(difference)),
        diferenca: difference,
        saldoAntes: before.saldo,
        saldoDepois: nextBalance,
        reservado: before.reservado,
        motivo: reason,
        criadoPor: 'dono',
        criadoEm: admin.firestore.FieldValue.serverTimestamp()
      });
      result = {
        saldo: nextBalance,
        reservado: before.reservado,
        disponivel: money(nextBalance - before.reservado),
        diferenca: difference
      };
    });

    return res.json({ ok: true, ...result });
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
      rastreamentoAtivo: false,
      motoboyLocalizacao: admin.firestore.FieldValue.delete(),
      localizacaoAtualizadaEm: admin.firestore.FieldValue.delete(),
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

app.post('/api/admin/rides/:rideId/payment/presential/approve', assertOwner, async (req, res, next) => {
  try {
    const rideRef = db.collection('corridas').doc(String(req.params.rideId || ''));
    await db.runTransaction(async (tx) => {
      const rideSnap = await tx.get(rideRef);
      if (!rideSnap.exists) {
        const error = new Error('Corrida nao encontrada.');
        error.status = 404;
        throw error;
      }
      const ride = rideSnap.data() || {};
      if (ride.status === 'cancelada') {
        const error = new Error('Corrida cancelada nao pode ter pagamento aprovado.');
        error.status = 409;
        throw error;
      }
      if (!ride.pagamento?.presencialManual?.codigo) {
        const error = new Error('Esta corrida nao tem pagamento presencial informado.');
        error.status = 400;
        throw error;
      }
      tx.set(rideRef, {
        pagamento: {
          ...(ride.pagamento || {}),
          provider: ride.pagamento?.provider || 'mercadopago',
          status: 'approved',
          valido: true,
          aprovadoManualEm: admin.firestore.FieldValue.serverTimestamp(),
          aprovadoManualPor: 'dono'
        },
        pagamentoConfirmadoEm: admin.firestore.FieldValue.serverTimestamp(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/admin/drivers/:cpf/block', assertOwner, async (req, res, next) => {
  try {
    const cpf = onlyDigits(req.params.cpf);
    const motivo = cleanText(req.body.reason || req.body.motivo || 'Bloqueado pelo dono', 180);
    if (cpf.length !== 11) return res.status(400).json({ error: 'cpf_invalido' });
    const driverRef = db.collection('motoboys').doc(cpf);
    const snap = await driverRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'motoboy_nao_encontrado' });
    await driverRef.set({
      status: 'bloqueado',
      motivoBloqueio: motivo,
      bloqueadoEm: admin.firestore.FieldValue.serverTimestamp(),
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    driverProofCache.clear();
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/admin/drivers/:cpf/unblock', assertOwner, async (req, res, next) => {
  try {
    const cpf = onlyDigits(req.params.cpf);
    if (cpf.length !== 11) return res.status(400).json({ error: 'cpf_invalido' });
    const driverRef = db.collection('motoboys').doc(cpf);
    const snap = await driverRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'motoboy_nao_encontrado' });
    await driverRef.set({
      status: 'ativo',
      motivoBloqueio: admin.firestore.FieldValue.delete(),
      desbloqueadoEm: admin.firestore.FieldValue.serverTimestamp(),
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    driverProofCache.clear();
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/admin/car/drivers/:cpf/approve', assertOwner, async (req, res, next) => {
  try {
    const cpf = onlyDigits(req.params.cpf);
    const ref = db.collection('carroMotoristas').doc(cpf);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'cadastro_carro_nao_encontrado' });
    const car = snap.data() || {};
    if (!car.modelo || !car.ano || !car.placa || !car.cor || !validDriverDocument(car.crlvFoto) || !validDriverPhoto(car.fotoCarro)) {
      return res.status(409).json({ error: 'cadastro_carro_incompleto', message: 'Modelo, ano, placa, cor e fotos sao obrigatorios.' });
    }
    await ref.set({
      status: 'aprovado',
      motivoBloqueio: admin.firestore.FieldValue.delete(),
      aprovadoEm: admin.firestore.FieldValue.serverTimestamp(),
      aprovadoPor: 'dono',
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    clearCarDriverCache(cpf);
    adminStateCache = null;
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/admin/car/drivers/:cpf/block', assertOwner, async (req, res, next) => {
  try {
    const cpf = onlyDigits(req.params.cpf);
    const motivo = cleanText(req.body.reason || 'Bloqueado pelo dono', 180);
    const ref = db.collection('carroMotoristas').doc(cpf);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'cadastro_carro_nao_encontrado' });
    await ref.set({
      status: 'bloqueado',
      online: false,
      motivoBloqueio: motivo,
      bloqueadoEm: admin.firestore.FieldValue.serverTimestamp(),
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    clearCarDriverCache(cpf);
    adminStateCache = null;
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/drivers/register', authLimiter, async (req, res, next) => {
  try {
    const password = String(req.body.password || '');
    const cpf = onlyDigits(req.body.cpf);

    if (!isValidDriverPassword(password)) {
      return res.status(401).json({ error: 'senha_incorreta' });
    }
    if (cpf.length !== 11) {
      return res.status(400).json({ error: 'cpf_invalido' });
    }

    const driverRef = db.collection('motoboys').doc(cpf);
    const driverSnap = await driverRef.get();
    const savedDriver = driverSnap.exists ? driverSnap.data() || {} : {};
    const nome = cleanText(req.body.nome || savedDriver.nome, 80);
    const cnh = onlyDigits(req.body.cnh || savedDriver.cnh);
    const telefone = onlyDigits(req.body.telefone || savedDriver.telefone);
    const fotoMotoboy = validDriverPhoto(req.body.fotoMotoboy) || savedDriver.fotoMotoboy || '';
    const motoModelo = cleanText(req.body.motoModelo || savedDriver.motoModelo, 60);
    const motoAno = onlyDigits(req.body.motoAno || savedDriver.motoAno);
    const motoPlaca = cleanText(req.body.motoPlaca || savedDriver.motoPlaca, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const crlvFoto = validDriverDocument(req.body.crlvFoto) || savedDriver.crlvFoto || '';

    if (!nome || cpf.length !== 11 || cnh.length !== 11 || telefone.length < 10 || telefone.length > 11) {
      return res.status(400).json({ error: 'dados_invalidos' });
    }
    if (!motoModelo || !/^(19|20)\d{2}$/.test(motoAno) || motoPlaca.length < 7) {
      return res.status(400).json({
        error: 'dados_moto_invalidos',
        message: 'Preencha modelo, ano e placa da moto para liberar o acesso.'
      });
    }

    if (driverSnap.exists) {
      const driver = driverSnap.data() || {};
      if (driver.status === 'bloqueado') {
        return res.status(403).json({
          error: 'motoboy_bloqueado',
          message: 'Seu cadastro esta bloqueado pelo dono. Fale com o suporte MotoJa.'
        });
      }
      const savedCnh = onlyDigits(driver.cnh);
      const savedPhone = onlyDigits(driver.telefone);
      const savedName = normalizedPersonName(driver.nome);
      const givenName = normalizedPersonName(nome);
      if ((savedCnh && savedCnh !== cnh) || (savedPhone && savedPhone !== telefone) || (savedName && givenName && savedName !== givenName)) {
        return res.status(409).json({
          error: 'cadastro_ja_existe',
          message: 'CPF ja cadastrado com outros dados. Fale com o dono para conferir.'
        });
      }
      if (!driver.fotoMotoboy && !fotoMotoboy) {
        return res.status(400).json({
          error: 'foto_obrigatoria',
          message: 'Envie uma foto do rosto para liberar o acesso do motoboy.'
        });
      }
      if (!driver.crlvFoto && !crlvFoto) {
        return res.status(400).json({
          error: 'crlv_obrigatorio',
          message: 'Envie uma foto do CRLV/documento da moto para liberar o acesso do motoboy.'
        });
      }
    } else if (!fotoMotoboy) {
      return res.status(400).json({
        error: 'foto_obrigatoria',
        message: 'Envie uma foto do rosto para cadastrar o motoboy.'
      });
    } else if (!crlvFoto) {
      return res.status(400).json({
        error: 'crlv_obrigatorio',
        message: 'Envie uma foto do CRLV/documento da moto para cadastrar o motoboy.'
      });
    }

    const newDriver = !driverSnap.exists;
    const driverData = {
      nome,
      cpf,
      cnh,
      telefone,
      motoModelo,
      motoAno,
      motoPlaca,
      status: newDriver ? 'bloqueado' : (savedDriver.status || 'ativo'),
      cidadesAtivas: driverRideCities(savedDriver),
      ultimoAcesso: admin.firestore.FieldValue.serverTimestamp(),
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
    };
    if (newDriver) {
      driverData.motivoBloqueio = 'Cadastro novo aguardando aprovacao do dono';
      driverData.aguardandoAprovacaoEm = admin.firestore.FieldValue.serverTimestamp();
    }
    if (fotoMotoboy) {
      driverData.fotoMotoboy = fotoMotoboy;
      driverData.fotoAtualizadaEm = admin.firestore.FieldValue.serverTimestamp();
    }
    if (crlvFoto) {
      driverData.crlvFoto = crlvFoto;
      driverData.crlvAtualizadoEm = admin.firestore.FieldValue.serverTimestamp();
    }

    await driverRef.set(driverData, { merge: true });

    if (newDriver) {
      driverProofCache.clear();
      return res.status(403).json({
        error: 'motoboy_aguardando_aprovacao',
        message: 'Cadastro recebido. Aguarde o dono conferir seus documentos e liberar seu acesso.'
      });
    }

    return res.json({
      ok: true,
      nome,
      cpf,
      cnh,
      telefone,
      fotoMotoboy,
      motoModelo,
      motoAno,
      motoPlaca,
      crlvFoto,
      cidadesAtivas: driverRideCities(savedDriver)
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/drivers/:cpf/car/status', authLimiter, async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.params.cpf);
    const driver = await getDriverWithProof(driverCpf, req.body);
    const car = await getCarDriverProfile(driverCpf, driver);
    return res.json({ ok: true, carDriver: publicCarDriver(driver, driverCpf, car) });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/drivers/:cpf/car/register', authLimiter, async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.params.cpf);
    const driver = await getDriverWithProof(driverCpf, req.body);
    const previous = await getCarDriverProfile(driverCpf, driver);
    const modelo = cleanText(req.body.modelo, 80);
    const ano = onlyDigits(req.body.ano).slice(0, 4);
    const placa = cleanText(req.body.placa, 8).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const cor = cleanText(req.body.cor, 40);
    const cidadeBase = cleanText(req.body.cidadeBase, 80);
    const fotoCarro = validDriverPhoto(req.body.fotoCarro);
    const crlvFoto = validDriverDocument(req.body.crlvFoto);
    if (!modelo || !/^(19|20)\d{2}$/.test(ano) || placa.length < 7 || !cor || !cidadeBase || !fotoCarro || !crlvFoto) {
      return res.status(400).json({
        error: 'dados_carro_invalidos',
        message: 'Preencha modelo, ano, placa, cor, cidade e envie as fotos do carro e do CRLV.'
      });
    }
    const changed = [modelo, ano, placa, cor, cidadeBase, fotoCarro, crlvFoto]
      .some((value, index) => String(value) !== String([
        previous.modelo, previous.ano, previous.placa, previous.cor,
        previous.cidadeBase, previous.fotoCarro, previous.crlvFoto
      ][index] || ''));
    const status = changed || carDriverStatus(previous) === 'nao_cadastrado'
      ? 'aguardando_aprovacao'
      : carDriverStatus(previous);
    const car = {
      modelo,
      ano,
      placa,
      cor,
      cidadeBase,
      fotoCarro,
      crlvFoto,
      status,
      online: status === 'aprovado' && previous.online === true,
      motoristaCpf: driverCpf,
      motoristaNome: cleanText(driver.nome, 80),
      motoristaTelefone: onlyDigits(driver.telefone).slice(0, 11),
      cadastradoEm: previous.cadastradoEm || admin.firestore.FieldValue.serverTimestamp(),
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
    };
    await db.collection('carroMotoristas').doc(driverCpf).set(car, { merge: true });
    clearCarDriverCache(driverCpf);
    adminStateCache = null;
    sendEvolutionText(OWNER_WHATSAPP, `Nexus CarroJa: ${driver.nome || 'Motorista'} cadastrou o carro ${modelo} ${placa}. Confira e aprove no Painel do Dono.`)
      .catch((error) => console.error('car registration whatsapp failed', error));
    return res.status(201).json({ ok: true, carDriver: publicCarDriver({ ...driver, carro: car }, driverCpf) });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/drivers/:cpf/car/online', authLimiter, async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.params.cpf);
    const driver = await getApprovedCarDriver(driverCpf, req.body);
    const online = req.body.online === true;
    await db.collection('carroMotoristas').doc(driverCpf).set({
      online,
      onlineAtualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    clearCarDriverCache(driverCpf);
    return res.json({ ok: true, online });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/drivers/:cpf/car/jobs', createRideLimiter, async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.params.cpf);
    const driver = await getApprovedCarDriver(driverCpf, req.body);
    const scope = req.body.scope === 'mine' ? 'mine' : 'pending';
    if (scope === 'pending' && driver.carro?.online !== true) {
      return res.json({ ok: true, jobs: [], carDriver: publicCarDriver(driver, driverCpf) });
    }
    let snapshot;
    if (scope === 'mine') {
      snapshot = await db.collection('corridasCarro').where('motoristaCpf', '==', driverCpf).limit(25).get();
    } else {
      snapshot = await db.collection('corridasCarro').where('status', '==', 'pendente').limit(25).get();
    }
    const allowedMine = new Set(['aceita', 'motorista_chegou', 'em_andamento']);
    const jobs = snapshot.docs
      .map((doc) => ({ id: doc.id, ...serializeFirestore(doc.data()) }))
      .filter((job) => scope === 'pending' ? job.status === 'pendente' : allowedMine.has(job.status))
      .sort((a, b) => Number(b.criadaEm?.seconds || 0) - Number(a.criadaEm?.seconds || 0))
      .map((job) => ({
        id: job.id,
        status: job.status,
        origem: job.origemEncontrada || job.origem,
        destino: job.destinoEncontrado || job.destino,
        cidadeOperacao: job.cidadeOperacao || '',
        observacao: job.observacao || '',
        km: Number(job.km || 0),
        valor: money(job.valor),
        motoristaRecebe: money(job.driverAmount || carRideSplit(job.valor).driverAmount),
        tarifaLabel: job.tarifaLabel || '',
        pagamentoModo: job.pagamentoModo || 'pix',
        passageiro: scope === 'mine' ? cleanText(job.passageiroNome, 80) : '',
        passageiroTelefone: scope === 'mine' ? onlyDigits(job.passageiroTelefone).slice(0, 11) : '',
        criadaEm: job.criadaEm || null
      }));
    return res.json({ ok: true, jobs, carDriver: publicCarDriver(driver, driverCpf) });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/drivers/:cpf/cities/status', async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.params.cpf);
    if (driverCpf.length !== 11) return res.status(400).json({ error: 'driverCpf_invalido' });
    const driver = await getDriverWithProof(driverCpf, req.body);
    return res.json({ ok: true, cidadesAtivas: driverRideCities(driver) });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/drivers/:cpf/cities', async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.params.cpf);
    if (driverCpf.length !== 11) return res.status(400).json({ error: 'driverCpf_invalido' });
    await getDriverWithProof(driverCpf, req.body);

    const cidadesAtivas = {
      conchal: true,
      aguai: req.body?.cidadesAtivas?.aguai === true,
      engenheiro_coelho: req.body?.cidadesAtivas?.engenheiro_coelho === true
    };

    await db.collection('motoboys').doc(driverCpf).set({
      cidadesAtivas,
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    driverProofCache.clear();
    return res.json({ ok: true, cidadesAtivas });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/drivers/:cpf/earnings/summary', async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.params.cpf);
    if (driverCpf.length !== 11) return res.status(400).json({ error: 'driverCpf_invalido' });
    await getDriverWithProof(driverCpf, req.body);
    await initializeDriverEarnings(driverCpf);

    const period = ['today', '7days', '30days', 'all'].includes(req.body.period) ? req.body.period : 'today';
    if (period === 'all') {
      const totalSnap = await driverEarningsRef(driverCpf).get();
      return res.json({ ok: true, period, summary: publicDriverEarnings(totalSnap.data()), days: [] });
    }

    const count = period === '30days' ? 30 : period === '7days' ? 7 : 1;
    const dayKeys = Array.from({ length: count }, (_, index) => dateKeySaoPaulo(new Date(Date.now() - index * 86400000))).reverse();
    const snapshots = await db.getAll(...dayKeys.map((day) => driverEarningsDayRef(driverCpf, day)));
    const total = emptyDriverEarnings();
    const days = snapshots.map((snapshot, index) => {
      const raw = snapshot.exists ? snapshot.data() || {} : emptyDriverEarnings();
      mergeDriverEarningsSummary(total, raw);
      return { dia: dayKeys[index], ...publicDriverEarnings(raw) };
    });
    return res.json({ ok: true, period, summary: publicDriverEarnings(total), days });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/drivers/:cpf/earnings/history', async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.params.cpf);
    if (driverCpf.length !== 11) return res.status(400).json({ error: 'driverCpf_invalido' });
    await getDriverWithProof(driverCpf, req.body);
    await initializeDriverEarnings(driverCpf);

    const historyRef = driverEarningsRef(driverCpf).collection('historico');
    let query = historyRef.orderBy('finalizadaEmMs', 'desc');
    const cursor = cleanText(req.body.cursor, 140);
    if (cursor) {
      const cursorSnap = await historyRef.doc(cursor).get();
      if (cursorSnap.exists) query = query.startAfter(cursorSnap);
    }
    const snapshot = await query.limit(21).get();
    const hasMore = snapshot.docs.length > 20;
    const visible = snapshot.docs.slice(0, 20);
    const items = visible.map((docSnap) => {
      const data = docSnap.data() || {};
      return {
        id: docSnap.id,
        tipo: data.tipo === 'entrega' ? 'entrega' : 'corrida',
        titulo: cleanText(data.titulo, 100),
        origem: cleanText(data.origem, 180),
        destino: cleanText(data.destino, 180),
        ganho: money(Number(data.ganhoCentavos || 0) / 100),
        quilometros: Math.round(Number(data.quilometrosMetros || 0) / 10) / 100,
        finalizadaEmMs: Number(data.finalizadaEmMs || 0)
      };
    });
    return res.json({ ok: true, items, nextCursor: hasMore && visible.length ? visible[visible.length - 1].id : '' });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/drivers/:cpf/jobs', async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.params.cpf);
    const kind = req.body.kind === 'deliveries' ? 'deliveries' : 'rides';
    const scope = req.body.scope === 'mine' ? 'mine' : 'pending';
    const collectionName = kind === 'deliveries' ? 'entregas' : 'corridas';
    if (driverCpf.length !== 11) return res.status(400).json({ error: 'driverCpf_invalido' });
    const driver = await getDriverWithProof(driverCpf, req.body);

    const enabledCities = driverRideCities(driver);
    let docs = [];
    if (scope === 'mine') {
      const activeStatuses = kind === 'deliveries' ? ['aceita', 'retirada'] : ['aceita'];
      const snapshots = await Promise.all(activeStatuses.map((status) => (
        db.collection(collectionName)
          .where('motoboyCpf', '==', driverCpf)
          .where('status', '==', status)
          .limit(15)
          .get()
      )));
      docs = snapshots.flatMap((snapshot) => snapshot.docs);
    } else {
      const snapshot = await db.collection(collectionName)
        .where('status', '==', 'pendente')
        .limit(30)
        .get();
      docs = kind === 'rides'
        ? snapshot.docs.filter((docSnap) => enabledCities[rideOperatingCity(docSnap.data())])
        : snapshot.docs;
    }
    const jobs = sortJobs(docs.map((docSnap) => {
      const item = serializeFirestore({ id: docSnap.id, ...docSnap.data() });
      return scope === 'pending' ? publicPendingJob(item) : privateDriverJob(item);
    })).slice(0, 30);
    return res.json({ ok: true, jobs });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/drivers/:cpf/telegram-link', async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.params.cpf);
    if (driverCpf.length !== 11) return res.status(400).json({ error: 'driverCpf_invalido' });
    await getDriverWithProof(driverCpf, req.body);
    const link = String(process.env.TELEGRAM_GROUP_LINK || '').trim();
    if (!/^https:\/\/t\.me\//i.test(link)) {
      return res.status(404).json({
        error: 'telegram_nao_configurado',
        message: 'Grupo do Telegram ainda nao configurado no servidor.'
      });
    }
    return res.json({ ok: true, link });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/companies/:phone/balance', assertCompany, async (req, res, next) => {
  try {
    const companyRef = companyRefFromPhone(req.params.phone);
    if (!companyRef) return res.status(400).json({ error: 'telefone_empresa_invalido' });
    if (companyRef.id !== req.companyId) return res.status(403).json({ error: 'empresa_nao_autorizada' });

    const snap = await companyRef.get();
    const data = snap.exists ? snap.data() : {};
    res.json({ ok: true, telefoneEmpresa: companyRef.id, ...companyBalance(data) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/companies/register', authLimiter, async (req, res, next) => {
  try {
    const empresa = String(req.body.empresa || '').slice(0, 120).trim();
    const responsavel = String(req.body.responsavel || '').slice(0, 120).trim();
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 160);
    const telefoneEmpresa = onlyDigits(req.body.telefoneEmpresa);
    const retirada = String(req.body.retirada || '').slice(0, 300).trim();
    const password = String(req.body.password || '');
    if (!empresa || !responsavel || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || telefoneEmpresa.length < 10 || telefoneEmpresa.length > 11 || password.length < 8) {
      return res.status(400).json({ error: 'dados_empresa_invalidos', message: 'Preencha empresa, responsavel, email, WhatsApp e senha com pelo menos 8 caracteres.' });
    }

    const companyRef = companyRefFromPhone(telefoneEmpresa);
    const existingByPhone = await companyRef.get();
    if (existingByPhone.exists && existingByPhone.data()?.passwordHash) {
      return res.status(409).json({ error: 'empresa_ja_cadastrada', message: 'Esta empresa ja tem conta. Use Entrar ou Esqueci minha senha.' });
    }

    const existingByEmail = await db.collection('empresas').where('email', '==', email).limit(1).get();
    if (!existingByEmail.empty && existingByEmail.docs[0].id !== telefoneEmpresa) {
      return res.status(409).json({ error: 'email_ja_cadastrado', message: 'Este email ja esta cadastrado em outra empresa.' });
    }

    const auth = passwordHash(password);
    const companyData = {
      empresa,
      responsavel,
      email,
      telefoneEmpresa,
      retirada,
      status: 'aguardando_aprovacao',
      passwordSalt: auth.salt,
      passwordHash: auth.hash,
      saldo: admin.firestore.FieldValue.increment(0),
      reservado: admin.firestore.FieldValue.increment(0),
      cadastradaEm: admin.firestore.FieldValue.serverTimestamp(),
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp(),
      ultimoLoginEm: admin.firestore.FieldValue.serverTimestamp()
    };
    await companyRef.set(companyData, { merge: true });
    adminStateCache = null;

    res.status(201).json({
      ok: true,
      pendingApproval: true,
      message: 'Cadastro enviado. Aguarde a aprovação da MotoJÁ para acessar o painel.',
      company: publicCompany({ empresa, responsavel, email, telefoneEmpresa, retirada, status: 'aguardando_aprovacao' }, telefoneEmpresa)
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/companies/login', authLimiter, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 160);
    const password = String(req.body.password || '');
    const snap = await db.collection('empresas').where('email', '==', email).limit(1).get();
    if (snap.empty) {
      passwordHash(password || crypto.randomBytes(12).toString('hex'));
      return res.status(401).json({ error: 'credenciais_empresa_invalidas', message: 'Email ou senha incorretos.' });
    }
    const company = snap.docs[0].data() || {};
    if (!verifyPassword(password, company)) {
      return res.status(401).json({ error: 'credenciais_empresa_invalidas', message: 'Email ou senha incorretos.' });
    }
    const status = companyStatus(company);
    if (status !== 'aprovada') {
      return res.status(403).json({
        error: status === 'bloqueada' ? 'empresa_bloqueada' : 'empresa_aguardando_aprovacao',
        message: status === 'bloqueada'
          ? 'Esta empresa está bloqueada. Fale com o suporte MotoJÁ.'
          : 'Seu cadastro ainda está aguardando aprovação da MotoJÁ.'
      });
    }
    const token = await issueCompanySession(snap.docs[0].ref);
    res.json({ ok: true, token, company: publicCompany(company, snap.docs[0].id) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/companies/logout', assertCompany, async (req, res, next) => {
  try {
    const update = {
      ultimoLogoutEm: admin.firestore.FieldValue.serverTimestamp(),
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    };
    if (req.companySessionHash) {
      update[`companySessions.${req.companySessionHash}`] = admin.firestore.FieldValue.delete();
    } else {
      update.sessionTokenHash = admin.firestore.FieldValue.delete();
      update.sessionIssuedAtMs = admin.firestore.FieldValue.delete();
      update.sessionExpiresAtMs = admin.firestore.FieldValue.delete();
    }
    await req.companySnap.ref.update(update);
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/companies/password-recovery', authLimiter, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 160);
    const telefoneEmpresa = onlyDigits(req.body.telefoneEmpresa);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || telefoneEmpresa.length < 10 || telefoneEmpresa.length > 11) {
      return res.status(400).json({ error: 'dados_recuperacao_invalidos', message: 'Digite o email e o WhatsApp cadastrados da empresa.' });
    }
    const snap = await db.collection('empresas').where('email', '==', email).limit(1).get();
    if (snap.empty) {
      return res.status(202).json({ ok: true, message: 'Se os dados conferirem, o pedido sera enviado ao dono.' });
    }
    const doc = snap.docs[0];
    const company = doc.data() || {};
    if (onlyDigits(company.telefoneEmpresa || doc.id) !== telefoneEmpresa) {
      return res.status(202).json({ ok: true, message: 'Se os dados conferirem, o pedido sera enviado ao dono.' });
    }
    const recoveryRef = db.collection('recuperacoesSenhaEmpresa').doc();
    await recoveryRef.set({
      companyId: doc.id,
      empresa: cleanText(company.empresa || '', 120),
      responsavel: cleanText(company.responsavel || '', 120),
      email,
      telefoneEmpresa,
      status: 'pendente',
      criadaEm: admin.firestore.FieldValue.serverTimestamp(),
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    });
    return res.status(202).json({ ok: true, message: 'Se os dados conferirem, o pedido sera enviado ao dono.' });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/customers/device-status', authLimiter, async (req, res, next) => {
  try {
    const deviceId = validDeviceId(req.body.deviceId);
    const telefoneCliente = onlyDigits(req.body.telefoneCliente).slice(0, 11);
    if (!deviceId) return res.status(400).json({ error: 'aparelho_invalido' });
    const header = String(req.header('authorization') || '');
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const session = await findCustomerSession(token);
    const authenticated = !!(session && customerProfileComplete(session.customer));
    const completedRides = CUSTOMER_REGISTRATION_ENFORCED && !authenticated
      ? await completedCustomerRides(deviceId)
      : 0;
    return res.json({
      ok: true,
      authenticated,
      registrationRequired: CUSTOMER_REGISTRATION_ENFORCED && !authenticated && completedRides >= CUSTOMER_FREE_RIDES,
      completedRides,
      freeRideLimit: CUSTOMER_FREE_RIDES,
      customer: authenticated ? publicCustomer(session.customer, session.customerId) : null
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/customers/otp/request', customerOtpLimiter, async (req, res, next) => {
  try {
    const telefoneCliente = onlyDigits(req.body.telefoneCliente).slice(0, 11);
    const deviceId = validDeviceId(req.body.deviceId);
    if (telefoneCliente.length < 10 || telefoneCliente.length > 11 || !deviceId) {
      return res.status(400).json({ error: 'whatsapp_invalido', message: 'Digite um WhatsApp com DDD.' });
    }
    const code = String(crypto.randomInt(100000, 1000000));
    const otpRef = db.collection('customerOtp').doc(hashSecret(`${telefoneCliente}:${deviceId}`));
    const delivery = await sendEvolutionText(`55${telefoneCliente}`, `Nexus MotoJá: seu código de confirmação é ${code}. Ele vence em 10 minutos. Não compartilhe este código.`);
    if (!delivery.sent) {
      return res.status(503).json({ error: 'whatsapp_otp_indisponivel', message: 'A confirmacao por WhatsApp ainda nao esta disponivel. Fale com o suporte.' });
    }
    await otpRef.set({
      telefoneCliente,
      deviceHash: hashSecret(deviceId),
      codeHash: hashSecret(code),
      expiresAtMs: Date.now() + CUSTOMER_OTP_MS,
      attempts: 0,
      verified: false,
      criadaEm: admin.firestore.FieldValue.serverTimestamp()
    });
    return res.json({ ok: true, message: 'Codigo enviado pelo WhatsApp.' });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/customers/otp/verify', authLimiter, async (req, res, next) => {
  try {
    const telefoneCliente = onlyDigits(req.body.telefoneCliente).slice(0, 11);
    const deviceId = validDeviceId(req.body.deviceId);
    const code = onlyDigits(req.body.code).slice(0, 6);
    if (!deviceId || telefoneCliente.length < 10 || code.length !== 6) {
      return res.status(400).json({ error: 'codigo_invalido', message: 'Digite o codigo de 6 numeros.' });
    }
    const otpRef = db.collection('customerOtp').doc(hashSecret(`${telefoneCliente}:${deviceId}`));
    let verificationToken = '';
    let verificationError = null;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(otpRef);
      const data = snap.data() || {};
      if (!snap.exists || data.expiresAtMs < Date.now() || Number(data.attempts || 0) >= 5) {
        verificationError = { code: 'codigo_expirado', message: 'Código expirado. Solicite um novo.' };
        return;
      }
      if (!safeEqual(hashSecret(code), data.codeHash || '')) {
        tx.set(otpRef, { attempts: admin.firestore.FieldValue.increment(1) }, { merge: true });
        verificationError = { code: 'codigo_incorreto', message: 'Código incorreto. Confira e tente novamente.' };
        return;
      }
      verificationToken = crypto.randomBytes(32).toString('hex');
      tx.set(otpRef, {
        verified: true,
        verificationTokenHash: hashSecret(verificationToken),
        verificationExpiresAtMs: Date.now() + CUSTOMER_VERIFICATION_MS,
        verificadaEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });
    if (verificationError) {
      return res.status(400).json({ error: verificationError.code, message: verificationError.message });
    }
    return res.json({ ok: true, verificationToken });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/customers/register', authLimiter, async (req, res, next) => {
  try {
    const nome = cleanText(req.body.nome, 80);
    const telefoneCliente = onlyDigits(req.body.telefoneCliente).slice(0, 11);
    const cpf = onlyDigits(req.body.cpf);
    const birth = validBirthDate(req.body.dataNascimento);
    const origem = cleanText(req.body.origem, 300);
    const fotoCliente = validDriverPhoto(req.body.fotoCliente);
    const password = String(req.body.password || '');
    const deviceId = validDeviceId(req.body.deviceId);
    const verificationToken = String(req.body.verificationToken || '').trim();
    if (!nome || telefoneCliente.length < 10 || !validCpf(cpf) || !birth || !fotoCliente || password.length < 6 || !deviceId) {
      return res.status(400).json({ error: 'dados_cliente_invalidos', message: 'Preencha nome, CPF valido, nascimento, foto e senha com pelo menos 6 caracteres.' });
    }
    const otpRef = db.collection('customerOtp').doc(hashSecret(`${telefoneCliente}:${deviceId}`));
    const cpfHash = hashSecret(cpf);
    const customerRef = db.collection('clientes').doc(telefoneCliente);
    const cpfRef = db.collection('customerCpf').doc(cpfHash);
    const auth = passwordHash(password);
    const customerData = {
      nome,
      telefoneCliente,
      origem,
      fotoCliente,
      cpfHash,
      cpfEncrypted: encryptSecret(cpf),
      cpfFinal: cpf.slice(-4),
      dataNascimento: birth.text,
      idadeCadastro: birth.age,
      clienteDeviceId: deviceId,
      whatsappVerificadoEm: admin.firestore.FieldValue.serverTimestamp(),
      passwordSalt: auth.salt,
      passwordHash: auth.hash,
      cadastradaEm: admin.firestore.FieldValue.serverTimestamp(),
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    };
    let registrationError = null;
    await db.runTransaction(async (tx) => {
      const [freshOtpSnap, cpfSnap, customerSnap] = await Promise.all([
        tx.get(otpRef),
        tx.get(cpfRef),
        tx.get(customerRef)
      ]);
      const freshOtp = freshOtpSnap.data() || {};
      if (!freshOtpSnap.exists || !freshOtp.verified || freshOtp.verificationExpiresAtMs < Date.now() || !safeEqual(hashSecret(verificationToken), freshOtp.verificationTokenHash || '')) {
        registrationError = { status: 401, code: 'whatsapp_nao_verificado', message: 'Confirme novamente o código enviado pelo WhatsApp.' };
        return;
      }
      const cpfOwnerId = String(cpfSnap.data()?.customerId || '');
      if (cpfSnap.exists && cpfOwnerId !== telefoneCliente) {
        registrationError = { status: 409, code: 'cpf_ja_cadastrado', message: 'Este CPF já possui cadastro. Use a tela de login.' };
        return;
      }
      tx.set(customerRef, customerData, { merge: true });
      tx.set(cpfRef, {
        customerId: telefoneCliente,
        cpfFinal: cpf.slice(-4),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      tx.delete(otpRef);
    });
    if (registrationError) {
      return res.status(registrationError.status).json({ error: registrationError.code, message: registrationError.message });
    }
    const token = await issueCustomerSession(customerRef);
    return res.status(201).json({ ok: true, token, customer: publicCustomer(customerData, telefoneCliente) });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/customers/login', authLimiter, async (req, res, next) => {
  try {
    const cpf = onlyDigits(req.body.cpf);
    const password = String(req.body.password || '');
    const deviceId = validDeviceId(req.body.deviceId);
    if (!validCpf(cpf) || password.length < 6 || !deviceId) {
      return res.status(400).json({ error: 'dados_cliente_invalidos', message: 'Digite CPF e senha.' });
    }
    const snap = await db.collection('clientes').where('cpfHash', '==', hashSecret(cpf)).limit(1).get();
    if (snap.empty || !verifyPassword(password, snap.docs[0].data()) || !customerProfileComplete(snap.docs[0].data())) {
      passwordHash(password || crypto.randomBytes(12).toString('hex'));
      return res.status(401).json({ error: 'credenciais_cliente_invalidas', message: 'CPF ou senha incorretos.' });
    }
    await snap.docs[0].ref.set({ clienteDeviceId: deviceId, atualizadaEm: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    const token = await issueCustomerSession(snap.docs[0].ref);
    return res.json({ ok: true, token, customer: publicCustomer(snap.docs[0].data(), snap.docs[0].id) });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/customers/logout', async (req, res, next) => {
  try {
    const header = String(req.header('authorization') || '');
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const session = await findCustomerSession(token);
    if (session) {
      await session.customerSnap.ref.set({
        sessionTokenHash: admin.firestore.FieldValue.delete(),
        sessionIssuedAtMs: admin.firestore.FieldValue.delete(),
        sessionExpiresAtMs: admin.firestore.FieldValue.delete(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/customers/me', createRideLimiter, async (req, res, next) => {
  try {
    const header = String(req.header('authorization') || '');
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    if (!token) return res.status(401).json({ error: 'cliente_login_obrigatorio' });
    const session = await findCustomerSession(token);
    if (!session) return res.status(401).json({ error: 'sessao_cliente_invalida' });
    const update = {
      nome: cleanText(req.body.nome, 80),
      telefoneCliente: session.customerId,
      origem: cleanText(req.body.origem, 300),
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    };
    const fotoCliente = validDriverPhoto(req.body.fotoCliente);
    if (fotoCliente) update.fotoCliente = fotoCliente;
    if (!update.nome) return res.status(400).json({ error: 'nome_cliente_obrigatorio', message: 'Digite seu nome para salvar o perfil.' });
    await session.customerSnap.ref.set(update, { merge: true });
    res.json({ ok: true, customer: publicCustomer({ ...session.customer, ...update, fotoCliente: fotoCliente || session.customer.fotoCliente }, session.customerId) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/customers/push-token', createRideLimiter, async (req, res, next) => {
  try {
    const telefoneCliente = onlyDigits(req.body.telefoneCliente);
    const token = String(req.body.token || '').trim();
    const nome = cleanText(req.body.nome, 80);
    if (telefoneCliente.length < 10 || telefoneCliente.length > 11 || !token) {
      return res.status(400).json({ error: 'dados_invalidos', message: 'Informe WhatsApp e permita notificacoes.' });
    }

    await db.collection('clientes').doc(telefoneCliente).set({
      nome: nome || 'Cliente MotoJa',
      telefoneCliente,
      fcmTokens: {
        [token]: {
          ativo: true,
          tipo: 'cliente_lembrete',
          horarios: ['06:40', '16:50'],
          userAgent: String(req.body.userAgent || '').slice(0, 300),
          atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
        }
      },
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({ ok: true, horarios: ['06:40', '16:50'] });
  } catch (error) {
    next(error);
  }
});

app.get('/api/customers/me/rides', createRideLimiter, async (req, res, next) => {
  try {
    const header = String(req.header('authorization') || '');
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    if (!token) return res.status(401).json({ error: 'cliente_login_obrigatorio' });
    const session = await findCustomerSession(token);
    if (!session || !customerProfileComplete(session.customer)) return res.status(401).json({ error: 'sessao_cliente_invalida' });

    const telefoneCliente = session.customerId;
    const ridesSnap = await db.collection('corridas')
      .where('telefoneCliente', '==', telefoneCliente)
      .limit(80)
      .get();

    const rides = ridesSnap.docs
      .map((docSnap) => {
        const ride = serializeFirestore({ id: docSnap.id, ...docSnap.data() });
        return {
          id: ride.id,
          status: ride.status || '',
          origem: ride.origemDigitada || ride.origem || '',
          destino: ride.destino || '',
          destinoEncontrado: ride.destinoEncontrado || '',
          km: Number(ride.km || 0),
          valor: Number(ride.valor || 0),
          precoLabel: ride.precoLabel || '',
          motoboy: ride.motoboy || '',
          motoboyFoto: validDriverPhoto(ride.motoboyFoto) || '',
          criadaEm: ride.criadaEm || null,
          aceitaEm: ride.aceitaEm || null,
          finalizadaEm: ride.finalizadaEm || null
        };
      })
      .sort((a, b) => timestampMs(b.criadaEm) - timestampMs(a.criadaEm));

    return res.json({ ok: true, rides });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/car/fare', mapLimiter, async (req, res, next) => {
  try {
    const points = req.body?.points || [];
    const route = await calculateRoute(points);
    const fare = carFare(route.km);
    const quotePayload = {
      points: points.map((point) => ({
        lat: Number(Number(point.lat).toFixed(6)),
        lon: Number(Number(point.lon).toFixed(6))
      })),
      km: route.km,
      period: fare.period,
      rate: fare.rate,
      total: fare.total,
      issuedAtMs: Date.now(),
      expiresAtMs: Date.now() + 10 * 60 * 1000
    };
    return res.json({
      ok: true,
      km: route.km,
      geometry: route.geometry,
      period: fare.period,
      rate: fare.rate,
      total: fare.total,
      label: carFareLabel(fare),
      quoteToken: createCarQuoteToken(quotePayload),
      expiresAtMs: quotePayload.expiresAtMs
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/car/customers/otp/request', customerOtpLimiter, async (req, res, next) => {
  try {
    const telefoneCliente = onlyDigits(req.body.telefoneCliente).slice(0, 11);
    const deviceId = validDeviceId(req.body.deviceId);
    if (telefoneCliente.length < 10 || telefoneCliente.length > 11 || !deviceId) {
      return res.status(400).json({ error: 'whatsapp_invalido', message: 'Digite um WhatsApp com DDD.' });
    }
    const code = String(crypto.randomInt(100000, 1000000));
    const otpRef = db.collection('carroCustomerOtp').doc(hashSecret(`${telefoneCliente}:${deviceId}`));
    const delivery = await sendEvolutionText(`55${telefoneCliente}`, `Nexus CarroJa: seu codigo de confirmacao e ${code}. Ele vence em 10 minutos. Nao compartilhe este codigo.`);
    if (!delivery.sent) {
      return res.status(503).json({ error: 'whatsapp_otp_indisponivel', message: 'A confirmacao pelo WhatsApp esta indisponivel. Fale com o suporte.' });
    }
    await otpRef.set({
      telefoneCliente,
      deviceHash: hashSecret(deviceId),
      codeHash: hashSecret(code),
      expiresAtMs: Date.now() + CUSTOMER_OTP_MS,
      attempts: 0,
      verified: false,
      criadaEm: admin.firestore.FieldValue.serverTimestamp()
    });
    return res.json({ ok: true, message: 'Codigo enviado pelo WhatsApp.' });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/car/customers/otp/verify', authLimiter, async (req, res, next) => {
  try {
    const telefoneCliente = onlyDigits(req.body.telefoneCliente).slice(0, 11);
    const deviceId = validDeviceId(req.body.deviceId);
    const code = onlyDigits(req.body.code).slice(0, 6);
    if (!deviceId || telefoneCliente.length < 10 || code.length !== 6) {
      return res.status(400).json({ error: 'codigo_invalido', message: 'Digite o codigo de 6 numeros.' });
    }
    const otpRef = db.collection('carroCustomerOtp').doc(hashSecret(`${telefoneCliente}:${deviceId}`));
    let verificationToken = '';
    let verificationError = null;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(otpRef);
      const data = snap.data() || {};
      if (!snap.exists || data.expiresAtMs < Date.now() || Number(data.attempts || 0) >= 5) {
        verificationError = { code: 'codigo_expirado', message: 'Codigo expirado. Solicite um novo.' };
        return;
      }
      if (!safeEqual(hashSecret(code), data.codeHash || '')) {
        tx.set(otpRef, { attempts: admin.firestore.FieldValue.increment(1) }, { merge: true });
        verificationError = { code: 'codigo_incorreto', message: 'Codigo incorreto. Confira e tente novamente.' };
        return;
      }
      verificationToken = crypto.randomBytes(32).toString('hex');
      tx.set(otpRef, {
        verified: true,
        verificationTokenHash: hashSecret(verificationToken),
        verificationExpiresAtMs: Date.now() + CUSTOMER_VERIFICATION_MS,
        verificadaEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });
    if (verificationError) return res.status(400).json({ error: verificationError.code, message: verificationError.message });
    return res.json({ ok: true, verificationToken });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/car/customers/register', authLimiter, async (req, res, next) => {
  try {
    const nome = cleanText(req.body.nome, 80);
    const telefoneCliente = onlyDigits(req.body.telefoneCliente).slice(0, 11);
    const cpf = onlyDigits(req.body.cpf);
    const birth = validBirthDate(req.body.dataNascimento);
    const fotoCliente = validDriverPhoto(req.body.fotoCliente);
    const password = String(req.body.password || '');
    const deviceId = validDeviceId(req.body.deviceId);
    const verificationToken = String(req.body.verificationToken || '').trim();
    if (!nome || telefoneCliente.length < 10 || !validCpf(cpf) || !birth || !fotoCliente || password.length < 6 || !deviceId) {
      return res.status(400).json({ error: 'dados_cliente_invalidos', message: 'Preencha nome, CPF valido, nascimento, foto e senha com pelo menos 6 caracteres.' });
    }
    const otpRef = db.collection('carroCustomerOtp').doc(hashSecret(`${telefoneCliente}:${deviceId}`));
    const cpfHash = hashSecret(cpf);
    const customerRef = db.collection('carroClientes').doc(telefoneCliente);
    const cpfRef = db.collection('carroCustomerCpf').doc(cpfHash);
    const auth = passwordHash(password);
    const customerData = {
      nome,
      telefoneCliente,
      fotoCliente,
      cpfHash,
      cpfEncrypted: encryptSecret(cpf),
      cpfFinal: cpf.slice(-4),
      dataNascimento: birth.text,
      idadeCadastro: birth.age,
      clienteDeviceId: deviceId,
      whatsappVerificadoEm: admin.firestore.FieldValue.serverTimestamp(),
      passwordSalt: auth.salt,
      passwordHash: auth.hash,
      status: 'ativo',
      cadastradaEm: admin.firestore.FieldValue.serverTimestamp(),
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    };
    let registrationError = null;
    await db.runTransaction(async (tx) => {
      const [freshOtpSnap, cpfSnap] = await Promise.all([tx.get(otpRef), tx.get(cpfRef)]);
      const freshOtp = freshOtpSnap.data() || {};
      if (!freshOtpSnap.exists || !freshOtp.verified || freshOtp.verificationExpiresAtMs < Date.now() || !safeEqual(hashSecret(verificationToken), freshOtp.verificationTokenHash || '')) {
        registrationError = { status: 401, code: 'whatsapp_nao_verificado', message: 'Confirme novamente o codigo enviado pelo WhatsApp.' };
        return;
      }
      const cpfOwnerId = String(cpfSnap.data()?.customerId || '');
      if (cpfSnap.exists && cpfOwnerId !== telefoneCliente) {
        registrationError = { status: 409, code: 'cpf_ja_cadastrado', message: 'Este CPF ja possui cadastro. Use a tela de login.' };
        return;
      }
      const currentCpfHash = String(customerSnap.data()?.cpfHash || '');
      if (customerSnap.exists && currentCpfHash && currentCpfHash !== cpfHash) {
        registrationError = { status: 409, code: 'telefone_ja_cadastrado', message: 'Este WhatsApp ja possui uma conta. Use a tela de login ou fale com o suporte.' };
        return;
      }
      tx.set(customerRef, customerData, { merge: true });
      tx.set(cpfRef, { customerId: telefoneCliente, cpfFinal: cpf.slice(-4), atualizadaEm: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      tx.delete(otpRef);
    });
    if (registrationError) return res.status(registrationError.status).json({ error: registrationError.code, message: registrationError.message });
    const token = await issueCarCustomerSession(customerRef);
    return res.status(201).json({ ok: true, token, customer: publicCarCustomer(customerData, telefoneCliente) });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/car/customers/login', authLimiter, async (req, res, next) => {
  try {
    const cpf = onlyDigits(req.body.cpf);
    const password = String(req.body.password || '');
    const deviceId = validDeviceId(req.body.deviceId);
    if (!validCpf(cpf) || password.length < 6 || !deviceId) {
      return res.status(400).json({ error: 'dados_cliente_invalidos', message: 'Digite CPF e senha.' });
    }
    const snap = await db.collection('carroClientes').where('cpfHash', '==', hashSecret(cpf)).limit(1).get();
    if (snap.empty || !verifyPassword(password, snap.docs[0].data()) || !carCustomerProfileComplete(snap.docs[0].data())) {
      passwordHash(password || crypto.randomBytes(12).toString('hex'));
      return res.status(401).json({ error: 'credenciais_cliente_invalidas', message: 'CPF ou senha incorretos.' });
    }
    await snap.docs[0].ref.set({ clienteDeviceId: deviceId, atualizadaEm: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    const token = await issueCarCustomerSession(snap.docs[0].ref);
    return res.json({ ok: true, token, customer: publicCarCustomer(snap.docs[0].data(), snap.docs[0].id) });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/car/customers/me', assertCarCustomer, async (req, res) => {
  return res.json({ ok: true, customer: publicCarCustomer(req.carCustomer, req.carCustomerId) });
});

app.post('/api/car/customers/logout', assertCarCustomer, async (req, res, next) => {
  try {
    await req.carCustomerSnap.ref.set({
      sessionTokenHash: admin.firestore.FieldValue.delete(),
      sessionIssuedAtMs: admin.firestore.FieldValue.delete(),
      sessionExpiresAtMs: admin.firestore.FieldValue.delete(),
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/car/rides', assertCarCustomer, createRideLimiter, async (req, res, next) => {
  try {
    const ride = carRidePublicData(req.body);
    const quote = verifyCarQuoteToken(req.body.quoteToken);
    if (!quote || !Array.isArray(quote.points) || quote.points.length < 2) {
      return res.status(400).json({ error: 'cotacao_expirada', message: 'Calcule a rota novamente antes de confirmar.' });
    }
    if (!ride.origem || !ride.destino) {
      return res.status(400).json({ error: 'enderecos_obrigatorios', message: 'Informe local de partida e destino.' });
    }
    const requestedPoints = [
      { lat: ride.origemLat, lon: ride.origemLon },
      { lat: ride.destinoLat, lon: ride.destinoLon }
    ];
    const coordinatesMatch = requestedPoints.every((point, index) => (
      Math.abs(Number(point.lat) - Number(quote.points[index]?.lat)) < 0.000002
      && Math.abs(Number(point.lon) - Number(quote.points[index]?.lon)) < 0.000002
    ));
    if (!coordinatesMatch) {
      return res.status(400).json({ error: 'rota_divergente', message: 'Os pontos mudaram. Calcule a rota novamente.' });
    }
    const requestId = ride.clientRequestId || crypto.randomUUID().replace(/-/g, '');
    const ref = db.collection('corridasCarro').doc(hashSecret(`${req.carCustomerId}:${requestId}`).slice(0, 48));
    const split = carRideSplit(quote.total);
    let created = false;
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      if (existing.exists) return;
      tx.set(ref, {
        ...ride,
        clientRequestId: requestId,
        passageiroId: req.carCustomerId,
        passageiroNome: cleanText(req.carCustomer.nome, 80),
        passageiroTelefone: onlyDigits(req.carCustomer.telefoneCliente || req.carCustomerId).slice(0, 11),
        passageiroFoto: validDriverPhoto(req.carCustomer.fotoCliente) || '',
        km: Number(quote.km),
        valor: money(quote.total),
        tarifaPeriodo: quote.period,
        tarifaPorKm: Number(quote.rate),
        tarifaLabel: carFareLabel(quote),
        ...split,
        status: 'pendente',
        criadaEm: admin.firestore.FieldValue.serverTimestamp(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      });
      created = true;
    });
    if (!created) return res.status(200).json({ ok: true, rideId: ref.id, duplicated: true });
    const push = await notifyCarDriversAboutRide(ref.id, { ...ride, valor: quote.total }).catch((error) => {
      console.error('car driver push failed', error);
      return { sent: 0, failed: 0 };
    });
    adminStateCache = null;
    emitSupportOperationsRefresh();
    return res.status(201).json({ ok: true, rideId: ref.id, push });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/car/rides/:rideId/status', assertCarCustomer, async (req, res, next) => {
  try {
    const snap = await db.collection('corridasCarro').doc(String(req.params.rideId || '')).get();
    if (!snap.exists) return res.status(404).json({ error: 'corrida_carro_nao_encontrada' });
    const ride = snap.data() || {};
    if (String(ride.passageiroId || '') !== req.carCustomerId) return res.status(403).json({ error: 'corrida_nao_pertence_ao_passageiro' });
    return res.json({ ok: true, ride: carRideForCustomer(snap.id, ride) });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/car/customers/me/rides', assertCarCustomer, async (req, res, next) => {
  try {
    const snapshot = await db.collection('corridasCarro').where('passageiroId', '==', req.carCustomerId).limit(60).get();
    const rides = snapshot.docs
      .map((doc) => carRideForCustomer(doc.id, doc.data() || {}))
      .sort((a, b) => b.criadaEmMs - a.criadaEmMs);
    return res.json({ ok: true, rides });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/car/rides/:rideId/cancel', assertCarCustomer, createRideLimiter, async (req, res, next) => {
  try {
    const ref = db.collection('corridasCarro').doc(String(req.params.rideId || ''));
    let cancelledDriverCpf = '';
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        const error = new Error('Corrida nao encontrada.');
        error.status = 404;
        error.code = 'corrida_carro_nao_encontrada';
        throw error;
      }
      const ride = snap.data() || {};
      if (String(ride.passageiroId || '') !== req.carCustomerId) {
        const error = new Error('Esta corrida nao pertence a sua conta.');
        error.status = 403;
        error.code = 'corrida_nao_pertence_ao_passageiro';
        throw error;
      }
      if (ride.status === 'em_andamento' || ride.status === 'finalizada') {
        const error = new Error('Corrida iniciada. Fale com o suporte para cancelar com seguranca.');
        error.status = 409;
        error.code = 'corrida_ja_iniciada';
        throw error;
      }
      if (ride.status === 'cancelada') return;
      const driverCpf = onlyDigits(ride.motoristaCpf);
      cancelledDriverCpf = driverCpf;
      const driverRef = driverCpf.length === 11 ? db.collection('carroMotoristas').doc(driverCpf) : null;
      const driverSnap = driverRef ? await tx.get(driverRef) : null;
      tx.set(ref, {
        status: 'cancelada',
        canceladaPor: 'passageiro',
        motivoCancelamento: cleanText(req.body.reason || 'Cancelada pelo passageiro', 180),
        canceladaEm: admin.firestore.FieldValue.serverTimestamp(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      if (driverRef && driverSnap?.exists) {
        tx.set(driverRef, {
          corridaAtivaId: admin.firestore.FieldValue.delete(),
          corridaAtivaDesde: admin.firestore.FieldValue.delete(),
          atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }
    });
    clearCarDriverCache(cancelledDriverCpf);
    adminStateCache = null;
    emitSupportOperationsRefresh();
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/car/rides/:rideId/accept', createRideLimiter, async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.body.driverCpf);
    const driver = await getApprovedCarDriver(driverCpf, req.body);
    const active = await db.collection('corridasCarro').where('motoristaCpf', '==', driverCpf).limit(20).get();
    if (active.docs.some((doc) => ['aceita', 'motorista_chegou', 'em_andamento'].includes(doc.data()?.status))) {
      return res.status(409).json({ error: 'motorista_ja_tem_corrida', message: 'Finalize sua corrida atual antes de aceitar outra.' });
    }
    const ref = db.collection('corridasCarro').doc(String(req.params.rideId || ''));
    const driverRef = db.collection('carroMotoristas').doc(driverCpf);
    await db.runTransaction(async (tx) => {
      const [snap, freshDriverSnap] = await Promise.all([tx.get(ref), tx.get(driverRef)]);
      if (!snap.exists) {
        const error = new Error('Corrida nao encontrada.');
        error.status = 404;
        error.code = 'corrida_carro_nao_encontrada';
        throw error;
      }
      const ride = snap.data() || {};
      if (ride.status !== 'pendente') {
        const error = new Error('Outro motorista aceitou esta corrida.');
        error.status = 409;
        error.code = 'corrida_carro_indisponivel';
        throw error;
      }
      const freshDriver = freshDriverSnap.data() || {};
      const lockedRideId = String(freshDriver.corridaAtivaId || '');
      if (lockedRideId && lockedRideId !== ref.id) {
        const lockedSnap = await tx.get(db.collection('corridasCarro').doc(lockedRideId));
        if (lockedSnap.exists && ['aceita', 'motorista_chegou', 'em_andamento'].includes(lockedSnap.data()?.status)) {
          const error = new Error('Finalize sua corrida atual antes de aceitar outra.');
          error.status = 409;
          error.code = 'motorista_ja_tem_corrida';
          throw error;
        }
      }
      tx.set(ref, {
        status: 'aceita',
        motorista: cleanText(driver.nome, 80),
        motoristaCpf: driverCpf,
        motoristaTelefone: onlyDigits(driver.telefone).slice(0, 11),
        motoristaFoto: validDriverPhoto(driver.fotoMotoboy) || '',
        carro: {
          modelo: cleanText(driver.carro?.modelo, 80),
          ano: cleanText(driver.carro?.ano, 4),
          placa: cleanText(driver.carro?.placa, 8).toUpperCase(),
          cor: cleanText(driver.carro?.cor, 40),
          fotoCarro: validDriverPhoto(driver.carro?.fotoCarro) || ''
        },
        aceitaEm: admin.firestore.FieldValue.serverTimestamp(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      tx.set(driverRef, {
        corridaAtivaId: ref.id,
        corridaAtivaDesde: admin.firestore.FieldValue.serverTimestamp(),
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });
    clearCarDriverCache(driverCpf);
    adminStateCache = null;
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

async function updateCarRideDriverState(req, res, next, config) {
  try {
    const driverCpf = onlyDigits(req.body.driverCpf);
    await getApprovedCarDriver(driverCpf, req.body);
    const ref = db.collection('corridasCarro').doc(String(req.params.rideId || ''));
    const driverRef = db.collection('carroMotoristas').doc(driverCpf);
    await db.runTransaction(async (tx) => {
      const [snap, driverSnap] = await Promise.all([tx.get(ref), tx.get(driverRef)]);
      if (!snap.exists) {
        const error = new Error('Corrida nao encontrada.');
        error.status = 404;
        error.code = 'corrida_carro_nao_encontrada';
        throw error;
      }
      const ride = snap.data() || {};
      if (onlyDigits(ride.motoristaCpf) !== driverCpf) {
        const error = new Error('Esta corrida nao pertence a este motorista.');
        error.status = 403;
        error.code = 'corrida_nao_pertence_ao_motorista';
        throw error;
      }
      if (!config.from.includes(ride.status)) {
        const error = new Error(config.invalidMessage);
        error.status = 409;
        error.code = 'status_corrida_invalido';
        throw error;
      }
      if (config.recordEarning) {
        const earningEvent = driverEarningEvent('carro', ref.id, ride, Date.now());
        await recordDriverEarning(tx, driverCpf, earningEvent);
      }
      tx.set(ref, {
        status: config.to,
        [config.timestampField]: admin.firestore.FieldValue.serverTimestamp(),
        ...(config.recordEarning ? { ganhoContabilizadoEm: admin.firestore.FieldValue.serverTimestamp() } : {}),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      if (config.recordEarning && driverSnap.exists) {
        tx.set(driverRef, {
          corridaAtivaId: admin.firestore.FieldValue.delete(),
          corridaAtivaDesde: admin.firestore.FieldValue.delete(),
          atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }
    });
    if (config.recordEarning) clearCarDriverCache(driverCpf);
    adminStateCache = null;
    return res.json({ ok: true, status: config.to });
  } catch (error) {
    return next(error);
  }
}

app.post('/api/car/rides/:rideId/arrived', createRideLimiter, (req, res, next) => updateCarRideDriverState(req, res, next, {
  from: ['aceita'], to: 'motorista_chegou', timestampField: 'motoristaChegouEm', invalidMessage: 'A corrida precisa estar aceita.'
}));

app.post('/api/car/rides/:rideId/start', createRideLimiter, (req, res, next) => updateCarRideDriverState(req, res, next, {
  from: ['aceita', 'motorista_chegou'], to: 'em_andamento', timestampField: 'iniciadaEm', invalidMessage: 'A corrida nao pode ser iniciada agora.'
}));

app.post('/api/car/rides/:rideId/finish', createRideLimiter, (req, res, next) => updateCarRideDriverState(req, res, next, {
  from: ['em_andamento'], to: 'finalizada', timestampField: 'finalizadaEm', invalidMessage: 'Inicie a corrida antes de finalizar.', recordEarning: true
}));

app.post('/api/car/rides/:rideId/location', createRideLimiter, async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.body.driverCpf);
    await getApprovedCarDriver(driverCpf, req.body);
    const latitude = Number(req.body.latitude);
    const longitude = Number(req.body.longitude);
    if (!validCoordinate({ lat: latitude, lon: longitude })) return res.status(400).json({ error: 'localizacao_invalida' });
    const ref = db.collection('corridasCarro').doc(String(req.params.rideId || ''));
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'corrida_carro_nao_encontrada' });
    const ride = snap.data() || {};
    if (onlyDigits(ride.motoristaCpf) !== driverCpf || !['aceita', 'motorista_chegou', 'em_andamento'].includes(ride.status)) {
      return res.status(409).json({ error: 'rastreamento_nao_permitido' });
    }
    await ref.set({
      motoristaLocalizacao: {
        latitude,
        longitude,
        accuracy: Math.max(0, Number(req.body.accuracy || 0)),
        clientTimestampMs: Number(req.body.clientTimestampMs || Date.now()),
        serverTimestampMs: Date.now()
      },
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/car/rides/:rideId/driver-cancel', createRideLimiter, async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.body.driverCpf);
    await getApprovedCarDriver(driverCpf, req.body);
    const ref = db.collection('corridasCarro').doc(String(req.params.rideId || ''));
    const driverRef = db.collection('carroMotoristas').doc(driverCpf);
    await db.runTransaction(async (tx) => {
      const [snap, driverSnap] = await Promise.all([tx.get(ref), tx.get(driverRef)]);
      if (!snap.exists) {
        const error = new Error('Corrida nao encontrada.');
        error.status = 404;
        throw error;
      }
      const ride = snap.data() || {};
      if (onlyDigits(ride.motoristaCpf) !== driverCpf) {
        const error = new Error('Esta corrida nao pertence a este motorista.');
        error.status = 403;
        throw error;
      }
      if (ride.status === 'em_andamento') {
        const error = new Error('Corrida iniciada. Fale com o suporte antes de cancelar.');
        error.status = 409;
        throw error;
      }
      if (!['aceita', 'motorista_chegou'].includes(ride.status)) return;
      tx.set(ref, {
        status: 'pendente',
        motorista: '',
        motoristaCpf: '',
        motoristaTelefone: '',
        motoristaFoto: '',
        carro: {},
        aceitaEm: null,
        motoristaChegouEm: null,
        motoristaLocalizacao: admin.firestore.FieldValue.delete(),
        cancelamentosMotorista: admin.firestore.FieldValue.increment(1),
        ultimoCancelamentoMotoristaCpf: driverCpf,
        motivoReabertura: cleanText(req.body.reason || 'Motorista cancelou antes do inicio', 180),
        reabertaEm: admin.firestore.FieldValue.serverTimestamp(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      if (driverSnap.exists) {
        tx.set(driverRef, {
          corridaAtivaId: admin.firestore.FieldValue.delete(),
          corridaAtivaDesde: admin.firestore.FieldValue.delete(),
          atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }
    });
    clearCarDriverCache(driverCpf);
    const rideSnap = await ref.get();
    notifyCarDriversAboutRide(ref.id, rideSnap.data() || {}).catch((error) => console.error('car reopen push failed', error));
    adminStateCache = null;
    return res.json({ ok: true, status: 'pendente' });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/admin/car/rides/:rideId/cancel', assertOwner, async (req, res, next) => {
  try {
    const reason = cleanText(req.body.reason, 250);
    if (!reason) return res.status(400).json({ error: 'motivo_obrigatorio', message: 'Informe o motivo do cancelamento.' });
    const ref = db.collection('corridasCarro').doc(String(req.params.rideId || ''));
    let cancelledDriverCpf = '';
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        const error = new Error('Corrida de carro nao encontrada.');
        error.status = 404;
        throw error;
      }
      const ride = snap.data() || {};
      if (ride.status === 'finalizada') {
        const error = new Error('Corrida ja finalizada.');
        error.status = 409;
        throw error;
      }
      if (ride.status === 'cancelada') return;
      const driverCpf = onlyDigits(ride.motoristaCpf);
      cancelledDriverCpf = driverCpf;
      const driverRef = driverCpf.length === 11 ? db.collection('carroMotoristas').doc(driverCpf) : null;
      const driverSnap = driverRef ? await tx.get(driverRef) : null;
      tx.set(ref, {
        status: 'cancelada',
        canceladaPor: 'dono',
        motivoCancelamento: reason,
        canceladaEm: admin.firestore.FieldValue.serverTimestamp(),
        motoristaLocalizacao: admin.firestore.FieldValue.delete(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      if (driverRef && driverSnap?.exists) {
        tx.set(driverRef, {
          corridaAtivaId: admin.firestore.FieldValue.delete(),
          corridaAtivaDesde: admin.firestore.FieldValue.delete(),
          atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }
    });
    clearCarDriverCache(cancelledDriverCpf);
    adminStateCache = null;
    emitSupportOperationsRefresh();
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/admin/car/rides/:rideId/force-finish', assertOwner, async (req, res, next) => {
  try {
    const reason = cleanText(req.body.reason, 250);
    if (!reason) return res.status(400).json({ error: 'motivo_obrigatorio', message: 'Informe o motivo da finalizacao.' });
    const ref = db.collection('corridasCarro').doc(String(req.params.rideId || ''));
    let finishedDriverCpf = '';
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        const error = new Error('Corrida de carro nao encontrada.');
        error.status = 404;
        throw error;
      }
      const ride = snap.data() || {};
      if (ride.status === 'finalizada') return;
      const driverCpf = onlyDigits(ride.motoristaCpf);
      finishedDriverCpf = driverCpf;
      if (driverCpf.length !== 11 || !['aceita', 'motorista_chegou', 'em_andamento'].includes(ride.status)) {
        const error = new Error('Vincule um motorista e confirme a corrida antes de finalizar.');
        error.status = 409;
        throw error;
      }
      const driverRef = db.collection('carroMotoristas').doc(driverCpf);
      const driverSnap = await tx.get(driverRef);
      const performedAtMs = timestampMs(ride.iniciadaEm) || timestampMs(ride.aceitaEm) || timestampMs(ride.criadaEm) || Date.now();
      const performedAt = admin.firestore.Timestamp.fromMillis(performedAtMs);
      const earningEvent = driverEarningEvent('carro', ref.id, ride, performedAtMs);
      await recordDriverEarning(tx, driverCpf, earningEvent);
      tx.set(ref, {
        status: 'finalizada',
        finalizadaEm: performedAt,
        realizadaEm: performedAt,
        finalizadaPeloDonoEm: admin.firestore.FieldValue.serverTimestamp(),
        motivoFinalizacaoManual: reason,
        ganhoContabilizadoEm: admin.firestore.FieldValue.serverTimestamp(),
        motoristaLocalizacao: admin.firestore.FieldValue.delete(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      if (driverSnap.exists) {
        tx.set(driverRef, {
          corridaAtivaId: admin.firestore.FieldValue.delete(),
          corridaAtivaDesde: admin.firestore.FieldValue.delete(),
          atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }
    });
    clearCarDriverCache(finishedDriverCpf);
    adminStateCache = null;
    emitSupportOperationsRefresh();
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/companies/me', assertCompany, async (req, res) => {
  res.json({ ok: true, company: publicCompany(req.company, req.companyId) });
});

app.get('/api/companies/me/order-integrations', assertCompany, assertCompanyApproved, async (req, res) => {
  const baseUrl = BACKEND_BASE_URL || `${req.protocol}://${req.get('host')}`;
  const integrations = {};
  for (const platform of CAPTURE_PLATFORMS) {
    const config = companyCaptureConfig(req.company, platform);
    integrations[platform] = {
      ...config,
      secretConfigured: !!captureSecretHash(req.company, platform, config.captureMode),
      ingestUrl: `${baseUrl}/api/integrations/orders/${req.companyId}/${platform}`
    };
  }
  res.json({ ok: true, companyId: req.companyId, integrations });
});

app.post('/api/companies/me/order-integrations/:platform', assertCompany, assertCompanyApproved, async (req, res, next) => {
  try {
    const platform = capturePlatform(req.params.platform);
    if (!platform) return res.status(404).json({ error: 'plataforma_invalida' });
    if (platform === 'ifood') {
      return res.status(409).json({ error: 'ifood_em_breve', message: 'iFood esta visivel no painel, mas a captura ainda nao esta liberada.' });
    }
    const captureMode = captureSource(req.body.captureMode, platform);
    if (platform === 'anotaai' && captureMode !== 'whatsapp') {
      return res.status(400).json({ error: 'modo_captura_invalido' });
    }
    const config = {
      active: req.body.active === true,
      autoDispatch: req.body.autoDispatch === true,
      commissionPercent: Math.max(0, Math.min(100, Number(req.body.commissionPercent || 0))),
      deliveryType: cleanText(req.body.deliveryType || 'Lanche / pizza / pastel / marmita', 80),
      captureMode,
      connected: companyCaptureConfig(req.company, platform).connected,
      updatedAtMs: Date.now()
    };
    if (!isPricedDeliveryType(config.deliveryType)) {
      return res.status(400).json({ error: 'tipo_entrega_sem_preco', message: 'Escolha um tipo de entrega com preco definido.' });
    }
    let secret = '';
    const secretField = captureSecretField(platform, captureMode);
    if (req.body.regenerateSecret === true || !captureSecretHash(req.company, platform, captureMode)) {
      secret = crypto.randomBytes(24).toString('hex');
    }
    const update = {
      captureIntegrations: { [platform]: config },
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    };
    if (secret) update.captureSecretHashes = { [secretField]: hashSecret(secret) };
    await req.companySnap.ref.set(update, { merge: true });
    const baseUrl = BACKEND_BASE_URL || `${req.protocol}://${req.get('host')}`;
    return res.json({
      ok: true,
      config,
      ingestUrl: `${baseUrl}/api/integrations/orders/${req.companyId}/${platform}`,
      captureKey: secret || undefined,
      message: secret
        ? 'Configuracao salva. Guarde a chave agora; ela nao sera mostrada novamente.'
        : 'Configuracao salva.'
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/companies/me/order-integrations/anotaai/connect', assertCompany, assertCompanyApproved, async (req, res, next) => {
  try {
    const baseUrl = String(process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
    const apiKey = String(process.env.EVOLUTION_API_KEY || '').trim();
    if (!baseUrl || !apiKey) {
      return res.status(503).json({ error: 'evolution_nao_configurada', message: 'Configure EVOLUTION_API_URL e EVOLUTION_API_KEY no Render antes de gerar o QR Code.' });
    }
    const instanceName = `nexus-${req.companyId}`.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60);
    const captureKey = crypto.randomBytes(24).toString('hex');
    const headers = { 'content-type': 'application/json', apikey: apiKey };
    let createResponse = await fetch(`${baseUrl}/instance/create`, {
      method: 'POST', headers, body: JSON.stringify({ instanceName, qrcode: true, integration: 'WHATSAPP-BAILEYS' })
    });
    let createData = await createResponse.json().catch(() => ({}));
    if (!createResponse.ok && createResponse.status !== 409 && !/already|exist/i.test(JSON.stringify(createData))) {
      return res.status(502).json({ error: 'evolution_instancia_falhou', message: createData.message || 'Nao consegui criar a conexao do WhatsApp.' });
    }
    const backendBase = BACKEND_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const webhookUrl = `${backendBase}/api/integrations/orders/${req.companyId}/anotaai?captureKey=${captureKey}`;
    await fetch(`${baseUrl}/webhook/set/${encodeURIComponent(instanceName)}`, {
      method: 'POST', headers,
      body: JSON.stringify({ webhook: { enabled: true, url: webhookUrl, webhookByEvents: false, events: ['MESSAGES_UPSERT'] } })
    }).catch(() => null);
    if (!createData.qrcode?.base64 && !createData.base64) {
      const connectResponse = await fetch(`${baseUrl}/instance/connect/${encodeURIComponent(instanceName)}`, { headers: { apikey: apiKey } });
      if (connectResponse.ok) createData = await connectResponse.json().catch(() => createData);
    }
    await req.companySnap.ref.set({
      captureIntegrations: {
        anotaai: {
          ...companyCaptureConfig(req.company, 'anotaai'),
          instanceName,
          connected: false,
          captureMode: 'whatsapp',
          updatedAtMs: Date.now()
        }
      },
      captureSecretHashes: { [captureSecretField('anotaai', 'whatsapp')]: hashSecret(captureKey) },
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return res.json({
      ok: true,
      instanceName,
      qrCode: createData.qrcode?.base64 || createData.base64 || createData.qrcode?.code || '',
      pairingCode: createData.qrcode?.pairingCode || createData.pairingCode || '',
      message: 'Escaneie o QR Code com o WhatsApp da loja.'
    });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/companies/me/order-integrations/anotaai/status', assertCompany, assertCompanyApproved, async (req, res, next) => {
  try {
    const config = companyCaptureConfig(req.company, 'anotaai');
    const baseUrl = String(process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
    const apiKey = String(process.env.EVOLUTION_API_KEY || '').trim();
    if (!baseUrl || !apiKey || !config.instanceName) return res.json({ ok: true, connected: false, state: 'disconnected' });
    const response = await fetch(`${baseUrl}/instance/connectionState/${encodeURIComponent(config.instanceName)}`, { headers: { apikey: apiKey } });
    const data = await response.json().catch(() => ({}));
    const state = data.instance?.state || data.state || 'disconnected';
    const connected = state === 'open' || state === 'connected';
    await req.companySnap.ref.set({ captureIntegrations: { anotaai: { connected, updatedAtMs: Date.now() } } }, { merge: true });
    return res.json({ ok: true, connected, state });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/integrations/orders/:companyId/:platform', integrationLimiter, async (req, res, next) => {
  try {
    const companyId = onlyDigits(req.params.companyId);
    const platform = capturePlatform(req.params.platform);
    const companyRef = companyRefFromPhone(companyId);
    if (!companyRef || !platform) return res.status(404).json({ error: 'integracao_nao_encontrada' });
    const companySnap = await companyRef.get();
    if (!companySnap.exists) return res.status(404).json({ error: 'empresa_nao_encontrada' });
    const company = companySnap.data() || {};
    const config = companyCaptureConfig(company, platform);
    const source = captureSource(req.body.source, platform);
    const suppliedKey = String(req.header('x-nexus-capture-key') || req.query.captureKey || '').trim();
    const expectedHash = captureSecretHash(company, platform, source);
    if (!suppliedKey || !expectedHash || !safeEqual(hashSecret(suppliedKey), expectedHash)) {
      return res.status(401).json({ error: 'chave_captura_invalida' });
    }
    if (!config.active) return res.status(409).json({ error: 'integracao_desligada' });
    if (platform === 'beefood' && config.captureMode !== source) {
      return res.status(409).json({ error: 'modo_captura_diferente', message: `A loja esta configurada para captura por ${config.captureMode}.` });
    }
    const evolutionFromMe = req.body.data?.key?.fromMe === true;
    if (platform === 'anotaai' && evolutionFromMe) return res.status(200).json({ ok: true, ignored: true });
    const order = normalizeCapturedOrder(platform, source, req.body);
    const orderRef = captureOrderRef(companyId, order);
    const amounts = capturedOrderAmounts(order, config);
    let duplicated = false;
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(orderRef);
      if (existing.exists) {
        duplicated = true;
        return;
      }
      tx.create(orderRef, {
        ...order,
        ...amounts,
        fingerprint: orderRef.id,
        missing: capturedOrderMissing(order),
        status: 'revisar',
        autoDispatchRequested: config.autoDispatch,
        criadoEm: admin.firestore.FieldValue.serverTimestamp(),
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    if (duplicated) return res.status(200).json({ ok: true, duplicated: true, capturedOrderId: orderRef.id });

    let dispatch = null;
    if (config.autoDispatch && !capturedOrderMissing(order).length) {
      try {
        dispatch = await dispatchCapturedOrder(companyId, company, orderRef, order, config);
      } catch (error) {
        await orderRef.set({
          status: 'revisar',
          reviewReason: cleanText(error.message || 'Falha no envio automatico.', 500),
          atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }
    }
    return res.status(dispatch?.deliveryId ? 201 : 202).json({ ok: true, capturedOrderId: orderRef.id, order, amounts, dispatch });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/companies/me/captured-orders', assertCompany, assertCompanyApproved, async (req, res, next) => {
  try {
    const snapshot = await req.companySnap.ref.collection('pedidosCapturados').limit(80).get();
    const orders = snapshot.docs
      .map((docSnap) => serializeFirestore({ id: docSnap.id, ...docSnap.data() }))
      .sort((a, b) => Number(b.receivedAtMs || 0) - Number(a.receivedAtMs || 0));
    return res.json({ ok: true, orders });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/companies/me/captured-orders/:orderId/dispatch', assertCompany, assertCompanyApproved, createRideLimiter, async (req, res, next) => {
  const orderRef = req.companySnap.ref.collection('pedidosCapturados').doc(String(req.params.orderId || ''));
  try {
    const snapshot = await orderRef.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'pedido_capturado_nao_encontrado' });
    if (snapshot.data().status === 'ignorado') return res.status(409).json({ error: 'pedido_ignorado' });
    const saved = snapshot.data() || {};
    const order = normalizeCapturedOrder(saved.platform, saved.source, { ...saved, ...req.body });
    order.receivedAtMs = Number(saved.receivedAtMs || Date.now());
    const config = companyCaptureConfig(req.company, saved.platform);
    await orderRef.set({ ...order, ...capturedOrderAmounts(order, config), missing: capturedOrderMissing(order), atualizadoEm: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    const dispatch = await dispatchCapturedOrder(req.companyId, req.company, orderRef, order, config);
    return res.json({ ok: true, dispatch });
  } catch (error) {
    await orderRef.set({ status: 'revisar', reviewReason: cleanText(error.message, 500), atualizadoEm: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }).catch(() => null);
    return next(error);
  }
});

app.post('/api/companies/me/captured-orders/:orderId/dismiss', assertCompany, assertCompanyApproved, async (req, res, next) => {
  try {
    const orderRef = req.companySnap.ref.collection('pedidosCapturados').doc(String(req.params.orderId || ''));
    const snapshot = await orderRef.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'pedido_capturado_nao_encontrado' });
    if (snapshot.data().deliveryId) return res.status(409).json({ error: 'pedido_ja_enviado' });
    await orderRef.set({ status: 'ignorado', ignoradoEm: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/companies/me/message-integration', assertCompany, assertCompanyApproved, async (req, res) => {
  const baseUrl = BACKEND_BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.json({
    ok: true,
    active: !!req.company.pedidosMensagemAtivos,
    commissionPercent: Number(req.company.pedidosMensagemTaxaPercentual || 0),
    groupJid: req.company.pedidosMensagemGrupoJid || '',
    webhookConfigured: !!req.company.pedidosMensagemWebhookSecretHash,
    webhookUrl: `${baseUrl}/api/integrations/message-orders/${req.companyId}`
  });
});

app.post('/api/companies/me/message-integration', assertCompany, assertCompanyApproved, async (req, res, next) => {
  try {
    const active = req.body.active === true;
    const commissionPercent = Math.max(0, Math.min(100, Number(req.body.commissionPercent || 0)));
    const groupJidRaw = String(req.body.groupJid || '').trim();
    const groupJid = groupJidRaw && !groupJidRaw.includes('@') ? `${onlyDigits(groupJidRaw)}@g.us` : groupJidRaw;
    if (groupJid && !/^\d{5,30}(?:-\d{5,30})?@g\.us$/.test(groupJid)) {
      return res.status(400).json({ error: 'grupo_whatsapp_invalido', message: 'Informe o ID do grupo do WhatsApp no formato numero@g.us.' });
    }
    if (active && (!groupJid || commissionPercent < 0 || commissionPercent > 100)) {
      return res.status(400).json({ error: 'configuracao_incompleta', message: 'Informe o grupo e uma taxa valida antes de ligar.' });
    }

    let webhookSecret = '';
    const regenerate = req.body.regenerateSecret === true;
    if (regenerate || !req.company.pedidosMensagemWebhookSecretHash) {
      webhookSecret = crypto.randomBytes(24).toString('hex');
    }
    const update = {
      pedidosMensagemAtivos: active,
      pedidosMensagemTaxaPercentual: commissionPercent,
      pedidosMensagemGrupoJid: groupJid,
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    };
    if (webhookSecret) update.pedidosMensagemWebhookSecretHash = hashSecret(webhookSecret);
    await req.companySnap.ref.set(update, { merge: true });
    const baseUrl = BACKEND_BASE_URL || `${req.protocol}://${req.get('host')}`;
    return res.json({
      ok: true,
      active,
      commissionPercent,
      groupJid,
      webhookUrl: `${baseUrl}/api/integrations/message-orders/${req.companyId}`,
      webhookSecret: webhookSecret || undefined,
      message: webhookSecret
        ? 'Integracao salva. Guarde a chave agora; ela nao sera exibida novamente.'
        : 'Integracao salva.'
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/companies/me/message-order/test', assertCompany, assertCompanyApproved, async (req, res, next) => {
  try {
    const order = parseMessageOrder(incomingOrderText(req.body));
    if (!order.valid) {
      return res.status(422).json({ error: 'pedido_nao_reconhecido', message: `Nao encontrei: ${order.missing.join(', ')}.`, order });
    }
    const amounts = orderAmounts(order.total, req.company.pedidosMensagemTaxaPercentual);
    const message = formatMessageOrder(order, amounts, req.company.empresa || 'Empresa');
    const delivery = req.body.send === true
      ? await sendEvolutionGroupMessage(req.company.pedidosMensagemGrupoJid, message)
      : { sent: false, reason: 'somente_teste' };
    return res.json({ ok: true, order, amounts, message, delivery });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/integrations/message-orders/:companyId', integrationLimiter, async (req, res, next) => {
  try {
    const companyId = onlyDigits(req.params.companyId);
    if (companyId.length < 10) return res.status(404).json({ error: 'empresa_nao_encontrada' });
    const companyRef = db.collection('empresas').doc(companyId);
    const companySnap = await companyRef.get();
    if (!companySnap.exists) return res.status(404).json({ error: 'empresa_nao_encontrada' });
    const company = companySnap.data() || {};
    const suppliedSecret = String(req.header('x-motoja-webhook-secret') || '').trim();
    if (!company.pedidosMensagemWebhookSecretHash || !safeEqual(hashSecret(suppliedSecret), company.pedidosMensagemWebhookSecretHash)) {
      return res.status(401).json({ error: 'webhook_nao_autorizado' });
    }
    if (!company.pedidosMensagemAtivos) return res.status(409).json({ error: 'integracao_desligada' });

    const rawText = incomingOrderText(req.body);
    const order = parseMessageOrder(rawText);
    if (!order.valid) {
      return res.status(422).json({ error: 'pedido_nao_reconhecido', message: `Nao encontrei: ${order.missing.join(', ')}.`, order });
    }
    const fingerprint = crypto.createHash('sha256').update(`${companyId}:${normalizeText(rawText)}`).digest('hex');
    const orderRef = companyRef.collection('pedidosMensagem').doc(fingerprint);
    const amounts = orderAmounts(order.total, company.pedidosMensagemTaxaPercentual);
    const message = formatMessageOrder(order, amounts, company.empresa || 'Empresa');
    let duplicated = false;
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(orderRef);
      if (existing.exists) {
        if (existing.data()?.status === 'envio_falhou' || existing.data()?.status === 'aguardando_configuracao_whatsapp') {
          tx.set(orderRef, {
            status: 'processando',
            novaTentativaEm: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        } else {
          duplicated = true;
        }
        return;
      }
      tx.create(orderRef, {
        status: 'processando',
        fingerprint,
        criadoEm: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    if (duplicated) return res.status(200).json({ ok: true, duplicated: true, orderId: orderRef.id });

    let delivery;
    try {
      delivery = await sendEvolutionGroupMessage(company.pedidosMensagemGrupoJid, message);
    } catch (error) {
      await orderRef.set({
        status: 'envio_falhou',
        ultimoErro: cleanText(error.message || error.code || 'envio_falhou', 500),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      throw error;
    }
    await orderRef.set({
      ...order,
      rawText: order.rawText.slice(0, 12000),
      ...amounts,
      formattedMessage: message,
      whatsappSent: delivery.sent,
      whatsappMessageId: delivery.id || '',
      whatsappReason: delivery.reason || '',
      status: delivery.sent ? 'enviado' : 'aguardando_configuracao_whatsapp',
      criadoEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return res.status(201).json({ ok: true, orderId: orderRef.id, order, amounts, delivery });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/companies/me/payment-mode', assertCompany, assertCompanyApproved, async (req, res, next) => {
  try {
    const modo = req.body.modo === 'mercadopago' ? 'mercadopago' : 'pix_manual';
    await req.companySnap.ref.set({
      pagamentoModo: modo,
      pagamentoModoAtualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return res.json({
      ok: true,
      pagamentoModo: modo,
      message: modo === 'mercadopago'
        ? 'Modo Mercado Pago ativado. Depositos pagos pelo checkout entram automaticamente quando aprovados.'
        : 'Modo manual ativado. Depositos continuam por Pix e comprovante.'
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/companies/me/integration', assertCompany, assertCompanyApproved, async (req, res, next) => {
  try {
    const nome = String(req.body.nome || '').slice(0, 80).trim();
    let token = String(req.body.token || '').trim();
    let codigoLoja = cleanText(req.body.codigoLoja || req.body.storeCode || '', 40);
    const tipoEntrega = cleanText(req.body.tipoEntrega || req.body.integrationDeliveryType || '', 80);
    const tokenLines = token.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!codigoLoja && tokenLines.length > 1 && /^\d{3,}$/.test(tokenLines[0])) {
      codigoLoja = tokenLines[0];
      token = tokenLines.slice(1).join('');
    }
    const hasAtivo = Object.prototype.hasOwnProperty.call(req.body || {}, 'ativo');
    const ativo = hasAtivo ? !!req.body.ativo : !!token;
    const encryptedToken = token ? encryptSecret(token) : '';
    const tokenJaSalvo = !!req.company.integracaoTokenEncrypted;

    const balance = companyBalance(req.company || {});
    if (ativo && balance.disponivel < MIN_INTEGRATION_BALANCE) {
      return res.status(400).json({
        error: 'saldo_insuficiente',
        message: `Saldo insuficiente (R$ ${balance.disponivel.toFixed(2).replace('.', ',')}). Para ativar o modo automatico e necessario ter no minimo R$ 6,50 de saldo disponivel. Adicione saldo no Financeiro primeiro.`
      });
    }

    if (ativo && !tipoEntrega && !req.company.integracaoTipoEntrega) {
      return res.status(400).json({
        error: 'integration_delivery_type_required',
        message: 'Selecione o tipo de entrega antes de ligar o automatico.'
      });
    }

    if (ativo && !encryptedToken && !tokenJaSalvo) {
      return res.status(400).json({
        error: 'integration_token_required',
        message: 'Cole a chave/API da empresa e salve antes de ligar o modo automatico.'
      });
    }

    const update = {
      integracaoNome: nome || 'Painel de integracao',
      integracaoCodigoLoja: codigoLoja || req.company.integracaoCodigoLoja || '',
      integracaoTipoEntrega: tipoEntrega || req.company.integracaoTipoEntrega || '',
      integracaoAtiva: ativo,
      integracaoProtegida: !!(encryptedToken || tokenJaSalvo),
      integracaoAtualizadaEm: admin.firestore.FieldValue.serverTimestamp(),
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    };

    if (encryptedToken) {
      update.integracaoTokenHash = hashSecret(token);
      update.integracaoTokenEncrypted = encryptedToken;
    }

    await req.companySnap.ref.set(update, { merge: true });

    // Refresh in-memory cache when integration settings change
    if (ativo && balance.disponivel >= MIN_INTEGRATION_BALANCE) {
      // Use encryptedToken if a new one was provided, otherwise try existing
      const tokenToDecrypt = encryptedToken || req.company.integracaoTokenEncrypted || '';
      const apiKey = decryptSecretSafe(tokenToDecrypt);
      if (apiKey) {
        cardapioWebActiveCompanies.set(req.companyId, {
          apiKey,
          storeCode: req.body.codigoLoja || req.company.integracaoCodigoLoja || '',
          tipoEntrega: req.body.tipoEntrega || req.company.integracaoTipoEntrega || 'Lanche / pizza / pastel / marmita',
          empresa: req.company.empresa || '',
          retirada: req.company.retirada || '',
          cidade: req.company.cidade || 'Conchal',
          companyData: req.company
        });
        if (!cardapioWebSeenOrders.has(req.companyId)) cardapioWebSeenOrders.set(req.companyId, new Set());
        if (!cardapioWebPendingOrders.has(req.companyId)) cardapioWebPendingOrders.set(req.companyId, new Map());
      }
    } else {
      cardapioWebActiveCompanies.delete(req.companyId);
    }

    res.json({ ok: true, integracaoAtiva: ativo, integracaoProtegida: !!(encryptedToken || tokenJaSalvo), integracaoTipoEntrega: tipoEntrega || req.company.integracaoTipoEntrega || '' });
  } catch (error) {
    next(error);
  }
});

function cardapioWebBaseUrl() {
  return String(process.env.CARDAPIOWEB_API_BASE_URL || 'https://integracao.cardapioweb.com/api/partner/v1').replace(/\/$/, '');
}

async function notifyCarDriversAboutRide(rideId, ride) {
  const profiles = await db.collection('carroMotoristas')
    .where('status', '==', 'aprovado')
    .select('online')
    .get();
  const onlineCpfs = profiles.docs
    .filter((doc) => doc.data()?.online === true)
    .map((doc) => doc.id)
    .slice(0, 500);
  const drivers = await Promise.all(onlineCpfs.map((cpf) => db.collection('motoboys').doc(cpf).get()));
  const tokens = [];

  drivers.forEach((doc) => {
    if (!doc.exists) return;
    const data = doc.data() || {};
    if (String(data.status || '') !== 'ativo') return;
    const saved = data.fcmTokens || {};
    Object.entries(saved).forEach(([token, info]) => {
      if (info?.ativo !== false) tokens.push(token);
    });
  });

  if (!tokens.length) return { sent: 0, failed: 0 };
  const response = await admin.messaging().sendEachForMulticast({
    tokens: [...new Set(tokens)].slice(0, 500),
    notification: {
      title: 'Nova corrida Nexus CarroJa',
      body: `${ride.cidadeOperacao || 'Nova chamada'} - ${money(ride.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`
    },
    webpush: {
      headers: { Urgency: 'high' },
      fcmOptions: { link: appUrl('/motoboy.html?aba=carros') },
      notification: {
        icon: appUrl('/nexus-motoja-icon-192.png'),
        badge: appUrl('/nexus-motoja-icon-192.png'),
        tag: `carroja_${rideId}`,
        renotify: true,
        requireInteraction: true,
        vibrate: [220, 90, 220, 90, 320]
      }
    },
    data: { rideId, tipo: 'nova_corrida_carro' }
  });
  return { sent: response.successCount, failed: response.failureCount };
}

function rideTrackingHtml(rideId, item = {}, nonce = '') {
  const safeRideId = String(rideId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
  const name = escapeHtml(cleanText(item.motoboy || 'Motoboy Nexus MotoJa', 80));
  const photo = validDriverPhoto(item.motoboyFoto) || '';
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Acompanhar corrida</title><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#090911;color:#fff;font-family:system-ui,sans-serif;padding:18px}.card{width:min(100%,520px);margin:auto;padding:20px;border-radius:18px;background:#11121c;border:1px solid rgba(255,154,0,.34);box-shadow:0 20px 60px rgba(0,0,0,.42)}header{display:flex;align-items:center;gap:14px}img,.empty{width:72px;height:72px;border-radius:50%;object-fit:cover;border:3px solid #ff9a00;background:#1b1b27}.empty{display:grid;place-items:center;color:#ff9a00;font-size:24px;font-weight:900}small{color:#ff9a00;font-weight:900;text-transform:uppercase}h1{font-size:22px;margin:4px 0}p{color:#c8c8d6;margin:6px 0}.status{margin:18px 0 12px;padding:13px;border-radius:10px;background:rgba(255,154,0,.11);border:1px solid rgba(255,154,0,.28);color:#fff;font-weight:700}.map{display:none;width:100%;height:330px;border-radius:12px;background:#191923;overflow:hidden}.map.show{display:block}.updated{font-size:13px;text-align:center;margin-top:10px}.done{color:#bfffd2}.leaflet-container img{max-width:none!important;max-height:none!important}</style></head><body><main class="card"><header>${photo ? `<img src="${escapeHtml(photo)}" alt="Foto do motoboy">` : '<div class="empty">MJ</div>'}<div><small>Nexus MotoJa</small><h1>${name}</h1><p>Seu motoboy nesta corrida</p></div></header><div id="status" class="status">Aguardando o motoboy iniciar o GPS...</div><div id="map" class="map" aria-label="Localizacao do motoboy"></div><p id="updated" class="updated">Esta pagina atualiza automaticamente.</p></main><script nonce="${escapeHtml(nonce)}" src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><script nonce="${escapeHtml(nonce)}">const rideId=${JSON.stringify(safeRideId)};let map,marker,last='';const statusEl=document.getElementById('status'),mapEl=document.getElementById('map'),updatedEl=document.getElementById('updated');function showMap(lat,lon){mapEl.classList.add('show');if(!map){map=L.map(mapEl).setView([lat,lon],16);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(map);marker=L.marker([lat,lon]).addTo(map).bindPopup('Seu motoboy');new ResizeObserver(()=>map.invalidateSize()).observe(mapEl);}else{marker.setLatLng([lat,lon]);map.panTo([lat,lon]);}requestAnimationFrame(()=>map.invalidateSize());setTimeout(()=>map.invalidateSize(),180);}async function refresh(){try{const r=await fetch('/api/rides/'+encodeURIComponent(rideId)+'/status',{cache:'no-store'}),d=await r.json();if(!r.ok)return;if(d.status==='finalizada'){statusEl.textContent='Corrida finalizada.';statusEl.classList.add('done');return;}if(d.status==='cancelada'){statusEl.textContent='Corrida cancelada.';return;}const p=d.motoboyLocalizacao;if(p&&Number.isFinite(Number(p.latitude))&&Number.isFinite(Number(p.longitude))){const key=Number(p.latitude).toFixed(5)+','+Number(p.longitude).toFixed(5);if(key!==last){showMap(Number(p.latitude),Number(p.longitude));last=key;}statusEl.textContent='Motoboy a caminho - localizacao ao vivo';const age=Math.max(0,Math.round((Date.now()-Number(p.serverTimestampMs||Date.now()))/1000));updatedEl.textContent=age<15?'Localizacao atualizada agora':'Atualizada ha '+age+' segundos';}else{statusEl.textContent=d.clienteAvisado?'GPS iniciado. Aguardando a primeira localizacao...':'Aguardando o motoboy iniciar o GPS...';}}catch(_){updatedEl.textContent='Reconectando ao acompanhamento...';}}refresh();setInterval(refresh,8000);</script></body></html>`;
}

function cardapioWebHeaders(apiKey, storeCode = '') {
  const headers = {
    accept: 'application/json',
    'X-API-KEY': apiKey
  };
  if (storeCode) {
    headers['X-PARTNER-KEY'] = storeCode;
    headers['X-STORE-CODE'] = storeCode;
  }
  return headers;
}

function joinAddress(parts = []) {
  return parts.map((item) => cleanText(item, 120)).filter(Boolean).join(', ');
}

function pickFirst(...values) {
  return values.find((value) => String(value || '').trim()) || '';
}

const CARDAPIO_WEB_NEW_ORDER_STATUSES = new Set([
  'waiting_confirmation',
  'pending_confirmation',
  'awaiting_confirmation',
  'pending',
  'new',
  'novo',
  'pendente'
]);

function cardapioWebOrderStatus(order = {}) {
  return normalizeText(pickFirst(
    order.status,
    order.order_status,
    order.orderStatus,
    order.state
  )).replace(/[\s-]+/g, '_');
}

function isNewCardapioWebOrder(order = {}) {
  return CARDAPIO_WEB_NEW_ORDER_STATUSES.has(cardapioWebOrderStatus(order));
}

function normalizeCardapioWebOrder(order = {}, company = {}) {
  const customer = order.customer || order.client || order.consumer || {};
  const delivery = order.delivery || order.delivery_address || order.address || order.shipping || {};
  const address = delivery.address || delivery;
  const street = pickFirst(address.street, address.street_name, address.route, address.public_place);
  const number = pickFirst(address.number, address.street_number, address.house_number);
  const neighborhood = pickFirst(address.neighborhood, address.district, address.area);
  const city = pickFirst(address.city, address.city_name, company.cidade || 'Conchal');
  const state = pickFirst(address.state, address.uf, 'SP');
  const complement = pickFirst(address.complement, address.reference, address.landmark);
  const enderecoEntrega = pickFirst(
    order.delivery_address_text,
    order.deliveryAddress,
    delivery.formatted,
    delivery.full_address,
    joinAddress([street && number ? `${street}, ${number}` : street, neighborhood, `${city} - ${state}`])
  );
  const items = Array.isArray(order.items) ? order.items : Array.isArray(order.cart) ? order.cart : [];
  const recebidoEm = pickFirst(order.created_at, order.createdAt, order.created, order.date, order.updated_at, new Date().toISOString());
  const recebidoEmMs = externalOrderMs(recebidoEm);
  return {
    externalId: String(order.id || order.order_id || order.uuid || order.code || '').slice(0, 80),
    status: cardapioWebOrderStatus(order).slice(0, 60),
    origem: 'Cardapio Web',
    empresa: company.empresa || 'Empresa',
    cliente: cleanText(pickFirst(customer.name, customer.nome, order.customer_name, order.client_name, 'Cliente Cardapio Web'), 120),
    telefoneCliente: onlyDigits(pickFirst(customer.phone, customer.phone_number, customer.whatsapp, order.customer_phone, order.phone)).slice(0, 13),
    enderecoEntrega: cleanText(enderecoEntrega, 300),
    complemento: cleanText(complement, 160),
    itens: items.slice(0, 20).map((item) => ({
      nome: cleanText(pickFirst(item.name, item.item_name, item.product_name, item.description, 'Item'), 120),
      quantidade: Number(item.quantity || item.amount || item.qty || 1)
    })),
    valorPedido: money(order.total || order.total_price || order.total_amount || order.amount || 0),
    recebidoEm,
    recebidoEmMs,
    recebidoDia: recebidoEmMs ? dateKeySaoPaulo(new Date(recebidoEmMs)) : ''
  };
}

async function alreadyImportedIntegrationOrder(companyId, origem, externalId) {
  if (!externalId) return false;
  const doc = await db.collection('empresas')
    .doc(companyId)
    .collection('integracaoPedidos')
    .doc(externalOrderDocId(origem, externalId))
    .get();
  return doc.exists;
}

function integrationPendingRef(companyId, origem, externalId) {
  return db.collection('empresas')
    .doc(companyId)
    .collection('integracaoPedidosDisponiveis')
    .doc(externalOrderDocId(origem, externalId));
}

async function fetchCardapioWebLatestOrder(apiKey, storeCode, company, companyId) {
  const base = cardapioWebBaseUrl();
  const ordersUrl = `${base}/orders?${new URLSearchParams({ status: 'waiting_confirmation' }).toString()}`;
  const response = await fetch(ordersUrl, { headers: cardapioWebHeaders(apiKey, storeCode) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || data.error || `Cardapio Web respondeu HTTP ${response.status}. Confira token, codigo da loja e URL base.`);
    error.status = 502;
    throw error;
  }
  const orders = Array.isArray(data) ? data : Array.isArray(data.orders) ? data.orders : Array.isArray(data.data) ? data.data : [];
  if (!orders.length) {
    const error = new Error('Conectou na Cardapio Web, mas nao encontrei pedido recente para importar.');
    error.status = 404;
    throw error;
  }
  const today = dateKeySaoPaulo();
  let sawOld = false;
  let sawImported = false;
  let sawNotNew = false;
  const availableOrders = [];
  for (const candidate of orders.slice(0, 30)) {
    const orderId = candidate.id || candidate.order_id || candidate.uuid || candidate.code;
    let fullOrder = candidate;
    if (orderId) {
      const detail = await fetch(`${base}/orders/${encodeURIComponent(orderId)}`, { headers: cardapioWebHeaders(apiKey, storeCode) });
      if (detail.ok) {
        const detailData = await detail.json().catch(() => ({}));
        fullOrder = { ...candidate, ...(detailData && typeof detailData === 'object' ? detailData : {}) };
      }
    }
    const preview = normalizeCardapioWebOrder(fullOrder, company);
    if (!preview.externalId) continue;
    if (!isNewCardapioWebOrder(fullOrder)) {
      sawNotNew = true;
      continue;
    }
    if (!preview.recebidoEmMs || preview.recebidoDia !== today) {
      sawOld = true;
      continue;
    }
    if (await alreadyImportedIntegrationOrder(companyId, preview.origem, preview.externalId)) {
      sawImported = true;
      continue;
    }
    availableOrders.push(preview);
    if (availableOrders.length >= 10) break;
  }
  if (availableOrders.length) return availableOrders;
  const error = new Error(sawNotNew
    ? 'A Cardapio Web nao retornou pedido novo aguardando confirmacao. Pedidos em preparo, entregues, concluidos ou cancelados foram ignorados.'
    : sawImported
      ? 'Os pedidos novos encontrados na Cardapio Web ja foram enviados para os motoboys.'
      : sawOld
        ? 'A Cardapio Web retornou pedido antigo. Por seguranca, o MotoJa so importa pedidos novos de hoje.'
        : 'Conectou na Cardapio Web, mas nao encontrei pedido novo aguardando confirmacao.');
  error.status = 404;
  throw error;
}

app.post('/api/companies/me/integration/test', assertCompany, assertCompanyApproved, async (req, res, next) => {
  try {
    if (!req.company.integracaoTokenEncrypted) {
      return res.status(400).json({
        error: 'integration_token_missing',
        message: 'Nenhuma chave/API salva. Cole a chave da integracao, salve e teste novamente.'
      });
    }

    const company = publicCompany(req.company, req.companyId);
    const apiKey = decryptSecret(req.company.integracaoTokenEncrypted);
    const orderPreviews = await fetchCardapioWebLatestOrder(apiKey, req.company.integracaoCodigoLoja || '', company, req.companyId);
    const orderPreview = orderPreviews[0] || {};

    await req.companySnap.ref.set({
      ultimoTesteIntegracaoEm: admin.firestore.FieldValue.serverTimestamp(),
      ultimoTesteIntegracaoStatus: 'ok',
      ultimoTesteIntegracaoPedido: orderPreview.externalId || '',
      ultimoTesteIntegracaoQuantidade: orderPreviews.length,
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    const validUntilMs = Date.now() + 15 * 60 * 1000;
    const batch = db.batch();
    orderPreviews.forEach((order) => {
      batch.set(integrationPendingRef(req.companyId, order.origem, order.externalId), {
        origem: order.origem,
        pedidoId: order.externalId,
        recebidoEm: order.recebidoEm || '',
        recebidoEmMs: order.recebidoEmMs || 0,
        recebidoDia: order.recebidoDia || '',
        enderecoEntrega: order.enderecoEntrega || '',
        cliente: order.cliente || '',
        telefoneCliente: order.telefoneCliente || '',
        valorPedido: order.valorPedido || 0,
        validUntilMs,
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });
    await batch.commit();

    res.json({
      ok: true,
      mode: 'test_only',
      integracaoAtiva: !!req.company.integracaoAtiva,
      message: orderPreviews.length === 1
        ? '1 pedido novo aguardando confirmacao encontrado na Cardapio Web.'
        : `${orderPreviews.length} pedidos novos aguardando confirmacao encontrados na Cardapio Web.`,
      orderPreview,
      orderPreviews,
      totalPedidos: orderPreviews.length
    });
  } catch (error) {
    await req.companySnap.ref.set({
      ultimoTesteIntegracaoEm: admin.firestore.FieldValue.serverTimestamp(),
      ultimoTesteIntegracaoStatus: 'erro',
      ultimoTesteIntegracaoErro: String(error.message || 'erro').slice(0, 300),
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true }).catch(() => {});
    next(error);
  }
});

// ── Cardápio Web: Automatic Polling System (in-memory, Firebase-friendly) ──

async function cardapioWebRefreshActiveCompanies() {
  try {
    const snapshot = await db.collection('empresas')
      .where('integracaoAtiva', '==', true)
      .where('integracaoTokenEncrypted', '!=', '')
      .select('integracaoTokenEncrypted', 'integracaoCodigoLoja', 'integracaoTipoEntrega', 'empresa', 'retirada', 'cidade', 'status', 'saldo', 'reservado')
      .get();
    const found = new Set();
    snapshot.docs.forEach((doc) => {
      const data = doc.data() || {};
      if (companyStatus(data) !== 'aprovada') return;
      const balance = companyBalance(data);
      if (balance.disponivel < MIN_INTEGRATION_BALANCE) return;
      const apiKey = decryptSecretSafe(data.integracaoTokenEncrypted);
      if (!apiKey) return;
      found.add(doc.id);
      cardapioWebActiveCompanies.set(doc.id, {
        apiKey,
        storeCode: data.integracaoCodigoLoja || '',
        tipoEntrega: data.integracaoTipoEntrega || 'Lanche / pizza / pastel / marmita',
        empresa: data.empresa || '',
        retirada: data.retirada || '',
        cidade: data.cidade || 'Conchal',
        companyData: data
      });
      if (!cardapioWebSeenOrders.has(doc.id)) cardapioWebSeenOrders.set(doc.id, new Set());
      if (!cardapioWebPendingOrders.has(doc.id)) cardapioWebPendingOrders.set(doc.id, new Map());
    });
    // Remove companies that are no longer active
    for (const companyId of cardapioWebActiveCompanies.keys()) {
      if (!found.has(companyId)) {
        cardapioWebActiveCompanies.delete(companyId);
        cardapioWebSeenOrders.delete(companyId);
        cardapioWebPendingOrders.delete(companyId);
      }
    }
    cardapioWebLastCompanyRefresh = Date.now();
    console.log(`[cardapioweb] ${cardapioWebActiveCompanies.size} empresa(s) ativa(s) carregada(s).`);
  } catch (error) {
    console.error('[cardapioweb] erro ao carregar empresas ativas:', error.message);
  }
}

function cardapioWebClearMidnight() {
  const today = dateKeySaoPaulo();
  for (const [companyId, seen] of cardapioWebSeenOrders.entries()) {
    // Keep a tag of the day; if day changed, clear seen orders
    if (seen._day && seen._day !== today) {
      seen.clear();
      cardapioWebPendingOrders.get(companyId)?.clear();
    }
    seen._day = today;
  }
}

async function cardapioWebPollSingleCompany(companyId, config) {
  try {
    const base = cardapioWebBaseUrl();
    const ordersUrl = `${base}/orders?${new URLSearchParams({ status: 'waiting_confirmation' }).toString()}`;
    const response = await fetch(ordersUrl, { headers: cardapioWebHeaders(config.apiKey, config.storeCode) });
    if (!response.ok) {
      console.error(`[cardapioweb] ${config.empresa || companyId}: API HTTP ${response.status}`);
      return;
    }
    const data = await response.json().catch(() => ({}));
    const orders = Array.isArray(data) ? data : Array.isArray(data.orders) ? data.orders : Array.isArray(data.data) ? data.data : [];
    if (!orders.length) return;

    const today = dateKeySaoPaulo();
    const seen = cardapioWebSeenOrders.get(companyId) || new Set();
    const pending = cardapioWebPendingOrders.get(companyId) || new Map();
    let newCount = 0;

    for (const candidate of orders.slice(0, 15)) {
      const orderId = candidate.id || candidate.order_id || candidate.uuid || candidate.code;
      if (!orderId) continue;
      const externalIdStr = String(orderId).slice(0, 80);

      // Already seen in memory? Skip (ZERO Firebase cost)
      if (seen.has(externalIdStr)) continue;

      // Not a new order? Skip
      if (!isNewCardapioWebOrder(candidate)) {
        seen.add(externalIdStr);
        continue;
      }

      // Fetch full order details
      let fullOrder = candidate;
      try {
        const detail = await fetch(`${base}/orders/${encodeURIComponent(orderId)}`, { headers: cardapioWebHeaders(config.apiKey, config.storeCode) });
        if (detail.ok) {
          const detailData = await detail.json().catch(() => ({}));
          fullOrder = { ...candidate, ...(detailData && typeof detailData === 'object' ? detailData : {}) };
        }
      } catch {}

      const preview = normalizeCardapioWebOrder(fullOrder, { empresa: config.empresa, cidade: config.cidade });
      if (!preview.externalId) continue;

      // Only today's orders
      if (!preview.recebidoEmMs || preview.recebidoDia !== today) {
        seen.add(externalIdStr);
        continue;
      }

      // Mark as seen in memory
      seen.add(externalIdStr);

      // Add to pending orders (in memory)
      pending.set(externalIdStr, {
        ...preview,
        receivedAtMs: Date.now(),
        companyId
      });
      newCount++;
    }

    if (newCount > 0) {
      console.log(`[cardapioweb] ${config.empresa || companyId}: ${newCount} pedido(s) novo(s) encontrado(s).`);
      // Notify frontend via Socket.IO
      io.to(`company:${companyId}`).emit('cardapioweb:new-orders', {
        orders: Array.from(pending.values()),
        total: pending.size,
        at: Date.now()
      });
    }
  } catch (error) {
    console.error(`[cardapioweb] ${config.empresa || companyId}: erro no polling:`, error.message);
  }
}

async function cardapioWebPollAll() {
  // Refresh company list every 5 minutes (1 Firebase read)
  if (Date.now() - cardapioWebLastCompanyRefresh > CARDAPIO_WEB_COMPANIES_REFRESH_MS) {
    await cardapioWebRefreshActiveCompanies();
  }
  // Clear seen orders at midnight (São Paulo time)
  cardapioWebClearMidnight();

  // Poll each active company (API calls only, zero Firebase)
  for (const [companyId, config] of cardapioWebActiveCompanies.entries()) {
    await cardapioWebPollSingleCompany(companyId, config);
    // Small delay between companies to respect rate limits
    if (cardapioWebActiveCompanies.size > 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

// ── Endpoint: Get pending orders from in-memory (ZERO Firebase reads) ──
app.get('/api/companies/me/integration/pending-orders', assertCompany, assertCompanyApproved, (req, res) => {
  const pending = cardapioWebPendingOrders.get(req.companyId);
  const orders = pending ? Array.from(pending.values()) : [];
  res.json({ ok: true, orders, total: orders.length });
});

// ── Endpoint: Accept and dispatch a pending order ──
app.post('/api/companies/me/integration/pending-orders/:orderId/accept', assertCompany, assertCompanyApproved, async (req, res, next) => {
  try {
    const orderId = String(req.params.orderId || '').slice(0, 80);
    const pending = cardapioWebPendingOrders.get(req.companyId);
    const order = pending?.get(orderId);
    if (!order) {
      return res.status(404).json({ error: 'pedido_nao_encontrado', message: 'Pedido nao encontrado ou ja foi aceito.' });
    }

    const balance = companyBalance(req.company || {});
    if (balance.disponivel < MIN_INTEGRATION_BALANCE) {
      return res.status(402).json({
        error: 'saldo_insuficiente',
        message: `Saldo insuficiente (R$ ${balance.disponivel.toFixed(2).replace('.', ',')}). E necessario ter no minimo R$ 6,50 de saldo para liberar e chamar motoboy. Adicione saldo no Financeiro.`
      });
    }

    // Mark as imported in Firebase (1 write — the ONLY Firebase cost per order)
    const docId = externalOrderDocId(order.origem || 'Cardapio Web', orderId);
    await db.collection('empresas').doc(req.companyId).collection('integracaoPedidos').doc(docId).set({
      origem: order.origem || 'Cardapio Web',
      pedidoId: orderId,
      recebidoEm: order.recebidoEm || '',
      recebidoEmMs: order.recebidoEmMs || 0,
      aceitoEm: admin.firestore.FieldValue.serverTimestamp(),
      aceitoEmMs: Date.now(),
      enderecoEntrega: order.enderecoEntrega || '',
      cliente: order.cliente || '',
      telefoneCliente: order.telefoneCliente || '',
      valorPedido: order.valorPedido || 0
    }, { merge: true });

    // Remove from pending (memory)
    pending.delete(orderId);

    // Notify frontend to update the list
    io.to(`company:${req.companyId}`).emit('cardapioweb:order-accepted', { orderId, at: Date.now() });

    // Return order data so frontend can fill the delivery form
    res.json({
      ok: true,
      message: `Pedido ${orderId} aceito. Calculando entrega...`,
      order
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/companies/me/integration/pending-orders/:orderId/cancel', assertCompany, assertCompanyApproved, async (req, res, next) => {
  try {
    const orderId = String(req.params.orderId || '').slice(0, 80);
    const pending = cardapioWebPendingOrders.get(req.companyId);
    if (pending) pending.delete(orderId);
    const seen = cardapioWebSeenOrders.get(req.companyId) || new Set();
    seen.add(orderId);

    const docId = externalOrderDocId('Cardapio Web', orderId);
    await db.collection('empresas').doc(req.companyId).collection('integracaoPedidos').doc(docId).set({
      origem: 'Cardapio Web',
      pedidoId: orderId,
      status: 'cancelado',
      canceladoEm: admin.firestore.FieldValue.serverTimestamp(),
      canceladoEmMs: Date.now()
    }, { merge: true });

    io.to(`company:${req.companyId}`).emit('cardapioweb:order-accepted', { orderId, at: Date.now() });
    res.json({ ok: true, message: `Pedido ${orderId} cancelado.` });
  } catch (error) {
    next(error);
  }
});

// ── Start polling on server boot ──
cardapioWebRefreshActiveCompanies().then(() => {
  console.log('[cardapioweb] polling automatico iniciado (intervalo: 45s).');
  setInterval(() => {
    cardapioWebPollAll().catch((error) => console.error('[cardapioweb] erro no polling geral:', error.message));
  }, CARDAPIO_WEB_POLL_INTERVAL_MS);
}).catch((error) => {
  console.error('[cardapioweb] erro ao iniciar polling:', error.message);
});

// ── PediPlus: Automatic Polling System (in-memory, Firebase-friendly) ──

function normalizePediplusDelivery(delivery = {}, company = {}) {
  const customer = delivery.customer || {};
  const payment = delivery.payment || {};
  const items = Array.isArray(delivery.items) ? delivery.items : [];
  const orderNumber = delivery.order_number || delivery.display_id || delivery.id || '';
  const externalId = String(orderNumber).replace(/^#/, '').trim().slice(0, 80);
  const itemsFormatted = items.map((item) => {
    const addons = Array.isArray(item.addons) && item.addons.length ? ` (${item.addons.join(', ')})` : '';
    return {
      nome: cleanText(`${item.name || 'Item'}${addons}`, 150),
      quantidade: Number(item.quantity || 1)
    };
  });
  const recebidoEm = pickFirst(delivery.created_at, delivery.createdAt, new Date().toISOString());
  const recebidoEmMs = externalOrderMs(recebidoEm);
  return {
    origem: 'PediPlus',
    externalId,
    orderId: externalId,
    status: cleanText(delivery.status || 'pendente', 40),
    empresa: company.empresa || 'Empresa',
    cliente: cleanText(customer.name || 'Cliente PediPlus', 120),
    telefoneCliente: onlyDigits(customer.phone).slice(0, 13),
    enderecoEntrega: cleanText(customer.address || '', 300),
    complemento: cleanText(delivery.notes || '', 160),
    itens: itemsFormatted,
    valorPedido: money(payment.total || 0),
    taxaEntregaPediplus: money(payment.delivery_fee || 0),
    formaPagamento: cleanText(payment.method || '', 40),
    trocoPara: money(payment.change_for || 0),
    recebidoEm,
    recebidoEmMs,
    recebidoDia: recebidoEmMs ? dateKeySaoPaulo(new Date(recebidoEmMs)) : ''
  };
}

async function updatePediplusOrderStatus(token, orderNumber, status = 'saiu_para_entrega', driverName = 'Motoboy Nexus') {
  try {
    const num = Number(String(orderNumber).replace(/\D/g, ''));
    if (!num) return false;
    const url = 'https://pediplus.online/api/public/deliveries';
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        order_number: num,
        status,
        driver_name: driverName
      })
    });
    console.log(`[pediplus] status update #${num} -> ${status}: HTTP ${response.status}`);
    return response.ok;
  } catch (error) {
    console.error('[pediplus] erro ao atualizar status:', error.message);
    return false;
  }
}

async function pediplusRefreshActiveCompanies() {
  try {
    const snapshot = await db.collection('empresas')
      .where('pediplusAtivo', '==', true)
      .where('pediplusTokenEncrypted', '!=', '')
      .select('pediplusTokenEncrypted', 'pediplusTipoEntrega', 'empresa', 'retirada', 'cidade', 'status', 'saldo', 'reservado')
      .get();
    const found = new Set();
    snapshot.docs.forEach((doc) => {
      const data = doc.data() || {};
      if (companyStatus(data) !== 'aprovada') return;
      const balance = companyBalance(data);
      if (balance.disponivel < MIN_INTEGRATION_BALANCE) return;
      const apiKey = decryptSecretSafe(data.pediplusTokenEncrypted);
      if (!apiKey) return;
      found.add(doc.id);
      pediplusActiveCompanies.set(doc.id, {
        apiKey,
        tipoEntrega: data.pediplusTipoEntrega || 'Acai / pote de sorvete',
        empresa: data.empresa || '',
        retirada: data.retirada || '',
        cidade: data.cidade || 'Conchal',
        companyData: data
      });
      if (!pediplusSeenOrders.has(doc.id)) pediplusSeenOrders.set(doc.id, new Set());
      if (!pediplusPendingOrders.has(doc.id)) pediplusPendingOrders.set(doc.id, new Map());
    });
    for (const companyId of pediplusActiveCompanies.keys()) {
      if (!found.has(companyId)) {
        pediplusActiveCompanies.delete(companyId);
        pediplusSeenOrders.delete(companyId);
        pediplusPendingOrders.delete(companyId);
      }
    }
    pediplusLastCompanyRefresh = Date.now();
    console.log(`[pediplus] ${pediplusActiveCompanies.size} empresa(s) ativa(s) carregada(s).`);
  } catch (error) {
    console.error('[pediplus] erro ao carregar empresas ativas:', error.message);
  }
}

function pediplusClearMidnight() {
  const today = dateKeySaoPaulo();
  for (const [companyId, seen] of pediplusSeenOrders.entries()) {
    if (seen._day && seen._day !== today) {
      seen.clear();
      pediplusPendingOrders.get(companyId)?.clear();
    }
    seen._day = today;
  }
}

async function pediplusPollSingleCompany(companyId, config) {
  try {
    const url = 'https://pediplus.online/api/public/deliveries';
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Accept': 'application/json'
      }
    });
    if (!response.ok) {
      console.error(`[pediplus] ${config.empresa || companyId}: HTTP ${response.status}`);
      return;
    }
    const data = await response.json().catch(() => ({}));
    const deliveries = Array.isArray(data.deliveries) ? data.deliveries : (Array.isArray(data) ? data : []);
    if (!deliveries.length) return;

    const today = dateKeySaoPaulo();
    const seen = pediplusSeenOrders.get(companyId) || new Set();
    const pending = pediplusPendingOrders.get(companyId) || new Map();
    let newCount = 0;

    for (const candidate of deliveries.slice(0, 20)) {
      const preview = normalizePediplusDelivery(candidate, { empresa: config.empresa, cidade: config.cidade });
      if (!preview.externalId) continue;

      if (seen.has(preview.externalId)) continue;

      // Only today's orders
      if (preview.recebidoDia && preview.recebidoDia !== today) {
        seen.add(preview.externalId);
        continue;
      }

      // Check if already imported/dispatched in Firestore
      if (await alreadyImportedIntegrationOrder(companyId, preview.origem, preview.externalId)) {
        seen.add(preview.externalId);
        continue;
      }

      seen.add(preview.externalId);
      pending.set(preview.externalId, {
        ...preview,
        receivedAtMs: Date.now(),
        companyId
      });
      newCount++;
    }

    if (newCount > 0) {
      console.log(`[pediplus] ${config.empresa || companyId}: ${newCount} pedido(s) novo(s) encontrado(s).`);
      io.to(`company:${companyId}`).emit('pediplus:new-orders', {
        orders: Array.from(pending.values()),
        total: pending.size,
        at: Date.now()
      });
    }
  } catch (error) {
    console.error(`[pediplus] ${config.empresa || companyId}: erro no polling:`, error.message);
  }
}

async function pediplusPollAll() {
  if (Date.now() - pediplusLastCompanyRefresh > PEDIPLUS_COMPANIES_REFRESH_MS) {
    await pediplusRefreshActiveCompanies();
  }
  pediplusClearMidnight();

  for (const [companyId, config] of pediplusActiveCompanies.entries()) {
    await pediplusPollSingleCompany(companyId, config);
    if (pediplusActiveCompanies.size > 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

app.post('/api/companies/me/pediplus/save', assertCompany, assertCompanyApproved, async (req, res, next) => {
  try {
    const token = typeof req.body.token === 'string' ? req.body.token.trim() : '';
    const ativo = req.body.ativo !== undefined ? !!req.body.ativo : !!req.body.ativa;
    const tipoEntrega = String(req.body.tipoEntrega || 'Acai / pote de sorvete').slice(0, 50);

    const balance = companyBalance(req.company || {});
    if (ativo && balance.disponivel < MIN_INTEGRATION_BALANCE) {
      return res.status(400).json({
        error: 'saldo_insuficiente',
        message: `Saldo insuficiente (R$ ${balance.disponivel.toFixed(2).replace('.', ',')}). Para ativar o modo automatico e necessario ter no minimo R$ 6,50 de saldo disponivel. Adicione saldo no Financeiro primeiro.`
      });
    }

    const updates = {
      pediplusAtivo: ativo,
      pediplusTipoEntrega: tipoEntrega,
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    };
    let tokenSalvo = false;
    if (token) {
      updates.pediplusTokenEncrypted = encryptSecret(token);
      tokenSalvo = true;
    }
    await req.companySnap.ref.set(updates, { merge: true });

    const tokenFinal = token || decryptSecretSafe(req.company.pediplusTokenEncrypted || '');
    if (ativo && tokenFinal && balance.disponivel >= MIN_INTEGRATION_BALANCE) {
      pediplusActiveCompanies.set(req.companyId, {
        apiKey: tokenFinal,
        tipoEntrega,
        empresa: req.company.empresa || '',
        retirada: req.company.retirada || '',
        cidade: req.company.cidade || 'Conchal',
        companyData: req.company
      });
      if (!pediplusSeenOrders.has(req.companyId)) pediplusSeenOrders.set(req.companyId, new Set());
      if (!pediplusPendingOrders.has(req.companyId)) pediplusPendingOrders.set(req.companyId, new Map());
      pediplusPollSingleCompany(req.companyId, pediplusActiveCompanies.get(req.companyId)).catch(console.error);
    } else if (!ativo) {
      pediplusActiveCompanies.delete(req.companyId);
    }

    res.json({
      ok: true,
      pediplusAtivo: ativo,
      pediplusProtegido: !!(tokenSalvo || req.company.pediplusTokenEncrypted),
      pediplusTipoEntrega: tipoEntrega,
      message: ativo ? 'PediPlus ativo e sincronizando.' : 'PediPlus desativado.'
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/companies/me/pediplus/test', assertCompany, assertCompanyApproved, async (req, res, next) => {
  try {
    const rawToken = String(req.body.token || '').trim();
    const token = rawToken || decryptSecretSafe(req.company.pediplusTokenEncrypted || '');
    if (!token) {
      return res.status(400).json({ error: 'token_missing', message: 'Cole o Token do PediPlus ou salve antes de testar.' });
    }
    const response = await fetch('https://pediplus.online/api/public/deliveries?status=pendentes', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      }
    });
    if (!response.ok) {
      return res.status(response.status).json({
        error: 'pediplus_error',
        message: `PediPlus respondeu HTTP ${response.status}. Verifique se o token esta correto.`
      });
    }
    const data = await response.json().catch(() => ({}));
    const store = data.store || {};
    const deliveries = Array.isArray(data.deliveries) ? data.deliveries : [];
    res.json({
      ok: true,
      message: `Conexao com ${store.name || 'PediPlus'} bem sucedida!`,
      store,
      total: deliveries.length,
      deliveries
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/companies/me/pediplus/pending-orders', assertCompany, assertCompanyApproved, (req, res) => {
  const pending = pediplusPendingOrders.get(req.companyId);
  const orders = pending ? Array.from(pending.values()) : [];
  res.json({ ok: true, orders, total: orders.length });
});

app.post('/api/companies/me/pediplus/pending-orders/:orderId/accept', assertCompany, assertCompanyApproved, async (req, res, next) => {
  try {
    const orderId = String(req.params.orderId || '').slice(0, 80);
    const pending = pediplusPendingOrders.get(req.companyId);
    const order = pending?.get(orderId);
    if (!order) {
      return res.status(404).json({ error: 'pedido_nao_encontrado', message: 'Pedido nao encontrado ou ja foi aceito.' });
    }

    const balance = companyBalance(req.company || {});
    if (balance.disponivel < MIN_INTEGRATION_BALANCE) {
      return res.status(402).json({
        error: 'saldo_insuficiente',
        message: `Saldo insuficiente (R$ ${balance.disponivel.toFixed(2).replace('.', ',')}). E necessario ter no minimo R$ 6,50 de saldo para liberar e chamar motoboy. Adicione saldo no Financeiro.`
      });
    }

    const docId = externalOrderDocId(order.origem || 'PediPlus', orderId);
    await db.collection('empresas').doc(req.companyId).collection('integracaoPedidos').doc(docId).set({
      origem: order.origem || 'PediPlus',
      pedidoId: orderId,
      recebidoEm: order.recebidoEm || '',
      recebidoEmMs: order.recebidoEmMs || 0,
      aceitoEm: admin.firestore.FieldValue.serverTimestamp(),
      aceitoEmMs: Date.now(),
      enderecoEntrega: order.enderecoEntrega || '',
      cliente: order.cliente || '',
      telefoneCliente: order.telefoneCliente || '',
      valorPedido: order.valorPedido || 0
    }, { merge: true });

    pending.delete(orderId);
    io.to(`company:${req.companyId}`).emit('pediplus:order-accepted', { orderId, at: Date.now() });

    if (req.company.pediplusTokenEncrypted) {
      const token = decryptSecretSafe(req.company.pediplusTokenEncrypted);
      if (token) {
        updatePediplusOrderStatus(token, orderId, 'saiu_para_entrega', 'MotoJa Entregador').catch(console.error);
      }
    }

    res.json({ ok: true, message: `Pedido ${orderId} aceito.`, order });
  } catch (error) {
    next(error);
  }
});

app.post('/api/companies/me/pediplus/pending-orders/:orderId/cancel', assertCompany, assertCompanyApproved, async (req, res, next) => {
  try {
    const orderId = String(req.params.orderId || '').slice(0, 80);
    const pending = pediplusPendingOrders.get(req.companyId);
    if (pending) pending.delete(orderId);
    const seen = pediplusSeenOrders.get(req.companyId) || new Set();
    seen.add(orderId);

    const docId = externalOrderDocId('PediPlus', orderId);
    await db.collection('empresas').doc(req.companyId).collection('integracaoPedidos').doc(docId).set({
      origem: 'PediPlus',
      pedidoId: orderId,
      status: 'cancelado',
      canceladoEm: admin.firestore.FieldValue.serverTimestamp(),
      canceladoEmMs: Date.now()
    }, { merge: true });

    io.to(`company:${req.companyId}`).emit('pediplus:order-accepted', { orderId, at: Date.now() });
    res.json({ ok: true, message: `Pedido ${orderId} cancelado.` });
  } catch (error) {
    next(error);
  }
});

pediplusRefreshActiveCompanies().then(() => {
  console.log('[pediplus] polling automatico iniciado (intervalo: 45s).');
  setInterval(() => {
    pediplusPollAll().catch((error) => console.error('[pediplus] erro no polling geral:', error.message));
  }, PEDIPLUS_POLL_INTERVAL_MS);
}).catch((error) => {
  console.error('[pediplus] erro ao iniciar polling:', error.message);
});

app.get('/api/company/balance', assertCompany, async (req, res) => {
  res.json({ ok: true, telefoneEmpresa: req.companyId, ...companyBalance(req.company) });
});

app.get('/api/companies/:phone/delivery-report', assertCompany, async (req, res, next) => {
  try {
    const phone = onlyDigits(req.params.phone);
    if (phone.length < 10 || phone.length > 11) return res.status(400).json({ error: 'telefone_empresa_invalido' });
    if (phone !== req.companyId) return res.status(403).json({ error: 'empresa_nao_autorizada' });

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
        motoboy: item.motoboy || '',
        motoboyFoto: item.motoboyFoto || '',
        valor: money(item.valor),
        criadaEm: timestampMs(item.criadaEm),
        quantidadeEntregasExclusivo: Number(item.quantidadeEntregasExclusivo || 0),
        taxaFixaEntrega: money(item.taxaFixaEntrega || 0),
        empresaFicaPorTaxa: money(item.empresaFicaPorTaxa || 0)
      }))
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/companies/deposit-request', assertCompany, assertCompanyApproved, createRideLimiter, async (req, res, next) => {
  try {
    const deposit = depositPublicData({
      ...req.body,
      empresa: req.company.empresa || req.body.empresa,
      responsavel: req.company.responsavel || req.body.responsavel,
      telefoneEmpresa: req.companyId
    });
    if (!deposit.empresa || !deposit.responsavel || deposit.telefoneEmpresa.length < 10 || deposit.telefoneEmpresa.length > 11) {
      return res.status(400).json({ error: 'preencha_empresa_responsavel_telefone' });
    }
    if (!deposit.valor || deposit.valor < 10 || deposit.valor > 5000) {
      return res.status(400).json({ error: 'valor_deposito_invalido', message: 'Deposito deve ser entre R$ 10,00 e R$ 5.000,00.' });
    }

    const companyRef = req.companySnap.ref;
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
        metodo: 'pix_manual',
        empresaId: deposit.telefoneEmpresa,
        status: 'pendente',
        criadaEm: admin.firestore.FieldValue.serverTimestamp(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    const msg = `Pedido de deposito Nexus MotoJa\n\nEmpresa: ${deposit.empresa}\nResponsavel: ${deposit.responsavel}\nWhatsApp: ${deposit.telefoneEmpresa}\nValor: ${deposit.valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}\nCodigo: ${depositRef.id}\n\nPix para pagamento:\nChave Pix: ${OWNER_PIX_KEY}\n\nDepois de pagar, envie o comprovante aqui. O saldo so entra no app depois que o dono conferir o pagamento e aprovar no painel.`;
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

app.post('/api/companies/deposit-preference', assertCompany, assertCompanyApproved, createRideLimiter, async (req, res, next) => {
  try {
    const deposit = {
      ...depositPublicData({
        ...req.body,
        empresa: req.company.empresa,
        responsavel: req.company.responsavel,
        telefoneEmpresa: req.companyId,
        metodo: 'mercadopago'
      }),
      email: req.company.email || ''
    };

    if (!deposit.valor || deposit.valor < 10 || deposit.valor > 5000) {
      return res.status(400).json({ error: 'valor_deposito_invalido', message: 'Deposito deve ser entre R$ 10,00 e R$ 5.000,00.' });
    }

    const depositRef = db.collection('depositos').doc();
    const preference = await createCompanyDepositPreference(depositRef.id, deposit);

    await db.runTransaction(async (tx) => {
      tx.set(req.companySnap.ref, {
        pagamentoModo: 'mercadopago',
        mercadoPagoEmpresa: {
          ultimoPreferenceId: preference.preferenceId,
          ultimoDepositoId: depositRef.id,
          atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
        },
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      tx.set(depositRef, {
        ...deposit,
        empresaId: req.companyId,
        metodo: 'mercadopago',
        status: 'aguardando_pagamento',
        mercadoPago: {
          preferenceId: preference.preferenceId,
          initPoint: preference.initPoint,
          sandboxInitPoint: preference.sandboxInitPoint,
          criadoEm: admin.firestore.FieldValue.serverTimestamp()
        },
        criadaEm: admin.firestore.FieldValue.serverTimestamp(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return res.status(201).json({
      ok: true,
      depositId: depositRef.id,
      status: 'aguardando_pagamento',
      initPoint: preference.initPoint,
      sandboxInitPoint: preference.sandboxInitPoint
    });
  } catch (error) {
    return next(error);
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

app.post('/api/admin/deposits/:depositId/update-value', assertOwner, async (req, res, next) => {
  try {
    const newValue = money(req.body.valor);
    if (!newValue || newValue < 10 || newValue > 5000) {
      return res.status(400).json({ error: 'valor_deposito_invalido', message: 'Deposito deve ser entre R$ 10,00 e R$ 5.000,00.' });
    }
    const depositRef = db.collection('depositos').doc(String(req.params.depositId || ''));
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(depositRef);
      if (!snap.exists) {
        const error = new Error('Deposito nao encontrado.');
        error.status = 404;
        throw error;
      }
      if (snap.data().status !== 'pendente') {
        const error = new Error('So e possivel editar valor de deposito pendente.');
        error.status = 409;
        throw error;
      }
      tx.update(depositRef, {
        valor: newValue,
        valorEditadoEm: admin.firestore.FieldValue.serverTimestamp(),
        valorEditadoPor: 'dono',
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    res.json({ ok: true, valor: newValue });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/deposits/:depositId/cancel-credit', assertOwner, async (req, res, next) => {
  try {
    const reason = String(req.body.reason || '').trim().slice(0, 250);
    if (!reason) return res.status(400).json({ error: 'motivo_obrigatorio', message: 'Informe o motivo para cancelar o credito.' });
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
      if (deposit.status !== 'aprovado') {
        const error = new Error('So e possivel cancelar credito de deposito aprovado.');
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
      if (before.disponivel < valor) {
        const error = new Error('Nao da para cancelar: a empresa ja usou parte desse saldo. Ajuste manualmente pelo financeiro.');
        error.status = 409;
        throw error;
      }
      const afterSaldo = money(before.saldo - valor);
      tx.set(companyRef, {
        saldo: afterSaldo,
        reservado: before.reservado,
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      tx.set(ledgerRef(deposit.telefoneEmpresa), {
        tipo: 'debito',
        origem: 'cancelamento_credito_deposito',
        depositoId: depositRef.id,
        valor,
        motivo: reason,
        saldoAntes: before.saldo,
        saldoDepois: afterSaldo,
        reservadoAntes: before.reservado,
        reservadoDepois: before.reservado,
        criadoEm: admin.firestore.FieldValue.serverTimestamp()
      });
      tx.update(depositRef, {
        status: 'credito_cancelado',
        motivoCancelamentoCredito: reason,
        creditoCanceladoEm: admin.firestore.FieldValue.serverTimestamp(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      });
      result = { saldo: afterSaldo, reservado: before.reservado, disponivel: money(afterSaldo - before.reservado) };
    });

    res.json({ ok: true, ...result });
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

app.post('/api/drivers/:cpf/mercadopago/status', authLimiter, async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.params.cpf);
    if (driverCpf.length !== 11) return res.status(400).json({ error: 'driverCpf_invalido' });

    const driver = await getDriverWithProof(driverCpf, req.body);
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
    ride.cidadeOperacao = inferNewRideOperatingCity(ride, req.body.cidadeOperacao);
    if (!ride.nome || !ride.origem || !ride.destino || ride.telefoneCliente.length < 10 || ride.telefoneCliente.length > 11) {
      return res.status(400).json({ error: 'preencha_nome_telefone_origem_destino' });
    }
    if (!ride.valor || ride.valor <= 0) {
      return res.status(400).json({ error: 'valor_invalido' });
    }
    const header = String(req.header('authorization') || '');
    const customerToken = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const customerSession = await findCustomerSession(customerToken);
    const authenticated = !!(customerSession && customerProfileComplete(customerSession.customer));
    if (authenticated && onlyDigits(customerSession.customer.telefoneCliente || customerSession.customerId) !== ride.telefoneCliente) {
      return res.status(403).json({ error: 'telefone_cliente_divergente', message: 'Use o WhatsApp confirmado da sua conta.' });
    }
    if (CUSTOMER_REGISTRATION_ENFORCED && !authenticated) {
      const completedRides = await completedCustomerRides(ride.clienteDeviceId);
      if (completedRides >= CUSTOMER_FREE_RIDES) {
        return res.status(403).json({
          error: 'cadastro_cliente_obrigatorio',
          message: 'Você já concluiu 3 corridas. Faça seu cadastro para continuar usando a Nexus MotoJá.',
          completedRides,
          freeRideLimit: CUSTOMER_FREE_RIDES
        });
      }
    }
    if (authenticated) {
      ride.customerId = customerSession.customerId;
      ride.nome = cleanText(customerSession.customer.nome, 80) || ride.nome;
      ride.fotoCliente = validDriverPhoto(customerSession.customer.fotoCliente) || '';
      ride.clienteVerificado = true;
    }
    const serverKm = await calculateRouteDistanceKm([
      { lat: ride.origemLat, lon: ride.origemLon },
      { lat: ride.destinoLat, lon: ride.destinoLon }
    ]);
    ride.km = serverKm;
    if (!isGpsOrigin(ride.origemDigitada || ride.origem)) {
      ensureResolvedPlaceMatches(ride.origemDigitada || ride.origem, ride.origemEncontrada || ride.origem, 'Origem da corrida');
      ensureResolvedAddressIsSpecific(ride.origemDigitada || ride.origem, ride.origemEncontrada || ride.origem, 'Origem da corrida');
    }
    ensureResolvedPlaceMatches(ride.destino, ride.destinoEncontrado || ride.destino, 'Destino da corrida');
    ensureResolvedAddressIsSpecific(ride.destino, ride.destinoEncontrado || ride.destino, 'Destino da corrida');
    ensureDistantRouteIsPlausible(ride.km, ride.destino, ride.destinoEncontrado);
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

app.get('/api/rides/:rideId/status', async (req, res, next) => {
  try {
    const doc = await db.collection('corridas').doc(String(req.params.rideId || '')).get();
    if (!doc.exists) return res.status(404).json({ error: 'corrida_nao_encontrada' });
    const ride = doc.data() || {};
    res.json({
      ok: true,
      rideId: doc.id,
      status: ride.status || '',
      criadaEmMs: timestampMs(ride.criadaEm),
      expiradaEmMs: timestampMs(ride.expiradaEm),
      aceitaEmMs: timestampMs(ride.aceitaEm),
      motoboy: ride.motoboy || '',
      motoboyFoto: validDriverPhoto(ride.motoboyFoto) || '',
      valor: money(ride.valor),
      destino: ride.destino || '',
      clienteAvisado: !!ride.clienteAvisadoEm,
      rastreamentoAtivo: ride.rastreamentoAtivo === true,
      motoboyLocalizacao: ride.rastreamentoAtivo === true && ride.status === 'aceita'
        ? serializeFirestore(ride.motoboyLocalizacao || null)
        : null
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/rides/:rideId/renew', createRideLimiter, async (req, res, next) => {
  try {
    const telefoneCliente = onlyDigits(req.body.telefoneCliente);
    if (telefoneCliente.length < 10 || telefoneCliente.length > 11) {
      return res.status(400).json({ error: 'telefone_cliente_obrigatorio' });
    }
    const ref = db.collection('corridas').doc(String(req.params.rideId || ''));
    let renewedRide = null;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        const error = new Error('Corrida nao encontrada.');
        error.status = 404;
        error.code = 'corrida_nao_encontrada';
        throw error;
      }
      const ride = snap.data() || {};
      if (onlyDigits(ride.telefoneCliente) !== telefoneCliente) {
        const error = new Error('Telefone nao confere com o pedido.');
        error.status = 403;
        error.code = 'telefone_nao_confere';
        throw error;
      }
      if (!['pendente', 'expirada'].includes(ride.status)) {
        const error = new Error('Essa corrida nao pode ser renovada agora.');
        error.status = 409;
        error.code = 'corrida_nao_renovavel';
        throw error;
      }
      renewedRide = { ...ride, status: 'pendente' };
      tx.update(ref, {
        status: 'pendente',
        renovacoes: Number(ride.renovacoes || 0) + 1,
        expiradaEm: null,
        renovadaEm: admin.firestore.FieldValue.serverTimestamp(),
        criadaEm: admin.firestore.FieldValue.serverTimestamp(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    const telegram = await notifyTelegramAboutRide(ref.id, renewedRide).catch((error) => {
      console.error('telegram renew notify failed', error);
      return { sent: false, failed: true };
    });
    res.json({ ok: true, rideId: ref.id, telegram });
  } catch (error) {
    next(error);
  }
});

app.post('/api/rides/:rideId/client-cancel', async (req, res, next) => {
  try {
    const telefoneCliente = onlyDigits(req.body.telefoneCliente);
    if (telefoneCliente.length < 10 || telefoneCliente.length > 11) {
      return res.status(400).json({ error: 'telefone_cliente_obrigatorio' });
    }
    const ref = db.collection('corridas').doc(String(req.params.rideId || ''));
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        const error = new Error('Corrida nao encontrada.');
        error.status = 404;
        error.code = 'corrida_nao_encontrada';
        throw error;
      }
      const ride = snap.data() || {};
      if (onlyDigits(ride.telefoneCliente) !== telefoneCliente) {
        const error = new Error('Telefone nao confere com o pedido.');
        error.status = 403;
        error.code = 'telefone_nao_confere';
        throw error;
      }
      if (!['pendente', 'expirada'].includes(ride.status)) {
        const error = new Error('Essa corrida ja foi aceita por um motoboy e nao pode ser cancelada por aqui.');
        error.status = 409;
        error.code = 'corrida_ja_aceita';
        error.currentStatus = ride.status || '';
        error.motoboy = ride.motoboy || '';
        throw error;
      }
      tx.update(ref, {
        status: 'cancelada',
        canceladoPor: 'Cliente',
        motivoCancelamento: 'Cliente cancelou depois da espera',
        canceladoEm: admin.firestore.FieldValue.serverTimestamp(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    res.json({ ok: true, rideId: ref.id });
  } catch (error) {
    next(error);
  }
});

app.get('/api/companies/daily-plan/status', assertCompany, async (req, res, next) => {
  try {
    const dia = todayKeySaoPaulo();
    const snap = await dailyPlanRef(req.companyId, dia).get();
    const plan = snap.exists ? snap.data() : null;
    res.json({
      ok: true,
      active: !!plan && plan.status === 'ativo',
      dia,
      tipoEntrega: DAILY_PLAN_TYPE,
      diaria: DAILY_PLAN_PRICE,
      taxaEntrega: DAILY_PLAN_DELIVERY_FEE,
      appFee: DAILY_PLAN_APP_FEE
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/companies/daily-plan/activate', assertCompany, assertCompanyApproved, createRideLimiter, async (req, res, next) => {
  try {
    const dia = todayKeySaoPaulo();
    const companyRef = req.companySnap.ref;
    const planRef = dailyPlanRef(req.companyId, dia);
    let balanceAfter = null;
    let alreadyActive = false;

    await db.runTransaction(async (tx) => {
      const planSnap = await tx.get(planRef);
      if (planSnap.exists && planSnap.data().status === 'ativo') {
        alreadyActive = true;
        balanceAfter = companyBalance((await tx.get(companyRef)).data() || {});
        return;
      }

      const companySnap = await tx.get(companyRef);
      const balance = companyBalance(companySnap.exists ? companySnap.data() : {});
      if (balance.disponivel < DAILY_PLAN_PRICE) {
        const error = new Error('Saldo insuficiente para ativar o Plano Diario MotoJa Pro. Carregue saldo antes de aceitar.');
        error.status = 402;
        error.code = 'saldo_insuficiente';
        error.balance = balance;
        throw error;
      }
      const nextSaldo = money(balance.saldo - DAILY_PLAN_PRICE);
      tx.set(companyRef, {
        saldo: nextSaldo,
        reservado: balance.reservado,
        planoDiarioAtivoDia: dia,
        planoDiarioTaxa: DAILY_PLAN_DELIVERY_FEE,
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      tx.set(planRef, {
        status: 'ativo',
        dia,
        valor: DAILY_PLAN_PRICE,
        taxaEntrega: DAILY_PLAN_DELIVERY_FEE,
        appFee: DAILY_PLAN_APP_FEE,
        tipoEntrega: DAILY_PLAN_TYPE,
        ativadoEm: admin.firestore.FieldValue.serverTimestamp()
      });
      tx.set(ledgerRef(req.companyId), {
        tipo: 'debito',
        origem: 'plano_diario_motoja_pro_ativado',
        valor: DAILY_PLAN_PRICE,
        saldoAntes: balance.saldo,
        saldoDepois: nextSaldo,
        reservadoAntes: balance.reservado,
        reservadoDepois: balance.reservado,
        criadoEm: admin.firestore.FieldValue.serverTimestamp()
      });
      balanceAfter = companyBalance({ saldo: nextSaldo, reservado: balance.reservado });
    });

    res.json({ ok: true, active: true, alreadyActive, dia, balance: balanceAfter, tipoEntrega: DAILY_PLAN_TYPE, diaria: DAILY_PLAN_PRICE, taxaEntrega: DAILY_PLAN_DELIVERY_FEE });
  } catch (error) {
    if (error.code === 'saldo_insuficiente') {
      return res.status(error.status || 402).json({ error: 'saldo_insuficiente', message: error.message, balance: error.balance || null });
    }
    next(error);
  }
});

app.post('/api/deliveries', assertCompany, assertCompanyApproved, createRideLimiter, async (req, res, next) => {
  try {
    const delivery = deliveryPublicData(req.body);
    delivery.telefoneEmpresa = req.companyId;
    delivery.empresa = cleanText(req.company.empresa || delivery.empresa, 120);
    delivery.responsavel = cleanText(req.company.responsavel || delivery.responsavel, 120);
    if (!delivery.empresa || !delivery.responsavel || !delivery.retirada || !delivery.entrega || delivery.telefoneEmpresa.length < 10 || delivery.telefoneEmpresa.length > 11) {
      return res.status(400).json({ error: 'preencha_empresa_responsavel_telefone_retirada_entrega' });
    }
    if (delivery.telefoneRecebedor && (delivery.telefoneRecebedor.length < 10 || delivery.telefoneRecebedor.length > 11)) {
      return res.status(400).json({ error: 'telefone_recebedor_invalido', message: 'Confira o WhatsApp opcional de quem recebe ou deixe o campo vazio.' });
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
    if (pontosExtras.some((p) => {
      const telefone = onlyDigits(p.telefoneRecebedor);
      return !String(p.digitado || '').trim() || (telefone && (telefone.length < 10 || telefone.length > 11)) || !validCoordinate(p);
    })) {
      return res.status(400).json({ error: 'pontos_extras_invalidos', message: 'Confira o endereco de cada ponto extra e qualquer WhatsApp opcional preenchido.' });
    }
    ensureResolvedPlaceMatches(delivery.retirada, delivery.retiradaEncontrada || delivery.retirada, 'Endereco de retirada');
    ensureResolvedAddressIsSpecific(delivery.retirada, delivery.retiradaEncontrada || delivery.retirada, 'Endereco de retirada');
    ensureResolvedPlaceMatches(delivery.entrega, delivery.entregaEncontrada || delivery.entrega, 'Endereco de entrega');
    ensureResolvedAddressIsSpecific(delivery.entrega, delivery.entregaEncontrada || delivery.entrega, 'Endereco de entrega');
    pontosExtras.forEach((point) => {
      ensureResolvedPlaceMatches(point.digitado, point.encontrado || point.digitado, `Ponto ${point.ordem || ''}`.trim());
      ensureResolvedAddressIsSpecific(point.digitado, point.encontrado || point.digitado, `Ponto ${point.ordem || ''}`.trim());
    });
    const addressesToVerify = [
      { label: 'retirada', text: delivery.retirada, point: { lat: delivery.retiradaLat, lon: delivery.retiradaLon } },
      { label: 'entrega', text: delivery.entrega, point: { lat: delivery.entregaLat, lon: delivery.entregaLon } },
      ...pontosExtras.map((point, index) => ({
        label: `ponto ${index + 2}`,
        text: point.digitado,
        point: { lat: point.lat, lon: point.lon }
      }))
    ];
    const verifiedAddresses = await Promise.all(addressesToVerify.map(async (item) => {
      const verified = await geocodeCapturedAddress(item.text, item.point);
      const differenceKm = coordinateDistanceKm(item.point, verified);
      if (!Number.isFinite(differenceKm) || differenceKm > 2.5) {
        const error = new Error(`As coordenadas do endereco de ${item.label} nao conferem com o endereco digitado. Calcule novamente.`);
        error.status = 400;
        error.code = 'coordenadas_endereco_divergentes';
        throw error;
      }
      return verified;
    }));
    delivery.retiradaLat = verifiedAddresses[0].lat;
    delivery.retiradaLon = verifiedAddresses[0].lon;
    delivery.retiradaEncontrada = verifiedAddresses[0].text;
    delivery.entregaLat = verifiedAddresses[1].lat;
    delivery.entregaLon = verifiedAddresses[1].lon;
    delivery.entregaEncontrada = verifiedAddresses[1].text;
    pontosExtras.forEach((point, index) => {
      const verified = verifiedAddresses[index + 2];
      point.lat = verified.lat;
      point.lon = verified.lon;
      point.encontrado = verified.text;
      point.mapa = `https://www.google.com/maps?q=${verified.lat},${verified.lon}`;
    });
    if (!isFixedFoodDelivery(delivery.tipoEntrega)) {
      const serverKm = await calculateRouteDistanceKm([
        { lat: delivery.retiradaLat, lon: delivery.retiradaLon },
        { lat: delivery.entregaLat, lon: delivery.entregaLon },
        ...pontosExtras.map((point) => ({ lat: point.lat, lon: point.lon }))
      ]);
      delivery.km = serverKm;
    }
    ensureDistantRouteIsPlausible(
      delivery.km,
      delivery.entrega,
      delivery.entregaEncontrada,
      ...pontosExtras.flatMap((point) => [point.digitado, point.encontrado])
    );
    if (!delivery.valor || delivery.valor <= 0) {
      return res.status(400).json({ error: 'valor_invalido' });
    }
    if (money(delivery.valor) !== expectedDeliveryFare(delivery.km, delivery.paradas, delivery.tipoEntrega, delivery)) {
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

      const companyRef = req.companySnap.ref;
      const companySnap = await tx.get(companyRef);
      const balance = companyBalance(companySnap.exists ? companySnap.data() : {});
      const integrationDocId = delivery.integracaoOrigem && delivery.integracaoPedidoId
        ? externalOrderDocId(delivery.integracaoOrigem, delivery.integracaoPedidoId)
        : '';
      const integrationRef = integrationDocId ? companyRef.collection('integracaoPedidos').doc(integrationDocId) : null;
      const pendingIntegrationRef = integrationDocId ? integrationPendingRef(req.companyId, delivery.integracaoOrigem, delivery.integracaoPedidoId) : null;
      if (integrationRef) {
        const integrationSnap = await tx.get(integrationRef);
        if (integrationSnap.exists) {
          const error = new Error('Esse pedido da API ja foi enviado para os motoboys.');
          error.status = 409;
          error.code = 'pedido_integracao_ja_processado';
          throw error;
        }
        const pendingSnap = await tx.get(pendingIntegrationRef);
        const pending = pendingSnap.exists ? pendingSnap.data() || {} : null;
        if (!pending || pending.recebidoDia !== todayKeySaoPaulo() || Number(pending.validUntilMs || 0) < Date.now()) {
          const error = new Error('Pedido da API nao esta mais liberado. Teste a integracao novamente para carregar somente pedidos de hoje.');
          error.status = 409;
          error.code = 'pedido_integracao_nao_liberado';
          throw error;
        }
        if (normalizeText(pending.enderecoEntrega) !== normalizeText(delivery.entrega)) {
          const error = new Error('Endereco do pedido da API foi alterado. Para evitar fraude ou erro de saldo, teste a integracao novamente.');
          error.status = 409;
          error.code = 'pedido_integracao_endereco_alterado';
          throw error;
        }
      }
      const dailyPlan = isDailyPlanDelivery(delivery.tipoEntrega);
      if (dailyPlan) {
        const dia = todayKeySaoPaulo();
        const planSnap = await tx.get(dailyPlanRef(req.companyId, dia));
        if (!planSnap.exists || planSnap.data().status !== 'ativo') {
          const error = new Error('Plano Diario MotoJa Pro nao esta ativo hoje. Ative e desconte a diaria antes de usar taxa fixa de R$ 4,00.');
          error.status = 403;
          error.code = 'plano_diario_inativo';
          throw error;
        }
        delivery.planoDiario = true;
        delivery.planoDiarioDia = dia;
        delivery.taxaFixaEntrega = DAILY_PLAN_DELIVERY_FEE;
        delivery.empresaFicaPorTaxa = DAILY_PLAN_APP_FEE;
        delivery.precoLabel = `Plano Diario MotoJa Pro ativo: R$ ${DAILY_PLAN_DELIVERY_FEE.toFixed(2).replace('.', ',')} por entrega/ponto`;
      }
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
        telefoneEmpresa: req.companyId,
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

      if (integrationRef) {
        tx.set(integrationRef, {
          origem: delivery.integracaoOrigem,
          pedidoId: delivery.integracaoPedidoId,
          recebidoEm: delivery.integracaoPedidoRecebidoEm || '',
          entregaId: ref.id,
          status: 'enviado_motoboy',
          criadoEm: admin.firestore.FieldValue.serverTimestamp()
        });
        tx.delete(pendingIntegrationRef);
      }

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
    const push = await notifyDriversAboutDelivery(ref.id, delivery).catch((error) => {
      console.error('push delivery notify failed', error);
      return { sent: 0, failed: 1 };
    });

    res.status(201).json({ deliveryId: ref.id, telegram, push });
  } catch (error) {
    if (error.code === 'saldo_insuficiente') {
      return res.status(error.status || 402).json({
        error: 'saldo_insuficiente',
        message: error.message,
        balance: error.balance || null
      });
    }
    if (error.code === 'plano_diario_inativo') {
      return res.status(error.status || 403).json({ error: 'plano_diario_inativo', message: error.message });
    }
    next(error);
  }
});

app.post('/api/companies/exclusive-service', assertCompany, assertCompanyApproved, createRideLimiter, async (req, res, next) => {
  try {
    const empresa = cleanText(req.body.empresa || req.company.empresa || '', 120);
    const responsavel = cleanText(req.body.responsavel || req.company.responsavel || '', 120);
    const retirada = cleanText(req.body.retirada || req.company.retirada || '', 300);
    const horario = cleanText(req.body.horario || 'Horario a combinar com suporte MotoJa', 120);
    if (!empresa || !responsavel) {
      return res.status(400).json({ error: 'dados_empresa_invalidos', message: 'Entre na conta da empresa e confira empresa/responsavel.' });
    }

    const valor = 70;
    const driverAmount = 50;
    const appFee = 20;
    const taxaFixaEntrega = 4;
    const empresaFicaPorTaxa = 1;
    const ref = db.collection('entregas').doc();
    const companyRef = req.companySnap.ref;

    await db.runTransaction(async (tx) => {
      const companySnap = await tx.get(companyRef);
      const balance = companyBalance(companySnap.exists ? companySnap.data() : {});
      if (balance.disponivel < valor) {
        const error = new Error('Saldo insuficiente para contratar o MotoJa Exclusivo. Carregue saldo antes de aceitar a diaria.');
        error.status = 402;
        error.code = 'saldo_insuficiente';
        error.balance = balance;
        throw error;
      }
      const nextReserved = money(balance.reservado + valor);

      tx.set(companyRef, {
        saldo: balance.saldo,
        reservado: nextReserved,
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      tx.set(ledgerRef(req.companyId), {
        tipo: 'reserva',
        origem: 'motoja_exclusivo_contratado',
        entregaId: ref.id,
        valor,
        saldoAntes: balance.saldo,
        saldoDepois: balance.saldo,
        reservadoAntes: balance.reservado,
        reservadoDepois: nextReserved,
        criadoEm: admin.firestore.FieldValue.serverTimestamp()
      });

      tx.set(ref, {
        empresa,
        responsavel,
        telefoneEmpresa: req.companyId,
        empresaId: req.companyId,
        tipo: 'servico_exclusivo',
        tipoEntrega: 'MotoJa Exclusivo',
        retirada: retirada || 'Loja da empresa',
        entrega: 'Motoboy dedicado para a loja',
        entregaEncontrada: 'Servico exclusivo sem rota fixa',
        recebedor: responsavel,
        telefoneRecebedor: req.companyId,
        km: 0,
        valor,
        precoLabel: 'Diaria MotoJa Exclusivo: R$ 70,00',
        horario,
        periodo: horario,
        taxaFixaEntrega,
        empresaFicaPorTaxa,
        ganhoMotoboyPrevisto: driverAmount,
        ganhoAppPrevisto: appFee,
        saldoReservado: valor,
        status: 'pendente',
        pagamento: 'saldo_pre_pago_empresa',
        observacao: 'Motoboy dedicado para empresa no horario combinado. Plano sujeito a disponibilidade e confirmacao do suporte MotoJa.',
        criadaEm: admin.firestore.FieldValue.serverTimestamp(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    const job = {
      empresa,
      responsavel,
      telefoneEmpresa: req.companyId,
      tipo: 'servico_exclusivo',
      tipoEntrega: 'MotoJa Exclusivo',
      valor,
      horario,
      observacao: 'Motoboy dedicado para empresa no horario combinado.'
    };
    const telegram = await notifyTelegramAboutDelivery(ref.id, job).catch((error) => {
      console.error('telegram exclusive notify failed', error);
      return { sent: false, failed: true };
    });
    const push = await notifyDriversAboutDelivery(ref.id, job).catch((error) => {
      console.error('push exclusive notify failed', error);
      return { sent: 0, failed: 1 };
    });

    return res.status(201).json({
      ok: true,
      deliveryId: ref.id,
      valor,
      motoboy: driverAmount,
      app: appFee,
      taxaFixaEntrega,
      empresaFicaPorTaxa,
      telegram,
      push
    });
  } catch (error) {
    if (error.code === 'saldo_insuficiente') {
      return res.status(error.status || 402).json({
        error: 'saldo_insuficiente',
        message: error.message,
        balance: error.balance || null
      });
    }
    return next(error);
  }
});

app.post('/api/deliveries/:deliveryId/renew', assertCompany, assertCompanyApproved, createRideLimiter, async (req, res, next) => {
  try {
    const ref = db.collection('entregas').doc(String(req.params.deliveryId || ''));
    let renewedDelivery = null;

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        const error = new Error('Entrega nao encontrada.');
        error.status = 404;
        error.code = 'entrega_nao_encontrada';
        throw error;
      }

      const delivery = snap.data() || {};
      if (onlyDigits(delivery.empresaId || delivery.telefoneEmpresa) !== req.companyId) {
        const error = new Error('Entrega nao pertence a esta empresa.');
        error.status = 403;
        error.code = 'empresa_nao_confere';
        throw error;
      }
      if (!['pendente', 'expirada'].includes(delivery.status)) {
        const error = new Error('Essa entrega nao pode ser chamada novamente agora.');
        error.status = 409;
        error.code = 'entrega_nao_renovavel';
        throw error;
      }

      const valor = money(delivery.saldoReservado || delivery.valor || 0);
      const companyRef = req.companySnap.ref;
      const companySnap = await tx.get(companyRef);
      const balance = companyBalance(companySnap.exists ? companySnap.data() : {});
      const precisaReservar = delivery.status === 'expirada' || !!delivery.saldoLiberadoEm;
      if (precisaReservar && balance.disponivel < valor) {
        const error = new Error('Saldo insuficiente para chamar esta entrega novamente.');
        error.status = 402;
        error.code = 'saldo_insuficiente';
        error.balance = balance;
        throw error;
      }

      const nextReserved = precisaReservar ? money(balance.reservado + valor) : balance.reservado;
      if (precisaReservar) {
        tx.set(companyRef, {
          reservado: nextReserved,
          atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        tx.set(ledgerRef(companyRef.id), {
          tipo: 'reserva',
          origem: 'entrega_renovada',
          entregaId: ref.id,
          valor,
          saldoAntes: balance.saldo,
          saldoDepois: balance.saldo,
          reservadoAntes: balance.reservado,
          reservadoDepois: nextReserved,
          criadoEm: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      renewedDelivery = { ...delivery, status: 'pendente' };
      tx.update(ref, {
        status: 'pendente',
        motoboy: '',
        motoboyCpf: '',
        motoboyCnh: '',
        motoboyTelefone: '',
        aceitaEm: null,
        expiradaEm: null,
        saldoLiberadoEm: admin.firestore.FieldValue.delete(),
        renovacoes: Number(delivery.renovacoes || 0) + 1,
        renovadaEm: admin.firestore.FieldValue.serverTimestamp(),
        criadaEm: admin.firestore.FieldValue.serverTimestamp(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    const telegram = await notifyTelegramAboutDelivery(ref.id, renewedDelivery).catch((error) => {
      console.error('telegram delivery renew notify failed', error);
      return { sent: false, failed: true };
    });
    const push = await notifyDriversAboutDelivery(ref.id, renewedDelivery).catch((error) => {
      console.error('push delivery renew notify failed', error);
      return { sent: 0, failed: 1 };
    });
    res.json({ ok: true, deliveryId: ref.id, telegram, push });
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

app.post('/api/admin/deliveries/:deliveryId/renew', assertOwner, async (req, res, next) => {
  try {
    const ref = db.collection('entregas').doc(String(req.params.deliveryId || ''));
    let renewedDelivery = null;

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        const error = new Error('Entrega nao encontrada.');
        error.status = 404;
        throw error;
      }

      const delivery = snap.data() || {};
      if (!['pendente', 'expirada'].includes(delivery.status)) {
        const error = new Error('Essa entrega nao pode ser chamada novamente agora.');
        error.status = 409;
        throw error;
      }

      const valor = money(delivery.saldoReservado || delivery.valor || 0);
      const companyRef = companyRefFromPhone(delivery.empresaId || delivery.telefoneEmpresa);
      if (!companyRef || valor <= 0) {
        const error = new Error('Dados da empresa invalidos para renovar a entrega.');
        error.status = 409;
        throw error;
      }

      const companySnap = await tx.get(companyRef);
      const balance = companyBalance(companySnap.exists ? companySnap.data() : {});
      const precisaReservar = delivery.status === 'expirada' || !!delivery.saldoLiberadoEm;
      if (precisaReservar && balance.disponivel < valor) {
        const error = new Error('Saldo insuficiente para chamar esta entrega novamente.');
        error.status = 402;
        throw error;
      }

      const nextReserved = precisaReservar ? money(balance.reservado + valor) : balance.reservado;
      if (precisaReservar) {
        tx.set(companyRef, {
          reservado: nextReserved,
          atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        tx.set(ledgerRef(companyRef.id), {
          tipo: 'reserva',
          origem: 'entrega_renovada_pelo_dono',
          entregaId: ref.id,
          valor,
          saldoAntes: balance.saldo,
          saldoDepois: balance.saldo,
          reservadoAntes: balance.reservado,
          reservadoDepois: nextReserved,
          criadoEm: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      renewedDelivery = { ...delivery, status: 'pendente' };
      tx.update(ref, {
        status: 'pendente',
        motoboy: '',
        motoboyCpf: '',
        motoboyCnh: '',
        motoboyTelefone: '',
        aceitaEm: null,
        expiradaEm: null,
        saldoLiberadoEm: admin.firestore.FieldValue.delete(),
        renovacoes: Number(delivery.renovacoes || 0) + 1,
        renovadaPeloDonoEm: admin.firestore.FieldValue.serverTimestamp(),
        criadaEm: admin.firestore.FieldValue.serverTimestamp(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    const telegram = await notifyTelegramAboutDelivery(ref.id, renewedDelivery).catch((error) => {
      console.error('telegram admin delivery renew notify failed', error);
      return { sent: false, failed: true };
    });
    const push = await notifyDriversAboutDelivery(ref.id, renewedDelivery).catch((error) => {
      console.error('push admin delivery renew notify failed', error);
      return { sent: 0, failed: 1 };
    });
    res.json({ ok: true, deliveryId: ref.id, telegram, push });
  } catch (error) {
    next(error);
  }
});

app.post('/api/rides/:rideId/accept', async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.body.driverCpf);
    if (driverCpf.length !== 11) return res.status(400).json({ error: 'driverCpf_invalido' });

    const driver = await getDriverWithProof(driverCpf, req.body);
    let acceptedRide = null;
    let alreadyAccepted = false;
    const rideRef = db.collection('corridas').doc(req.params.rideId);

    await db.runTransaction(async (tx) => {
      const rideSnap = await tx.get(rideRef);
      if (!rideSnap.exists) {
        const error = new Error('Corrida nao encontrada.');
        error.status = 404;
        throw error;
      }

      const ride = rideSnap.data();
      if (ride.status === 'aceita' && onlyDigits(ride.motoboyCpf) === driverCpf) {
        acceptedRide = ride;
        alreadyAccepted = true;
        return;
      }
      if (ride.status !== 'pendente') {
        const error = new Error(`Corrida ja foi aceita por ${ride.motoboy || 'outro motoboy'}.`);
        error.status = 409;
        throw error;
      }

      const city = rideOperatingCity(ride);
      if (!driverRideCities(driver)[city]) {
        const error = new Error(`Ative ${rideCityLabel(city)} no topo do app para aceitar esta corrida.`);
        error.status = 403;
        error.code = 'cidade_desativada';
        throw error;
      }

      acceptedRide = ride;
      tx.update(rideRef, {
        status: 'aceita',
        motoboy: driver.nome || req.body.driverName || '',
        motoboyCpf: driverCpf,
        motoboyCnh: driver.cnh || '',
        motoboyTelefone: driver.telefone || '',
        motoboyFoto: driver.fotoMotoboy || '',
        aceitaEm: admin.firestore.FieldValue.serverTimestamp(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    if (alreadyAccepted) {
      return res.json({
        ok: true,
        alreadyAccepted: true,
        payment: acceptedRide?.pagamento || null,
        job: privateDriverJob(serializeFirestore({ id: rideRef.id, ...acceptedRide }))
      });
    }

    let payment = null;
    try {
      payment = await createPaymentPreference(req.params.rideId, acceptedRide, driverCpf);
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
    } catch (paymentError) {
      console.error('ride driver mercado pago preference failed; using owner automatic fallback', paymentError);
      try {
        payment = await createOwnerRidePaymentPreference(req.params.rideId, acceptedRide, driverCpf);
        await rideRef.set({
          pagamento: {
            provider: 'mercadopago',
            receiver: 'motoja_owner',
            preferenceId: payment.preferenceId,
            initPoint: payment.initPoint,
            sandboxInitPoint: payment.sandboxInitPoint,
            status: 'preference_created',
            total: payment.total,
            appFee: payment.appFee,
            driverAmount: payment.driverAmount,
            ownerFallback: true,
            fallbackReason: paymentError.code || paymentError.message || 'driver_mercadopago_indisponivel',
            criadoEm: admin.firestore.FieldValue.serverTimestamp()
          },
          atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      } catch (ownerPaymentError) {
        console.error('ride owner mercado pago fallback failed; releasing ride', ownerPaymentError);
        await rideRef.set({
          status: 'pendente',
          motoboy: admin.firestore.FieldValue.delete(),
          motoboyCpf: admin.firestore.FieldValue.delete(),
          motoboyCnh: admin.firestore.FieldValue.delete(),
          motoboyTelefone: admin.firestore.FieldValue.delete(),
          motoboyFoto: admin.firestore.FieldValue.delete(),
          aceitaEm: admin.firestore.FieldValue.delete(),
          pagamento: {
            provider: 'mercadopago',
            status: 'preference_failed',
            erro: ownerPaymentError.code || ownerPaymentError.message || 'mercadopago_indisponivel',
            atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
          },
          atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        ownerPaymentError.status = ownerPaymentError.status || 503;
        ownerPaymentError.code = ownerPaymentError.code || 'mercadopago_indisponivel';
        throw ownerPaymentError;
      }
    }

    res.json({
      ok: true,
      payment,
      job: privateDriverJob(serializeFirestore({
        id: rideRef.id,
        ...acceptedRide,
        status: 'aceita',
        motoboy: driver.nome || req.body.driverName || '',
        motoboyCpf: driverCpf,
        motoboyCnh: driver.cnh || '',
        motoboyTelefone: driver.telefone || '',
        motoboyFoto: driver.fotoMotoboy || '',
        pagamento: payment ? {
          provider: 'mercadopago',
          preferenceId: payment.preferenceId,
          initPoint: payment.initPoint,
          sandboxInitPoint: payment.sandboxInitPoint,
          status: 'preference_created',
          total: payment.total,
          appFee: payment.appFee,
          driverAmount: payment.driverAmount
        } : acceptedRide?.pagamento || null
      }))
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/companies/me/active-deliveries', assertCompany, assertCompanyApproved, async (req, res, next) => {
  try {
    const snapshot = await db.collection('entregas')
      .where('empresaId', '==', req.companyId)
      .limit(100)
      .get();
    const deliveries = snapshot.docs
      .map((docSnap) => serializeFirestore({ id: docSnap.id, ...docSnap.data() }))
      .filter((delivery) => delivery.status === 'aceita' || delivery.status === 'retirada')
      .sort((a, b) => Number(timestampMs(b.aceitaEm)) - Number(timestampMs(a.aceitaEm)));
    return res.json({ ok: true, deliveries });
  } catch (error) {
    return next(error);
  }
});

// Compatibility for installed clients that still use the previous read-only status route.
app.get('/api/drivers/:cpf/mercadopago/status', async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.params.cpf);
    if (driverCpf.length !== 11) return res.status(400).json({ error: 'driverCpf_invalido' });
    const snap = await db.collection('motoboys').doc(driverCpf).get();
    if (!snap.exists) return res.status(404).json({ error: 'motoboy_nao_encontrado' });
    const driver = snap.data() || {};
    return res.json({
      ok: true,
      connected: !!driver.mercadoPago?.accessToken,
      legacyClient: true
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/deliveries/:deliveryId/pickup', async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.body.driverCpf);
    if (driverCpf.length !== 11) return res.status(400).json({ error: 'driverCpf_invalido' });
    await getDriverWithProof(driverCpf, req.body);

    const deliveryRef = db.collection('entregas').doc(req.params.deliveryId);
    let companyId = '';
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
      if (delivery.tipo === 'servico_exclusivo') {
        const error = new Error('Servico exclusivo nao usa rastreamento por retirada.');
        error.status = 409;
        error.code = 'servico_exclusivo_sem_rastreamento';
        throw error;
      }
      if (delivery.status !== 'aceita' && delivery.status !== 'retirada') {
        const error = new Error('Esta entrega nao pode iniciar o rastreamento.');
        error.status = 409;
        error.code = 'entrega_nao_esta_aceita';
        throw error;
      }
      companyId = onlyDigits(delivery.empresaId || delivery.telefoneEmpresa);
      if (delivery.status === 'aceita') {
        tx.update(deliveryRef, {
          status: 'retirada',
          retiradaConfirmadaEm: admin.firestore.FieldValue.serverTimestamp(),
          rastreamentoAtivo: true,
          atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    });

    emitDeliveryTracking(companyId, {
      deliveryId: req.params.deliveryId,
      status: 'retirada',
      rastreamentoAtivo: true
    });
    return res.json({ ok: true, status: 'retirada', tracking: true });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/deliveries/:deliveryId/location', async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.body.driverCpf);
    const latitude = Number(req.body.latitude);
    const longitude = Number(req.body.longitude);
    const accuracy = Math.max(0, Number(req.body.accuracy || 0));
    const clientTimestamp = Number(req.body.timestamp || Date.now());
    if (driverCpf.length !== 11) return res.status(400).json({ error: 'driverCpf_invalido' });
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return res.status(400).json({ error: 'coordenadas_invalidas' });
    }
    if (!Number.isFinite(clientTimestamp) || Math.abs(Date.now() - clientTimestamp) > 5 * 60 * 1000) {
      return res.status(400).json({ error: 'localizacao_fora_do_tempo' });
    }
    await getDriverWithProof(driverCpf, req.body);

    const deliveryRef = db.collection('entregas').doc(req.params.deliveryId);
    const deliverySnap = await deliveryRef.get();
    if (!deliverySnap.exists) return res.status(404).json({ error: 'entrega_nao_encontrada' });
    const delivery = deliverySnap.data();
    if (onlyDigits(delivery.motoboyCpf) !== driverCpf) {
      return res.status(409).json({ error: 'entrega_nao_pertence_ao_motoboy' });
    }
    if (delivery.status !== 'retirada' || delivery.rastreamentoAtivo === false) {
      return res.status(409).json({ error: 'rastreamento_nao_ativo' });
    }

    const location = {
      latitude,
      longitude,
      accuracy: Math.min(5000, accuracy),
      heading: Number.isFinite(Number(req.body.heading)) ? Number(req.body.heading) : null,
      speed: Number.isFinite(Number(req.body.speed)) ? Math.max(0, Number(req.body.speed)) : null,
      clientTimestamp,
      serverTimestampMs: Date.now()
    };
    await deliveryRef.set({
      motoboyLocalizacao: location,
      localizacaoAtualizadaEm: admin.firestore.FieldValue.serverTimestamp(),
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    emitDeliveryTracking(delivery.empresaId || delivery.telefoneEmpresa, {
      deliveryId: deliveryRef.id,
      status: 'retirada',
      rastreamentoAtivo: true,
      motoboy: delivery.motoboy || '',
      location
    });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/deliveries/:deliveryId/accept', async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.body.driverCpf);
    if (driverCpf.length !== 11) return res.status(400).json({ error: 'driverCpf_invalido' });

    const driver = await getDriverWithProof(driverCpf, req.body);
    const deliveryRef = db.collection('entregas').doc(req.params.deliveryId);

    let companyId = '';
    let acceptedDelivery = null;
    let alreadyAccepted = false;
    await db.runTransaction(async (tx) => {
      const deliverySnap = await tx.get(deliveryRef);
      if (!deliverySnap.exists) {
        const error = new Error('Entrega nao encontrada.');
        error.status = 404;
        throw error;
      }

      const delivery = deliverySnap.data();
      acceptedDelivery = delivery;
      companyId = onlyDigits(delivery.empresaId || delivery.telefoneEmpresa);
      if (delivery.status === 'aceita' && onlyDigits(delivery.motoboyCpf) === driverCpf) {
        alreadyAccepted = true;
        return;
      }
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
        motoboyFoto: driver.fotoMotoboy || '',
        aceitaEm: admin.firestore.FieldValue.serverTimestamp(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    if (alreadyAccepted) {
      return res.json({
        ok: true,
        alreadyAccepted: true,
        job: privateDriverJob(serializeFirestore({ id: deliveryRef.id, ...acceptedDelivery }))
      });
    }

    emitDeliveryTracking(companyId, {
      deliveryId: req.params.deliveryId,
      status: 'aceita',
      rastreamentoAtivo: false
    });
    res.json({
      ok: true,
      job: privateDriverJob(serializeFirestore({
        id: deliveryRef.id,
        ...acceptedDelivery,
        status: 'aceita',
        motoboy: driver.nome || req.body.driverName || '',
        motoboyCpf: driverCpf,
        motoboyCnh: driver.cnh || '',
        motoboyTelefone: driver.telefone || '',
        motoboyFoto: driver.fotoMotoboy || ''
      }))
    });
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

    const driverUrl = BACKEND_BASE_URL ? `${BACKEND_BASE_URL}/corrida/${req.params.rideId}` : '';
    const message = `Ola, ${ride.nome || 'cliente'}! Seu motoboy ${ride.motoboy || 'MotoJa Conchal'} aceitou a corrida e iniciou o trajeto com GPS.\n\nValor: ${money(ride.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}\nOrigem: ${ride.origem || '-'}\nDestino: ${ride.destino || '-'}${driverUrl ? `\n\nAcompanhe a foto e a localizacao do motoboy ao vivo:\n${driverUrl}` : ''}\n\n${ridePaymentInstructions(ride)}`;

    await rideRef.set({
      clienteAvisadoEm: admin.firestore.FieldValue.serverTimestamp(),
      clienteAvisadoPor: ride.motoboy || '',
      rastreamentoAtivo: true,
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
      rastreamentoAtivo: false,
      motoboyLocalizacao: admin.firestore.FieldValue.delete(),
      localizacaoAtualizadaEm: admin.firestore.FieldValue.delete(),
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

    emitDeliveryTracking(delivery.empresaId || delivery.telefoneEmpresa, {
      deliveryId: deliveryRef.id,
      status: 'cancelada',
      rastreamentoAtivo: false
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
    await db.runTransaction(async (tx) => {
      const rideSnap = await tx.get(rideRef);
      if (!rideSnap.exists) {
        const error = new Error('Corrida nao encontrada.');
        error.status = 404;
        error.code = 'corrida_nao_encontrada';
        throw error;
      }
      const ride = rideSnap.data() || {};
      if (onlyDigits(ride.motoboyCpf) !== driverCpf) {
        const error = new Error('Corrida nao pertence ao motoboy.');
        error.status = 409;
        error.code = 'corrida_nao_pertence_ao_motoboy';
        throw error;
      }
      if (ride.status === 'finalizada') {
        const error = new Error('Corrida ja finalizada.');
        error.status = 409;
        error.code = 'corrida_ja_finalizada';
        throw error;
      }
      if (!ride.clienteAvisadoEm) {
        const error = new Error('Avise o cliente antes de finalizar.');
        error.status = 409;
        error.code = 'avise_o_cliente_antes_de_finalizar';
        throw error;
      }
      if (ride.pagamento?.status !== 'approved' || ride.pagamento?.valido === false) {
        const error = new Error('Pagamento ainda nao aprovado.');
        error.status = 409;
        error.code = 'pagamento_ainda_nao_aprovado';
        throw error;
      }
      if (ride.status === 'cancelada') {
        const error = new Error('Corrida cancelada.');
        error.status = 409;
        error.code = 'corrida_cancelada';
        throw error;
      }

      const split = rideSplitAmounts(ride.pagamento?.total || ride.valor, ride.km);
      const event = driverEarningEvent('corrida', rideRef.id, { ...ride, ganhoMotoboy: split.driverAmount });
      await recordDriverEarning(tx, driverCpf, event);
      tx.set(rideRef, {
        status: 'finalizada',
        rastreamentoAtivo: false,
        motoboyLocalizacao: admin.firestore.FieldValue.delete(),
        localizacaoAtualizadaEm: admin.firestore.FieldValue.delete(),
        finalizadaEm: admin.firestore.FieldValue.serverTimestamp(),
        ganhoContabilizadoEm: admin.firestore.FieldValue.serverTimestamp(),
        ganhoMotoboy: split.driverAmount,
        ganhoApp: split.appFee,
        percentualMotoboy: split.driverPercent,
        percentualApp: split.appPercent,
        valorMotoboy: split.driverAmount,
        valorApp: split.appFee,
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/deliveries/:deliveryId/force-finish', assertOwner, async (req, res, next) => {
  try {
    const reason = String(req.body.reason || '').trim().slice(0, 250);
    const manualDriverCpf = onlyDigits(req.body.driverCpf);
    const requestedValue = money(req.body.valor);
    if (!reason) return res.status(400).json({ error: 'motivo_obrigatorio', message: 'Informe o motivo para finalizar pelo painel.' });
    const deliveryRef = db.collection('entregas').doc(String(req.params.deliveryId || ''));

    await db.runTransaction(async (tx) => {
      const deliverySnap = await tx.get(deliveryRef);
      if (!deliverySnap.exists) {
        const error = new Error('Entrega nao encontrada.');
        error.status = 404;
        throw error;
      }
      const delivery = deliverySnap.data();
      if (delivery.status === 'finalizada' || delivery.saldoDebitadoEm) {
        const error = new Error('Entrega ja foi finalizada ou debitada.');
        error.status = 409;
        throw error;
      }

      let driverCpf = onlyDigits(delivery.motoboyCpf);
      let driverData = null;
      if (driverCpf.length === 11) {
        driverData = {
          nome: delivery.motoboy || '',
          cpf: driverCpf,
          cnh: delivery.motoboyCnh || '',
          telefone: onlyDigits(delivery.motoboyTelefone),
          fotoMotoboy: delivery.motoboyFoto || ''
        };
      } else {
        if (manualDriverCpf.length !== 11) {
          const error = new Error('Informe o CPF do motoboy cadastrado que fez esta entrega.');
          error.status = 400;
          throw error;
        }
        const driverSnap = await tx.get(db.collection('motoboys').doc(manualDriverCpf));
        if (!driverSnap.exists) {
          const error = new Error('Motoboy nao cadastrado. Cadastre o motoboy antes de finalizar esta entrega.');
          error.status = 404;
          throw error;
        }
        const foundDriver = driverSnap.data() || {};
        driverCpf = manualDriverCpf;
        driverData = {
          nome: cleanText(foundDriver.nome || ''),
          cpf: driverCpf,
          cnh: onlyDigits(foundDriver.cnh),
          telefone: onlyDigits(foundDriver.telefone),
          fotoMotoboy: foundDriver.fotoMotoboy || ''
        };
      }

      const valorOriginal = money(delivery.saldoReservado || delivery.valor || 0);
      const valor = requestedValue > 0 ? requestedValue : valorOriginal;
      const companyRef = companyRefFromPhone(delivery.empresaId || delivery.telefoneEmpresa);
      if (!companyRef || valor <= 0 || valor > 5000) {
        const error = new Error('Dados de saldo da empresa invalidos.');
        error.status = 409;
        throw error;
      }

      const companySnap = await tx.get(companyRef);
      const balance = companyBalance(companySnap.exists ? companySnap.data() : {});
      if (balance.saldo < valor) {
        const error = new Error('Saldo total insuficiente para abater esta entrega.');
        error.status = 409;
        throw error;
      }

      const wasReserved = !delivery.saldoLiberadoEm;
      const nextSaldo = money(balance.saldo - valor);
      const nextReserved = wasReserved ? money(Math.max(0, balance.reservado - valor)) : balance.reservado;
      const adjustedDelivery = { ...delivery, valor, saldoReservado: valor };
      const split = deliverySplit(adjustedDelivery);
      const performedAtMs = manualDeliveryPerformedAtMs(delivery);
      const performedAt = admin.firestore.Timestamp.fromMillis(performedAtMs);
      const earningEvent = driverEarningEvent(
        'entrega',
        deliveryRef.id,
        { ...adjustedDelivery, ganhoMotoboy: split.driverAmount },
        performedAtMs
      );
      await recordDriverEarning(tx, driverCpf, earningEvent);

      tx.set(companyRef, {
        saldo: nextSaldo,
        reservado: nextReserved,
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      tx.set(ledgerRef(companyRef.id), {
        tipo: 'debito',
        origem: 'entrega_finalizada_pelo_dono',
        entregaId: deliveryRef.id,
        valor,
        valorOriginal,
        motivo: reason,
        motoboy: driverData.nome,
        motoboyCpf: driverCpf,
        saldoAntes: balance.saldo,
        saldoDepois: nextSaldo,
        reservadoAntes: balance.reservado,
        reservadoDepois: nextReserved,
        competenciaEm: performedAt,
        criadoEm: admin.firestore.FieldValue.serverTimestamp()
      });

      tx.update(deliveryRef, {
        status: 'finalizada',
        rastreamentoAtivo: false,
        motoboyLocalizacao: admin.firestore.FieldValue.delete(),
        localizacaoAtualizadaEm: admin.firestore.FieldValue.delete(),
        valor,
        saldoReservado: valor,
        valorOriginalAntesAjuste: valor !== valorOriginal ? valorOriginal : admin.firestore.FieldValue.delete(),
        valorAjustadoPeloDonoEm: valor !== valorOriginal ? admin.firestore.FieldValue.serverTimestamp() : admin.firestore.FieldValue.delete(),
        motoboy: driverData.nome,
        motoboyCpf: driverCpf,
        motoboyCnh: driverData.cnh,
        motoboyTelefone: driverData.telefone,
        motoboyFoto: driverData.fotoMotoboy,
        finalizadaEm: performedAt,
        realizadaEm: performedAt,
        ganhoContabilizadoEm: admin.firestore.FieldValue.serverTimestamp(),
        finalizadaPeloDonoEm: admin.firestore.FieldValue.serverTimestamp(),
        finalizadaPeloDonoMotivo: reason,
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

    const finishedDelivery = await deliveryRef.get();
    const finishedData = finishedDelivery.data() || {};
    emitDeliveryTracking(finishedData.empresaId || finishedData.telefoneEmpresa, {
      deliveryId: deliveryRef.id,
      status: 'finalizada',
      rastreamentoAtivo: false
    });
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
      const exclusiveService = delivery.tipo === 'servico_exclusivo';
      if (delivery.status !== 'retirada' && !(exclusiveService && delivery.status === 'aceita')) {
        const error = new Error('Confirme a retirada do pedido antes de finalizar a entrega.');
        error.status = 409;
        error.code = 'confirme_retirada_antes_de_finalizar';
        throw error;
      }
      if (delivery.saldoDebitadoEm) {
        const error = new Error('Entrega ja foi debitada.');
        error.status = 409;
        error.code = 'entrega_ja_debitada';
        throw error;
      }

      if (!exclusiveService) {
        const pickupMs = timestampMs(delivery.retiradaConfirmadaEm);
        if (!pickupMs || Date.now() - pickupMs < 30 * 1000) {
          const error = new Error('Aguarde alguns segundos apos confirmar a retirada antes de finalizar.');
          error.status = 409;
          error.code = 'finalizacao_rapida_demais';
          throw error;
        }
        const location = delivery.motoboyLocalizacao || {};
        const locationMs = Number(location.serverTimestampMs || timestampMs(delivery.localizacaoAtualizadaEm));
        if (!locationMs || Date.now() - locationMs > 10 * 60 * 1000) {
          const error = new Error('Atualize sua localizacao perto do destino antes de finalizar.');
          error.status = 409;
          error.code = 'localizacao_finalizacao_desatualizada';
          throw error;
        }
        const finalExtra = Array.isArray(delivery.pontosExtras) && delivery.pontosExtras.length
          ? delivery.pontosExtras[delivery.pontosExtras.length - 1]
          : null;
        const finalDestination = finalExtra
          ? { lat: finalExtra.lat, lon: finalExtra.lon }
          : { lat: delivery.entregaLat, lon: delivery.entregaLon };
        const distanceToDestination = coordinateDistanceKm(
          { lat: location.latitude, lon: location.longitude },
          finalDestination
        );
        const allowedDistanceKm = Math.max(2, Math.min(5, Number(location.accuracy || 0) / 1000 + 0.5));
        if (!Number.isFinite(distanceToDestination) || distanceToDestination > allowedDistanceKm) {
          const error = new Error('Chegue mais perto do endereco de entrega para finalizar.');
          error.status = 409;
          error.code = 'motoboy_longe_do_destino';
          throw error;
        }
      }

      const valor = money(delivery.saldoReservado || delivery.valor || 0);
      const split = deliverySplit(delivery);
      const quantidadeExclusivo = delivery.tipo === 'servico_exclusivo'
        ? Math.max(0, Math.min(300, Math.floor(Number(req.body.quantidadeEntregasExclusivo || 0))))
        : 0;
      const companyRef = companyRefFromPhone(delivery.empresaId || delivery.telefoneEmpresa);
      if (!companyRef || valor <= 0) {
        const error = new Error('Dados de saldo da empresa invalidos.');
        error.status = 409;
        error.code = 'saldo_empresa_invalido';
        throw error;
      }

      const companySnap = await tx.get(companyRef);
      const balance = companyBalance(companySnap.exists ? companySnap.data() : {});
      if (balance.reservado < valor) {
        const error = new Error('A reserva da empresa nao cobre esta entrega. Chame o suporte antes de finalizar.');
        error.status = 409;
        error.code = 'saldo_reservado_insuficiente';
        throw error;
      }
      const nextSaldo = money(balance.saldo - valor);
      const nextReserved = money(Math.max(0, balance.reservado - valor));
      const earningEvent = driverEarningEvent('entrega', deliveryRef.id, { ...delivery, valor, ganhoMotoboy: split.driverAmount });
      await recordDriverEarning(tx, driverCpf, earningEvent);

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
        rastreamentoAtivo: false,
        motoboyLocalizacao: admin.firestore.FieldValue.delete(),
        localizacaoAtualizadaEm: admin.firestore.FieldValue.delete(),
        finalizadaEm: admin.firestore.FieldValue.serverTimestamp(),
        ganhoContabilizadoEm: admin.firestore.FieldValue.serverTimestamp(),
        saldoDebitadoEm: admin.firestore.FieldValue.serverTimestamp(),
        ganhoMotoboy: split.driverAmount,
        ganhoApp: split.appFee,
        percentualMotoboy: split.driverPercent,
        percentualApp: split.appPercent,
        valorMotoboy: split.driverAmount,
        valorApp: split.appFee,
        quantidadeEntregasExclusivo: quantidadeExclusivo || admin.firestore.FieldValue.delete(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    const finishedDelivery = await deliveryRef.get();
    const finishedData = finishedDelivery.data() || {};
    emitDeliveryTracking(finishedData.empresaId || finishedData.telefoneEmpresa, {
      deliveryId: deliveryRef.id,
      status: 'finalizada',
      rastreamentoAtivo: false
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/drivers/:cpf/mercadopago/oauth-link', authLimiter, async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.params.cpf);
    if (driverCpf.length !== 11) return res.status(400).json({ error: 'driverCpf_invalido' });
    await getDriverWithProof(driverCpf, req.body);

    const state = crypto.randomBytes(32).toString('hex');
    await db.collection('mercadoPagoOAuthStates').doc(hashSecret(state)).set({
      driverCpf,
      expiresAtMs: Date.now() + MP_OAUTH_STATE_MS,
      criadaEm: admin.firestore.FieldValue.serverTimestamp()
    });
    const params = new URLSearchParams({
      client_id: requiredEnv('MP_CLIENT_ID'),
      response_type: 'code',
      platform_id: 'mp',
      state,
      redirect_uri: requiredEnv('MP_REDIRECT_URI')
    });
    return res.json({ ok: true, url: `https://auth.mercadopago.com.br/authorization?${params.toString()}` });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/rides/:rideId/location', async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.body.driverCpf);
    const latitude = Number(req.body.latitude);
    const longitude = Number(req.body.longitude);
    const accuracy = Math.max(0, Number(req.body.accuracy || 0));
    const clientTimestamp = Number(req.body.timestamp || Date.now());
    if (driverCpf.length !== 11) return res.status(400).json({ error: 'driverCpf_invalido' });
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return res.status(400).json({ error: 'coordenadas_invalidas' });
    }
    if (!Number.isFinite(clientTimestamp) || Math.abs(Date.now() - clientTimestamp) > 5 * 60 * 1000) {
      return res.status(400).json({ error: 'localizacao_fora_do_tempo' });
    }
    await getDriverWithProof(driverCpf, req.body);

    const rideRef = db.collection('corridas').doc(req.params.rideId);
    const rideSnap = await rideRef.get();
    if (!rideSnap.exists) return res.status(404).json({ error: 'corrida_nao_encontrada' });
    const ride = rideSnap.data();
    if (onlyDigits(ride.motoboyCpf) !== driverCpf) {
      return res.status(409).json({ error: 'corrida_nao_pertence_ao_motoboy' });
    }
    if (ride.status !== 'aceita' || !ride.clienteAvisadoEm || ride.rastreamentoAtivo === false) {
      return res.status(409).json({ error: 'rastreamento_nao_ativo' });
    }

    await rideRef.set({
      motoboyLocalizacao: {
        latitude,
        longitude,
        accuracy: Math.min(5000, accuracy),
        heading: Number.isFinite(Number(req.body.heading)) ? Number(req.body.heading) : null,
        speed: Number.isFinite(Number(req.body.speed)) ? Math.max(0, Number(req.body.speed)) : null,
        clientTimestamp,
        serverTimestampMs: Date.now()
      },
      localizacaoAtualizadaEm: admin.firestore.FieldValue.serverTimestamp(),
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/mercadopago/oauth/start', (_req, res) => {
  const updatedPanel = `${appUrl('/motoboy.html')}?v=138&reconnect=mercadopago`;
  res.set('cache-control', 'no-store');
  return res.redirect(302, updatedPanel);
});

app.get('/api/mercadopago/oauth/callback', async (req, res, next) => {
  try {
    if (req.query.error) {
      const detail = escapeHtml(String(req.query.error_description || req.query.error || 'Autorizacao recusada pelo Mercado Pago.').slice(0, 400));
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
    const state = String(req.query.state || '').trim();
    if (!code || !/^[a-f0-9]{64}$/i.test(state)) {
      return res.status(400).send('Autorizacao invalida.');
    }
    const stateRef = db.collection('mercadoPagoOAuthStates').doc(hashSecret(state));
    let driverCpf = '';
    await db.runTransaction(async (tx) => {
      const stateSnap = await tx.get(stateRef);
      const stateData = stateSnap.exists ? stateSnap.data() || {} : {};
      driverCpf = onlyDigits(stateData.driverCpf);
      if (!stateSnap.exists || driverCpf.length !== 11 || Number(stateData.expiresAtMs || 0) < Date.now()) {
        const error = new Error('Autorizacao expirada ou ja utilizada.');
        error.status = 400;
        error.code = 'oauth_state_invalido';
        throw error;
      }
      tx.delete(stateRef);
    });

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
          <p>${escapeHtml(String(detail).slice(0, 400))}</p>
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

app.post('/api/rides/:rideId/payment/point-order', createRideLimiter, async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.body.driverCpf);
    if (driverCpf.length !== 11) return res.status(400).json({ error: 'driverCpf_invalido' });
    await getDriverWithProof(driverCpf, req.body);

    const rideRef = db.collection('corridas').doc(String(req.params.rideId || ''));
    const rideSnap = await rideRef.get();
    if (!rideSnap.exists) return res.status(404).json({ error: 'corrida_nao_encontrada' });
    const ride = rideSnap.data() || {};
    if (onlyDigits(ride.motoboyCpf) !== driverCpf) {
      return res.status(409).json({ error: 'corrida_nao_pertence_ao_motoboy' });
    }
    if (ride.status !== 'aceita') {
      return res.status(409).json({ error: 'corrida_nao_esta_em_andamento', message: 'A corrida precisa estar aceita para cobrar por aproximacao.' });
    }
    if (ride.pagamentoConfirmadoEm || ride.pagamento?.status === 'approved') {
      return res.status(409).json({ error: 'pagamento_ja_aprovado', message: 'Pagamento desta corrida ja consta como aprovado.' });
    }

    const pointOrder = await createPointPaymentOrder(rideSnap.id, ride, driverCpf);
    await rideRef.set({
      pagamento: {
        ...(ride.pagamento || {}),
        provider: 'mercadopago',
        point: {
          orderId: pointOrder.orderId,
          externalReference: pointOrder.externalReference,
          terminalId: pointOrder.terminalId,
          status: pointOrder.status,
          statusDetail: pointOrder.statusDetail,
          total: pointOrder.total,
          appFee: pointOrder.appFee,
          driverAmount: pointOrder.driverAmount,
          criadoEm: admin.firestore.FieldValue.serverTimestamp()
        },
        status: ride.pagamento?.status || 'point_order_created',
        total: ride.pagamento?.total || pointOrder.total,
        appFee: ride.pagamento?.appFee || pointOrder.appFee,
        driverAmount: ride.pagamento?.driverAmount || pointOrder.driverAmount
      },
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.status(201).json({
      ok: true,
      message: 'Cobranca enviada para o terminal Mercado Pago Point. Aproxime o cartao no celular/maquininha cadastrada.',
      ...pointOrder
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/rides/:rideId/payment/point-order/status', createRideLimiter, async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.body.driverCpf);
    if (driverCpf.length !== 11) return res.status(400).json({ error: 'driverCpf_invalido' });
    await getDriverWithProof(driverCpf, req.body);

    const rideRef = db.collection('corridas').doc(String(req.params.rideId || ''));
    const rideSnap = await rideRef.get();
    if (!rideSnap.exists) return res.status(404).json({ error: 'corrida_nao_encontrada' });
    const ride = rideSnap.data() || {};
    if (onlyDigits(ride.motoboyCpf) !== driverCpf) {
      return res.status(409).json({ error: 'corrida_nao_pertence_ao_motoboy' });
    }
    const orderId = String(ride.pagamento?.point?.orderId || '');
    if (!orderId) return res.status(404).json({ error: 'point_order_nao_encontrada', message: 'Nenhuma cobranca por aproximacao foi criada para esta corrida.' });

    const order = await mpFetch(`/v1/orders/${encodeURIComponent(orderId)}`, {
      token: requiredEnv('MP_OWNER_ACCESS_TOKEN')
    });
    await rideRef.set({
      pagamento: {
        ...(ride.pagamento || {}),
        point: {
          ...(ride.pagamento?.point || {}),
          status: order.status || ride.pagamento?.point?.status || '',
          statusDetail: order.status_detail || ride.pagamento?.point?.statusDetail || '',
          atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
        }
      },
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({
      ok: true,
      orderId,
      status: order.status || '',
      statusDetail: order.status_detail || '',
      paymentStatus: order.transactions?.payments?.[0]?.status || ''
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/rides/:rideId/payment/presential-report', createRideLimiter, async (req, res, next) => {
  try {
    const driverCpf = onlyDigits(req.body.driverCpf);
    const codigo = cleanText(req.body.codigo || req.body.comprovante || '', 80);
    const observacao = cleanText(req.body.observacao || '', 180);
    if (driverCpf.length !== 11) return res.status(400).json({ error: 'driverCpf_invalido' });
    if (!codigo) {
      return res.status(400).json({
        error: 'codigo_pagamento_obrigatorio',
        message: 'Informe o codigo/autorizacao do comprovante para registrar pagamento por aproximacao.'
      });
    }
    await getDriverWithProof(driverCpf, req.body);

    const rideRef = db.collection('corridas').doc(String(req.params.rideId || ''));
    const rideSnap = await rideRef.get();
    if (!rideSnap.exists) return res.status(404).json({ error: 'corrida_nao_encontrada' });
    const ride = rideSnap.data() || {};
    if (onlyDigits(ride.motoboyCpf) !== driverCpf) {
      return res.status(409).json({ error: 'corrida_nao_pertence_ao_motoboy' });
    }
    if (ride.status !== 'aceita') {
      return res.status(409).json({ error: 'corrida_nao_esta_em_andamento', message: 'A corrida precisa estar aceita para registrar pagamento presencial.' });
    }
    if (!ride.clienteAvisadoEm) {
      return res.status(409).json({ error: 'avise_o_cliente_antes_de_registrar_pagamento', message: 'Avise o cliente antes de registrar pagamento presencial.' });
    }

    await rideRef.set({
      pagamento: {
        ...(ride.pagamento || {}),
        provider: ride.pagamento?.provider || 'mercadopago',
        status: 'presencial_em_conferencia',
        valido: false,
        presencialManual: {
          tipo: 'aproximacao_manual',
          codigo,
          observacao,
          valorInformado: money(ride.valor),
          motoboy: ride.motoboy || '',
          motoboyCpf: driverCpf,
          informadoEm: admin.firestore.FieldValue.serverTimestamp()
        }
      },
      atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({
      ok: true,
      message: 'Pagamento por aproximacao registrado para conferencia do dono. O link/Pix continua disponivel como alternativa.'
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

    const webhookDriverCpf = onlyDigits(req.query.driverCpf);
    let payment;
    let paymentSource = 'owner';
    try {
      payment = await mpFetch(`/v1/payments/${paymentId}`, {
        token: requiredEnv('MP_OWNER_ACCESS_TOKEN')
      });
    } catch (ownerError) {
      if (webhookDriverCpf.length !== 11) throw ownerError;
      const driverSnap = await db.collection('motoboys').doc(webhookDriverCpf).get();
      const sellerToken = driverSnap.data()?.mercadoPago?.accessToken;
      if (!sellerToken) throw ownerError;
      payment = await mpFetch(`/v1/payments/${paymentId}`, { token: sellerToken });
      paymentSource = 'driver';
    }

    if (String(payment.id) !== String(paymentId)) {
      return res.status(409).json({ error: 'mercadopago_payment_id_divergente' });
    }
    const externalReference = String(payment.external_reference || '').trim();
    const metadataRideRef = String(payment.metadata?.ride_id || '').trim();
    const hintedRideRef = String(req.query.rideId || '').trim();
    const normalizedRideRef = (value) => String(value || '').replace(/^ride_/, '');
    if (externalReference && metadataRideRef
      && normalizedRideRef(externalReference) !== normalizedRideRef(metadataRideRef)) {
      return res.status(409).json({ error: 'mercadopago_referencia_divergente' });
    }
    const authoritativeReference = externalReference || metadataRideRef;
    if (hintedRideRef && authoritativeReference
      && normalizedRideRef(hintedRideRef) !== normalizedRideRef(authoritativeReference)) {
      return res.status(409).json({ error: 'mercadopago_webhook_alvo_divergente' });
    }

    const paymentKind = String(payment.metadata?.payment_kind || '');
    if (authoritativeReference.startsWith('deposit:') || paymentKind === 'company_deposit') {
      const depositId = String(payment.metadata?.deposit_id || authoritativeReference.replace(/^deposit:/, '')).trim();
      const paymentStatus = String(payment.status || '');
      if (!depositId) return res.status(200).json({ ignored: true });
      const expectedReference = `deposit:${depositId}`;
      if (paymentSource !== 'owner'
        || paymentKind !== 'company_deposit'
        || externalReference !== expectedReference
        || String(payment.metadata?.deposit_id || '') !== depositId
        || String(payment.currency_id || '').toUpperCase() !== 'BRL') {
        return res.status(409).json({ error: 'deposito_mercadopago_nao_autentico' });
      }

      const depositRef = db.collection('depositos').doc(depositId);
      await db.runTransaction(async (tx) => {
        const depositSnap = await tx.get(depositRef);
        if (!depositSnap.exists) return;
        const deposit = depositSnap.data() || {};
        const companyRef = companyRefFromPhone(deposit.empresaId || deposit.telefoneEmpresa);
        if (!companyRef) return;
        if (onlyDigits(payment.metadata?.company_id) !== companyRef.id) {
          const error = new Error('Pagamento nao pertence a esta empresa.');
          error.status = 409;
          error.code = 'deposito_empresa_divergente';
          throw error;
        }
        const usageRef = db.collection('mercadoPagoPagamentos').doc(hashSecret(String(payment.id)));
        const [usageSnap, companySnap] = await Promise.all([tx.get(usageRef), tx.get(companyRef)]);
        const expectedTarget = `deposit:${depositId}`;
        if (usageSnap.exists && usageSnap.data()?.target !== expectedTarget) {
          const error = new Error('Pagamento Mercado Pago ja vinculado a outra operacao.');
          error.status = 409;
          error.code = 'pagamento_mercadopago_reutilizado';
          throw error;
        }

        const alreadyCredited = !!deposit.aprovadoEm || deposit.status === 'aprovado';
        const wasReversed = !!deposit.creditoEstornadoEm;
        const valor = money(deposit.valor);
        const totalPago = money(payment.transaction_amount);
        const taxaMercadoPago = money(payment.fee_details?.reduce?.((sum, fee) => sum + Number(fee.amount || 0), 0) || payment.marketplace_fee || 0);
        const valorLiquido = money(payment.transaction_details?.net_received_amount || Math.max(0, totalPago - taxaMercadoPago));
        const amountMatches = Math.abs(totalPago - valor) <= 0.01;
        const reversalStatuses = new Set(['refunded', 'charged_back', 'cancelled']);

        const updateDeposit = {
          status: wasReversed
            ? 'credito_estornado'
            : paymentStatus === 'approved' && amountMatches ? 'aprovado' : paymentStatus || 'aguardando_pagamento',
          mercadoPago: {
            ...(deposit.mercadoPago || {}),
            paymentId: String(payment.id),
            status: paymentStatus,
            statusDetail: payment.status_detail || null,
            totalPago: money(payment.transaction_amount),
            taxaMercadoPago: money(payment.fee_details?.reduce?.((sum, fee) => sum + Number(fee.amount || 0), 0) || payment.marketplace_fee || 0),
            valorLiquido: money(payment.transaction_details?.net_received_amount || payment.transaction_amount || 0),
            atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
          },
          atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
        };

        if (reversalStatuses.has(paymentStatus) && alreadyCredited && !wasReversed) {
          const before = companyBalance(companySnap.exists ? companySnap.data() : {});
          const debit = money(deposit.valorCreditado || valorLiquido || valor);
          const afterSaldo = money(before.saldo - debit);
          tx.set(companyRef, {
            saldo: afterSaldo,
            reservado: before.reservado,
            bloqueioFinanceiro: afterSaldo < before.reservado,
            ultimoEstornoMercadoPagoEm: admin.firestore.FieldValue.serverTimestamp(),
            atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          tx.set(ledgerRef(companyRef.id), {
            tipo: 'debito',
            origem: 'estorno_deposito_mercadopago',
            depositoId,
            paymentId: String(payment.id),
            valor: debit,
            saldoAntes: before.saldo,
            saldoDepois: afterSaldo,
            reservadoAntes: before.reservado,
            reservadoDepois: before.reservado,
            criadoEm: admin.firestore.FieldValue.serverTimestamp()
          });
          tx.set(usageRef, {
            target: expectedTarget,
            paymentId: String(payment.id),
            status: paymentStatus,
            atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          tx.set(depositRef, {
            ...updateDeposit,
            status: 'credito_estornado',
            creditoEstornadoEm: admin.firestore.FieldValue.serverTimestamp(),
            valorEstornado: debit
          }, { merge: true });
          return;
        }

        if (paymentStatus !== 'approved' || alreadyCredited || wasReversed) {
          tx.set(depositRef, updateDeposit, { merge: true });
          return;
        }

        if (!amountMatches) {
          tx.set(depositRef, {
            ...updateDeposit,
            status: 'pagamento_divergente',
            divergencia: {
              esperado: valor,
              recebido: totalPago,
              motivo: 'valor_pago_diferente_do_deposito'
            }
          }, { merge: true });
          return;
        }

        const before = companyBalance(companySnap.exists ? companySnap.data() : {});
        const afterSaldo = money(before.saldo + valorLiquido);
        tx.set(companyRef, {
          saldo: afterSaldo,
          reservado: before.reservado,
          pagamentoModo: 'mercadopago',
          ultimoDepositoMercadoPagoEm: admin.firestore.FieldValue.serverTimestamp(),
          atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        tx.set(ledgerRef(companyRef.id), {
          tipo: 'credito',
          origem: 'deposito_mercadopago_aprovado',
          depositoId: depositRef.id,
          valor: valorLiquido,
          valorBruto: totalPago,
          taxaMercadoPago,
          saldoAntes: before.saldo,
          saldoDepois: afterSaldo,
          reservadoAntes: before.reservado,
          reservadoDepois: before.reservado,
          criadoEm: admin.firestore.FieldValue.serverTimestamp()
        });
        tx.set(usageRef, {
          target: expectedTarget,
          paymentId: String(payment.id),
          status: paymentStatus,
          criadoEm: admin.firestore.FieldValue.serverTimestamp(),
          atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        tx.set(depositRef, {
          ...updateDeposit,
          aprovadoEm: admin.firestore.FieldValue.serverTimestamp(),
          aprovadoPor: 'mercadopago_webhook',
          valorCreditado: valorLiquido,
          valorBruto: totalPago,
          taxaMercadoPago
        }, { merge: true });
      });

      return res.json({ ok: true, kind: 'company_deposit' });
    }
    const rideId = normalizedRideRef(authoritativeReference);
    if (!rideId || rideId.startsWith('deposit:')) return res.status(200).json({ ignored: true });
    if (!externalReference || !metadataRideRef
      || normalizedRideRef(metadataRideRef) !== rideId
      || String(payment.currency_id || '').toUpperCase() !== 'BRL') {
      return res.status(409).json({ error: 'corrida_mercadopago_nao_autentica' });
    }

    const rideRef = db.collection('corridas').doc(rideId);
    const usageRef = db.collection('mercadoPagoPagamentos').doc(hashSecret(String(payment.id)));
    await db.runTransaction(async (tx) => {
      const [rideSnap, usageSnap] = await Promise.all([tx.get(rideRef), tx.get(usageRef)]);
      if (!rideSnap.exists) {
        const error = new Error('Corrida do pagamento nao encontrada.');
        error.status = 404;
        error.code = 'corrida_pagamento_nao_encontrada';
        throw error;
      }
      const ride = rideSnap.data() || {};
      const target = `ride:${rideId}`;
      if (usageSnap.exists && usageSnap.data()?.target !== target) {
        const error = new Error('Pagamento Mercado Pago ja vinculado a outra operacao.');
        error.status = 409;
        error.code = 'pagamento_mercadopago_reutilizado';
        throw error;
      }
      const rideDriverCpf = onlyDigits(ride.motoboyCpf);
      const metadataDriverCpf = onlyDigits(payment.metadata?.driver_cpf);
      if ((metadataDriverCpf && metadataDriverCpf !== rideDriverCpf)
        || (webhookDriverCpf && webhookDriverCpf !== rideDriverCpf)
        || (paymentSource === 'driver' && webhookDriverCpf !== rideDriverCpf)) {
        const error = new Error('Pagamento nao pertence ao motoboy desta corrida.');
        error.status = 409;
        error.code = 'pagamento_motoboy_divergente';
        throw error;
      }

      const totalPago = money(payment.transaction_amount);
      const valorEsperado = money(ride.pagamento?.total || ride.valor || 0);
      const pagamentoAprovado = payment.status === 'approved';
      const valorConfere = valorEsperado > 0 && Math.abs(totalPago - valorEsperado) <= 0.01;
      tx.set(usageRef, {
        target,
        paymentId: String(payment.id),
        status: String(payment.status || ''),
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      tx.update(rideRef, {
        pagamento: {
          ...(ride.pagamento || {}),
          provider: 'mercadopago',
          paymentId: String(payment.id),
          status: payment.status,
          statusDetail: payment.status_detail || null,
          totalPago,
          valorEsperado,
          valido: pagamentoAprovado && valorConfere,
          divergencia: pagamentoAprovado && !valorConfere
            ? `Valor pago ${totalPago.toFixed(2)} diferente do esperado ${valorEsperado.toFixed(2)}`
            : null,
          appFee: money(payment.marketplace_fee || payment.metadata?.app_fee || ride.pagamento?.appFee || 0),
          driverAmount: money(payment.metadata?.driver_amount || ride.pagamento?.driverAmount || 0),
          atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
        },
        pagamentoConfirmadoEm: pagamentoAprovado && valorConfere
          ? admin.firestore.FieldValue.serverTimestamp()
          : admin.firestore.FieldValue.delete(),
        atualizadaEm: admin.firestore.FieldValue.serverTimestamp()
      });
    });

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

async function scheduledCleanup() {
  if (cleanupRunning) return;
  cleanupRunning = true;
  try {
    await cleanupRides();
  } catch (error) {
    console.error('cleanup failed', error);
  } finally {
    cleanupRunning = false;
  }
}

setInterval(scheduledCleanup, CLEANUP_INTERVAL_MS);

setInterval(() => {
  runCustomerReminderTick().catch((error) => console.error('customer reminder failed', error));
}, 60 * 1000);
runCustomerReminderTick().catch((error) => console.error('customer reminder startup failed', error));


app.use((error, _req, res, _next) => {
  console.error(error);
  const quotaExceeded = Number(error?.code) === 8 || String(error?.code || '').toUpperCase() === 'RESOURCE_EXHAUSTED';
  if (quotaExceeded) {
    return res.status(503).json({
      error: 'banco_temporariamente_indisponivel',
      message: 'O banco atingiu o limite temporario de uso. Tente novamente mais tarde ou fale com o suporte.'
    });
  }
  const status = Number(error.status || 500);
  res.status(status).json({
    error: error.code || 'internal_error',
    message: status >= 500 ? 'Erro interno. Tente novamente ou fale com o suporte.' : error.message,
    currentStatus: error.currentStatus || undefined,
    motoboy: error.motoboy || undefined
  });
});

httpServer.listen(PORT, () => {
  console.log(`MotoJa Conchal backend listening on ${PORT}`);
  manualDeliveryDateMigrationStatus = { status: 'running' };
  migrateManualDeliveryEarningDates()
    .then((result) => {
      manualDeliveryDateMigrationStatus = { status: 'completed', ...result };
      console.log('manual delivery date migration', result);
    })
    .catch((error) => {
      manualDeliveryDateMigrationStatus = { status: 'error' };
      console.error('manual delivery date migration failed', error);
    });
});
