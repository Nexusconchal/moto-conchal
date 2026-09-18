(function () {
  'use strict';

  const BACKEND = 'https://motoboy-conchal.onrender.com';
  const TOKEN_KEY = 'nexusEmpresaToken';
  let loadedToken = '';

  function token() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  async function api(path, options = {}) {
    const response = await fetch(`${BACKEND}${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token()}`,
        ...(options.headers || {})
      },
      cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error || 'Nao consegui atualizar a integracao.');
    return data;
  }

  function setStatus(message, error = false) {
    const box = document.getElementById('pedidosMensagemStatus');
    if (!box) return;
    box.textContent = message;
    box.className = `status show${error ? ' error' : ''}`;
  }

  function showConnection(data) {
    const box = document.getElementById('pedidosMensagemConexao');
    if (!box) return;
    const secret = data.webhookSecret
      ? `\nChave do webhook (guarde agora): ${data.webhookSecret}`
      : '';
    box.textContent = `URL para receber pedidos: ${data.webhookUrl || '-'}${secret}\nCabecalho obrigatorio: x-motoja-webhook-secret`;
    box.style.whiteSpace = 'pre-wrap';
    box.className = 'status show';
  }

  async function loadSettings() {
    if (!token()) return;
    try {
      const data = await api('/api/companies/me/message-integration');
      document.getElementById('pedidosMensagemAtivos').checked = !!data.active;
      document.getElementById('pedidosMensagemTaxa').value = Number(data.commissionPercent || 0);
      document.getElementById('pedidosMensagemGrupo').value = data.groupJid || '';
      showConnection(data);
      setStatus(data.active ? 'Captura automatica ligada.' : 'Captura automatica desligada.');
      loadedToken = token();
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  async function saveSettings(regenerateSecret) {
    const button = document.getElementById(regenerateSecret ? 'gerarChavePedidosMensagem' : 'salvarPedidosMensagem');
    button.disabled = true;
    try {
      const data = await api('/api/companies/me/message-integration', {
        method: 'POST',
        body: JSON.stringify({
          active: document.getElementById('pedidosMensagemAtivos').checked,
          commissionPercent: Number(document.getElementById('pedidosMensagemTaxa').value || 0),
          groupJid: document.getElementById('pedidosMensagemGrupo').value.trim(),
          regenerateSecret
        })
      });
      showConnection(data);
      setStatus(data.message || 'Integracao salva.');
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      button.disabled = false;
    }
  }

  async function testOrder(send) {
    const text = document.getElementById('pedidosMensagemTextoTeste').value.trim();
    if (!text) {
      setStatus('Cole primeiro o texto completo de um pedido.', true);
      return;
    }
    const result = document.getElementById('pedidosMensagemResultado');
    result.className = 'result show';
    result.textContent = 'Analisando pedido...';
    try {
      const data = await api('/api/companies/me/message-order/test', {
        method: 'POST',
        body: JSON.stringify({ text, send })
      });
      result.textContent = data.message;
      setStatus(send
        ? (data.delivery?.sent ? 'Pedido de teste enviado ao grupo.' : `Pedido reconhecido, mas nao enviado: ${data.delivery?.reason || 'WhatsApp nao configurado no servidor'}.`)
        : 'Pedido reconhecido. Confira o resumo antes de ligar o envio automatico.', !data.delivery?.sent && send);
    } catch (error) {
      result.textContent = error.message;
      setStatus(error.message, true);
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    document.getElementById('salvarPedidosMensagem')?.addEventListener('click', () => saveSettings(false));
    document.getElementById('gerarChavePedidosMensagem')?.addEventListener('click', () => saveSettings(true));
    document.getElementById('testarPedidoMensagem')?.addEventListener('click', () => testOrder(false));
    document.getElementById('enviarTestePedidoMensagem')?.addEventListener('click', () => testOrder(true));
    loadSettings();
    setInterval(() => {
      if (token() && token() !== loadedToken) loadSettings();
    }, 2000);
    window.addEventListener('storage', (event) => {
      if (event.key === TOKEN_KEY) loadSettings();
    });
  });
})();
