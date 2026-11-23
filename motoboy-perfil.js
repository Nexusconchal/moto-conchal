// Perfil do motoboy: foto, dados, moto e o botao SOS. Antes "Editar cadastro" abria o cadastro
// inteiro de novo (e o motoboy achava que estava se cadastrando outra vez).
// motoboy.html chama MotoPerfil.iniciar(opcoes) e MotoPerfil.render().
(function () {
  'use strict';

  const SEGURAR_MS = 3000;
  const SUPORTE = 'https://api.whatsapp.com/send?phone=5519992306488&text=';
  let o = null;
  let segurarTimer = null;
  let sosAberto = false;

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const digitos = (v) => String(v || '').replace(/\D/g, '');
  const telefone = (v) => { const d = digitos(v); return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d.length === 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : d || '-'; };
  const escondido = (v, mostra = 2) => { const d = digitos(v); return d ? `${'•'.repeat(Math.max(0, d.length - mostra))}${d.slice(-mostra)}` : '-'; };

  // ---------- Janela de baixo (foto, dados, moto, SOS) ----------

  function folha() {
    let ov = document.getElementById('mjp-ov');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'mjp-ov';
      ov.className = 'mjp-ov';
      ov.hidden = true;
      ov.innerHTML = '<div class="mjp-folha" role="dialog" aria-modal="true"><div class="mjp-grab"></div><div data-mjp-corpo></div></div>';
      ov.addEventListener('click', (event) => { if (event.target === ov && !sosAberto) fechar(); });
      document.body.append(ov);
    }
    return ov;
  }
  function abrir(html) {
    const ov = folha();
    ov.querySelector('[data-mjp-corpo]').innerHTML = html;
    ov.hidden = false;
    document.body.classList.add('mjp-travado');
    ov.querySelectorAll('[data-mjp-fechar]').forEach((b) => { b.onclick = fechar; });
    return ov;
  }
  function fechar() {
    const ov = document.getElementById('mjp-ov');
    if (ov) ov.hidden = true;
    sosAberto = false;
    document.body.classList.remove('mjp-travado');
  }
  function aviso(texto, erro = false) {
    const t = document.createElement('div');
    t.className = `mjp-toast${erro ? ' erro' : ''}`;
    t.textContent = texto;
    document.body.append(t);
    setTimeout(() => t.remove(), 3200);
  }

  async function salvar(corpo) {
    const proof = o.getProof();
    const r = await fetch(`${o.backend}/api/drivers/${proof.driverCpf}/perfil`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...proof, ...corpo }),
      cache: 'no-store'
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || 'Não consegui salvar agora. Tente de novo.');
    o.salvarDados?.(d);
    render();
    return d;
  }

  // ---------- Trocar foto ----------

  function abrirFoto() {
    const atual = o.dados().foto;
    const ov = abrir(`<h3>Trocar foto de perfil</h3>
      <div class="mjp-prev" data-mjp-prev>${atual ? `<img src="${esc(atual)}" alt="">` : '<span>📷</span>'}</div>
      <p class="mjp-dica">É a foto que o cliente vê antes de você chegar.<br>Rosto à mostra, sem capacete e sem óculos escuros.</p>
      <div class="mjp-botoes">
        <label class="mjp-bt">📷 Tirar foto<input type="file" accept="image/*" capture="user" hidden data-mjp-arquivo></label>
        <label class="mjp-bt">🖼️ Da galeria<input type="file" accept="image/*" hidden data-mjp-arquivo></label>
        <button type="button" class="mjp-bt pri" data-mjp-salvar disabled>Salvar foto</button>
      </div>
      <button type="button" class="mjp-cancelar" data-mjp-fechar>Cancelar</button>`);
    let nova = '';
    const salvarBt = ov.querySelector('[data-mjp-salvar]');
    ov.querySelectorAll('[data-mjp-arquivo]').forEach((input) => {
      input.onchange = async () => {
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        try {
          nova = await o.comprimirFoto(file);
          ov.querySelector('[data-mjp-prev]').innerHTML = `<img src="${esc(nova)}" alt="Foto nova">`;
          salvarBt.disabled = false;
        } catch (error) {
          aviso(error.message || 'Não consegui usar essa foto.', true);
        }
      };
    });
    salvarBt.onclick = async () => {
      if (!nova) return;
      salvarBt.disabled = true;
      salvarBt.textContent = 'Salvando...';
      try {
        await salvar({ fotoMotoboy: nova });
        fechar();
        aviso('✓ Foto atualizada');
      } catch (error) {
        aviso(error.message, true);
        salvarBt.disabled = false;
        salvarBt.textContent = 'Salvar foto';
      }
    };
  }

  // ---------- Meus dados (so leitura: ligados a CNH e ao login) ----------

  function abrirDados() {
    const d = o.dados();
    const msg = encodeURIComponent(`Oi! Sou o motoboy ${d.nome || ''} e preciso mudar um dado do meu cadastro no MotoJá.`);
    abrir(`<h3>Meus dados</h3>
      <div class="mjp-campos">
        <div><small>Nome</small><b>${esc(d.nome || '-')}</b></div>
        <div><small>WhatsApp</small><b>${esc(telefone(d.telefone))}</b></div>
        <div><small>CPF</small><b>${esc(escondido(d.cpf))}</b></div>
        <div><small>CNH</small><b>${esc(escondido(d.cnh, 4))}</b></div>
      </div>
      <p class="mjp-dica">Esses dados são da sua CNH e do seu acesso. Para mudar algum, fale com o suporte: a gente confere e troca pra você.</p>
      <div class="mjp-botoes"><a class="mjp-bt pri" href="${SUPORTE}${msg}" target="_blank" rel="noopener">💬 Falar com o suporte</a></div>
      <button type="button" class="mjp-cancelar" data-mjp-fechar>Fechar</button>`);
  }

  // ---------- Minha moto e documento ----------

  function abrirMoto() {
    const d = o.dados();
    const ov = abrir(`<h3>Minha moto</h3>
      <form class="mjp-form" data-mjp-moto>
        <label>Modelo<input name="modelo" maxlength="60" value="${esc(d.motoModelo || '')}" placeholder="Honda CG 160" required></label>
        <div class="mjp-duas">
          <label>Ano<input name="ano" inputmode="numeric" maxlength="4" value="${esc(d.motoAno || '')}" placeholder="2020" required></label>
          <label>Placa<input name="placa" maxlength="8" value="${esc(d.motoPlaca || '')}" placeholder="ABC1D23" required></label>
        </div>
        <div class="mjp-doc"><span>📄 Documento da moto (CRLV)<small>${d.crlv ? '<b class="mjp-ok">✓ cadastrado</b>' : '<b class="mjp-pend">pendente</b>'}</small></span>
          <label class="mjp-bt mini">Enviar foto nova<input type="file" accept="image/*" hidden data-mjp-crlv></label></div>
        <p class="mjp-dica" data-mjp-crlv-info>Trocou de moto ou de placa? Salve aqui. O dono confere depois e você continua rodando.</p>
        <div class="mjp-botoes"><button type="submit" class="mjp-bt pri" data-mjp-salvar>Salvar</button></div>
      </form>
      <button type="button" class="mjp-cancelar" data-mjp-fechar>Cancelar</button>`);
    const form = ov.querySelector('[data-mjp-moto]');
    const placa = form.elements.placa;
    placa.oninput = () => { placa.value = placa.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7); };
    form.elements.ano.oninput = () => { form.elements.ano.value = digitos(form.elements.ano.value).slice(0, 4); };
    let crlv = '';
    ov.querySelector('[data-mjp-crlv]').onchange = async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      try {
        crlv = await o.comprimirDocumento(file);
        ov.querySelector('[data-mjp-crlv-info]').textContent = '✓ Foto do documento pronta. Toque em Salvar.';
      } catch (error) {
        aviso(error.message || 'Não consegui usar essa foto.', true);
      }
    };
    form.onsubmit = async (event) => {
      event.preventDefault();
      const bt = form.querySelector('[data-mjp-salvar]');
      bt.disabled = true;
      bt.textContent = 'Salvando...';
      try {
        const d2 = await salvar({ moto: { modelo: form.elements.modelo.value, ano: form.elements.ano.value, placa: placa.value }, ...(crlv ? { crlvFoto: crlv } : {}) });
        fechar();
        aviso(d2.message || '✓ Salvo');
      } catch (error) {
        aviso(error.message, true);
        bt.disabled = false;
        bt.textContent = 'Salvar';
      }
    };
  }

  // ---------- SOS ----------

  function posicao() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 9000, maximumAge: 30000 }
      );
    });
  }

  async function chamarSos(acao) {
    const proof = o.getProof();
    const ponto = acao === 'sos' ? await posicao() : null;
    const r = await fetch(`${o.backend}/api/drivers/${proof.driverCpf}/sos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...proof, acao, ...(ponto || {}) }),
      cache: 'no-store'
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.message || 'Não consegui avisar o grupo agora.'), { code: d.error });
    return d;
  }

  const LIGAR = '<div class="mjp-botoes"><a class="mjp-bt ligar" href="tel:190">📞 Ligar 190 · Polícia</a><a class="mjp-bt ligar" href="tel:192">🚑 Ligar 192 · SAMU</a></div>';

  async function dispararSos() {
    sosAberto = true;
    try { navigator.vibrate?.([200, 100, 200]); } catch (_) { /* sem vibrar */ }
    abrir('<div class="mjp-sos-envio"><div class="mjp-sos-bola">SOS</div><h3>Pedindo ajuda...</h3><p class="mjp-dica">Pegando sua localização e avisando o grupo da sua cidade.</p></div>');
    try {
      const d = await chamarSos('sos');
      const ov = abrir(`<div class="mjp-sos-envio"><div class="mjp-sos-bola ok">✓</div><h3>${esc(d.message || 'Pedido de ajuda enviado.')}</h3><p class="mjp-dica">Os motoboys receberam seu nome, sua localização e o serviço em andamento. Se estiver em perigo, ligue agora:</p></div>
        ${LIGAR}<button type="button" class="mjp-bt bem" data-mjp-bem>✅ Estou bem, avisar o grupo</button>
        <button type="button" class="mjp-cancelar" data-mjp-fechar>Fechar</button>`);
      ov.querySelector('[data-mjp-bem]').onclick = async (event) => {
        const bt = event.currentTarget;
        bt.disabled = true;
        bt.textContent = 'Avisando...';
        try {
          await chamarSos('ok');
          fechar();
          aviso('✓ Avisamos que está tudo bem');
        } catch (error) {
          aviso(error.message, true);
          bt.disabled = false;
          bt.textContent = '✅ Estou bem, avisar o grupo';
        }
      };
    } catch (error) {
      const ov = abrir(`<div class="mjp-sos-envio"><div class="mjp-sos-bola">!</div><h3>${esc(error.message)}</h3><p class="mjp-dica">${error.code === 'sos_recente' ? 'O grupo já foi avisado.' : 'Tente de novo ou ligue:'}</p></div>
        ${LIGAR}${error.code === 'sos_recente' ? '' : '<button type="button" class="mjp-bt pri" data-mjp-denovo>Tentar de novo</button>'}
        <button type="button" class="mjp-cancelar" data-mjp-fechar>Fechar</button>`);
      ov.querySelector('[data-mjp-denovo]')?.addEventListener('click', dispararSos);
    }
  }

  function ligarSos(botao) {
    const parar = () => {
      clearTimeout(segurarTimer);
      segurarTimer = null;
      botao.classList.remove('segurando');
    };
    botao.addEventListener('pointerdown', (event) => {
      if (event.button > 0) return;
      parar();
      botao.classList.add('segurando');
      segurarTimer = setTimeout(() => { parar(); dispararSos(); }, SEGURAR_MS);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((tipo) => botao.addEventListener(tipo, parar));
    botao.addEventListener('contextmenu', (event) => event.preventDefault());
    // Teclado/leitor de tela (sem "segurar"): pede confirmacao.
    botao.addEventListener('click', (event) => {
      if (event.detail !== 0) return;
      const ov = abrir('<h3>Pedir ajuda agora?</h3><p class="mjp-dica">Vamos mandar sua localização no grupo dos motoboys da sua cidade.</p><div class="mjp-botoes"><button type="button" class="mjp-bt sos" data-mjp-confirma>🆘 Enviar SOS</button></div><button type="button" class="mjp-cancelar" data-mjp-fechar>Cancelar</button>');
      ov.querySelector('[data-mjp-confirma]').onclick = dispararSos;
    });
  }

  // ---------- Tela ----------

  function render() {
    const box = document.getElementById('perfilMotoboy');
    if (!box || !o) return;
    estilos();
    const d = o.dados();
    const mp = o.mercadoPagoTexto?.() || '';
    const moto = [d.motoModelo, d.motoPlaca].filter(Boolean).join(' · ') || 'Moto não informada';
    box.classList.add('mjp');
    box.innerHTML = `
      <div class="mjp-topo">
        <button type="button" class="mjp-foto" data-mjp="foto" aria-label="Trocar foto de perfil">${d.foto ? `<img src="${esc(d.foto)}" alt="">` : `<span>${esc((d.nome || 'M').charAt(0).toUpperCase())}</span>`}<i>📷</i></button>
        <h2>${esc(d.nome || 'Motoboy MotoJá')}</h2>
        <span class="mjp-selo">✓ Cadastro aprovado</span>
        <p>${esc(telefone(d.telefone))}</p>
      </div>
      <button type="button" class="mjp-sos" data-mjp-sos>
        <span class="mjp-sos-ic">SOS</span>
        <span><b>Botão de emergência</b><small>Segure 3 segundos: avisa o grupo dos motoboys da sua cidade com a sua localização</small></span>
        <i class="mjp-sos-fill" aria-hidden="true"></i>
      </button>
      <div class="mjp-lista">
        <button type="button" data-mjp="foto"><span class="ic">📷</span><span><b>Trocar foto</b><small>Escolhe e salva na hora</small></span><i>›</i></button>
        <button type="button" data-mjp="dados"><span class="ic">👤</span><span><b>Meus dados</b><small>Nome, WhatsApp, CPF e CNH</small></span><i>›</i></button>
        <button type="button" data-mjp="moto"><span class="ic">🏍️</span><span><b>Minha moto</b><small>${esc(moto)} · CRLV ${d.crlv ? '✓' : 'pendente'}</small></span><i>›</i></button>
      </div>
      <div class="mjp-lista">
        <button type="button" data-mjp="mp"><span class="ic">💸</span><span><b>Mercado Pago</b><small>${esc(/desconectar|conectado/i.test(mp) ? 'Conectado: recebe Pix e cartão na sua conta' : 'Conecte para receber Pix e cartão na hora')}</small></span><i>›</i></button>
        <button type="button" data-mjp="avisos"><span class="ic">🔔</span><span><b>Avisos de chamada</b><small>Notificação, Telegram e tela acesa</small></span><i>›</i></button>
        <button type="button" data-mjp="indicar"><span class="ic">🤝</span><span><b>Indicar motoboy</b><small>Chame um amigo para o MotoJá</small></span><i>›</i></button>
      </div>`;
    box.querySelectorAll('[data-mjp]').forEach((b) => {
      b.onclick = () => ({
        foto: abrirFoto,
        dados: abrirDados,
        moto: abrirMoto,
        mp: () => o.mercadoPago?.(),
        avisos: () => o.avisos?.(),
        indicar: () => o.indicar?.()
      })[b.dataset.mjp]?.();
    });
    ligarSos(box.querySelector('[data-mjp-sos]'));
  }

  function estilos() {
    if (document.getElementById('mjp-css')) return;
    const css = document.createElement('style');
    css.id = 'mjp-css';
    css.textContent = `
#perfilMotoboy.mjp{padding:0;background:none;border:0;box-shadow:none;display:grid;gap:12px}
.mjp-topo{display:grid;justify-items:center;gap:5px;text-align:center;padding:6px 0 2px}
.mjp-topo h2{margin:4px 0 0;font-size:1.3rem}.mjp-topo p{margin:0;color:#9aa0ab;font-size:.82rem}
.mjp-foto{position:relative;width:96px;height:96px;border-radius:50%;padding:0;border:3px solid #ff7a00;background:#1f232c;overflow:visible;box-shadow:none;min-height:0}
.mjp-foto img{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block}.mjp-foto span{font-size:2.2rem;font-weight:900;color:#fff}
.mjp-foto i{position:absolute;right:-4px;bottom:-2px;width:34px;height:34px;border-radius:50%;background:#ff7a00;display:grid;place-items:center;font-style:normal;font-size:15px;border:3px solid #0b0c11}
.mjp-selo{font-size:.74rem;font-weight:800;color:#7ee2a8;background:rgba(34,184,102,.12);border:1px solid rgba(34,184,102,.35);border-radius:999px;padding:4px 10px}
.mjp-sos{position:relative;overflow:hidden;display:flex;align-items:center;gap:12px;width:100%;text-align:left;border:0;border-radius:18px;padding:14px;background:linear-gradient(135deg,#c41616,#ff4d4d);color:#fff;box-shadow:0 12px 28px rgba(255,60,60,.22);user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;touch-action:none;min-height:0}
.mjp-sos-ic{flex:none;width:52px;height:52px;border-radius:50%;background:rgba(255,255,255,.2);display:grid;place-items:center;font-weight:900;font-size:1rem;position:relative;z-index:1}
.mjp-sos b{display:block;font-size:1.02rem;position:relative;z-index:1}.mjp-sos small{display:block;font-size:.76rem;opacity:.92;margin-top:2px;position:relative;z-index:1;font-weight:600}
.mjp-sos-fill{position:absolute;inset:0;width:0;background:rgba(0,0,0,.28);transition:none}
.mjp-sos.segurando .mjp-sos-fill{width:100%;transition:width 3s linear}
.mjp-lista{background:#12141b;border:1px solid #262a35;border-radius:16px;overflow:hidden}
.mjp-lista button{display:flex;align-items:center;gap:11px;width:100%;text-align:left;padding:12px;border:0;border-bottom:1px solid #262a35;border-radius:0;background:transparent;color:#fff;box-shadow:none;min-height:0}
.mjp-lista button:last-child{border-bottom:0}
.mjp-lista .ic{width:36px;height:36px;border-radius:11px;background:#1c2029;display:grid;place-items:center;font-size:17px;flex:none}
.mjp-lista b{display:block;font-size:.92rem}.mjp-lista small{display:block;font-size:.76rem;color:#9aa0ab;font-weight:600}.mjp-lista span:nth-child(2){flex:1;min-width:0}
.mjp-lista i{color:#6d7280;font-style:normal;font-size:1.3rem}
.mjp-ov{position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.62);display:flex;align-items:flex-end;justify-content:center}
.mjp-ov[hidden]{display:none}
.mjp-folha{width:min(100%,540px);max-height:92vh;overflow:auto;background:#14161d;border-top:1px solid #262a35;border-radius:26px 26px 0 0;padding:10px 18px calc(22px + env(safe-area-inset-bottom));display:grid;gap:12px;color:#fff}
.mjp-folha h3{margin:4px 0 0;text-align:center;font-size:1.15rem}
.mjp-grab{width:44px;height:5px;border-radius:5px;background:#3a3f4b;margin:0 auto}
.mjp-prev{width:150px;height:150px;border-radius:50%;margin:0 auto;border:4px solid #ff7a00;background:#1f232c;display:grid;place-items:center;overflow:hidden;font-size:2.4rem}
.mjp-prev img{width:100%;height:100%;object-fit:cover}
.mjp-dica{margin:0;color:#9aa0ab;font-size:.8rem;text-align:center;line-height:1.45}
.mjp-botoes{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.mjp-bt{display:grid;place-items:center;min-height:48px;border-radius:14px;padding:10px;font-weight:800;font-size:.9rem;text-align:center;background:#1f232c;border:1px solid #2a2e39;color:#fff;text-decoration:none;cursor:pointer;box-shadow:none}
.mjp-bt.pri{grid-column:1/-1;background:linear-gradient(135deg,#ff6b00,#ff9a00);border:0}
.mjp-bt.pri:disabled{opacity:.45}
.mjp-bt.ligar{background:#1c2029}.mjp-bt.sos{grid-column:1/-1;background:linear-gradient(135deg,#c41616,#ff4d4d);border:0}
.mjp-bt.bem{width:100%;background:rgba(34,184,102,.16);border-color:rgba(34,184,102,.45);color:#bff5d4}
.mjp-bt.mini{min-height:38px;padding:6px 12px;font-size:.8rem}
.mjp-cancelar{background:none;border:0;color:#9aa0ab;font-weight:700;box-shadow:none;min-height:40px}
.mjp-campos{display:grid;gap:8px}.mjp-campos div{background:#1a1d26;border:1px solid #262a35;border-radius:12px;padding:10px 12px}
.mjp-campos small{display:block;color:#9aa0ab;font-size:.72rem}.mjp-campos b{font-size:.98rem;letter-spacing:.3px}
.mjp-form{display:grid;gap:10px}.mjp-form label{display:grid;gap:5px;font-size:.8rem;font-weight:700;color:#d8dbe2}
.mjp-duas{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.mjp-doc{display:flex;justify-content:space-between;align-items:center;gap:10px;background:#1a1d26;border:1px solid #262a35;border-radius:12px;padding:10px 12px;font-size:.86rem;font-weight:700}
.mjp-doc small{display:block;font-size:.74rem}.mjp-ok{color:#7ee2a8}.mjp-pend{color:#ffb020}
.mjp-sos-envio{display:grid;justify-items:center;gap:8px;text-align:center;padding-top:6px}
.mjp-sos-bola{width:78px;height:78px;border-radius:50%;display:grid;place-items:center;font-weight:900;font-size:1.3rem;background:linear-gradient(135deg,#c41616,#ff4d4d);animation:mjp-pulso 1.2s ease-out infinite}
.mjp-sos-bola.ok{background:#1d7a47;animation:none;font-size:2rem}
@keyframes mjp-pulso{0%{box-shadow:0 0 0 0 rgba(255,77,77,.6)}100%{box-shadow:0 0 0 22px rgba(255,77,77,0)}}
.mjp-toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:2100;background:#1d7a47;color:#fff;font-weight:800;font-size:.88rem;border-radius:999px;padding:10px 18px;box-shadow:0 10px 24px rgba(0,0,0,.4);max-width:90vw;text-align:center}
.mjp-toast.erro{background:#8a2020}
body.mjp-travado{overflow:hidden}`;
    document.head.append(css);
  }

  window.MotoPerfil = {
    iniciar(opcoes) { o = opcoes; },
    render
  };
})();
