// Painel do dono: consumo do banco (Firestore) hoje, por parte do sistema, e dos ultimos dias.
// A cota gratis do Firebase e de 50 mil leituras e 20 mil gravacoes por dia e zera de madrugada
// (meia-noite no horario do Pacifico = 4h ou 5h no horario de Brasilia).
(function () {
  "use strict";
  const backend = () => (window.CONFIG && window.CONFIG.backend) || "https://motoboy-conchal.onrender.com";
  const senha = () => window.senhaDono || document.getElementById("senha")?.value?.trim() || "";
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const num = (n) => Number(n || 0).toLocaleString("pt-BR");

  // Nome que o dono entende para cada rota do servidor.
  const NOMES = [
    [/^espelho ao vivo/, "🔴 Espelho ao vivo (corridas e entregas em andamento)"],
    [/^POST \/api\/drivers\/:id\/jobs$/, "🏍️ App do motoboy: lista de chamadas e serviços"],
    [/^POST \/api\/drivers\/:id\/call-alerts$/, "🏍️ App do motoboy: alerta de chamada tocando"],
    [/^POST \/api\/drivers\/:id\/earnings/, "🏍️ App do motoboy: ganhos"],
    [/^POST \/api\/drivers\/:id\/plans$/, "🏍️ App do motoboy: planos reservados"],
    [/^POST \/api\/drivers\/:id\/location-city$/, "🏍️ App do motoboy: cidade pelo GPS"],
    [/^POST \/api\/(rides|deliveries)\/:id\/location$/, "📍 GPS do motoboy durante o serviço"],
    [/^POST \/api\/drivers\//, "🏍️ App do motoboy (outros)"],
    [/^POST \/api\/food\//, "🍔 App do motoboy: MotoJÁ Food"],
    [/^GET \/api\/rides\/:id\/status$/, "🙋 App do cliente: acompanhar corrida"],
    [/^(GET|POST) \/api\/rides/, "🙋 App do cliente: corridas"],
    [/^(GET|POST) \/api\/customers/, "🙋 App do cliente: conta"],
    [/^(GET|POST) \/api\/maps/, "🗺️ Mapa e endereços"],
    [/^GET \/api\/companies\/me\/active-deliveries$/, "🏪 Painel da empresa: entregas no mapa"],
    [/^(GET|POST) \/api\/compan/, "🏪 Painel da empresa"],
    [/^(GET|POST) \/api\/deliveries/, "🏪 Entregas (empresa e motoboy)"],
    [/^(GET|POST) \/api\/admin/, "👑 Painel do dono"],
    [/^(GET|POST) \/api\/support/, "🎧 Suporte"],
    [/^(GET|POST) \/api\/car/, "🚗 CarroJá"],
    [/^(GET|POST) \/api\/(mercadopago|payments|webhooks?)/, "💳 Pagamentos (Mercado Pago)"],
    [/^(GET|POST) \/api\/telegram/, "✈️ Telegram"],
    [/^rotina: /, (r) => "⚙️ Automático: " + r.replace(/^rotina: /, "")],
    [/^rotinas do servidor$/, "⚙️ Automático (avisos, conexões dos apps)"],
    [/^medidor de consumo$/, "📊 Este medidor"],
  ];
  const nome = (rota) => {
    for (const [re, label] of NOMES) if (re.test(rota)) return typeof label === "function" ? label(rota) : label;
    return rota;
  };

  function montar() {
    let box = document.getElementById("banco-section");
    if (box) return box;
    const visao = document.getElementById("visao-section");
    if (!visao) return null;
    box = document.createElement("section");
    box.id = "banco-section";
    box.className = "box grid";
    box.innerHTML = `<h2>Consumo do banco (Firebase)</h2>
      <p class="muted">Cota grátis por dia: <b>50.000 leituras</b> e <b>20.000 gravações</b>. Se passar, os apps param até zerar (de madrugada, 4h–5h). A conta começa quando o servidor liga e é salva a cada 20 min.</p>
      <div id="bancoResumo" class="muted">Carregando...</div>
      <div id="bancoRotas" class="table compact"></div>
      <div id="bancoDias" class="muted"></div>`;
    visao.insertAdjacentElement("afterend", box);
    const pagina = document.getElementById("ownerWorkspace")?.dataset.page;
    box.hidden = !!pagina && pagina !== "overview";
    return box;
  }

  function barra(usado, limite) {
    const pct = Math.min(100, Math.round((usado / limite) * 100));
    const cor = pct >= 85 ? "#ff5252" : pct >= 60 ? "#ffd700" : "#25d366";
    return `<div style="height:10px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden;margin:6px 0 2px"><div style="height:100%;width:${pct}%;background:${cor}"></div></div><small style="color:${cor};font-weight:900">${pct}% da cota grátis</small>`;
  }

  function render(d) {
    const box = montar();
    if (!box) return;
    const hoje = d.hoje || {};
    const lim = d.limites || { leituras: 50000, gravacoes: 20000 };
    const desde = hoje.desdeMs ? new Date(hoje.desdeMs).toLocaleString("pt-BR", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }) : "";
    const espelho = Object.values(d.espelho || {});
    const espelhoOk = espelho.length && espelho.every((e) => e.pronto);
    box.querySelector("#bancoResumo").innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
        <div><strong style="color:#fff">📖 Leituras hoje: ${num(hoje.leituras)}</strong> de ${num(lim.leituras)}${barra(hoje.leituras || 0, lim.leituras)}</div>
        <div><strong style="color:#fff">✍️ Gravações hoje: ${num(hoje.gravacoes)}</strong> de ${num(lim.gravacoes)}${barra(hoje.gravacoes || 0, lim.gravacoes)}</div>
      </div>
      <p style="margin-top:8px">${espelhoOk ? "🟢 Espelho ao vivo ligado: listas de chamadas, status e mapa da loja saem da memória do servidor." : "🟠 Espelho ao vivo ainda ligando (ou o banco recusou): o servidor consulta o banco como antes."}${desde ? ` Contando desde ${esc(desde)} (dia da cota ${esc(hoje.dia || "")}).` : ""}</p>`;
    const rotas = (hoje.rotas || []).filter((r) => r.leituras || r.gravacoes);
    box.querySelector("#bancoRotas").innerHTML = rotas.length
      ? `<table style="min-width:0"><thead><tr><th>Quem usou</th><th>Leituras</th><th>Gravações</th><th>Pedidos</th></tr></thead><tbody>${rotas.map((r) => `<tr><td title="${esc(r.rota)}">${esc(nome(r.rota))}</td><td>${num(r.leituras)}</td><td>${num(r.gravacoes)}</td><td>${r.vezes ? num(r.vezes) : "—"}</td></tr>`).join("")}</tbody></table>`
      : '<div class="empty">Ainda sem consumo contado hoje.</div>';
    const dias = d.anteriores || [];
    box.querySelector("#bancoDias").innerHTML = dias.length
      ? "<b>Dias anteriores:</b> " + dias.map((x) => `${esc(x.dia.slice(8, 10))}/${esc(x.dia.slice(5, 7))}: ${num(x.leituras)} leituras · ${num(x.gravacoes)} gravações`).join(" &nbsp;|&nbsp; ")
      : "";
  }

  async function carregar() {
    if (!senha() || document.hidden || !montar()) return;
    try {
      const r = await fetch(`${backend()}/api/admin/db-usage`, { headers: { "x-owner-password": senha() }, cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || d.error || "Servidor sem o medidor ainda (atualize o Render).");
      render(d);
    } catch (e) {
      const el = document.getElementById("bancoResumo");
      if (el) el.textContent = e.message || "Não consegui carregar o consumo do banco.";
    }
  }

  const espera = setInterval(() => {
    if (!senha() || !document.getElementById("visao-section")) return;
    clearInterval(espera);
    carregar();
    // O medidor fica na memória do servidor: ver o consumo não gasta leitura do banco.
    setInterval(carregar, 3 * 60000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) carregar(); });
  }, 1500);
})();
