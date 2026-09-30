/* Real screenshot/OpenCV regression for compact DOM assistance. */
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
const bounds = { width: 1080, height: 760 };
const fixture = `<!doctype html><style>
  * { box-sizing: border-box; } body { margin: 0; background: white; font: 20px/28px Arial; }
  button { position: absolute; border: 2px solid #252525; background: #ececec; color: #202020;
    border-radius: 12px; font: 18px Arial; padding: 0; }
  #compact { left: 40px; top: 50px; width: 180px; height: 48px; }
  #label { position: absolute; left: 260px; top: 58px; font: 24px/28px monospace; white-space: pre; }
  #icon { position: absolute; left: 440px; top: 50px; width: 48px; height: 48px; }
  #empty { position: absolute; left: 580px; top: 50px; width: 70px; height: 45px; }
  #covered { left: 730px; top: 50px; width: 160px; height: 48px; }
  #cover { position: absolute; left: 725px; top: 45px; width: 170px; height: 58px; background: white; }
  #card { position: absolute; left: 30px; top: 190px; width: 450px; height: 320px; background: #e6e6e6; }
  #card-label { position: absolute; left: 30px; top: 28px; font: 24px/28px monospace; white-space: pre; }
  #graphic { position: absolute; left: 580px; top: 200px; width: 380px; height: 300px; }
  #moving { left: 60px; top: 580px; width: 140px; height: 48px; }
  #pointer-covered { left: 600px; top: 580px; width: 200px; height: 60px; background: #202020; border: 0; border-radius: 0; }
  #pointer-cover { position: absolute; left: 610px; top: 570px; width: 190px; height: 80px;
    background: white; pointer-events: none; }
  #center-covered { left: 850px; top: 580px; width: 200px; height: 60px; background: #202020; border: 0; border-radius: 0; }
  #center-cover { position: absolute; left: 890px; top: 570px; width: 120px; height: 80px;
    background: white; pointer-events: none; }
</style>
<button id="compact">Small action</button><span id="label">Small text</span>
<svg id="icon" viewBox="0 0 48 48"><circle cx="24" cy="24" r="18" fill="none" stroke="#202020" stroke-width="4"/></svg>
<canvas id="empty" width="70" height="45"></canvas>
<button id="covered">Hidden action</button><div id="cover"></div>
<div id="card"><span id="card-label">Small text</span></div>
<svg id="graphic" viewBox="0 0 380 300"><circle cx="190" cy="150" r="75" fill="#186dde"/></svg>
<button id="moving">Moving action</button>
<button id="pointer-covered" aria-label="Partially visible action"></button><div id="pointer-cover"></div>
<button id="center-covered" aria-label="Center covered action"></button><div id="center-cover"></div>`;

