import { addressFeatureMatches, mapSearchText, streetNumber } from './address-search.js';

// Memory only: repeated searches do not consume Firebase reads or writes.
export function createGeocodeSearch({ fetchImpl = fetch, maxEntries = 500, now = Date.now } = {}) {
  const cache = new Map();
  const pending = new Map();
  return async function search({ text, apiKey, filter = '', bias = '', city = 'Conchal', limit = 5 }) {
    const query = mapSearchText(text);
    const key = JSON.stringify([query.toLowerCase(), filter, bias, city.toLowerCase(), limit]);
    const saved = cache.get(key);
    if (saved && saved.expires > now()) return saved.data;
    if (pending.has(key)) return pending.get(key);
    const run = (async () => {
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
      const matches = feature => addressFeatureMatches(text, feature.properties || {});
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
      if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
      cache.set(key, { data, expires: now() + (data.features.some(matches) ? 30 * 60 * 1000 : 60 * 1000) });
      return data;
    })();
    pending.set(key, run);
    try { return await run; } finally { pending.delete(key); }
  };
}
