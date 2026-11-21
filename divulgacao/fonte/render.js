// Gera as artes: node render.js . .. ["R$ 2.000"]   (o 3o valor, opcional, troca "Salario fixo" por "Fixo de R$ ...")
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const dir = process.argv[2];
  const out = process.argv[3];
  const fixo = process.argv[4] || '';
  const browser = await chromium.launch();
  const formats = [
    { name: 'feed', w: 1080, h: 1350 },
    { name: 'story', w: 1080, h: 1920 },
  ];
  for (const f of formats) {
    const page = await browser.newPage({ viewport: { width: f.w, height: f.h }, deviceScaleFactor: 1 });
    const q = new URLSearchParams({ formato: f.name });
    if (fixo) q.set('fixo', fixo);
    await page.goto('file://' + path.resolve(dir, 'flyer.html') + '?' + q.toString());
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(() => {
      const c = document.querySelector('.content');
      return { scrollH: c.scrollHeight, clientH: c.clientHeight };
    });
    console.log(f.name, JSON.stringify(overflow));
    await page.screenshot({ path: path.join(out, `motoboy-motoja-${f.name}.png`) });
    await page.close();
  }
  await browser.close();
})();
