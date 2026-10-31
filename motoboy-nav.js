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
  // O alarme pertence à fila de chamados, não à abertura/fechamento do mapa.
  // Clicar em Aceitar só o encerra depois que o servidor confirmar o aceite.
  function iniciarAlarme() { window.MotojaCallAlerts?.refresh(); }
  function pararAlarme() {}

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
        ultimaPosicao = { lat: pos.coords.latitude, lon: pos.coords.longitude, heading: pos.coords.heading, precisao: pos.coords.accuracy, em: Date.now() };
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

  function iconeNumero(L, numero, estado) {
    return L.divIcon({
      className: 'mjnav-icon',
      html: `<span class="mjnav-pin num ${estado || ''}">${estado === 'feita' ? '✓' : esc(numero)}</span>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15]
    });
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
      ultimaPosicao = { lat: pos.coords.latitude, lon: pos.coords.longitude, heading: pos.coords.heading, precisao: pos.coords.accuracy, em: Date.now() };
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
    pararAlarme();
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
    const total = Number(cfg.lote?.total || 0);
    const numeros = total > 1 && total <= 30
      ? `<div class="mjnav-notas">${Array.from({ length: total }, (_, i) => `<i>${i + 1}</i>`).join('')}</div>`
      : '';
    return `<div class="mjnav-stops">
      <div class="mjnav-stop"><b>${esc(cfg.coleta?.titulo || '-')}</b><span>${esc(cfg.coleta?.detalhe || '')}${tempoAteColeta ? `${cfg.coleta?.detalhe ? ' · ' : ''}<em>${esc(tempoAteColeta)}</em> de você` : ''}</span></div>
      <div class="mjnav-stop fim"><b>${esc(cfg.destino?.titulo || '-')}</b><span>${esc(cfg.destino?.detalhe || '')}</span>${numeros}</div>
    </div>`;
  }

  // Conta do servico: total cobrado, taxa do app e quanto o motoboy recebe.
  function htmlConta(conta) {
    if (!Array.isArray(conta) || !conta.length) return '';
    return `<div class="mjnav-conta">${conta.map((linha) =>
      `<div class="${esc(linha.classe || '')}"><span>${esc(linha.rotulo)}</span><b>${esc(linha.valor)}</b></div>`).join('')}</div>`;
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
        ${htmlConta(cfg.conta)}
        <div class="mjnav-stats">
          <div><b>${esc(ateColeta)}</b><span>${cfg.tipo === 'entrega' ? 'até a coleta' : 'até buscar'}</span></div>
          ${cfg.meio
            ? `<div><b>${esc(cfg.meio.valor)}</b><span>${esc(cfg.meio.rotulo)}</span></div>`
            : `<div><b>${esc(cfg.kmViagemTexto || '-')}</b><span>${cfg.tipo === 'entrega' ? 'da entrega' : 'da viagem'}</span></div>`}
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
      pararAlarme();
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
    if (cfg.alarme) iniciarAlarme();
    else pararAlarme();
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
    else if (cfg.lote && pontoValido(cfg.coleta)) {
      etiqueta(L, [[cfg.coleta.lat, cfg.coleta.lon]], `${esc(cfg.lote.total)} ${Number(cfg.lote.total) > 1 ? 'entregas' : 'entrega'}<small>endereços nas notas</small>`, 'nota');
    }
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

  // ---------- Lote "endereco pela nota" ----------
  // A empresa so informou quantas entregas sao; o motoboy digita o endereco
  // de cada nota e ele vira um numero no mapa. Fica salvo neste celular.
  const PARADAS_PREFIXO = 'mjnav-paradas:';
  const PARADAS_VALIDADE_MS = 3 * 24 * 60 * 60 * 1000;
  let paradaFormAberto = '';
  let paradaFocar = '';

  function lerParadas(id) {
    try {
      const dados = JSON.parse(localStorage.getItem(PARADAS_PREFIXO + id) || 'null');
      if (dados && Array.isArray(dados.lista)) return dados;
    } catch (_) {}
    return { lista: [], ativa: '' };
  }

  function salvarParadas(id, dados) {
    try {
      localStorage.setItem(PARADAS_PREFIXO + id, JSON.stringify({ ...dados, em: Date.now() }));
      for (let i = localStorage.length - 1; i >= 0; i -= 1) {
        const chave = localStorage.key(i);
        if (!chave?.startsWith(PARADAS_PREFIXO) || chave === PARADAS_PREFIXO + id) continue;
        const antigo = JSON.parse(localStorage.getItem(chave) || 'null');
        if (!antigo?.em || Date.now() - antigo.em > PARADAS_VALIDADE_MS) localStorage.removeItem(chave);
      }
    } catch (_) {}
  }

  const MOTIVOS_PROBLEMA = {
    ninguem_atende: 'Ninguém atende',
    endereco_nao_existe: 'Não achei o endereço',
    cliente_recusou: 'Cliente recusou',
    outro: 'Outro problema'
  };
  let paradaProblema = '';

  // Celular trocado ou app reinstalado: a lista volta do servidor.
  function restaurarDoServidor(cfg) {
    const salvas = cfg.paradas?.salvas;
    if (!Array.isArray(salvas) || !salvas.length || lerParadas(cfg.id).lista.length) return;
    salvarParadas(cfg.id, {
      ativa: '',
      lista: salvas.map((p) => ({
        id: p.id, texto: p.texto, encontrado: p.encontrado || '', lat: Number(p.lat) || 0, lon: Number(p.lon) || 0,
        entregue: p.status === 'entregue', entregueEm: Number(p.entregueEm) || 0, problema: p.status === 'nao_encontrado' ? p.problema || 'outro' : ''
      }))
    });
  }

  // Manda a lista para o servidor (a loja acompanha e o app aprende os enderecos).
  const sincronizacoes = new Map();
  function sincronizarParadas(cfg) {
    if (!cfg.backend || !cfg.prova?.driverCpf) return;
    clearTimeout(sincronizacoes.get(cfg.id));
    sincronizacoes.set(cfg.id, setTimeout(() => {
      sincronizacoes.delete(cfg.id);
      const dados = lerParadas(cfg.id);
      const paradas = dados.lista.map((p) => ({
        id: p.id, texto: p.texto, encontrado: p.encontrado, lat: p.lat, lon: p.lon, entregueEm: p.entregueEm || 0,
        status: p.entregue ? 'entregue' : p.problema ? 'nao_encontrado' : 'pendente', problema: p.problema || '', gpsEntrega: p.gpsEntrega || null
      }));
      fetch(`${cfg.backend}/api/deliveries/${encodeURIComponent(cfg.id)}/notas`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...cfg.prova, paradas })
      }).catch(() => {});
    }, 1200));
  }

  // Distancia pela rua ate cada parada (servidor consulta o OSRM); sem resposta, linha reta.
  const distRua = { chave: '', origem: null, em: 0, metros: new Map() };
  function distanciaAteMim(p) {
    if (!pontoValido(ultimaPosicao)) return Infinity;
    const rua = distRua.metros.get(p.id);
    return Number.isFinite(rua) ? rua : distanciaMetros(ultimaPosicao, p);
  }

  async function atualizarDistanciasRua(cfg) {
    const pendentes = lerParadas(cfg.id).lista.filter((p) => !p.entregue && !p.problema && pontoValido(p));
    if (!pontoValido(ultimaPosicao) || pendentes.length < 2) return false;
    const chave = pendentes.map((p) => p.id).join(',');
    const moveu = distRua.origem ? distanciaMetros(distRua.origem, ultimaPosicao) : Infinity;
    if (chave === distRua.chave && moveu < 150 && Date.now() - distRua.em < 90000) return false;
    const origem = { lat: ultimaPosicao.lat, lon: ultimaPosicao.lon };
    Object.assign(distRua, { chave, origem, em: Date.now() });
    try {
      const response = await fetch(`${cfg.backend}/api/maps/distances`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ origem, destinos: pendentes.map((p) => ({ lat: p.lat, lon: p.lon })) })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(data.distancias)) return false;
      distRua.metros = new Map(pendentes.map((p, i) => [p.id, Number.isFinite(data.distancias[i]) ? data.distancias[i] : NaN]));
      return true;
    } catch (_) {
      return false;
    }
  }

  function paradaMaisPerta(pendentes) {
    const comMapa = pendentes.filter(pontoValido);
    if (!comMapa.length || !pontoValido(ultimaPosicao)) return comMapa[0] || pendentes[0] || null;
    return comMapa.reduce((melhor, p) => (distanciaAteMim(p) < distanciaAteMim(melhor) ? p : melhor));
  }

  // O alvo da navegacao e a parada escolhida ("Ir") ou, sem escolha, a mais perto pela rua.
  // Entrega com problema (cliente nao achado) sai da fila ate a loja responder.
  function aplicarAlvoParadas(cfg) {
    if (!cfg.paradas) return;
    restaurarDoServidor(cfg);
    const dados = lerParadas(cfg.id);
    const pendentes = dados.lista.filter((p) => !p.entregue && !p.problema);
    let ativa = pendentes.find((p) => p.id === dados.ativa);
    const perto = paradaMaisPerta(pendentes);
    if (!ativa || (!dados.ativaManual && perto && perto !== ativa)) {
      ativa = perto;
      if ((ativa?.id || '') !== (dados.ativa || '')) salvarParadas(cfg.id, { ...dados, ativa: ativa?.id || '', ativaManual: false });
    }
    const comProblema = dados.lista.filter((p) => !p.entregue && p.problema).length;
    cfg.alvo = ativa
      ? { lat: ativa.lat, lon: ativa.lon, titulo: ativa.texto, busca: ativa.texto, rotulo: `Entrega ${dados.lista.indexOf(ativa) + 1}` }
      : { lat: 0, lon: 0, titulo: comProblema ? `${comProblema} com problema · fale com a loja` : dados.lista.length ? 'todas marcadas como entregues' : 'adicione os endereços abaixo', rotulo: 'Endereços das notas' };
  }

  async function buscarEndereco(cfg, texto) {
    const dica = cfg.paradas?.cidade || '';
    const params = new URLSearchParams({
      text: dica && !texto.toLowerCase().includes(dica.split(',')[0].toLowerCase()) ? `${texto}, ${dica} - SP` : texto,
      original: texto,
      limit: '4'
    });
    if (pontoValido(ultimaPosicao)) params.set('bias', `proximity:${ultimaPosicao.lon.toFixed(5)},${ultimaPosicao.lat.toFixed(5)}`);
    const response = await fetch(`${cfg.backend}/api/maps/geocode?${params}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || 'Não consegui procurar o endereço agora.');
    const achados = (data.features || []).map((feature) => {
      const props = feature.properties || {};
      const coords = feature.geometry?.coordinates || [];
      return { lat: Number(props.lat ?? coords[1]), lon: Number(props.lon ?? coords[0]), formatado: props.formatted || texto };
    }).filter(pontoValido).slice(0, 4);
    // Sem resultado, o servidor manda as ruas parecidas do cadastro ("Rua X - Bairro").
    const sugestoes = achados.length ? [] : (Array.isArray(data.suggestions) ? data.suggestions : []).map(String).filter(Boolean).slice(0, 3);
    return { achados, sugestoes, mensagem: data.message || '' };
  }

  // "Rua X - Bairro" + numero digitado -> "Rua X, 120, Bairro" para buscar de novo.
  function textoDaSugestao(sugestao, digitado) {
    const [rua, bairro] = sugestao.split(' - ');
    const semRua = digitado.replace(/^[^,\d]*/, '');
    const numero = semRua.match(/\b(\d{1,5}[a-z]?)\b/i)?.[1] || '';
    return [rua, numero, bairro].filter(Boolean).join(', ');
  }

  function carregarLeitorNota() {
    if (window.MotoNota) return Promise.resolve(window.MotoNota);
    return new Promise((ok, erro) => {
      const script = document.createElement('script');
      script.src = './motoboy-nota.js?v=3';
      script.onload = () => (window.MotoNota ? ok(window.MotoNota) : erro(new Error('leitor')));
      script.onerror = () => erro(new Error('leitor'));
      document.head.appendChild(script);
    });
  }

  function htmlParadasNav(cfg) {
    if (!cfg.paradas) return '';
    const dados = lerParadas(cfg.id);
    const total = Number(cfg.paradas.total || 0);
    const pendentes = dados.lista.filter((p) => !p.entregue && !p.problema);
    const comProblema = dados.lista.filter((p) => !p.entregue && p.problema);
    const perto = paradaMaisPerta(pendentes);
    const faltam = total - dados.lista.length;
    const entregues = dados.lista.filter((p) => p.entregue).length;
    const resumo = faltam > 0
      ? `${dados.lista.length} de ${total} endereços · ${faltam === 1 ? 'falta 1' : `faltam ${faltam}`}`
      : `${entregues} de ${dados.lista.length} entregues${comProblema.length ? ` · ${comProblema.length} com problema` : ''}`;
    // Pendentes da mais perto (pela rua) para a mais longe; depois as com problema; entregues no fim.
    const ordenadas = [...pendentes]
      .sort((a, b) => (pontoValido(ultimaPosicao) ? distanciaAteMim(a) - distanciaAteMim(b) : 0) || 0)
      .concat(comProblema, dados.lista.filter((p) => p.entregue));
    const linhas = ordenadas.map((p) => {
      const numero = dados.lista.indexOf(p) + 1;
      const ativa = !p.entregue && !p.problema && p.id === dados.ativa;
      let info;
      if (p.entregue) {
        info = esc(`Entregue${p.entregueEm ? ` ${new Date(p.entregueEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : ''}`);
      } else if (p.problema) {
        info = `<em class="mjnav-problema-tag">⚠️ ${esc(MOTIVOS_PROBLEMA[p.problema] || 'Problema')} · loja avisada</em>`;
      } else {
        const dist = pontoValido(p) ? textoKm(distanciaAteMim(p)) : 'sem mapa';
        const pelaRua = Number.isFinite(distRua.metros.get(p.id)) ? ' pela rua' : '';
        const marcas = [p === perto && pendentes.length > 1 ? 'mais perto' : '', ativa ? 'indo agora' : ''].filter(Boolean).join(' · ');
        info = `${esc(dist === '-' ? '' : dist)}${dist !== '-' && dist !== 'sem mapa' ? `${pelaRua}` : ''}${marcas ? `${dist === '-' ? '' : ' · '}<em>${marcas}</em>` : dist !== '-' && dist !== 'sem mapa' ? ' de você' : ''}`;
      }
      const botoes = p.entregue
        ? `<button type="button" class="mjnav-mini" data-mjnav-desfazer="${esc(p.id)}" aria-label="Desfazer entrega ${numero}">↺</button>`
        : p.problema
          ? `<button type="button" class="mjnav-mini" data-mjnav-voltar="${esc(p.id)}" aria-label="Voltar a entrega ${numero} para a fila">↺ Fila</button><button type="button" class="mjnav-mini ok" data-mjnav-ok="${esc(p.id)}" aria-label="Marcar entrega ${numero} como entregue">✓</button>`
          : `${ativa ? '' : `<button type="button" class="mjnav-mini" data-mjnav-ir="${esc(p.id)}">Ir</button>`}<button type="button" class="mjnav-mini ok" data-mjnav-ok="${esc(p.id)}" aria-label="Marcar entrega ${numero} como entregue">${ativa ? '✓ Entregue' : '✓'}</button><button type="button" class="mjnav-mini aviso" data-mjnav-problema="${esc(p.id)}" aria-label="Não encontrei o cliente da entrega ${numero}">⚠️</button><button type="button" class="mjnav-mini x" data-mjnav-del="${esc(p.id)}" aria-label="Remover endereço ${numero}">✕</button>`;
      const painel = paradaProblema === p.id && !p.entregue
        ? `<div class="mjnav-problema" data-mjnav-problema-painel="${esc(p.id)}">
            <b>Qual o problema na entrega ${numero}?</b>
            <div class="mjnav-motivos">${Object.entries(MOTIVOS_PROBLEMA).map(([chave, texto]) => `<button type="button" class="mjnav-mini" data-mjnav-motivo="${chave}">${esc(texto)}</button>`).join('')}</div>
            <input type="text" data-mjnav-problema-obs maxlength="200" placeholder="Detalhe para a loja (opcional)">
            <div class="mjnav-motivos"><button type="button" class="mjnav-mini laranja" data-mjnav-problema-enviar disabled>Avisar a loja</button><button type="button" class="mjnav-mini" data-mjnav-problema-cancelar>Cancelar</button></div>
          </div>`
        : '';
      return `<div class="mjnav-parada${ativa ? ' ativa' : ''}${p.entregue ? ' feita' : ''}${p.problema ? ' problema' : ''}">
        <span class="mjnav-num">${p.entregue ? '✓' : numero}</span>
        <div class="mjnav-parada-txt"><b>${esc(p.texto)}</b><span>${info}</span></div>
        ${botoes}
      </div>${painel}`;
    }).join('');
    const formAberto = faltam > 0 || paradaFormAberto === cfg.id;
    return `<div class="mjnav-paradas">
      <div class="mjnav-paradas-head"><b>📝 Endereços das notas</b><span>${esc(resumo)}</span></div>
      ${linhas}
      ${formAberto
        ? `<form class="mjnav-add" data-mjnav-add-form>
            <button type="button" class="mjnav-mini mjnav-cam" data-mjnav-cam aria-label="Escanear o endereço da nota com a câmera">📷</button>
            <input type="file" accept="image/*" data-mjnav-foto hidden>
            <input type="text" name="endereco" placeholder="Endereço da nota ${dados.lista.length + 1}: rua, número, bairro" autocomplete="off" enterkeyhint="search" maxlength="160">
            <button type="submit" class="mjnav-mini laranja">Buscar</button>
          </form>
          <div class="mjnav-resultados" data-mjnav-resultados></div>`
        : '<button type="button" class="mjnav-act mjnav-add-btn" data-mjnav-add>+ Adicionar endereço</button>'}
    </div>`;
  }

  function ligarParadas(cfg) {
    const caixa = cfg.paradas && ui().querySelector('.mjnav-paradas');
    if (!caixa) return;
    const atualizar = (focar) => {
      if (tela) tela.editando = false;
      paradaFocar = focar ? cfg.id : '';
      sincronizarParadas(cfg);
      aplicarAlvoParadas(cfg);
      renderNav(cfg, null);
      if (window.L && tela?.cfg === cfg) {
        atualizarRotaNav(window.L, cfg, true).then(() => {
          paradaFocar = '';
          if (tela?.cfg !== cfg) return;
          // Mostra no mapa todos os numeros que faltam; o botao ◎ volta a seguir o GPS.
          const pendentes = lerParadas(cfg.id).lista.filter((p) => !p.entregue && pontoValido(p));
          if (pendentes.length > 1) {
            seguirMotoboy = false;
            root.querySelector('[data-mjnav-centralizar]')?.classList.add('show');
            enquadrar([ultimaPosicao, ...pendentes], alturaRodape());
          } else enquadrarNav(cfg);
        });
      }
    };
    const mudar = (id, fn) => {
      const dados = lerParadas(cfg.id);
      const parada = dados.lista.find((p) => p.id === id);
      if (!parada) return;
      fn(parada, dados);
      salvarParadas(cfg.id, dados);
      atualizar(false);
    };
    caixa.querySelectorAll('[data-mjnav-ir]').forEach((btn) => {
      btn.onclick = () => mudar(btn.dataset.mjnavIr, (p, dados) => { dados.ativa = p.id; dados.ativaManual = true; });
    });
    caixa.querySelectorAll('[data-mjnav-ok]').forEach((btn) => {
      btn.onclick = () => mudar(btn.dataset.mjnavOk, (p, dados) => {
        p.entregue = true;
        p.entregueEm = Date.now();
        p.problema = '';
        // Onde o motoboy estava ao entregar: ensina o app onde esse endereco fica.
        const gpsRecente = pontoValido(ultimaPosicao) && Date.now() - Number(ultimaPosicao.em || 0) < 60000;
        p.gpsEntrega = gpsRecente ? { lat: ultimaPosicao.lat, lon: ultimaPosicao.lon, precisao: Math.round(Number(ultimaPosicao.precisao) || 9999), em: Date.now() } : null;
        if (dados.ativa === p.id) dados.ativa = '';
      });
    });
    caixa.querySelectorAll('[data-mjnav-desfazer]').forEach((btn) => {
      btn.onclick = () => mudar(btn.dataset.mjnavDesfazer, (p) => {
        p.entregue = false;
        p.entregueEm = 0;
        p.gpsEntrega = null;
      });
    });
    caixa.querySelectorAll('[data-mjnav-voltar]').forEach((btn) => {
      btn.onclick = () => mudar(btn.dataset.mjnavVoltar, (p) => { p.problema = ''; });
    });
    // ⚠️ Nao encontrei o cliente: escolhe o motivo, avisa a loja pelo chat (toca na empresa)
    // e a entrega vai para o fim da fila.
    caixa.querySelectorAll('[data-mjnav-problema]').forEach((btn) => {
      btn.onclick = () => {
        paradaProblema = btn.dataset.mjnavProblema;
        if (tela) tela.editando = true;
        renderNav(cfg, tela?.rota || null);
      };
    });
    const painel = caixa.querySelector('[data-mjnav-problema-painel]');
    if (painel) {
      let motivo = '';
      const enviar = painel.querySelector('[data-mjnav-problema-enviar]');
      painel.querySelectorAll('[data-mjnav-motivo]').forEach((btn) => {
        btn.onclick = () => {
          motivo = btn.dataset.mjnavMotivo;
          painel.querySelectorAll('[data-mjnav-motivo]').forEach((b) => b.classList.toggle('laranja', b === btn));
          enviar.disabled = false;
        };
      });
      painel.querySelector('[data-mjnav-problema-cancelar]').onclick = () => {
        paradaProblema = '';
        atualizar(false);
      };
      enviar.onclick = async () => {
        const id = painel.dataset.mjnavProblemaPainel;
        const obs = painel.querySelector('[data-mjnav-problema-obs]').value.trim();
        const dados = lerParadas(cfg.id);
        const parada = dados.lista.find((p) => p.id === id);
        if (!parada || !motivo) return;
        enviar.disabled = true;
        enviar.textContent = 'Avisando...';
        const numero = dados.lista.indexOf(parada) + 1;
        const texto = `⚠️ Entrega ${numero} (${parada.texto}): ${MOTIVOS_PROBLEMA[motivo]}.${obs ? ` ${obs.replace(/[.!?\s]*$/, '.')}` : ''} Pode me ajudar?`;
        try {
          const response = await fetch(`${cfg.backend}/api/deliveries/${encodeURIComponent(cfg.id)}/chat/send`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...cfg.prova, texto })
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.message || 'Não consegui avisar a loja agora.');
        } catch (error) {
          enviar.disabled = false;
          enviar.textContent = 'Avisar a loja';
          alert(`${error.message || 'Não consegui avisar a loja agora.'} Tente de novo ou ligue para a loja.`);
          return;
        }
        paradaProblema = '';
        mudar(id, (p, d) => {
          p.problema = motivo;
          if (d.ativa === p.id) { d.ativa = ''; d.ativaManual = false; }
        });
        cfg.cliente?.chat?.();
      };
    }
    caixa.querySelectorAll('[data-mjnav-del]').forEach((btn) => {
      btn.onclick = () => {
        const dados = lerParadas(cfg.id);
        const parada = dados.lista.find((p) => p.id === btn.dataset.mjnavDel);
        if (!parada || !confirm(`Remover o endereço "${parada.texto}"?`)) return;
        dados.lista = dados.lista.filter((p) => p !== parada);
        if (dados.ativa === parada.id) dados.ativa = '';
        salvarParadas(cfg.id, dados);
        atualizar(false);
      };
    });
    const abrirForm = caixa.querySelector('[data-mjnav-add]');
    if (abrirForm) abrirForm.onclick = () => {
      paradaFormAberto = cfg.id;
      renderNav(cfg, tela?.rota || null);
      ui().querySelector('[data-mjnav-add-form] input[name="endereco"]')?.focus();
    };
    const form = caixa.querySelector('[data-mjnav-add-form]');
    if (!form) return;
    const input = form.querySelector('input[name="endereco"]');
    const resultados = caixa.querySelector('[data-mjnav-resultados]');
    // Depois de adicionar um endereco, ja deixa o campo pronto para a proxima nota.
    if (paradaFocar === cfg.id) input.focus();
    // Enquanto digita, o GPS e a lista nao redesenham a tela (perderia o texto).
    input.oninput = () => {
      if (tela) tela.editando = !!input.value.trim();
    };
    const adicionar = (texto, achado) => {
      const dados = lerParadas(cfg.id);
      dados.lista.push({
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        texto,
        encontrado: achado?.formatado || '',
        lat: achado ? achado.lat : 0,
        lon: achado ? achado.lon : 0,
        entregue: false
      });
      salvarParadas(cfg.id, dados);
      const total = Number(cfg.paradas.total || 0);
      if (dados.lista.length >= total) paradaFormAberto = '';
      atualizar(dados.lista.length < total || paradaFormAberto === cfg.id);
    };
    const buscar = async () => {
      const texto = input.value.trim();
      if (texto.length < 4) {
        resultados.innerHTML = '<p class="mjnav-erro">Digite a rua e o número que estão na nota.</p>';
        return;
      }
      if (tela) tela.editando = true;
      resultados.innerHTML = '<p class="mjnav-busca">Procurando no mapa...</p>';
      let busca = { achados: [], sugestoes: [], mensagem: '' };
      let falha = '';
      try {
        busca = await buscarEndereco(cfg, texto);
      } catch (error) {
        falha = error?.message || 'Não consegui procurar o endereço agora.';
      }
      if (tela?.cfg !== cfg || !resultados.isConnected) return;
      const { achados, sugestoes } = busca;
      // Rua escrita errada na nota: mostra as ruas parecidas para o motoboy escolher e ir conferir.
      const aviso = achados.length
        ? '<p class="mjnav-busca">Toque no endereço certo:</p>'
        : sugestoes.length
          ? '<p class="mjnav-erro">Não achei essa rua exata. Será alguma destas?</p>'
          : `<p class="mjnav-erro">${esc(falha || busca.mensagem || 'Não achei esse endereço no mapa. Confira rua e número.')}</p>`;
      resultados.innerHTML = `${aviso}
        ${achados.map((achado, index) => `<button type="button" class="mjnav-achado" data-mjnav-achado="${index}">📍 ${esc(achado.formatado)}<small>${esc(textoKm(distanciaAteMim(achado)))}${pontoValido(ultimaPosicao) ? ' de você' : ''}</small></button>`).join('')}
        ${sugestoes.map((sugestao, index) => `<button type="button" class="mjnav-achado sugestao" data-mjnav-sugestao="${index}">🔎 ${esc(sugestao)}<small>toque para procurar esta rua</small></button>`).join('')}
        <button type="button" class="mjnav-achado sem" data-mjnav-sem-mapa>Adicionar só o texto, sem mapa</button>`;
      resultados.querySelectorAll('[data-mjnav-achado]').forEach((btn) => {
        btn.onclick = () => adicionar(texto, achados[Number(btn.dataset.mjnavAchado)]);
      });
      resultados.querySelectorAll('[data-mjnav-sugestao]').forEach((btn) => {
        btn.onclick = () => {
          input.value = textoDaSugestao(sugestoes[Number(btn.dataset.mjnavSugestao)], texto);
          buscar();
        };
      });
      resultados.querySelector('[data-mjnav-sem-mapa]').onclick = () => adicionar(texto, null);
    };
    form.onsubmit = (event) => {
      event.preventDefault();
      buscar();
    };

    // 📷: abre a camera dentro da tela (o app Android perde a foto se for para o app de camera).
    // O motoboy mira no endereco (nota, tela do PC, papel) e o app le sozinho e preenche.
    // "Galeria" escolhe uma foto ja tirada.
    const foto = form.querySelector('[data-mjnav-foto]');
    const abrirGaleria = () => {
      if (tela) tela.editando = true;
      foto.value = '';
      foto.click();
    };
    form.querySelector('[data-mjnav-cam]').onclick = async () => {
      if (tela) tela.editando = true;
      let abriu = false;
      try {
        const leitor = await carregarLeitorNota();
        abriu = await leitor.abrirCamera({
          aoEndereco: (texto) => usarEnderecoLido(texto),
          aoFoto: (blob) => lerFotoDaNota(cfg, blob),
          aoGaleria: abrirGaleria,
          aoFechar: () => { if (tela) tela.editando = !!ui().querySelector('[data-mjnav-add-form] input[name="endereco"]')?.value.trim(); }
        });
      } catch (_) {}
      if (!abriu) abrirGaleria();
    };
    foto.oncancel = () => {
      if (tela) tela.editando = !!input.value.trim();
      const lista = ui().querySelector('[data-mjnav-resultados]');
      if (lista) lista.innerHTML = '<p class="mjnav-erro">A foto não chegou ao app. Tire a foto com a câmera do celular e depois escolha pela galeria, ou digite o endereço.</p>';
    };
    foto.onchange = () => {
      const arquivo = foto.files?.[0];
      if (!arquivo) {
        foto.oncancel();
        return;
      }
      lerFotoDaNota(cfg, arquivo);
    };
  }

  // Coloca o endereco lido no campo que esta na tela agora e ja procura no mapa
  // (a tela pode ter sido redesenhada enquanto a camera estava aberta).
  function usarEnderecoLido(texto) {
    const form = ui().querySelector('[data-mjnav-add-form]');
    const input = form?.querySelector('input[name="endereco"]');
    if (!form || !input) return;
    input.value = texto;
    if (tela) tela.editando = true;
    form.requestSubmit();
  }

  async function lerFotoDaNota(cfg, arquivo) {
    const lista = () => ui().querySelector('[data-mjnav-resultados]');
    const progresso = (texto) => { const el = lista(); if (el) el.innerHTML = `<p class="mjnav-busca">${texto}</p>`; };
    if (tela) tela.editando = true;
    progresso('📷 Lendo a nota no celular...');
    let leitura = { enderecos: [], fonte: '', aviso: '' };
    try {
      const leitor = await carregarLeitorNota();
      leitura = await leitor.lerEndereco(arquivo, {
        backend: cfg.backend,
        cpf: cfg.prova?.driverCpf,
        prova: cfg.prova,
        aoProgresso: (p) => progresso(`📷 Lendo a nota no celular... ${Math.round(p * 100)}%`),
        aoReserva: () => progresso('📷 Não achei o endereço na foto. Tentando a leitura reserva...')
      });
    } catch (_) {
      leitura.aviso = 'Não consegui abrir o leitor agora. Confira a internet ou digite o endereço.';
    }
    if (tela?.cfg?.id !== cfg.id || !lista()) return;
    if (leitura.enderecos.length === 1) return usarEnderecoLido(leitura.enderecos[0]);
    if (leitura.enderecos.length > 1) {
      lista().innerHTML = `<p class="mjnav-busca">Achei mais de um endereço na nota. Qual é o da entrega?</p>
        ${leitura.enderecos.map((e, index) => `<button type="button" class="mjnav-achado" data-mjnav-lido="${index}">🧾 ${esc(e)}</button>`).join('')}`;
      lista().querySelectorAll('[data-mjnav-lido]').forEach((btn) => {
        btn.onclick = () => usarEnderecoLido(leitura.enderecos[Number(btn.dataset.mjnavLido)]);
      });
      return;
    }
    const input = ui().querySelector('[data-mjnav-add-form] input[name="endereco"]');
    if (tela) tela.editando = !!input?.value.trim();
    lista().innerHTML = `<p class="mjnav-erro">${esc(leitura.aviso || 'Não consegui ler o endereço na foto. Tente de novo mais perto e com luz, ou digite.')}</p>`;
    input?.focus();
  }

  function linksNavegacao(alvo) {
    if (!pontoValido(alvo)) {
      // Endereco da nota que o mapa nao achou: abre a busca pelo texto.
      if (!alvo?.busca) return { waze: '', maps: '' };
      const q = encodeURIComponent(alvo.busca);
      return { waze: `https://waze.com/ul?q=${q}&navigate=yes`, maps: `https://www.google.com/maps/search/?api=1&query=${q}` };
    }
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
            ${typeof cliente.chat === 'function' ? `<button type="button" class="mjnav-round" data-mjnav-chat aria-label="${cfg.paradas ? 'Chat com a loja' : 'Chat com o cliente'}" style="position:relative">💬${cliente.chatNaoLido ? '<span class="mjchat-badge" style="position:absolute;top:2px;right:2px;margin:0"></span>' : ''}</button>${cfg.paradas && fone ? `<a class="mjnav-round" href="tel:${esc(fone)}" aria-label="Ligar para a loja">📞</a>` : ''}` : fone ? `<a class="mjnav-round" href="https://api.whatsapp.com/send?phone=55${esc(fone)}" target="_blank" rel="noopener" aria-label="WhatsApp">💬</a><a class="mjnav-round" href="tel:${esc(fone)}" aria-label="Ligar">📞</a>` : ''}
          </div>
        </div>
        ${htmlParadasNav(cfg)}
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
    const chatBotao = ui().querySelector('[data-mjnav-chat]');
    if (chatBotao) chatBotao.onclick = () => {
      chatBotao.querySelector('.mjchat-badge')?.remove();
      cliente.chat();
    };
    const principal = ui().querySelector('[data-mjnav-principal]');
    if (principal) principal.onclick = () => executar(principal, cfg.principal);
    ligarParadas(cfg);
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
    // Lote: com a distancia pela rua, a "mais perto" pode mudar (se o motoboy nao escolheu outra).
    if (cfg.paradas && !tela?.editando && await atualizarDistanciasRua(cfg)) {
      const antes = `${cfg.alvo?.lat},${cfg.alvo?.lon}`;
      aplicarAlvoParadas(cfg);
      if (`${cfg.alvo?.lat},${cfg.alvo?.lon}` !== antes) forcar = true;
    }
    const eu = ultimaPosicao;
    const chave = `${cfg.id}:${cfg.etapa}:${Number(cfg.alvo?.lat || 0).toFixed(5)},${Number(cfg.alvo?.lon || 0).toFixed(5)}`;
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
    if (cfg.paradas) {
      const dados = lerParadas(cfg.id);
      dados.lista.forEach((p, index) => {
        if (!pontoValido(p)) return;
        const estado = p.entregue ? 'feita' : p.id === dados.ativa ? 'ativa' : '';
        adicionar(L.marker([p.lat, p.lon], { icon: iconeNumero(L, index + 1, estado), zIndexOffset: estado === 'ativa' ? 600 : 0 }));
      });
    } else if (pontoValido(cfg.alvo)) {
      adicionar(L.marker([cfg.alvo.lat, cfg.alvo.lon], { icon: iconePino(L, cfg.etapa === 'levar' ? 'destino' : cfg.tipo === 'entrega' ? 'pacote' : 'coleta') }));
    }
    atual.rota = rota;
    // Nao redesenha os botoes no meio de uma acao (ex.: "Avisando cliente...")
    // nem enquanto o motoboy digita um endereco de nota.
    if (!atual.ocupado && !atual.editando) renderNav(atual.cfg, rota);
  }

  async function abrirNavegacao(cfg) {
    pararAlarme();
    pararContagem();
    aplicarAlvoParadas(cfg);
    const mesmaEtapa = tela?.modo === 'nav' && tela.cfg.id === cfg.id && tela.cfg.etapa === cfg.etapa &&
      Number(tela.cfg.alvo?.lat || 0) === Number(cfg.alvo?.lat || 0) && Number(tela.cfg.alvo?.lon || 0) === Number(cfg.alvo?.lon || 0);
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
    ocupado: () => !!(tela?.ocupado || tela?.editando),
    modo: () => tela?.modo || '',
    idAtual: () => tela?.cfg?.id || '',
    tipo: () => tela?.cfg?.tipo || '',
    alarmeTocando: () => alarmeTimer !== null,
    carregarLeaflet
  };
})();
