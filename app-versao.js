(function () {
  'use strict';

  // O app Android (WebView) e o PWA podem ficar dias com a mesma tela aberta.
  // Quando sai versao nova do site (o nome do cache no sw.js muda a cada publicacao),
  // mostra um aviso para atualizar com um toque.
  const VERIFICAR_MS = 10 * 60 * 1000;
  let versaoAberta = '';
  let ultimaVerificacao = 0;

  async function versaoNoServidor() {
    const response = await fetch(`./sw.js?versao=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) return '';
    return (await response.text()).match(/CACHE_NAME\s*=\s*'([^']+)'/)?.[1] || '';
  }

  function mostrarAviso() {
    if (document.getElementById('mj-nova-versao')) return;
    const aviso = document.createElement('div');
    aviso.id = 'mj-nova-versao';
    aviso.setAttribute('role', 'status');
    aviso.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:100000;display:flex;align-items:center;gap:10px;' +
      'max-width:520px;margin:0 auto;padding:12px 14px;border-radius:14px;background:#1b1f2a;color:#fff;border:1px solid #ff9a00;box-shadow:0 10px 30px rgba(0,0,0,.45);font:600 14px/1.3 system-ui,sans-serif';
    aviso.innerHTML = '<span style="flex:1">📲 Nova versão do app disponível</span>' +
      '<button type="button" data-atualizar style="border:0;border-radius:10px;padding:9px 14px;background:#ff9a00;color:#111;font-weight:800;cursor:pointer">Atualizar</button>' +
      '<button type="button" data-depois aria-label="Depois" style="border:0;background:none;color:#aab;font-size:20px;cursor:pointer">×</button>';
    aviso.querySelector('[data-atualizar]').onclick = () => location.reload();
    aviso.querySelector('[data-depois]').onclick = () => aviso.remove();
    document.body.appendChild(aviso);
  }

  async function verificar() {
    if (Date.now() - ultimaVerificacao < 60 * 1000) return;
    ultimaVerificacao = Date.now();
    try {
      const versao = await versaoNoServidor();
      if (!versao) return;
      if (!versaoAberta) versaoAberta = versao;
      else if (versao !== versaoAberta) mostrarAviso();
    } catch (_) {}
  }

  verificar();
  setInterval(() => { if (document.visibilityState === 'visible') verificar(); }, VERIFICAR_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') verificar(); });
  window.addEventListener('online', verificar);
})();
