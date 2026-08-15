// admin.js - Lógica do painel do operador (validação humana anti-fraude)
const API_BASE = window.location.origin.includes('localhost')
  ? 'http://localhost:3000/api'
  : `${window.location.origin}/api`;

let ADMIN_TOKEN = sessionStorage.getItem('mc_admin_token') || '';
let ATENDENTE_NOME = sessionStorage.getItem('mc_atendente_nome') || '';
let corridaParaRejeitar = null;
let intervalAtualizacao = null;

const telaLogin = document.getElementById('tela-login');
const painel = document.getElementById('painel');

// ---------- LOGIN ----------
document.getElementById('btn-entrar').addEventListener('click', async () => {
  const nome = document.getElementById('atendente-nome').value.trim();
  const token = document.getElementById('admin-token').value.trim();
  if (!nome || !token) return;

  const ok = await testarToken(token);
  if (!ok) {
    document.getElementById('login-erro').hidden = false;
    return;
  }

  ADMIN_TOKEN = token;
  ATENDENTE_NOME = nome;
  sessionStorage.setItem('mc_admin_token', token);
  sessionStorage.setItem('mc_atendente_nome', nome);
  entrarNoPainel();
});

document.getElementById('btn-sair').addEventListener('click', () => {
  sessionStorage.clear();
  location.reload();
});

async function testarToken(token) {
  try {
    const resp = await fetch(`${API_BASE}/admin/corridas/fila`, {
      headers: { 'x-admin-token': token },
    });
    return resp.ok;
  } catch {
    return false;
  }
}

function entrarNoPainel() {
  telaLogin.hidden = true;
  painel.hidden = false;
  document.getElementById('login-info').hidden = false;
  document.getElementById('atendente-nome-display').textContent = `👤 ${ATENDENTE_NOME}`;

  carregarFila();
  carregarTodas();
  carregarRepasses();

  if (intervalAtualizacao) clearInterval(intervalAtualizacao);
  intervalAtualizacao = setInterval(carregarFila, 8000); // auto-atualiza a fila a cada 8s
}

// Se já tiver token salvo, tenta logar automaticamente
if (ADMIN_TOKEN && ATENDENTE_NOME) {
  testarToken(ADMIN_TOKEN).then((ok) => { if (ok) entrarNoPainel(); });
}

// ---------- TABS ----------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('ativo'));
    document.querySelectorAll('.tab-content').forEach((c) => (c.hidden = true));
    btn.classList.add('ativo');
    document.getElementById(`tab-${btn.dataset.tab}`).hidden = false;
  });
});

