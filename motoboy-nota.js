(function () {
  'use strict';

  // Le o endereco de entrega da foto de uma nota.
  // 1) No proprio celular (Tesseract.js): a foto nao sai do aparelho.
  // 2) Se o celular nao achar endereco, pede ao servidor (Gemini, so enquanto tem
  //    limite gratis). Sem limite, devolve vazio e o motoboy digita.
  const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  const OCIOSO_MS = 2 * 60 * 1000;
  let carregando = null;
  let worker = null;
  let ociosoTimer = null;

  function carregarTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (!carregando) {
      carregando = new Promise((ok, erro) => {
        const script = document.createElement('script');
        script.src = TESSERACT_URL;
        script.async = true;
        script.onload = () => (window.Tesseract ? ok(window.Tesseract) : erro(new Error('leitor_indisponivel')));
        script.onerror = () => { carregando = null; erro(new Error('leitor_indisponivel')); };
        document.head.appendChild(script);
      });
    }
    return carregando;
  }

  // O mesmo leitor serve para todas as notas do lote; fecha depois de 2 min sem uso.
  async function leitor(aoProgresso) {
    clearTimeout(ociosoTimer);
    if (!worker) {
      const Tesseract = await carregarTesseract();
      worker = Tesseract.createWorker('por', 1, {
        logger: (m) => {
          if (m.status === 'recognizing text') aoProgresso?.(0.3 + 0.7 * (m.progress || 0));
          else if (/loading|initializ/.test(m.status || '')) aoProgresso?.(0.3 * (m.progress || 0));
        }
      }).catch((error) => { worker = null; throw error; });
    }
    return worker;
  }

  function soltarLeitor() {
    clearTimeout(ociosoTimer);
    ociosoTimer = setTimeout(async () => {
      const atual = worker;
      worker = null;
      try { (await atual)?.terminate(); } catch (_) {}
    }, OCIOSO_MS);
  }

  function carregarImagem(arquivo) {
    return new Promise((ok, erro) => {
      const url = URL.createObjectURL(arquivo);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); ok(img); };
      img.onerror = () => { URL.revokeObjectURL(url); erro(new Error('foto_invalida')); };
      img.src = url;
    });
  }

  // Reduz a foto e passa para tons de cinza com mais contraste (papel termico apagado).
  function prepararCanvas(img, maior, contraste) {
    const largura = img.naturalWidth || img.width;
    const altura = img.naturalHeight || img.height;
    const escala = Math.min(1, maior / Math.max(largura, altura));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(largura * escala));
    canvas.height = Math.max(1, Math.round(altura * escala));
    const ctx = canvas.getContext('2d', { willReadFrequently: contraste });
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    if (contraste) {
      const dados = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const px = dados.data;
      for (let i = 0; i < px.length; i += 4) {
        const cinza = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        const v = Math.max(0, Math.min(255, (cinza - 128) * 1.6 + 128));
        px[i] = px[i + 1] = px[i + 2] = v;
      }
      ctx.putImageData(dados, 0, 0);
    }
    return canvas;
  }

  // O leitor recebe JPEG: canvas ou PNG as vezes chegam em branco para ele (fundo colorido,
  // tela do PC) e a leitura volta vazia.
  function paraJpeg(canvas) {
    return new Promise((ok) => canvas.toBlob((blob) => ok(blob || canvas.toDataURL('image/jpeg', 0.92)), 'image/jpeg', 0.92));
  }

  const TIPO = /\b(?:rua|r\.|av\.?|avenida|travessa|tv\.|trav\.?|estrada|est\.|rodovia|rod\.|alameda|al\.|pra[cç]a|viela)\s+\S/i;
  const ROTULO = /^(?:endere[cç]o(?:\s+(?:de|da|para)\s+entrega)?|end\.?|entregar\s+(?:em|na|no)|local(?:\s+de\s+entrega)?|destino)\s*[:\-–]?\s*/i;
  const BAIRRO = /^(?:bairro|b\.)\s*[:\-–]?\s*/i;
  const COMECO_BAIRRO = /^(?:jd\.?|jardim|vila|vl\.?|parque|pq\.?|residencial|res\.|centro|conjunto|cj\.?|chac[aá]ra|distrito|loteamento|condom[ií]nio)\b/i;
  const RUIDO = /\b(?:cep|tel(?:efone)?|fone|cel(?:ular)?|whats(?:app)?|cpf|cnpj|cliente|pedido|total|troco|pagamento)\b.*$/i;

  function limparLinha(linha) {
    return String(linha || '').replace(/[|_~^`´¨"“”]+/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/[,;\s]*\b\d{1,2}[:.]\d{2}\b[\s.,]*$/, '').trim();
  }

  // "R," "R:" e "Av" sem ponto: o leitor costuma errar a pontuacao do tipo da rua.
  const TOKEN_RUA = /(?:^|[\s,;—–-])((?:rua|r|av|avenida|al|alameda|tv|trav|travessa|est|estr|estrada|rod|rodovia|pra[cç]a)[\s.,:]+(?=[A-Za-zÀ-ú]))/i;

  // Camera mirando num endereco solto (tela do PC, papel): escolhe a UMA linha que mais
  // parece "rua + numero" e ignora o resto (fundo da tela, horario, lixo da leitura).
  function melhorLinhaSolta(linhas) {
    let melhor = null;
    for (const bruta of linhas) {
      let linha = limparLinha(bruta);
      if (/r\$|\d+[.,]\d{2}\b/i.test(linha)) continue;
      const tipo = linha.match(TOKEN_RUA);
      if (tipo) linha = linha.slice(tipo.index + tipo[0].indexOf(tipo[1]));
      linha = linha.replace(RUIDO, '').trim();
      const numero = linha.match(/\b\d{1,5}[a-z]?\b/i);
      if (!numero) continue;
      const antes = linha.slice(0, numero.index).trim();
      const palavras = antes.split(/\s+/).filter(Boolean);
      const boas = palavras.filter((p) => /^[a-zà-ú][a-zà-ú.,]{1,}$/i.test(p)).length;
      if (!boas || !/[a-zà-ú]{3,}/i.test(antes)) continue;
      // Depois do numero so fica o que parece bairro (palavras); para no primeiro simbolo estranho.
      const depois = linha.slice(numero.index + numero[0].length).match(/^[\s,\-–]*([A-Za-zÀ-ú][A-Za-zÀ-ú\s.]{2,40})?/)?.[1] || '';
      const lixo = (antes.match(/[^a-zà-ú0-9\s,.\-º°]/gi) || []).length;
      const pontos = (tipo ? 3 : 0) + Math.min(boas, 4) - lixo * 1.5 - (palavras.length - boas);
      const texto = `${antes} ${numero[0]}${depois.trim() ? `, ${depois.trim()}` : ''}`.replace(/\s+/g, ' ').replace(/\s+,/g, ',').slice(0, 120);
      if (!melhor || pontos > melhor.pontos) melhor = { pontos, texto };
    }
    // "R, Dr. Altino" -> "R. Dr. Altino"
    return melhor && melhor.pontos >= 2 ? melhor.texto.replace(/^r[,:]\s*/i, 'R. ') : '';
  }

  // Tira do texto lido as linhas que parecem endereco de entrega (rua, numero e bairro).
  // solto: o texto veio so da moldura da camera; sem "Rua"/"Av" aceita "Nome 123".
  function enderecosDoTexto(texto, { solto = false } = {}) {
    const linhas = String(texto || '').split(/\r?\n/).map(limparLinha).filter(Boolean);
    const bairroSolto = linhas.map((l) => (BAIRRO.test(l) ? l.replace(BAIRRO, '').replace(RUIDO, '').trim() : '')).find((b) => b.length >= 3) || '';
    const achados = [];
    linhas.forEach((linha, i) => {
      const comRotulo = ROTULO.test(linha);
      let resto = linha.replace(ROTULO, '');
      const tipo = resto.match(TIPO);
      if (!tipo && !(comRotulo && /[a-z]{3}/i.test(resto))) return;
      if (tipo) resto = resto.slice(tipo.index);
      resto = resto.replace(RUIDO, '').replace(/[\s,;.\-–]+$/, '').trim();
      if (resto.length < 5) return;
      let seguinte = linhas[i + 1] || '';
      // Numero ou bairro que a nota imprimiu na linha de baixo.
      if (!/\d/.test(resto) && /^(?:n[º°o.]*\s*)?\d{1,5}[a-z]?\b/i.test(seguinte)) {
        resto += `, ${seguinte.match(/\d{1,5}[a-z]?/i)[0]}`;
        seguinte = linhas[i + 2] || '';
      } else if (!/\d/.test(resto) && /\d/.test(seguinte) && !TIPO.test(seguinte) && !BAIRRO.test(seguinte) && !RUIDO.test(seguinte)) {
        // Nome da rua que continua na linha de baixo ("R. Eduardo Rogerio" / "Barbosa, 84").
        resto = `${resto} ${seguinte}`.replace(/[\s,;.\-–]+$/, '');
        seguinte = linhas[i + 2] || '';
      }
      const bairroAbaixo = BAIRRO.test(seguinte) ? seguinte.replace(BAIRRO, '') : COMECO_BAIRRO.test(seguinte) ? seguinte : '';
      const bairro = limparLinha(bairroAbaixo.replace(RUIDO, '')) || (!/,.*[a-z]{3}.*$/i.test(resto.replace(/^[^,]*,\s*\d+/, '')) ? bairroSolto : '');
      if (bairro && !resto.toLowerCase().includes(bairro.toLowerCase())) resto += `, ${bairro}`;
      achados.push(resto.slice(0, 140));
    });
    if (solto) {
      // Na camera vale so a melhor linha; o "achado" com rua e numero tem preferencia.
      const comNumero = achados.find((a) => /\d/.test(a) && a.length <= 90);
      const linha = comNumero || melhorLinhaSolta(linhas);
      return linha ? [linha] : [];
    }
    return [...new Set(achados)].slice(0, 3);
  }

  async function lerNoCelular(img, aoProgresso) {
    const w = await leitor(aoProgresso);
    try {
      await w.setParameters({ tessedit_pageseg_mode: '3' }).catch(() => {});
      const { data } = await w.recognize(await paraJpeg(prepararCanvas(img, 1800, true)));
      return enderecosDoTexto(data?.text || '');
    } finally {
      soltarLeitor();
    }
  }

  async function lerComIa(img, opcoes) {
    if (!opcoes.backend || !opcoes.cpf || !opcoes.prova) return { enderecos: [], aviso: '' };
    const imagem = prepararCanvas(img, 1280, false).toDataURL('image/jpeg', 0.72);
    const response = await fetch(`${opcoes.backend}/api/drivers/${encodeURIComponent(opcoes.cpf)}/ler-nota`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...opcoes.prova, imagem })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { enderecos: [], aviso: data.message || '' };
    return { enderecos: (data.enderecos || []).map(limparLinha).filter((e) => e.length >= 5).slice(0, 3), aviso: '' };
  }

  // Resultado: { enderecos: [...], fonte: 'celular' | 'ia' | '', aviso }
  async function lerEndereco(arquivo, opcoes = {}) {
    const img = await carregarImagem(arquivo);
    let falhaCelular = false;
    try {
      const enderecos = await lerNoCelular(img, opcoes.aoProgresso);
      if (enderecos.length) return { enderecos, fonte: 'celular', aviso: '' };
    } catch (_) {
      falhaCelular = true;
    }
    opcoes.aoReserva?.();
    try {
      const ia = await lerComIa(img, opcoes);
      if (ia.enderecos.length) return { enderecos: ia.enderecos, fonte: 'ia', aviso: '' };
      return { enderecos: [], fonte: '', aviso: ia.aviso || (falhaCelular ? 'Não consegui abrir o leitor agora. Confira a internet ou digite o endereço.' : '') };
    } catch (_) {
      return { enderecos: [], fonte: '', aviso: '' };
    }
  }

  // ---------- Camera dentro da propria tela ----------
  // O app Android (WebView) perde a foto quando abre o app de camera do celular: o Android
  // pode fechar o MotoJa enquanto a camera esta aberta. Aqui a camera abre dentro da tela,
  // com uma moldura para o endereco; so a parte da moldura vai para a leitura.
  function estiloScanner() {
    if (document.getElementById('mjnota-estilo')) return;
    const style = document.createElement('style');
    style.id = 'mjnota-estilo';
    style.textContent = `
      .mjnota-cam{position:fixed;inset:0;z-index:100001;background:#000;display:flex;flex-direction:column;color:#fff;font-family:system-ui,sans-serif}
      .mjnota-cam video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
      .mjnota-moldura{position:absolute;left:5%;width:90%;top:28%;height:30%;border:3px solid #ff9a00;border-radius:14px;box-shadow:0 0 0 100vmax rgba(0,0,0,.45)}
      .mjnota-dica{position:absolute;left:0;right:0;top:calc(28% - 46px);text-align:center;font-weight:800;font-size:15px;text-shadow:0 1px 4px #000}
      .mjnota-erro{position:absolute;left:16px;right:16px;top:40%;text-align:center;background:#2a1408;border:1px solid #ff9a00;border-radius:12px;padding:14px}
      .mjnota-barra{position:absolute;left:0;right:0;bottom:0;padding:18px 18px calc(22px + env(safe-area-inset-bottom));display:flex;align-items:center;justify-content:space-between;gap:10px;background:linear-gradient(transparent,rgba(0,0,0,.75))}
      .mjnota-barra button{border:0;border-radius:12px;padding:12px 14px;font:inherit;font-weight:800;font-size:14px;background:#23262f;color:#fff;min-width:84px}
      .mjnota-barra .mjnota-ler{width:78px;height:78px;min-width:0;border-radius:50%;background:#ff9a00;color:#111;font-size:15px;border:5px solid #fff}
      .mjnota-barra .mjnota-ler:disabled{opacity:.5}
      .mjnota-moldura.ok{border-color:#35c979}
      .mjnota-achado{position:absolute;left:5%;right:5%;top:calc(58% + 14px);display:flex;gap:10px;align-items:center;padding:10px 12px;border-radius:12px;background:rgba(10,40,22,.92);border:1px solid #35c979;font-weight:700;font-size:15px}
      .mjnota-achado[hidden]{display:none}
      .mjnota-achado span{flex:1;overflow-wrap:anywhere}
      .mjnota-achado button{border:0;border-radius:10px;padding:9px 12px;background:#35c979;color:#06210f;font-weight:800;font:inherit}`;
    document.head.appendChild(style);
  }

  const comparavel = (texto) => String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

  // Abre a camera na tela e le sozinha o que esta na moldura (nota, tela do PC, papel).
  // Mesmo endereco lido duas vezes seguidas: vibra, mostra e preenche (aoEndereco).
  // "Ler" manda o recorte para a leitura completa (com a reserva do servidor) via aoFoto.
  // Devolve false se o aparelho/app nao liberar a camera (ai usa a galeria).
  async function abrirCamera({ aoEndereco, aoFoto, aoGaleria, aoFechar }) {
    if (!navigator.mediaDevices?.getUserMedia) return false;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      });
    } catch (_) {
      return false;
    }
    estiloScanner();
    const tela = document.createElement('div');
    tela.className = 'mjnota-cam';
    tela.setAttribute('role', 'dialog');
    tela.setAttribute('aria-label', 'Escanear o endereço');
    tela.innerHTML = `<video playsinline muted autoplay></video>
      <div class="mjnota-dica" aria-live="polite">Mire no endereço</div>
      <div class="mjnota-moldura"></div>
      <div class="mjnota-achado" hidden><span></span><button type="button" data-usar>Usar este</button></div>
      <div class="mjnota-barra">
        <button type="button" data-galeria>🖼️ Galeria</button>
        <button type="button" class="mjnota-ler" data-ler aria-label="Ler agora">Ler</button>
        <button type="button" data-fechar>✕ Fechar</button>
      </div>`;
    document.body.appendChild(tela);
    const video = tela.querySelector('video');
    const dica = tela.querySelector('.mjnota-dica');
    const achadoBox = tela.querySelector('.mjnota-achado');
    const moldura = tela.querySelector('.mjnota-moldura');
    video.srcObject = stream;
    video.play().catch(() => {});
    const [faixa] = stream.getVideoTracks();
    // Lanterna, quando o celular tem (entrega a noite).
    try {
      if (faixa?.getCapabilities?.().torch) {
        const luz = document.createElement('button');
        luz.type = 'button';
        luz.textContent = '🔦';
        luz.style.minWidth = '56px';
        let ligada = false;
        luz.onclick = () => { ligada = !ligada; faixa.applyConstraints({ advanced: [{ torch: ligada }] }).catch(() => {}); };
        tela.querySelector('.mjnota-barra').insertBefore(luz, tela.querySelector('[data-fechar]'));
      }
    } catch (_) {}

    let ativo = true;
    let timer = null;
    const historico = [];
    let achadoAtual = '';
    const fechar = () => {
      if (!ativo) return;
      ativo = false;
      clearTimeout(timer);
      stream.getTracks().forEach((t) => t.stop());
      tela.remove();
      soltarLeitor();
    };
    const concluir = (texto) => {
      fechar();
      aoEndereco?.(texto);
    };

    // Recorta a moldura (com folga) do quadro real da camera (video em object-fit: cover).
    function recortar() {
      const iw = video.videoWidth;
      const ih = video.videoHeight;
      if (!iw || !ih) return null;
      const caixa = video.getBoundingClientRect();
      const quadro = moldura.getBoundingClientRect();
      const escala = Math.max(caixa.width / iw, caixa.height / ih);
      const sobraX = (iw * escala - caixa.width) / 2;
      const sobraY = (ih * escala - caixa.height) / 2;
      const folgaX = quadro.width * 0.06;
      const folgaY = quadro.height * 0.25;
      const sx = Math.max(0, (quadro.left - caixa.left - folgaX + sobraX) / escala);
      const sy = Math.max(0, (quadro.top - caixa.top - folgaY + sobraY) / escala);
      const sw = Math.min(iw - sx, (quadro.width + 2 * folgaX) / escala);
      const sh = Math.min(ih - sy, (quadro.height + 2 * folgaY) / escala);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(sw));
      canvas.height = Math.max(1, Math.round(sh));
      canvas.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      return canvas;
    }

    async function ciclo() {
      if (!ativo) return;
      const quadro = recortar();
      if (quadro) {
        try {
          const w = await leitor((p) => { if (ativo && !achadoAtual) dica.textContent = `Preparando o leitor... ${Math.round(p * 100)}%`; });
          if (!ativo) return;
          if (!achadoAtual) dica.textContent = 'Lendo... mire no endereço';
          await w.setParameters({ tessedit_pageseg_mode: '6' }).catch(() => {});
          const { data } = await w.recognize(await paraJpeg(prepararCanvas(quadro, 1600, false)));
          if (!ativo) return;
          const [endereco] = enderecosDoTexto(data?.text || '', { solto: true });
          if (endereco) {
            achadoAtual = endereco;
            achadoBox.hidden = false;
            achadoBox.querySelector('span').textContent = `✅ ${endereco}`;
            moldura.classList.add('ok');
            dica.textContent = 'Endereço encontrado! Segure parado...';
            historico.push(comparavel(endereco));
            if (historico.length > 4) historico.shift();
            const iguais = historico.filter((h) => h === comparavel(endereco)).length;
            // So confirma sozinho com numero (sem numero costuma ser endereco cortado); "Usar este" aceita.
            if (iguais >= 2 && /\d/.test(endereco)) {
              try { navigator.vibrate?.(120); } catch (_) {}
              return concluir(endereco);
            }
          } else if (!achadoAtual) {
            dica.textContent = 'Procurando o endereço... chegue mais perto e com luz';
          }
        } catch (_) {
          if (ativo) dica.textContent = 'Não consegui abrir o leitor. Use "Ler" ou a Galeria.';
        }
      }
      if (ativo) timer = setTimeout(ciclo, 350);
    }

    tela.querySelector('[data-usar]').onclick = () => achadoAtual && concluir(achadoAtual);
    tela.querySelector('[data-fechar]').onclick = () => { fechar(); aoFechar?.(); };
    tela.querySelector('[data-galeria]').onclick = () => { fechar(); aoGaleria?.(); };
    tela.querySelector('[data-ler]').onclick = () => {
      const quadro = recortar();
      if (!quadro) return;
      fechar();
      quadro.toBlob((blob) => blob && aoFoto?.(blob), 'image/jpeg', 0.92);
    };
    const comecar = () => { if (ativo && !timer) timer = setTimeout(ciclo, 300); };
    video.addEventListener('playing', comecar, { once: true });
    setTimeout(comecar, 1500);
    return true;
  }

  window.MotoNota = { lerEndereco, enderecosDoTexto, abrirCamera };
})();
