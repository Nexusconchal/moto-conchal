// Chat da corrida dentro do app (cliente <-> motoboy), sem trocar WhatsApp.
// Uso: MotojaRideChat.open({ rideId, backend, titulo, auth: () => ({ headers, body }) })
(function () {
  "use strict";
  const POLL_MS = 4000;
  let state = null;

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const hora = (ms) => new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const seenKey = (rideId) => `motoja:chat-visto:${rideId}`;

  function markSeen(rideId, ms) {
    try {
      if (ms > Number(localStorage.getItem(seenKey(rideId)) || 0)) localStorage.setItem(seenKey(rideId), String(ms));
    } catch (_) {}
  }

  // Quantas mensagens novas do outro lado ainda nao foram vistas (para o selo no botao).
  function hasUnread(rideId, ultimaEmMs, ultimoAutor, voce) {
    if (!ultimaEmMs || !ultimoAutor || ultimoAutor === voce) return false;
    let seen = 0;
    try { seen = Number(localStorage.getItem(seenKey(rideId)) || 0); } catch (_) {}
    return Number(ultimaEmMs) > seen;
  }

  function injectStyle() {
    if (document.getElementById("motoja-chat-style")) return;
    const style = document.createElement("style");
    style.id = "motoja-chat-style";
    style.textContent = `
      .mjchat-back{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.6);display:flex;align-items:flex-end;justify-content:center}
      .mjchat{width:min(520px,100%);height:min(640px,88vh);display:flex;flex-direction:column;background:#11151f;color:#f3f5f8;border-radius:18px 18px 0 0;border:1px solid rgba(255,154,0,.35);overflow:hidden;font-family:inherit}
      .mjchat header{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.08);background:#161b27}
      .mjchat header b{flex:1;font-size:1rem}.mjchat header small{display:block;color:#9aa3b2;font-weight:400;font-size:.72rem;margin-top:2px}
      .mjchat header button{background:none;border:0;color:#fff;font-size:1.4rem;cursor:pointer;padding:4px 8px;box-shadow:none}
      .mjchat-list{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px}
      .mjchat-msg{max-width:80%;padding:9px 12px;border-radius:14px;line-height:1.35;font-size:.92rem;white-space:pre-wrap;overflow-wrap:anywhere}
      .mjchat-msg small{display:block;margin-top:3px;font-size:.66rem;opacity:.7;text-align:right}
      .mjchat-msg.eu{align-self:flex-end;background:#ff8a00;color:#111;border-bottom-right-radius:4px}
      .mjchat-msg.outro{align-self:flex-start;background:#232a38;border-bottom-left-radius:4px}
      .mjchat-vazio,.mjchat-aviso{color:#9aa3b2;font-size:.8rem;text-align:center;margin:auto 0}
      .mjchat-aviso{margin:0;padding:8px 14px;border-top:1px solid rgba(255,255,255,.06)}
      .mjchat form{display:flex;gap:8px;padding:10px;border-top:1px solid rgba(255,255,255,.08);background:#161b27}
      .mjchat textarea{flex:1;resize:none;min-height:42px;max-height:110px;padding:10px 12px;border-radius:12px;border:1px solid #394150;background:#0c0f16;color:#fff;font:inherit;font-size:.92rem}
      .mjchat form button{min-width:84px;border-radius:12px;border:0;background:#ff8a00;color:#111;font-weight:800;cursor:pointer}
      .mjchat form button:disabled{opacity:.5}
      .mjchat-rapidas{display:flex;gap:6px;overflow-x:auto;padding:8px 10px 0;background:#161b27}
      .mjchat-rapidas button{flex:0 0 auto;padding:7px 11px;border-radius:999px;border:1px solid rgba(255,154,0,.4);background:#1d2331;color:#ffd39a;font-size:.78rem;cursor:pointer;box-shadow:none}
      .mjchat-badge{display:inline-block;min-width:9px;height:9px;margin-left:6px;border-radius:50%;background:#ff3b30;vertical-align:middle}`;
    document.head.appendChild(style);
  }

  function render() {
    if (!state) return;
    const list = state.root.querySelector(".mjchat-list");
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.innerHTML = state.messages.length
      ? state.messages.map((m) => `<div class="mjchat-msg ${m.autor === state.voce ? "eu" : "outro"}">${esc(m.texto)}<small>${hora(m.criadoEmMs)}</small></div>`).join("")
      : `<p class="mjchat-vazio">Nenhuma mensagem ainda. Combine detalhes da ${esc(state.servico)} por aqui.</p>`;
    if (nearBottom || state.firstRender) list.scrollTop = list.scrollHeight;
    state.firstRender = false;
    const closed = state.aberto === false;
    state.root.querySelector("textarea").disabled = closed;
    state.root.querySelector("form button").disabled = closed || state.sending;
    state.root.querySelector(".mjchat-aviso").textContent = closed
      ? `A ${state.servico} terminou. O chat fica só para leitura.`
      : "Por segurança, números de telefone e links são escondidos. Combine tudo pelo app.";
  }

  async function request(path, extraBody = {}) {
    const auth = state.auth() || {};
    const response = await fetch(`${state.backend}/api/rides/${encodeURIComponent(state.rideId)}/chat/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth.headers || {}) },
      body: JSON.stringify({ ...(auth.body || {}), ...extraBody }),
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || "Não consegui falar com o servidor agora.");
    return data;
  }

  async function poll() {
    if (!state) return;
    const current = state;
    try {
      const last = current.messages.length ? current.messages[current.messages.length - 1].criadoEmMs : 0;
      const data = await request("list", { depoisDeMs: last });
      if (current !== state) return;
      current.voce = data.voce || current.voce;
      current.aberto = data.aberto;
      if (data.outro?.nome && !current.tituloFixo) current.root.querySelector("header b").firstChild.textContent = data.outro.nome;
      const known = new Set(current.messages.map((m) => m.id));
      for (const m of data.mensagens || []) if (!known.has(m.id)) current.messages.push(m);
      current.messages.sort((a, b) => a.criadoEmMs - b.criadoEmMs);
      if (current.messages.length) markSeen(current.rideId, current.messages[current.messages.length - 1].criadoEmMs);
      render();
    } catch (_) {
      // Mantem as mensagens na tela; tenta de novo no proximo ciclo.
    } finally {
      if (current === state) current.timer = setTimeout(poll, POLL_MS);
    }
  }

  async function send(texto) {
    if (!state || !texto.trim() || state.sending) return;
    const current = state;
    current.sending = true;
    render();
    try {
      const data = await request("send", { texto });
      if (current !== state) return;
      if (data.mensagem && !current.messages.some((m) => m.id === data.mensagem.id)) current.messages.push(data.mensagem);
      markSeen(current.rideId, data.mensagem?.criadoEmMs || Date.now());
      current.root.querySelector("textarea").value = "";
    } catch (error) {
      alert(error.message);
    } finally {
      current.sending = false;
      render();
    }
  }

  function close() {
    if (!state) return;
    clearTimeout(state.timer);
    state.root.remove();
    const onClose = state.onClose;
    state = null;
    onClose?.();
  }

  function open(options) {
    close();
    injectStyle();
    const root = document.createElement("div");
    root.className = "mjchat-back";
    const rapidas = options.rapidas || [];
    root.innerHTML = `<div class="mjchat" role="dialog" aria-modal="true" aria-label="Chat da corrida">
      <header><b>${esc(options.titulo || "Chat")}<small>${esc(options.subtitulo || "Conversa pelo app MotoJá")}</small></b><button type="button" data-mjchat-fechar aria-label="Fechar">×</button></header>
      <div class="mjchat-list" aria-live="polite"></div>
      <p class="mjchat-aviso"></p>
      ${rapidas.length ? `<div class="mjchat-rapidas">${rapidas.map((t) => `<button type="button" data-mjchat-rapida="${esc(t)}">${esc(t)}</button>`).join("")}</div>` : ""}
      <form><textarea maxlength="500" rows="1" placeholder="Escreva uma mensagem"></textarea><button type="submit">Enviar</button></form>
    </div>`;
    document.body.appendChild(root);
    state = { root, rideId: options.rideId, backend: options.backend, auth: options.auth, voce: options.voce || "", servico: options.servico || "corrida",
      tituloFixo: !!options.titulo, messages: [], aberto: true, sending: false, firstRender: true, timer: 0, onClose: options.onClose };
    root.addEventListener("click", (event) => {
      if (event.target === root || event.target.closest("[data-mjchat-fechar]")) close();
      const quick = event.target.closest("[data-mjchat-rapida]");
      if (quick) send(quick.dataset.mjchatRapida);
    });
    const textarea = root.querySelector("textarea");
    root.querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); send(textarea.value); });
    textarea.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(textarea.value); } });
    render();
    poll();
    setTimeout(() => textarea.focus(), 80);
  }

  window.MotojaRideChat = { open, close, hasUnread, markSeen };
  // O selo de mensagem nova aparece nos botoes antes de abrir o chat.
  if (document.head) injectStyle();
  else document.addEventListener("DOMContentLoaded", injectStyle);
})();
