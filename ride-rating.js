// Avaliacao do motoboy pelo cliente ao terminar a corrida (como na 99):
// estrelas, etiquetas prontas e comentario opcional. Pode pular.
// Uso: MotojaRideRating.open({ rideId, backend, motoboy, foto, auth: () => headers, onDone })
(function () {
  "use strict";
  // Mesmas etiquetas aceitas pelo servidor (backend/src/ride-rating.js).
  const TAGS = {
    elogio: ["Ótima direção", "Simpático", "Chegou rápido", "Moto limpa", "Capacete limpo", "Ótima conversa"],
    problema: ["Demorou para chegar", "Direção perigosa", "Rota ruim", "Falta de educação", "Sem capacete para mim", "Cobrou diferente"],
  };
  const LEGENDA = ["", "Muito ruim", "Ruim", "Regular", "Boa", "Excelente!"];
  const PENDENTE = "motoja:avaliacao-pendente";
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function injectStyle() {
    if (document.getElementById("motoja-rating-style")) return;
    const style = document.createElement("style");
    style.id = "motoja-rating-style";
    style.textContent = `
      .mjrate-back{position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,.65);display:flex;align-items:flex-end;justify-content:center}
      .mjrate{width:min(520px,100%);max-height:92vh;overflow-y:auto;background:#11151f;color:#f3f5f8;border-radius:20px 20px 0 0;border:1px solid rgba(255,154,0,.35);padding:22px 18px 18px;text-align:center;font-family:inherit}
      .mjrate-foto{width:72px;height:72px;border-radius:50%;object-fit:cover;border:2px solid #ff8a00;background:#232a38;display:inline-flex;align-items:center;justify-content:center;font-size:2rem}
      .mjrate h3{margin:10px 0 2px;font-size:1.15rem}.mjrate p{margin:0;color:#9aa3b2;font-size:.86rem}
      .mjrate-estrelas{display:flex;justify-content:center;gap:6px;margin:16px 0 4px}
      .mjrate-estrelas button{background:none;border:0;box-shadow:none;font-size:2.4rem;line-height:1;color:#3a4252;cursor:pointer;padding:2px;transition:transform .12s}
      .mjrate-estrelas button.on{color:#ffb400}.mjrate-estrelas button:active{transform:scale(1.2)}
      .mjrate-legenda{min-height:1.2em;font-weight:700;color:#ffd39a}
      .mjrate-tags{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin:14px 0}
      .mjrate-tags button{padding:8px 12px;border-radius:999px;border:1px solid #394150;background:#1a2030;color:#e6e9ef;font-size:.84rem;cursor:pointer;box-shadow:none}
      .mjrate-tags button.on{background:#ff8a00;border-color:#ff8a00;color:#111;font-weight:700}
      .mjrate textarea{width:100%;box-sizing:border-box;min-height:70px;resize:vertical;padding:10px 12px;border-radius:12px;border:1px solid #394150;background:#0c0f16;color:#fff;font:inherit;font-size:.9rem}
      .mjrate-acoes{display:flex;gap:10px;margin-top:14px}
      .mjrate-acoes button{flex:1;padding:13px;border-radius:12px;border:0;font-weight:800;font-size:.95rem;cursor:pointer}
      .mjrate-enviar{background:#ff8a00;color:#111}.mjrate-enviar:disabled{opacity:.45}
      .mjrate-pular{background:#232a38;color:#e6e9ef}
      .mjrate-ok{font-size:2.6rem;margin:8px 0}`;
    document.head.appendChild(style);
  }

  function savePending(info) {
    try { localStorage.setItem(PENDENTE, JSON.stringify({ ...info, ate: Date.now() + 7 * 864e5 })); } catch (_) {}
  }
  function clearPending() {
    try { localStorage.removeItem(PENDENTE); } catch (_) {}
  }
  function pending() {
    try {
      const info = JSON.parse(localStorage.getItem(PENDENTE) || "null");
      if (info?.rideId && Number(info.ate || 0) > Date.now()) return info;
      clearPending();
    } catch (_) {}
    return null;
  }

  function open(options) {
    if (!options?.rideId || document.querySelector(".mjrate-back")) return;
    injectStyle();
    savePending({ rideId: options.rideId, motoboy: options.motoboy || "", foto: options.foto || "" });
    let nota = 0;
    const escolhidas = new Set();
    const root = document.createElement("div");
    root.className = "mjrate-back";
    const foto = /^(https:|data:image\/)/.test(options.foto || "")
      ? `<img class="mjrate-foto" src="${esc(options.foto)}" alt="">`
      : `<span class="mjrate-foto">🏍️</span>`;
    root.innerHTML = `<div class="mjrate" role="dialog" aria-modal="true" aria-label="Avaliar motoboy">
      ${foto}
      <h3>Como foi sua corrida com ${esc(options.motoboy || "o motoboy")}?</h3>
      <p>Sua avaliação é anônima e ajuda a manter a MotoJá segura.</p>
      <div class="mjrate-estrelas">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-nota="${n}" aria-label="${n} estrela${n > 1 ? "s" : ""}">★</button>`).join("")}</div>
      <div class="mjrate-legenda"></div>
      <div class="mjrate-detalhe" hidden>
        <p class="mjrate-pergunta"></p>
        <div class="mjrate-tags"></div>
        <textarea maxlength="300" placeholder="Quer contar mais? (opcional)"></textarea>
      </div>
      <div class="mjrate-acoes"><button type="button" class="mjrate-pular">Agora não</button><button type="button" class="mjrate-enviar" disabled>Enviar</button></div>
    </div>`;
    document.body.appendChild(root);
    const box = root.querySelector(".mjrate");
    const enviar = root.querySelector(".mjrate-enviar");

    function close(done) {
      root.remove();
      if (done) clearPending();
      options.onDone?.(done);
    }

    function paint() {
      root.querySelectorAll("[data-nota]").forEach((b) => b.classList.toggle("on", Number(b.dataset.nota) <= nota));
      root.querySelector(".mjrate-legenda").textContent = LEGENDA[nota] || "";
      const detalhe = root.querySelector(".mjrate-detalhe");
      detalhe.hidden = !nota;
      const lista = nota === 5 ? TAGS.elogio : TAGS.problema;
      root.querySelector(".mjrate-pergunta").textContent = nota === 5 ? "O que você mais gostou?" : "O que pode melhorar?";
      root.querySelector(".mjrate-tags").innerHTML = lista.map((t) => `<button type="button" data-tag="${esc(t)}" class="${escolhidas.has(t) ? "on" : ""}">${esc(t)}</button>`).join("");
      enviar.disabled = !nota;
    }

    async function send() {
      enviar.disabled = true;
      enviar.textContent = "Enviando...";
      try {
        const response = await fetch(`${options.backend}/api/rides/${encodeURIComponent(options.rideId)}/rating`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(options.auth?.() || {}) },
          body: JSON.stringify({ nota, tags: [...escolhidas], comentario: root.querySelector("textarea").value }),
        });
        const data = await response.json().catch(() => ({}));
        // Ja avaliada ou prazo encerrado: nao adianta perguntar de novo.
        if (!response.ok && !["corrida_ja_avaliada", "avaliacao_expirada", "corrida_sem_motoboy"].includes(data.error)) throw new Error(data.message || "Não consegui enviar agora. Tente de novo.");
        box.innerHTML = `<div class="mjrate-ok">${nota >= 4 ? "🧡" : "🙏"}</div><h3>Obrigado pela avaliação!</h3><p>${nota >= 4 ? "Vamos mandar seu elogio para o motoboy." : "Vamos olhar com atenção o que aconteceu."}</p><div class="mjrate-acoes"><button type="button" class="mjrate-enviar" data-fechar>Fechar</button></div>`;
        clearPending();
        setTimeout(() => root.isConnected && close(true), 3500);
      } catch (error) {
        alert(error.message);
        enviar.disabled = false;
        enviar.textContent = "Enviar";
      }
    }

    root.addEventListener("click", (event) => {
      const star = event.target.closest("[data-nota]");
      if (star) {
        const nova = Number(star.dataset.nota);
        // Elogio e problema sao listas diferentes: trocar de lado limpa as escolhidas.
        if ((nova === 5) !== (nota === 5)) escolhidas.clear();
        nota = nova;
        paint();
        return;
      }
      const tag = event.target.closest("[data-tag]");
      if (tag) {
        escolhidas.has(tag.dataset.tag) ? escolhidas.delete(tag.dataset.tag) : escolhidas.add(tag.dataset.tag);
        tag.classList.toggle("on");
        return;
      }
      if (event.target.closest("[data-fechar]")) return close(true);
      if (event.target.closest(".mjrate-pular")) return close(true);
      if (event.target.closest(".mjrate-enviar")) send();
    });
  }

  // Corrida terminou e o app foi fechado antes de avaliar: pergunta de novo ao abrir.
  function resume(options) {
    const info = pending();
    if (info) open({ ...options, ...info });
  }

  window.MotojaRideRating = { open, resume, TAGS };
})();
