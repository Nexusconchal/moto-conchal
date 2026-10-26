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
})();
