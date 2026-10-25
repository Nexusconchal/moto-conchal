// Lote "endereco pela nota": a lista de enderecos que o motoboy monta no celular,
// guardada no servidor para a empresa e o dono acompanharem.
// Tambem guarda onde cada endereco realmente fica (GPS do motoboy ao marcar entregue),
// para a proxima busca desse endereco cair no ponto certo.
import crypto from 'node:crypto';
import { stripAccents } from './conchal-gazetteer.js';

export const STOP_STATUS = ['pendente', 'entregue', 'nao_encontrado'];
export const STOP_PROBLEMS = {
  ninguem_atende: 'Ninguém atende no endereço',
  endereco_nao_existe: 'Não achei o endereço',
  cliente_recusou: 'Cliente recusou o pedido',
  outro: 'Outro problema'
};

const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const coord = (value, limit) => {
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= limit && n !== 0 ? Math.round(n * 1e6) / 1e6 : 0;
};

function cleanGps(gps) {
  const lat = coord(gps?.lat, 90);
  const lon = coord(gps?.lon, 180);
  const precisao = Number(gps?.precisao);
  if (!lat || !lon) return null;
  return { lat, lon, precisao: Number.isFinite(precisao) && precisao >= 0 ? Math.round(precisao) : 9999, em: Number(gps?.em) || 0 };
}

// Aceita so o formato esperado; o celular e a fonte da lista, o servidor so confere.
export function sanitizeStops(list, max = 40) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const stops = [];
  for (const item of list.slice(0, max)) {
    const id = String(item?.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 24);
    const texto = text(item?.texto, 160);
    if (!id || seen.has(id) || texto.length < 3) continue;
    seen.add(id);
    const status = item?.entregue === true ? 'entregue' : STOP_STATUS.includes(item?.status) ? item.status : 'pendente';
    stops.push({
      id,
      texto,
      encontrado: text(item?.encontrado, 200),
      lat: coord(item?.lat, 90),
      lon: coord(item?.lon, 180),
      status,
      entregueEm: status === 'entregue' ? Number(item?.entregueEm) || 0 : 0,
      problema: status === 'nao_encontrado' && STOP_PROBLEMS[item?.problema] ? item.problema : '',
      gpsEntrega: status === 'entregue' ? cleanGps(item?.gpsEntrega) : null
    });
  }
  return stops;
}

export function stopsSummary(stops = [], total = 0) {
  return {
    total: Math.max(Number(total) || 0, stops.length),
    adicionados: stops.length,
    entregues: stops.filter(stop => stop.status === 'entregue').length,
    problemas: stops.filter(stop => stop.status === 'nao_encontrado').length
  };
}

// Paradas que acabaram de ser marcadas como entregues (para aprender o endereco).
export function newlyDelivered(previous = [], next = []) {
  const before = new Map(previous.map(stop => [stop.id, stop.status]));
  return next.filter(stop => stop.status === 'entregue' && before.get(stop.id) !== 'entregue');
}

const WORDS = { r: 'rua', av: 'avenida', avd: 'avenida', jd: 'jardim', jdm: 'jardim', res: 'residencial', vl: 'vila', pq: 'parque',
  tv: 'travessa', trav: 'travessa', est: 'estrada', rod: 'rodovia', al: 'alameda', cond: 'condominio', dr: 'doutor', prof: 'professor' };
const DROP = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'n', 'no', 'num', 'numero', 'sp', 'brasil', 'casa', 'bairro', 'cep']);
const CITIES = /\b(conchal|aguai|engenheiro coelho|eng coelho|martinho prado|tujuguaba|iate|araras|limeira|mogi mirim|mogi guacu|artur nogueira|leme|estiva gerbi)\b/g;

