(() => {
  if (window.__nexusBeeFoodCaptureInstalled) return;
  window.__nexusBeeFoodCaptureInstalled = true;

  function visibleText(selector) {
    return Array.from(document.querySelectorAll(selector))
      .filter((element) => element.offsetParent !== null)
      .map((element) => element.innerText || element.textContent || '')
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)[0] || '';
  }

  function captureOrder() {
    const preferred = [
      '[data-testid*="order"]', '[class*="pedido"]', '[class*="order"]',
      'main', '[role="main"]', '.modal.show', '[role="dialog"]'
    ];
    const rawText = preferred.map(visibleText).find((text) => text.length >= 40)
      || document.body.innerText;
    return {
      source: 'extension',
      rawText: String(rawText || '').slice(0, 12000),
      pageUrl: location.href,
      pageTitle: document.title,
      capturedAt: Date.now()
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'NEXUS_CAPTURE_BEEFOOD') return false;
    try { sendResponse({ ok: true, order: captureOrder() }); }
    catch (error) { sendResponse({ ok: false, error: error.message }); }
    return true;
  });
})();
