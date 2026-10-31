// Entregas do MotoJÁ Food no app do motoboy. O Food roda em outro serviço; este backend confere o
// login do motoboy e fala com o Food servidor-a-servidor com FOOD_PLATFORM_KEY (a mesma chave do resumo).
// O Food também chama /api/food/notify com a chave quando um pedido fica pronto.
import { timingSafeEqual } from 'node:crypto';

// O app de corridas grava "engenheiro_coelho"; o Food usa "engenheiro-coelho".
export const CIDADE_FOOD = { conchal: 'conchal', aguai: 'aguai', engenheiro_coelho: 'engenheiro-coelho' };
const CIDADE_APP = Object.fromEntries(Object.entries(CIDADE_FOOD).map(([app, food]) => [food, app]));
export const ACOES_FOOD = ['accept', 'pickup', 'arrived', 'deliver'];

export function foodConfigurado(env = process.env) {
  return !!String(env.FOOD_URL || '').trim() && String(env.FOOD_PLATFORM_KEY || '').length >= 24;
}

// Corpo que o Food espera: CPF, nome e a cidade em que o motoboy pode pegar entrega agora
// (nenhuma quando ele desligou "Entregas"; ainda vê as que já aceitou).
export function motoboyParaFood(cpf, driver = {}, { cidade, recebeEntregas = true } = {}) {
  return { cpf, name: String(driver.nome || 'Motoboy MotoJÁ').slice(0, 70), cities: recebeEntregas && CIDADE_FOOD[cidade] ? [CIDADE_FOOD[cidade]] : [] };
}

export async function chamarFood(caminho, corpo, { env = process.env, fetcher = fetch } = {}) {
  const base = String(env.FOOD_URL || '').replace(/\/+$/, '');
  // O Food pode estar acordando no Render: espera até 25 s antes de desistir.
  const resposta = await fetcher(`${base}/api/platform/${caminho}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-motoja-key': String(env.FOOD_PLATFORM_KEY || '') },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(25000)
  });
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) {
    const erro = new Error(dados.message || `O MotoJÁ Food respondeu ${resposta.status}.`);
    // Erro do motoboy (código errado, já aceita) volta como veio; falha do Food vira 502.
    erro.status = resposta.status >= 400 && resposta.status < 500 ? resposta.status : 502;
    erro.code = dados.error || 'food_erro';
    throw erro;
  }
  return dados;
}

export function chaveFoodConfere(recebida, env = process.env) {
  const a = Buffer.from(String(recebida || ''));
  const b = Buffer.from(String(env.FOOD_PLATFORM_KEY || ''));
  return b.length >= 24 && a.length === b.length && timingSafeEqual(a, b);
}

// Aviso que o Food manda: só o que precisa para o push (sem endereço nem telefone do cliente).
export function avisoFood(corpo = {}) {
  const cidade = CIDADE_APP[corpo.city];
  if (!cidade || !/^[a-zA-Z0-9-]{1,64}$/.test(String(corpo.orderId || ''))) return null;
  const valido = (v) => Number.isSafeInteger(v) && v >= 0;
  // O ganho do motoboy (frete menos a parte do app, mais gorjeta); pedidos antigos mandam só o frete.
  const frete = valido(corpo.earning) ? corpo.earning : valido(corpo.fee) ? corpo.fee : 0;
  return {
    orderId: String(corpo.orderId),
    cidade,
    loja: String(corpo.storeName || 'Loja').slice(0, 60),
    bairro: String(corpo.district || '').slice(0, 60),
    frete,
    km: Number.isFinite(corpo.distanceKm) ? corpo.distanceKm : null
  };
}

export function pushEntregaFood(aviso, tokens, link) {
  const valor = (aviso.frete / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const onde = [aviso.bairro, aviso.km != null ? `${String(aviso.km).replace('.', ',')} km` : ''].filter(Boolean).join(' • ');
  return {
    tokens,
    notification: { title: '🍔 Entrega MotoJÁ Food', body: `${aviso.loja}${onde ? ` • ${onde}` : ''} • você ganha ${valor}` },
    webpush: { headers: { Urgency: 'high', TTL: '300' }, fcmOptions: { link } },
    data: { tipo: 'entrega_food', foodOrderId: aviso.orderId }
  };
}
