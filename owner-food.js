// MotoJÁ Food no painel do dono: números, pedidos, empresas (aprovar, pausar, entrega grátis),
// promoções pagas pela MotoJá, avisos no celular dos clientes, equipe e atendimento.
// Tudo passa por /api/admin/food/admin com a senha do dono; o Food confere quais ações são liberadas.
(function () {
  "use strict";
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const reais = (centavos) => (Number(centavos || 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const backend = () => window.CONFIG?.backend || "";
  const senha = () => window.senhaDono || document.getElementById("senha")?.value?.trim() || "";
  const $ = (id) => document.getElementById(id);
  const card = (valor, rotulo) => `<div class="fd-num"><b>${valor}</b><span>${rotulo}</span></div>`;
  const tabela = (cabecalho, linhas) => `<div class="table compact"><table><thead><tr>${cabecalho.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${linhas.join("")}</tbody></table></div>`;
  const vazio = (texto) => `<div class="empty">${texto}</div>`;
  const CIDADES = { conchal: "Conchal", aguai: "Aguaí", "engenheiro-coelho": "Engenheiro Coelho" };
  const cidadeOpcoes = () => Object.entries(CIDADES).map(([id, nome]) => `<option value="${id}">${nome}</option>`).join("");
  const STATUS = { novo: "🆕 Novo", preparo: "👨‍🍳 Preparando", pronto: "✅ Pronto", entrega: "🛵 Saiu para entrega", entregue: "📦 Entregue", cancelado: "✖ Cancelado" };
  const PAGAMENTO = { dinheiro: "Dinheiro", cartao: "Cartão", vale: "Vale", app: "Cartão pelo app", pix: "Pix pelo app" };
  const PROBLEMA = { atraso: "Atraso", item: "Problema no item", endereco: "Endereço", pagamento: "Pagamento", cliente_ausente: "Cliente ausente", outro: "Outro" };
  const ABAS = [["resumo", "Resumo"], ["pedidos", "Pedidos"], ["empresas", "Empresas"], ["promocoes", "Promoções"], ["avisos", "Avisos"], ["acerto", "Acerto"], ["equipe", "Equipe"], ["atendimento", "Atendimento"]];
  const PIX = { cpf: "CPF", cnpj: "CNPJ", email: "E-mail", telefone: "Celular", aleatoria: "Chave aleatória" };
  const QUEM = { motoboy: "motoboy (dinheiro)", loja: "loja (maquininha/caixa)", motoja: "app" };
  const hojeSP = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
  const hora = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-");
  const local = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const centavos = (v) => { const t = String(v || "0").trim().replace(",", "."); if (!/^\d+(\.\d{1,2})?$/.test(t)) throw new Error("Confira os valores em reais, como 10,00."); return Math.round(Number(t) * 100); };
  const ABERTOS = ["novo", "preparo", "pronto", "entrega"];

  let aba = "resumo";
  let estado = null;
  let carregando = false;

  function injectStyle() {
    if ($("food-admin-style")) return;
    const s = document.createElement("style");
    s.id = "food-admin-style";
    s.textContent = `
      .fd-abas{display:flex;gap:6px;overflow:auto;scrollbar-width:none;padding-bottom:2px}
      .fd-abas::-webkit-scrollbar{display:none}
      .fd-abas button{min-height:38px;padding:8px 14px;white-space:nowrap;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);box-shadow:none;font-size:.82rem}
      .fd-abas button.on{background:linear-gradient(135deg,#ff6b00,#ff9a00);color:#111;border-color:transparent}
      .fd-abas button i{font-style:normal;margin-left:6px;padding:1px 7px;border-radius:999px;background:#ff5252;color:#fff;font-size:.72rem}
      .fd-nums{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
      .fd-num{background:rgba(255,184,0,.08);border:1px solid rgba(255,184,0,.25);border-radius:12px;padding:12px}
      .fd-num b{display:block;font-size:20px}.fd-num span{color:#aeb4c3;font-size:12px}
      .fd-form{display:grid;gap:10px;padding:14px;border-radius:14px;border:1px solid rgba(255,255,255,.1);background:rgba(7,9,17,.46)}
      .fd-form [hidden]{display:none!important}
      .fd-linha{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
      .fd-form h3,.fd-sub{font-size:.95rem;margin:4px 0}
      .fd-check{display:flex;align-items:center;gap:10px;font-weight:700}.fd-check input{width:auto}
      .fd-erro{color:#ffb4ab;font-weight:800}
      .fd-ok{color:#bfffd2;font-weight:800}
      .fd-tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.72rem;font-weight:900;background:rgba(255,255,255,.08)}
      .fd-tag.verde{background:rgba(37,211,102,.15);color:#bfffd2}.fd-tag.amarela{background:rgba(255,215,0,.14);color:#ffd700}.fd-tag.vermelha{background:rgba(255,82,82,.16);color:#ffb4ab}
      #food-section td small{color:#aeb4c3}
      #food-section td a{color:#ffb02e}
      #food-section td button.sec{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14)}
      #food-section td button.perigo{background:rgba(255,82,82,.16);border:1px solid rgba(255,82,82,.4);color:#ffb4ab}`;
    document.head.appendChild(s);
  }

  async function food(method, path, body) {
    const r = await fetch(`${backend()}/api/admin/food/admin`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-owner-password": senha() },
      body: JSON.stringify({ method, path, body }),
      cache: "no-store",
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status >= 500 ? "O MotoJÁ Food não respondeu agora. Ele pode estar acordando: tente de novo em 30 segundos." : d.message || "Não deu certo.");
    return d;
  }

  function montar() {
    const sec = $("food-section");
    if (!sec || $("foodAbas")) return;
    injectStyle();
    $("foodResumo").insertAdjacentHTML("beforebegin", `<div id="foodAbas" class="fd-abas" role="tablist"></div><p id="foodMsg" class="fd-ok" hidden></p>`);
    $("foodResumo").classList.remove("table", "compact");
    $("foodResumo").classList.add("grid");
    sec.addEventListener("click", clique);
    sec.addEventListener("submit", enviar);
    sec.addEventListener("change", mudou);
  }

  function contagens() {
    return {
      empresas: (estado?.empresas || []).filter((e) => !e.isDemo && e.approval === "pendente").length,
      atendimento: (estado?.incidents || []).filter((i) => i.status !== "resolvido").length,
      pedidos: (estado?.orders || []).filter((o) => ABERTOS.includes(o.status)).length,
      acerto: (estado?.acerto?.pending || []).length,
    };
  }

  function renderAbas() {
    const n = contagens();
    $("foodAbas").innerHTML = ABAS.map(([id, nome]) => `<button type="button" data-fd-aba="${id}" class="${id === aba ? "on" : ""}">${nome}${n[id] ? `<i>${n[id]}</i>` : ""}</button>`).join("");
    const filtro = $("foodDias");
    if (filtro) filtro.hidden = aba !== "resumo";
  }

  function aviso(texto, erro = false) {
    const m = $("foodMsg");
    if (!m) return;
    m.hidden = !texto;
    m.className = erro ? "fd-erro" : "fd-ok";
    m.textContent = texto || "";
    if (texto && !erro) setTimeout(() => { if (m.textContent === texto) m.hidden = true; }, 6000);
  }

  // Estado do Food (lojas, produtos, pedidos, equipe, atendimentos) + empresas, promoções e avisos.
  async function carregarEstado() {
    const st = await food("GET", "state");
    if (!st.configurado) return null;
    const [emp, acerto, camp, avisos] = await Promise.all([
      food("GET", "partner/stores"),
      food("GET", "settlements").catch(() => ({ parties: [], pending: [] })),
      food("GET", "campaigns"),
      food("GET", "push/promos").catch(() => ({ promos: [] })),
    ]);
    return { ...st, empresas: emp.stores || [], campanhas: camp.campaigns || [], promosEnviadas: avisos.promos || [], acerto };
  }

  async function carregar() {
    const box = $("foodResumo");
    if (!box || !senha() || carregando) return;
    montar();
    carregando = true;
    try {
      if (aba === "resumo" && !(await renderResumo(box))) return;
      estado = await carregarEstado();
      if (!estado) { renderDesligado(box); return; }
      render();
    } catch (error) {
      if (aba !== "resumo") box.innerHTML = `<div class="fd-erro" style="padding:12px">${esc(error.message)}</div>`;
      else aviso(error.message, true);
    } finally {
      carregando = false;
    }
  }

  function renderDesligado(box) {
    $("foodAbas").innerHTML = "";
    box.innerHTML = vazio(`O MotoJÁ Food ainda não está ligado a este painel. Quando o Food estiver no ar, coloque no Render deste serviço <b>FOOD_URL</b> (endereço do Food) e <b>FOOD_PLATFORM_KEY</b> (a mesma chave do serviço do Food).`);
  }

  async function renderResumo(box) {
    const dias = $("foodDias")?.value || "30";
    const r = await fetch(`${backend()}/api/admin/food-summary?dias=${encodeURIComponent(dias)}`, { headers: { "x-owner-password": senha() }, cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || d.error || "Não consegui carregar o MotoJÁ Food.");
    if (!d.configurado) { renderDesligado(box); return false; }
    const link = $("foodAbrir");
    if (link) { link.href = d.foodUrl + "/?painel=gestao"; link.hidden = false; }
    box.innerHTML = `<div class="fd-nums">
        ${card(reais(d.money.platform), "ficou para a MotoJá")}
        ${card(reais(d.money.gross), "vendido pelo app")}
        ${card(d.orders.delivered, "pedidos entregues")}
        ${card(d.deliveries.motoja, "entregas com motoboy MotoJá")}
        ${card(reais(d.money.drivers), "para os motoboys (com gorjeta)")}
        ${card(reais(d.money.stores), "para as lojas")}
        ${card(d.companies.total + (d.companies.pending ? ` (${d.companies.pending} em análise)` : ""), "empresas cadastradas")}
        ${card(d.orders.customers, "clientes que pediram")}
        ${card(reais(d.money.subsidies || 0), "gasto em promoções MotoJá")}
      </div>
      <p class="muted">Comissão ${reais(d.money.commission)} (10% dos produtos) + ${reais(d.money.fleetFeeShare)} do frete MotoJá (R$ 1,50 por entrega). ${esc(d.money.note || "")}</p>
      <h3 class="fd-sub">Por cidade</h3>
      ${tabela(["Cidade", "Lojas", "Pedidos", "Entregues", "MotoJá"], (d.cities || []).map((c) => `<tr><td>${esc(c.name)}</td><td>${c.stores}</td><td>${c.orders}</td><td>${c.delivered}</td><td>${reais(c.platform)}</td></tr>`))}
      <h3 class="fd-sub">Lojas que mais venderam</h3>
      ${(d.topStores || []).length ? tabela(["Loja", "Pedidos", "Vendido", "MotoJá"], d.topStores.map((s) => `<tr><td>${esc(s.name)} <small>${esc(s.city)}</small></td><td>${s.orders}</td><td>${reais(s.gross)}</td><td>${reais(s.platform)}</td></tr>`)) : vazio("Sem pedidos entregues no período.")}
      <h3 class="fd-sub">Motoboys MotoJá no Food</h3>
      ${(d.topDrivers || []).length ? tabela(["Motoboy", "Entregas", "Recebe"], d.topDrivers.map((m) => `<tr><td>${esc(m.name)}</td><td>${m.deliveries}</td><td>${reais(m.earned)}</td></tr>`)) : vazio("Sem entregas de motoboy MotoJá no período.")}`;
    return true;
  }

  const lojaNome = (id) => estado?.stores?.find((s) => s.id === id)?.name || estado?.empresas?.find((s) => s.id === id)?.name || "Loja";
  const whats = (tel) => { const n = String(tel || "").replace(/\D/g, ""); return n ? ` <a href="https://wa.me/55${n}" target="_blank" rel="noopener">WhatsApp</a>` : ""; };

  function renderPedidos() {
    const filtro = $("fdPedidosFiltro")?.value || "abertos";
    const lista = (estado.orders || []).filter((o) => filtro === "todos" || (filtro === "abertos" ? ABERTOS.includes(o.status) : o.status === filtro));
    const opcao = (v, t) => `<option value="${v}" ${filtro === v ? "selected" : ""}>${t}</option>`;
    return `<div class="fd-linha"><label>Mostrar<select id="fdPedidosFiltro">${opcao("abertos", "Em andamento")}${opcao("todos", "Últimos 100")}${opcao("entregue", "Entregues")}${opcao("cancelado", "Cancelados")}</select></label></div>
      ${lista.length ? tabela(["Pedido", "Loja", "Cliente", "Situação", "Entrega", "Total", "Feito em"], lista.map((o) => {
        const entrega = o.mode === "retirada" ? "Retirada" : `${o.deliveryBy === "loja" ? "Motoboy da loja" : "Motoboy MotoJá"}${o.driver ? `<br><small>${esc(o.driver)}</small>` : o.status === "pronto" ? '<br><small class="warn">esperando motoboy</small>' : ""}`;
        return `<tr><td><b>#${esc(o.code)}</b>${o.isDemo ? " <small>teste</small>" : ""}</td><td>${esc(o.storeName || lojaNome(o.store))}<br><small>${whats(o.shopPhone)}</small></td>
          <td>${esc(o.profile?.name || "Cliente")}<br><small>${esc(o.profile?.district || "")}${whats(o.profile?.phone)}</small></td>
          <td>${STATUS[o.status] || esc(o.status)}${o.scheduledFor ? `<br><small>agendado ${hora(o.scheduledFor)}</small>` : ""}</td><td>${entrega}</td>
          <td>${reais(o.total)}<br><small>${PAGAMENTO[o.payment] || esc(o.payment)}${o.paid ? " • pago" : ""}${o.refund ? (o.refund.status === "erro" ? " • ⚠️ devolver no Mercado Pago" : " • devolvido") : ""}${o.campaign ? " • promoção" : ""}</small></td><td>${hora(o.created)}</td></tr>`;
      })) : vazio("Nenhum pedido aqui agora.")}`;
  }

  function renderEmpresas() {
    const ordem = (e) => (e.approval === "pendente" ? 0 : e.isDemo ? 2 : 1);
    const lojas = (estado.empresas || []).slice().sort((a, b) => ordem(a) - ordem(b));
    if (!lojas.length) return vazio("Nenhuma empresa cadastrada ainda.");
    const hoje = hojeSP();
    const escondidas = !!estado.launch?.hideDemo, exemplos = lojas.filter((e) => e.isDemo).length;
    return `${exemplos ? `<div class="fd-form"><b>${escondidas ? "🚀 Modo lançamento ligado: os clientes não veem as lojas de exemplo." : `🧪 ${exemplos} loja(s) de exemplo aparecem para os clientes.`}</b><button type="button" class="${escondidas ? "sec" : ""}" data-fd-demo="${escondidas ? "0" : "1"}">${escondidas ? "Mostrar as lojas de exemplo" : "Esconder as lojas de exemplo (lançamento)"}</button></div>` : ""}<p class="muted">Aprove as empresas novas, pause uma loja na hora ou dê entrega grátis hoje (a loja paga o frete). O Pix de cada loja aparece em "Pix".</p>
      ${tabela(["Empresa", "Cidade", "Situação", "Loja agora", "Ações"], lojas.map((e) => {
        const s = estado.stores.find((x) => x.id === e.id) || {};
        const gratis = s.freeDeliveryFrom > 0 && (!s.freeDeliveryUntil || s.freeDeliveryUntil >= hoje);
        const situacao = e.approval === "pendente" ? '<span class="fd-tag amarela">Em análise</span>' : e.approval === "recusada" ? '<span class="fd-tag vermelha">Recusada</span>' : '<span class="fd-tag verde">Aprovada</span>';
        const agora = !s.id ? "-" : s.manuallyPaused ? '<span class="fd-tag vermelha">Pausada</span>' : s.openNow ? '<span class="fd-tag verde">Aberta</span>' : '<span class="fd-tag">Fechada (horário)</span>';
        const id = esc(e.id);
        return `<tr><td><b>${esc(e.name)}</b>${e.isDemo ? " <small>exemplo</small>" : ""}<br><small>${esc(e.category || "")} • ${e.deliveryBy === "loja" ? "motoboy próprio" : "motoboy MotoJá"}${e.partner ? ` • ${esc(e.partner.responsible)} (${esc(e.partner.email)})` : ""}${s.rating ? ` • ⭐ ${s.rating.average} (${s.rating.count})` : ""}</small></td>
          <td>${esc(CIDADES[e.city] || e.city)}</td><td>${situacao}${gratis ? '<br><span class="fd-tag verde">entrega grátis</span>' : ""}</td><td>${agora}</td>
          <td class="actions">${e.approval === "pendente" ? `<button type="button" data-fd-aprovar="${id}">Aprovar</button><button type="button" class="perigo" data-fd-recusar="${id}">Recusar</button>` : ""}
            ${s.id ? `<button type="button" class="sec" data-fd-pausar="${id}" data-pausa="${s.manuallyPaused ? "0" : "1"}">${s.manuallyPaused ? "Reabrir" : "Pausar"}</button>
            <button type="button" class="sec" data-fd-gratis="${id}" data-liga="${gratis ? "0" : "1"}">${gratis ? "Tirar entrega grátis" : "Entrega grátis hoje"}</button>` : ""}
            ${e.payout ? `<button type="button" class="sec" data-fd-pix="${id}">Pix</button>` : "<small>sem Pix</small>"}</td></tr>`;
      }))}`;
  }

  const produtosDe = (lojaId) => (estado.products || []).filter((p) => p.store === lojaId).map((p) => `<option value="${esc(p.id)}">${esc(p.name)} • ${reais(p.price)}</option>`).join("");

  function renderPromocoes() {
    const lojas = (estado.stores || []).filter((s) => { const e = estado.empresas.find((x) => x.id === s.id); return !e || e.approval === "aprovada"; });
    const ini = new Date(); ini.setHours(19, 0, 0, 0); if (ini < new Date()) ini.setDate(ini.getDate() + 1);
    const fim = new Date(ini.getTime() + 3 * 3600000);
    const lista = estado.campanhas || [];
    return `<form id="fdPromo" class="fd-form"><h3>Nova promoção paga pela MotoJá <small class="muted">a loja recebe o valor cheio; a MotoJá cobre a diferença</small></h3>
        <div class="fd-linha"><label>Nome que o cliente vê<input name="title" required maxlength="60" value="1º lanche por R$ 10"></label>
          <label>Tipo<select name="type"><option value="item">Preço especial num produto</option><option value="frete">Entrega grátis</option></select></label></div>
        <div class="fd-linha"><label>Loja<select name="storeId"><option value="">Todas as lojas da cidade (só entrega grátis)</option>${lojas.map((s, i) => `<option value="${esc(s.id)}" ${i === 0 ? "selected" : ""}>${esc(s.name)}${s.isDemo === false ? "" : " (exemplo)"}</option>`).join("")}</select></label>
          <label data-fd-cidade hidden>Cidade<select name="city">${cidadeOpcoes()}</select></label></div>
        <div class="fd-linha" data-fd-item><label>Produto<select name="productId">${lojas[0] ? produtosDe(lojas[0].id) : ""}</select></label><label>Preço para o cliente (R$)<input name="price" inputmode="decimal" value="10,00"></label></div>
        <div class="fd-linha"><label>Começa<input name="starts" type="datetime-local" required value="${local(ini)}"></label><label>Termina<input name="ends" type="datetime-local" required value="${local(fim)}"></label></div>
        <div class="fd-linha"><label>Quantas vezes no total<input name="maxUses" inputmode="numeric" required value="30"></label><label>Por cliente<input name="perCustomer" inputmode="numeric" required value="1"></label></div>
        <label class="fd-check"><input type="checkbox" name="notify" checked> Avisar agora no celular os clientes da cidade que aceitam promoções</label>
        <p class="muted" data-fd-custo></p><p class="fd-erro" role="alert"></p><button type="submit">Criar promoção</button></form>
      <h3 class="fd-sub">Promoções</h3>
      ${lista.length ? tabela(["Promoção", "Quando", "Usos", "Gasto", ""], lista.map((k) => `<tr><td><b>${esc(k.title)}</b><br><small>${k.type === "frete" ? "entrega grátis" : `${esc(k.productName || "")} por ${reais(k.price)}`} • ${esc(k.storeId ? lojaNome(k.storeId) : CIDADES[k.city] || "")}</small></td>
          <td>${hora(k.starts)} até ${hora(k.ends)}</td><td>${k.uses}/${k.maxUses}</td><td>${reais(k.spent)}</td>
          <td>${k.active && Date.parse(k.ends) > Date.now() ? `<button type="button" class="perigo" data-fd-encerrar="${esc(k.id)}">Encerrar</button>` : "<small>encerrada</small>"}</td></tr>`)) : vazio("Nenhuma promoção criada ainda.")}`;
  }

  function custoPromo() {
    const f = $("fdPromo");
    if (!f) return;
    const item = f.type.value === "item";
    f.querySelector("[data-fd-item]").hidden = !item;
    f.querySelector("[data-fd-cidade]").hidden = !!f.storeId.value;
    const p = (estado.products || []).find((x) => x.id === f.productId.value);
    let preco = 0;
    try { preco = centavos(f.price.value); } catch (_) {}
    const custo = p ? Math.max(0, p.price - preco) : 0;
    f.querySelector("[data-fd-custo]").textContent = item && p ? `Cada uso custa para a MotoJá ${reais(custo)}. Gasto máximo: ${reais(custo * (Number(f.maxUses.value) || 0))}.` : "Cada uso custa para a MotoJá o valor do frete daquele pedido.";
  }

  function renderAvisos() {
    const enviados = estado.promosEnviadas || [];
    return `<form id="fdAviso" class="fd-form"><h3>Mandar aviso no celular dos clientes</h3>
        <p class="muted">Chega para quem instalou o app ou salvou na tela inicial e aceitou receber promoções, só da cidade escolhida.</p>
        <div class="fd-linha"><label>Cidade<select name="city">${cidadeOpcoes()}</select></label><label>Título<input name="title" required maxlength="60" placeholder="🍔 Fome? Hoje tem entrega grátis"></label></div>
        <label>Mensagem<input name="body" required maxlength="160" placeholder="Peça até as 23h no MotoJÁ Food. Toque para ver as lojas."></label>
        <p class="fd-erro" role="alert"></p><button type="submit">Enviar aviso</button></form>
      <h3 class="fd-sub">Avisos enviados</h3>
      ${enviados.length ? tabela(["Quando", "Cidade", "Aviso", "Quem mandou", "Chegou em"], enviados.map((p) => `<tr><td>${hora(p.created_at)}</td><td>${esc(CIDADES[p.city] || p.city)}</td><td><b>${esc(p.title)}</b><br><small>${esc(p.body)}</small></td><td>${p.store_id ? esc(lojaNome(p.store_id)) : "MotoJá"}</td><td>${p.sent} celulares</td></tr>`)) : vazio("Nenhum aviso enviado ainda.")}`;
  }

  function escopo(m) {
    if (m.role === "loja") return `Loja: ${esc(lojaNome(m.store_id))}`;
    if (!m.store_id) return "Motoboy de todas as cidades";
    if (m.store_id.startsWith("cidade:")) return `Motoboy MotoJá em ${esc(CIDADES[m.store_id.slice(7)] || m.store_id.slice(7))}`;
    return `Motoboy da loja ${esc(lojaNome(m.store_id))}`;
  }

  function renderEquipe() {
    const membros = (estado.members || []).filter((m) => m.active);
    const lojas = estado.stores || [];
    return `<form id="fdEquipe" class="fd-form"><h3>Dar acesso</h3>
        <p class="muted">Dono ou funcionário de loja entra no Food com o e-mail dele e vê o painel da loja. Motoboy do app MotoJá entra sozinho pelo CPF; aqui é para quem usa o Food direto.</p>
        <div class="fd-linha"><label>E-mail<input name="email" type="email" required placeholder="nome@gmail.com"></label>
          <label>Função<select name="role"><option value="loja">Dono ou funcionário da loja</option><option value="motoboy">Motoboy</option></select></label>
          <label data-fd-loja>Loja<select name="store">${lojas.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("")}</select></label>
          <label data-fd-escopo hidden>Onde entrega<select name="scope">${Object.entries(CIDADES).map(([id, n]) => `<option value="cidade:${id}">Motoboy MotoJá em ${n}</option>`).join("")}${lojas.map((s) => `<option value="${esc(s.id)}">Motoboy da loja ${esc(s.name)}</option>`).join("")}</select></label></div>
        <p class="fd-erro" role="alert"></p><button type="submit">Dar acesso</button></form>
      <h3 class="fd-sub">Quem tem acesso</h3>
      ${membros.length ? tabela(["E-mail", "Acesso", ""], membros.map((m) => `<tr><td>${esc(m.email)}${m.email.endsWith("@motoboy.motoja.app") ? " <small>(app do motoboy)</small>" : ""}</td><td>${escopo(m)}</td><td><button type="button" class="perigo" data-fd-remover="${esc(m.id)}">Tirar acesso</button></td></tr>`)) : vazio("Ninguém além de você ainda.")}`;
  }

  function renderAtendimento() {
    const lista = (estado.incidents || []).slice().sort((a, b) => (a.status === "resolvido") - (b.status === "resolvido") || String(b.created_at).localeCompare(String(a.created_at)));
    if (!lista.length) return vazio("Nenhum problema relatado pelos clientes.");
    return `<p class="muted">Problemas que os clientes relataram. A loja tem 2 horas para responder; depois o cliente pode pedir ajuda da MotoJá.</p>
      ${lista.map((i) => {
        const o = (estado.orders || []).find((x) => x.id === i.order_id) || {};
        let d = {};
        try { d = JSON.parse(i.data || "{}"); } catch (_) {}
        const cor = i.status === "resolvido" ? "verde" : d.escalatedAt ? "vermelha" : "amarela";
        return `<form class="fd-form" data-fd-chamado="${esc(i.id)}" data-pedido="${esc(i.order_id)}" data-revisao="${Number(i.revision) || 0}">
          <div><span class="fd-tag ${cor}">${i.status === "resolvido" ? "Resolvido" : d.escalatedAt ? "Pediu a MotoJá" : "Aberto"}</span> <b>${esc(PROBLEMA[i.kind] || i.kind)}</b> • pedido #${esc(o.code || "")} • ${esc(o.storeName || lojaNome(o.store))} • ${hora(i.created_at)}</div>
          <p>${esc(i.message)}</p>${(d.items || []).length ? `<small class="muted">Itens: ${d.items.map((x) => `${x.quantity}× ${esc(x.name)}`).join(", ")}</small>` : ""}
          ${(d.photos || []).length ? `<small class="muted">${d.photos.length} foto(s): abra o pedido no Food para ver.</small>` : ""}
          ${i.response ? `<p class="muted"><b>Resposta:</b> ${esc(i.response)}</p>` : ""}
          ${i.status !== "resolvido" ? `<div class="fd-linha"><label>Responder ao cliente<input name="response" required maxlength="1000" placeholder="Ex.: Vamos reenviar o item ainda hoje."></label><label>Situação<select name="status"><option value="em_atendimento">Em atendimento</option><option value="resolvido">Resolvido</option></select></label></div><p class="fd-erro" role="alert"></p><button type="submit">Enviar resposta</button>` : ""}
        </form>`;
      }).join("")}`;
  }

  // Saldo de cada loja e motoboy com a MotoJá: quem recebeu do cliente fica com dinheiro dos outros.
  function saldoTexto(p) {
    if (Math.abs(p.balance) < 1) return '<span class="fd-tag verde">em dia</span>';
    return p.balance < 0 ? `<span class="fd-tag vermelha">deve ${reais(-p.balance)} à MotoJá</span>` : `<span class="fd-tag amarela">MotoJá deve ${reais(p.balance)}</span>`;
  }

  function renderAcerto() {
    const a = estado.acerto || { parties: [], pending: [] };
    const pix = a.pix || {};
    const receber = a.parties.filter((p) => p.balance < 0).reduce((s, p) => s - p.balance, 0);
    const pagar = a.parties.filter((p) => p.balance > 0).reduce((s, p) => s + p.balance, 0);
    return `<p class="muted">O cliente paga na entrega. Quando o motoboy MotoJá recebe em dinheiro, ele fica com a parte da loja e da MotoJá; quando a loja recebe na maquininha, ela fica com a parte do motoboy e da MotoJá. Aqui você vê quanto cada um deve passar para a MotoJá e quanto a MotoJá deve pagar a cada um.</p>
      <div class="fd-nums">${card(reais(receber), "a receber de lojas e motoboys")}${card(reais(pagar), "a pagar para lojas e motoboys")}${card(a.pending.length, "pagamentos para conferir")}</div>
      ${a.pending.length ? `<h3 class="fd-sub">Pagamentos informados: confira no banco</h3>${tabela(["Quem", "Valor", "Quando", "Observação", ""], a.pending.map((x) => `<tr><td><b>${esc(x.name)}</b><br><small>${x.type === "loja" ? "loja" : "motoboy"}</small></td><td>${reais(Math.abs(x.amount))}</td><td>${hora(x.createdAt)}</td><td>${esc(x.note || "-")}</td><td class="actions"><button type="button" data-fd-conferir="${esc(x.id)}" data-acao="confirmar">Caiu no banco</button><button type="button" class="perigo" data-fd-conferir="${esc(x.id)}" data-acao="recusar">Não caiu</button></td></tr>`))}` : ""}
      <h3 class="fd-sub">Saldo de cada um</h3>
      ${a.parties.length ? tabela(["Quem", "Últimos 30 dias", "Saldo", ""], a.parties.map((p) => `<tr><td><b>${esc(p.name)}</b><br><small>${p.type === "loja" ? "loja" : "motoboy"}</small></td><td>${p.orders30} pedidos<br><small>recebeu ${reais(p.collected30)} do cliente</small></td><td>${saldoTexto(p)}</td>
          <td class="actions">${Math.abs(p.balance) >= 1 ? `<button type="button" data-fd-pagar="${esc(p.type)}|${esc(p.id)}|${p.balance}">${p.balance < 0 ? "Recebi" : "Paguei"}</button>` : ""}${p.type === "loja" ? `<button type="button" class="sec" data-fd-pix="${esc(p.id)}">Pix</button>` : ""}<button type="button" class="sec" data-fd-extrato="${esc(p.type)}|${esc(p.id)}">Pedidos</button></td></tr>`)) : vazio("Nenhum pedido entregue ainda. O acerto aparece quando as entregas começarem.")}
      <div id="fdExtrato"></div>
      <form id="fdPix" class="fd-form"><h3>Pix da MotoJá para o acerto</h3><p class="muted">Lojas e motoboys veem esta chave quando precisam passar dinheiro para a MotoJá.</p>
        <div class="fd-linha"><label>Tipo<select name="keyType">${Object.entries(PIX).map(([k, n]) => `<option value="${k}" ${pix.keyType === k ? "selected" : ""}>${n}</option>`).join("")}</select></label><label>Chave<input name="key" required maxlength="140" value="${esc(pix.key || "")}"></label><label>Nome de quem recebe<input name="holder" required maxlength="80" value="${esc(pix.holder || "")}"></label></div>
        <p class="fd-erro" role="alert"></p><button type="submit">Salvar Pix</button></form>`;
  }

  async function extrato(tipo, id) {
    const box = $("fdExtrato");
    box.innerHTML = '<div class="empty">Carregando…</div>';
    const p = (estado.acerto?.parties || []).find((x) => x.type === tipo && x.id === id) || { name: "" };
    try {
      const d = await food("GET", `settlements/${tipo}/${encodeURIComponent(id)}`);
      box.innerHTML = `<h3 class="fd-sub">Pedidos de ${esc(p.name)}</h3>${d.orders.length ? tabela(["Pedido", "Quem recebeu", "Total", tipo === "loja" ? "Parte da loja" : "Ganho do motoboy", "Acerto"], d.orders.map((o) => `<tr><td>#${esc(o.code)}<br><small>${hora(o.at)}${tipo === "motoboy" ? " • " + esc(o.storeName || "") : o.driver ? " • " + esc(o.driver) : ""}</small></td><td>${QUEM[o.collector] || ""}<br><small>${PAGAMENTO[o.payment] || ""}</small></td><td>${reais(o.total)}</td><td>${reais(o.share)}</td><td>${o.balance > 0 ? "MotoJá paga " + reais(o.balance) : o.balance < 0 ? "passa " + reais(-o.balance) : "-"}</td></tr>`)) : vazio("Sem pedidos.")}
        ${d.payouts.length ? `<h3 class="fd-sub">Pagamentos</h3>${tabela(["Quando", "Quem pagou", "Valor", "Situação"], d.payouts.map((x) => `<tr><td>${hora(x.createdAt)}</td><td>${x.amount > 0 ? "MotoJá" : esc(p.name)}</td><td>${reais(Math.abs(x.amount))}</td><td>${x.status === "informado" ? "esperando conferir" : x.status === "recusado" ? "não caiu" : "confirmado"}${x.note ? `<br><small>${esc(x.note)}</small>` : ""}</td></tr>`))}` : ""}`;
      box.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      box.innerHTML = `<div class="fd-erro">${esc(error.message)}</div>`;
    }
  }

  function render() {
    const box = $("foodResumo");
    if (!box || !estado) return;
    renderAbas();
    if (aba === "resumo") return;
    const telas = { pedidos: renderPedidos, empresas: renderEmpresas, promocoes: renderPromocoes, avisos: renderAvisos, acerto: renderAcerto, equipe: renderEquipe, atendimento: renderAtendimento };
    box.innerHTML = telas[aba]();
    custoPromo();
  }

  async function acao(botao, fazer, ok) {
    botao.disabled = true;
    try {
      await fazer();
      aviso(ok);
      estado = await carregarEstado();
      render();
    } catch (error) {
      aviso(error.message, true);
      botao.disabled = false;
    }
  }

  function clique(e) {
    const b = e.target.closest("button");
    if (!b || !$("food-section").contains(b)) return;
    if (b.dataset.fdAba) {
      aba = b.dataset.fdAba;
      aviso("");
      if (aba === "resumo" || !estado) carregar();
      else render();
      return;
    }
    const loja = (id) => estado.stores.find((x) => x.id === id);
    if (b.dataset.fdAprovar) acao(b, () => food("POST", `stores/${b.dataset.fdAprovar}/approval`, { approved: true }), "Empresa aprovada. A loja já aparece para os clientes.");
    if (b.dataset.fdRecusar) {
      const motivo = prompt("Motivo da recusa (aparece para a empresa):");
      if (motivo !== null) acao(b, () => food("POST", `stores/${b.dataset.fdRecusar}/approval`, { approved: false, note: motivo }), "Cadastro recusado.");
    }
    if (b.dataset.fdPausar) acao(b, () => food("POST", `stores/${b.dataset.fdPausar}`, { action: "pause", paused: b.dataset.pausa === "1" }), b.dataset.pausa === "1" ? "Loja pausada: ela não recebe pedidos até reabrir." : "Loja reaberta.");
    if (b.dataset.fdGratis) {
      const s = loja(b.dataset.fdGratis), liga = b.dataset.liga === "1";
      if (!liga || confirm(`Entrega grátis hoje na ${s.name}? A loja paga o frete dos pedidos de hoje.`)) acao(b, () => food("POST", `stores/${s.id}`, { ...s, freeDeliveryFrom: liga ? 1 : 0, freeDeliveryUntil: liga ? hojeSP() : undefined }), liga ? "Entrega grátis ligada até o fim do dia." : "Entrega grátis desligada.");
    }
    if (b.dataset.fdPix) {
      food("GET", `stores/${b.dataset.fdPix}/payout`).then((r) => {
        const p = r.payout || {};
        alert(p.pixKey ? `Pix de ${lojaNome(b.dataset.fdPix)}\n\nChave (${p.pixKeyType || "-"}): ${p.pixKey}\nTitular: ${p.holder || "-"}\nBanco: ${p.bank || "-"}` : "Esta loja ainda não cadastrou o Pix.");
      }).catch((error) => aviso(error.message, true));
    }
    if (b.dataset.fdEncerrar && confirm("Encerrar esta promoção agora?")) acao(b, () => food("POST", `campaigns/${b.dataset.fdEncerrar}/stop`, {}), "Promoção encerrada.");
    if (b.dataset.fdDemo) acao(b, () => food("POST", "launch", { hideDemo: b.dataset.fdDemo === "1" }), b.dataset.fdDemo === "1" ? "Lojas de exemplo escondidas. Os clientes veem só as lojas reais." : "Lojas de exemplo visíveis de novo.");
    if (b.dataset.fdExtrato) { const [tipo, id] = b.dataset.fdExtrato.split("|"); extrato(tipo, id); }
    if (b.dataset.fdConferir) acao(b, () => food("POST", `settlements/payments/${b.dataset.fdConferir}`, { action: b.dataset.acao }), b.dataset.acao === "confirmar" ? "Pagamento confirmado: já entrou no acerto." : "Pagamento marcado como não recebido.");
    if (b.dataset.fdPagar) {
      const [tipo, id, saldo] = b.dataset.fdPagar.split("|"), deve = Number(saldo) < 0;
      const p = (estado.acerto?.parties || []).find((x) => x.type === tipo && x.id === id) || { name: "" };
      const valor = prompt(deve ? `Quanto você recebeu de ${p.name}? (R$)` : `Quanto a MotoJá pagou para ${p.name}? (R$)`, (Math.abs(Number(saldo)) / 100).toFixed(2).replace(".", ","));
      if (valor !== null) {
        let centavosPagos = 0;
        try { centavosPagos = centavos(valor); } catch (error) { aviso(error.message, true); return; }
        acao(b, () => food("POST", "settlements/payments", { type: tipo, id, amount: centavosPagos, direction: deve ? "para_motoja" : "da_motoja", note: "registrado no painel do dono" }), "Pagamento registrado no acerto.");
      }
    }
    if (b.dataset.fdRemover && confirm("Tirar o acesso desta pessoa ao Food?")) acao(b, () => food("POST", `members/${b.dataset.fdRemover}`, {}), "Acesso retirado.");
  }

  function mudou(e) {
    if (e.target.id === "foodDias") { carregar(); return; }
    if (e.target.id === "fdPedidosFiltro") { render(); return; }
    const f = e.target.form;
    if (f?.id === "fdPromo") {
      if (e.target.name === "storeId" && f.storeId.value) f.productId.innerHTML = produtosDe(f.storeId.value);
      custoPromo();
    }
    if (f?.id === "fdEquipe") {
      const ehLoja = f.role.value === "loja";
      f.querySelector("[data-fd-loja]").hidden = !ehLoja;
      f.querySelector("[data-fd-escopo]").hidden = ehLoja;
    }
  }

  async function enviar(e) {
    const f = e.target;
    if (!["fdPromo", "fdAviso", "fdEquipe", "fdPix"].includes(f.id) && !f.dataset.fdChamado) return;
    e.preventDefault();
    const b = f.querySelector("[type=submit]");
    const erro = f.querySelector(".fd-erro");
    if (b.disabled) return;
    b.disabled = true;
    if (erro) erro.textContent = "";
    const d = new FormData(f);
    try {
      if (f.id === "fdPromo") {
        const tipo = d.get("type"), s = estado.stores.find((x) => x.id === d.get("storeId"));
        if (tipo === "item" && !s) throw new Error("Escolha a loja do produto.");
        const r = await food("POST", "campaigns", {
          type: tipo, title: d.get("title"), storeId: d.get("storeId") || undefined, city: d.get("city"),
          productId: tipo === "item" ? d.get("productId") : undefined, price: tipo === "item" ? centavos(d.get("price")) : undefined,
          starts: new Date(d.get("starts")).toISOString(), ends: new Date(d.get("ends")).toISOString(),
          maxUses: Number(d.get("maxUses")), perCustomer: Number(d.get("perCustomer")),
        });
        if (d.has("notify")) {
          const k = r.campaign;
          await food("POST", "push/promo", { title: "🔥 " + k.title, body: `${k.type === "frete" ? "Entrega grátis" : `${k.productName} por ${reais(k.price)}`}${s ? " na " + s.name : ""} • ${hora(k.starts)}. Toque para pedir!`, storeId: k.storeId || undefined, city: k.city }).catch(() => {});
        }
        aviso("Promoção criada! Ela aparece para os clientes no horário marcado.");
      }
      if (f.id === "fdAviso") {
        const r = await food("POST", "push/promo", { city: d.get("city"), title: d.get("title"), body: d.get("body") });
        aviso(r.configured === false ? "Aviso registrado, mas o envio para celulares ainda não está ligado no Food (falta FIREBASE_SERVICE_ACCOUNT_JSON)." : `Aviso enviado para ${r.sent} celulares.`);
      }
      if (f.id === "fdPix") {
        await food("POST", "settlements/pix", { keyType: d.get("keyType"), key: d.get("key"), holder: d.get("holder") });
        aviso("Pix da MotoJá salvo. Lojas e motoboys já veem esta chave no acerto.");
      }
      if (f.id === "fdEquipe") {
        await food("POST", "members", { email: d.get("email"), role: d.get("role"), store: d.get("store"), scope: d.get("scope") });
        aviso("Acesso liberado. A pessoa entra no Food com esse e-mail.");
      }
      if (f.dataset.fdChamado) {
        await food("POST", `orders/${f.dataset.pedido}/incident-response`, { id: f.dataset.fdChamado, response: d.get("response"), status: d.get("status"), revision: Number(f.dataset.revisao) });
        aviso("Resposta enviada ao cliente.");
      }
      estado = await carregarEstado();
      render();
    } catch (error) {
      if (erro) erro.textContent = error.message;
      else aviso(error.message, true);
      b.disabled = false;
    }
  }

  // Carrega quando o dono entra e a cada 2 minutos; não atualiza enquanto ele digita num formulário.
  let tentativas = 0;
  const espera = setInterval(() => {
    tentativas += 1;
    if (window.senhaDono) {
      clearInterval(espera);
      carregar();
      setInterval(() => { if (!document.hidden && !document.activeElement?.closest?.("#food-section form")) carregar(); }, 120000);
    } else if (tentativas > 3600) clearInterval(espera);
  }, 1000);
  window.MotojaFood = { carregar };
})();
