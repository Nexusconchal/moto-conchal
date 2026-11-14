// Repasses do cartao: corridas pagas na conta Mercado Pago da MotoJa (cartao salvo no app
// ou link da conta MotoJa) cuja parte do motoboy a MotoJa ainda precisa pagar.
(function () {
  "use strict";
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const reais = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const backend = () => window.CONFIG?.backend || "";
  const senha = () => window.senhaDono || document.getElementById("senha")?.value?.trim() || "";
  let carregando = false;

  async function carregar() {
    const box = document.getElementById("repasses");
    if (!box || !senha() || carregando) return;
    carregando = true;
    try {
      const r = await fetch(`${backend()}/api/admin/repasses`, { headers: { "x-owner-password": senha() }, cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || d.error || "Não consegui carregar os repasses.");
      const lista = d.motoboys || [];
      // Liquido: repasse menos a taxa das corridas que o motoboy recebeu em dinheiro.
      const pagar = (m) => Number(m.liquido ?? m.total ?? 0);
      const total = lista.reduce((s, m) => s + pagar(m), 0);
      const estornos = d.estornosAposPagamento || [];
      document.getElementById("repassesTotal").textContent = lista.length ? `Total a pagar: ${reais(total)}` : "";
      box.innerHTML = (lista.length
        ? `<table><thead><tr><th>Motoboy</th><th>Corridas</th><th>Repasse</th><th>Taxa em dinheiro</th><th>A pagar</th><th>Desde</th><th>Ação</th></tr></thead><tbody>${lista.map((m) => `<tr><td>${esc(m.motoboyNome)}</td><td>${Number(m.corridas || 0)}</td><td>${reais(m.total)}</td><td>${Number(m.dividaApp || 0) > 0 ? `<span style="color:#ffb27a">− ${reais(m.dividaApp)}</span>` : "-"}</td><td><b>${reais(pagar(m))}</b></td><td>${m.desdeMs ? new Date(m.desdeMs).toLocaleDateString("pt-BR") : "-"}</td><td><button type="button" data-repasse-pago="${esc(m.motoboyCpf)}" data-nome="${esc(m.motoboyNome)}" data-total="${pagar(m)}">Já paguei</button></td></tr>`).join("")}</tbody></table><div style="padding:8px 14px;color:#aeb4c3;font-size:.8rem">"Taxa em dinheiro" é a parte do app das corridas que o motoboy recebeu em dinheiro: já sai do valor a pagar.</div>`
        : `<div style="padding:16px;color:#aeb4c3">Nenhum repasse pendente. ✅</div>`)
        + (estornos.length ? `<div style="padding:12px 14px;color:#ffb4ab;border-top:1px solid rgba(255,82,82,.3)">⚠️ ${estornos.length} corrida(s) estornada(s) depois que o repasse já tinha sido pago: ${estornos.map((e) => `${esc(e.motoboyNome)} ${reais(e.valor)}`).join(", ")}. Desconte no próximo repasse.</div>` : "");
    } catch (error) {
      box.innerHTML = `<div style="padding:16px;color:#ffb4ab">${esc(error.message)}</div>`;
    } finally {
      carregando = false;
    }
  }

  document.addEventListener("click", async (e) => {
    const botao = e.target.closest("[data-repasse-pago]");
    if (!botao) return;
    if (!confirm(`Confirma que você já pagou ${reais(botao.dataset.total)} para ${botao.dataset.nome}? Os repasses dele saem da lista.`)) return;
    botao.disabled = true;
    try {
      const r = await fetch(`${backend()}/api/admin/repasses/pagar`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-owner-password": senha() },
        body: JSON.stringify({ motoboyCpf: botao.dataset.repassePago }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || d.error || "Não consegui marcar como pago.");
    } catch (error) {
      alert(error.message);
    }
    botao.disabled = false;
    carregar();
  });

  // Carrega quando o dono entra e a cada 2 minutos.
  let tentativas = 0;
  const espera = setInterval(() => {
    tentativas += 1;
    if (window.senhaDono) { clearInterval(espera); carregar(); setInterval(carregar, 120000); }
    else if (tentativas > 3600) clearInterval(espera);
  }, 1000);
  window.MotojaRepasses = { carregar };
})();
