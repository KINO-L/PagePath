'use strict';
// Optional developer utility: rasterize the local SVG for Chrome's icon sizes.
const fs = require('node:fs');
const path = require('node:path');
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.resolve(path.dirname(process.execPath), '../node_modules/playwright')); }
const root = path.resolve(__dirname, '..');
const candidate = process.env.PAGEPATH_BROWSER || (process.platform === 'win32'
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined);

(async () => {
  const browser = await playwright.chromium.launch({ headless: true,
    executablePath: candidate && fs.existsSync(candidate) ? candidate : undefined });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const svg = fs.readFileSync(path.join(root, 'icons/icon.svg'), 'utf8');
    for (const size of [16, 32, 48, 128]) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${svg}`);
      await page.screenshot({ path: path.join(root, `icons/icon${size}.png`), omitBackground: true });
    }
    console.log('Rendered local brush icons: 16, 32, 48, 128 px.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
