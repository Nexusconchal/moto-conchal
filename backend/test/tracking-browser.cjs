const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(path.join(process.env.RUNTIME_NODE_MODULES, 'playwright'));

(async () => {
  const root = path.resolve(__dirname, '../..');
  const leaflet = await (await fetch('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js')).text();
  const leafletCss = await (await fetch('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css')).text();
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const initial = Date.now() - 45000;
      const deliveries = ['a', 'b'].map((id, i) => ({ id, status: 'retirada', motoboy: 'Teste', empresa: 'Teste', retiradaLat: -22.3375, retiradaLon: -47.1729, entregaLat: -22.33, entregaLon: -47.17,
        motoboyLocalizacao: { latitude: -22.3375 + i * 0.001, longitude: -47.1729, clientTimestamp: initial - i * 1000, serverTimestampMs: initial - i * 1000 }
      }));
      await page.route('**/*', async (route) => {
        const url = route.request().url();
        if (url === 'http://tracking.test/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><div id="entregasRastreamentoLista"></div><div id="mapaEntregaEmpresa" style="height:480px;width:100%"></div><p id="mapaEntregaStatus"></p>' });
        if (url.endsWith('/active-deliveries')) return route.fulfill({ json: { deliveries } });
        if (url.endsWith('/api/maps/route')) return route.fulfill({ json: { km: 1.2, geometry: [[-22.3375, -47.1729], [-22.33, -47.17]] } });
        return route.abort();
      });
      await page.goto('http://tracking.test/');
      await page.addScriptTag({ content: leaflet });
      await page.addStyleTag({ content: leafletCss });
      await page.evaluate(() => {
        localStorage.setItem('nexusEmpresaToken', 'TEST_ONLY');
        window.__socketEvents = {};
        window.io = () => ({ connected: true, on: (event, callback) => { window.__socketEvents[event] = callback; }, disconnect() {} });
      });
      await page.addScriptTag({ path: path.join(root, 'tracking-map.js') });
      await page.addScriptTag({ path: path.join(root, 'empresa-tracking.js') });
      await page.evaluate(() => window.dispatchEvent(new Event('DOMContentLoaded')));
      await page.waitForFunction(() => document.getElementById('mapaEntregaStatus').textContent.includes('atrasado'));
      assert.equal(await page.locator('[data-tracking-delivery]').count(), 2);
      const before = await page.locator('.motoja-driver-marker').getAttribute('style');
      await page.evaluate(() => window.__socketEvents['delivery:tracking']({ deliveryId: 'a', status: 'retirada', location: { latitude: -22.335, longitude: -47.17, clientTimestamp: Date.now(), serverTimestampMs: Date.now() } }));
      await page.waitForFunction(() => document.getElementById('mapaEntregaStatus').textContent.includes('GPS atualizado'));
      assert.notEqual(await page.locator('.motoja-driver-marker').getAttribute('style'), before);
      await page.locator('[data-tracking-delivery="b"]').click();
      await page.waitForFunction(() => document.getElementById('mapaEntregaStatus').textContent.includes('atrasado'));
      await page.screenshot({ path: path.join(process.env.TEMP, `motoja-tracking-${viewport.width}.png`) });
      await page.evaluate(() => window.__socketEvents['delivery:tracking']({ deliveryId: 'b', status: 'finalizada' }));
      assert.equal(await page.locator('[data-tracking-delivery="b"]').count(), 0);
      assert.deepEqual(errors, []);
      console.log(`PASS ${viewport.width}px: stale signal, live update, delivery switch, finish event, no JS errors`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
