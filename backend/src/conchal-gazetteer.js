// Cadastro local de ruas de Conchal-SP.
//
// Fonte principal: IBGE CNEFE (Censo 2022) - todos os enderecos do municipio com
// numero, bairro, CEP e coordenada. Fonte complementar: OpenStreetMap (nomes com
// acento e ruas novas). Os arquivos ficam em backend/data e sao gerados por
// backend/scripts/build-conchal-gazetteer.mjs.
//
// O objetivo e nunca depender so do mapa externo para achar uma rua de Conchal:
// o nome digitado (com erro de grafia, sem acento, abreviado) e comparado com a
// lista oficial e o numero e posicionado com os enderecos reais do IBGE.
import { readFileSync } from 'node:fs';

const BASE_LAT = -22.33;
const BASE_LON = -47.16;

const TYPE_WORDS = {
  rua: 'rua', r: 'rua', ru: 'rua',
  avenida: 'avenida', av: 'avenida', avd: 'avenida', avda: 'avenida', aven: 'avenida',
  travessa: 'travessa', travesa: 'travessa', tv: 'travessa', trav: 'travessa', tr: 'travessa',
  estrada: 'estrada', est: 'estrada', estr: 'estrada',
  rodovia: 'rodovia', rod: 'rodovia',
  viela: 'viela', praca: 'praca', pca: 'praca', pc: 'praca',
  alameda: 'alameda', al: 'alameda', acesso: 'acesso', vicinal: 'vicinal'
};
const ABBREVIATIONS = {
  dr: 'doutor', dra: 'doutora', prof: 'professor', profa: 'professora', profe: 'professora', profesor: 'professor', profesora: 'professora',
  pres: 'presidente', pref: 'prefeito', ver: 'vereador', vere: 'vereador', veredor: 'vereador', vereadora: 'vereador',
  pe: 'padre', pdr: 'padre', sta: 'santa', sto: 'santo', sao: 'sao', s: 's',
  nsa: 'nossa', sra: 'senhora', n: 'n', eng: 'engenheiro', cel: 'coronel', gov: 'governador',
  dep: 'deputado', arq: 'arquiteto', cons: 'conselheiro', presb: 'presbitero', irma: 'irma',
  jd: 'jardim', jdm: 'jardim', jardin: 'jardim', vl: 'vila', pq: 'parque', res: 'residencial', cj: 'conjunto'
};
const NUMBER_WORDS = {
  1: 'um', 2: 'dois', 3: 'tres', 4: 'quatro', 5: 'cinco', 6: 'seis', 7: 'sete', 8: 'oito', 9: 'nove', 10: 'dez',
  11: 'onze', 12: 'doze', 13: 'treze', 14: 'quatorze', 15: 'quinze', 20: 'vinte',
  i: 'um', ii: 'dois', iii: 'tres', iv: 'quatro', v: 'cinco', vi: 'seis', vii: 'sete', viii: 'oito', ix: 'nove', x: 'dez',
  xv: 'quinze', segundo: 'dois', terceiro: 'tres', catorze: 'quatorze', primeiro: 'um'
};
const NUMBER_VALUES = new Set(Object.values(NUMBER_WORDS));
const STOPWORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'd', 'del', 'della', 'di', 'du', 'la', 'a', 'o']);
const TITLES = new Set(['doutor', 'doutora', 'professor', 'professora', 'presidente', 'prefeito', 'vereador', 'padre', 'presbitero',
  'deputado', 'arquiteto', 'conselheiro', 'engenheiro', 'coronel', 'governador', 'irma', 'dona', 'seu', 'senhor', 'capitao', 'monsenhor']);
const BAIRRO_GENERIC = new Set(['jardim', 'vila', 'parque', 'conjunto', 'residencial', 'habitacional', 'bairro', 'chacara', 'chacaras',
  'distrito', 'loteamento', 'condominio', 'recanto', 'nucleo', 'deputado', 'prefeito', 'vereador']);
