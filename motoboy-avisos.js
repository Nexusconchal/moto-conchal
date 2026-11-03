// Perfil do motoboy: avisos de chamada (grupo do Telegram da cidade, teste e guia de bateria)
// e "Minha avaliação" (media e comentarios dos clientes, sem nome, como na 99).
// Uso: MotojaDriverExtras.start({ backend, getProof })
(function () {
  "use strict";
  let options = null;
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  // Estrelas preenchidas na proporcao da nota (4,67 mostra quase 5 cheias).
  const estrelas = (nota) => `<span class="mjx-estrelas" style="--p:${Math.max(0, Math.min(100, (Number(nota) || 0) * 20))}%">★★★★★</span>`;

  function injectStyle() {
    if ($("motoja-extras-style")) return;
    const style = document.createElement("style");
    style.id = "motoja-extras-style";
    style.textContent = `
      .mjx-card{display:grid;gap:10px;padding:16px;border-radius:16px;background:var(--driver-surface,#111319);border:1px solid var(--driver-line,rgba(255,255,255,.09))}
      .mjx-card h3{margin:0;font-size:1.02rem}
      .mjx-estrelas{display:inline-block;letter-spacing:2px;background:linear-gradient(90deg,#ffb400 var(--p),#3a4252 var(--p));-webkit-background-clip:text;background-clip:text;color:transparent}
      .mjx-media{display:flex;align-items:center;gap:14px}
      .mjx-media strong{font-size:2.4rem;line-height:1;color:#ffd166}
      .mjx-media .mjx-estrelas{font-size:1.2rem}
      .mjx-media small,.mjx-card .mjx-sub{display:block;color:#9aa3b2;font-size:.8rem}
      .mjx-barras{display:grid;gap:4px}
      .mjx-barra{display:grid;grid-template-columns:22px 1fr 34px;align-items:center;gap:8px;font-size:.78rem;color:#c8cdd6}
      .mjx-barra i{display:block;height:7px;border-radius:9px;background:#232a38;overflow:hidden}
      .mjx-barra i b{display:block;height:100%;background:#ffb400;border-radius:9px}
      .mjx-elogios{display:flex;flex-wrap:wrap;gap:6px}
      .mjx-elogios span{padding:5px 10px;border-radius:999px;background:#1a2030;border:1px solid #394150;font-size:.78rem}
      .mjx-lista{display:grid;gap:8px;max-height:340px;overflow-y:auto}
      .mjx-item{padding:10px 12px;border-radius:12px;background:#0c0f16;border:1px solid #232a38;font-size:.86rem}
      .mjx-item header{display:flex;justify-content:space-between;margin-bottom:4px}
      .mjx-item header small{color:#9aa3b2}
      .mjx-item p{margin:4px 0 0;color:#e6e9ef;white-space:pre-wrap;overflow-wrap:anywhere}
      .mjx-item em{font-style:normal;color:#9aa3b2;font-size:.76rem}
      .mjx-status{display:flex;gap:8px;flex-wrap:wrap}
      .mjx-status span{padding:5px 10px;border-radius:999px;font-size:.78rem;background:#232a38}
      .mjx-status .ok{background:rgba(53,201,121,.16);color:#7ee2a8}
      .mjx-status .no{background:rgba(255,114,0,.14);color:#ffb27a}
      .mjx-card details{background:#0c0f16;border-radius:12px;padding:10px 12px;border:1px solid #232a38}
      .mjx-card summary{cursor:pointer;font-weight:700}
      .mjx-grupo{display:block;text-align:center;padding:12px 14px;border-radius:12px;border:1px solid rgba(255,255,255,.12);background:#1a2030;color:#fff;font-weight:800;text-decoration:none}
      .mjx-grupo.sua{border-color:#2aabee;background:rgba(42,171,238,.14)}
      .mjx-card ol{margin:8px 0 0;padding-left:20px;display:grid;gap:6px;color:#c8cdd6;font-size:.86rem;line-height:1.35}`;
    document.head.appendChild(style);
  }

  async function post(path) {
    const response = await fetch(`${options.backend}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options.getProof()),
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || "Não consegui falar com o servidor agora.");
    return data;
  }

  function cpf() {
    return String(options.getProof()?.driverCpf || "").replace(/\D/g, "");
  }

  // ---------- Minha avaliação ----------
  async function loadRatings() {
    const box = $("minhaAvaliacao");
    if (!box || !cpf()) return;
    try {
      const d = await post(`/api/drivers/${cpf()}/ratings`);
      if (!d.total) {
        box.innerHTML = `<h3>⭐ Minha avaliação</h3><p class="mjx-sub">Você ainda não recebeu avaliações. Depois de cada corrida o cliente pode dar de 1 a 5 estrelas e deixar um comentário.</p>`;
        return;
      }
      const max = Math.max(1, ...Object.values(d.distribuicao || {}));
      const contagem = {};
      for (const r of d.recentes || []) if (r.nota === 5) for (const t of r.tags || []) contagem[t] = (contagem[t] || 0) + 1;
      const elogios = Object.entries(contagem).sort((a, b) => b[1] - a[1]).slice(0, 5);
      box.innerHTML = `<h3>⭐ Minha avaliação</h3>
        <div class="mjx-media"><strong>${d.media.toFixed(2).replace(".", ",")}</strong><div><span>${estrelas(d.media)}</span><small>${d.total} avaliaç${d.total === 1 ? "ão" : "ões"} de clientes</small></div></div>
        <div class="mjx-barras">${[5, 4, 3, 2, 1].map((n) => `<div class="mjx-barra">${n}★<i><b style="width:${Math.round((Number(d.distribuicao[n] || 0) / max) * 100)}%"></b></i><span>${d.distribuicao[n] || 0}</span></div>`).join("")}</div>
        ${elogios.length ? `<div><p class="mjx-sub">Elogios mais recebidos</p><div class="mjx-elogios">${elogios.map(([t, n]) => `<span>${esc(t)} · ${n}</span>`).join("")}</div></div>` : ""}
        <p class="mjx-sub">Últimas avaliações (os clientes ficam anônimos)</p>
        <div class="mjx-lista">${(d.recentes || []).map((r) => `<div class="mjx-item"><header>${estrelas(r.nota)}<small>${esc(r.dia)}</small></header>${r.tags?.length ? `<em>${r.tags.map(esc).join(" · ")}</em>` : ""}${r.comentario ? `<p>“${esc(r.comentario)}”</p>` : ""}</div>`).join("")}</div>`;
    } catch (error) {
      box.innerHTML = `<h3>⭐ Minha avaliação</h3><p class="mjx-sub">${esc(error.message)}</p>`;
    }
  }

  // ---------- Avisos de chamada ----------
  function guiaBateria() {
    return `<details><summary>🔋 Celular não apita com a tela bloqueada? Veja como arrumar</summary><ol>
      <li><b>Telegram:</b> Configurações do Android → Apps → Telegram → Bateria → <b>Sem restrições</b>.</li>
      <li><b>Navegador/app MotoJá:</b> faça o mesmo com o Chrome (ou o app MotoJá instalado): Bateria → <b>Sem restrições</b>.</li>
      <li><b>Notificações:</b> Apps → Telegram → Notificações → deixe ligadas, com <b>som</b> e <b>pop-up</b>.</li>
      <li><b>Xiaomi/Redmi/Poco:</b> Segurança → Permissões → <b>Início automático</b> → ligue Telegram e Chrome.</li>
      <li><b>Samsung:</b> Bateria → Limites de uso em segundo plano → tire Telegram e Chrome de “Apps em suspensão”.</li>
      <li><b>Motorola/outros:</b> procure “Otimização de bateria” → Todos os apps → Telegram → <b>Não otimizar</b>.</li>
      <li>Não feche o Telegram pela tela de apps recentes. Depois, toque em <b>Testar aviso</b> com a tela bloqueada.</li>
    </ol></details>`;
  }

  // Pelo link (app da tela inicial) a notificacao com o app fechado usa o som do Android.
  // O motoboy pode trocar esse som pela voz do MotoJa nas configuracoes do celular.
  function guiaSomVoz() {
    return `<details><summary>🔊 Ouvir “MotoJá, bora rodar” com o app fechado</summary>
      <p class="mjx-sub">Com o app aberto a voz já toca sozinha. Com o celular bloqueado, a notificação usa o som do Android — dá para trocar pela voz do MotoJá:</p>
      <audio controls preload="none" src="./audio/motoja-bora-rodar.mp3" style="width:100%;margin-top:8px"></audio>
      <a class="secondary mjx-grupo" href="./audio/motoja-bora-rodar.mp3" download="motoja-bora-rodar.mp3" style="margin-top:8px">⬇️ Baixar o som</a>
      <ol>
        <li>Toque em <b>Baixar o som</b> (vai para a pasta <b>Downloads</b>).</li>
        <li>Abra <b>Configurações</b> do Android → <b>Apps</b> → <b>Nexus MotoJÁ Motorista</b> (o ícone da tela inicial; se não aparecer, abra o <b>Chrome</b>) → <b>Notificações</b>.</li>
        <li>Toque na categoria das notificações (ex.: <b>Geral</b> ou <b>nexusmotoja.com.br</b>) → <b>Som</b>.</li>
        <li>Escolha <b>Adicionar</b> / <b>+</b> / <b>Do armazenamento</b> (Samsung) ou <b>Escolher arquivo</b> (Xiaomi) e selecione <b>motoja-bora-rodar</b>.</li>
        <li>Deixe a importância em <b>Urgente</b> / <b>Pop-up</b> e o celular no <b>modo som</b>. Depois toque em <b>Testar aviso agora</b> com a tela bloqueada.</li>
      </ol></details>`;
  }

  // Opcional: tela acesa enquanto esta Disponivel esperando chamada (pelo link a voz
  // so toca com o app aberto na tela). Gasta bateria: melhor no carregador da moto.
  const CHAVE_ESPERANDO = "motojaTelaAcesaEsperando";
  function querTelaEsperando() {
    try { return localStorage.getItem(CHAVE_ESPERANDO) === "1"; } catch (_) { return false; }
  }
  function aplicarTelaEsperando() {
    const disponivel = window.MotojaDriverAvailability?.canAlert?.() === true;
    if (querTelaEsperando() && disponivel) window.MotojaTelaAcesa?.ligar("esperando");
    else window.MotojaTelaAcesa?.desligar("esperando");
  }
  window.addEventListener("motoja:availability-changed", aplicarTelaEsperando);
  function opcaoTelaEsperando() {
    return `<label style="display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:12px;background:#0c0f16;border:1px solid #232a38;cursor:pointer">
      <input type="checkbox" data-mjx-tela ${querTelaEsperando() ? "checked" : ""} style="width:22px;height:22px;margin:2px 0 0;accent-color:#ff6b00">
      <span><b>📱 Tela acesa esperando chamada</b><small class="mjx-sub">Enquanto você estiver Disponível a tela não apaga, então a voz “MotoJá, bora rodar” toca na hora. Gasta bateria: use com o celular no carregador.</small></span>
    </label>`;
  }

  // Grupos dos motoboys no Telegram: toda corrida e entrega da cidade chega neles.
  const GRUPOS_TELEGRAM = [
    ["conchal", "Conchal", "https://t.me/+M49aycYVf_kyZjUx"],
    ["aguai", "Aguaí", "https://t.me/+-4wK_5c2Rks3OTMx"],
    ["engenheiro_coelho", "Engenheiro Coelho", "https://t.me/+hxfRgsNR1VcxYzVh"],
  ];

  async function loadAlerts() {
    const box = $("avisosMotoboy");
    if (!box || !cpf()) return;
    let status = null;
    try { status = await post(`/api/drivers/${cpf()}/notification-status`); } catch (_) {}
    const devices = Number(status?.push?.devices || 0);
    const cidade = options.cidade?.() || "";
    box.innerHTML = `<h3>🔔 Avisos de chamada</h3>
      <p class="mjx-sub">Toda corrida e entrega da sua cidade chega no <b>grupo dos motoboys no Telegram</b>. Entre no grupo da sua cidade e deixe as notificações dele ligadas: o Telegram avisa mesmo com o celular bloqueado.</p>
      <div class="mjx-status">
        <span class="${devices ? "ok" : "no"}">${devices ? `✅ Notificação em ${devices} aparelho${devices > 1 ? "s" : ""}` : "⚠️ Notificação do aparelho desligada"}</span>
      </div>
      ${GRUPOS_TELEGRAM.map(([id, nome, link]) => `<a class="secondary mjx-grupo${id === cidade ? " sua" : ""}" href="${link}" target="_blank" rel="noopener">✈️ Grupo de ${nome}${id === cidade ? " (sua cidade)" : ""}</a>`).join("")}
      ${opcaoTelaEsperando()}
      <button type="button" class="secondary" data-mjx-teste>Testar aviso agora</button>
      <p class="mjx-sub" data-mjx-msg></p>
      ${guiaSomVoz()}
      ${guiaBateria()}`;
  }

  function message(text) {
    const el = document.querySelector("[data-mjx-msg]");
    if (el) el.textContent = text;
  }

  async function test(button) {
    button.disabled = true;
    button.textContent = "Enviando teste...";
    try {
      const d = await post(`/api/drivers/${cpf()}/notification-test`);
      const partes = [];
      partes.push(d.push.sent ? `✅ Notificação enviada para ${d.push.sent} aparelho(s).` : "⚠️ Nenhum aparelho recebeu notificação. Toque em Ativar notificações neste aparelho.");
      message(`${partes.join(" ")} Se não apitou com a tela bloqueada, siga o guia da bateria abaixo.`);
    } catch (error) {
      message(error.message);
    } finally {
      button.disabled = false;
      button.textContent = "Testar aviso agora";
    }
  }

  function start(opts) {
    options = opts;
    injectStyle();
    const perfil = $("perfilMotoboy");
    if (perfil && !$("minhaAvaliacao")) {
      perfil.insertAdjacentHTML("afterend", `<div id="minhaAvaliacao" class="mjx-card"></div><div id="avisosMotoboy" class="mjx-card"></div>`);
      $("avisosMotoboy").addEventListener("click", (event) => {
        const teste = event.target.closest("[data-mjx-teste]");
        if (teste) test(teste);
      });
      $("avisosMotoboy").addEventListener("change", (event) => {
        const caixa = event.target.closest("[data-mjx-tela]");
        if (!caixa) return;
        try { localStorage.setItem(CHAVE_ESPERANDO, caixa.checked ? "1" : "0"); } catch (_) {}
        aplicarTelaEsperando();
      });
    }
    loadRatings();
    loadAlerts();
    aplicarTelaEsperando();
  }

  // Ao abrir a aba Perfil, atualiza a media e o status dos avisos.
  function refresh() {
    if (!options) return;
    loadRatings();
    loadAlerts();
  }

  window.MotojaDriverExtras = { start, refresh };
})();
