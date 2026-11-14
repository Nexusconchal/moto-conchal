// Ligacao de voz pelo app MotoJa (cliente <-> motoboy), igual ligacao do WhatsApp:
// o audio vai pela internet, direto entre os celulares, e ninguem ve o numero do outro.
// Uso:
//   MotojaRideCall.watch({ rideId, backend, auth, voce, nomeOutro })  // escuta ligacao recebida
//   MotojaRideCall.call({ rideId, backend, auth, voce, nomeOutro })   // liga para o outro lado
//   MotojaRideCall.unwatch()
// auth() devolve { headers, body } (o mesmo do chat da corrida).
(function () {
  "use strict";
  const WATCH_MS = 3000, ACTIVE_MS = 1200;
  let watcher = null;      // { opts, timer, token }
  let session = null;      // ligacao em andamento
  let iceCache = null;
  let audioCtx = null;
  const recusadas = new Set();

  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const nativo = () => { try { return window.NexusNative || null; } catch (_) { return null; } };

  // ---------- Som (toque de chamada e "tuu... tuu...") ----------
  function ctx() {
    const A = window.AudioContext || window.webkitAudioContext;
    if (!A) return null;
    audioCtx = audioCtx || new A();
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return audioCtx;
  }
  document.addEventListener("pointerdown", () => ctx(), { passive: true });
  function tone(freqs, onMs, offMs) {
    let stop = false, timer = 0;
    const tick = () => {
      if (stop) return;
      const c = ctx();
      if (c && c.state === "running") {
        const gain = c.createGain(); gain.gain.value = 0.18; gain.connect(c.destination);
        freqs.forEach((f) => {
          const o = c.createOscillator(); o.type = "sine"; o.frequency.value = f; o.connect(gain);
          o.start(); o.stop(c.currentTime + onMs / 1000);
        });
      }
      timer = setTimeout(tick, onMs + offMs);
    };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }
  const toqueRecebida = () => {
    const pararSom = tone([880, 1320], 700, 900);
    const vib = setInterval(() => { try { navigator.vibrate?.([600, 300, 600]); } catch (_) {} }, 1800);
    try { navigator.vibrate?.([600, 300, 600]); } catch (_) {}
    return () => { pararSom(); clearInterval(vib); try { navigator.vibrate?.(0); } catch (_) {} };
  };
  const toqueChamando = () => tone([425], 1000, 3000);

  // ---------- Servidor ----------
  async function api(opts, path, extra = {}) {
    const auth = opts.auth?.() || {};
    const r = await fetch(`${opts.backend}/api/rides/${encodeURIComponent(opts.rideId)}/call/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth.headers || {}) },
      body: JSON.stringify({ ...(auth.body || {}), callToken: watcher?.opts.rideId === opts.rideId ? watcher.token || "" : session?.token || "", ...extra }),
      cache: "no-store",
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || "Não consegui falar com o servidor agora.");
    if (d.callToken) { if (watcher?.opts.rideId === opts.rideId) watcher.token = d.callToken; if (session) session.token = d.callToken; }
    return d;
  }
  async function iceServers(backend) {
    if (iceCache) return iceCache;
    try {
      const r = await fetch(`${backend}/api/call-config`, { cache: "no-store" });
      const d = await r.json();
      if (Array.isArray(d.iceServers) && d.iceServers.length) iceCache = d.iceServers;
    } catch (_) {}
    return iceCache || [{ urls: ["stun:stun.l.google.com:19302"] }];
  }

  // ---------- Audio da ligacao ----------
  async function microfone() {
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) throw new Error("Este celular não faz ligação pelo navegador. Use o chat.");
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    } catch (_) {
      const app = nativo();
      throw new Error(app && typeof app.audioCallVersion !== "function"
        ? "Para ligar pelo app, atualize o Nexus MotoJÁ Motorista na Play Store."
        : "Libere o microfone para ligar pelo app (toque no cadeado ou nas configurações do app e permita o Microfone).");
    }
  }
  function esperarIce(pc, ms = 3500) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const fim = () => { pc.removeEventListener("icegatheringstatechange", ver); clearTimeout(t); resolve(); };
      const ver = () => { if (pc.iceGatheringState === "complete") fim(); };
      const t = setTimeout(fim, ms);
      pc.addEventListener("icegatheringstatechange", ver);
    });
  }
  async function novaConexao(opts, stream) {
    const pc = new RTCPeerConnection({ iceServers: await iceServers(opts.backend) });
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    pc.ontrack = (e) => { if (session?.pc === pc) { session.audio.srcObject = e.streams[0]; session.audio.play?.().catch(() => {}); } };
    pc.onconnectionstatechange = () => {
      if (session?.pc !== pc) return;
      if (pc.connectionState === "connected" && !session.inicioMs) { session.inicioMs = Date.now(); render(); }
      if (pc.connectionState === "failed") encerrar("A ligação caiu ou a internet está fraca. Tente de novo ou use o chat.", true);
    };
    return pc;
  }

  // ---------- Tela ----------
  function injectStyle() {
    if (document.getElementById("mjcall-style")) return;
    const s = document.createElement("style");
    s.id = "mjcall-style";
    s.textContent = `
      .mjcall{position:fixed;inset:0;z-index:2147483600;background:linear-gradient(180deg,#151a26,#07080d);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:space-between;padding:calc(48px + env(safe-area-inset-top,0px)) 24px calc(40px + env(safe-area-inset-bottom,0px));font-family:inherit;text-align:center}
      .mjcall .av{width:118px;height:118px;border-radius:50%;display:grid;place-items:center;font-size:52px;background:#232a38;border:3px solid #ff8a00;margin:18px auto 14px;box-shadow:0 0 0 12px rgba(255,138,0,.12)}
      .mjcall.tocando .av{animation:mjcallp 1.4s ease-out infinite}
      @keyframes mjcallp{0%{box-shadow:0 0 0 0 rgba(255,138,0,.45)}100%{box-shadow:0 0 0 34px rgba(255,138,0,0)}}
      .mjcall h2{margin:0;font-size:1.6rem}.mjcall p{margin:8px 0 0;color:#aeb6c4;font-size:.95rem}
      .mjcall .sec{font-size:.78rem;color:#7e8898;margin-top:14px}
      .mjcall .bts{display:flex;gap:38px;justify-content:center;align-items:flex-end}
      .mjcall .bt{display:flex;flex-direction:column;align-items:center;gap:8px;background:none;border:0;color:#dfe3ea;font:inherit;font-size:.8rem;box-shadow:none;cursor:pointer;padding:0}
      .mjcall .bt i{width:68px;height:68px;border-radius:50%;display:grid;place-items:center;font-style:normal;font-size:28px;background:#2a3140}
      .mjcall .bt.verde i{background:#1fbf5b}.mjcall .bt.vermelho i{background:#e5413a}.mjcall .bt.on i{background:#fff;color:#111}`;
    document.head.appendChild(s);
  }
  function tempo(ms) { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; }
  function render() {
    if (!session) return;
    injectStyle();
    let el = document.getElementById("mjcall");
    if (!el) { el = document.createElement("div"); el.id = "mjcall"; el.className = "mjcall"; document.body.appendChild(el); el.addEventListener("click", clique); }
    const s = session, nome = esc(s.opts.nomeOutro || (s.opts.voce === "cliente" ? "Motoboy" : "Cliente"));
    const fase = s.fase;
    el.classList.toggle("tocando", fase === "recebendo" || fase === "chamando");
    const status = fase === "recebendo" ? "Ligação pelo app MotoJá"
      : fase === "chamando" ? "Chamando..."
      : fase === "conectando" ? "Conectando..."
      : s.inicioMs ? tempo(Date.now() - s.inicioMs) : "Conectando...";
    const botoes = fase === "recebendo"
      ? `<button class="bt vermelho" data-mjcall="recusar"><i>✕</i>Recusar</button><button class="bt verde" data-mjcall="atender"><i>📞</i>Atender</button>`
      : `<button class="bt${s.mudo ? " on" : ""}" data-mjcall="mudo"><i>${s.mudo ? "🔇" : "🎙️"}</i>${s.mudo ? "Mudo" : "Microfone"}</button><button class="bt vermelho" data-mjcall="desligar"><i>📵</i>Desligar</button>`;
    el.innerHTML = `<div><div class="av">${s.opts.voce === "cliente" ? "🏍️" : "🙋"}</div><h2>${nome}</h2><p data-mjcall-status>${status}</p><div class="sec">🔒 Ligação pelo app · ninguém vê o seu número</div></div><div class="bts">${botoes}</div>`;
  }
  function tick() {
    if (!session) return;
    const st = document.querySelector("[data-mjcall-status]");
    if (st && session.fase === "em_ligacao" && session.inicioMs) st.textContent = tempo(Date.now() - session.inicioMs);
  }
  function aviso(texto) {
    injectStyle();
    const t = document.createElement("div");
    t.style.cssText = "position:fixed;left:16px;right:16px;bottom:calc(24px + env(safe-area-inset-bottom,0px));z-index:2147483601;background:#232a38;color:#fff;border:1px solid rgba(255,154,0,.5);border-radius:14px;padding:13px 16px;font-weight:700;text-align:center;font-family:inherit;box-shadow:0 12px 30px rgba(0,0,0,.45)";
    t.textContent = texto;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4500);
  }

  function limpar() {
    if (!session) return;
    const s = session;
    session = null;
    s.pararSom?.();
    clearInterval(s.relogio); clearTimeout(s.pollTimer);
    try { s.pc?.close(); } catch (_) {}
    s.stream?.getTracks().forEach((t) => t.stop());
    s.audio?.remove();
    document.getElementById("mjcall")?.remove();
    agendarWatch(WATCH_MS);
  }
  async function encerrar(mensagem, avisarServidor) {
    const s = session;
    if (!s) return;
    if (avisarServidor && s.callId) api(s.opts, "end", { callId: s.callId }).catch(() => {});
    limpar();
    if (mensagem) aviso(mensagem);
  }
  const MOTIVOS = { recusada: "A ligação foi recusada.", sem_resposta: "Não atendeu. Tente de novo ou mande mensagem no chat.", cancelada: "Ligação cancelada.", encerrada: "Ligação encerrada.", tempo_maximo: "Ligação encerrada.", ocupado: "Está em outra ligação." };

  // Durante a ligacao: espera atender (quem liga) ou o outro desligar.
  async function acompanhar() {
    const s = session;
    if (!s) return;
    try {
      const d = await api(s.opts, "state");
      if (session !== s) return;
      const c = d.call;
      if (!c || c.id !== s.callId || c.status === "encerrada") {
        const quem = c?.motivo === "recusada" && s.fase !== "chamando" ? "encerrada" : c?.motivo;
        return encerrar(MOTIVOS[quem] || "Ligação encerrada.", false);
      }
      if (s.fase === "chamando" && c.status === "atendida" && c.answer) {
        s.pararSom?.(); s.pararSom = null;
        s.fase = "em_ligacao";
        await s.pc.setRemoteDescription(c.answer);
        render();
      }
    } catch (_) {}
    if (session === s) s.pollTimer = setTimeout(acompanhar, ACTIVE_MS);
  }

  async function atender() {
    const s = session;
    if (!s || s.fase !== "recebendo") return;
    s.pararSom?.(); s.pararSom = null;
    s.fase = "conectando"; render();
    try {
      s.stream = await microfone();
      s.pc = await novaConexao(s.opts, s.stream);
      await s.pc.setRemoteDescription(s.offer);
      await s.pc.setLocalDescription(await s.pc.createAnswer());
      await esperarIce(s.pc);
      if (session !== s) return;
      await api(s.opts, "answer", { callId: s.callId, answer: s.pc.localDescription });
      s.fase = "em_ligacao"; render();
      clearTimeout(s.pollTimer); acompanhar();
    } catch (error) {
      if (session === s) encerrar(error.message, true);
    }
  }

  function clique(e) {
    const acao = e.target.closest("[data-mjcall]")?.dataset.mjcall;
    if (!acao || !session) return;
    if (acao === "atender") atender();
    else if (acao === "recusar") { recusadas.add(session.callId); encerrar("", true); }
    else if (acao === "desligar") encerrar(session.fase === "chamando" ? "Ligação cancelada." : "Ligação encerrada.", true);
    else if (acao === "mudo") {
      session.mudo = !session.mudo;
      session.stream?.getAudioTracks().forEach((t) => { t.enabled = !session.mudo; });
      render();
    }
  }

  function novaSessao(opts, extra) {
    const audio = document.createElement("audio");
    audio.autoplay = true; audio.setAttribute("playsinline", "");
    audio.style.display = "none";
    document.body.appendChild(audio);
    session = { opts, audio, mudo: false, inicioMs: 0, token: watcher?.token || "", ...extra };
    session.relogio = setInterval(tick, 1000);
    clearTimeout(watcher?.timer);
    render();
  }

  // ---------- Ligar ----------
  async function call(opts) {
    if (!opts?.rideId) return;
    if (session) return aviso("Já tem uma ligação aberta.");
    watch(opts);
    novaSessao(opts, { fase: "conectando" });
    const s = session;
    try {
      s.stream = await microfone();
      s.pc = await novaConexao(opts, s.stream);
      await s.pc.setLocalDescription(await s.pc.createOffer({ offerToReceiveAudio: true }));
      await esperarIce(s.pc);
      if (session !== s) return;
      const d = await api(opts, "start", { offer: s.pc.localDescription });
      if (session !== s) return;
      s.callId = d.call?.id;
      s.fase = "chamando";
      s.pararSom = toqueChamando();
      render();
      acompanhar();
    } catch (error) {
      if (session === s) encerrar(error.message, !!s.callId);
    }
  }

  // ---------- Escutar ligacao recebida ----------
  function agendarWatch(ms) {
    if (!watcher) return;
    clearTimeout(watcher.timer);
    watcher.timer = setTimeout(verificar, ms);
  }
  async function verificar() {
    const w = watcher;
    if (!w || session) return;
    try {
      const d = await api(w.opts, "state");
      if (watcher !== w || session) return;
      const c = d.call;
      if (c && c.status === "chamando" && !c.souEu && c.offer && !recusadas.has(c.id)) {
        novaSessao(w.opts, { fase: "recebendo", callId: c.id, offer: c.offer });
        session.pararSom = toqueRecebida();
        acompanharRecebendo();
        return;
      }
    } catch (_) {}
    agendarWatch(document.visibilityState === "visible" ? WATCH_MS : WATCH_MS * 3);
  }
  // Tocando: se quem ligou desistir (ou passar o tempo), some a tela.
  async function acompanharRecebendo() {
    const s = session;
    if (!s || s.fase !== "recebendo") return;
    try {
      const d = await api(s.opts, "state");
      if (session !== s || s.fase !== "recebendo") return;
      if (!d.call || d.call.id !== s.callId || d.call.status !== "chamando") return encerrar("Ligação perdida.", false);
    } catch (_) {}
    if (session === s && s.fase === "recebendo") s.pollTimer = setTimeout(acompanharRecebendo, ACTIVE_MS * 2);
  }

  function watch(opts) {
    if (!opts?.rideId || !opts.backend || !opts.auth) return;
    if (watcher?.opts.rideId === opts.rideId) { watcher.opts = { ...watcher.opts, ...opts }; return; }
    unwatch();
    watcher = { opts, timer: 0, token: "" };
    agendarWatch(300);
  }
  function unwatch(rideId) {
    if (!watcher || (rideId && watcher.opts.rideId !== rideId)) return;
    clearTimeout(watcher.timer);
    watcher = null;
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && watcher && !session) agendarWatch(200); });

  window.MotojaRideCall = { call, watch, unwatch, ativa: () => !!session, vigiando: () => watcher?.opts.rideId || "" };
})();
