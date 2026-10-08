(() => {
  'use strict';
  const root = document.getElementById('motoboys-available');
  if (!root) return;
  const backend = root.dataset.backend;
  const title = root.querySelector('strong'), detail = root.querySelector('small');
  let inFlight = false, refreshedAt = 0;
  function unknown() {
    root.dataset.state = 'unknown'; title.textContent = 'Disponibilidade não confirmada agora';
    detail.textContent = 'Você pode solicitar uma corrida e aguardar a confirmação de um motoboy.';
  }
  async function refresh() {
    if (inFlight || document.visibilityState === 'hidden' || Date.now() - refreshedAt < 15000) return;
    inFlight = true;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`${backend}/api/drivers/availability`, { signal: controller.signal, cache: 'no-store' });
      const data = await response.json();
      const count = data.counts?.conchal;
      if (!response.ok || data.ok !== true || !Number.isInteger(count) || count < 0 || count > 2000 || !Number.isFinite(data.updatedAt) || Date.now() - data.updatedAt > 45000) throw new Error('contagem_nao_confirmada');
      root.dataset.state = count ? 'available' : 'empty';
      title.textContent = count ? `${count} ${count === 1 ? 'motoboy online e disponível' : 'motoboys online e disponíveis'}` : 'Nenhum motoboy disponível online agora';
      detail.textContent = count ? 'Para atender Conchal · a corrida depende do aceite de um motoboy.' : 'Em Conchal · você pode solicitar e aguardar um motoboy aceitar.';
      refreshedAt = Date.now();
    } catch { unknown(); refreshedAt = 0; }
    finally { clearTimeout(timeout); inFlight = false; }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { if (Date.now() - refreshedAt > 45000) unknown(); refresh(); } });
  window.addEventListener('offline', unknown);
  window.addEventListener('online', () => { refreshedAt = 0; refresh(); });
  setInterval(() => { if (Date.now() - refreshedAt > 45000) unknown(); refresh(); }, 20000);
  refresh();
})();
