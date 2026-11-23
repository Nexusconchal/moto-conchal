// Tela Ganhos do motoboy: quanto ficou pra ele, de onde veio o dinheiro (bolso x app x
// empresa), meta do dia, melhores horarios, extrato por dia e comprovante em PDF.
// motoboy.html chama MotoGanhos.iniciar(opcoes) e depois carregar()/render().
(function () {
  'use strict';

  const ROTULOS = { today: 'Hoje', '7days': '7 dias', '30days': '30 dias', all: 'Geral' };
  const DIAS = { today: 1, '7days': 7, '30days': 30 };
  const FORMAS = {
    dinheiro: ['DINHEIRO', 'd'],
    pix: ['PIX', 'p'],
    cartao: ['CARTÃO', 'c'],
    app: ['APP', 'p'],
    empresa: ['EMPRESA', 'e']
  };
  const CACHE_MS = 5 * 60 * 1000;

  let o = null;
  const st = {
    periodo: 'today', resumo: null, dias: [], ontem: null, saldo: null, extrato: null,
    historico: [], cursor: '', carregandoHist: false, filtro: 'todos', erro: '', metaEditando: false, seq: 0, gerandoPdf: false
  };
  const cache = new Map();

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const moeda = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const diaSP = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const horaSP = (ms) => new Date(ms).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  const km = (v) => Number(v || 0).toFixed(1).replace('.', ',');

  function chaveMeta() { return `motoJaMetaDia:${o?.cpf?.() || ''}`; }
  function meta() {
    try { return Math.max(0, Number(localStorage.getItem(chaveMeta()) || 0)); } catch (_) { return 0; }
  }
  function salvarMeta(valor) {
    try {
      if (valor > 0) localStorage.setItem(chaveMeta(), String(Math.round(valor)));
      else localStorage.removeItem(chaveMeta());
    } catch (_) { /* sem armazenamento: so nao guarda */ }
  }

  async function post(caminho, corpo) {
    const r = await o.fetchRetry(`${o.backend}/api/drivers/${o.cpf()}${caminho}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...o.getProof(), ...corpo }),
      cache: 'no-store'
    }, 25000);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || d.error || 'Não consegui carregar os ganhos.');
    return d;
  }

  async function carregar(atualizar = false) {
    if (!o?.cpf?.()) return;
    const seq = ++st.seq;
    const periodo = st.periodo;
    const guardado = cache.get(periodo);
    if (!atualizar && guardado && Date.now() - guardado.t < CACHE_MS) {
      Object.assign(st, guardado.dados, { erro: '' });
      render();
      precisaHistorico(false);
      return;
    }
    st.resumo = null;
    st.erro = '';
    render();
    try {
      const [resumo, extrato] = await Promise.all([
        post('/earnings/summary', { period: periodo, saldo: true }),
        DIAS[periodo] ? post('/earnings/history', { dias: DIAS[periodo] }) : Promise.resolve(null)
      ]);
      if (seq !== st.seq || !o.ativo()) return;
      const dados = {
        resumo: resumo.summary || {},
        dias: Array.isArray(resumo.days) ? resumo.days : [],
        ontem: resumo.ontem || null,
        saldo: resumo.saldoApp || null,
        extrato: extrato ? (Array.isArray(extrato.items) ? extrato.items : []) : null
      };
      cache.set(periodo, { t: Date.now(), dados });
      Object.assign(st, dados);
      render();
      precisaHistorico(atualizar);
    } catch (error) {
      if (seq !== st.seq || !o.ativo()) return;
      st.erro = error.message || 'Não consegui carregar os ganhos.';
      render();
    }
  }

  // "Geral" usa a lista paginada; dia vazio usa o 1o item para mostrar o ultimo servico.
  function precisaHistorico(atualizar) {
    const vazioHoje = st.periodo === 'today' && !Number(st.resumo?.servicos || 0);
    if ((st.periodo === 'all' || vazioHoje) && (atualizar || !st.historico.length)) carregarHistorico(true);
  }

  async function carregarHistorico(reset = false) {
    if (st.carregandoHist) return;
    st.carregandoHist = true;
    if (reset) { st.historico = []; st.cursor = ''; }
    try {
      const d = await post('/earnings/history', { cursor: st.cursor });
      st.historico.push(...(Array.isArray(d.items) ? d.items : []));
      st.cursor = d.nextCursor || '';
    } catch (error) {
      if (st.periodo === 'all') st.erroHist = error.message || 'Não consegui carregar o histórico.';
    } finally {
      st.carregandoHist = false;
      if (o.ativo()) render();
    }
  }

  // ---------- Partes da tela ----------

  function heroi() {
    const r = st.resumo;
    const n = DIAS[st.periodo];
    const rotulo = st.periodo === 'today' ? 'Ficou pra você hoje' : st.periodo === 'all' ? 'Ficou pra você desde o começo' : `Ficou pra você nos últimos ${n} dias`;
    let lado = '';
    if (st.periodo === 'today' && st.ontem) {
      const dif = Number(r.ganho || 0) - Number(st.ontem.ganho || 0);
      lado = `<span class="mjg-lado">ontem<b class="${dif >= 0 ? 'ok' : 'menos'}">${moeda(st.ontem.ganho)} ${dif >= 0 ? '▲' : '▼'}</b></span>`;
    } else if (n > 1) {
      lado = `<span class="mjg-lado">por dia<b>${moeda(Number(r.ganho || 0) / n)}</b></span>`;
    }
    let metaHtml = '';
    if (st.periodo === 'today') {
      const alvo = meta();
      if (st.metaEditando) {
        metaHtml = `<form class="mjg-meta-form" data-meta-form><label>Meta de hoje (R$)<input type="number" inputmode="numeric" min="0" max="2000" step="10" value="${alvo || ''}" placeholder="150" data-meta-valor></label><button type="submit">Salvar</button><button type="button" class="sec" data-meta-cancelar>Cancelar</button></form>`;
      } else if (alvo) {
        const feito = Number(r.ganho || 0);
        const pct = Math.min(100, Math.round((feito / alvo) * 100));
        const falta = Math.max(0, alvo - feito);
        const media = Number(r.mediaPorServico || 0) || 6;
        metaHtml = `<div class="mjg-bar"><i style="width:${pct}%"></i></div><p class="mjg-meta-txt">${falta > 0
          ? `Meta ${moeda(alvo)} · faltam ${moeda(falta)} (umas <b>${Math.max(1, Math.ceil(falta / media))} corridas</b>)`
          : `🎉 Meta de ${moeda(alvo)} batida!`} <button type="button" class="mjg-link" data-meta-editar>mudar</button></p>`;
      } else {
        metaHtml = `<button type="button" class="mjg-link mjg-meta-nova" data-meta-editar>🎯 Definir meta do dia</button>`;
      }
    }
    return `<div class="mjg-card mjg-heroi"><div class="mjg-heroi-top"><span><small>${esc(rotulo)}</small><strong>${moeda(r.ganho)}</strong></span>${lado}</div>${metaHtml}</div>`;
  }

  function diaVazio() {
    const ultimo = st.historico[0];
    const quando = ultimo ? `${new Date(ultimo.finalizadaEmMs).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })} às ${horaSP(ultimo.finalizadaEmMs)}` : '';
    return `<div class="mjg-card mjg-vazio"><b>Você ainda não rodou hoje.</b><p>Fique Disponível no Início para receber chamadas.${ultimo ? `<br>Seu último serviço: ${esc(quando)} · ${moeda(ultimo.ganho)}` : ''}</p></div>`;
  }

  function separacao(itens) {
    const soma = { dinheiro: 0, app: 0, empresa: 0, outros: 0 };
    let motoja = 0, mp = 0;
    for (const item of itens) {
      const ganho = Number(item.ganho || 0);
      if (item.forma === 'dinheiro') soma.dinheiro += ganho;
      else if (['pix', 'cartao', 'app'].includes(item.forma)) {
        soma.app += ganho;
        if (item.recebedor === 'motoja') motoja += ganho; else mp += ganho;
      } else if (item.forma === 'empresa') soma.empresa += ganho;
      else soma.outros += ganho;
    }
    const cartoes = [];
    if (soma.dinheiro) cartoes.push(['💵 Em dinheiro', soma.dinheiro, 'já ficou no seu bolso']);
    if (soma.app) cartoes.push(['📲 Pago pelo app', soma.app, motoja && mp ? 'Mercado Pago e repasse' : motoja ? 'a MotoJá te repassa' : 'direto no seu Mercado Pago']);
    if (soma.empresa) cartoes.push(['📦 Entregas', soma.empresa, 'de empresas']);
    if (soma.outros) cartoes.push(['⏳ A confirmar', soma.outros, 'pagamento sem registro']);
    if (!cartoes.length) return '';
    return `<div class="mjg-grid">${cartoes.map(([t, v, s]) => `<div class="mjg-mini"><small>${t}</small><b>${moeda(v)}</b><small>${s}</small></div>`).join('')}</div>`;
  }

  function numeros() {
    const r = st.resumo;
    return `<div class="mjg-grid mjg-grid3"><div class="mjg-mini"><small>Serviços</small><b>${Number(r.servicos || 0)}</b><small>${Number(r.corridas || 0)} corridas · ${Number(r.entregas || 0)} entregas</small></div><div class="mjg-mini"><small>Distância</small><b>${km(r.quilometros)} km</b><small>rodados</small></div><div class="mjg-mini"><small>Média</small><b>${moeda(r.mediaPorServico)}</b><small>por serviço</small></div></div>`;
  }

  function cartaoSaldo() {
    const saldo = st.saldo;
    if (!saldo) return '';
    const partes = [];
    if (saldo.devendo || saldo.credito) {
      const movimentos = (saldo.historico || []).slice(0, 5).map((m) => `<div class="mjg-mov"><span>${esc(m.descricao || (m.valor > 0 ? 'Corrida em dinheiro' : 'Desconto'))}<small>${m.emMs ? new Date(m.emMs).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }) : ''}</small></span><b class="${m.valor > 0 ? 'menos' : 'ok'}">${m.valor > 0 ? '−' : '+'} ${moeda(Math.abs(m.valor))}</b></div>`).join('');
      partes.push(`<div class="mjg-card ${saldo.devendo ? 'mjg-deve' : 'mjg-credito'}"><div class="mjg-heroi-top"><span><small>💵 Saldo com o app</small><strong class="${saldo.devendo ? 'menos' : 'ok'}">${saldo.devendo ? '− ' + moeda(saldo.devendo) : moeda(saldo.credito)}</strong></span></div><p class="mjg-nota">${saldo.devendo
        ? 'Taxa do app das corridas pagas em dinheiro. Ela é descontada sozinha da próxima corrida paga pelo app' + (saldo.repasseAPagar ? ' ou do seu repasse.' : '.')
        : 'Crédito a seu favor: entra no próximo repasse.'}</p>${movimentos}</div>`);
    }
    if (Number(saldo.repasseAPagar || 0) > 0) {
      partes.push(`<div class="mjg-card mjg-repasse"><span>🏦 A MotoJá vai te repassar</span><b>${moeda(saldo.repasseAPagar)}</b><small>corridas pagas no cartão/Pix da conta MotoJá${saldo.devendo ? ' (a taxa em dinheiro sai daqui)' : ''}</small></div>`);
    }
    return partes.join('');
  }

  function horarios(itens) {
    if (itens.length < 2) return '';
    const porHora = Array.from({ length: 24 }, () => 0);
    for (const item of itens) {
      const h = Number(new Date(item.finalizadaEmMs).toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hourCycle: 'h23' }));
      if (Number.isFinite(h)) porHora[h] += Number(item.ganho || 0);
    }
    const de = 6, ate = 23;
    const faixa = porHora.slice(de, ate + 1);
    const maior = Math.max(...faixa);
    if (!maior) return '';
    let pico = de;
    for (let h = de; h < ate; h += 1) if (porHora[h] + porHora[h + 1] > porHora[pico] + porHora[pico + 1]) pico = h;
    const barras = faixa.map((v, i) => `<i class="${de + i === pico || de + i === pico + 1 ? 'pico' : ''}" style="height:${Math.max(4, Math.round((v / maior) * 60))}px" title="${de + i}h: ${moeda(v)}"></i>`).join('');
    return `<div class="mjg-card"><div class="mjg-titulo"><b>${st.periodo === 'today' ? 'Seus horários hoje' : 'Seus melhores horários'}</b><span class="mjg-laranja">pico ${pico}h–${pico + 2}h</span></div><div class="mjg-horas">${barras}</div><div class="mjg-horas-leg"><span>6h</span><span>10h</span><span>14h</span><span>18h</span><span>23h</span></div></div>`;
  }

  function graficoDias() {
    if (!['7days', '30days'].includes(st.periodo) || !st.dias.length) return '';
    const maior = Math.max(1, ...st.dias.map((d) => Number(d.ganho || 0)));
    return `<div class="mjg-card"><div class="mjg-titulo"><b>Por dia</b></div><div class="mjg-dias ${st.periodo === '30days' ? 'mjg-dias30' : ''}">${st.dias.map((d) => `<div title="${esc(d.dia)}: ${moeda(d.ganho)}"><i style="height:${Math.max(3, Math.round((Number(d.ganho || 0) / maior) * 80))}px"></i><small>${esc(String(d.dia || '').slice(8, 10))}</small></div>`).join('')}</div></div>`;
  }

  function linha(item) {
    const entrega = item.tipo === 'entrega';
    const n = Number(item.quantidadeEntregas || 1);
    const tipo = entrega ? (item.entregaNaNota ? `Lote de ${n} entregas` : n > 1 ? `${n} entregas` : 'Entrega') : 'Corrida';
    const forma = FORMAS[item.forma];
    const tag = forma ? `<span class="mjg-tag ${forma[1]}">${forma[0]}</span>` : '';
    const trajeto = [item.origem, item.destino].filter(Boolean).join(' → ');
    const sub = [trajeto, Number(item.quilometros || 0) ? `${km(item.quilometros)} km` : '', horaSP(item.finalizadaEmMs)].filter(Boolean).join(' · ');
    const nota = item.forma === 'dinheiro' && Number(item.taxaApp || 0) > 0 ? `taxa ${moeda(item.taxaApp)}`
      : item.recebedor === 'motoja' ? 'repasse MotoJá' : item.recebedor === 'mercadopago' ? 'no seu MP' : '';
    return `<div class="mjg-tx"><span class="mjg-ic">${entrega ? '📦' : '🏍️'}</span><div><b>${tipo}${item.titulo ? ` · ${esc(item.titulo)}` : ''} ${tag}</b><small>${esc(sub)}</small></div><em>${moeda(item.ganho)}${nota ? `<small>${esc(nota)}</small>` : ''}</em></div>`;
  }

  function nomeDia(dia) {
    const hoje = diaSP(Date.now());
    const ontem = diaSP(Date.now() - 86400000);
    if (dia === hoje) return 'Hoje';
    if (dia === ontem) return 'Ontem';
    const d = new Date(`${dia}T12:00:00-03:00`);
    return d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
  }

  function extrato(itens, { paginado = false } = {}) {
    const filtrados = itens.filter((i) => st.filtro === 'todos' || (st.filtro === 'corridas' ? i.tipo !== 'entrega' : i.tipo === 'entrega'));
    const grupos = new Map();
    for (const item of filtrados) {
      const dia = diaSP(item.finalizadaEmMs);
      if (!grupos.has(dia)) grupos.set(dia, []);
      grupos.get(dia).push(item);
    }
    const filtros = `<div class="mjg-chips mjg-chips-sm">${[['todos', 'Todos'], ['corridas', 'Corridas'], ['entregas', 'Entregas']].map(([k, t]) => `<button type="button" data-filtro-ganhos="${k}" class="${st.filtro === k ? 'on' : ''}">${t}</button>`).join('')}</div>`;
    const corpo = grupos.size
      ? [...grupos.entries()].map(([dia, lista]) => `<div class="mjg-dia"><span>${esc(nomeDia(dia))}</span><b>${moeda(lista.reduce((s, i) => s + Number(i.ganho || 0), 0))}</b></div><div class="mjg-card mjg-lista">${lista.map(linha).join('')}</div>`).join('')
      : `<div class="mjg-vazio-lista">${st.carregandoHist ? 'Carregando...' : 'Nenhum serviço neste período.'}</div>`;
    const mais = paginado && st.cursor ? `<button type="button" class="mjg-mais" data-mais-ganhos ${st.carregandoHist ? 'disabled' : ''}>${st.carregandoHist ? 'Carregando...' : 'Carregar mais 20'}</button>` : '';
    return `<div class="mjg-sec"><h3>Extrato</h3>${filtros}</div>${corpo}${mais}`;
  }

  function render() {
    const lista = o?.lista?.();
    if (!lista || !o.ativo()) return;
    estilos();
    const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: 'numeric', month: 'long' });
    const cabeca = `<div class="mjg-head"><div><h2>Meus ganhos</h2><p>${esc(st.periodo === 'today' ? hoje : 'Resumo do período')}</p></div><button type="button" class="mjg-refresh" data-atualizar-ganhos aria-label="Atualizar ganhos">↻</button></div><div class="mjg-chips">${Object.entries(ROTULOS).map(([k, t]) => `<button type="button" data-periodo-ganhos="${k}" class="${st.periodo === k ? 'on' : ''}">${t}</button>`).join('')}</div>`;
    let corpo;
    if (st.erro) {
      corpo = `<div class="mjg-card mjg-erro">${esc(st.erro)}<button type="button" class="mjg-mais" data-atualizar-ganhos>Tentar de novo</button></div>`;
    } else if (!st.resumo) {
      corpo = '<div class="mjg-card mjg-carregando">Carregando seus ganhos...</div>';
    } else {
      const itens = st.periodo === 'all' ? st.historico : (st.extrato || []);
      const vazio = !Number(st.resumo.servicos || 0);
      const pdf = DIAS[st.periodo] && itens.length
        ? `<button type="button" class="mjg-pdf" data-pdf-ganhos ${st.gerandoPdf ? 'disabled' : ''}>${st.gerandoPdf ? 'Gerando comprovante...' : `📄 Comprovante de ganhos (PDF) · ${ROTULOS[st.periodo].toLowerCase()}`}</button>`
        : '';
      corpo = [
        heroi(),
        vazio && st.periodo === 'today' ? diaVazio() : '',
        vazio ? '' : separacao(itens),
        vazio ? '' : numeros(),
        cartaoSaldo(),
        vazio ? '' : horarios(itens),
        graficoDias(),
        vazio && st.periodo === 'today' ? '' : extrato(itens, { paginado: st.periodo === 'all' }),
        pdf
      ].join('');
    }
    lista.innerHTML = `<section class="mjg">${cabeca}${corpo}</section>`;
    ligar(lista);
  }

  function ligar(lista) {
    lista.querySelectorAll('[data-periodo-ganhos]').forEach((b) => {
      b.onclick = () => { st.periodo = b.dataset.periodoGanhos; st.metaEditando = false; carregar(); };
    });
    lista.querySelectorAll('[data-atualizar-ganhos]').forEach((b) => { b.onclick = () => carregar(true); });
    lista.querySelectorAll('[data-filtro-ganhos]').forEach((b) => { b.onclick = () => { st.filtro = b.dataset.filtroGanhos; render(); }; });
    lista.querySelector('[data-mais-ganhos]')?.addEventListener('click', () => carregarHistorico(false));
    lista.querySelectorAll('[data-meta-editar]').forEach((b) => { b.onclick = () => { st.metaEditando = true; render(); lista.querySelector('[data-meta-valor]')?.focus(); }; });
    lista.querySelector('[data-meta-cancelar]')?.addEventListener('click', () => { st.metaEditando = false; render(); });
    lista.querySelector('[data-meta-form]')?.addEventListener('submit', (event) => {
      event.preventDefault();
      salvarMeta(Number(lista.querySelector('[data-meta-valor]')?.value || 0));
      st.metaEditando = false;
      render();
    });
    lista.querySelector('[data-pdf-ganhos]')?.addEventListener('click', comprovante);
  }

  // ---------- Comprovante em PDF (renda para financiamento, aluguel...) ----------

  function carregarScript(src) {
    if (window.jspdf?.jsPDF) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { s.remove(); reject(new Error('Não consegui preparar o PDF. Confira a internet e tente de novo.')); };
      document.head.append(s);
    });
  }
  // As fontes do PDF so tem letras latinas: tira emoji e troca a seta.
  const pdfTexto = (v) => String(v ?? '').replace(/→/g, '>').replace(/[^\x20-\x7E -ÿ]/g, '').replace(/\s+/g, ' ').trim();
  const cpfFormatado = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : d; };

  async function comprovante() {
    if (st.gerandoPdf) return;
    const itens = (st.extrato || []).slice().sort((a, b) => a.finalizadaEmMs - b.finalizadaEmMs);
    if (!itens.length) return;
    st.gerandoPdf = true;
    render();
    try {
      await carregarScript('./vendor/jspdf-4.2.1.min.js');
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: 'mm', format: 'a4' });
      const n = DIAS[st.periodo];
      const ate = new Date();
      const desde = new Date(Date.now() - (n - 1) * 86400000);
      const data = (d) => d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      const r = st.resumo || {};
      let y = 18;
      const linhaTxt = (txt, x, tam = 10, negrito = false) => { doc.setFont('helvetica', negrito ? 'bold' : 'normal'); doc.setFontSize(tam); doc.text(pdfTexto(txt), x, y); };
      doc.setFillColor(255, 107, 0); doc.rect(0, 0, 210, 6, 'F');
      linhaTxt('Comprovante de ganhos', 14, 18, true); y += 7;
      linhaTxt('Nexus MotoJá - mototáxi e entregas', 14, 10); y += 10;
      linhaTxt(`Motoboy: ${o.nome?.() || ''}`, 14, 11, true); y += 6;
      linhaTxt(`CPF: ${cpfFormatado(o.cpf())}`, 14, 10); y += 6;
      linhaTxt(`Período: ${data(desde)} a ${data(ate)}`, 14, 10); y += 10;
      const sep = { dinheiro: 0, app: 0, empresa: 0, outros: 0 };
      itens.forEach((i) => { const v = Number(i.ganho || 0); if (i.forma === 'dinheiro') sep.dinheiro += v; else if (['pix', 'cartao', 'app'].includes(i.forma)) sep.app += v; else if (i.forma === 'empresa') sep.empresa += v; else sep.outros += v; });
      const resumoLinhas = [
        ['Total que ficou para o motoboy', moeda(r.ganho)],
        ['Serviços realizados', `${Number(r.servicos || 0)} (${Number(r.corridas || 0)} corridas, ${Number(r.entregas || 0)} entregas)`],
        ['Distância rodada', `${km(r.quilometros)} km`],
        ['Recebido em dinheiro', moeda(sep.dinheiro)],
        ['Pago pelo aplicativo (Pix/cartão)', moeda(sep.app)],
        ['Entregas de empresas', moeda(sep.empresa)]
      ];
      if (sep.outros) resumoLinhas.push(['Pagamento a confirmar', moeda(sep.outros)]);
      doc.setDrawColor(220); doc.roundedRect(12, y - 5, 186, resumoLinhas.length * 6.5 + 4, 2, 2);
      resumoLinhas.forEach(([k, v]) => { linhaTxt(k, 16, 10); doc.setFont('helvetica', 'bold'); doc.text(pdfTexto(v), 194, y, { align: 'right' }); y += 6.5; });
      y += 8;
      linhaTxt('Serviços', 14, 12, true); y += 6;
      const cab = () => { doc.setFillColor(245, 245, 245); doc.rect(12, y - 4.5, 186, 6.5, 'F'); linhaTxt('Data', 14, 9, true); doc.text('Serviço', 44, y); doc.text('Trajeto', 82, y); doc.text('Valor', 194, y, { align: 'right' }); y += 6; };
      cab();
      for (const i of itens) {
        if (y > 280) { doc.addPage(); y = 18; cab(); }
        const entrega = i.tipo === 'entrega';
        const tipo = entrega ? (Number(i.quantidadeEntregas || 1) > 1 ? `${i.quantidadeEntregas} entregas` : 'Entrega') : 'Corrida';
        const forma = FORMAS[i.forma]?.[0] || '';
        linhaTxt(`${new Date(i.finalizadaEmMs).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' })} ${horaSP(i.finalizadaEmMs)}`, 14, 8.5);
        doc.text(pdfTexto(`${tipo}${forma ? ` (${forma.toLowerCase()})` : ''}`), 44, y);
        doc.text(pdfTexto(`${i.origem || ''} > ${i.destino || ''}`).slice(0, 62), 82, y);
        doc.text(pdfTexto(moeda(i.ganho)), 194, y, { align: 'right' });
        y += 5.5;
      }
      y = Math.min(y + 8, 285);
      if (y > 270) { doc.addPage(); y = 20; }
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
      doc.text(pdfTexto('Valores que ficaram para o motoboy, já sem a taxa do aplicativo. Corridas em dinheiro: o motoboy recebeu direto do cliente.'), 14, y); y += 4.5;
      doc.text(pdfTexto(`Gerado em ${ate.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} pelo app Nexus MotoJá (nexusmotoja.com.br).`), 14, y);
      const nome = `ganhos-motoja-${diaSP(desde.getTime())}-a-${diaSP(ate.getTime())}.pdf`;
      const blob = doc.output('blob');
      const arquivo = typeof File === 'function' ? new File([blob], nome, { type: 'application/pdf' }) : null;
      // No celular abre "Compartilhar" (salvar, WhatsApp...); senao baixa o arquivo.
      if (arquivo && navigator.canShare?.({ files: [arquivo] })) {
        await navigator.share({ files: [arquivo], title: 'Comprovante de ganhos MotoJá' }).catch(() => {});
      } else {
        doc.save(nome);
      }
    } catch (error) {
      alert(error.message || 'Não consegui gerar o PDF agora.');
    } finally {
      st.gerandoPdf = false;
      render();
    }
  }

  // ---------- Estilos (ficam aqui para a tela ser um arquivo so) ----------

  function estilos() {
    if (document.getElementById('mjg-css')) return;
    const css = document.createElement('style');
    css.id = 'mjg-css';
    css.textContent = `
#lista{grid-template-columns:minmax(0,1fr)}
.mjg{display:grid;grid-template-columns:minmax(0,1fr);gap:10px;padding-bottom:12px;min-width:0}
.mjg>*{min-width:0}
.mjg-head{display:flex;justify-content:space-between;align-items:center;gap:10px}
.mjg-head h2{font-size:1.45rem;margin:0}.mjg-head p{margin:2px 0 0;color:#9aa0ab;font-size:.82rem}.mjg-head p::first-letter{text-transform:uppercase}
.mjg-refresh{width:44px;height:44px;border-radius:50%;border:1px solid #2a2e39;background:#171a22;color:#fff;font-size:1.2rem;box-shadow:none}
.mjg-chips{display:grid;grid-template-columns:repeat(4,1fr);gap:7px}
.mjg-chips button{min-height:40px;border-radius:12px;border:1px solid #2a2e39;background:#14161d;color:#cfd3da;font-weight:800;font-size:.82rem;box-shadow:none;padding:6px}
.mjg-chips button.on{background:linear-gradient(135deg,#ff6b00,#ff9a00);color:#fff;border-color:transparent}
.mjg-chips-sm{grid-template-columns:repeat(3,1fr)}.mjg-chips-sm button{min-height:34px;font-size:.78rem}
.mjg-card{background:#12141b;border:1px solid #262a35;border-radius:16px;padding:12px 13px}
.mjg-heroi-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.mjg-heroi-top small{display:block;color:#9aa0ab;font-size:.78rem;font-weight:700}
.mjg-heroi-top strong{display:block;font-size:1.9rem;font-weight:900;line-height:1.1;margin-top:2px}
.mjg-lado{text-align:right;color:#9aa0ab;font-size:.75rem;font-weight:700}.mjg-lado b{display:block;font-size:.98rem;color:#fff}
.mjg .ok{color:#7ee2a8!important}.mjg .menos{color:#ff9a6a!important}.mjg-laranja{color:#ffb020;font-size:.78rem;font-weight:800}
.mjg-bar{height:9px;border-radius:9px;background:#252935;margin-top:10px;overflow:hidden}.mjg-bar i{display:block;height:100%;border-radius:9px;background:linear-gradient(90deg,#ff7a00,#ffb020)}
.mjg-meta-txt{margin:7px 0 0;color:#9aa0ab;font-size:.8rem}.mjg-meta-txt b{color:#fff}
.mjg-link{background:none!important;border:0;color:#ffb020;font-weight:800;font-size:.8rem;padding:0;min-height:0;box-shadow:none;text-decoration:underline}
.mjg-meta-nova{margin-top:8px;text-decoration:none;font-size:.86rem}
.mjg-meta-form{display:flex;gap:8px;align-items:flex-end;margin-top:10px;flex-wrap:wrap}.mjg-meta-form label{flex:1;min-width:130px;font-size:.78rem;color:#9aa0ab;display:grid;gap:4px}
.mjg-meta-form input{min-height:42px}.mjg-meta-form button{min-height:42px;padding:0 14px;border-radius:12px}.mjg-meta-form .sec{background:#1f232c;border:1px solid #2a2e39;box-shadow:none}
.mjg-vazio b{font-size:1rem}.mjg-vazio p{margin:4px 0 0;color:#9aa0ab;font-size:.84rem;line-height:1.4}
.mjg-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.mjg-grid3{grid-template-columns:repeat(3,1fr)}
.mjg-mini{background:#12141b;border:1px solid #262a35;border-radius:14px;padding:10px 11px;min-width:0}
.mjg-mini small{display:block;font-size:.7rem;color:#9aa0ab;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mjg-mini b{display:block;font-size:1.08rem;font-weight:900;margin:2px 0}
.mjg-deve{border-color:rgba(255,138,0,.45);background:rgba(255,138,0,.08)}.mjg-credito{border-color:rgba(53,201,121,.4);background:rgba(53,201,121,.08)}
.mjg-nota{margin:6px 0 0;color:#9aa0ab;font-size:.78rem;line-height:1.4}
.mjg-mov{display:flex;justify-content:space-between;gap:10px;font-size:.8rem;padding:6px 0;border-top:1px solid rgba(255,255,255,.07);margin-top:6px}.mjg-mov small{display:block;color:#8a8e98;font-size:.7rem}
.mjg-repasse{display:grid;grid-template-columns:1fr auto;gap:2px 10px;align-items:center;border-color:rgba(53,201,121,.4)}
.mjg-repasse span{font-weight:800;font-size:.88rem}.mjg-repasse b{color:#7ee2a8;font-size:1.15rem}.mjg-repasse small{grid-column:1/-1;color:#9aa0ab;font-size:.74rem}
.mjg-titulo{display:flex;justify-content:space-between;align-items:center;gap:8px}.mjg-titulo b{font-size:.92rem}
.mjg-horas{display:flex;align-items:flex-end;gap:3px;height:64px;margin-top:10px}.mjg-horas i{flex:1;border-radius:4px 4px 2px 2px;background:#2a2f3b}.mjg-horas i.pico{background:linear-gradient(180deg,#ffb020,#ff7a00)}
.mjg-horas-leg{display:flex;justify-content:space-between;font-size:.66rem;color:#8a8e98;margin-top:4px}
.mjg-dias{display:flex;align-items:flex-end;gap:6px;height:100px;margin-top:10px}.mjg-dias div{flex:1;display:grid;justify-items:center;gap:3px;align-content:end;height:100%}
.mjg-dias i{display:block;width:100%;border-radius:6px 6px 2px 2px;background:linear-gradient(180deg,#ffb020,#ff7a00)}.mjg-dias small{font-size:.62rem;color:#8a8e98}
.mjg-dias30{gap:2px}.mjg-dias30 small{font-size:0}
.mjg-sec{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:6px}.mjg-sec h3{margin:0;font-size:1.05rem}.mjg-sec .mjg-chips{flex:1;max-width:260px}
.mjg-dia{display:flex;justify-content:space-between;font-size:.74rem;font-weight:800;color:#9aa0ab;padding:6px 2px 0;text-transform:uppercase;letter-spacing:.4px}.mjg-dia b{color:#7ee2a8}
.mjg-lista{padding:0}
.mjg-tx{display:flex;gap:10px;align-items:center;padding:10px 12px;border-bottom:1px solid #262a35}.mjg-tx:last-child{border-bottom:0}
.mjg-ic{width:34px;height:34px;border-radius:10px;background:#1c2029;display:grid;place-items:center;font-size:16px;flex:none}
.mjg-tx div{flex:1;min-width:0}.mjg-tx b{font-size:.84rem;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mjg-tx small{display:block;font-size:.72rem;color:#9aa0ab;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mjg-tx em{font-style:normal;text-align:right;font-weight:900;font-size:.92rem;white-space:nowrap}.mjg-tx em small{font-weight:700;font-size:.66rem;color:#ffb27a}
.mjg-tag{font-size:.6rem;font-weight:900;border-radius:6px;padding:2px 5px;margin-left:3px;vertical-align:1px}
.mjg-tag.d{background:rgba(255,176,32,.16);color:#ffcf7a}.mjg-tag.p{background:rgba(34,184,102,.16);color:#7ee2a8}.mjg-tag.c{background:rgba(117,167,255,.16);color:#a9c6ff}.mjg-tag.e{background:rgba(255,255,255,.08);color:#d0d3da}
.mjg-vazio-lista{padding:14px;text-align:center;color:#9aa0ab;font-size:.86rem}
.mjg-mais{width:100%;min-height:44px;border-radius:12px;background:#1a1d26;border:1px solid #2a2e39;box-shadow:none;margin-top:6px}
.mjg-pdf{width:100%;min-height:48px;border-radius:14px;background:#1a1d26;border:1px dashed rgba(255,154,0,.6);color:#ffd39a;font-weight:800;box-shadow:none;margin-top:4px}
.mjg-erro{color:#ffc4c4}.mjg-carregando{color:#9aa0ab;text-align:center}
@media (max-width:380px){.mjg-grid3{grid-template-columns:1fr 1fr}.mjg-heroi-top strong{font-size:1.6rem}}`;
    document.head.append(css);
  }

  window.MotoGanhos = {
    iniciar(opcoes) { o = opcoes; },
    carregar,
    render,
    limpar() { cache.clear(); st.historico = []; st.cursor = ''; },
    periodo: () => st.periodo
  };
})();