const NOT_BAIRRO = /\b(casa|apto|apartamento|ap|bloco|bl|fundos|frente|ref|referencia|perto|proximo|prox|ao lado|esquina|portao|cep|tel|telefone|whats|zap|obs|cliente|entregar|entrega|pagamento|troco|pix|cartao|dinheiro)\b/;
const OTHER_CITIES = /\b(martinho prado|mogi guacu|mogi mirim|aguai|engenheiro coelho|artur nogueira|arthur nogueira|araras|americana|limeira|leme|pirassununga|rio claro|campinas|cosmopolis|estiva gerbi|santo antonio de posse|holambra)\b/;

export const stripAccents = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function rawWords(value) {
  return stripAccents(value).replace(/[º°ª]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

function canonicalWord(word) {
  if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, word)) return NUMBER_WORDS[word];
  if (/^\d+$/.test(word)) return NUMBER_WORDS[Number(word)] || word;
  return ABBREVIATIONS[word] || word;
}

// Chave "fonetica" simples para tolerar erro de grafia comum: letras dobradas,
// y/i, ph/f, gue/ge, z/s, h mudo e plural.
export function phoneticKey(word) {
  let key = word
    .replace(/ph/g, 'f').replace(/th/g, 't').replace(/y/g, 'i').replace(/w/g, 'v').replace(/ck/g, 'k')
    .replace(/gu([ei])/g, 'g$1').replace(/qu([ei])/g, 'k$1').replace(/c([ei])/g, 's$1').replace(/z/g, 's').replace(/k/g, 'c')
    .replace(/([^cln])h/g, '$1').replace(/^h/, '')
    .replace(/(.)\1+/g, '$1');
  if (key.length > 4 && key.endsWith('s')) key = key.slice(0, -1);
  return key;
}

function tokenize(value) {
  const words = rawWords(value).map(canonicalWord);
  let type = '';
  if (words.length && TYPE_WORDS[words[0]]) type = TYPE_WORDS[words.shift()];
  const significant = [];
  const titles = [];
  for (const word of words) {
    if (STOPWORDS.has(word)) continue;
    if (TITLES.has(word)) titles.push(word);
    else significant.push({ word, key: phoneticKey(word) });
  }
  return { type, significant, titles };
}

function editDistance(a, b) {
  // Distancia de edicao com troca de letras vizinhas ("pamlas" -> "palmas" = 1).
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 9;
  const rows = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
    }
  }
  return rows[a.length][b.length];
}

function tokenSimilarity(q, c) {
  if (q.key === c.key || q.word === c.word) return 1;
  if (q.word.length === 1) return c.word.startsWith(q.word) ? 0.7 : 0;
  if (c.word.length === 1) return q.word.startsWith(c.word) ? 0.7 : 0;
  if (/^\d+$/.test(q.word) || /^\d+$/.test(c.word)) return 0;
  const min = Math.min(q.key.length, c.key.length);
  const distance = editDistance(q.key, c.key);
  if (distance === 1 && min >= 4) return 0.85;
  if (distance === 2 && min >= 6) return 0.72;
  if (distance === 3 && min >= 9) return 0.62;
  if (q.word.length >= 4 && c.word.startsWith(q.word)) return 0.75;
  return 0;
}

// Compara o nome digitado com um nome de rua do cadastro. 1 = identico.
export function streetNameScore(query, candidate) {
  if (!query.significant.length || !candidate.significant.length) return 0;
  const used = new Set();
  let total = 0;
  let misses = 0;
  for (const q of query.significant) {
    let best = 0;
    let bestIndex = -1;
    candidate.significant.forEach((c, index) => {
      if (used.has(index)) return;
      const sim = tokenSimilarity(q, c);
      if (sim > best) { best = sim; bestIndex = index; }
    });
    if (best >= 0.6) { used.add(bestIndex); total += best; } else misses += 1;
  }
  const matched = query.significant.length - misses;
  if (!matched) return 0;
  if (misses && (query.significant.length < 3 || misses > 1)) return 0;
  let score = total / query.significant.length - misses * 0.2;
  const extras = candidate.significant.filter((_, index) => !used.has(index));
  score -= Math.min(0.35, extras.reduce((sum, token) => sum + (token.word.length === 1 ? 0.02 : 0.15), 0));
  const strongMatch = query.significant.some(q => candidate.significant.some(c => {
    const sim = tokenSimilarity(q, c);
    return (q.word.length >= 3 && sim >= 0.72) || (q.word.length >= 2 && sim === 1) || (NUMBER_VALUES.has(q.word) && sim === 1);
  }));
  if (!strongMatch) return 0;
  if (query.type && candidate.type && query.type !== candidate.type) score -= 0.1;
  return Math.max(0, Math.min(1, score));
}

