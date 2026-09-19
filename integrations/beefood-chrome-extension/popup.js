const statusBox = document.getElementById('status');
const captureButton = document.getElementById('capture');

function status(message, error = false) {
  statusBox.textContent = message;
  statusBox.style.color = error ? '#ff9b9b' : '#caffd8';
}

document.getElementById('options').onclick = () => chrome.runtime.openOptionsPage();
captureButton.onclick = async () => {
  captureButton.disabled = true;
  try {
    const config = await chrome.storage.sync.get(['backendUrl', 'companyId', 'captureKey']);
    if (!config.companyId || !config.captureKey) throw new Error('Abra Configurar e informe empresa e chave.');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('Nao encontrei a aba aberta.');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content-script.js'] });
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'NEXUS_CAPTURE_BEEFOOD' });
    if (!result?.ok || !result.order?.rawText) throw new Error(result?.error || 'Nao encontrei texto do pedido na tela.');
    const backend = String(config.backendUrl || 'https://motoboy-conchal.onrender.com').replace(/\/$/, '');
    const response = await fetch(`${backend}/api/integrations/orders/${config.companyId}/beefood`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nexus-capture-key': config.captureKey },
      body: JSON.stringify(result.order)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error || 'O servidor recusou o pedido.');
    status(data.duplicated ? 'Esse pedido ja tinha sido capturado.' : 'Pedido enviado ao painel Nexus.');
  } catch (error) { status(error.message, true); }
  finally { captureButton.disabled = false; }
};
