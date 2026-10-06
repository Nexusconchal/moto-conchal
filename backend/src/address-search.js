export const normalizeStreetName = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/\bzanochett?a\b|\bzanchett?a\b/g, 'zancheta')
  .replace(/\b15 de novembro\b/g, 'xv de novembro')
  .replace(/\b9 de julho\b/g, 'nove de julho')
  .replace(/\b7 de setembro\b/g, 'sete de setembro')
  .replace(/\bvisconde de indaiatuba\b/g, 'visconde indatuba')
  .replace(/\bbenedito novo\b/g, 'bendito novo')
  .replace(/\btiradentes\b/g, 'tirandentes')
  .replace(/\bmaria chiavegatto corte\b/g, 'maria chiavegato corte')
  .replace(/\bvicente vigano\b/g, 'vicende vigano')
  .replace(/\bdos battel\b/g, 'dos batel')
  .replace(/\bdos paulo\b/g, 'dos paulos');
const normalized = normalizeStreetName;

export function streetNumber(value) {
  const text = String(value || '').trim().replace(/[–—]|\s+-\s+/g, ',');
  const match = text.match(/^(.+?)(?:,\s*|\s+)(?:n[ºo°.]*\s*)?(\d+[a-z]?)(?=\s*(?:[,;]|$|\b(?:jd\.?|jardim|bairro|vila|parque|centro|residencial|conjunto|desmembramento|chacara|chácaras?|distrito|polo|nucleo|núcleo|terra\s+nobre|santa\s+rita|noventa|conchal|sp|casa|apto|apartamento|bloco|fundos|ref|referencia)\b))/i);
  if (!match || /^(?:rua|r\.?|avenida|av\.?|estrada|rodovia|travessa)$/i.test(match[1].trim())) return null;
  // "Rua dos Colleta, Esperanca 2": o numero pertence ao bairro, nao a casa.
  if (match[1].includes(',') && /[a-z]/i.test(match[1].split(',').pop())) return null;
  return { street: match[1].trim().replace(/,$/, ''), number: match[2] };
}

export function addressSearchVariants(value, city = 'Conchal') {
  const text = mapSearchText(value);
  const parts = streetNumber(text);
  return [...new Set([parts ? `${parts.street}, ${parts.number}, ${city}, SP, Brasil` : '', text].filter(Boolean))];
}

export function mapSearchText(value) {
  return String(value || '').trim()
    .replace(/\bzanochett?a\b|\bzanchett?a\b/gi, 'Zancheta')
    .replace(/\b15 de novembro\b/gi, 'XV de Novembro')
    .replace(/\b9 de julho\b/gi, 'Nove de Julho')
    .replace(/\b7 de setembro\b/gi, 'Sete de Setembro')
    .replace(/\bvisconde de indaiatuba\b/gi, 'Visconde Indatuba')
    .replace(/\bbenedito novo\b/gi, 'Bendito Novo')
    .replace(/\btiradentes\b/gi, 'Tirandentes')
    .replace(/\bMaria Chiavegatto Corte\b/gi, 'Maria Chiavegato Corte')
    .replace(/\bVicente Vigan[oó]\b/gi, 'Vicende Vigano')
    .replace(/\bdos Battel\b/gi, 'dos Batel')
    .replace(/\bdos Paulo\b/gi, 'dos Paulos');
}

export function addressFeatureMatches(value, props = {}) {
  // Endereco ja conferido no cadastro oficial de ruas de Conchal (IBGE/OSM).
  if (props.match_confirmed === true && ['ibge-cnefe-2022', 'osm'].includes(props.match_source)) return true;
  if (['city', 'county', 'state', 'country', 'postcode', 'district', 'suburb'].includes(props.result_type)) return false;
  const text = normalized(value);
  const parts = streetNumber(text);
  if (parts && props.housenumber && normalized(props.housenumber).trim() !== parts.number) return false;
  const roadText = parts?.street || text.split(',')[0];
  const road = roadText.match(/^(?:rua|r\.?|avenida|av\.?|estrada|rodovia|travessa)\s+(.+)/) || (parts ? [roadText, roadText] : null);
  if (!road) return !!(props.street || props.housenumber || props.name);
  if (!props.street) return false;
  const words = road[1].split(/[^a-z0-9]+/).filter(word => (word.length > 1 || /^\d+$/.test(word)) && !['de','da','do','das','dos','dr','dra','doutor','doutora','vereador','professor','professora','prefeito','presbitero'].includes(word));
  const found = normalized(props.street).replace(/^(?:rua|r\.?|avenida|av\.?|estrada|rodovia|travessa)\s+/, '').split(/[^a-z0-9]+/)
    .filter(word => (word.length > 1 || /^\d+$/.test(word)) && !['de','da','do','das','dos','dr','dra','doutor','doutora','vereador','professor','professora','prefeito','presbitero'].includes(word));
  const initials = road[1].split(/[^a-z0-9]+/).filter(word => /^[a-z]$/.test(word));
  const remaining = found.filter(word => !words.includes(word));
  return words.length > 0 && words.every(word => found.includes(word)) && remaining.length <= initials.length && remaining.every(word => initials.includes(word[0]));
}
