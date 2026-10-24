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
    const escala = Math.min(1, maior / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * escala));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * escala));
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

  const TIPO = /\b(?:rua|r\.|av\.?|avenida|travessa|tv\.|trav\.?|estrada|est\.|rodovia|rod\.|alameda|al\.|pra[cç]a|viela)\s+\S/i;
  const ROTULO = /^(?:endere[cç]o(?:\s+(?:de|da|para)\s+entrega)?|end\.?|entregar\s+(?:em|na|no)|local(?:\s+de\s+entrega)?|destino)\s*[:\-–]?\s*/i;
  const BAIRRO = /^(?:bairro|b\.)\s*[:\-–]?\s*/i;
  const COMECO_BAIRRO = /^(?:jd\.?|jardim|vila|vl\.?|parque|pq\.?|residencial|res\.|centro|conjunto|cj\.?|chac[aá]ra|distrito|loteamento|condom[ií]nio)\b/i;
  const RUIDO = /\b(?:cep|tel(?:efone)?|fone|cel(?:ular)?|whats(?:app)?|cpf|cnpj|cliente|pedido|total|troco|pagamento)\b.*$/i;

  function limparLinha(linha) {
    return String(linha || '').replace(/[|_~^`´¨"“”]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Tira do texto lido as linhas que parecem endereco de entrega (rua, numero e bairro).
  function enderecosDoTexto(texto) {
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
      }
      const bairroAbaixo = BAIRRO.test(seguinte) ? seguinte.replace(BAIRRO, '') : COMECO_BAIRRO.test(seguinte) ? seguinte : '';
      const bairro = limparLinha(bairroAbaixo.replace(RUIDO, '')) || (!/,.*[a-z]{3}.*$/i.test(resto.replace(/^[^,]*,\s*\d+/, '')) ? bairroSolto : '');
      if (bairro && !resto.toLowerCase().includes(bairro.toLowerCase())) resto += `, ${bairro}`;
      achados.push(resto.slice(0, 140));
    });
    return [...new Set(achados)].slice(0, 3);
  }

  async function lerNoCelular(img, aoProgresso) {
    const w = await leitor(aoProgresso);
    try {
      const { data } = await w.recognize(prepararCanvas(img, 1800, true));
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

  window.MotoNota = { lerEndereco, enderecosDoTexto };
})();
