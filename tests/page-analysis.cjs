/* Run with: node tests/page-analysis.cjs (requires the optional Playwright dev dependency). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.resolve(path.dirname(process.execPath), '../node_modules/playwright')); }
const candidate = process.env.PAGEPATH_BROWSER || process.env.CHROME_PATH ||
  (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined);
const executablePath = candidate && fs.existsSync(candidate) ? candidate : undefined;

(async () => {
  const browser = await playwright.chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  try {
    await page.setContent(`<!doctype html><style>
      body { margin:0; background:#eee; font:20px/24px Arial; min-height:1200px }
      #paragraph { position:absolute; left:40px; top:40px; width:600px; height:100px; margin:0 }
      #clip { position:absolute; left:500px; top:200px; width:100px; height:30px; overflow:hidden; white-space:nowrap }
      #timer { position:absolute; left:40px; top:240px; font:20px/24px monospace }
      #invisible { position:absolute; left:500px; top:400px; opacity:0 }
      #media { position:absolute; left:800px; top:400px; width:100px; height:60px }
      #hidden { display:none; position:absolute; left:500px; top:500px }
    </style><p id="paragraph">Hello world</p>
    <div id="clip">A long clipped line of text extends past this box.</div>
    <span id="timer">00:01</span><div id="invisible">Invisible text</div>
    <canvas id="media" width="100" height="60"></canvas><button id="hidden">Hidden button</button>`);
    for (const file of ['config.js', 'collision.js', 'obstacleDetector.js', 'pageAnalyzer.js']) {
      await page.addScriptTag({ path: path.join(__dirname, '..', 'src', 'content', file) });
    }
    const summary = await page.evaluate(() => {
      const P = globalThis.__PAGEPATH__;
      window.analysis = P.PageAnalyzer.analyze();
      const contains = (x, y) => analysis.rects.some(r => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height);
      const index = P.Collision.createIndex(analysis.rects);
      return { text: contains(60, 50), paragraphWhitespace: contains(600, 80), pageBackground: contains(1100, 700),
        media: contains(850, 430), invisible: contains(520, 405), clippedOutside: contains(630, 210),
        threePixelGap: P.Collision.segmentHits({ x: 797, y: 410 }, { x: 797, y: 450 }, index),
        twoPixelGap: P.Collision.pointHits({ x: 798, y: 430 }, index),
        crossingMedia: P.Collision.segmentHits({ x: 780, y: 430 }, { x: 920, y: 430 }, index),
        stats: analysis.stats, watchTargets: analysis.watchTargets.length };
    });
    assert.equal(summary.text, true);
    assert.equal(summary.paragraphWhitespace, false, 'paragraph boxes must not swallow empty space');
    assert.equal(summary.pageBackground, false, 'body background must not block the viewport');
    assert.equal(summary.media, true);
    assert.equal(summary.invisible, false);
    assert.equal(summary.clippedOutside, false, 'overflow-hidden text must be clipped');
    assert.equal(summary.threePixelGap, false, 'a line 3px outside visible content must now pass');
    assert.equal(summary.twoPixelGap, true, 'the remaining 2px safety margin still blocks boundary contact');
    assert.equal(summary.crossingMedia, true, 'smaller padding must not allow fast movements through content');
    assert.equal(summary.stats.mediaCount, 1);
    assert.ok(summary.watchTargets <= 80);

    await page.evaluate(() => {
      window.changes = [];
      window.stopWatching = __PAGEPATH__.PageAnalyzer.watch(analysis, { onChange: reason => changes.push(reason) });
      document.querySelector('#timer').firstChild.nodeValue = '00:02';
    });
    await page.waitForTimeout(450);
    assert.deepEqual(await page.evaluate(() => changes), [], 'same-size timer text must not pause the game');
    await page.evaluate(() => {
      document.querySelector('#hidden').style.display = 'block';
      stopWatching.check();
    });
    assert.equal(await page.evaluate(() => changes.length), 1, 'showing content must invalidate the map');
    await page.evaluate(() => {
      document.querySelector('#hidden').style.display = 'none';
      window.changes = [];
      window.analysis = __PAGEPATH__.PageAnalyzer.analyze();
      window.stopWatching = __PAGEPATH__.PageAnalyzer.watch(analysis, { onChange: reason => changes.push(reason) });
      stopWatching();
      document.querySelector('#paragraph').style.left = '100px';
    });
    await page.waitForTimeout(450);
    assert.deepEqual(await page.evaluate(() => changes), [], 'cleanup must disconnect callbacks and timers');
    await page.evaluate(() => {
      window.analysis = __PAGEPATH__.PageAnalyzer.analyze();
      window.stopWatching = __PAGEPATH__.PageAnalyzer.watch(analysis, { onChange: reason => changes.push(reason) });
      const box = document.createElement('button');
      box.style.cssText = 'position:fixed;left:300px;top:500px';
      box.textContent = 'New visible menu';
      document.body.append(box);
      stopWatching.check();
    });
    assert.equal(await page.evaluate(() => changes.length), 1, 'new content must invalidate the map before collision checks');
    await page.evaluate(() => {
      window.changes = [];
      window.analysis = __PAGEPATH__.PageAnalyzer.analyze();
      window.stopWatching = __PAGEPATH__.PageAnalyzer.watch(analysis, { onChange: reason => changes.push(reason) });
    });
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => changes.length), 1, 'viewport resize must pause the map');
    await page.evaluate(() => {
      window.changes = [];
      window.analysis = __PAGEPATH__.PageAnalyzer.analyze();
      window.stopWatching = __PAGEPATH__.PageAnalyzer.watch(analysis, { onChange: reason => changes.push(reason) });
    });
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.2 });
    await page.evaluate(() => stopWatching.check());
    assert.equal(await page.evaluate(() => changes.length), 1, 'visual viewport pinch zoom must pause the map');
    await session.detach();
    console.log('Page analysis browser checks passed.', JSON.stringify(summary.stats));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
