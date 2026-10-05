// Captures full-page screenshots at desktop, tablet and phone widths for visual comparison with the
// reference. Usage: node scripts/screenshots.js [baseUrl] [outDir] [paths...]
// Uses the Playwright install available on the machine (PLAYWRIGHT_BROWSERS_PATH / CHROMIUM_PATH).
const path = require('node:path');
const fs = require('node:fs');

let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('playwright-core')); }

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1 },
  { name: 'tablet', width: 820, height: 1180, deviceScaleFactor: 1 },
  { name: 'phone', width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];

async function main() {
  const base = process.argv[2] || 'http://localhost:4100';
  const out = path.resolve(process.argv[3] || 'screenshots');
  const paths = process.argv.slice(4).length ? process.argv.slice(4) : ['/'];
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  for (const vp of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.deviceScaleFactor, isMobile: vp.isMobile, hasTouch: vp.hasTouch });
    for (const p of paths) {
      await page.goto(base + p, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      const file = path.join(out, `${vp.name}${p === '/' ? '-home' : p.replace(/[^a-z0-9]+/gi, '-')}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(file);
    }
    await page.close();
  }
  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
