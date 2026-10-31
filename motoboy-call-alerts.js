(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MotojaCallAlerts = api.browser(root);
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const key = offer => `${offer.kind}:${offer.id}`;
  const valid = offer => ['rides', 'deliveries'].includes(offer?.kind) && /^[a-zA-Z0-9_-]{1,120}$/.test(offer.id || '');

  function createController({ output, fetcher, setTimer = setInterval, clearTimer = clearInterval, now = Date.now }) {
    let options, timer, generation = 0, busy = false;
    const offers = new Map();
    const enabled = () => !!options && options.canAlert() === true;
    function paint() {
      for (const [id, offer] of offers) if (offer.expiresAtMs <= now()) offers.delete(id);
      output.update(enabled() ? [...offers.values()] : []);
    }
    async function verify() {
      if (output.native) { paint(); return; }
      if (!enabled() || !offers.size || busy) { paint(); return; }
      const epoch = generation, snapshot = new Map(offers), session = options;
      busy = true;
      try {
        const response = await fetcher(`${session.backend}/api/drivers/${session.getProof().driverCpf}/call-alerts`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store',
          signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
          body: JSON.stringify({ ...session.getProof(), offers: [...snapshot.values()].map(({ kind, id }) => ({ kind, id })) })
        });
        if (epoch !== generation || session !== options) return;
        if (!response.ok) {
          if ([401, 403].includes(response.status)) { generation++; clearTimer(timer); options = null; offers.clear(); output.session(null); }
          paint(); return;
        }
        const data = await response.json();
        if (epoch !== generation || !enabled()) return;
        const active = new Map((data.available ? data.offers : []).filter(valid).map(o => [key(o), o]));
        for (const [id, original] of snapshot) {
          if (offers.get(id) !== original) continue;
          if (!active.has(id)) offers.delete(id);
          else offers.set(id, active.get(id));
        }
        paint();
      } catch { if (epoch === generation) paint(); }
      finally { if (epoch === generation) busy = false; }
    }
    return {
      start(config) {
        this.stop(); options = config; output.session({ ...config.getProof(), backend: config.backend });
        timer = setTimer(verify, 3000);
      },
      jobs(detail) {
        if (!options || detail?.scope !== 'pending' || !['all', 'rides', 'deliveries'].includes(detail.kind)) return;
        for (const [id, offer] of offers) if (detail.kind === 'all' || offer.kind === detail.kind) offers.delete(id);
        for (const job of detail.jobs || []) {
          const kind = job.__kind || detail.kind;
          const offer = { kind, id: job.id, expiresAtMs: Number(job.expiraEmMs) || Number(job.criadaEm?.seconds || 0) * 1000 + (kind === 'deliveries' ? 15 : 10) * 60000 };
          if (valid(offer) && job.status === 'pendente' && !job.motoboyExclusivoCpf && job.tipo !== 'servico_exclusivo' && offer.expiresAtMs > now()) offers.set(key(offer), offer);
        }
        paint(); verify();
      },
      changed(detail) {
        if (valid(detail) && detail.status !== 'pendente') offers.delete(key(detail));
        paint(); verify();
      },
      refresh() { output.preference(enabled()); paint(); verify(); },
      stop() {
        generation++; clearTimer(timer); timer = null; busy = false; options = null; offers.clear();
        output.update([]); output.session(null);
      }
    };
  }

  function browser(env) {
    let context, buffer, loading, source, vibration, wanted = false, playEpoch = 0, native = false, nativeSnapshot = null;
    const soundUrl = new URL('./audio/motoja-bora-rodar-v1.wav', env.location.href).href;
    const bridge = () => env.NexusNative;
    function stopWeb() {
      playEpoch++; wanted = false;
      if (source) { try { source.stop(); } catch {} source = null; }
      env.clearInterval(vibration); vibration = null;
      try { env.navigator.vibrate?.(0); } catch {}
    }
    async function playWeb() {
      wanted = true;
      if (source || !context || context.state !== 'running') return;
      const epoch = ++playEpoch;
      try {
        if (!loading) loading = env.fetch(soundUrl).then(r => {
          if (!r.ok) throw new Error('audio_indisponivel');
          return r.arrayBuffer();
        }).then(bytes => context.decodeAudioData(bytes)).then(value => { buffer = value; })
          .catch(error => { loading = null; throw error; });
        await loading;
        if (!wanted || native || epoch !== playEpoch || context.state !== 'running') return;
        const current = context.createBufferSource();
        current.buffer = buffer; current.loop = true; current.connect(context.destination);
        current.onended = () => { current.disconnect(); if (source === current) source = null; };
        current.start(); source = current;
        const vibrate = () => { try { env.navigator.vibrate?.([500, 180, 500, 900]); } catch {} };
        vibrate(); vibration = env.setInterval(vibrate, 2080);
      } catch { /* Novo gesto ou próxima consulta pode tentar carregar o arquivo novamente. */ }
    }
    function unlock() {
      if (native) return;
      const Audio = env.AudioContext || env.webkitAudioContext;
      if (!Audio) return;
      context ||= new Audio();
      context.resume().then(() => { if (wanted) playWeb(); }).catch(() => {});
    }
    const output = {
      get native() { return native; },
      session(proof) {
        nativeSnapshot = null;
        try {
          native = !!proof && Number(bridge()?.callAlertVersion?.()) === 1 && bridge().setCallAlertSession(JSON.stringify({ driverCpf: proof.driverCpf, driverToken: proof.driverToken, backend: proof.backend })) === true;
          if (!proof) bridge()?.clearCallAlerts?.();
          if (native) stopWeb();
          else if (proof && env.Capacitor?.isNativePlatform?.()) unlock();
        } catch { native = false; }
      },
      preference(enabled) { if (native) { try { bridge().setCallAlertEnabled(enabled); } catch {} } },
      update(offers) {
        if (native) {
          stopWeb(); const json = JSON.stringify(offers);
          if (json !== nativeSnapshot) { try { bridge().setCallAlertOffers(json); nativeSnapshot = json; } catch {} }
        } else if (offers.length) playWeb();
        else stopWeb();
      }
    };
    const controller = createController({ output, fetcher: (...args) => env.fetch(...args) });
    ['pointerdown', 'keydown'].forEach(event => env.document.addEventListener(event, unlock, { passive: true }));
    env.addEventListener('motoja:jobs-rendered', event => controller.jobs(event.detail));
    env.addEventListener('motoja:call-alert-changed', event => controller.changed(event.detail));
    env.addEventListener('motoja:availability-changed', () => controller.refresh());
    env.addEventListener('pagehide', () => { if (!native) stopWeb(); });
    return controller;
  }
  return { createController, browser };
});
