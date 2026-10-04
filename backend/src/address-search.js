const normalized = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\bzanochett?a\b|\bzanchett?a\b/g, 'zancheta');

export function streetNumber(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(.+?)(?:,\s*|\s+)(?:n[ºo°.]*\s*)?(\d+[a-z]?)(?=\s*(?:[,;]|$|\b(?:jd\.?|jardim|bairro|vila|parque|conchal|sp)\b))/i);
  return match ? { street: match[1].trim().replace(/,$/, ''), number: match[2] } : null;
}

export function addressSearchVariants(value, city = 'Conchal') {
  const text = String(value || '').trim();
  const parts = streetNumber(text);
  return [...new Set([parts ? `${parts.street}, ${parts.number}, ${city}, SP, Brasil` : '', text].filter(Boolean))];
}

export function addressFeatureMatches(value, props = {}) {
  if (['city', 'county', 'state', 'country', 'postcode', 'district', 'suburb'].includes(props.result_type)) return false;
  const text = normalized(value);
  const parts = streetNumber(text);
  if (parts && props.housenumber && normalized(props.housenumber).trim() !== parts.number) return false;
  const road = (parts?.street || text).match(/^(?:rua|r\.?|avenida|av\.?|estrada|rodovia|travessa)\s+(.+)/);
  if (!road) return !!(props.street || props.housenumber || props.name);
  if (!props.street) return false;
  const words = road[1].split(/[^a-z0-9]+/).filter(word => (word.length > 1 || /^\d+$/.test(word)) && !['de','da','do','das','dos','dr','dra','doutor','doutora'].includes(word));
  const found = normalized(props.street).split(/[^a-z0-9]+/);
  return words.length > 0 && words.every(word => found.includes(word));
}