// ---------- FETCH HELPER ----------
async function apiAdmin(path, options = {}) {
  const resp = await fetch(`${API_BASE}/admin${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': ADMIN_TOKEN,
      ...(options.headers || {}),
    },
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.erro || 'Erro na requisição.');
  return data;
}

// ---------- FILA DE VALIDAÇÃO ----------
async function carregarFila() {
  try {
    const { corridas } = await apiAdmin('/corridas/fila');
    const lista = document.getElementById('lista-fila');

    if (corridas.length === 0) {
      lista.innerHTML = `<p class="vazio">Nenhuma corrida aguardando validação no momento. ✅</p>`;
      return;
    }

    lista.innerHTML = corridas.map(renderCorridaFila).join('');

    corridas.forEach((c) => {
      document.getElementById(`aprovar-${c.id}`)?.addEventListener('click', () => aprovarCorrida(c.id));
      document.getElementById(`rejeitar-${c.id}`)?.addEventListener('click', () => abrirModalRejeitar(c.id));
    });
  } catch (err) {
    console.error(err);
  }
}

document.getElementById('btn-atualizar-fila').addEventListener('click', carregarFila);

function renderCorridaFila(c) {
  return `
    <div class="corrida-card" id="corrida-${c.id}">
      <div class="linha1">
        <span class="cliente">${c.cliente_nome}</span>
        <span class="status-tag status-${c.status}">${c.status}</span>
      </div>
      <p class="detalhe"><strong>Tel:</strong> ${c.cliente_telefone}</p>
      <p class="detalhe"><strong>Origem:</strong> ${c.origem_endereco}</p>
      <p class="detalhe"><strong>Destino:</strong> ${c.destino_endereco}</p>
      <p class="detalhe"><strong>Distância informada:</strong> ${c.distancia_km} km (${c.faixa_km})</p>
      ${c.observacoes ? `<p class="detalhe"><strong>Obs:</strong> ${c.observacoes}</p>` : ''}
      <div class="valor-destaque-mini">R$ ${(c.valor_centavos / 100).toFixed(2)}</div>
      <div class="acoes">
        <button class="btn-aprovar" id="aprovar-${c.id}">✅ Aprovar e liberar</button>
        <button class="btn-rejeitar" id="rejeitar-${c.id}">❌ Rejeitar</button>
      </div>
    </div>
  `;
}

async function aprovarCorrida(id) {
  if (!confirm('Confirma que o endereço/distância bate com o valor pago e quer liberar essa corrida para os motoboys?')) return;
  try {
    await apiAdmin(`/corridas/${id}/aprovar`, {
      method: 'POST',
      body: JSON.stringify({ atendente: ATENDENTE_NOME }),
    });
    carregarFila();
    carregarTodas();
  } catch (err) {
    alert(err.message);
  }
}

function abrirModalRejeitar(id) {
  corridaParaRejeitar = id;
  document.getElementById('motivo-rejeicao').value = '';
  document.getElementById('modal-rejeitar').hidden = false;
}

document.getElementById('btn-cancelar-rejeicao').addEventListener('click', () => {
  document.getElementById('modal-rejeitar').hidden = true;
  corridaParaRejeitar = null;
});

document.getElementById('btn-confirmar-rejeicao').addEventListener('click', async () => {
  const motivo = document.getElementById('motivo-rejeicao').value.trim();
  if (!motivo) return alert('Descreva o motivo da rejeição.');

  try {
    await apiAdmin(`/corridas/${corridaParaRejeitar}/rejeitar`, {
      method: 'POST',
      body: JSON.stringify({ atendente: ATENDENTE_NOME, motivo }),
    });
    document.getElementById('modal-rejeitar').hidden = true;
    corridaParaRejeitar = null;
    carregarFila();
    carregarTodas();
  } catch (err) {
    alert(err.message);
  }
});

// ---------- TODAS AS CORRIDAS ----------
async function carregarTodas() {
  const status = document.getElementById('filtro-status').value;
  try {
    const { corridas } = await apiAdmin(`/corridas${status ? `?status=${status}` : ''}`);
    const lista = document.getElementById('lista-todas');

    if (corridas.length === 0) {
      lista.innerHTML = `<p class="vazio">Nenhuma corrida encontrada.</p>`;
      return;
    }

    lista.innerHTML = corridas
      .map(
        (c) => `
      <div class="corrida-card">
        <div class="linha1">
          <span class="cliente">${c.cliente_nome}</span>
          <span class="status-tag status-${c.status}">${c.status}</span>
        </div>
        <p class="detalhe"><strong>Origem:</strong> ${c.origem_endereco} → <strong>Destino:</strong> ${c.destino_endereco}</p>
        <p class="detalhe"><strong>Distância:</strong> ${c.distancia_km} km | <strong>Valor:</strong> R$ ${(c.valor_centavos / 100).toFixed(2)}</p>
        <p class="detalhe"><strong>Criada em:</strong> ${c.criado_em}</p>
        ${c.validado_por ? `<p class="detalhe"><strong>Validado por:</strong> ${c.validado_por} em ${c.validado_em}</p>` : ''}
        ${c.motivo_rejeicao ? `<p class="detalhe"><strong>Motivo rejeição:</strong> ${c.motivo_rejeicao}</p>` : ''}
      </div>
    `
      )
      .join('');
  } catch (err) {
    console.error(err);
  }
}
document.getElementById('filtro-status').addEventListener('change', carregarTodas);

// ---------- REPASSES ----------
async function carregarRepasses() {
  try {
    const { repasses } = await apiAdmin('/repasses');
    const lista = document.getElementById('lista-repasses');

    if (repasses.length === 0) {
      lista.innerHTML = `<p class="vazio">Nenhum repasse gerado ainda.</p>`;
      return;
    }

    lista.innerHTML = repasses
      .map(
        (r) => `
      <div class="corrida-card">
        <div class="linha1">
          <span class="cliente">${r.cliente_nome}</span>
          <span class="status-tag status-${r.status === 'PAGO' ? 'APPROVED' : 'PAID'}">${r.status}</span>
        </div>
        <p class="detalhe"><strong>Trajeto:</strong> ${r.origem_endereco} → ${r.destino_endereco}</p>
        <p class="detalhe"><strong>Valor total:</strong> R$ ${(r.valor_total_centavos / 100).toFixed(2)}</p>
        <p class="detalhe"><strong>Comissão plataforma (${(r.comissao_percentual * 100).toFixed(0)}%):</strong> R$ ${(r.comissao_centavos / 100).toFixed(2)}</p>
        <p class="detalhe"><strong>Repasse ao motoboy:</strong> R$ ${(r.repasse_centavos / 100).toFixed(2)}</p>
      </div>
    `
      )
      .join('');
  } catch (err) {
    console.error(err);
  }
}