(async () => {
  const browser = await playwright.chromium.launch({ headless: true, executablePath });
  fs.mkdirSync(resultPath, { recursive: true });
  try {
    const results = [];
    for (const dpr of [1, 2]) {
      const context = await browser.newContext({ viewport: bounds, deviceScaleFactor: dpr });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setContent(fixture);
      await page.evaluate(() => document.fonts.ready);
      for (const file of ['vendor/opencv/opencv.js', ...[
        'config', 'compactDom', 'compactMask', 'opencvRuntime', 'imageMapAnalyzer',
        'collision', 'grid', 'pathfinding', 'scoring', 'levelGenerator'
      ].map(name => 'src/content/' + name + '.js')]) {
        await page.addScriptTag({ path: path.join(root, file) });
      }
      await page.evaluate(bounds => { window.beforeHints = __PAGEPATH__.CompactDOM.collect(bounds); }, bounds);
      const screenshot = await page.screenshot({ path: path.join(resultPath, `pagepath-hybrid-source-dpr${dpr}.png`) });
      // Simulate content moving during capture. Only hints stable across both
      // observations may assist the frozen screenshot's map.
      await page.evaluate(bounds => {
        document.querySelector('#moving').style.left = '230px';
        window.afterHints = __PAGEPATH__.CompactDOM.collect(bounds);
        window.domHints = __PAGEPATH__.CompactMask.stable(beforeHints, afterHints, bounds);
      }, bounds);
      const summary = await page.evaluate(async ({ dataUrl, bounds }) => {
        const P = __PAGEPATH__;
        const image = new Image(); image.src = dataUrl; await image.decode();
        const canvas = new OffscreenCanvas(bounds.width, bounds.height), ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0, bounds.width, bounds.height);
        const pixels = ctx.getImageData(0, 0, bounds.width, bounds.height);
        window.imageMap = await P.ImageMapAnalyzer.analyze(pixels);
        window.hybridMap = await P.ImageMapAnalyzer.analyze(pixels, { domHints });
        window.sourceImage = image;
        const at = (map, x, y, name = 'obstacleMask') => map[name][y * map.width + x];
        const added = (x, y, width, height) => {
          let count = 0;
          for (let yy = y; yy < y + height; yy++) for (let xx = x; xx < x + width; xx++) {
            const i = yy * hybridMap.width + xx;
            count += hybridMap.obstacleMask[i] && !imageMap.obstacleMask[i] ? 1 : 0;
          }
          return count;
        };
        const point = (x, y) => ({ image: at(imageMap, x, y), hybrid: at(hybridMap, x, y),
          walkable: at(hybridMap, x, y, 'walkableMask') });
        let maskDisagreement = 0, removedForeground = 0;
        for (let i = 0; i < hybridMap.walkableMask.length; i++) {
          if (hybridMap.walkableMask[i] !== Number(hybridMap.distanceMap[i] > hybridMap.stats.walkableThreshold)) maskDisagreement++;
          if (imageMap.obstacleMask[i] && !hybridMap.obstacleMask[i]) removedForeground++;
        }
        const index = P.Collision.createMaskIndex(hybridMap);
        const random = initial => {
          let seed = initial;
          return () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296; };
        };
        const levels = [];
        for (const mode of ['normal', 'hell', 'immortal']) {
          const level = P.LevelGenerator.generate(hybridMap, [], random(73), mode);
          const collected = new Set([level.nodes[0].id]);
          let collisions = 0, length = 0;
          for (let i = 1; i < level.referencePath.length; i++) {
            const a = level.referencePath[i - 1], b = level.referencePath[i];
            if (P.Collision.segmentHits(a, b, index)) collisions++;
            length += P.Collision.distance(a, b);
            for (const node of level.nodes) {
              if (P.Collision.segmentCircleEntry(a, b, node, P.Config.HIT_RADIUS) !== null) collected.add(node.id);
            }
          }
          const labels = new Set(level.nodes.map(node =>
            hybridMap.componentLabels[Math.floor(node.y) * hybridMap.width + Math.floor(node.x)]));
          levels.push({ mode, nodes: level.nodes.length, collected: collected.size, collisions,
            collisionMapShared: level.obstacleIndex.walkableMask === hybridMap.walkableMask,
            blockedNodes: level.nodes.filter(node => P.Collision.pointHits(node, index)).length,
            connected: labels.size === 1 && !labels.has(0), length,
            referenceLength: level.referenceLength, maxInk: level.maxInk });
        }
        return { beforeHints, afterHints, domHints, stats: hybridMap.stats, levels,
          maskDisagreement, removedForeground,
          compactInterior: point(65, 84), compactRoundedCorner: point(40, 50),
          iconCenter: point(464, 74), cardWhitespace: point(320, 420),
          graphicWhitespace: point(610, 230), graphicSubject: point(770, 350),
          emptyCanvas: point(610, 70), occludedControl: point(810, 70),
          pointerCoveredArea: point(730, 610), pointerVisibleStrip: point(605, 610),
          pointerCoveredAdded: added(610, 580, 190, 60),
          centerCoveredArea: point(950, 610), centerVisibleLeft: point(870, 610), centerVisibleRight: point(1030, 610),
          centerCoveredAdded: added(890, 580, 120, 60),
          movedOldInterior: point(78, 614), movedNewBlank: point(250, 614),
          labelAdded: added(260, 58, 160, 28), nestedLabelAdded: added(60, 218, 160, 28),
          largeCardAdded: added(30, 260, 450, 250), largeGraphicAdded: added(580, 200, 380, 300),
          crossingCompact: P.Collision.segmentHits({ x: 30.5, y: 84.5 }, { x: 230.5, y: 84.5 }, index),
          crossingCardWhitespace: P.Collision.segmentHits({ x: 60.5, y: 420.5 }, { x: 450.5, y: 420.5 }, index),
          crossingPointerCover: P.Collision.segmentHits({ x: 650.5, y: 610.5 }, { x: 790.5, y: 610.5 }, index),
          crossingCenterCover: P.Collision.segmentHits({ x: 905.5, y: 610.5 }, { x: 995.5, y: 610.5 }, index),
          crossingGraphicWhitespace: P.Collision.segmentHits({ x: 600.5, y: 225.5 }, { x: 940.5, y: 225.5 }, index) };
      }, { dataUrl: 'data:image/png;base64,' + screenshot.toString('base64'), bounds });

      assert.ok(summary.domHints.some(h => h.x === 40 && h.y === 50 && h.kind === 'box'), 'compact painted control must be a DOM candidate');
      assert.ok(summary.beforeHints.some(h => h.x === 60 && h.y === 580), 'moving control was initially eligible');
      assert.ok(summary.afterHints.some(h => h.x === 230 && h.y === 580), 'moving control changed position');
      assert.ok(!summary.domHints.some(h => h.y === 580 && h.width === 140), 'unstable controls must fall back to screenshot-only geometry');
      assert.ok(!summary.domHints.some(h => h.x === 730 && h.y === 50), 'fully covered controls must be excluded');
      assert.ok(summary.domHints.some(h => h.x === 600 && h.y === 580), 'pointer-events:none cover deliberately bypasses DOM hit-testing');
      assert.ok(summary.domHints.some(h => h.x === 850 && h.y === 580), 'center cover leaves a full-span but disconnected foreground candidate');
      assert.deepEqual(summary.compactInterior, { image: 0, hybrid: 1, walkable: 0 }, JSON.stringify(summary));
      assert.deepEqual(summary.iconCenter, { image: 0, hybrid: 1, walkable: 0 });
      assert.ok(summary.labelAdded > 100, 'compact visible text must merge letter gaps: ' + JSON.stringify(summary));
      assert.ok(summary.nestedLabelAdded > 100, 'small descendants inside large cards may still merge');
      for (const key of ['compactRoundedCorner', 'cardWhitespace', 'graphicWhitespace', 'emptyCanvas',
        'occludedControl', 'pointerCoveredArea', 'centerCoveredArea', 'movedOldInterior', 'movedNewBlank']) {
        assert.equal(summary[key].image, 0, key + ' source must be empty');
        assert.equal(summary[key].hybrid, 0, key + ' must not become an invisible rectangular wall');
      }
      for (const key of ['cardWhitespace', 'graphicWhitespace', 'emptyCanvas', 'occludedControl', 'pointerCoveredArea', 'centerCoveredArea',
        'movedOldInterior', 'movedNewBlank']) assert.equal(summary[key].walkable, 1, key + ' remains reachable');
      assert.deepEqual(summary.pointerVisibleStrip, { image: 1, hybrid: 1, walkable: 0 }, 'visible strip remains a real obstacle');
      assert.equal(summary.pointerCoveredAdded, 0, 'screenshot evidence cannot expand a narrow visible strip across an opaque cover');
      for (const key of ['centerVisibleLeft', 'centerVisibleRight']) {
        assert.deepEqual(summary[key], { image: 1, hybrid: 1, walkable: 0 }, 'both visible sides remain real obstacles');
      }
      assert.equal(summary.centerCoveredAdded, 0, 'a full foreground bounding box must not bridge an opaque center cover');
      assert.equal(summary.graphicSubject.hybrid, 1, 'large foreground continues using the image silhouette');
      assert.equal(summary.largeCardAdded, 0, 'large card background must never be filled from its DOM bounds');
      assert.equal(summary.largeGraphicAdded, 0, 'large graphic must remain pixel precise');
      assert.equal(summary.maskDisagreement, 0);
      assert.equal(summary.removedForeground, 0);
      assert.equal(summary.crossingCompact, true);
      assert.equal(summary.crossingCardWhitespace, false);
      assert.equal(summary.crossingPointerCover, false);
      assert.equal(summary.crossingCenterCover, false);
      assert.equal(summary.crossingGraphicWhitespace, false);
      for (const level of summary.levels) {
        assert.equal(level.collisionMapShared, true);
        assert.equal(level.collisions, 0);
        assert.equal(level.blockedNodes, 0);
        assert.equal(level.connected, true);
        assert.equal(level.collected, level.nodes);
        assert.ok(level.length <= level.maxInk);
        assert.ok(Math.abs(level.length - level.referenceLength) < 1e-8);
      }
      const diagnostics = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = hybridMap.width; canvas.height = hybridMap.height;
        const ctx = canvas.getContext('2d');
        const render = map => {
          ctx.drawImage(sourceImage, 0, 0, canvas.width, canvas.height);
          ctx.strokeStyle = 'rgba(230,35,35,.85)'; ctx.lineWidth = 1; ctx.beginPath();
          for (let i = 0; i < map.contours.segments.length; i += 4) {
            const s = map.contours.segments;
            ctx.moveTo(s[i], s[i + 1]); ctx.lineTo(s[i + 2], s[i + 3]);
          }
          ctx.stroke(); return canvas.toDataURL('image/png');
        };
        return { image: render(imageMap), hybrid: render(hybridMap) };
      });
      for (const [kind, dataUrl] of Object.entries(diagnostics)) {
        fs.writeFileSync(path.join(resultPath, `pagepath-hybrid-${kind}-dpr${dpr}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
      }
      assert.deepEqual(errors, []);
      results.push({ dpr, hints: summary.domHints.length, stats: summary.stats, levels: summary.levels });
      await context.close();
    }
    console.log('Hybrid screenshot/DOM browser checks passed.', JSON.stringify(results));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
