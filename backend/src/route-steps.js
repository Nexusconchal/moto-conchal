// Instrucoes de curva em portugues para a navegacao do motoboy, a partir dos
// passos que o OSRM devolve com steps=true. Cada passo vira:
// { tipo, texto, lat, lon } — tipo escolhe a seta e texto vai na faixa e na voz.

const LADO = {
  right: 'direita',
  'sharp right': 'direita',
  'slight right': 'leve-direita',
  left: 'esquerda',
  'sharp left': 'esquerda',
  'slight left': 'leve-esquerda',
  straight: 'frente',
  uturn: 'retorno'
};

const ORDINAIS = ['primeira', 'segunda', 'terceira', 'quarta', 'quinta', 'sexta', 'sétima', 'oitava'];

// "na Rua X", "no Largo X", "na SP-191"; nome sem tipo conhecido fica "em X".
const FEMININOS = /^(rua|r\.|avenida|av\.?|travessa|tv\.?|alameda|al\.?|praça|praca|rodovia|estrada|est\.?|marginal|via|vicinal|ponte|passarela|servidão|servidao|viela|ladeira|rotatória|rotatoria|alça|alca)(\s|$)/i;
const MASCULINOS = /^(largo|viaduto|anel|contorno|acesso|caminho|beco|parque|jardim|trevo|elevado|túnel|tunel|retorno|calçadão|calcadao|corredor)(\s|$)/i;
const RODOVIA = /^[A-Z]{2,3}[- ]?\d{2,3}\b/;

function nomeDaRua(step = {}) {
  const nome = String(step.name || '').trim();
  const ref = String(step.ref || '').split(';')[0].trim();
  return (nome || ref).slice(0, 80);
}

function artigo(nome) {
  if (FEMININOS.test(nome) || RODOVIA.test(nome)) return 'a';
  if (MASCULINOS.test(nome)) return 'o';
  return '';
}

function naRua(nome) {
  if (!nome) return '';
  const a = artigo(nome);
  return a === 'a' ? ` na ${nome}` : a === 'o' ? ` no ${nome}` : ` em ${nome}`;
}

function paraRua(nome) {
  if (!nome) return '';
  const a = artigo(nome);
  return a ? ` para ${a} ${nome}` : ` para ${nome}`;
}

function direcao(lado) {
  return {
    direita: 'à direita',
    esquerda: 'à esquerda',
    'leve-direita': 'à direita',
    'leve-esquerda': 'à esquerda'
  }[lado] || '';
}

export function textoDoPasso(step = {}) {
  const maneuver = step.maneuver || {};
  const tipo = String(maneuver.type || '');
  const lado = LADO[String(maneuver.modifier || '')] || '';
  const nome = nomeDaRua(step);

  if (tipo === 'depart' || tipo === 'notification' || tipo === 'exit roundabout' || tipo === 'exit rotary') return null;
  if (tipo === 'arrive') {
    const lugar = lado === 'direita' || lado === 'leve-direita' ? ', à direita' : lado === 'esquerda' || lado === 'leve-esquerda' ? ', à esquerda' : '';
    return { tipo: 'chegada', texto: `Chegada ao destino${lugar}` };
  }
  if (tipo === 'roundabout' || tipo === 'rotary') {
    const saida = Number(maneuver.exit);
    const qual = Number.isInteger(saida) && saida > 0 ? ORDINAIS[saida - 1] || `${saida}ª` : '';
    return { tipo: 'rotatoria', texto: qual ? `Na rotatória, pegue a ${qual} saída${paraRua(nome)}` : `Na rotatória, siga${paraRua(nome) || ' em frente'}` };
  }
  // Seguir reto, mudar o nome da rua ou "continue" sem curva nao viram instrucao:
  // a faixa mostra a proxima curva de verdade.
  if (!lado || lado === 'frente') {
    if (tipo === 'turn' || tipo === 'end of road' || tipo === 'fork' || tipo === 'on ramp' || tipo === 'off ramp' || tipo === 'roundabout turn') {
      return { tipo: 'frente', texto: `Siga em frente${naRua(nome)}` };
    }
    return null;
  }
  if (lado === 'retorno') return { tipo: 'retorno', texto: `Faça o retorno${naRua(nome)}` };

  const para = direcao(lado);
  const leve = lado.startsWith('leve-');
  let texto;
  if (tipo === 'end of road') texto = `No fim da rua, vire ${para}${naRua(nome)}`;
  else if (tipo === 'fork') texto = `Na bifurcação, mantenha-se ${para}${naRua(nome)}`;
  else if (tipo === 'on ramp') texto = `Pegue o acesso ${para}${paraRua(nome)}`;
  else if (tipo === 'off ramp') texto = `Pegue a saída ${para}${paraRua(nome)}`;
  else if (tipo === 'merge') texto = `Entre ${para}${naRua(nome)}`;
  else if (tipo === 'roundabout turn') texto = `Na rotatória, vire ${para}${naRua(nome)}`;
  else if (leve) texto = `Siga ${para}${naRua(nome)}`;
  else if (tipo === 'continue') texto = `Continue ${para}${naRua(nome)}`;
  else texto = `Vire ${para}${naRua(nome)}`;
  return { tipo: lado, texto };
}

export function osrmRouteSteps(route = {}) {
  const passos = [];
  for (const leg of Array.isArray(route.legs) ? route.legs : []) {
    for (const step of Array.isArray(leg.steps) ? leg.steps : []) {
      const instrucao = textoDoPasso(step);
      const [lon, lat] = Array.isArray(step.maneuver?.location) ? step.maneuver.location.map(Number) : [];
      if (!instrucao || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      passos.push({ ...instrucao, lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) });
    }
  }
  return passos.slice(0, 120);
}
