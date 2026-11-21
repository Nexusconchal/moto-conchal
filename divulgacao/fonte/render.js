// Gera o story (1080x1920): node render.js
// Saida: ../motoboy-motoja-story.png
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  await page.goto('file://' + path.resolve(__dirname, 'story.html'));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  const alturas = await page.evaluate(() => {
    const c = document.querySelector('.content');
    const cta = document.querySelector('.cta').getBoundingClientRect();
    return { conteudo: c.scrollHeight, fimDoCadastro: Math.round(cta.bottom) };
  });
  console.log(JSON.stringify(alturas));
  await page.screenshot({ path: path.resolve(__dirname, '..', 'motoboy-motoja-story.png') });
  await browser.close();
})();
