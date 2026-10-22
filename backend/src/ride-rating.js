// Avaliacao do motoboy pelo cliente, no estilo da 99: nota de 1 a 5 estrelas,
// etiquetas prontas (elogios na nota 5, problemas abaixo de 5) e comentario opcional.
// O motoboy ve a media e os comentarios sem nome do cliente nem codigo da corrida;
// o dono ve tudo.
export const RATING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const RATING_COMMENT_MAX = 300;

export const RATING_TAGS = {
  elogio: ['Ótima direção', 'Simpático', 'Chegou rápido', 'Moto limpa', 'Capacete limpo', 'Ótima conversa'],
  problema: ['Demorou para chegar', 'Direção perigosa', 'Rota ruim', 'Falta de educação', 'Sem capacete para mim', 'Cobrou diferente']
};

const ALL_TAGS = new Set([...RATING_TAGS.elogio, ...RATING_TAGS.problema]);

function ratingError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

// Confere a nota enviada pelo cliente; o comentario passa pelo filtro do chat (sem telefone/link).
export function parseRating(body = {}, maskText = (text) => text) {
  const nota = Number(body.nota);
  if (!Number.isInteger(nota) || nota < 1 || nota > 5) throw ratingError('nota_invalida', 'Escolha de 1 a 5 estrelas.');
  const allowed = nota === 5 ? RATING_TAGS.elogio : RATING_TAGS.problema;
  const tags = [...new Set((Array.isArray(body.tags) ? body.tags : []).map(String))]
    .filter((tag) => ALL_TAGS.has(tag) && allowed.includes(tag))
    .slice(0, 6);
  const comentario = String(maskText(String(body.comentario || '').slice(0, RATING_COMMENT_MAX * 2)) || '').slice(0, RATING_COMMENT_MAX).trim();
  return { nota, tags, comentario };
}

// Corrida que o cliente ainda pode avaliar: finalizada, com motoboy, sem nota e dentro de 7 dias.
export function ratingBlocker(ride = {}, finishedAtMs = 0, now = Date.now()) {
  if (ride.status !== 'finalizada') return ratingError('corrida_nao_finalizada', 'Você poderá avaliar quando a corrida terminar.', 409);
  if (!/^\d{11}$/.test(String(ride.motoboyCpf || ''))) return ratingError('corrida_sem_motoboy', 'Esta corrida não tem motoboy para avaliar.', 409);
  if (ride.avaliacao) return ratingError('corrida_ja_avaliada', 'Você já avaliou esta corrida. Obrigado!', 409);
  if (finishedAtMs && now - finishedAtMs > RATING_WINDOW_MS) return ratingError('avaliacao_expirada', 'O prazo para avaliar esta corrida terminou.', 409);
  return null;
}

// Media guardada no cadastro do motoboy (soma, quantidade e quantas de cada estrela).
export function ratingSummary(driver = {}) {
  const total = Math.max(0, Number(driver.notaQtd || 0));
  const soma = Math.max(0, Number(driver.notaSoma || 0));
  const dist = driver.notaDist || {};
  return {
    media: total ? Math.round((soma / total) * 100) / 100 : 0,
    total,
    distribuicao: Object.fromEntries([5, 4, 3, 2, 1].map((n) => [n, Math.max(0, Number(dist[n] || 0))]))
  };
}

// O que o motoboy ve de cada avaliacao: nota, etiquetas, comentario e so o dia.
export function driverRatingView(rating = {}) {
  const day = new Date(Number(rating.criadoEmMs || 0));
  return {
    nota: Number(rating.nota || 0),
    tags: Array.isArray(rating.tags) ? rating.tags : [],
    comentario: String(rating.comentario || ''),
    dia: Number.isNaN(day.getTime()) ? '' : day.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
  };
}
