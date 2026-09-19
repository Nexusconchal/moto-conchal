(function () {
  'use strict';
  const BACKEND = 'https://motoboy-conchal.onrender.com';
  const TOKEN_KEY = 'nexusEmpresaToken';
  const PLATFORM_NAMES = { anotaai: 'Anota AI', beefood: 'BeeFood', ifood: 'iFood' };
  let loadedToken = '';
  let settings = {};
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const token = () => localStorage.getItem(TOKEN_KEY) || '';
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const money = (value) => Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  async function api(path, options = {}) {
    const response = await fetch(`${BACKEND}${path}`, {
      ...options,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}`, ...(options.headers || {}) },
      cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error || 'Nao consegui atualizar a integracao.');
    return data;
  }

  function setMainStatus(message, error = false) {
    const box = $('#integracoesPedidosStatus');
    if (!box) return;
    box.textContent = message;
    box.className = `status show${error ? ' error' : ''}`;
  }

  function setPlatformStatus(platform, message, error = false) {
    const box = $(`[data-status="${platform}"]`);
    if (!box) return;
    box.textContent = message;
    box.className = `status show capture-secret${error ? ' error' : ''}`;
  }

  const field = (platform, name) => $(`[data-platform="${platform}"][data-field="${name}"]`);

  function readPlatform(platform) {
    return {
      active: !!field(platform, 'active')?.checked,
      autoDispatch: !!field(platform, 'autoDispatch')?.checked,
      commissionPercent: Number(field(platform, 'commissionPercent')?.value || 0),
      deliveryType: field(platform, 'deliveryType')?.value || 'Lanche / pizza / pastel / marmita',
      captureMode: platform === 'anotaai' ? 'whatsapp' : ($('input[name="beefoodCapture"]:checked')?.value || 'extension')
    };
  }

  function renderPlatform(platform, data = {}) {
    settings[platform] = data;
    if (field(platform, 'active')) field(platform, 'active').checked = !!data.active;
    if (field(platform, 'autoDispatch')) field(platform, 'autoDispatch').checked = !!data.autoDispatch;
    if (field(platform, 'commissionPercent')) field(platform, 'commissionPercent').value = Number(data.commissionPercent || 0);
    if (field(platform, 'deliveryType')) field(platform, 'deliveryType').value = data.deliveryType || 'Lanche / pizza / pastel / marmita';
    if (platform === 'beefood') {
      const mode = data.captureMode === 'print' ? 'print' : 'extension';
      const radio = $(`input[name="beefoodCapture"][value="${mode}"]`);
      if (radio) radio.checked = true;
    }
    const badge = $(`[data-badge="${platform}"]`);
    if (badge) {
      badge.textContent = data.active ? 'Ativo' : 'Inativo';
      badge.classList.toggle('active', !!data.active);
    }
    if (platform === 'anotaai') {
      setPlatformStatus(platform, data.connected ? 'WhatsApp conectado e pronto para receber pedidos.' : 'Salve e conecte o WhatsApp da loja pelo QR Code.');
    } else if (platform === 'beefood') {
      const modeText = data.captureMode === 'print' ? 'programa Nexus Captura' : 'extensao do Chrome';
      setPlatformStatus(platform, `${data.secretConfigured ? 'Chave configurada.' : 'Gere uma chave.'} Modo atual: ${modeText}.`);
    }
  }

  async function loadSettings() {
    if (!token()) return;
    try {
      const data = await api('/api/companies/me/order-integrations');
      Object.entries(data.integrations || {}).forEach(([platform, config]) => renderPlatform(platform, config));
      if (data.integrations?.anotaai?.instanceName) checkAnotaStatus();
      loadedToken = token();
      setMainStatus('Integracoes carregadas. Cada plataforma funciona separadamente.');
    } catch (error) { setMainStatus(error.message, true); }
  }

  async function checkAnotaStatus() {
    try {
      const data = await api('/api/companies/me/order-integrations/anotaai/status');
      const current = settings.anotaai || {};
      renderPlatform('anotaai', { ...current, connected: !!data.connected });
    } catch (error) {
      setPlatformStatus('anotaai', error.message, true);
    }
  }

  async function savePlatform(platform, regenerateSecret = false) {
    const button = regenerateSecret ? $(`[data-key="${platform}"]`) : $(`[data-save="${platform}"]`);
    if (button) button.disabled = true;
    try {
      const data = await api(`/api/companies/me/order-integrations/${platform}`, {
        method: 'POST', body: JSON.stringify({ ...readPlatform(platform), regenerateSecret })
      });
      renderPlatform(platform, { ...(settings[platform] || {}), ...data.config, secretConfigured: true, ingestUrl: data.ingestUrl });
      const keyText = data.captureKey ? `\n\nURL: ${data.ingestUrl}\nChave (guarde agora): ${data.captureKey}` : '';
      setPlatformStatus(platform, `${data.message || 'Configuracao salva.'}${keyText}`);
      setMainStatus(`${PLATFORM_NAMES[platform]} atualizado.`);
    } catch (error) {
      setPlatformStatus(platform, error.message, true);
      setMainStatus(error.message, true);
    } finally { if (button) button.disabled = false; }
  }

  async function connectAnota() {
    const button = $('[data-connect-anota]');
    button.disabled = true;
    button.textContent = 'Gerando QR Code...';
    try {
      await savePlatform('anotaai', false);
      const data = await api('/api/companies/me/order-integrations/anotaai/connect', { method: 'POST', body: '{}' });
      const qr = $('#anotaAiQr');
      if (data.qrCode) {
        qr.src = String(data.qrCode).startsWith('data:') ? data.qrCode : `data:image/png;base64,${data.qrCode}`;
        qr.classList.add('show');
      }
      setPlatformStatus('anotaai', data.pairingCode ? `${data.message} Codigo alternativo: ${data.pairingCode}` : data.message);
      setTimeout(checkAnotaStatus, 8000);
    } catch (error) { setPlatformStatus('anotaai', error.message, true); }
    finally { button.disabled = false; button.textContent = 'Conectar WhatsApp e gerar QR Code'; }
  }

  function queueCard(order) {
    const sent = order.status === 'enviado_motoboy';
    const ignored = order.status === 'ignorado';
    const items = Array.isArray(order.items) ? order.items.join(', ') : '';
    const reason = order.reviewReason || (order.missing?.length ? `Falta: ${order.missing.join(', ')}` : 'Pronto para conferir.');
    return `<article class="captured-order${sent ? ' sent' : ''}" data-order-id="${escapeHtml(order.id)}">
      <div class="captured-meta"><strong>${escapeHtml(PLATFORM_NAMES[order.platform] || order.platform)} ${escapeHtml(order.externalId || '')}</strong><span>${escapeHtml(order.status || 'revisar')}</span></div>
      <label>Cliente<input data-order-field="customer" value="${escapeHtml(order.customer || '')}" ${sent || ignored ? 'disabled' : ''}></label>
      <label>WhatsApp<input data-order-field="phone" inputmode="tel" value="${escapeHtml(order.phone || '')}" ${sent || ignored ? 'disabled' : ''}></label>
      <label>Endereco de entrega<input data-order-field="address" value="${escapeHtml(order.address || '')}" ${sent || ignored ? 'disabled' : ''}></label>
      <label>Itens<textarea data-order-field="items" ${sent || ignored ? 'disabled' : ''}>${escapeHtml(items)}</textarea></label>
      <div class="captured-meta"><span>Produtos: <strong>${money(order.productTotal || order.orderTotal)}</strong></span><span>Liquido loja: <strong>${money(order.storeNetAmount)}</strong></span></div>
      <div class="status show${sent ? '' : ' error'}">${sent ? `Motoboy chamado. Entrega: ${escapeHtml(order.deliveryId || '-')}` : escapeHtml(reason)}</div>
      ${sent || ignored ? '' : '<div class="grid2 compact-buttons"><button type="button" class="green" data-dispatch>Conferir e chamar</button><button type="button" class="secondary" data-dismiss>Ignorar</button></div>'}
    </article>`;
  }

  async function loadQueue() {
    if (!token()) return;
    const list = $('#pedidosCapturadosLista');
    if (!list) return;
    list.innerHTML = '<p class="queue-empty">Carregando pedidos...</p>';
    try {
      const data = await api('/api/companies/me/captured-orders');
      const visible = (data.orders || []).filter((order) => order.status !== 'ignorado');
      list.innerHTML = visible.length ? visible.map(queueCard).join('') : '<p class="queue-empty">Nenhum pedido capturado.</p>';
    } catch (error) { list.innerHTML = `<div class="status show error">${escapeHtml(error.message)}</div>`; }
  }

  async function dispatchOrder(card) {
    const payload = {
      customer: $('[data-order-field="customer"]', card).value.trim(),
      phone: $('[data-order-field="phone"]', card).value.trim(),
      address: $('[data-order-field="address"]', card).value.trim(),
      items: $('[data-order-field="items"]', card).value.split(',').map((item) => item.trim()).filter(Boolean)
    };
    const button = $('[data-dispatch]', card);
    button.disabled = true;
    button.textContent = 'Calculando...';
    try {
      const data = await api(`/api/companies/me/captured-orders/${encodeURIComponent(card.dataset.orderId)}/dispatch`, { method: 'POST', body: JSON.stringify(payload) });
      setMainStatus(`Entrega ${data.dispatch.deliveryId} enviada aos motoboys.`);
      await loadQueue();
    } catch (error) { setMainStatus(error.message, true); button.disabled = false; button.textContent = 'Conferir e chamar'; }
  }

  async function dismissOrder(card) {
    if (!confirm('Ignorar este pedido capturado?')) return;
    try {
      await api(`/api/companies/me/captured-orders/${encodeURIComponent(card.dataset.orderId)}/dismiss`, { method: 'POST', body: '{}' });
      card.remove();
    } catch (error) { setMainStatus(error.message, true); }
  }

  window.addEventListener('DOMContentLoaded', () => {
    $$('[data-expand]').forEach((button) => button.addEventListener('click', () => button.closest('.integration-card').classList.toggle('open')));
    $$('[data-save]').forEach((button) => button.addEventListener('click', () => savePlatform(button.dataset.save, false)));
    $$('[data-key]').forEach((button) => button.addEventListener('click', () => savePlatform(button.dataset.key, true)));
    $('[data-connect-anota]')?.addEventListener('click', connectAnota);
    $('#atualizarPedidosCapturados')?.addEventListener('click', loadQueue);
    $('#pedidosCapturadosLista')?.addEventListener('click', (event) => {
      const card = event.target.closest('[data-order-id]');
      if (!card) return;
      if (event.target.closest('[data-dispatch]')) dispatchOrder(card);
      if (event.target.closest('[data-dismiss]')) dismissOrder(card);
    });
    loadSettings();
    loadQueue();
    setInterval(() => {
      if (token() && token() !== loadedToken) { loadSettings(); loadQueue(); }
    }, 2000);
    window.addEventListener('storage', (event) => {
      if (event.key === TOKEN_KEY) { loadSettings(); loadQueue(); }
    });
  });
})();
