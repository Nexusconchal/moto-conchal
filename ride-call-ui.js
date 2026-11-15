// Ligacao de voz pelo app MotoJa, igual ligacao do WhatsApp: o audio vai pela internet,
// direto entre os celulares, e ninguem ve o numero do outro.
// Corrida: cliente <-> motoboy (tipo "corrida", padrao). Entrega: loja <-> motoboy (tipo "entrega").
// Uso:
//   MotojaRideCall.watch({ tipo, rideId, backend, auth, voce, nomeOutro })  // escuta ligacao recebida
//   MotojaRideCall.call({ tipo, rideId, backend, auth, voce, nomeOutro })   // liga para o outro lado
//   MotojaRideCall.ring(opts, { callId })   // aviso que chegou por fora (socket da loja): toca na hora
//   MotojaRideCall.vigiarSo("entrega", [opts, ...])  // escuta so estas entregas (tira as outras)
//   MotojaRideCall.unwatch(rideId | { tipo } | nada)
// auth() devolve { headers, body } (o mesmo do chat).
// Economia do banco: depois da primeira conferida, o servidor responde pela memoria (ficha curta).
(function () {
  "use strict";
  const WATCH_MS = 3000, ACTIVE_MS = 1200;
  const alvos = new Map();  // "tipo:id" -> { chave, opts, timer, token }
  let session = null;       // ligacao em andamento
  let iceCache = null;
  let audioCtx = null;
  const recusadas = new Set();

  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const nativo = () => { try { return window.NexusNative || null; } catch (_) { return null; } };
  const tipoDe = (opts) => (opts?.tipo === "entrega" ? "entrega" : "corrida");
  const chaveDe = (opts) => `${tipoDe(opts)}:${opts?.rideId || ""}`;
  const base = (opts) => `${opts.backend}/api/${tipoDe(opts) === "entrega" ? "deliveries" : "rides"}/${encodeURIComponent(opts.rideId)}/call/`;

  // ---------- Som ----------
  function ctx() {
    const A = window.AudioContext || window.webkitAudioContext;
    if (!A) return null;
    audioCtx = audioCtx || new A();
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return audioCtx;
  }
  document.addEventListener("pointerdown", () => ctx(), { passive: true });
  document.addEventListener("keydown", () => ctx(), { passive: true });

  // Nota com cara de marimba (toque de celular): ataque rapido e decaimento.
  function nota(c, freq, at, dur, volume) {
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(volume, at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    g.connect(c.destination);
    [[1, "sine", 1], [2, "sine", 0.3], [3.01, "triangle", 0.12]].forEach(([mult, type, vol]) => {
      const o = c.createOscillator();
      const gg = c.createGain();
      o.type = type; o.frequency.value = freq * mult; gg.gain.value = vol;
      o.connect(gg).connect(g);
      o.start(at); o.stop(at + dur + 0.05);
    });
  }
  function repetir(tocar, cadaMs) {
    let stop = false, timer = 0;
    const tick = () => {
      if (stop) return;
      const c = ctx();
      if (c && c.state === "running") tocar(c, c.currentTime + 0.03);
      timer = setTimeout(tick, cadaMs);
    };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }
  // Recebendo: duas frases curtas e alegres, pausa e repete (como toque de ligacao).
  const FRASE = [[659.3, 0], [784, 0.15], [987.8, 0.3], [784, 0.45], [659.3, 0.75], [784, 0.9], [987.8, 1.05], [1318.5, 1.2]];
  const toqueRecebida = () => {
    const pararSom = repetir((c, t0) => FRASE.forEach(([f, t]) => nota(c, f, t0 + t, 0.45, 0.55)), 2600);
    const vibrar = () => { try { navigator.vibrate?.([800, 400, 800]); } catch (_) {} };
    vibrar();
    const vib = setInterval(vibrar, 2600);
    return () => { pararSom(); clearInterval(vib); try { navigator.vibrate?.(0); } catch (_) {} };
  };
  // Chamando: "tuu... tuu..." (425 Hz, 1 s tocando e 4 s parado, padrao do Brasil).
  const toqueChamando = () => repetir((c, t0) => {
    const g = c.createGain(); g.gain.value = 0.16; g.connect(c.destination);
    const o = c.createOscillator(); o.type = "sine"; o.frequency.value = 425; o.connect(g);
    o.start(t0); o.stop(t0 + 1);
  }, 5000);

  // Ligacao chegando com a tela em outra aba/app: pisca o titulo e mostra notificacao.
  function chamarAtencao(nome) {
    let tituloOriginal = document.title, alterna = false;
    const piscar = setInterval(() => { alterna = !alterna; document.title = alterna ? `📞 ${nome} ligando...` : tituloOriginal; }, 900);
    let aviso = null;
    try {
      if (document.visibilityState !== "visible" && "Notification" in window && Notification.permission === "granted") {
        aviso = new Notification(`📞 ${nome} está ligando`, { body: "Ligação pelo app MotoJá. Toque para atender.", tag: "motoja-ligacao", requireInteraction: true });
        aviso.onclick = () => { try { window.focus(); } catch (_) {} aviso?.close(); };
      }
    } catch (_) {}
    return () => { clearInterval(piscar); document.title = tituloOriginal; try { aviso?.close(); } catch (_) {} };
  }

  // ---------- Servidor ----------
  async function api(opts, path, extra = {}) {
    const chave = chaveDe(opts);
    const alvo = alvos.get(chave);
    const token = (session?.chave === chave && session.token) || alvo?.token || "";
    const auth = opts.auth?.() || {};
    const r = await fetch(base(opts) + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth.headers || {}) },
      body: JSON.stringify({ ...(auth.body || {}), callToken: token, ...extra }),
      cache: "no-store",
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.message || "Não consegui falar com o servidor agora."), { status: r.status });
    if (d.callToken) {
      if (alvos.get(chave)) alvos.get(chave).token = d.callToken;
      if (session?.chave === chave) session.token = d.callToken;
    }
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
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) throw new Error("Este aparelho não faz ligação pelo navegador. Use o chat.");
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    } catch (_) {
      const app = nativo();
      throw new Error(app && typeof app.audioCallVersion !== "function"
        ? "Para ligar pelo app, atualize o Nexus MotoJÁ Motorista na Play Store."
        : "Libere o microfone para ligar pelo app (toque no cadeado do navegador ou nas configurações do app e permita o Microfone).");
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
      .mjcall{position:fixed;inset:0;z-index:2147483600;background:linear-gradient(180deg,#0f5132 0%,#0b3d26 38%,#07120d 100%);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:space-between;padding:calc(48px + env(safe-area-inset-top,0px)) 24px calc(40px + env(safe-area-inset-bottom,0px));font-family:inherit;text-align:center}
      .mjcall .tp{font-size:.82rem;letter-spacing:.06em;color:#c9f0d8;font-weight:700}
      .mjcall .av{width:124px;height:124px;border-radius:50%;display:grid;place-items:center;font-size:56px;background:#1c2a22;border:3px solid #25d366;margin:20px auto 14px;box-shadow:0 0 0 12px rgba(37,211,102,.14)}
      .mjcall.tocando .av{animation:mjcallp 1.3s ease-out infinite}
      @keyframes mjcallp{0%{box-shadow:0 0 0 0 rgba(37,211,102,.55)}100%{box-shadow:0 0 0 38px rgba(37,211,102,0)}}
      .mjcall h2{margin:0;font-size:1.7rem;color:#fff}.mjcall p{margin:8px 0 0;color:#c4d6cb;font-size:1rem}
      .mjcall .sec{font-size:.78rem;color:#8fb3a0;margin-top:14px}
      .mjcall .bts{display:flex;gap:46px;justify-content:center;align-items:flex-end}
      .mjcall .bt{display:flex;flex-direction:column;align-items:center;gap:8px;background:none;border:0;color:#e3efe8;font:inherit;font-size:.82rem;box-shadow:none;cursor:pointer;padding:0;min-height:0;width:auto}
      .mjcall .bt i{width:70px;height:70px;border-radius:50%;display:grid;place-items:center;font-style:normal;font-size:28px;background:rgba(255,255,255,.14)}
      .mjcall .bt.verde i{background:#25d366}.mjcall .bt.vermelho i{background:#e5413a}.mjcall .bt.on i{background:#fff;color:#111}
      .mjcall.tocando .bt.verde i{animation:mjcallb 1s ease-in-out infinite}
      @keyframes mjcallb{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
      @media (min-width:760px){.mjcall{inset:auto;left:50%;top:50%;transform:translate(-50%,-50%);width:400px;height:640px;max-height:92vh;border-radius:28px;box-shadow:0 30px 90px rgba(0,0,0,.6),0 0 0 9999px rgba(0,0,0,.45)}}`;
    document.head.appendChild(s);
  }
  function tempo(ms) { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; }
  function avatarDe(opts) {
    if (opts.avatar) return opts.avatar;
    if (opts.voce === "motoboy") return tipoDe(opts) === "entrega" ? "🏪" : "🙋";
    return "🏍️";
  }
  function render() {
    if (!session) return;
    injectStyle();
    let el = document.getElementById("mjcall");
    if (!el) { el = document.createElement("div"); el.id = "mjcall"; el.className = "mjcall"; document.body.appendChild(el); el.addEventListener("click", clique); }
    const s = session, nome = esc(s.opts.nomeOutro || (s.opts.voce === "motoboy" ? (tipoDe(s.opts) === "entrega" ? "Loja" : "Cliente") : "Motoboy"));
    const fase = s.fase;
    el.classList.toggle("tocando", fase === "recebendo" || fase === "chamando");
    const status = fase === "recebendo" ? "está te ligando..."
      : fase === "chamando" ? "Chamando..."
      : fase === "conectando" ? "Conectando..."
      : s.inicioMs ? tempo(Date.now() - s.inicioMs) : "Conectando...";
    const botoes = fase === "recebendo"
      ? `<button type="button" class="bt vermelho" data-mjcall="recusar"><i>✕</i>Recusar</button><button type="button" class="bt verde" data-mjcall="atender"><i>📞</i>Atender</button>`
      : `<button type="button" class="bt${s.mudo ? " on" : ""}" data-mjcall="mudo"><i>${s.mudo ? "🔇" : "🎙️"}</i>${s.mudo ? "Mudo" : "Microfone"}</button><button type="button" class="bt vermelho" data-mjcall="desligar"><i>📵</i>Desligar</button>`;
    el.innerHTML = `<div><div class="tp">🔒 LIGAÇÃO PELO APP MOTOJÁ</div><div class="av">${esc(avatarDe(s.opts))}</div><h2>${nome}</h2><p data-mjcall-status>${status}</p><div class="sec">Ninguém vê o seu número${tipoDe(s.opts) === "entrega" ? " · ligação da entrega" : ""}</div></div><div class="bts">${botoes}</div>`;
  }
  function tick() {
    if (!session) return;
    const st = document.querySelector("[data-mjcall-status]");
    if (st && session.fase === "em_ligacao" && session.inicioMs) st.textContent = tempo(Date.now() - session.inicioMs);
  }
  function aviso(texto) {
    injectStyle();
    const t = document.createElement("div");
    t.style.cssText = "position:fixed;left:16px;right:16px;bottom:calc(24px + env(safe-area-inset-bottom,0px));z-index:2147483601;background:#232a38;color:#fff;border:1px solid rgba(255,154,0,.5);border-radius:14px;padding:13px 16px;font-weight:700;text-align:center;font-family:inherit;box-shadow:0 12px 30px rgba(0,0,0,.45);max-width:520px;margin:0 auto";
    t.textContent = texto;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4500);
  }

  function limpar() {
    if (!session) return;
    const s = session;
    session = null;
    s.pararSom?.();
    s.pararAtencao?.();
    clearInterval(s.relogio); clearTimeout(s.pollTimer);
    try { s.pc?.close(); } catch (_) {}
    s.stream?.getTracks().forEach((t) => t.stop());
    s.audio?.remove();
    document.getElementById("mjcall")?.remove();
    try { window.MotojaTelaAcesa?.desligar("ligacao"); } catch (_) {}
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
    s.pararAtencao?.(); s.pararAtencao = null;
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
    const chave = chaveDe(opts);
    session = { opts, chave, audio, mudo: false, inicioMs: 0, token: alvos.get(chave)?.token || "", ...extra };
    session.relogio = setInterval(tick, 1000);
    try { window.MotojaTelaAcesa?.ligar("ligacao"); } catch (_) {}
    render();
  }

  // ---------- Ligar ----------
  async function call(opts) {
    if (!opts?.rideId) return;
    if (session) return aviso("Já tem uma ligação aberta.");
    if (opts.vigiar !== false) watch(opts);
    ctx();
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

  // ---------- Receber ----------
  function receber(opts, c) {
    if (session || !c?.offer || recusadas.has(c.id)) return;
    novaSessao(opts, { fase: "recebendo", callId: c.id, offer: c.offer });
    session.pararSom = toqueRecebida();
    session.pararAtencao = chamarAtencao(opts.nomeOutro || "Ligação");
    acompanharRecebendo();
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
  // Aviso que chegou por fora (socket do painel da loja ou a conferida geral): toca na hora.
  async function ring(opts, info = {}) {
    if (!opts?.rideId || session || (info.callId && recusadas.has(info.callId))) return;
    try {
      const d = await api(opts, "state");
      const c = d.call;
      if (c && c.status === "chamando" && !c.souEu) receber(opts, c);
    } catch (_) {}
  }

  // ---------- Escutar ligacao recebida (cada entrega/corrida vigiada) ----------
  function agendar(alvo, ms) {
    clearTimeout(alvo.timer);
    alvo.timer = setTimeout(() => verificar(alvo), ms);
  }
  async function verificar(alvo) {
    if (alvos.get(alvo.chave) !== alvo) return;
    if (session) return agendar(alvo, WATCH_MS * 2);
    try {
      const d = await api(alvo.opts, "state");
      if (alvos.get(alvo.chave) !== alvo) return;
      // Entrega ja encerrada: para de conferir.
      if (d.encerrada) return remover(alvo.chave);
      const c = d.call;
      if (!session && c && c.status === "chamando" && !c.souEu && c.offer && !recusadas.has(c.id)) receber(alvo.opts, c);
    } catch (error) {
      // Sem acesso (nao e mais desta pessoa) ou nao existe: para, para nao gastar o servidor.
      if ([401, 403, 404].includes(error.status)) return remover(alvo.chave);
    }
    agendar(alvo, document.visibilityState === "visible" ? WATCH_MS : WATCH_MS * 3);
  }
  function remover(chave) {
    const alvo = alvos.get(chave);
    if (!alvo) return;
    clearTimeout(alvo.timer);
    alvos.delete(chave);
  }
  function watch(opts) {
    if (!opts?.rideId || !opts.backend || !opts.auth) return;
    const chave = chaveDe(opts);
    const atual = alvos.get(chave);
    if (atual) { atual.opts = { ...atual.opts, ...opts }; return; }
    // Corrida: uma por vez (a nova substitui a anterior), como sempre foi.
    if (tipoDe(opts) === "corrida") unwatch({ tipo: "corrida" });
    const alvo = { chave, opts, timer: 0, token: "" };
    alvos.set(chave, alvo);
    agendar(alvo, 300);
  }
  function unwatch(filtro) {
    for (const [chave, alvo] of [...alvos]) {
      if (filtro === undefined
        || (typeof filtro === "string" && alvo.opts.rideId === filtro)
        || (filtro && typeof filtro === "object" && tipoDe(alvo.opts) === tipoDe(filtro))) remover(chave);
    }
  }
  // Deixa vigiando exatamente estas (ex.: as entregas em andamento do motoboy).
  function vigiarSo(tipo, lista) {
    const quero = new Set((lista || []).filter((o) => o?.rideId).map((o) => chaveDe({ ...o, tipo })));
    for (const [chave, alvo] of [...alvos]) if (tipoDe(alvo.opts) === tipoDe({ tipo }) && !quero.has(chave)) remover(chave);
    (lista || []).forEach((o) => o?.rideId && watch({ ...o, tipo }));
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !session) alvos.forEach((alvo) => agendar(alvo, 200));
  });

  window.MotojaRideCall = { call, watch, unwatch, ring, vigiarSo, ativa: () => !!session, vigiando: () => [...alvos.keys()] };
})();
