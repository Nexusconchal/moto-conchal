// Painel do dono: "Desconectar celulares" derruba o acesso de todos os celulares de um
// motoboy (celular perdido, roubado ou suspeita). Ele volta a entrar com o codigo do WhatsApp.
(function () {
  "use strict";
  const backend = () => window.CONFIG?.backend || "";
  const senha = () => window.senhaDono || document.getElementById("senha")?.value?.trim() || "";

  document.addEventListener("click", async (e) => {
    const botao = e.target.closest("[data-desconectar-motoboy]");
    if (!botao) return;
    if (!confirm("Desconectar todos os celulares deste motoboy? Ele vai precisar entrar de novo com o código que chega no WhatsApp dele.")) return;
    botao.disabled = true;
    botao.textContent = "Desconectando...";
    try {
      const r = await fetch(`${backend()}/api/admin/drivers/${encodeURIComponent(botao.dataset.desconectarMotoboy)}/sessions/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-owner-password": senha() },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || d.error || "Não consegui desconectar agora.");
      botao.textContent = "Desconectado ✓";
    } catch (error) {
      alert(error.message);
      botao.disabled = false;
      botao.textContent = "Desconectar celulares";
    }
  });

  // Grupo do WhatsApp: em cada motoboy, mostra se ele esta no grupo da cidade (o bot confere).
  const NOMES = { conchal: "Conchal", aguai: "Aguaí", engenheiro_coelho: "Eng. Coelho" };
  let grupos = null;
  let buscadoEm = 0;

  async function carregarGrupos() {
    if (!senha() || Date.now() - buscadoEm < 5 * 60000) return;
    buscadoEm = Date.now();
    try {
      const r = await fetch(`${backend()}/api/admin/drivers/groups`, { headers: { "x-owner-password": senha() }, cache: "no-store" });
      if (r.ok) grupos = await r.json();
    } catch (_) {}
    marcar();
  }

  function selo(cpf) {
    const status = grupos?.motoboys?.[cpf];
    if (!status) return "";
    const dentro = Object.keys(status).filter((c) => status[c] === true).map((c) => NOMES[c] || c);
    const conferiu = Object.values(status).some((v) => v !== null);
    if (dentro.length) return `<div class="grupo-selo" style="margin:4px 0;color:#7ee2a8;font-weight:800">✅ No grupo: ${dentro.join(", ")}</div>`;
    if (!conferiu) return `<div class="grupo-selo" style="margin:4px 0;color:#ffd39a">⚠️ Não deu para conferir o grupo</div>`;
    return `<div class="grupo-selo" style="margin:4px 0;color:#ff8a80;font-weight:800">❌ Fora dos grupos</div>`;
  }

  function marcar() {
    const tabela = document.getElementById("motoboys");
    if (!tabela || !grupos) return;
    tabela.querySelectorAll("[data-desconectar-motoboy]").forEach((botao) => {
      const celula = botao.parentElement;
      if (!celula || celula.querySelector(".grupo-selo")) return;
      celula.insertAdjacentHTML("afterbegin", selo(botao.dataset.desconectarMotoboy));
    });
    const aviso = document.getElementById("grupos-aviso");
    const semNumero = Object.values(grupos.grupos || {}).reduce((s, g) => s + Number(g.semNumero || 0), 0);
    const semGrupo = Object.entries(grupos.grupos || {}).filter(([, g]) => !g.configurado || g.erro).map(([c]) => NOMES[c] || c);
    const textos = [];
    if (semGrupo.length) textos.push(`O WhatsApp da empresa não está (ou não achou) o grupo de: ${semGrupo.join(", ")}. Coloque o número da empresa nesses grupos.`);
    if (semNumero) textos.push(`${semNumero} participante(s) aparecem no WhatsApp sem número visível; esses não dá para conferir.`);
    if (!textos.length) { aviso?.remove(); return; }
    if (aviso) { aviso.textContent = `⚠️ ${textos.join(" ")}`; return; }
    tabela.insertAdjacentHTML("beforebegin", `<p id="grupos-aviso" class="muted" style="color:#ffd39a">⚠️ ${textos.join(" ")}</p>`);
  }

  const observar = setInterval(() => {
    const tabela = document.getElementById("motoboys");
    if (!tabela || !senha()) return;
    clearInterval(observar);
    new MutationObserver(marcar).observe(tabela, { childList: true, subtree: true });
    carregarGrupos();
    setInterval(carregarGrupos, 5 * 60000);
  }, 1000);
})();
