// Entregas do MotoJÁ Food (app de cardápio) dentro do app do motoboy. Igual às outras chamadas:
// a entrega nova abre a tela de oferta tocando "MotoJá, bora rodar"; depois de aceitar, a rota até a
// loja e depois até o cliente aparece no mapa do próprio app (MotoNav). A lista fica em Serviços →
// Entregas (abertas) e Em andamento → Entregas (a sua). Quem fala com o Food é o backend.
// Uso: MotoFood.start({ backend, getProof })
(function () {
  "use strict";
  let options = null;
  let timer = null;
  let carregando = false;
  let entregas = [];
  let aviso = "";
  let acerto = null;
  let gps = null;
  let acertoEm = 0;
  const ocupado = new Set();
  // Oferta recusada não volta; a que passou sem resposta volta depois de alguns minutos se ninguém pegou.
  const naoOferecerAte = new Map();
  const mapaAberto = new Set();
  // A chamada do Food fica aberta 15 min (callUntil vem do Food). Se a loja chamar de novo, o prazo muda
  // e a oferta volta, mesmo para quem tinha recusado.
  const CHAMADA_MS = 15 * 60000;
  const DE_NOVO_MS = 3 * 60000;
  const prazoDe = (e) => (Number(e.callUntil) > 0 ? Number(e.callUntil) : Date.now() + CHAMADA_MS);
  const chaveOferta = (e) => `${e.id}:${Number(e.callUntil) || 0}`;
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const moeda = (centavos) => (Number(centavos || 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const CIDADES = { conchal: "Conchal", aguai: "Aguaí", "engenheiro-coelho": "Engenheiro Coelho" };
  const PAGAMENTO = { dinheiro: "em dinheiro", cartao: "no cartão (maquininha da loja)", vale: "no vale-refeição (maquininha da loja)", app: "" };
  const idTela = (id) => `food-${id}`;
  // Chat do pedido (cliente, loja e motoboy). O telefone do cliente não vem para o app.
  let conversa = null;
  const naoLidoAntes = new Map();
  const CHAVE_LIDO = "motofood-chat-lido";
  function lidoAte(id) {
    try { return Number(JSON.parse(localStorage.getItem(CHAVE_LIDO) || "{}")[id] || 0); } catch (_) { return 0; }
  }
  function marcarLido(id, seq) {
    try {
      const mapa = JSON.parse(localStorage.getItem(CHAVE_LIDO) || "{}");
      mapa[id] = Math.max(Number(mapa[id] || 0), Number(seq || 0));
      const chaves = Object.keys(mapa);
      if (chaves.length > 50) delete mapa[chaves[0]];
      localStorage.setItem(CHAVE_LIDO, JSON.stringify(mapa));
    } catch (_) {}
  }
  const naoLido = (e) => !!e?.chat?.fromOther && Number(e.chat.seq || 0) > lidoAte(e.id);
  const ponto = (geo, titulo, detalhe) => ({ lat: Number(geo?.lat) || 0, lon: Number(geo?.lon) || 0, titulo: titulo || "-", detalhe: detalhe || "" });
  const itensTexto = (e) => `${e.items || 1} ${Number(e.items) === 1 ? "item" : "itens"}`;
  const kmTexto = (km) => (km != null && Number.isFinite(Number(km)) ? `${Number(km).toFixed(1).replace(".", ",")} km` : "-");

  function injectStyle() {
    if ($("motofood-style")) return;
    const style = document.createElement("style");
    style.id = "motofood-style";
    style.textContent = `
      #foodEntregas{display:grid;gap:10px;margin:4px 0 12px}
      #foodEntregas[hidden],#foodPilula[hidden]{display:none}
      body:not([data-tela="servicos"]) #foodEntregas{display:none}
      body[data-servicos-modo="pendentes"] #foodEntregas,body[data-servicos-modo="minhas"] #foodEntregas{display:none}
      body[data-servicos-modo="entregas"] #foodEntregas .mf-card.mine,body[data-servicos-modo="minhas-entregas"] #foodEntregas .mf-card:not(.mine){display:none}
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
      .mf-aviso{padding:10px 12px;border-radius:12px;background:rgba(255,114,0,.14);color:#ffb27a;font-size:.85rem}
      .mf-vazio{color:#9aa3b2;font-size:.86rem;padding:4px 2px}
      .mf-acerto{display:grid;gap:8px;padding:12px 14px;border-radius:14px;background:rgba(255,180,0,.1);border:1px solid rgba(255,180,0,.35);font-size:.88rem}
      .mf-acerto.recebe{background:rgba(53,201,121,.1);border-color:rgba(53,201,121,.35)}
      .mf-acerto b.v{font-size:1.1rem}
      .mf-acerto small{color:#c8cdd6}
      .mf-gps{font-size:.78rem;color:#7ee2a8}
      .mf-gps.off{color:#ffb27a}
      .mf-chegou{padding:8px 10px;border-radius:10px;background:rgba(53,201,121,.12);color:#7ee2a8;font-weight:800;font-size:.85rem}
      .mf-pix{padding:8px 10px;border-radius:10px;background:#0c0f16;border:1px dashed #394150;overflow-wrap:anywhere}
      #mfChat{position:fixed;inset:0;z-index:10050;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.55)}
      .mfc-folha{width:100%;max-width:560px;height:min(82vh,640px);display:flex;flex-direction:column;background:#0f1218;border-radius:22px 22px 0 0;border:1px solid #232a36;padding-bottom:env(safe-area-inset-bottom)}
      .mfc-topo{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:16px 16px 10px;border-bottom:1px solid #1e2430}
      .mfc-topo b{display:block;font-size:1.02rem;color:#fff}
      .mfc-topo small{display:block;color:#9aa3b2;font-size:.76rem;margin-top:3px;line-height:1.3}
      .mfc-x{width:40px;height:40px;border-radius:50%;border:0;background:#1a2030;color:#fff;font-size:1.1rem;cursor:pointer;flex:0 0 auto}
      .mfc-lista{flex:1;overflow:auto;padding:14px 12px;display:flex;flex-direction:column;gap:8px}
      .mfc-vazio{margin:auto;color:#9aa3b2;font-size:.86rem;text-align:center;padding:20px}
      .mfc-msg{max-width:82%;padding:9px 12px;border-radius:14px;background:#1a2030;color:#e8ebf1;font-size:.92rem;line-height:1.35;white-space:pre-wrap;overflow-wrap:anywhere}
      .mfc-msg small{display:block;color:#9aa3b2;font-size:.7rem;margin-bottom:3px;font-weight:700}
      .mfc-msg.eu{align-self:flex-end;background:#ff8a00;color:#111}
      .mfc-msg.eu small{color:#4a2a00}
      .mfc-rapidas{display:flex;gap:6px;overflow-x:auto;padding:8px 12px 0}
      .mfc-rapidas button{flex:0 0 auto;padding:7px 11px;border-radius:999px;border:1px solid #2c3442;background:#151a24;color:#d6dae2;font-size:.8rem;cursor:pointer}
      .mfc-envio{display:flex;gap:8px;padding:10px 12px 12px}
      .mfc-envio textarea{flex:1;min-height:44px;max-height:110px;resize:none;padding:10px 12px;border-radius:14px;border:1px solid #2c3442;background:#0b0e14;color:#fff;font:inherit;font-size:.95rem}
      .mfc-envio button{width:48px;border-radius:14px;border:0;background:#ff8a00;color:#111;font-weight:900;font-size:1.1rem;cursor:pointer}
      .mfc-envio button:disabled{opacity:.5}
      .mfc-erro{color:#ffb27a;font-size:.8rem;padding:0 14px}
      #foodPilula{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(96px + env(safe-area-inset-bottom));z-index:40;padding:11px 18px;border-radius:999px;border:0;background:#35c979;color:#0b1a10;font-weight:900;box-shadow:0 8px 24px rgba(0,0,0,.45);cursor:pointer;white-space:nowrap}`;
    document.head.appendChild(style);
  }

  function montar() {
    injectStyle();
    if ($("foodEntregas")) return;
    const servicos = $("telaServicos");
    if (!servicos) return;
    servicos.insertAdjacentHTML("afterend", '<section id="foodEntregas" aria-label="Entregas MotoJÁ Food" hidden></section>');
    document.body.insertAdjacentHTML("beforeend", '<button id="foodPilula" type="button" hidden></button>');
    $("foodPilula").addEventListener("click", () => {
      const minha = entregas.find((e) => e.mine);
      if (!minha || !abrirMapa(minha)) abrirLista();
    });
    $("foodEntregas").addEventListener("click", (event) => {
      const botao = event.target.closest("[data-mf-acao]");
      if (!botao) return;
      const acao = botao.dataset.mfAcao;
      const e = entregas.find((x) => x.id === botao.dataset.mfId);
      if (acao === "paguei") pagueiAcerto();
      else if (acao === "mapa" && e) abrirMapa(e);
      else if (acao === "oferta" && e) abrirOferta(e, { alarme: false });
      else if (acao === "chat" && e) abrirChat(e);
      else agir(botao.dataset.mfId, acao, botao);
    });
    $("nav-servicos")?.addEventListener("click", () => carregar());
  }

  function abrirLista() {
    $("nav-servicos")?.click();
    setTimeout(() => $("foodEntregas")?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
  }

  function textoCobrar(e) {
    if (!e.toCollect) return "Já pago pelo app. Não cobre nada do cliente.";
    const troco = e.payment === "dinheiro" && e.change ? ` • cliente paga com ${moeda(e.change)}, leve ${moeda(e.change - e.toCollect)} de troco` : "";
    return `Receber ${moeda(e.toCollect)} ${PAGAMENTO[e.payment] || ""}${troco}`.trim();
  }

  function cobrar(e) {
    return e.toCollect ? `<div class="mf-cobrar">${esc(textoCobrar(e))}</div>` : `<div class="mf-cobrar pago">✓ ${esc(textoCobrar(e))}</div>`;
  }

  // ---------- Tela de oferta (igual às corridas e entregas) ----------
  function podeOferecer() {
    if (!window.MotoNav || window.MotoNav.aberto()) return false;
    // Só para quem está Disponível e livre (sem corrida/entrega em andamento).
    if (window.MotojaDriverAvailability?.canAlert?.() !== true) return false;
    return !entregas.some((e) => e.mine);
  }

  function oferecerNova() {
    if (!podeOferecer()) return;
    const agora = Date.now();
    const nova = entregas.find((e) => !e.mine && e.status === "pronto" && prazoDe(e) > agora + 5000 && !((naoOferecerAte.get(chaveOferta(e)) || 0) > agora));
    if (nova) abrirOferta(nova, { alarme: true });
  }

  function abrirOferta(e, { alarme = true } = {}) {
    if (!window.MotoNav) return false;
    const prazo = prazoDe(e);
    naoOferecerAte.set(chaveOferta(e), Date.now() + DE_NOVO_MS);
    window.MotoNav.abrirOferta({
      id: idTela(e.id),
      backend: options.backend,
      tipo: "entrega",
      tag: `🍔 MotoJÁ Food · ${CIDADES[e.city] || "Conchal"}`,
      topo: "Online",
      ganhoTexto: moeda(e.earning),
      ganhoLegenda: e.tip ? `você recebe · inclui gorjeta ${moeda(e.tip)}` : "você recebe",
      kmViagemTexto: kmTexto(e.distanceKm),
      extra: { valor: String(e.items || 1), rotulo: Number(e.items) === 1 ? "item" : "itens" },
      coleta: ponto(e.storeGeo, `Coleta · ${e.storeName}`, e.pickupAddress),
      destino: ponto(null, `Entrega · bairro ${e.district || "-"}`, "O endereço do cliente aparece depois de aceitar."),
      observacao: `${e.toCollect ? "💵" : "✓"} ${textoCobrar(e)}`,
      // Cronômetro de 15 min, igual ao tempo que a loja espera antes de chamar de novo.
      expiraEmMs: prazo,
      duracaoMs: CHAMADA_MS,
      textoAceitar: "Aceitar entrega",
      alarme,
      onRecusar: () => naoOferecerAte.set(chaveOferta(e), prazo + 1000),
      onExpirar: () => naoOferecerAte.set(chaveOferta(e), prazo + 1000),
      onAceitar: async () => {
        const dados = await post(`/api/food/deliveries/${encodeURIComponent(e.id)}/accept`);
        entregas = Array.isArray(dados.deliveries) ? dados.deliveries : entregas;
        aviso = "";
        render();
        const minha = entregas.find((x) => x.id === e.id && x.mine);
        if (!minha || !abrirMapa(minha)) window.MotoNav.fechar();
      },
    });
    return true;
  }

  // ---------- Mapa dentro do app depois de aceitar ----------
  function abrirMapa(e) {
    if (!window.MotoNav || !e?.mine) return false;
    mapaAberto.add(e.id);
    const c = e.customer || {};
    const endereco = [c.street, c.number].filter(Boolean).join(", ");
    const base = { id: idTela(e.id), backend: options.backend, prova: options.getProof(), tipo: "entrega", onFechar: () => render() };
    if (e.status === "pronto") {
      window.MotoNav.abrirNavegacao({
        ...base,
        etapa: "buscar",
        alvo: { ...ponto(e.storeGeo, e.storeName, e.pickupAddress), rotulo: "Retirar pedido" },
        etapaTexto: "INDO RETIRAR",
        cliente: { nome: e.storeName || "Loja", linha: e.pickupAddress || `Pedido #${e.code}`, telefone: e.shopPhone || "", chat: () => abrirChat(e), chatNaoLido: naoLido(e) },
        aviso: { tipo: e.toCollect ? "alerta" : "", texto: `Pedido #${e.code} · ${itensTexto(e)}. ${textoCobrar(e)}` },
        principal: { texto: "Peguei o pedido", textoCarregando: "Confirmando...", acao: () => agirPeloMapa(e.id, "pickup") },
      });
      return true;
    }
    window.MotoNav.abrirNavegacao({
      ...base,
      etapa: "levar",
      alvo: { ...ponto(e.dropGeo, c.name || "Cliente", [endereco, e.district].filter(Boolean).join(" — ")), rotulo: "Entregar pedido" },
      etapaTexto: "INDO ENTREGAR",
      // Sem telefone do cliente: o 💬 abre o chat do pedido (como no iFood).
      cliente: { nome: c.name || "Cliente", linha: [endereco, e.district, c.reference ? `Ref.: ${c.reference}` : ""].filter(Boolean).join(" · "), chat: () => abrirChat(e), chatNaoLido: naoLido(e) },
      aviso: { tipo: e.toCollect ? "alerta" : "", texto: `${e.arrivedAt ? "🛎️ Cliente avisado que você chegou. " : ""}${textoCobrar(e)}` },
      secundarias: e.arrivedAt ? [] : [{ texto: "🛎️ Cheguei", textoCarregando: "Avisando o cliente...", acao: () => agirPeloMapa(e.id, "arrived") }],
      principal: { texto: e.toCollect ? "Recebi e entreguei" : "Entreguei", textoCarregando: "Finalizando...", cor: "verde", acao: () => entregarPeloMapa(e) },
    });
    return true;
  }

  async function agirPeloMapa(id, acao, extra = {}) {
    ocupado.add(id);
    try {
      const dados = await post(`/api/food/deliveries/${encodeURIComponent(id)}/${acao}`, extra);
      entregas = Array.isArray(dados.deliveries) ? dados.deliveries : entregas;
      aviso = "";
    } finally {
      ocupado.delete(id);
      render();
    }
    const atual = entregas.find((x) => x.id === id && x.mine);
    if (acao === "deliver" || !atual) {
      if (conversa?.id === id) fecharChat(false);
      if (window.MotoNav?.idAtual?.() === idTela(id)) window.MotoNav.fechar();
      await carregarAcerto(true);
      render();
      return;
    }
    abrirMapa(atual);
  }

  async function entregarPeloMapa(e) {
    const extra = {};
    if (e.hasCode) {
      const codigo = String(prompt("Digite o código de 4 dígitos que aparece no pedido do cliente:") || "").replace(/\D/g, "");
      if (codigo.length !== 4) throw new Error("Peça ao cliente o código de 4 dígitos do pedido e digite de novo.");
      extra.code = codigo;
    }
    if (e.toCollect && !confirm(`Você recebeu ${moeda(e.toCollect)} ${PAGAMENTO[e.payment] || ""}?`)) throw new Error("Confirme quando receber o pagamento do cliente.");
    await agirPeloMapa(e.id, "deliver", extra);
  }

  // ---------- Chat do pedido (dentro do app, sem número de telefone) ----------
  const RAPIDAS = ["Estou a caminho 🛵", "Cheguei, estou na porta", "Não estou achando o endereço, pode me orientar?", "Peguei o pedido na loja"];

  function abrirChat(e) {
    fecharChat(false);
    conversa = { id: e.id, code: e.code, cliente: e.customer?.name || "Cliente", loja: e.storeName || "Loja", msgs: [], ultimo: 0, me: "", erro: "", enviando: false, timer: null };
    document.body.insertAdjacentHTML("beforeend", `<div id="mfChat" role="dialog" aria-label="Conversa do pedido">
      <section class="mfc-folha">
        <div class="mfc-topo"><div><b>💬 Conversa do pedido #${esc(e.code)}</b><small>Cliente, loja e você no mesmo chat. O seu número e o do cliente não aparecem.</small></div><button type="button" class="mfc-x" data-mfc-fechar aria-label="Fechar conversa">✕</button></div>
        <div class="mfc-lista" data-mfc-lista><p class="mfc-vazio">Carregando a conversa…</p></div>
        <div class="mfc-rapidas">${RAPIDAS.map((t) => `<button type="button" data-mfc-rapida>${esc(t)}</button>`).join("")}</div>
        <p class="mfc-erro" data-mfc-erro hidden></p>
        <form class="mfc-envio" data-mfc-form><textarea data-mfc-texto maxlength="1200" placeholder="Escreva para o cliente…" aria-label="Mensagem"></textarea><button type="submit" data-mfc-enviar aria-label="Enviar">➤</button></form>
      </section></div>`);
    const raiz = $("mfChat");
    raiz.addEventListener("click", (event) => {
      if (event.target === raiz || event.target.closest("[data-mfc-fechar]")) fecharChat();
      const rapida = event.target.closest("[data-mfc-rapida]");
      if (rapida) enviarChat(rapida.textContent);
    });
    raiz.querySelector("[data-mfc-form]").addEventListener("submit", (event) => {
      event.preventDefault();
      const campo = raiz.querySelector("[data-mfc-texto]");
      enviarChat(campo.value);
    });
    atualizarChat();
    conversa.timer = setInterval(atualizarChat, 4000);
  }

  function fecharChat(atualizarTela = true) {
    if (!conversa) return;
    clearInterval(conversa.timer);
    const id = conversa.id;
    conversa = null;
    $("mfChat")?.remove();
    if (!atualizarTela) return;
    render();
    // O aviso de mensagem nova some do mapa também.
    const e = entregas.find((x) => x.id === id && x.mine);
    if (e && window.MotoNav?.idAtual?.() === idTela(id) && window.MotoNav.modo() === "nav") abrirMapa(e);
  }

  function renderChat() {
    const raiz = $("mfChat");
    if (!raiz || !conversa) return;
    const lista = raiz.querySelector("[data-mfc-lista]");
    const noFim = lista.scrollHeight - lista.scrollTop - lista.clientHeight < 60;
    const nome = (m) => (m.userId === conversa.me ? "Você" : m.role === "cliente" ? conversa.cliente : m.role === "loja" ? conversa.loja : m.role === "entregador" ? "Motoboy" : "MotoJÁ");
    const hora = (at) => { const d = new Date(at); return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }); };
    lista.innerHTML = conversa.msgs.length
      ? conversa.msgs.map((m) => `<div class="mfc-msg ${m.userId === conversa.me ? "eu" : ""}"><small>${esc(nome(m))} · ${esc(hora(m.at))}</small>${esc(m.text)}</div>`).join("")
      : '<p class="mfc-vazio">Nenhuma mensagem ainda. Fale com o cliente por aqui: ele recebe no celular.</p>';
    if (noFim || conversa.rolar) { lista.scrollTop = lista.scrollHeight; conversa.rolar = false; }
    const erro = raiz.querySelector("[data-mfc-erro]");
    erro.hidden = !conversa.erro;
    erro.textContent = conversa.erro;
    raiz.querySelector("[data-mfc-enviar]").disabled = conversa.enviando;
  }

  async function atualizarChat() {
    const atual = conversa;
    if (!atual || atual.carregando) return;
    atual.carregando = true;
    try {
      const dados = await post(`/api/food/conversa/${encodeURIComponent(atual.id)}`, { after: atual.ultimo });
      if (conversa !== atual) return;
      atual.me = dados.me || atual.me;
      const novas = (dados.messages || []).filter((m) => !atual.msgs.some((x) => x.seq === m.seq));
      if (novas.length) { atual.msgs = [...atual.msgs, ...novas].sort((a, b) => a.seq - b.seq); atual.rolar = !atual.ultimo; }
      atual.ultimo = Math.max(atual.ultimo, ...atual.msgs.map((m) => m.seq), 0);
      atual.erro = "";
      marcarLido(atual.id, atual.ultimo);
    } catch (erro) {
      if (conversa === atual) atual.erro = erro.message;
    } finally {
      atual.carregando = false;
      if (conversa === atual) renderChat();
    }
  }

  async function enviarChat(texto) {
    const atual = conversa;
    const mensagem = String(texto || "").trim();
    if (!atual || !mensagem || atual.enviando) return;
    atual.enviando = true;
    atual.erro = "";
    renderChat();
    try {
      const chave = `mf${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 8)}`.replace(/[^a-zA-Z0-9_-]/g, "").padEnd(24, "0");
      await post(`/api/food/conversa/${encodeURIComponent(atual.id)}`, { text: mensagem, requestKey: chave });
      const campo = $("mfChat")?.querySelector("[data-mfc-texto]");
      if (campo && campo.value.trim() === mensagem) campo.value = "";
      atual.rolar = true;
    } catch (erro) {
      atual.erro = erro.message;
    } finally {
      atual.enviando = false;
      renderChat();
    }
    await atualizarChat();
  }

  // ---------- Lista em Serviços ----------
  function cartao(e) {
    const km = e.distanceKm != null ? ` • ${kmTexto(e.distanceKm)}` : "";
    const topo = `<div class="mf-top"><div><b>🍔 ${esc(e.storeName)}</b><small>Pedido #${esc(e.code)} • ${itensTexto(e)}${km}</small></div><div class="mf-ganho"><strong>${moeda(e.earning)}</strong><small>${e.tip ? `inclui gorjeta ${moeda(e.tip)}` : "você recebe"}</small></div></div>`;
    const retirada = `<div class="mf-linha"><span>Retirada:</span> ${esc(e.pickupAddress || "endereço da loja")}</div>`;
    const id = esc(e.id);
    const espera = ocupado.has(e.id) ? "disabled" : "";
    if (!e.mine) {
      return `<article class="mf-card">${topo}${retirada}<div class="mf-linha"><span>Entrega:</span> bairro ${esc(e.district || "-")}, ${esc(CIDADES[e.city] || "")}</div>${cobrar(e)}
        <div class="mf-acoes"><button type="button" data-mf-acao="oferta" data-mf-id="${id}">🗺️ Ver no mapa</button><button type="button" class="mf-principal" data-mf-acao="accept" data-mf-id="${id}" ${espera}>Aceitar entrega</button></div></article>`;
    }
    const c = e.customer || {};
    const endereco = [c.street, c.number].filter(Boolean).join(", ");
    const cliente = `<div class="mf-linha"><span>Cliente:</span> ${esc(c.name)}<br><span>Entregar em:</span> ${esc(endereco)} — ${esc(e.district)}${c.reference ? `<br><span>Referência:</span> ${esc(c.reference)}` : ""}</div>`;
    const mapa = `<button type="button" class="mf-principal" data-mf-acao="mapa" data-mf-id="${id}">🗺️ Abrir mapa</button>`;
    const conversar = `<button type="button" data-mf-acao="chat" data-mf-id="${id}">💬 Conversar${naoLido(e) ? " 🔴" : ""}</button>`;
    if (e.status === "pronto") {
      return `<article class="mf-card mine">${topo}<div class="mf-linha"><b>1. Vá até a loja buscar o pedido</b></div>${retirada}${cliente}${cobrar(e)}
        <div class="mf-acoes">${mapa}${conversar}${e.shopPhone ? `<a href="tel:${esc(e.shopPhone)}">📞 Loja</a>` : ""}</div></article>`;
    }
    return `<article class="mf-card mine">${topo}<div class="mf-linha"><b>2. Leve até o cliente</b></div>${cliente}${cobrar(e)}
      <div class="mf-acoes">${mapa}${conversar}</div>
      <small class="mf-gps ${gps?.erro ? "off" : ""}">${gps?.erro ? "📍 " + esc(gps.erro) : gps?.enviadoEm ? "📍 O cliente vê você no mapa (atualizado " + new Date(gps.enviadoEm).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) + ")" : "📍 Ligando a localização para o cliente ver você no mapa…"}</small>
      ${e.arrivedAt ? `<div class="mf-chegou">🛎️ Cliente avisado que você chegou (${new Date(e.arrivedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })})</div>` : ""}</article>`;
  }

  // Acerto: em dinheiro, a parte da loja e da MotoJá fica com o motoboy até ele passar por Pix.
  function cartaoAcerto() {
    if (!acerto || Math.abs(acerto.balance || 0) < 1) return "";
    const pendente = (acerto.pending || []).reduce((s, p) => s - p.amount, 0);
    if (acerto.balance > 0) return `<div class="mf-acerto recebe"><span>💰 A MotoJá vai te pagar <b class="v">${moeda(acerto.balance)}</b> das suas entregas do Food (pedidos pagos pelo app ou na maquininha da loja).</span></div>`;
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

  // Enquanto o motoboy leva um pedido do Food, a posição vai para o mapa do cliente a cada 15 s.
  function gpsSeguir() {
    const ativa = entregas.find((e) => e.mine && e.status === "entrega");
    if (!ativa) {
      if (gps) { navigator.geolocation?.clearWatch(gps.watch); gps = null; }
      return;
    }
    if (gps?.id === ativa.id) return;
    if (gps) navigator.geolocation?.clearWatch(gps.watch);
    if (!navigator.geolocation) { gps = { id: ativa.id, erro: "Este celular não libera a localização." }; return; }
    const atual = { id: ativa.id, ultimo: 0, enviando: false, erro: "", enviadoEm: 0, watch: null };
    gps = atual;
    atual.watch = navigator.geolocation.watchPosition(async (pos) => {
      if (gps !== atual || atual.enviando || Date.now() - atual.ultimo < 15000) return;
      atual.enviando = true;
      try {
        await post(`/api/food/posicao/${encodeURIComponent(atual.id)}`, { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: Math.min(999, pos.coords.accuracy || 50), observedAt: pos.timestamp || Date.now() });
        atual.ultimo = Date.now();
        atual.enviadoEm = Date.now();
        atual.erro = "";
      } catch (_) {
        atual.ultimo = Date.now();
      } finally {
        atual.enviando = false;
        render();
      }
    }, () => {
      if (gps !== atual) return;
      atual.erro = "Localização desligada. Ligue o GPS e permita a localização para o cliente ver você no mapa.";
      render();
    }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
  }

  function render() {
    const painel = $("foodEntregas");
    if (!painel) return;
    gpsSeguir();
    const minhas = entregas.filter((e) => e.mine);
    const abertas = entregas.filter((e) => !e.mine);
    const acertoHtml = cartaoAcerto();
    painel.hidden = !entregas.length && !aviso && !acertoHtml;
    painel.innerHTML = `<div class="mf-head"><h3>🍔 Entregas MotoJÁ Food</h3><small>${abertas.length ? `${abertas.length} disponível${abertas.length > 1 ? "is" : ""}` : "atualiza sozinho"}</small></div>
      ${aviso ? `<div class="mf-aviso">${esc(aviso)}</div>` : ""}
      ${acertoHtml}
      ${minhas.map(cartao).join("")}${abertas.map(cartao).join("")}
      ${!entregas.length ? '<p class="mf-vazio">Nenhuma entrega do Food agora.</p>' : ""}`;
    // A pílula só aparece com uma entrega do Food em andamento e o mapa minimizado.
    const pilula = $("foodPilula");
    if (pilula) {
      const minha = minhas[0];
      const mapaNaTela = minha && window.MotoNav?.aberto?.() && window.MotoNav.idAtual() === idTela(minha.id);
      pilula.hidden = !minha || !!mapaNaTela;
      pilula.textContent = minha ? (naoLido(minha) ? "💬 Mensagem nova na entrega Food — abrir" : "🍔 Entrega Food em andamento — abrir mapa") : "";
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

  // Oferta aberta que não está mais livre (outro motoboy pegou ou a loja cancelou): fecha na hora.
  function fecharOfertaEncerrada() {
    if (window.MotoNav?.modo?.() !== "oferta") return;
    const atual = String(window.MotoNav.idAtual() || "");
    if (!atual.startsWith("food-")) return;
    const id = atual.slice(5);
    if (!entregas.some((e) => e.id === id && !e.mine && e.status === "pronto")) {
      window.MotoNav.fechar();
      aviso = "Essa entrega do Food não está mais disponível: outro motoboy pegou.";
    }
  }

  // Entrega aceita que sumiu da lista (a loja cancelou porque o cliente desistiu): fecha o mapa e avisa.
  function fecharMapaCancelado() {
    if (window.MotoNav?.modo?.() !== "nav") return;
    const atual = String(window.MotoNav.idAtual() || "");
    if (!atual.startsWith("food-")) return;
    const id = atual.slice(5);
    // Com uma ação em andamento (entreguei, peguei), quem cuida da tela é a própria ação.
    if (ocupado.has(id) || entregas.some((e) => e.id === id && e.mine)) return;
    if (conversa?.id === id) fecharChat(false);
    window.MotoNav.fechar();
    aviso = "A loja cancelou essa entrega do Food. Não precisa buscar nem entregar.";
    setTimeout(() => alert("A loja cancelou essa entrega do MotoJÁ Food. Não precisa buscar nem entregar."), 50);
  }

  async function carregar() {
    if (!options || carregando || document.hidden) return;
    carregando = true;
    let ok = false;
    try {
      const [dados] = await Promise.all([post("/api/food/deliveries"), carregarAcerto()]);
      entregas = Array.isArray(dados.deliveries) ? dados.deliveries : [];
      aviso = "";
      ok = true;
    } catch (erro) {
      // Lista vazia em silêncio quando o Food está fora; o aviso só aparece se havia entrega na tela.
      if (entregas.length) aviso = erro.message;
    } finally {
      carregando = false;
    }
    if (ok) {
      fecharOfertaEncerrada();
      fecharMapaCancelado();
      // Entrega aceita (por exemplo, em outro aparelho ou antes de fechar o app): abre o mapa uma vez.
      const minha = entregas.find((e) => e.mine);
      if (minha && !mapaAberto.has(minha.id) && window.MotoNav && !window.MotoNav.aberto()) abrirMapa(minha);
      else oferecerNova();
      // Mensagem nova do cliente ou da loja: o 💬 do mapa ganha o aviso na hora.
      if (minha) {
        const agora = naoLido(minha);
        if (agora && !naoLidoAntes.get(minha.id) && !conversa && window.MotoNav?.idAtual?.() === idTela(minha.id) && window.MotoNav.modo() === "nav" && !window.MotoNav.ocupado()) abrirMapa(minha);
        naoLidoAntes.set(minha.id, agora);
      }
      if (conversa) atualizarChat();
    }
    render();
  }

  async function agir(id, acao, botao) {
    ocupado.add(id);
    if (botao) botao.disabled = true;
    try {
      const dados = await post(`/api/food/deliveries/${encodeURIComponent(id)}/${acao}`);
      entregas = Array.isArray(dados.deliveries) ? dados.deliveries : [];
      aviso = "";
      const minha = acao === "accept" ? entregas.find((x) => x.id === id && x.mine) : null;
      if (minha) abrirMapa(minha);
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
    // A cada 15 s; o aviso em tempo real (push e conexão do app) busca na hora.
    timer = setInterval(carregar, 15000);
    if (!start.ouvindo) document.addEventListener("visibilitychange", () => { if (!document.hidden) carregar(); });
    start.ouvindo = true;
    if (new URLSearchParams(location.search).get("aba") === "food") setTimeout(abrirLista, 600);
  }

  window.MotoFood = { start, refresh: carregar };
})();
