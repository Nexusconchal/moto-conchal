// Entregas do MotoJÁ Food (app de cardápio) dentro do app do motoboy: lista na tela Serviços,
// aceitar, "peguei o pedido" e finalizar com o código do cliente. Quem fala com o Food é o backend.
// Uso: MotoFood.start({ backend, getProof })
(function () {
  "use strict";
  let options = null;
  let timer = null;
  let carregando = false;
  let entregas = [];
  let aviso = "";
  let acerto = null;
  let acertoEm = 0;
  const ocupado = new Set();
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const moeda = (centavos) => (Number(centavos || 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const CIDADES = { conchal: "Conchal", aguai: "Aguaí", "engenheiro-coelho": "Engenheiro Coelho" };
  const PAGAMENTO = { dinheiro: "em dinheiro", cartao: "no cartão (maquininha da loja)", vale: "no vale-refeição (maquininha da loja)" };

  function injectStyle() {
    if ($("motofood-style")) return;
    const style = document.createElement("style");
    style.id = "motofood-style";
    style.textContent = `
      #foodEntregas{display:grid;gap:10px;margin:4px 0 12px}
      #foodEntregas[hidden],#foodPilula[hidden]{display:none}
      body:not([data-tela="servicos"]) #foodEntregas{display:none}
      .mf-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .mf-head h3{margin:0;font-size:1.02rem}
      .mf-head small{color:#9aa3b2;font-size:.78rem}
      .mf-card{display:grid;gap:8px;padding:14px;border-radius:16px;background:var(--driver-surface,#111319);border:1px solid rgba(255,138,0,.35)}
      .mf-card.mine{border-color:#35c979;background:linear-gradient(180deg,rgba(53,201,121,.08),transparent 60%),var(--driver-surface,#111319)}
      .mf-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
      .mf-top b{font-size:1rem}
      .mf-top small{display:block;color:#9aa3b2;font-size:.76rem;margin-top:2px}
      .mf-ganho{text-align:right;white-space:nowrap}
      .mf-ganho strong{display:block;color:#7ee2a8;font-size:1.15rem}
      .mf-ganho small{color:#9aa3b2;font-size:.7rem}
      .mf-linha{font-size:.86rem;color:#d6dae2;line-height:1.35}
      .mf-linha span{color:#9aa3b2}
      .mf-cobrar{padding:8px 10px;border-radius:10px;background:rgba(255,180,0,.12);color:#ffd166;font-size:.85rem;font-weight:700}
      .mf-cobrar.pago{background:rgba(53,201,121,.12);color:#7ee2a8}
      .mf-acoes{display:flex;flex-wrap:wrap;gap:8px}
      .mf-acoes a,.mf-acoes button{flex:1 1 auto;display:flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.12);background:#1a2030;color:#fff;font-weight:800;font-size:.9rem;text-align:center;text-decoration:none;cursor:pointer}
      .mf-acoes .mf-principal{background:#ff8a00;border-color:#ff8a00;color:#111}
      .mf-acoes button:disabled{opacity:.6}
      .mf-codigo{display:flex;gap:8px}
      .mf-codigo input{flex:1;min-width:0;min-height:44px;padding:8px 12px;border-radius:12px;border:1px solid #394150;background:#0c0f16;color:#fff;font-size:1.3rem;letter-spacing:6px;text-align:center}
      .mf-aviso{padding:10px 12px;border-radius:12px;background:rgba(255,114,0,.14);color:#ffb27a;font-size:.85rem}
      .mf-vazio{color:#9aa3b2;font-size:.86rem;padding:4px 2px}
      .mf-acerto{display:grid;gap:8px;padding:12px 14px;border-radius:14px;background:rgba(255,180,0,.1);border:1px solid rgba(255,180,0,.35);font-size:.88rem}
      .mf-acerto.recebe{background:rgba(53,201,121,.1);border-color:rgba(53,201,121,.35)}
      .mf-acerto b.v{font-size:1.1rem}
      .mf-acerto small{color:#c8cdd6}
      .mf-pix{padding:8px 10px;border-radius:10px;background:#0c0f16;border:1px dashed #394150;overflow-wrap:anywhere}
      #foodPilula{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(84px + env(safe-area-inset-bottom));z-index:40;padding:11px 18px;border-radius:999px;border:0;background:#ff8a00;color:#111;font-weight:900;box-shadow:0 8px 24px rgba(0,0,0,.45);cursor:pointer}
      body:not([data-tela="inicio"]) #foodPilula{display:none}`;
    document.head.appendChild(style);
  }

  function montar() {
    injectStyle();
    if ($("foodEntregas")) return;
    const servicos = $("telaServicos");
    if (!servicos) return;
    servicos.insertAdjacentHTML("afterend", '<section id="foodEntregas" aria-label="Entregas MotoJÁ Food" hidden></section>');
    document.body.insertAdjacentHTML("beforeend", '<button id="foodPilula" type="button" hidden></button>');
    $("foodPilula").addEventListener("click", () => abrir());
    $("foodEntregas").addEventListener("click", (event) => {
      const botao = event.target.closest("[data-mf-acao]");
      if (botao?.dataset.mfAcao === "paguei") pagueiAcerto();
      else if (botao) agir(botao.dataset.mfId, botao.dataset.mfAcao, botao);
    });
    $("nav-servicos")?.addEventListener("click", () => carregar());
  }

  function abrir() {
    $("nav-servicos")?.click();
    setTimeout(() => $("foodEntregas")?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
  }

  function rota(geo, endereco, cidade) {
    const destino = geo && Number.isFinite(geo.lat) ? `${geo.lat},${geo.lon}` : `${endereco}, ${CIDADES[cidade] || ""} - SP`;
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destino)}`;
  }

  function cobrar(e) {
    if (!e.toCollect) return '<div class="mf-cobrar pago">✓ Já pago pelo app. Não cobre nada.</div>';
    const troco = e.payment === "dinheiro" && e.change ? ` • cliente paga com ${moeda(e.change)}, leve ${moeda(e.change - e.toCollect)} de troco` : "";
    return `<div class="mf-cobrar">Receber ${moeda(e.toCollect)} ${PAGAMENTO[e.payment] || ""}${troco}</div>`;
  }

  function cartao(e) {
    const km = e.distanceKm != null ? ` • ${String(e.distanceKm).replace(".", ",")} km` : "";
    const topo = `<div class="mf-top"><div><b>🍔 ${esc(e.storeName)}</b><small>Pedido #${esc(e.code)} • ${e.items} ${e.items === 1 ? "item" : "itens"}${km}</small></div><div class="mf-ganho"><strong>${moeda(e.earning)}</strong><small>${e.tip ? `inclui gorjeta ${moeda(e.tip)}` : "você ganha"}</small></div></div>`;
    const retirada = `<div class="mf-linha"><span>Retirada:</span> ${esc(e.pickupAddress || "endereço da loja")}</div>`;
    const id = esc(e.id);
    const espera = ocupado.has(e.id) ? "disabled" : "";
    if (!e.mine) {
      return `<article class="mf-card">${topo}${retirada}<div class="mf-linha"><span>Entrega:</span> bairro ${esc(e.district || "-")}, ${esc(CIDADES[e.city] || "")}</div>${cobrar(e)}
        <div class="mf-acoes"><button type="button" class="mf-principal" data-mf-acao="accept" data-mf-id="${id}" ${espera}>Aceitar entrega</button></div></article>`;
    }
    const c = e.customer || {};
    const endereco = [c.street, c.number].filter(Boolean).join(", ");
    const cliente = `<div class="mf-linha"><span>Cliente:</span> ${esc(c.name)}<br><span>Entregar em:</span> ${esc(endereco)} — ${esc(e.district)}${c.reference ? `<br><span>Referência:</span> ${esc(c.reference)}` : ""}</div>`;
    if (e.status === "pronto") {
      return `<article class="mf-card mine">${topo}<div class="mf-linha"><b>1. Vá até a loja buscar o pedido</b></div>${retirada}${cliente}${cobrar(e)}
        <div class="mf-acoes"><a href="${rota(e.storeGeo, e.pickupAddress, e.city)}" target="_blank" rel="noopener">🗺️ Rota até a loja</a>${e.shopPhone ? `<a href="tel:${esc(e.shopPhone)}">📞 Loja</a>` : ""}</div>
        <div class="mf-acoes"><button type="button" class="mf-principal" data-mf-acao="pickup" data-mf-id="${id}" ${espera}>Peguei o pedido</button></div></article>`;
    }
    return `<article class="mf-card mine">${topo}<div class="mf-linha"><b>2. Leve até o cliente</b></div>${cliente}${cobrar(e)}
      <div class="mf-acoes"><a href="${rota(e.dropGeo, endereco, e.city)}" target="_blank" rel="noopener">🗺️ Rota até o cliente</a>${c.phone ? `<a href="tel:${esc(c.phone)}">📞 Cliente</a>` : ""}</div>
      ${e.hasCode ? `<div class="mf-linha">Peça ao cliente o <b>código de 4 dígitos</b> que aparece no pedido dele.</div><div class="mf-codigo"><input id="mf-codigo-${id}" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="0000" aria-label="Código do cliente"></div>` : ""}
      <div class="mf-acoes"><button type="button" class="mf-principal" data-mf-acao="deliver" data-mf-id="${id}" ${espera}>${e.toCollect ? "Recebi e entreguei" : "Entreguei"}</button></div></article>`;
  }

  // Acerto: em dinheiro, a parte da loja e da MotoJá fica com o motoboy até ele passar por Pix.
  function cartaoAcerto() {
    if (!acerto || Math.abs(acerto.balance || 0) < 1) return "";
    const pendente = (acerto.pending || []).reduce((s, p) => s - p.amount, 0);
    if (acerto.balance > 0) return `<div class="mf-acerto recebe"><span>💰 A MotoJá vai te pagar <b class="v">${moeda(acerto.balance)}</b> das entregas do Food (quando a loja recebeu no cartão).</span></div>`;
    const pix = acerto.pix;
    return `<div class="mf-acerto"><span>💰 Acerto do Food: passe <b class="v">${moeda(-acerto.balance)}</b> para a MotoJá. É a parte da loja e do app nas entregas que você recebeu em dinheiro.</span>
      ${pix ? `<div class="mf-pix">Pix da MotoJá: <b>${esc(pix.key)}</b><br><small>${esc(pix.holder)}</small></div>` : "<small>A MotoJá ainda vai informar a chave Pix.</small>"}
      ${pendente ? `<small>Esperando a MotoJá conferir: ${moeda(pendente)}.</small>` : ""}
      <div class="mf-acoes"><button type="button" data-mf-acao="paguei" data-mf-id="acerto">Já paguei</button></div></div>`;
  }

  async function carregarAcerto(forcar = false) {
    if (!forcar && Date.now() - acertoEm < 120000) return;
    acertoEm = Date.now();
    try {
      const d = await post("/api/food/acerto");
      acerto = d.configurado ? d : null;
    } catch (_) {}
  }

  async function pagueiAcerto() {
    const sugerido = acerto && acerto.balance < 0 ? (-acerto.balance / 100).toFixed(2).replace(".", ",") : "";
    const valor = prompt("Quanto você mandou por Pix para a MotoJá? (R$)", sugerido);
    if (valor === null) return;
    const t = String(valor).trim().replace(",", ".");
    if (!/^\d+(\.\d{1,2})?$/.test(t)) { aviso = "Confira o valor, como 25,00."; render(); return; }
    try {
      acerto = { configurado: true, ...(await post("/api/food/acerto", { acao: "paguei", valor: Math.round(Number(t) * 100) })) };
      aviso = "Pagamento informado. Ele entra no acerto quando a MotoJá conferir no banco.";
    } catch (erro) {
      aviso = erro.message;
    }
    render();
  }

  function render() {
    const painel = $("foodEntregas");
    if (!painel) return;
    const minhas = entregas.filter((e) => e.mine);
    const abertas = entregas.filter((e) => !e.mine);
    const acertoHtml = cartaoAcerto();
    painel.hidden = !entregas.length && !aviso && !acertoHtml;
    // O código digitado não pode sumir quando a lista atualiza sozinha.
    const digitados = {};
    painel.querySelectorAll(".mf-codigo input").forEach((input) => { digitados[input.id] = input.value; });
    painel.innerHTML = `<div class="mf-head"><h3>🍔 Entregas MotoJÁ Food</h3><small>${abertas.length ? `${abertas.length} disponível${abertas.length > 1 ? "is" : ""}` : "atualiza sozinho"}</small></div>
      ${aviso ? `<div class="mf-aviso">${esc(aviso)}</div>` : ""}
      ${acertoHtml}
      ${minhas.map(cartao).join("")}${abertas.map(cartao).join("")}
      ${!entregas.length ? '<p class="mf-vazio">Nenhuma entrega do Food agora.</p>' : ""}`;
    Object.entries(digitados).forEach(([id, valor]) => { if ($(id)) $(id).value = valor; });
    const pilula = $("foodPilula");
    if (pilula) {
      pilula.hidden = !entregas.length;
      pilula.textContent = minhas.length ? `🍔 Sua entrega Food (${minhas.length}) — abrir` : `🍔 ${abertas.length} entrega${abertas.length > 1 ? "s" : ""} MotoJÁ Food — ver`;
    }
  }

  async function post(caminho, extra = {}) {
    const resposta = await fetch(`${options.backend}${caminho}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...options.getProof(), ...extra }),
      cache: "no-store",
    });
    const dados = await resposta.json().catch(() => ({}));
    if (!resposta.ok) throw new Error(resposta.status >= 500 ? "O MotoJÁ Food não respondeu agora. Tente de novo em alguns segundos." : dados.message || "Não deu certo agora.");
    return dados;
  }

  async function carregar() {
    if (!options || carregando || document.hidden) return;
    carregando = true;
    try {
      const [dados] = await Promise.all([post("/api/food/deliveries"), carregarAcerto()]);
      entregas = Array.isArray(dados.deliveries) ? dados.deliveries : [];
      aviso = "";
    } catch (erro) {
      // Lista vazia em silêncio quando o Food está fora; o aviso só aparece se havia entrega na tela.
      if (entregas.length) aviso = erro.message;
    } finally {
      carregando = false;
      render();
    }
  }

  async function agir(id, acao, botao) {
    const extra = {};
    if (acao === "deliver") {
      const e = entregas.find((x) => x.id === id);
      const campo = $(`mf-codigo-${id}`);
      if (e?.hasCode) {
        extra.code = String(campo?.value || "").replace(/\D/g, "");
        if (extra.code.length !== 4) { aviso = "Digite o código de 4 dígitos do cliente."; render(); campo?.focus(); return; }
      }
      if (e?.toCollect && !confirm(`Você recebeu ${moeda(e.toCollect)} ${PAGAMENTO[e.payment] || ""}?`)) return;
    }
    ocupado.add(id);
    if (botao) botao.disabled = true;
    try {
      const dados = await post(`/api/food/deliveries/${encodeURIComponent(id)}/${acao}`, extra);
      entregas = Array.isArray(dados.deliveries) ? dados.deliveries : [];
      aviso = "";
      if (acao === "deliver") await carregarAcerto(true);
    } catch (erro) {
      aviso = erro.message;
      if (acao === "accept") carregar();
    } finally {
      ocupado.delete(id);
      render();
    }
  }

  function start(opts) {
    options = opts;
    montar();
    carregar();
    clearInterval(timer);
    timer = setInterval(carregar, 20000);
    if (!start.ouvindo) document.addEventListener("visibilitychange", () => { if (!document.hidden) carregar(); });
    start.ouvindo = true;
    if (new URLSearchParams(location.search).get("aba") === "food") setTimeout(abrir, 600);
  }

  window.MotoFood = { start, refresh: carregar };
})();
