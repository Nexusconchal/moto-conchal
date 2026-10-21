(function () {
  'use strict';

  // Tela Inicio do motoboy no estilo Uber/99: mapa, botao grande para ficar
  // disponivel, ganhos de hoje e o que falta para rodar. Ela so espelha e
  // aciona o que ja existe no painel (disponibilidade, cidades, Mercado Pago,
  // Telegram e notificacoes), sem regra de negocio propria.
  const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const CENTRO_PADRAO = [-22.3308, -47.1724];
  const TELEGRAM_KEY = 'motoja:telegramAberto';
  const NAV_ATIVA = 'motoJaNavAtiva';

  let opcoes = null;
  let root = null;
  let mapa = null;
  let marcadorEu = null;
  let marcadoresChamadas = [];
  let posicao = null;
  let watchId = null;
  let seguir = true;
  let ganhosTimer = null;
  let gpsPermitido = null;

  const $ = (sel) => root?.querySelector(sel);

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  function moeda(valor) {
    return Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function lerLocal(chave) {
    try {
      return localStorage.getItem(chave);
    } catch (_) {
      return null;
    }
  }

  function montar() {
    root.innerHTML = `
      <div class="mjhome-map">
        <div class="mjhome-leaflet" data-home-mapa></div>
        <div class="mjhome-top">
          <button type="button" class="mjhome-av" data-home-perfil aria-label="Meu perfil"></button>
          <button type="button" class="mjhome-earn" data-home-ganhos aria-label="Ver meus ganhos"><small>HOJE</small><b data-home-ganho>R$ --</b></button>
          <button type="button" class="mjhome-round" data-home-centralizar aria-label="Centralizar no meu GPS">◎</button>
        </div>
        <div class="mjhome-searching" data-home-procurando hidden>
          <span class="mjhome-radar" aria-hidden="true"></span>
          <div><b data-home-procurando-titulo>Procurando chamadas</b><small data-home-procurando-sub></small></div>
          <button type="button" data-home-pausar>Pausar</button>
        </div>
        <div class="mjhome-chip" data-home-perto hidden></div>
        <button type="button" class="mjhome-go" data-home-go>FICAR<br>DISPONÍVEL</button>
      </div>
      <div class="mjhome-sheet">
        <div class="mjhome-state">
          <span class="mjhome-dot" data-home-dot></span>
          <div><h2 data-home-estado>Conectando…</h2><p data-home-estado-sub></p></div>
        </div>
        <button type="button" class="mjhome-active" data-home-ativo hidden>
          <span class="mjhome-active-ic" data-home-ativo-ic>🏍️</span>
          <span><b data-home-ativo-titulo></b><small data-home-ativo-sub></small></span>
          <span class="mjhome-active-go">Abrir GPS</span>
        </button>
        <div class="mjhome-stats">
          <div><b data-home-stat="servicos">-</b><span>serviços</span></div>
          <div><b data-home-stat="corridas">-</b><span>corridas</span></div>
          <div><b data-home-stat="entregas">-</b><span>entregas</span></div>
          <div><b data-home-stat="km">-</b><span>rodados</span></div>
        </div>
        <div class="mjhome-check" data-home-check>
          <div class="mjhome-check-h"><span>Pronto para rodar</span><span data-home-check-conta></span></div>
          <div class="mjhome-bar"><i data-home-check-barra></i></div>
          <div data-home-check-itens></div>
        </div>
        <button type="button" class="mjhome-pref" data-home-pref>
          <span class="mjhome-pref-ic">⚙️</span>
          <span><b>Preferências</b><small data-home-pref-sub>Cidades das corridas</small></span>
          <i>›</i>
        </button>
      </div>
      <div class="mjhome-prefs" data-home-prefs hidden>
        <div class="mjhome-prefs-sheet" role="dialog" aria-label="Preferências">
          <div class="mjhome-prefs-h"><h2>Preferências</h2><button type="button" class="mjhome-round" data-home-prefs-fechar aria-label="Fechar">✕</button></div>
          <p class="mjhome-prefs-txt">Escolha de onde você quer receber corridas. Entregas para comércios chegam de todas as cidades atendidas.</p>
          <div data-home-cidades></div>
        </div>
      </div>`;
  }

  // ---------- Mapa ----------

  async function iniciarMapa() {
    if (mapa || !window.MotoNav?.carregarLeaflet) return;
    let L;
    try {
      L = await window.MotoNav.carregarLeaflet();
    } catch (_) {
      $('[data-home-mapa]').classList.add('sem-mapa');
      return;
    }
    mapa = L.map($('[data-home-mapa]'), { zoomControl: false, attributionControl: true })
      .setView(posicao ? [posicao.lat, posicao.lon] : CENTRO_PADRAO, 15);
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(mapa);
    mapa.on('dragstart', () => {
      seguir = false;
      $('[data-home-centralizar]').classList.add('destaque');
    });
    desenharEu();
    setTimeout(() => mapa.invalidateSize(), 80);
  }

  function desenharEu() {
    if (!mapa || !posicao || !window.L) return;
    const rot = Number.isFinite(posicao.heading) ? posicao.heading : 0;
    const html = `<span class="mjhome-eu ${root.dataset.estado === 'disponivel' ? 'on' : ''}"><i style="transform:rotate(${rot}deg)"></i></span>`;
    if (!marcadorEu) {
      marcadorEu = window.L.marker([posicao.lat, posicao.lon], {
        icon: window.L.divIcon({ className: 'mjhome-icon', html, iconSize: [120, 120], iconAnchor: [60, 60] }),
        zIndexOffset: 1000,
        interactive: false
      }).addTo(mapa);
    } else {
      marcadorEu.setLatLng([posicao.lat, posicao.lon]);
      marcadorEu.setIcon(window.L.divIcon({ className: 'mjhome-icon', html, iconSize: [120, 120], iconAnchor: [60, 60] }));
    }
    if (seguir) mapa.setView([posicao.lat, posicao.lon], Math.max(mapa.getZoom(), 15), { animate: true });
  }

  function aoMudarPosicao(pos) {
    posicao = { lat: pos.coords.latitude, lon: pos.coords.longitude, heading: pos.coords.heading };
    gpsPermitido = true;
    desenharEu();
    renderChecklist();
  }

  function iniciarGps() {
    if (!navigator.geolocation || watchId !== null || document.visibilityState === 'hidden') return;
    watchId = navigator.geolocation.watchPosition(aoMudarPosicao, (erro) => {
      if (erro?.code === 1) {
        gpsPermitido = false;
        renderChecklist();
      }
    }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
  }

  function pararGps() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  function desenharChamadas(jobs) {
    if (!mapa || !window.L) return;
    marcadoresChamadas.forEach((m) => mapa.removeLayer(m));
    marcadoresChamadas = [];
    const pontos = jobs
      .map((j) => ({ lat: Number(j.origemLat || j.retiradaLat), lon: Number(j.origemLon || j.retiradaLon), entrega: !!j.retiradaLat }))
      .filter((p) => Math.abs(p.lat) > 0.1 && Math.abs(p.lon) > 0.1);
    pontos.forEach((p) => {
      marcadoresChamadas.push(window.L.marker([p.lat, p.lon], {
        icon: window.L.divIcon({ className: 'mjhome-icon', html: `<span class="mjhome-chamada">${p.entrega ? '📦' : '🙋'}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
        interactive: false
      }).addTo(mapa));
    });
  }

  // ---------- Disponibilidade (espelha #driver-availability) ----------

  function lerDisponibilidade() {
    const box = document.getElementById('driver-availability');
    const sim = box?.querySelector('[data-available="true"]');
    const nao = box?.querySelector('[data-available="false"]');
    const texto = box?.querySelector('[data-availability-status]')?.textContent?.trim() || '';
    return {
      ativo: !!box && !box.hidden,
      ligado: sim?.getAttribute('aria-pressed') === 'true',
      pronto: !!sim && !sim.disabled,
      online: box?.dataset.state === 'available',
      ocupado: /atendimento/i.test(texto),
      texto,
      sim,
      nao
    };
  }

  function renderDisponibilidade() {
    if (!root) return;
    const d = lerDisponibilidade();
    const go = $('[data-home-go]');
    const procurando = $('[data-home-procurando]');
    let estado = 'indisponivel';
    if (d.ligado && d.ocupado) estado = 'ocupado';
    else if (d.ligado && d.online) estado = 'disponivel';
    else if (d.ligado) estado = 'conectando';
    root.dataset.estado = estado;

    go.hidden = d.ligado;
    go.disabled = !d.pronto;
    go.innerHTML = d.pronto ? 'FICAR<br>DISPONÍVEL' : 'CONECTANDO…';

    procurando.hidden = !d.ligado;
    $('[data-home-procurando-titulo]').textContent = estado === 'ocupado'
      ? 'Em atendimento'
      : estado === 'conectando' ? 'Reconectando…' : 'Procurando chamadas';
    $('[data-home-procurando-sub]').textContent = opcoes?.resumoCidades?.() || '';
    $('[data-home-pausar]').disabled = !d.pronto;

    const titulos = {
      indisponivel: 'Você está indisponível',
      conectando: 'Disponível · reconectando',
      disponivel: 'Você está disponível',
      ocupado: 'Em atendimento'
    };
    $('[data-home-estado]').textContent = titulos[estado];
    $('[data-home-estado-sub]').textContent = estado === 'indisponivel'
      ? (d.pronto ? 'Toque no botão para receber chamadas' : d.texto || 'Conectando ao servidor…')
      : d.texto;
    desenharEu();
  }

  // ---------- Ganhos de hoje ----------

  async function carregarGanhos() {
    if (!opcoes || document.visibilityState === 'hidden') return;
    const proof = opcoes.getProof();
    if (!/^\d{11}$/.test(proof.driverCpf || '')) return;
    try {
      const r = await fetch(`${opcoes.backend}/api/drivers/${proof.driverCpf}/earnings/summary`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...proof, period: 'today' }),
        cache: 'no-store'
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error('ganhos');
      const s = d.summary || {};
      $('[data-home-ganho]').textContent = moeda(s.ganho);
      $('[data-home-stat="servicos"]').textContent = String(Number(s.servicos || 0));
      $('[data-home-stat="corridas"]').textContent = String(Number(s.corridas || 0));
      $('[data-home-stat="entregas"]').textContent = String(Number(s.entregas || 0));
      $('[data-home-stat="km"]').textContent = `${Number(s.quilometros || 0).toFixed(0)} km`;
    } catch (_) {
      // Mantem o ultimo valor; o painel de ganhos mostra o erro detalhado.
    }
  }

  // ---------- Servico em andamento ----------

  function renderAtivo() {
    if (!root) return;
    let nav = null;
    try {
      nav = JSON.parse(lerLocal(NAV_ATIVA) || 'null');
    } catch (_) {}
    const card = $('[data-home-ativo]');
    card.hidden = !nav?.id;
    if (!nav?.id) return;
    const entrega = nav.tipo === 'entrega';
    $('[data-home-ativo-ic]').textContent = entrega ? '📦' : '🏍️';
    $('[data-home-ativo-titulo]').textContent = entrega ? 'Entrega em andamento' : 'Corrida em andamento';
    $('[data-home-ativo-sub]').textContent = nav.etapa === 'levar'
      ? (entrega ? 'Indo entregar o pedido' : 'Levando o passageiro')
      : (entrega ? 'Indo retirar o pedido' : 'Indo buscar o passageiro');
  }

  // ---------- Pronto para rodar ----------

  function itensChecklist() {
    const mp = document.getElementById('btn-mp');
    const notificacao = 'Notification' in window ? Notification.permission : 'unsupported';
    return [
      {
        id: 'gps',
        texto: 'GPS e localização',
        feito: gpsPermitido === true,
        acao: gpsPermitido === false ? 'Como liberar' : 'Ativar',
        clique: () => {
          if (gpsPermitido === false) {
            alert('A localização está bloqueada. Abra as configurações do celular, toque em Apps > navegador/MotoJá > Permissões e libere a Localização.');
            return;
          }
          pararGps();
          iniciarGps();
        }
      },
      {
        id: 'notificacao',
        texto: 'Notificações neste aparelho',
        feito: notificacao === 'granted',
        acao: 'Ativar',
        clique: () => document.getElementById('btn-push-device')?.click()
      },
      {
        id: 'telegram',
        texto: 'Grupo de avisos no Telegram',
        feito: lerLocal(TELEGRAM_KEY) === '1',
        acao: 'Entrar',
        clique: () => {
          try {
            localStorage.setItem(TELEGRAM_KEY, '1');
          } catch (_) {}
          document.getElementById('btn-push')?.click();
        }
      },
      {
        id: 'mercadopago',
        texto: 'Mercado Pago (receber até 80%)',
        feito: !!mp && mp.disabled && /conectado/i.test(mp.textContent),
        acao: 'Conectar',
        clique: () => mp?.click()
      }
    ];
  }

  function renderChecklist() {
    if (!root) return;
    const itens = itensChecklist();
    const feitos = itens.filter((i) => i.feito).length;
    const box = $('[data-home-check]');
    box.hidden = feitos === itens.length;
    $('[data-home-check-conta]').textContent = `${feitos} de ${itens.length}`;
    $('[data-home-check-barra]').style.width = `${Math.round((feitos / itens.length) * 100)}%`;
    const lista = $('[data-home-check-itens]');
    lista.innerHTML = itens.map((i) => `
      <div class="mjhome-ck ${i.feito ? 'ok' : ''}">
        <span class="mjhome-ck-ic">${i.feito ? '✓' : '!'}</span>
        <span>${esc(i.texto)}</span>
        ${i.feito ? '' : `<button type="button" data-home-ck="${i.id}">${esc(i.acao)} ›</button>`}
      </div>`).join('');
    lista.querySelectorAll('[data-home-ck]').forEach((btn) => {
      btn.onclick = () => {
        itens.find((i) => i.id === btn.dataset.homeCk)?.clique();
        setTimeout(renderChecklist, 1500);
      };
    });
  }

  // ---------- Preferencias ----------

  function renderPreferencias() {
    if (!root) return;
    $('[data-home-pref-sub]').textContent = `Corridas de ${opcoes?.resumoCidades?.() || 'Conchal'}`;
  }

  function adotarCidades() {
    const cidades = document.getElementById('cidadeCorridas');
    const destino = $('[data-home-cidades]');
    // Move o seletor original (com os mesmos eventos de salvar) para dentro da folha.
    if (cidades && destino && cidades.parentElement !== destino) destino.appendChild(cidades);
  }

  function abrirPreferencias() {
    adotarCidades();
    $('[data-home-prefs]').hidden = false;
  }

  function fecharPreferencias() {
    $('[data-home-prefs]').hidden = true;
    renderPreferencias();
    renderDisponibilidade();
  }

  // ---------- Inicio ----------

  function renderAvatar() {
    const foto = opcoes?.foto?.() || '';
    const nome = String(opcoes?.nome?.() || 'M').trim();
    $('[data-home-perfil]').innerHTML = /^data:image\//.test(foto)
      ? `<img src="${esc(foto)}" alt="">`
      : esc(nome.charAt(0).toUpperCase() || 'M');
  }

  function iniciar(config) {
    opcoes = config;
    root = document.getElementById('motoHome');
    if (!root) return;
    if (!root.dataset.montado) {
      montar();
      root.dataset.montado = '1';
      $('[data-home-go]').onclick = () => lerDisponibilidade().sim?.click();
      $('[data-home-pausar]').onclick = () => lerDisponibilidade().nao?.click();
      $('[data-home-ganhos]').onclick = () => document.getElementById('nav-ganhos')?.click();
      $('[data-home-perfil]').onclick = () => document.getElementById('nav-perfil')?.click();
      $('[data-home-centralizar]').onclick = (event) => {
        seguir = true;
        event.currentTarget.classList.remove('destaque');
        if (posicao && mapa) mapa.setView([posicao.lat, posicao.lon], Math.max(mapa.getZoom(), 15), { animate: true });
        else iniciarGps();
      };
      $('[data-home-ativo]').onclick = () => opcoes?.abrirServicoAtivo?.();
      $('[data-home-pref]').onclick = abrirPreferencias;
      $('[data-home-prefs-fechar]').onclick = fecharPreferencias;
      $('[data-home-prefs]').addEventListener('click', (event) => {
        if (event.target === event.currentTarget) fecharPreferencias();
      });

      const box = document.getElementById('driver-availability');
      if (box) new MutationObserver(renderDisponibilidade).observe(box, { attributes: true, subtree: true, childList: true, characterData: true });
      const mp = document.getElementById('btn-mp');
      if (mp) new MutationObserver(renderChecklist).observe(mp, { attributes: true, childList: true, characterData: true, subtree: true });

      window.addEventListener('motoja:jobs-rendered', (event) => {
        const detail = event.detail || {};
        if (detail.scope === 'pending') {
          const jobs = Array.isArray(detail.jobs) ? detail.jobs.filter((j) => j.status === 'pendente') : [];
          const chip = $('[data-home-perto]');
          chip.hidden = !jobs.length || root.dataset.estado !== 'disponivel';
          chip.textContent = `${jobs.length} ${jobs.length > 1 ? 'chamadas abertas' : 'chamada aberta'} agora`;
          desenharChamadas(root.dataset.estado === 'disponivel' ? jobs : []);
        } else {
          carregarGanhos();
        }
        renderAtivo();
      });
      window.addEventListener('storage', renderAtivo);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          iniciarGps();
          carregarGanhos();
          renderChecklist();
          renderAtivo();
        } else pararGps();
      });
      if (navigator.permissions?.query) {
        navigator.permissions.query({ name: 'geolocation' }).then((status) => {
          const atualizar = () => {
            gpsPermitido = status.state === 'granted' ? true : status.state === 'denied' ? false : gpsPermitido;
            renderChecklist();
          };
          status.onchange = atualizar;
          atualizar();
        }).catch(() => {});
      }
    }
    document.body.classList.add('mjhome-ativo');
    adotarCidades();
    renderAvatar();
    renderDisponibilidade();
    renderChecklist();
    renderPreferencias();
    renderAtivo();
    iniciarMapa();
    iniciarGps();
    carregarGanhos();
    clearInterval(ganhosTimer);
    ganhosTimer = setInterval(() => {
      carregarGanhos();
      renderAtivo();
    }, 120000);
  }

  window.MotoHome = { iniciar, atualizar: () => { renderAtivo(); renderChecklist(); renderDisponibilidade(); renderPreferencias(); } };
})();