function bairroTokens(value) {
  return rawWords(value).map(canonicalWord).filter(word => !STOPWORDS.has(word) && !BAIRRO_GENERIC.has(word)).map(word => ({ word, key: phoneticKey(word) }));
}

function bairroScore(hintTokens, bairro) {
  if (!hintTokens.length || !bairro.tokens.length) return 0;
  let hits = 0;
  for (const q of hintTokens) if (bairro.tokens.some(c => tokenSimilarity(q, c) >= 0.85)) hits += 1;
  const named = bairro.tokens.filter(c => hintTokens.some(q => tokenSimilarity(q, c) >= 0.85)).length;
  return hits ? (hits / hintTokens.length + named / bairro.tokens.length) / 2 : 0;
}

const titleCase = value => stripAccents(value) === value.toLowerCase() && value === value.toUpperCase()
  ? value.toLowerCase().replace(/(^|\s)([a-z0-9])/g, (_, space, letter) => space + letter.toUpperCase())
    .replace(/\s(De|Da|Do|Das|Dos|E|Della)(?=\s)/g, word => word.toLowerCase())
  : value;

function decodePoint(text) {
  const [lat, lon] = text.split(',').map(Number);
  return { lat: +(BASE_LAT + lat / 1e5).toFixed(6), lon: +(BASE_LON + lon / 1e5).toFixed(6) };
}

export function parseCnefe(text) {
  const bairros = [];
  const streets = [];
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('#')) { section = line.slice(1); continue; }
    if (section === 'bairros') { bairros.push(line); continue; }
    const [name, bairroIndex, cep, center, points] = line.split('|');
    streets.push({
      name,
      bairro: bairros[Number(bairroIndex)] || '',
      cep,
      center: decodePoint(center),
      points: (points || '').split(' ').filter(Boolean).map(item => {
        const [number, coords] = item.split(':');
        return { number: Number(number), ...decodePoint(coords) };
      }).sort((a, b) => a.number - b.number)
    });
  }
  return streets;
}

export function parseOsm(text) {
  return text.split(/\r?\n/).filter(Boolean).map(line => {
    const [name, alt, point] = line.split('|');
    return { name, alt: alt ? alt.split(';').filter(Boolean) : [], center: decodePoint(point) };
  });
}

