(function () {
  'use strict';

  // Tela cheia estilo app de motorista: oferta com mapa/rota antes de aceitar
  // e navegacao com GPS depois do aceite. Este arquivo so cuida da interface;
  // aceitar, avisar cliente, retirada e finalizar continuam no motoboy.html.
  const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
  const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
  const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const ROTA_CACHE_MS = 2 * 60 * 1000;
  const REROTA_METROS = 60;
  const REROTA_MS = 45000;
  const VELOCIDADE_MOTO_KMH = 28;

  let leafletPromise = null;
  let root = null;
  let mapa = null;
  let camadas = [];
  let marcadorMotoboy = null;
  let watchId = null;
  let ultimaPosicao = null;
  let tela = null; // { modo: 'oferta' | 'nav', cfg }
  let timerContagem = null;
  let seguirMotoboy = true;
  let rotaNav = { chave: '', em: 0, origem: null };
  const rotasCache = new Map();

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  function pontoValido(p) {
    return p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)) &&
      Math.abs(Number(p.lat)) > 0.1 && Math.abs(Number(p.lon)) > 0.1;
  }

  function distanciaMetros(a, b) {
    if (!pontoValido(a) || !pontoValido(b)) return Infinity;
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function textoKm(metros) {
    if (!Number.isFinite(metros)) return '-';
    if (metros < 1000) return `${Math.max(10, Math.round(metros / 10) * 10)} m`;
    return `${(metros / 1000).toFixed(1).replace('.', ',')} km`;
  }

  function textoMin(segundos) {
    if (!Number.isFinite(segundos)) return '-';
    const min = Math.max(1, Math.round(segundos / 60));
    return min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}` : `${min} min`;
  }

  function horaChegada(segundos) {
    if (!Number.isFinite(segundos)) return '';
    return new Date(Date.now() + segundos * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function carregarLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (leafletPromise) return leafletPromise;
    leafletPromise = new Promise((resolve, reject) => {
      if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = LEAFLET_CSS;
        document.head.appendChild(link);
      }
      const script = document.createElement('script');
      script.src = LEAFLET_JS;
      script.onload = () => resolve(window.L);
      script.onerror = () => {
        leafletPromise = null;
        reject(new Error('Nao consegui carregar o mapa.'));
      };
      document.head.appendChild(script);
    });
    return leafletPromise;
  }

  function posicaoAtual() {
    if (ultimaPosicao && Date.now() - ultimaPosicao.em < 30000) return Promise.resolve(ultimaPosicao);
    if (!navigator.geolocation) return Promise.resolve(ultimaPosicao);
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition((pos) => {
        ultimaPosicao = { lat: pos.coords.latitude, lon: pos.coords.longitude, heading: pos.coords.heading, em: Date.now() };
        resolve(ultimaPosicao);
      }, () => resolve(ultimaPosicao), { enableHighAccuracy: true, maximumAge: 15000, timeout: 12000 });
    });
  }

  async function calcularRota(backend, a, b) {
    if (!pontoValido(a) || !pontoValido(b)) return null;
    const chave = [a.lat, a.lon, b.lat, b.lon].map((n) => Number(n).toFixed(4)).join(',');
    const cached = rotasCache.get(chave);
    if (cached && Date.now() - cached.em < ROTA_CACHE_MS) return cached.rota;
    const reta = distanciaMetros(a, b);
    const estimada = {
      metros: reta * 1.3,
      segundos: (reta * 1.3) / (VELOCIDADE_MOTO_KMH / 3.6),
      geometria: [[a.lat, a.lon], [b.lat, b.lon]],
      aproximada: true
    };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 9000);
      const response = await fetch(`${backend}/api/maps/route`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ points: [{ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }] }),
        signal: controller.signal
      }).finally(() => clearTimeout(timer));
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(data.geometry) || data.geometry.length < 2) throw new Error('rota');
      const metros = Number(data.km) * 1000;
      const rota = {
        metros,
        // A rota do servidor e calculada para carro; moto no trecho urbano
        // costuma chegar um pouco antes, entao usamos o menor dos dois.
        segundos: Math.min(Number(data.durationSeconds) || Infinity, metros / (VELOCIDADE_MOTO_KMH / 3.6) * 1.15),
        geometria: data.geometry,
        aproximada: false
      };
      rotasCache.set(chave, { em: Date.now(), rota });
      return rota;
    } catch (_) {
      return estimada;
    }
  }

  function garantirRoot() {
    if (root) return root;
    root = document.createElement('div');
    root.className = 'mjnav hidden';
    root.innerHTML = '<div class="mjnav-map" id="mjnav-map"></div><div class="mjnav-ui"></div>';
    document.body.appendChild(root);
    return root;
  }

  async function prepararMapa(centro) {
    const L = await carregarLeaflet();
    garantirRoot();
    if (!mapa) {
      mapa = L.map(root.querySelector('.mjnav-map'), { zoomControl: false, attributionControl: true })
        .setView(centro ? [centro.lat, centro.lon] : [-22.3308, -47.1724], 15);
      L.tileLayer(TILE_URL, { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(mapa);
      mapa.on('dragstart', () => {
        seguirMotoboy = false;
        root.querySelector('[data-mjnav-centralizar]')?.classList.add('show');
      });
    }
    setTimeout(() => mapa.invalidateSize(), 60);
    return L;
  }

  function limparCamadas() {
    camadas.forEach((camada) => mapa?.removeLayer(camada));
    camadas = [];
  }

  function adicionar(camada) {
    camada.addTo(mapa);
    camadas.push(camada);
    return camada;
  }

  function iconePino(L, tipo) {
    const html = tipo === 'coleta'
      ? '<span class="mjnav-pin coleta"></span>'
      : tipo === 'pacote'
        ? '<span class="mjnav-pin pacote">📦</span>'
        : '<span class="mjnav-pin destino"><i></i></span>';
    return L.divIcon({ className: 'mjnav-icon', html, iconSize: [30, 36], iconAnchor: [15, tipo === 'destino' ? 34 : 15] });
  }

  function atualizarMarcadorMotoboy(L, pos) {
    if (!pontoValido(pos)) return;
    const rotacao = Number.isFinite(pos.heading) ? pos.heading : 0;
    const html = `<span class="mjnav-moto" style="transform:rotate(${rotacao}deg)"></span>`;
    if (!marcadorMotoboy || !marcadorMotoboy._map) {
      marcadorMotoboy = L.marker([pos.lat, pos.lon], {
        icon: L.divIcon({ className: 'mjnav-icon', html, iconSize: [44, 44], iconAnchor: [22, 22] }),
        zIndexOffset: 1000
      }).addTo(mapa);
    } else {
      marcadorMotoboy.setLatLng([pos.lat, pos.lon]);
      const el = marcadorMotoboy.getElement()?.querySelector('.mjnav-moto');
      if (el) el.style.transform = `rotate(${rotacao}deg)`;
    }
  }

  function etiqueta(L, geometria, html, classe) {
    if (!Array.isArray(geometria) || !geometria.length) return;
    const meio = geometria[Math.floor(geometria.length / 2)];
    adicionar(L.marker(meio, {
      icon: L.divIcon({ className: 'mjnav-icon', html: `<span class="mjnav-chip ${classe || ''}">${html}</span>`, iconSize: [0, 0] }),
      interactive: false,
      zIndexOffset: 800
    }));
  }

  function linha(L, geometria, cor, tracejada) {
    if (!Array.isArray(geometria) || geometria.length < 2) return null;
    if (!tracejada) adicionar(L.polyline(geometria, { color: cor, weight: 11, opacity: 0.25, lineCap: 'round', lineJoin: 'round' }));
    return adicionar(L.polyline(geometria, {
      color: cor,
      weight: tracejada ? 4 : 6,
      opacity: 0.95,
      dashArray: tracejada ? '2 9' : null,
      lineCap: 'round',
      lineJoin: 'round'
    }));
  }

  function enquadrar(pontos, rodape) {
    const validos = pontos.filter(pontoValido).map((p) => [p.lat, p.lon]);
    if (!mapa || !validos.length) return;
    if (validos.length === 1) {
      mapa.setView(validos[0], 16);
      return;
    }
    mapa.fitBounds(validos, { paddingTopLeft: [40, 110], paddingBottomRight: [40, rodape + 30], maxZoom: 17 });
  }

  function iniciarGps(aoMover) {
    pararGps();
    if (!navigator.geolocation) return;
    watchId = navigator.geolocation.watchPosition((pos) => {
      if (!Number.isFinite(pos.coords.accuracy) || pos.coords.accuracy > 150) return;
      ultimaPosicao = { lat: pos.coords.latitude, lon: pos.coords.longitude, heading: pos.coords.heading, em: Date.now() };
      aoMover(ultimaPosicao);
    }, () => {}, { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 });
  }

  function pararGps() {
    if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  function pararContagem() {
    if (timerContagem) clearInterval(timerContagem);
    timerContagem = null;
  }

  function mostrar() {
    garantirRoot();
    root.classList.remove('hidden');
    document.documentElement.classList.add('mjnav-aberto');
  }

  function fechar() {
    pararGps();
    pararContagem();
    tela = null;
    if (root) root.classList.add('hidden');
    document.documentElement.classList.remove('mjnav-aberto');
  }

  function ui() {
    return root.querySelector('.mjnav-ui');
  }

  function alturaRodape() {
    return root.querySelector('.mjnav-sheet')?.offsetHeight || 320;
  }

  // ---------- Oferta (antes de aceitar) ----------

  function anelContagem(restanteMs, totalMs) {
    const circ = 2 * Math.PI * 23;
    const fracao = totalMs > 0 ? Math.max(0, Math.min(1, restanteMs / totalMs)) : 0;
    const seg = Math.ceil(restanteMs / 1000);
    const texto = seg >= 60 ? `${Math.floor(seg / 60)}:${String(seg % 60).padStart(2, '0')}` : String(seg);
    return `<svg width="58" height="58" viewBox="0 0 58 58"><circle cx="29" cy="29" r="23" class="trilho"/><circle cx="29" cy="29" r="23" class="progresso" stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${(circ * (1 - fracao)).toFixed(1)}"/></svg><span>${texto}</span>`;
  }

  function htmlParadas(cfg, tempoAteColeta) {
    return `<div class="mjnav-stops">
      <div class="mjnav-stop"><b>${esc(cfg.coleta?.titulo || '-')}</b><span>${esc(cfg.coleta?.detalhe || '')}${tempoAteColeta ? `${cfg.coleta?.detalhe ? ' · ' : ''}<em>${esc(tempoAteColeta)}</em> de você` : ''}</span></div>
      <div class="mjnav-stop fim"><b>${esc(cfg.destino?.titulo || '-')}</b><span>${esc(cfg.destino?.detalhe || '')}</span></div>
    </div>`;
  }

  function renderOferta(cfg, rotaColeta) {
    const ateColeta = rotaColeta ? textoKm(rotaColeta.metros) : '...';
    const tempoColeta = rotaColeta ? textoMin(rotaColeta.segundos) : '';
    ui().innerHTML = `
      <div class="mjnav-top">
        <button type="button" class="mjnav-round" data-mjnav-recusar aria-label="Fechar">✕</button>
        <span class="mjnav-pill"><i class="online"></i>${esc(cfg.topo || 'Online')}</span>
      </div>
      <section class="mjnav-sheet" role="dialog" aria-label="Nova ${esc(cfg.tipo)}">
        <div class="mjnav-grab"></div>
        <div class="mjnav-offerhead">
          <div>
            <div class="mjnav-tag">${esc(cfg.tag)}</div>
            <div class="mjnav-price">${esc(cfg.ganhoTexto)}<small>${esc(cfg.ganhoLegenda || '')}</small></div>
          </div>
          ${cfg.expiraEmMs ? `<div class="mjnav-ring" data-mjnav-ring>${anelContagem(cfg.expiraEmMs - Date.now(), cfg.duracaoMs)}</div>` : ''}
        </div>
        <div class="mjnav-stats">
          <div><b>${esc(ateColeta)}</b><span>${cfg.tipo === 'entrega' ? 'até a coleta' : 'até buscar'}</span></div>
          <div><b>${esc(cfg.kmViagemTexto || '-')}</b><span>${cfg.tipo === 'entrega' ? 'da entrega' : 'da viagem'}</span></div>
          <div><b>${esc(cfg.extra?.valor || '-')}</b><span>${esc(cfg.extra?.rotulo || '')}</span></div>
        </div>
        ${htmlParadas(cfg, tempoColeta)}
        ${cfg.observacao ? `<p class="mjnav-obs">${esc(cfg.observacao)}</p>` : ''}
        <p class="mjnav-erro" data-mjnav-erro hidden></p>
        <button type="button" class="mjnav-btn" data-mjnav-aceitar>${esc(cfg.textoAceitar)}</button>
        <button type="button" class="mjnav-ghost" data-mjnav-recusar>Recusar</button>
      </section>`;
    ui().querySelectorAll('[data-mjnav-recusar]').forEach((btn) => {
      btn.onclick = () => {
        const recusar = cfg.onRecusar;
        fechar();
        recusar?.();
      };
    });
    const aceitar = ui().querySelector('[data-mjnav-aceitar]');
    aceitar.onclick = async () => {
      const erro = ui().querySelector('[data-mjnav-erro]');
      aceitar.disabled = true;
      aceitar.textContent = 'Aceitando...';
      erro.hidden = true;
      try {
        pararContagem();
        await cfg.onAceitar();
      } catch (error) {
        if (tela?.cfg !== cfg) return;
        erro.textContent = error?.message || `Nao consegui aceitar essa ${cfg.tipo}.`;
        erro.hidden = false;
        aceitar.disabled = false;
        aceitar.textContent = `Tentar aceitar ${cfg.tipo}`;
      }
    };
  }

  async function abrirOferta(cfg) {
    pararGps();
    pararContagem();
    tela = { modo: 'oferta', cfg };
    mostrar();
    root.dataset.modo = 'oferta';
    renderOferta(cfg, null);
    if (cfg.expiraEmMs) {
      timerContagem = setInterval(() => {
        if (tela?.cfg !== cfg) return pararContagem();
        const restante = cfg.expiraEmMs - Date.now();
        if (restante <= 0) {
          const expirou = cfg.onExpirar;
          fechar();
          expirou?.();
          return;
        }
        const ring = ui().querySelector('[data-mjnav-ring]');
        if (ring) ring.innerHTML = anelContagem(restante, cfg.duracaoMs);
      }, 1000);
    }
    let L;
    try {
      [L] = await Promise.all([prepararMapa(cfg.coleta), posicaoAtual()]);
    } catch (_) {
      return;
    }
    if (tela?.cfg !== cfg) return;
    const eu = ultimaPosicao;
    const [rotaColeta, rotaViagem] = await Promise.all([
      calcularRota(cfg.backend, eu, cfg.coleta),
      calcularRota(cfg.backend, cfg.coleta, cfg.destino)
    ]);
    if (tela?.cfg !== cfg) return;
    limparCamadas();
    linha(L, rotaViagem?.geometria, '#ff7200', false);
    linha(L, rotaColeta?.geometria, '#9aa3b5', true);
    if (rotaColeta) etiqueta(L, rotaColeta.geometria, `${esc(textoKm(rotaColeta.metros))} · ${esc(textoMin(rotaColeta.segundos))}<small>${cfg.tipo === 'entrega' ? 'até a coleta' : 'até o passageiro'}</small>`, 'cinza');
    if (rotaViagem) etiqueta(L, rotaViagem.geometria, `${esc(textoKm(rotaViagem.metros))}<small>${cfg.tipo === 'entrega' ? 'entrega' : 'viagem'}</small>`);
    if (pontoValido(cfg.coleta)) adicionar(L.marker([cfg.coleta.lat, cfg.coleta.lon], { icon: iconePino(L, cfg.tipo === 'entrega' ? 'pacote' : 'coleta') }));
    if (pontoValido(cfg.destino)) adicionar(L.marker([cfg.destino.lat, cfg.destino.lon], { icon: iconePino(L, 'destino') }));
    atualizarMarcadorMotoboy(L, eu);
    renderOferta(cfg, rotaColeta);
    if (!pontoValido(eu)) {
      const erro = ui().querySelector('[data-mjnav-erro]');
      erro.textContent = 'Ative a localização para ver a distância até a coleta.';
      erro.hidden = false;
    }
    enquadrar([eu, cfg.coleta, cfg.destino], alturaRodape());
  }

  // ---------- Navegacao (depois de aceitar) ----------

  function linksNavegacao(alvo) {
    if (!pontoValido(alvo)) return { waze: '', maps: '' };
    return {
      waze: `https://waze.com/ul?ll=${alvo.lat},${alvo.lon}&navigate=yes`,
      maps: `https://www.google.com/maps/dir/?api=1&destination=${alvo.lat},${alvo.lon}&travelmode=driving`
    };
  }

  function renderNav(cfg, rota) {
    const alvo = cfg.alvo || {};
    const links = linksNavegacao(alvo);
    const distancia = rota ? textoKm(rota.metros) : pontoValido(alvo) ? '...' : '-';
    const tempo = rota ? textoMin(rota.segundos) : '';
    const cliente = cfg.cliente || {};
    const fone = String(cliente.telefone || '').replace(/\D/g, '');
    const avatar = cliente.foto
      ? `<img class="mjnav-avatar" src="${esc(cliente.foto)}" alt="">`
      : `<span class="mjnav-avatar">${esc(String(cliente.nome || 'C').trim().charAt(0).toUpperCase() || 'C')}</span>`;
    ui().innerHTML = `
      <div class="mjnav-banner ${cfg.etapa === 'levar' ? 'levar' : ''}">
        <div class="mjnav-arrow">${cfg.etapa === 'levar' ? '🏁' : '📍'}</div>
        <div><b>${esc(distancia)}</b><span>${esc(alvo.rotulo || '')}: ${esc(alvo.titulo || '-')}</span></div>
        <button type="button" class="mjnav-round" data-mjnav-fechar aria-label="Minimizar mapa">⌄</button>
      </div>
      ${cfg.aviso ? `<div class="mjnav-toast ${cfg.aviso.tipo === 'alerta' ? 'alerta' : ''}">${esc(cfg.aviso.texto)}</div>` : ''}
      <button type="button" class="mjnav-round mjnav-recenter" data-mjnav-centralizar aria-label="Centralizar no meu GPS">◎</button>
      <section class="mjnav-sheet">
        <div class="mjnav-grab"></div>
        <div class="mjnav-eta">
          <div><div class="mjnav-eta-big">${esc(tempo || distancia)}</div><div class="mjnav-meta">${esc(distancia)}${rota ? ` · chegada ${esc(horaChegada(rota.segundos))}` : ''}${rota?.aproximada ? ' · estimado' : ''}</div></div>
          <div class="mjnav-tag verde">● ${esc(cfg.etapaTexto || '')}</div>
        </div>
        <div class="mjnav-client">
          ${avatar}
          <div><b>${esc(cliente.nome || '-')}</b><span>${esc(cliente.linha || '')}</span></div>
          <div class="mjnav-client-icons">
            ${fone ? `<a class="mjnav-round" href="https://api.whatsapp.com/send?phone=55${esc(fone)}" target="_blank" rel="noopener" aria-label="WhatsApp">💬</a><a class="mjnav-round" href="tel:${esc(fone)}" aria-label="Ligar">📞</a>` : ''}
          </div>
        </div>
        <div class="mjnav-actions">
          ${(cfg.secundarias || []).map((acao, index) => `<button type="button" class="mjnav-act ${acao.destaque ? 'hl' : ''}" data-mjnav-sec="${index}" ${acao.desativado ? 'disabled' : ''}>${esc(acao.texto)}</button>`).join('')}
          ${links.waze ? `<a class="mjnav-act" href="${esc(links.waze)}" target="_blank" rel="noopener">🗺️ Waze</a><a class="mjnav-act" href="${esc(links.maps)}" target="_blank" rel="noopener">🧭 Google Maps</a>` : ''}
        </div>
        <p class="mjnav-erro" data-mjnav-erro hidden></p>
        ${cfg.principal ? `<button type="button" class="mjnav-btn ${cfg.principal.cor === 'verde' ? 'verde' : ''}" data-mjnav-principal ${cfg.principal.desativado ? 'disabled' : ''}>${esc(cfg.principal.texto)}</button>` : ''}
      </section>`;
    ui().querySelector('[data-mjnav-fechar]').onclick = () => {
      const aoFechar = cfg.onFechar;
      fechar();
      aoFechar?.();
    };
    ui().querySelector('[data-mjnav-centralizar]').onclick = (event) => {
      seguirMotoboy = true;
      event.currentTarget.classList.remove('show');
      enquadrarNav(cfg);
    };
    const executar = async (btn, acao) => {
      if (!acao?.acao) return;
      const erro = ui().querySelector('[data-mjnav-erro]');
      const original = btn.textContent;
      btn.disabled = true;
      if (acao.textoCarregando) btn.textContent = acao.textoCarregando;
      erro.hidden = true;
      if (tela) tela.ocupado = true;
      try {
        await acao.acao();
      } catch (error) {
        if (tela?.cfg !== cfg) return;
        erro.textContent = error?.message || 'Nao consegui concluir agora.';
        erro.hidden = false;
        btn.disabled = false;
        btn.textContent = original;
      } finally {
        if (tela?.cfg === cfg) tela.ocupado = false;
      }
    };
    ui().querySelectorAll('[data-mjnav-sec]').forEach((btn) => {
      btn.onclick = () => executar(btn, cfg.secundarias[Number(btn.dataset.mjnavSec)]);
    });
    const principal = ui().querySelector('[data-mjnav-principal]');
    if (principal) principal.onclick = () => executar(principal, cfg.principal);
  }

  function enquadrarNav(cfg) {
    if (!mapa) return;
    if (pontoValido(ultimaPosicao) && pontoValido(cfg.alvo) && distanciaMetros(ultimaPosicao, cfg.alvo) > 250 && !seguirMotoboy) {
      enquadrar([ultimaPosicao, cfg.alvo], alturaRodape());
      return;
    }
    if (pontoValido(ultimaPosicao)) {
      const alvoZoom = Math.max(mapa.getZoom(), 16);
      const ponto = mapa.project([ultimaPosicao.lat, ultimaPosicao.lon], alvoZoom);
      // Mantem o motoboy acima da folha inferior, como nos apps de motorista.
      const deslocado = mapa.unproject(ponto.add([0, alturaRodape() / 2 - 40]), alvoZoom);
      mapa.setView(deslocado, alvoZoom, { animate: true });
      return;
    }
    enquadrar([cfg.alvo], alturaRodape());
  }

  async function atualizarRotaNav(L, cfg, forcar) {
    const eu = ultimaPosicao;
    const chave = `${cfg.id}:${cfg.etapa}`;
    const moveu = distanciaMetros(rotaNav.origem, eu);
    if (!forcar && rotaNav.chave === chave && moveu < REROTA_METROS && Date.now() - rotaNav.em < REROTA_MS) return;
    rotaNav = { chave, em: Date.now(), origem: eu };
    const rota = pontoValido(eu) ? await calcularRota(cfg.backend, eu, cfg.alvo) : null;
    // A lista pode ter reaberto a mesma etapa enquanto a rota carregava; o
    // resultado continua valido para a tela atual.
    const atual = tela;
    if (!atual || atual.modo !== 'nav' || atual.cfg.id !== cfg.id || atual.cfg.etapa !== cfg.etapa) return;
    limparCamadas();
    linha(L, rota?.geometria, '#35c979', false);
    if (pontoValido(cfg.alvo)) adicionar(L.marker([cfg.alvo.lat, cfg.alvo.lon], { icon: iconePino(L, cfg.etapa === 'levar' ? 'destino' : cfg.tipo === 'entrega' ? 'pacote' : 'coleta') }));
    atual.rota = rota;
    // Nao redesenha os botoes no meio de uma acao (ex.: "Avisando cliente...").
    if (!atual.ocupado) renderNav(atual.cfg, rota);
  }

  async function abrirNavegacao(cfg) {
    pararContagem();
    const mesmaEtapa = tela?.modo === 'nav' && tela.cfg.id === cfg.id && tela.cfg.etapa === cfg.etapa;
    const rotaAnterior = mesmaEtapa ? tela.rota : null;
    tela = { modo: 'nav', cfg, rota: rotaAnterior };
    mostrar();
    root.dataset.modo = 'nav';
    if (!mesmaEtapa) seguirMotoboy = true;
    renderNav(cfg, rotaAnterior);
    let L;
    try {
      [L] = await Promise.all([prepararMapa(cfg.alvo), posicaoAtual()]);
    } catch (_) {
      return;
    }
    if (tela?.cfg !== cfg) return;
    atualizarMarcadorMotoboy(L, ultimaPosicao);
    await atualizarRotaNav(L, cfg, !mesmaEtapa);
    if (tela?.cfg !== cfg) return;
    enquadrarNav(cfg);
    iniciarGps((pos) => {
      if (tela?.cfg !== cfg) return;
      atualizarMarcadorMotoboy(L, pos);
      if (seguirMotoboy) enquadrarNav(cfg);
      atualizarRotaNav(L, cfg, false);
    });
  }

  window.MotoNav = {
    abrirOferta,
    abrirNavegacao,
    fechar,
    aberto: () => !!tela,
    ocupado: () => !!tela?.ocupado,
    modo: () => tela?.modo || '',
    idAtual: () => tela?.cfg?.id || '',
    tipo: () => tela?.cfg?.tipo || '',
    carregarLeaflet
  };
})();
