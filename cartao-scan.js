(function (raiz) {
  'use strict';

  // Le numero, validade e nome de um cartao pela camera, no proprio celular (Tesseract.js).
  // A imagem nunca sai do aparelho e nao e guardada. O numero so vale se passar na conta
  // de verificacao dos cartoes (Luhn); o codigo de seguranca o cliente digita.
  const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

  function luhn(numero) {
    let soma = 0;
    let dobra = false;
    for (let i = numero.length - 1; i >= 0; i -= 1) {
      let d = Number(numero[i]);
      if (dobra) { d *= 2; if (d > 9) d -= 9; }
      soma += d;
      dobra = !dobra;
    }
    return numero.length >= 13 && soma % 10 === 0;
  }

  // Comeco de numero das bandeiras aceitas no Brasil (Visa, Master, Elo, Amex, Hiper, Discover).
  const BANDEIRA = /^(?:4|5[1-5]|2[2-7]|3[47]|6|50|36|38)/;

  function numeroValido(numero) {
    const tamanhoOk = numero.length === 16 || (numero.length === 15 && /^3[47]/.test(numero)) || (numero.length >= 13 && numero.length <= 19 && /^(?:6|50)/.test(numero));
    return tamanhoOk && BANDEIRA.test(numero) && luhn(numero);
  }

  // Letras que o leitor confunde com numero (O/0, I/1, S/5, B/8...): so em linha que ja tem
  // numeros, e so nos blocos feitos inteiros dessas letras/numeros (VALID, THRU ficam como estao).
  function corrigirDigitos(texto) {
    return String(texto || '').split('\n').map((linha) => ((linha.match(/\d/g) || []).length < 3 ? linha
      : linha.replace(/(^|[^A-Za-z0-9|!])([0-9OoQDIl|!SsBZz]+)(?=$|[^A-Za-z0-9|!])/g, (_, antes, bloco) => antes
        + bloco.replace(/[OoQD]/g, '0').replace(/[Il|!]/g, '1').replace(/[Ss]/g, '5').replace(/B/g, '8').replace(/[Zz]/g, '2'))))
      .join('\n');
  }

  function numeroDoTexto(texto) {
    const linhas = String(texto || '').split(/\n+/).map(corrigirDigitos);
    const candidatos = [];
    const blocos = [...linhas, linhas.join(' ')];
    for (const linha of blocos) {
      const so = linha.replace(/[^\d ]/g, ' ');
      const sequencias = so.match(/\d[\d ]{11,26}\d/g) || [];
      for (const seq of sequencias) {
        const digitos = seq.replace(/\D/g, '');
        // Leitor pode grudar lixo antes/depois: procura um trecho valido dentro.
        for (const tamanho of [16, 15, 19, 18, 17, 14, 13]) {
          for (let i = 0; i + tamanho <= digitos.length; i += 1) {
            const pedaco = digitos.slice(i, i + tamanho);
            if (numeroValido(pedaco)) candidatos.push(pedaco);
          }
        }
      }
    }
    candidatos.sort((a, b) => (b.length === 16) - (a.length === 16) || b.length - a.length);
    return candidatos[0] || '';
  }

  function validadeDoTexto(texto, agora = new Date()) {
    const anoAtual = agora.getFullYear();
    let melhor = null;
    const re = /(?:^|[^\d])(0[1-9]|1[0-2])\s*[/\\|-]\s*(\d{4}|\d{2})(?!\d)/g;
    let m;
    const limpo = corrigirDigitos(String(texto || ''));
    while ((m = re.exec(limpo))) {
      const mes = Number(m[1]);
      let ano = Number(m[2]);
      if (ano < 100) ano += 2000;
      if (ano < anoAtual || ano > anoAtual + 15) continue;
      if (ano === anoAtual && mes < agora.getMonth() + 1) continue;
      // "Valido de" e "valido ate": fica com a data mais longe.
      if (!melhor || ano * 12 + mes > melhor.ano * 12 + melhor.mes) melhor = { mes, ano };
    }
    return melhor;
  }

  const NAO_NOME = /\b(?:VALID|VALIDO|VALIDA|THRU|ATE|DESDE|MONTH|YEAR|MES|ANO|BANK|BANCO|VISA|MASTER|MASTERCARD|ELO|AMEX|AMERICAN|EXPRESS|HIPERCARD|HIPER|DEBITO|DEBIT|CREDITO|CREDIT|PLATINUM|GOLD|BLACK|INFINITE|INTERNATIONAL|INTERNACIONAL|NACIONAL|NUBANK|ITAU|BRADESCO|SANTANDER|CAIXA|INTER|SICOOB|SICREDI|PAN|NEON|MERCADO|PAGO|PICPAY|ORIGINAL|BRASIL|CARD|CARTAO|MULTIPLO|ELECTRON|MAESTRO|CONTACTLESS|SIGNATURE|CLIENTE|DESDE|MEMBER|SINCE)\b/;

  function nomeDoTexto(texto) {
    const linhas = String(texto || '').toUpperCase().split(/\n+/).map((l) => l.replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim());
    let melhor = '';
    for (const linha of linhas) {
      const palavras = linha.split(' ').filter(Boolean);
      if (palavras.length < 2 || palavras.length > 5) continue;
      if (linha.length < 6 || linha.length > 26) continue;
      if (NAO_NOME.test(linha)) continue;
      // Uma inicial no meio vale ("RAFAEL A SOUZA"); primeira e ultima palavra tem 2+ letras.
      if (palavras[0].length < 2 || palavras.at(-1).length < 2 || palavras.filter((p) => p.length < 2).length > 1) continue;
      if (linha.length > melhor.length) melhor = linha;
    }
    return melhor;
  }

  function dadosDoCartao(texto, agora) {
    return { numero: numeroDoTexto(texto), validade: validadeDoTexto(texto, agora), nome: nomeDoTexto(texto) };
  }

  // ---------- Camera dentro da tela ----------
  let carregando = null;
  let worker = null;

  function carregarTesseract() {
    if (raiz.Tesseract) return Promise.resolve(raiz.Tesseract);
    if (!carregando) {
      carregando = new Promise((ok, erro) => {
        const script = document.createElement('script');
        script.src = TESSERACT_URL;
        script.async = true;
        script.onload = () => (raiz.Tesseract ? ok(raiz.Tesseract) : erro(new Error('leitor_indisponivel')));
        script.onerror = () => { carregando = null; erro(new Error('leitor_indisponivel')); };
        document.head.appendChild(script);
      });
    }
    return carregando;
  }

  async function leitor(aoProgresso) {
    if (!worker) {
      const Tesseract = await carregarTesseract();
      worker = Tesseract.createWorker('eng', 1, {
        logger: (m) => { if (/loading|initializ/.test(m.status || '')) aoProgresso?.(m.progress || 0); }
      }).then(async (w) => {
        await w.setParameters({ tessedit_pageseg_mode: '11', tessedit_char_whitelist: '0123456789/ ABCDEFGHIJKLMNOPQRSTUVWXYZ' }).catch(() => {});
        return w;
      }).catch((error) => { worker = null; throw error; });
    }
    return worker;
  }

  function soltarLeitor() {
    const atual = worker;
    worker = null;
    Promise.resolve(atual).then((w) => w?.terminate()).catch(() => {});
  }

  // Cinza com contraste; em cartao escuro (numero claro) inverte as cores.
  function preparar(canvas, inverter) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const dados = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = dados.data;
    let soma = 0;
    for (let i = 0; i < px.length; i += 4) soma += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    const media = soma / (px.length / 4);
    const inverte = inverter ?? media < 110;
    for (let i = 0; i < px.length; i += 4) {
      let v = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      v = (v - media) * 1.8 + 128;
      if (inverte) v = 255 - v;
      px[i] = px[i + 1] = px[i + 2] = Math.max(0, Math.min(255, v));
    }
    ctx.putImageData(dados, 0, 0);
    return new Promise((ok) => canvas.toBlob((blob) => ok(blob || canvas.toDataURL('image/jpeg', 0.92)), 'image/jpeg', 0.92));
  }

  function estilo() {
    if (document.getElementById('mjcard-scan-estilo')) return;
    const style = document.createElement('style');
    style.id = 'mjcard-scan-estilo';
    style.textContent = `
      .mjcard-cam{position:fixed;inset:0;z-index:100002;background:#000;color:#fff;font-family:system-ui,sans-serif}
      .mjcard-cam video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
      .mjcard-moldura{position:absolute;left:6%;width:88%;top:26%;aspect-ratio:1.586;border:3px solid #ff9a00;border-radius:16px;box-shadow:0 0 0 100vmax rgba(0,0,0,.5)}
      .mjcard-moldura.ok{border-color:#35c979}
      .mjcard-dica{position:absolute;left:12px;right:12px;top:calc(26% - 58px);text-align:center;font-weight:800;font-size:15px;text-shadow:0 1px 4px #000}
      .mjcard-lido{position:absolute;left:6%;right:6%;top:calc(26% + 55.5vw + 18px);padding:10px 12px;border-radius:12px;background:rgba(10,40,22,.92);border:1px solid #35c979;font-weight:800;text-align:center;letter-spacing:1px}
      .mjcard-lido[hidden]{display:none}
      .mjcard-barra{position:absolute;left:0;right:0;bottom:0;padding:18px 18px calc(22px + env(safe-area-inset-bottom));display:flex;justify-content:space-between;gap:10px;background:linear-gradient(transparent,rgba(0,0,0,.8))}
      .mjcard-barra button{border:0;border-radius:12px;padding:13px 16px;font:inherit;font-weight:800;font-size:14px;background:#23262f;color:#fff}
      .mjcard-barra .usar{background:#35c979;color:#06210f}
      .mjcard-barra .usar[hidden]{display:none}`;
    document.head.appendChild(style);
  }

  // Abre a camera; quando le um numero valido duas vezes, vibra e devolve {numero, validade, nome}.
  // Devolve false se o aparelho/app nao liberar a camera (o cliente digita).
  async function abrirCameraCartao({ aoLer, aoFechar }) {
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
    estilo();
    const tela = document.createElement('div');
    tela.className = 'mjcard-cam';
    tela.setAttribute('role', 'dialog');
    tela.setAttribute('aria-label', 'Escanear cartão');
    tela.innerHTML = `<video playsinline muted autoplay></video>
      <div class="mjcard-dica" aria-live="polite">Coloque a frente do cartão dentro do quadro</div>
      <div class="mjcard-moldura"></div>
      <div class="mjcard-lido" hidden></div>
      <div class="mjcard-barra"><button type="button" data-fechar>✕ Digitar</button><button type="button" class="usar" data-usar hidden>✅ Usar este</button></div>`;
    document.body.appendChild(tela);
    const video = tela.querySelector('video');
    const dica = tela.querySelector('.mjcard-dica');
    const moldura = tela.querySelector('.mjcard-moldura');
    const lido = tela.querySelector('.mjcard-lido');
    const usar = tela.querySelector('[data-usar]');
    video.srcObject = stream;
    video.play().catch(() => {});

    let ativo = true;
    let timer = null;
    let rodada = 0;
    let achado = null;
    const vistos = new Map();
    const fechar = () => {
      if (!ativo) return;
      ativo = false;
      clearTimeout(timer);
      stream.getTracks().forEach((t) => t.stop());
      tela.remove();
      soltarLeitor();
    };
    const concluir = () => { const dados = achado; fechar(); aoLer?.(dados); };

    function recortar() {
      const iw = video.videoWidth;
      const ih = video.videoHeight;
      if (!iw || !ih) return null;
      const caixa = video.getBoundingClientRect();
      const quadro = moldura.getBoundingClientRect();
      const escala = Math.max(caixa.width / iw, caixa.height / ih);
      const sobraX = (iw * escala - caixa.width) / 2;
      const sobraY = (ih * escala - caixa.height) / 2;
      const sx = Math.max(0, (quadro.left - caixa.left + sobraX) / escala);
      const sy = Math.max(0, (quadro.top - caixa.top + sobraY) / escala);
      const sw = Math.min(iw - sx, quadro.width / escala);
      const sh = Math.min(ih - sy, quadro.height / escala);
      const largura = Math.min(1400, Math.round(sw));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, largura);
      canvas.height = Math.max(1, Math.round(sh * (largura / sw)));
      canvas.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      return canvas;
    }

    async function ciclo() {
      if (!ativo) return;
      const quadro = recortar();
      if (quadro) {
        try {
          const w = await leitor((p) => { if (ativo && !achado) dica.textContent = `Preparando o leitor... ${Math.round(p * 100)}%`; });
          if (!ativo) return;
          if (!achado) dica.textContent = 'Lendo... segure o cartão parado e com luz';
          // Alterna normal e invertido: numero escuro em cartao claro e numero claro em cartao escuro.
          rodada += 1;
          const { data } = await w.recognize(await preparar(quadro, rodada % 3 === 0 ? undefined : rodada % 3 === 1 ? false : true));
          if (!ativo) return;
          const dados = dadosDoCartao(data?.text || '');
          if (dados.numero) {
            const atual = vistos.get(dados.numero) || { vezes: 0, validade: null, nome: '' };
            atual.vezes += 1;
            atual.validade = dados.validade || atual.validade;
            atual.nome = dados.nome || atual.nome;
            vistos.set(dados.numero, atual);
            achado = { numero: dados.numero, validade: atual.validade, nome: atual.nome };
            moldura.classList.add('ok');
            usar.hidden = false;
            lido.hidden = false;
            lido.textContent = `•••• ${dados.numero.slice(-4)}${atual.validade ? `  ·  ${String(atual.validade.mes).padStart(2, '0')}/${String(atual.validade.ano).slice(-2)}` : ''}`;
            dica.textContent = atual.validade ? 'Cartão lido!' : 'Número lido! Procurando a validade...';
            if (atual.vezes >= 2 && (atual.validade || atual.vezes >= 4)) {
              try { navigator.vibrate?.(120); } catch (_) {}
              return concluir();
            }
          } else if (!achado) {
            dica.textContent = 'Procurando o número... chegue mais perto e evite reflexo';
          }
        } catch (_) {
          if (ativo) dica.textContent = 'Não consegui abrir o leitor. Toque em Digitar.';
        }
      }
      if (ativo) timer = setTimeout(ciclo, 250);
    }

    usar.onclick = () => achado && concluir();
    tela.querySelector('[data-fechar]').onclick = () => { fechar(); aoFechar?.(); };
    const comecar = () => { if (ativo && !timer) timer = setTimeout(ciclo, 300); };
    video.addEventListener('playing', comecar, { once: true });
    setTimeout(comecar, 1500);
    return true;
  }

  raiz.MotojaCartaoScan = { dadosDoCartao, numeroValido, luhn, abrirCameraCartao };
})(typeof window !== 'undefined' ? window : globalThis);
