// MotoJÁ Food no painel do dono: só um resumo (pedidos, quanto ficou para a MotoJá, empresas esperando)
// e o botão que abre o painel de gestão do próprio Food (gestao.html, login com a conta do dono).
// A gestão completa (empresas, pedidos, promoções, acerto, equipe, atendimento) fica no Food, separada daqui:
// se este servidor dormir ou a senha mudar, o Food continua funcionando.
(function () {
  "use strict";
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const reais = (centavos) => (Number(centavos || 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const backend = () => window.CONFIG?.backend || "";
  const senha = () => window.senhaDono || "";
  const $ = (id) => document.getElementById(id);
  const GESTAO = "https://parceiro.nexusmotoja.com.br/gestao.html";
  let carregando = false;

  function estilo() {
    if ($("food-resumo-style")) return;
    const s = document.createElement("style");
    s.id = "food-resumo-style";
    s.textContent = `
      .fr-card{display:flex;flex-wrap:wrap;align-items:center;gap:14px;padding:14px;border-radius:16px;border:1px solid rgba(255,184,0,.28);background:rgba(255,184,0,.06)}
      .fr-nums{display:flex;flex-wrap:wrap;gap:10px;flex:1 1 420px}
      .fr-num{min-width:130px;padding:10px 12px;border-radius:12px;background:rgba(7,9,17,.46);border:1px solid rgba(255,255,255,.08)}
      .fr-num b{display:block;font-size:19px}.fr-num span{color:#aeb4c3;font-size:12px}
      .fr-num.alerta{border-color:rgba(255,215,0,.5)}.fr-num.alerta b{color:#ffd700}
      .fr-abrir{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;border-radius:999px;background:linear-gradient(135deg,#ff6b00,#ff9a00);color:#fff;font-weight:900;text-decoration:none}
      .fr-erro{color:#ffb4ab;font-weight:800}`;
    document.head.appendChild(s);
  }

  async function carregar() {
    const box = $("foodResumo");
    if (!box || !senha() || carregando) return;
    estilo();
    box.classList.remove("table", "compact");
    carregando = true;
    const dias = $("foodDias")?.value || "30";
    try {
      const r = await fetch(`${backend()}/api/admin/food-summary?dias=${encodeURIComponent(dias)}`, { headers: { "x-owner-password": senha() }, cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (r.status === 401) throw new Error("A senha do painel mudou ou a sessão venceu. Aperte F5 e entre de novo.");
      if (!r.ok) throw new Error(d.message || "O MotoJÁ Food não respondeu agora. Ele pode estar acordando: tente de novo em 30 segundos.");
      if (!d.configurado) { box.innerHTML = `<div class="empty">O MotoJÁ Food não está ligado a este painel (falta FOOD_URL ou FOOD_PLATFORM_KEY no Render).</div>`; return; }
      const pendentes = d.companies?.pending || 0;
      box.innerHTML = `<div class="fr-card"><div class="fr-nums">
          <div class="fr-num"><b>${d.orders?.delivered ?? 0}</b><span>pedidos entregues</span></div>
          <div class="fr-num"><b>${reais(d.money?.gross)}</b><span>vendido pelo app</span></div>
          <div class="fr-num"><b>${reais(d.money?.platform)}</b><span>ficou para a MotoJá</span></div>
          <div class="fr-num"><b>${reais(d.money?.drivers)}</b><span>para os motoboys</span></div>
          <div class="fr-num ${pendentes ? "alerta" : ""}"><b>${pendentes}</b><span>empresa(s) esperando liberar</span></div>
        </div><a class="fr-abrir" href="${GESTAO}" target="_blank" rel="noopener">Abrir painel do Food ↗</a></div>
        <p class="muted" style="margin-top:8px">Liberar empresas, pedidos, promoções, acerto, equipe e atendimento ficam no painel do Food. Entre lá com a sua conta Google do dono.</p>`;
    } catch (error) {
      box.innerHTML = `<div class="fr-card"><span class="fr-erro">${esc(error.message)}</span><a class="fr-abrir" href="${GESTAO}" target="_blank" rel="noopener">Abrir painel do Food ↗</a></div>`;
    } finally {
      carregando = false;
    }
  }

  document.addEventListener("change", (e) => { if (e.target.id === "foodDias") carregar(); });
  // Carrega quando o dono entra e a cada 2 minutos.
  let tentativas = 0;
  const espera = setInterval(() => {
    tentativas += 1;
    if (window.senhaDono) {
      clearInterval(espera);
      carregar();
      setInterval(() => { if (!document.hidden) carregar(); }, 120000);
    } else if (tentativas > 3600) clearInterval(espera);
  }, 1000);
  window.MotojaFood = { carregar };
})();
