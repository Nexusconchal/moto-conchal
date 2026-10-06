// Regenera o cadastro local de ruas de Conchal-SP usado pela busca de enderecos.
//
//   npm run gazetteer:build
//
// Fontes:
//   - IBGE CNEFE Censo 2022, municipio 3512209 (Conchal): todos os enderecos com
//     numero, bairro, CEP e coordenada.
//   - OpenStreetMap (Overpass): nomes com acento e ruas que o IBGE ainda nao tem.
//
// Gera backend/data/cnefe-conchal.txt e backend/data/osm-conchal.txt.
import { writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const CNEFE_URL = 'https://ftp.ibge.gov.br/Cadastro_Nacional_de_Enderecos_para_Fins_Estatisticos/Censo_Demografico_2022/Arquivos_CNEFE/CSV/Municipio/35_SP/3512209_CONCHAL.zip';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const OVERPASS_QUERY = '[out:json][timeout:90];way["highway"]["name"](-22.44,-47.30,-22.24,-47.08);out tags geom;';
const BASE_LAT = -22.33;
const BASE_LON = -47.16;
const TOLERANCE_METERS = 20;

const encode = (lat, lon) => `${Math.round((lat - BASE_LAT) * 1e5)},${Math.round((lon - BASE_LON) * 1e5)}`;
const meters = (a, b) => Math.hypot((a.lon - b.lon) * 102000, (a.lat - b.lat) * 111000);

function unzipFirstFile(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let end = buffer.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  const central = view.getUint32(end + 16, true);
  const size = view.getUint32(central + 20, true);
  const local = view.getUint32(central + 42, true);
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  return inflateRawSync(buffer.subarray(start, start + size)).toString('utf8');
}

// Mantem so os numeros necessarios para reconstruir a rua por interpolacao com erro <= 20 m.
function simplify(points) {
  if (points.length <= 2) return points;
  const keep = [points[0]];
  let i = 0;
  while (i < points.length - 1) {
    let j = i + 1;
    for (let k = i + 2; k < points.length; k++) {
      let ok = true;
      for (let t = i + 1; t < k; t++) {
        const f = (points[t].number - points[i].number) / ((points[k].number - points[i].number) || 1);
        const guess = { lat: points[i].lat + f * (points[k].lat - points[i].lat), lon: points[i].lon + f * (points[k].lon - points[i].lon) };
        if (meters(guess, points[t]) > TOLERANCE_METERS) { ok = false; break; }
      }
      if (!ok) break;
      j = k;
    }
    keep.push(points[j]);
    i = j;
  }
  return keep;
}

async function buildCnefe() {
  const response = await fetch(CNEFE_URL);
  if (!response.ok) throw new Error(`IBGE respondeu ${response.status}`);
  const csv = unzipFirstFile(Buffer.from(await response.arrayBuffer()));
  const [header, ...lines] = csv.split(/\r?\n/).filter(Boolean);
  const columns = header.split(';');
  const col = name => columns.indexOf(name);
  const groups = new Map();
  for (const line of lines) {
    const row = line.split(';');
    const lat = Number(row[col('LATITUDE')]);
    const lon = Number(row[col('LONGITUDE')]);
    if (!lat || !lon) continue;
    const name = [row[col('NOM_TIPO_SEGLOGR')], row[col('NOM_TITULO_SEGLOGR')], row[col('NOM_SEGLOGR')]].filter(Boolean).join(' ');
    const bairro = row[col('DSC_LOCALIDADE')];
    const key = `${name}|${bairro}`;
    if (!groups.has(key)) groups.set(key, { name, bairro, ceps: new Set(), points: [] });
    const group = groups.get(key);
    group.ceps.add(row[col('CEP')]);
    group.points.push({ number: Number.parseInt(row[col('NUM_ENDERECO')], 10) || 0, lat, lon });
  }
  const bairros = [...new Set([...groups.values()].map(group => group.bairro))].sort();
  const rows = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name) || a.bairro.localeCompare(b.bairro)).map(group => {
    const byNumber = new Map();
    for (const point of group.points) {
      if (!point.number) continue;
      if (!byNumber.has(point.number)) byNumber.set(point.number, []);
      byNumber.get(point.number).push(point);
    }
    const numbered = [...byNumber.entries()].sort((a, b) => a[0] - b[0]).map(([number, list]) => ({
      number,
      lat: list.reduce((sum, p) => sum + p.lat, 0) / list.length,
      lon: list.reduce((sum, p) => sum + p.lon, 0) / list.length
    }));
    const center = {
      lat: group.points.reduce((sum, p) => sum + p.lat, 0) / group.points.length,
      lon: group.points.reduce((sum, p) => sum + p.lon, 0) / group.points.length
    };
    const anchors = simplify(numbered).map(p => `${p.number}:${encode(p.lat, p.lon)}`).join(' ');
    return [group.name, bairros.indexOf(group.bairro), [...group.ceps][0], encode(center.lat, center.lon), anchors].join('|');
  });
  return `#bairros\n${bairros.join('\n')}\n#ruas\n${rows.join('\n')}`;
}

async function buildOsm() {
  const response = await fetch(`${OVERPASS_URL}?data=${encodeURIComponent(OVERPASS_QUERY)}`);
  if (!response.ok) throw new Error(`Overpass respondeu ${response.status}`);
  const data = await response.json();
  const byName = new Map();
  for (const element of data.elements || []) {
    if (!element.geometry) continue;
    const tags = element.tags || {};
    if (!byName.has(tags.name)) byName.set(tags.name, { name: tags.name, alt: new Set(), points: [] });
    const item = byName.get(tags.name);
    item.points.push(...element.geometry);
    for (const tag of ['alt_name', 'old_name', 'official_name', 'short_name', 'loc_name']) {
      if (tags[tag]) tags[tag].split(';').forEach(value => item.alt.add(value.trim()));
    }
  }
  return [...byName.values()].map(item => {
    const lat = item.points.reduce((sum, p) => sum + p.lat, 0) / item.points.length;
    const lon = item.points.reduce((sum, p) => sum + p.lon, 0) / item.points.length;
    const middle = item.points.reduce((best, p) => ((p.lat - lat) ** 2 + (p.lon - lon) ** 2 < (best.lat - lat) ** 2 + (best.lon - lon) ** 2 ? p : best));
    return [item.name, [...item.alt].join(';'), encode(middle.lat, middle.lon)].join('|');
  }).sort().join('\n');
}

const cnefe = await buildCnefe();
writeFileSync(new URL('../data/cnefe-conchal.txt', import.meta.url), cnefe);
console.log(`IBGE: ${cnefe.split('\n').length} linhas gravadas`);
try {
  const osm = await buildOsm();
  writeFileSync(new URL('../data/osm-conchal.txt', import.meta.url), osm);
  console.log(`OSM: ${osm.split('\n').length} ruas gravadas`);
} catch (error) {
  console.warn(`OSM nao atualizado (${error.message}); o arquivo anterior foi mantido.`);
}
