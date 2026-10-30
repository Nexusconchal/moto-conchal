// MotoJÁ Food no painel do dono: empresas cadastradas, pedidos, quanto ficou para a MotoJá,
// para as lojas e para os motoboys, e quantas entregas usaram motoboy MotoJá.
(function () {
  "use strict";
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const reais = (centavos) => (Number(centavos || 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const backend = () => window.CONFIG?.backend || "";
  const senha = () => window.senhaDono || document.getElementById("senha")?.value?.trim() || "";
  const card = (valor, rotulo) => `<div style="background:rgba(255,184,0,.08);border:1px solid rgba(255,184,0,.25);border-radius:12px;padding:12px"><b style="display:block;font-size:20px">${valor}</b><span style="color:#aeb4c3;font-size:12px">${rotulo}</span></div>`;
  const tabela = (cabecalho, linhas) => `<table><thead><tr>${cabecalho.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${linhas.join("")}</tbody></table>`;
  let carregando = false;

  async function carregar() {
    const box = document.getElementById("foodResumo");
    if (!box || !senha() || carregando) return;
    carregando = true;
    const dias = document.getElementById("foodDias")?.value || "30";
    try {
      const r = await fetch(`${backend()}/api/admin/food-summary?dias=${encodeURIComponent(dias)}`, { headers: { "x-owner-password": senha() }, cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || d.error || "Não consegui carregar o MotoJÁ Food.");
      if (!d.configurado) {
        box.innerHTML = `<div style="padding:16px;color:#aeb4c3">O MotoJÁ Food ainda não está ligado a este painel. Quando o Food estiver no ar, coloque no Render deste serviço <b>FOOD_URL</b> (endereço do Food) e <b>FOOD_PLATFORM_KEY</b> (a mesma chave do serviço do Food).</div>`;
        return;
      }
      const link = document.getElementById("foodAbrir");
      if (link) { link.href = d.foodUrl + "/?painel=gestao"; link.hidden = false; }
      const empresas = d.companies.latest || [];
      box.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;padding:12px">
        ${card(reais(d.money.platform), "ficou para a MotoJá")}
        ${card(reais(d.money.gross), "vendido pelo app")}
        ${card(d.orders.delivered, "pedidos entregues")}
        ${card(d.deliveries.motoja, "entregas com motoboy MotoJá")}
        ${card(reais(d.money.drivers), "para os motoboys (com gorjeta)")}
        ${card(reais(d.money.stores), "para as lojas")}
        ${card(d.companies.total + (d.companies.pending ? ` (${d.companies.pending} em análise)` : ""), "empresas cadastradas")}
        ${card(d.orders.customers, "clientes que pediram")}
      </div>
      <p class="muted" style="padding:0 12px">Comissão ${reais(d.money.commission)} (10% dos produtos) + ${reais(d.money.fleetFeeShare)} do frete MotoJá (R$ 1,50 por entrega). ${esc(d.money.note || "")}</p>
      <h3 style="padding:0 12px">Por cidade</h3>
      ${tabela(["Cidade", "Lojas", "Pedidos", "Entregues", "MotoJá"], (d.cities || []).map((c) => `<tr><td>${esc(c.name)}</td><td>${c.stores}</td><td>${c.orders}</td><td>${c.delivered}</td><td>${reais(c.platform)}</td></tr>`))}
      <h3 style="padding:0 12px">Empresas que se cadastraram</h3>
      ${empresas.length ? tabela(["Empresa", "Cidade", "Categoria", "Entrega", "Situação", "Cadastro"], empresas.map((e) => `<tr><td>${esc(e.name)}${e.responsible ? `<br><small>${esc(e.responsible)}</small>` : ""}</td><td>${esc(e.city)}</td><td>${esc(e.category)}</td><td>${e.deliveryBy === "loja" ? "Motoboy próprio" : "Motoboy MotoJá"}</td><td>${e.approval === "pendente" ? "⏳ Em análise" : e.approval === "recusada" ? "Recusada" : "✅ Aprovada"}</td><td>${new Date(e.createdAt).toLocaleDateString("pt-BR")}</td></tr>`)) : `<div style="padding:12px;color:#aeb4c3">Nenhuma empresa cadastrada ainda.</div>`}
      <h3 style="padding:0 12px">Lojas que mais venderam</h3>
      ${(d.topStores || []).length ? tabela(["Loja", "Pedidos", "Vendido", "MotoJá"], d.topStores.map((s) => `<tr><td>${esc(s.name)} <small>${esc(s.city)}</small></td><td>${s.orders}</td><td>${reais(s.gross)}</td><td>${reais(s.platform)}</td></tr>`)) : `<div style="padding:12px;color:#aeb4c3">Sem pedidos entregues no período.</div>`}
      <h3 style="padding:0 12px">Motoboys MotoJá no Food</h3>
      ${(d.topDrivers || []).length ? tabela(["Motoboy", "Entregas", "Recebe"], d.topDrivers.map((m) => `<tr><td>${esc(m.name)}</td><td>${m.deliveries}</td><td>${reais(m.earned)}</td></tr>`)) : `<div style="padding:12px;color:#aeb4c3">Sem entregas de motoboy MotoJá no período.</div>`}`;
    } catch (error) {
      box.innerHTML = `<div style="padding:16px;color:#ffb4ab">${esc(error.message)}</div>`;
    } finally {
      carregando = false;
    }
  }

  document.addEventListener("change", (e) => { if (e.target.id === "foodDias") carregar(); });
  // Carrega quando o dono entra e a cada 5 minutos.
  let tentativas = 0;
  const espera = setInterval(() => {
    tentativas += 1;
    if (window.senhaDono) { clearInterval(espera); carregar(); setInterval(carregar, 300000); }
    else if (tentativas > 3600) clearInterval(espera);
  }, 1000);
  window.MotojaFood = { carregar };
})();
