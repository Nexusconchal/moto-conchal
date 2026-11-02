// Mantem a tela do motoboy acesa enquanto ele roda com o GPS do app (como o Google Maps faz).
// Uso: MotojaTelaAcesa.ligar("nav") / MotojaTelaAcesa.desligar("nav"). Fica acesa enquanto
// existir pelo menos um motivo ligado.
// 1) App Android (WebView): NexusNative.keepScreenOn -> FLAG_KEEP_SCREEN_ON da janela.
// 2) Navegador/PWA: Screen Wake Lock (navigator.wakeLock), pedido de novo ao voltar pro app.
// 3) Reserva: video preto mudo em loop (o navegador nao apaga a tela com video tocando).
(function () {
  "use strict";
  const motivos = new Set();
  let trava = null, pedindo = false, video = null;

  const nativo = () => {
    try { return typeof window.NexusNative?.keepScreenOn === "function" ? window.NexusNative : null; } catch (_) { return null; }
  };
  const ativa = () => motivos.size > 0;

  async function pedirWakeLock() {
    if (!ativa() || trava || pedindo || document.visibilityState !== "visible" || !navigator.wakeLock?.request) return !!trava;
    pedindo = true;
    try {
      trava = await navigator.wakeLock.request("screen");
      trava.addEventListener?.("release", () => { trava = null; });
      if (!ativa()) soltarWakeLock();
      return true;
    } catch (_) {
      trava = null;
      return false;
    } finally {
      pedindo = false;
    }
  }
  function soltarWakeLock() {
    const t = trava;
    trava = null;
    try { t?.release?.(); } catch (_) {}
  }

  function criarVideo() {
    if (video) return video;
    video = document.createElement("video");
    video.setAttribute("playsinline", "");
    video.setAttribute("muted", "");
    video.setAttribute("aria-hidden", "true");
    video.muted = true;
    video.loop = true;
    video.preload = "auto";
    // Tela inteira e transparente: o navegador so segura a tela com o video "visivel".
    video.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;opacity:0.01;pointer-events:none;z-index:-1;object-fit:cover";
    for (const [src, type] of [["./motoboy-tela-acesa.webm", "video/webm"], ["./motoboy-tela-acesa.mp4", "video/mp4"]]) {
      const s = document.createElement("source");
      s.src = src;
      s.type = type;
      video.appendChild(s);
    }
    document.body.appendChild(video);
    return video;
  }
  function tocarVideo() {
    if (!ativa() || document.visibilityState !== "visible" || !document.body) return;
    const v = criarVideo();
    if (v.paused) v.play().catch(() => {});
  }
  function pararVideo() {
    if (video && !video.paused) video.pause();
  }

  async function aplicar() {
    const app = nativo();
    if (app) {
      try { app.keepScreenOn(ativa()); } catch (_) {}
      return;
    }
    if (!ativa()) {
      soltarWakeLock();
      pararVideo();
      return;
    }
    if (await pedirWakeLock()) pararVideo();
    else tocarVideo();
  }

  function ligar(motivo = "geral") {
    const antes = motivos.size;
    motivos.add(motivo);
    if (!antes || (!trava && !nativo())) aplicar();
  }
  function desligar(motivo = "geral") {
    if (!motivos.delete(motivo)) return;
    if (!motivos.size) aplicar();
  }

  // O Android solta o wake lock quando o app vai pro fundo; ao voltar, pede de novo.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && ativa()) aplicar();
  });
  // Sem permissao de tocar video sozinho, o primeiro toque na tela libera.
  document.addEventListener("pointerdown", () => {
    if (ativa() && !trava && !nativo()) aplicar();
  }, { passive: true });

  window.MotojaTelaAcesa = { ligar, desligar, ativa, motivos: () => [...motivos] };
})();
