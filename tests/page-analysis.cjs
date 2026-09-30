/* Run with: node tests/page-analysis.cjs (requires optional Playwright). */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.resolve(path.dirname(process.execPath), '../node_modules/playwright')); }
const candidate = process.env.PAGEPATH_BROWSER || process.env.CHROME_PATH ||
  (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined);
const executablePath = candidate && fs.existsSync(candidate) ? candidate : undefined;
const root = path.resolve(__dirname, '..');
const resultPath = path.join(root, 'test-results');

(async () => {
  const browser = await playwright.chromium.launch({ headless: true, executablePath });
  fs.mkdirSync(resultPath, { recursive: true });
  try {
    const results = [];
    for (const dpr of [1, 1.5, 2]) {
      const context = await browser.newContext({ viewport: { width: 960, height: 640 }, deviceScaleFactor: dpr });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await require('./screenshot-harness.cjs')(page);
      await page.goto('about:blank');
      await page.setContent('<!doctype html><style>' +
        'body{margin:0;background:#fff;font:20px/26px Arial}.card{position:absolute;top:60px;width:280px;height:400px;padding:0}' +
        '#light{left:40px;background:#e6e6e6;color:#202020}#dark{left:370px;background:#202020;color:#efefef}p{margin:30px 22px;height:80px}' +
        '#blank{position:absolute;left:720px;top:70px;width:180px;height:170px}#picture{position:absolute;left:750px;top:300px;width:140px;height:100px}' +
        '#clipped{position:absolute;left:60px;top:500px;width:80px;height:30px;overflow:hidden;white-space:nowrap}' +
        '#invisible{position:absolute;left:700px;top:480px;opacity:0;background:#000;width:100px;height:35px}' +
        '#separator{position:absolute;left:0;top:560px;width:960px;height:1px;background:#d2d2d2}</style>' +
        '<div class="card" id="light"><p>Visual text<br>on a light card</p></div><div class="card" id="dark"><p>Visual text<br>on a dark card</p></div>' +
        '<canvas id="blank" width="180" height="170"></canvas><canvas id="picture" width="140" height="100"></canvas>' +
        '<div id="clipped">Clipped content should stop here</div><div id="invisible">Invisible</div><div id="separator"></div>');
      await page.evaluate(async () => {
        await document.fonts.ready;
        const circle = document.querySelector('#blank').getContext('2d');
        circle.fillStyle = '#186dde'; circle.beginPath(); circle.arc(90, 85, 35, 0, Math.PI * 2); circle.fill();
        const photo = document.querySelector('#picture').getContext('2d');
        for (let y = 0; y < 100; y += 4) for (let x = 0; x < 140; x += 4) {
          photo.fillStyle = 'rgb(' + (30 + (x * 17 + y * 7) % 150) + ' ' + (20 + (x * 13 + y * 29) % 150) + ' ' + (30 + (x * 31 + y * 11) % 140) + ')';
          photo.fillRect(x, y, 4, 4);
        }
      });
      for (const file of ['vendor/opencv/opencv.js', ...['config', 'opencvRuntime', 'imageMapAnalyzer', 'mapCodec', 'pageSnapshot', 'collision'].map(name => 'src/content/' + name + '.js')]) {
        await page.addScriptTag({ path: path.join(root, file) });
      }
      await page.screenshot({ path: path.join(resultPath, 'pagepath-vision-source-dpr' + dpr + '.png') });
      const summary = await page.evaluate(async () => {
        const P = globalThis.__PAGEPATH__;
        const host = document.createElement('div'); document.body.append(host);
        window.captureOverlay = { host, setCaptureHidden() {} };
        window.snapshot = await P.PageSnapshot.capture({ overlay: captureOverlay });
        window.analysis = snapshot.analysis;
        const { width, height, obstacleMask, walkableMask, distanceMap } = analysis;
        const index = P.Collision.createMaskIndex(analysis);
        const contains = (x, y, mask = walkableMask) => mask[y * width + x];
        const density = (x, y, w, h) => {
          let count = 0;
          for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) count += contains(xx, yy, obstacleMask);
          return count / (w * h);
        };
        let invalid = 0;
        for (let i = 0; i < walkableMask.length; i++) {
          if (walkableMask[i] !== Number(distanceMap[i] > analysis.stats.walkableThreshold)) invalid++;
        }
        return { width, height, naturalWidth: snapshot.image.naturalWidth,
          lightText: density(60, 90, 160, 50), darkText: density(390, 90, 160, 50),
          lightBackground: contains(200, 340), darkBackground: contains(530, 340), outerBackground: contains(920, 350),
          darkInsideEdge: contains(370, 300, obstacleMask), darkOutsideEdge: contains(369, 300, obstacleMask),
          darkCorner: contains(370, 60, obstacleMask),
          circle: contains(810, 155, obstacleMask), circleCorner: contains(735, 85, obstacleMask),
          blankCanvas: contains(750, 220), imageDensity: density(755, 305, 130, 90),
          invisible: contains(740, 495, obstacleMask), clippedOutside: density(155, 500, 150, 26),
          separator: contains(500, 560), invalid,
          crossingCircle: P.Collision.segmentHits({ x: 750, y: 155 }, { x: 870, y: 155 }, index),
          clearCanvas: P.Collision.segmentHits({ x: 735, y: 85 }, { x: 880, y: 85 }, index),
          stats: analysis.stats };
      });
      assert.equal(summary.width, 960); assert.equal(summary.height, 640);
      assert.equal(summary.naturalWidth, 960 * dpr, 'device screenshot must normalize to CSS pixels');
      assert.ok(summary.lightText > 0.03 && summary.darkText > 0.03, JSON.stringify(summary));
      for (const key of ['lightBackground', 'darkBackground', 'outerBackground', 'blankCanvas', 'separator', 'circle']) assert.equal(summary[key], 1, key);
      for (const key of ['circleCorner', 'invisible', 'clippedOutside', 'invalid', 'darkInsideEdge', 'darkOutsideEdge', 'darkCorner']) assert.equal(summary[key], 0, key);
      assert.ok(summary.imageDensity > 0.95);
      assert.equal(summary.crossingCircle, true); assert.equal(summary.clearCanvas, false);
      assert.ok(summary.stats.decorativeLines >= 1);
      const diagnostics = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = analysis.width; canvas.height = analysis.height;
        const ctx = canvas.getContext('2d'), mask = ctx.createImageData(canvas.width, canvas.height);
        for (let i = 0; i < analysis.obstacleMask.length; i++) {
          const shade = analysis.obstacleMask[i] ? 0 : 255;
          mask.data.set([shade, shade, shade, 255], i * 4);
        }
        ctx.putImageData(mask, 0, 0);
        const obstacle = canvas.toDataURL('image/png');
        ctx.drawImage(snapshot.image, 0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = 'rgba(255,0,0,0.85)'; ctx.lineWidth = 1; ctx.beginPath();
        const segments = analysis.contours.segments;
        for (let i = 0; i < segments.length; i += 4) { ctx.moveTo(segments[i], segments[i + 1]); ctx.lineTo(segments[i + 2], segments[i + 3]); }
        ctx.stroke();
        return { obstacle, collision: canvas.toDataURL('image/png') };
      });
      for (const [kind, url] of Object.entries(diagnostics)) {
        fs.writeFileSync(path.join(resultPath, 'pagepath-vision-' + kind + '-dpr' + dpr + '.png'), Buffer.from(url.split(',')[1], 'base64'));
      }
      await page.evaluate(() => {
        window.changes = [];
        window.stopWatching = __PAGEPATH__.PageSnapshot.watch(snapshot, { onChange: reason => changes.push(reason) });
        window.originalMask = new Uint8Array(analysis.walkableMask);
        document.querySelector('#light').style.background = '#000';
        document.querySelector('#dark').textContent = 'Entirely different live content';
        stopWatching.check();
      });
      assert.deepEqual(await page.evaluate(() => changes), [], 'live DOM changes cannot invalidate captured pixels');
      assert.equal(await page.evaluate(() => originalMask.every((value, i) => value === analysis.walkableMask[i])), true);
      await page.setViewportSize({ width: 940, height: 640 });
      await page.evaluate(() => stopWatching.check());
      assert.equal(await page.evaluate(() => changes.length), 1);
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.5 });
      const pinchError = await page.evaluate(async () => {
        try { await __PAGEPATH__.PageSnapshot.capture({ overlay: captureOverlay }); return null; }
        catch (error) { return error.message; }
      });
      assert.match(pinchError, /恢复触控手势缩放/, 'pinch zoom must not generate offscreen, unplayable nodes');
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
      await cdp.detach();
      await page.evaluate(() => { stopWatching(); snapshot.destroy(); captureOverlay.host.remove(); });
      assert.deepEqual(errors, []);
      results.push({ dpr, ...summary.stats }); await context.close();
    }
    console.log('Screenshot/OpenCV browser checks passed.', JSON.stringify(results));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