// "R. das Azaleias, nº 65 - Centro, Conchal/SP" -> "rua azaleias 65 centro"
export function normalizeAddressKey(value) {
  return stripAccents(value)
    .replace(/\b\d{5}-?\d{3}\b/g, ' ')
    .replace(/[º°ª]/g, ' ')
    .replace(CITIES, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(word => WORDS[word] || word)
    .filter(word => !DROP.has(word))
    .join(' ')
    .slice(0, 160);
}

// Duas chaves: o texto inteiro e "rua + numero" (a mesma casa escrita com bairro diferente).
export function addressKeys(value, city = 'conchal') {
  const full = normalizeAddressKey(value);
  if (full.length < 4) return [];
  const place = String(city || 'conchal').replace(/[^a-z_]/g, '') || 'conchal';
  const keys = [`${place}:${full}`];
  const streetNumber = full.match(/^((?:rua|avenida|travessa|estrada|rodovia|alameda|praca|viela)\s+[a-z0-9 ]*?[a-z][a-z0-9 ]*?)\s+(\d{1,5}[a-z]?)\b/);
  if (streetNumber) keys.push(`${place}:${streetNumber[1]}#${streetNumber[2]}`);
  return [...new Set(keys)];
}

const meters = (a, b) => Math.hypot((a.lon - b.lon) * 102000, (a.lat - b.lat) * 111000);
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Ponto aprendido de um endereco: mediana dos GPS de entrega. Se os pontos discordam
// (mais de 250 m), nao usa ate ter mais entregas que decidam.
export function learnedPoint(entry) {
  const points = (entry?.pontos || []).filter(p => coord(p.lat, 90) && coord(p.lon, 180));
  if (!points.length) return null;
  const center = { lat: median(points.map(p => p.lat)), lon: median(points.map(p => p.lon)) };
  const agree = points.filter(p => meters(p, center) <= 250);
  if (agree.length < Math.ceil(points.length / 2) + (points.length === 2 ? 1 : 0)) return null;
  return { lat: Math.round(center.lat * 1e6) / 1e6, lon: Math.round(center.lon * 1e6) / 1e6, confirmacoes: agree.length };
}

const MAX_GPS_ERROR_METERS = 60;
const docId = key => crypto.createHash('sha1').update(key).digest('hex');

// Indice em memoria (le a colecao inteira a cada 10 min) para a busca nao gastar leitura do Firebase.
export function createLearnedAddresses({ db, now = () => Date.now(), refreshMs = 10 * 60 * 1000 } = {}) {
  let index = new Map();
  let loadedAt = 0;
  let loading = null;
  const collection = () => db.collection('enderecosAprendidos');

  async function refresh() {
    if (!db) return;
    if (loading) return loading;
    loading = (async () => {
      try {
        const snapshot = await collection().limit(5000).get();
        const next = new Map();
        snapshot.docs.forEach(doc => {
          const data = doc.data() || {};
          if (data.chave) next.set(data.chave, data);
        });
        index = next;
        loadedAt = now();
      } catch (error) {
        console.error('Enderecos aprendidos indisponiveis:', String(error?.message || '').slice(0, 120));
        loadedAt = now() - refreshMs + 60000;
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  async function lookup(value, city) {
    if (now() - loadedAt > refreshMs) await refresh();
    for (const key of addressKeys(value, city)) {
      const entry = index.get(key);
      const point = learnedPoint(entry);
      if (point) return { ...point, texto: entry.texto || value };
    }
    return null;
  }

  // Guarda o GPS do motoboy na hora do "entregue" como o lugar desse endereco.
  async function learn({ texto, city, gps }) {
    const point = cleanGps(gps);
    if (!db || !point || point.precisao > MAX_GPS_ERROR_METERS) return false;
    const keys = addressKeys(texto, city);
    if (!keys.length) return false;
    await Promise.all(keys.map(key => db.runTransaction(async tx => {
      const ref = collection().doc(docId(key));
      const current = (await tx.get(ref)).data() || {};
      const pontos = [...(current.pontos || []), { lat: point.lat, lon: point.lon, em: now() }].slice(-5);
      const entry = { chave: key, cidade: city || 'conchal', texto: text(texto, 160), pontos, atualizadoEmMs: now() };
      tx.set(ref, entry);
      index.set(key, entry);
    })));
    return true;
  }

  return { lookup, learn, refresh, size: () => index.size };
}
