import { addressFeatureMatches, mapSearchText, streetNumber } from './address-search.js';
import { GAZETTEER_CITIES, gazetteerCityKey, gazetteerFor, otherCityRequested } from './conchal-gazetteer.js';

function defaultGazetteer(cityKey) {
  try {
    return gazetteerFor(cityKey);
  } catch (error) {
    console.error(`Cadastro local de ruas de ${GAZETTEER_CITIES[cityKey].name} indisponivel:`, error.message);
    return null;
  }
}

// Busca primeiro no cadastro oficial de ruas da cidade (IBGE + OSM) e so depois no Geoapify.
// Conchal, Aguai e Engenheiro Coelho tem cadastro; as outras cidades vao direto ao Geoapify.
export function lookupLocalAddress(gazetteer, text, city = 'Conchal') {
  const cityKey = gazetteerCityKey(city);
  if (!gazetteer || !cityKey || gazetteer.city && gazetteer.city !== cityKey || otherCityRequested(text, cityKey)) return null;
  const cityName = GAZETTEER_CITIES[cityKey].name;
  const result = gazetteer.search(text);
  if (result.features.length) return { type: 'FeatureCollection', features: result.features, source: 'conchal-local' };
  if (result.ambiguous) {
    return {
      type: 'FeatureCollection',
      features: [],
      source: 'conchal-local',
      ambiguous: true,
      suggestions: result.suggestions,
      message: `Encontrei mais de uma rua parecida em ${cityName}: ${result.suggestions.join('; ')}. Digite o nome completo da rua e o bairro.`
    };
  }
  return { type: 'FeatureCollection', features: [], suggestions: result.suggestions, cityName };
}
export const lookupConchalAddress = lookupLocalAddress;

// Memory only: repeated searches do not consume Firebase reads or writes.
export function createGeocodeSearch({ fetchImpl = fetch, maxEntries = 500, now = Date.now, gazetteer } = {}) {
  const cache = new Map();
  const pending = new Map();
  // gazetteer (inclusive null) substitui o cadastro de todas as cidades; usado nos testes.
  const localGazetteer = city => {
    if (gazetteer !== undefined) return gazetteer;
    const cityKey = gazetteerCityKey(city);
    return cityKey ? defaultGazetteer(cityKey) : null;
  };
  return async function search({ text, original = '', apiKey, filter = '', bias = '', city = 'Conchal', limit = 5 }) {
    const query = mapSearchText(text);
    const key = JSON.stringify([query.toLowerCase(), String(original || '').toLowerCase(), filter, bias, city.toLowerCase(), limit]);
    const saved = cache.get(key);
    if (saved && saved.expires > now()) return saved.data;
    if (pending.has(key)) return pending.get(key);
    const remember = (data, ttl) => {
      if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
      cache.set(key, { data, expires: now() + ttl });
      return data;
    };
    const run = (async () => {
      // O texto original digitado preserva bairro e numero que o app pode ter reorganizado.
      const fromOriginal = original ? lookupLocalAddress(localGazetteer(city), original, city) : null;
      const localResult = (fromOriginal?.features.length ? fromOriginal : null) || lookupLocalAddress(localGazetteer(city), text, city);
      if (localResult && (localResult.features.length || localResult.ambiguous)) return remember(localResult, 6 * 60 * 60 * 1000);

      const common = { lang: 'pt', limit: String(limit), apiKey };
      if (filter) common.filter = filter;
      if (bias) common.bias = bias;
      const request = async (address) => {
        const params = new URLSearchParams({ ...common, ...address });
        const response = await fetchImpl(`https://api.geoapify.com/v1/geocode/search?${params}`, { signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw Object.assign(new Error('Nao consegui consultar o mapa agora.'), { status: 502, code: 'geoapify_falhou' });
        const data = await response.json();
        if (!Array.isArray(data.features)) throw Object.assign(new Error('Resposta do mapa invalida.'), { status: 502, code: 'geoapify_falhou' });
        return data;
      };
      let data = await request({ text: query });
      const normalized = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      const matches = feature => {
        const props = feature.properties || {};
        const location = normalized(`${props.city || ''} ${props.district || ''} ${props.suburb || ''} ${props.formatted || ''}`);
        const coordinates = feature.geometry?.coordinates;
        return addressFeatureMatches(text, props) && location.includes(normalized(city)) && Array.isArray(coordinates) &&
          Number.isFinite(coordinates[0]) && Number.isFinite(coordinates[1]) && Math.abs(coordinates[0]) <= 180 && Math.abs(coordinates[1]) <= 90;
      };
      const parts = streetNumber(query);
      const street = parts?.street || query.split(',')[0].trim();
      // Structured fallback keeps the street and house separate from the city.
      // Never substitute another house, another road, or a generic city pin.
      if (!data.features.some(matches) && /^(?:rua|r\.?|avenida|av\.?|estrada|rodovia|travessa|praça|praca)\s+\S+/i.test(street)) {
        try {
          const structured = await request({ street, ...(parts ? { housenumber: parts.number } : {}), city, state: 'São Paulo', country: 'Brasil' });
          const usable = structured.features.filter(matches);
          if (usable.length) data = { ...structured, features: usable };
        } catch {
          // A working first response remains usable if the fallback is unavailable.
        }
      }
      const found = data.features.some(matches);
      if (!found && localResult) {
        const suggestions = localResult.suggestions || [];
        const cityName = localResult.cityName || 'Conchal';
        data = {
          ...data,
          suggestions,
          message: suggestions.length
            ? `Nao achei essa rua em ${cityName}. Voce quis dizer: ${suggestions.join('; ')}?`
            : `Nao achei essa rua em ${cityName}. Confira o nome da rua e digite rua, numero e bairro.`
        };
      }
      return remember(data, found ? 30 * 60 * 1000 : 60 * 1000);
    })();
    pending.set(key, run);
    try { return await run; } finally { pending.delete(key); }
  };
}
