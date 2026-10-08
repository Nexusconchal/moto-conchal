(() => {
  'use strict';
  const root = document.getElementById('motoboys-available');
  if (!root) return;
  const backend = root.dataset.backend;
  const title = root.querySelector('strong'), detail = root.querySelector('small');
  let inFlight = false, refreshedAt = -Infinity;
  const now = () => performance.now();
  function unknown() {
    root.dataset.state = 'unknown'; title.textContent = 'Disponibilidade não confirmada';
    detail.textContent = 'A disponibilidade será confirmada no aceite.';
  }
  async function refresh() {
    if (inFlight || document.visibilityState === 'hidden' || now() - refreshedAt < 15000) return;
    inFlight = true;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`${backend}/api/drivers/availability?t=${Date.now()}`, { signal: controller.signal, cache: 'no-store' });
      const data = await response.json();
      const count = data.counts?.conchal;
      if (!response.ok || data.ok !== true || !Number.isInteger(count) || count < 0 || count > 2000 || !Number.isFinite(data.updatedAt)) throw new Error('contagem_nao_confirmada');
      root.dataset.state = count ? 'available' : 'empty';
      title.textContent = count ? `${count} ${count === 1 ? 'motoboy online' : 'motoboys online'}` : 'Nenhum motoboy online';
      detail.textContent = count ? 'Confirmação após o aceite do motoboy.' : 'Seu pedido aguarda o aceite de um motoboy.';
      refreshedAt = now();
    } catch { unknown(); refreshedAt = -Infinity; }
    finally { clearTimeout(timeout); inFlight = false; }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { if (now() - refreshedAt > 45000) unknown(); refresh(); } });
  window.addEventListener('offline', unknown);
  window.addEventListener('online', () => { refreshedAt = -Infinity; refresh(); });
  setInterval(() => { if (now() - refreshedAt > 45000) unknown(); refresh(); }, 20000);
  refresh();
})();