// Separa "Rua X, 120, Bairro" em rua, numero e dicas de bairro. Um numero junto
// do nome do bairro ("Esperanca 2") nunca e tratado como numero da casa.
export function parseAddressInput(value) {
  let text = String(value || '').replace(/\[[^\]]*\]\([^)]*\)/g, ' ').replace(/https?:\/\/\S+/gi, ' ');
  text = text.replace(/\b\d{5}-?\d{3}\b/g, ' ').replace(/\bcep\b/gi, ' ');
  const segments = text.split(/[,;\n|]+|\s[-–—]\s|\s\/\s/).map(part => part.trim()).filter(Boolean);
  const placeOnly = /^(conchal|sp|s p|sao paulo|estado de sao paulo|brasil|brazil|conchal sp|conchal sao paulo|conchal sp brasil|sp brasil)$/;
  const cleaned = segments
    .filter(part => !placeOnly.test(rawWords(part).join(' ')))
    .map(part => part.replace(/\s+conchal(?:\s*[-/]?\s*(?:sp|s\.p\.))?(?:\s+brasil)?\s*$/i, '').replace(/\s*[-/]\s*sp\s*$/i, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const isTyped = part => !!TYPE_WORDS[canonicalWord(rawWords(part)[0] || '')];
  let streetIndex = cleaned.findIndex(isTyped);
  if (streetIndex < 0) streetIndex = 0;
  let street = cleaned[streetIndex] || '';
  let number = '';
  const rest = [];
  const words = street.split(/\s+/);
  // Numero dentro do mesmo trecho da rua: "Rua X 120 Jardim Y" / "Rua X nº 120".
  // "Av Joao Paulo 2 250": o numero da casa e o ultimo de uma sequencia.
  const isNumberMark = word => /^(?:n[º°o.]*|numero|número|num\.?)$/i.test(word);
  for (let index = 1; index < words.length; index++) {
    const marked = isNumberMark(words[index]);
    const numberWord = marked ? words[index + 1] || '' : words[index];
    const match = numberWord.match(marked ? /^(\d{1,5})([a-zA-Z])?$/ : /^(?:n[º°o.]*)?(\d{1,5})([a-zA-Z])?$/i);
    if (!match) continue;
    const nextIndex = index + (marked ? 2 : 1);
    if (!marked && /^(?:n[º°o.]*)?\d{1,5}[a-zA-Z]?$/i.test(words[nextIndex] || '')) continue; // "Av Joao Paulo 2 250"
    if (/^(sp|chl|br|km|arr|rod)$/.test(stripAccents(words[index - 1] || '').replace(/[^a-z]/g, ''))) continue; // "Rodovia SP 191"
    const before = words.slice(0, index);
    const named = before.map(word => canonicalWord(rawWords(word)[0] || '')).filter(word => word && !TYPE_WORDS[word] && !STOPWORDS.has(word));
    if (!named.length) continue;
    if (['de', 'da', 'do'].includes(stripAccents(words[nextIndex] || ''))) continue; // "Rua 15 de Novembro"
    number = match[1] + (match[2] || '').toUpperCase();
    const after = words.slice(nextIndex).join(' ');
    street = before.join(' ');
    if (after) rest.push(after);
    break;
  }
  const inlineNumber = number;
  const inlineAtEnd = number && !rest.length;
  cleaned.forEach((part, index) => {
    if (index === streetIndex) return;
    const numberOnly = part.match(/^(?:n[º°o.]*|numero|número|num\.?)?\s*(\d{1,5})\s*([a-zA-Z])?$/i);
    if (numberOnly && (!number || (inlineAtEnd && number === inlineNumber))) {
      // "Av Joao Paulo 2, 250": o numero separado por virgula e o da casa; o "2" faz parte do nome.
      if (number) street = `${street} ${inlineNumber}`;
      number = numberOnly[1] + (numberOnly[2] || '').toUpperCase();
      return;
    }
    if (/^s\/?n$/i.test(part)) return;
    rest.push(part);
  });
  const bairroHints = rest.filter(part => /[a-z]/i.test(part) && !NOT_BAIRRO.test(stripAccents(part)));
  return { street: street.trim(), number, bairroHints, otherParts: rest };
}

function interpolate(entry, number) {
  const points = entry.points;
  if (!number || !points.length) return { ...entry.center, precision: 'rua' };
  const n = Number.parseInt(number, 10);
  const exact = points.find(point => point.number === n);
  if (exact) return { lat: exact.lat, lon: exact.lon, precision: 'numero' };
  const lower = [...points].reverse().find(point => point.number < n);
  const upper = points.find(point => point.number > n);
  if (lower && upper) {
    const f = (n - lower.number) / (upper.number - lower.number);
    return { lat: +(lower.lat + f * (upper.lat - lower.lat)).toFixed(6), lon: +(lower.lon + f * (upper.lon - lower.lon)).toFixed(6), precision: 'interpolado' };
  }
  const nearest = lower || upper;
  if (Math.abs(nearest.number - n) <= 200) return { lat: nearest.lat, lon: nearest.lon, precision: 'aproximado' };
  return { ...entry.center, precision: 'rua' };
}

function distanceKm(a, b) {
  const dy = (a.lat - b.lat) * 111;
  const dx = (a.lon - b.lon) * 103;
  return Math.hypot(dx, dy);
}

function numberFit(entry, number) {
  const n = Number.parseInt(number, 10);
  if (!n || !entry.points.length) return 0;
  const min = entry.points[0].number;
  const max = entry.points[entry.points.length - 1].number;
  if (n >= min && n <= max) return 1;
  const gap = n < min ? min - n : n - max;
  return gap <= 200 ? 0.5 : 0;
}

export function otherCityRequested(value) {
  // O nome da rua pode citar outra cidade (Rua Araras, Rua Mogi Mirim); so o resto do texto indica a cidade.
  return parseAddressInput(value).otherParts.some(part => OTHER_CITIES.test(stripAccents(part)));
}

export function createConchalGazetteer({ cnefeText, osmText } = {}) {
  const cnefe = parseCnefe(cnefeText ?? readFileSync(new URL('../data/cnefe-conchal.txt', import.meta.url), 'utf8'));
  const osm = parseOsm(osmText ?? readFileSync(new URL('../data/osm-conchal.txt', import.meta.url), 'utf8'))
    // Somente o municipio de Conchal (cidade, Tujuguaba e Iate). Martinho Prado e Araras ficam de fora.
    .filter(item => item.center.lat >= -22.386 && item.center.lat <= -22.29 && item.center.lon >= -47.187 && item.center.lon <= -47.15);

  const osmTokens = osm.map(item => ({ item, names: [item.name, ...item.alt].map(name => tokenize(name)) }));
  const bairroCache = new Map();
  const bairroInfo = name => {
    if (!bairroCache.has(name)) bairroCache.set(name, { name, tokens: bairroTokens(name) });
    return bairroCache.get(name);
  };

  const entries = cnefe.map(street => ({ ...street, source: 'ibge-cnefe-2022', names: [tokenize(street.name)], display: titleCase(street.name), bairroInfo: bairroInfo(street.bairro) }));
  // Nome com acento vindo do OSM quando for claramente a mesma rua; ruas que so existem no OSM entram como extra.
  for (const entry of entries) {
    // Usa o nome do OSM so para recuperar acentos (mesmo nome letra por letra).
    const plain = rawWords(entry.name).join(' ');
    const twin = osm.find(item => rawWords(item.name).join(' ') === plain);
    if (twin) entry.display = twin.name;
  }
  for (const candidate of osmTokens) {
    const known = entries.some(entry => entry.source !== 'osm' && distanceKm(entry.center, candidate.item.center) < 1.5 && candidate.names.some(tokens => streetNameScore(tokens, entry.names[0]) >= 0.85));
    if (!known) entries.push({ name: candidate.item.name, display: candidate.item.name, bairro: '', cep: '13835000', center: candidate.item.center, points: [], source: 'osm', names: candidate.names, bairroInfo: bairroInfo('') });
  }

  function scoreEntries(streetText) {
    const query = tokenize(streetText);
    return {
      query,
      scored: entries.map(entry => ({ entry, score: Math.max(...entry.names.map(tokens => streetNameScore(query, tokens))) })).filter(item => item.score > 0)
    };
  }

  function toFeature(entry, point, parsed, score) {
    const bairro = entry.bairro && !/^(conchal|zona rural)$/i.test(entry.bairro) ? titleCase(entry.bairro) : '';
    const street = entry.display;
    const cep = entry.cep ? `${entry.cep.slice(0, 5)}-${entry.cep.slice(5)}` : '';
    const line1 = parsed.number ? `${street}, ${parsed.number}` : street;
    const line2 = [bairro, 'Conchal - SP', cep].filter(Boolean).join(', ');
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
      properties: {
        lat: point.lat,
        lon: point.lon,
        street,
        ...(parsed.number ? { housenumber: parsed.number } : {}),
        suburb: bairro || undefined,
        district: bairro || undefined,
        city: 'Conchal',
        county: 'Conchal',
        state: 'São Paulo',
        state_code: 'SP',
        country: 'Brasil',
        country_code: 'br',
        postcode: cep || undefined,
        result_type: parsed.number ? 'building' : 'street',
        formatted: `${line1} - ${line2}`,
        address_line1: line1,
        address_line2: line2,
        match_confirmed: true,
        match_source: entry.source,
        match_precision: point.precision,
        match_score: Number(score.toFixed(3))
      }
    };
  }

  // Resolve um endereco de Conchal. Retorna { features, ambiguous, suggestions }.
  function search(text, { limit = 1 } = {}) {
    if (!text) return { features: [], suggestions: [] };
    const parsed = parseAddressInput(text);
    if (parsed.otherParts.some(part => OTHER_CITIES.test(stripAccents(part)))) return { features: [], suggestions: [] };
    if (!parsed.street) return { features: [], suggestions: [] };
    const interpretations = [parsed];
    // "Rua X Esperanca 2" sem virgula: o fim pode ser o bairro.
    const words = parsed.street.split(/\s+/);
    for (let cut = words.length - 1; cut >= 2; cut--) {
      const tail = words.slice(cut).join(' ');
      if (entries.some(entry => bairroScore(bairroTokens(tail), entry.bairroInfo) >= 0.5)) {
        interpretations.push({ ...parsed, street: words.slice(0, cut).join(' '), bairroHints: [...parsed.bairroHints, tail], penalty: 0.2 });
      }
    }
    let best = null;
    for (const interpretation of interpretations) {
      const { query, scored } = scoreEntries(interpretation.street);
      if (!scored.length) continue;
      const hints = interpretation.bairroHints.map(bairroTokens).filter(tokens => tokens.length);
      const ranked = scored.map(item => {
        const bairro = hints.length ? Math.max(...hints.map(tokens => bairroScore(tokens, item.entry.bairroInfo))) : 0;
        const fit = numberFit(item.entry, interpretation.number);
        return { ...item, bairro, fit, final: item.score + bairro * 0.08 + fit * 0.04 - (interpretation.penalty || 0) + (item.entry.source === 'osm' ? -0.02 : 0) };
      }).sort((a, b) => b.final - a.final);
      const required = query.type ? 0.7 : 0.85;
      if (ranked[0].score < required) {
        if (!best || ranked[0].final > best.top.final) best = { interpretation, ranked, top: ranked[0], accepted: false };
        continue;
      }
      if (!best || !best.accepted || ranked[0].final > best.top.final + 0.001) best = { interpretation, ranked, top: ranked[0], accepted: true };
    }
    if (!best) return { features: [], suggestions: [] };
    const nameKey = entry => entry.names[0].significant.map(token => token.key).join(' ');
    const suggestions = [...new Set(best.ranked.filter(item => item.score >= 0.5).map(item => item.entry.display))].slice(0, 4);
    if (!best.accepted) return { features: [], suggestions };
    const topKey = nameKey(best.top.entry);
    const rival = best.ranked.find(item => nameKey(item.entry) !== topKey && item.score >= 0.7);
    if (rival && best.top.final - rival.final < 0.05) {
      return { features: [], ambiguous: true, suggestions };
    }
    const sameStreet = best.ranked.filter(item => nameKey(item.entry) === topKey);
    const chosen = sameStreet[0].entry;
    // Mesmo nome em lugares distantes (ex.: "Rua Um" em bairros diferentes) sem bairro ou numero que decida.
    const far = sameStreet.find(item => item !== sameStreet[0] && item.final >= sameStreet[0].final - 0.03 && distanceKm(item.entry.center, chosen.center) > 1.5);
    if (far) {
      return { features: [], ambiguous: true, suggestions: [...new Set(sameStreet.filter(item => item.final >= sameStreet[0].final - 0.03).map(item => `${item.entry.display} - ${titleCase(item.entry.bairro || 'Conchal')}`))].slice(0, 4) };
    }
    const point = interpolate(chosen, best.interpretation.number);
    const features = [toFeature(chosen, point, best.interpretation, best.top.score)];
    if (limit > 1) {
      for (const item of sameStreet.slice(1, limit)) features.push(toFeature(item.entry, interpolate(item.entry, best.interpretation.number), best.interpretation, item.score));
    }
    return { features, suggestions };
  }

  return { search, size: entries.length, entries };
}

let shared = null;
export function conchalGazetteer() {
  if (!shared) shared = createConchalGazetteer();
  return shared;
}
