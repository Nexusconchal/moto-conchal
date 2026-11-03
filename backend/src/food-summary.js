// Números do MotoJÁ Food para o painel do dono. O Food roda em outro serviço; esta rota busca o resumo
// dele servidor-a-servidor com FOOD_PLATFORM_KEY (a mesma chave configurada no serviço do Food).
const PERIODOS = [1, 7, 30, 90, 365];

export async function buscarResumoFood({ dias = 30, env = process.env, fetcher = fetch } = {}) {
  const base = String(env.FOOD_URL || '').replace(/\/+$/, '');
  const chave = String(env.FOOD_PLATFORM_KEY || '');
  if (!base || !chave) return { configurado: false };
  const periodo = PERIODOS.includes(Number(dias)) ? Number(dias) : 30;
  // O Food pode estar acordando no Render: espera até 25 s antes de desistir.
  const resposta = await fetcher(`${base}/api/platform/summary?days=${periodo}`, {
    headers: { 'x-motoja-key': chave },
    signal: AbortSignal.timeout(25000)
  });
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) {
    const erro = new Error(dados.message || `O MotoJÁ Food respondeu ${resposta.status}.`);
    erro.status = 502;
    throw erro;
  }
  return { configurado: true, foodUrl: base, ...dados };
}
