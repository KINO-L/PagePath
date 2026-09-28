const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.resolve(path.dirname(process.execPath), '../node_modules/playwright')); }
const candidate = process.env.PAGEPATH_BROWSER || (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined);
const executablePath = candidate && fs.existsSync(candidate) ? candidate : undefined;
const state = page => page.evaluate(() => globalThis.__PAGEPATH__?.instance?.state || 'DESTROYED');
async function waitState(page, target) {
  await page.waitForFunction(target => globalThis.__PAGEPATH__?.instance?.state === target, target, { timeout: 6000 });
}
async function ready(page) {
  await page.locator('#launch').click();
  await page.waitForFunction(() => ['READY','PAUSED'].includes(globalThis.__PAGEPATH__?.instance?.state));
  assert.equal(await state(page), 'READY', await page.locator('#__pagepath_overlay__').evaluate(el => el.shadowRoot.querySelector('.message').textContent));
}
async function solve(page, shownAnswer = false) {
  const route = await page.evaluate(shown => {
    const game = globalThis.__PAGEPATH__.instance;
    // Following the displayed SVG verifies the hint itself, not just hidden data.
    return shown ? Array.from(game.overlay.hintLayer.querySelector('.hint-path').points, p => ({ x: p.x, y: p.y }))
      : game.level.referencePath;
  }, shownAnswer);
  await page.mouse.move(route[0].x, route[0].y);
  await page.mouse.down();
  await page.waitForFunction(() => document.querySelector('[data-pagepath-root]').shadowRoot.querySelector('.mode-select').disabled);
  assert.equal(await page.locator('[data-pagepath-root] .hint').isDisabled(), true);
  for (const point of route.slice(1)) {
    await page.mouse.move(point.x, point.y, { steps: 2 });
    if (await state(page) === 'SUCCESS') break;
  }
  assert.equal(await state(page), 'SUCCESS');
  await page.mouse.up();
}

async function verifyTrail(page, mode) {
  const result = await page.evaluate(() => {
    const game = globalThis.__PAGEPATH__.instance;
    return { mode: game.mode, levelMode: game.level.mode, length: game.length,
      drawn: game.overlay.path.getTotalLength(), cap: game.level.trailLength,
      inkMultiplier: game.level.inkMultiplier, nodes: game.level.nodes.length,
      maxInk: game.level.maxInk, referenceLength: game.level.referenceLength,
      modeTitle: game.overlay.modeSelect.title, controlTitle: game.overlay.modeControl.title,
      consumed: game.level.maxInk - game.length };
  });
  assert.equal(result.mode, mode);
  assert.equal(result.levelMode, mode);
  const sparePercent = mode === 'hell' ? 10 + Math.max(0, result.nodes - 5) * 1.5 : mode === 'normal' ? 22 : 10;
  const expectedMultiplier = 1 + sparePercent / 100;
  assert.ok(Math.abs(result.inkMultiplier - expectedMultiplier) < 1e-12,
    'Hell budgets depend on this map\'s actual node count; the other modes keep their fixed allowance');
  assert.ok(Math.abs(result.maxInk / result.referenceLength - expectedMultiplier) < 1e-12);
  assert.match(result.modeTitle, new RegExp(`(?:^|[^\\d.])${String(sparePercent).replace('.', '\\.')}%`),
    'the difficulty tooltip must show this map\'s actual ink allowance');
  assert.equal(result.controlTitle, result.modeTitle, 'the visible difficulty icon shares the accurate tooltip');
  assert.equal(result.cap, 45);
  assert.ok(result.drawn <= result.cap + 1 && result.drawn > 0, 'only the recent tail is visible, including on success');
  assert.ok(result.length > result.drawn * 3, 'ink still counts the full route even when old line segments disappear');
  assert.ok(result.consumed > 0, 'the witness remains solvable with the configured ink');
  return result;
}

(async () => {
  const server = spawn(process.execPath, ['scripts/serve.cjs'], { cwd: root, stdio: ['ignore','pipe','pipe'], windowsHide: true });
  let browser;
  try {
    await new Promise((resolve,reject) => { server.stdout.once('data',resolve); server.once('error',reject); server.once('exit', code => reject(new Error(`Fixture server exited ${code}`))); });
    browser = await playwright.chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const results = [];
    for (const type of ['simple','article','github','dashboard','shop','spa']) {
      await page.goto(`http://127.0.0.1:4173/?type=${type}`);
      await page.evaluate(() => document.fonts.ready);
      const before = await page.locator('#content').boundingBox();
      await ready(page);
      const metrics = await page.evaluate(() => {
        const { level, analysis } = globalThis.__PAGEPATH__.instance;
        const C = globalThis.__PAGEPATH__.Collision;
        return { nodes: level.nodes.length, analysisMs: analysis.stats.analysisMs, obstacleCount: analysis.rects.length,
          safe: level.nodes.every(n => !C.pointHits(n, level.obstacleIndex, 14)), referenceLength: level.referenceLength };
      });
      assert.ok(metrics.safe && metrics.nodes >= 4);
      assert.deepEqual(await page.locator('#content').boundingBox(), before);
      if (type === 'simple') {
        fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
        const pen = await page.evaluate(() => globalThis.__PAGEPATH__.instance.level.nodes[0]);
        await page.mouse.move(pen.x, pen.y);
        await page.screenshot({ path: path.join(root, 'test-results/pagepath-ink-ready.png') });
      }
      await solve(page);
      await verifyTrail(page, 'normal');
      const message = await page.locator('#__pagepath_overlay__').evaluate(el => el.shadowRoot.querySelector('.message').textContent);
      assert.match(message, /得分.*难度.*效率/);
      if (type === 'simple') {
        fs.mkdirSync(path.join(root,'test-results'), { recursive: true });
        await page.screenshot({ path: path.join(root,'test-results/pagepath-success.png') });
      }
      await page.locator('[data-pagepath-root] .mode-select').selectOption('hell');
      await waitState(page, 'READY');
      const readyBudget = await page.evaluate(() => {
        const game = globalThis.__PAGEPATH__.instance;
        return { nodes: game.level.nodes.length, title: game.overlay.modeSelect.title };
      });
      const readySpare = 10 + Math.max(0, readyBudget.nodes - 5) * 1.5;
      assert.match(readyBudget.title, new RegExp(`(?:^|[^\\d.])${String(readySpare).replace('.', '\\.')}%`),
        'the ready-state tooltip must already reflect the generated Hell map');
      assert.doesNotMatch(readyBudget.title, /(?:^|[^\d.])10%/, 'roomy Hell maps must include the node allowance above the 10% baseline');
      const hint = page.locator('[data-pagepath-root] .hint');
      assert.equal(await hint.getAttribute('aria-pressed'), 'false');
      const reservedBeforeHint = await page.evaluate(() => globalThis.__PAGEPATH__.instance.overlay.getReservedRects());
      await hint.click();
      assert.equal(await hint.getAttribute('aria-pressed'), 'true');
      const answer = await page.evaluate(() => {
        const game = globalThis.__PAGEPATH__.instance;
        return { actual: game.overlay.hintLayer.querySelector('.hint-path').getTotalLength(),
          expected: game.level.referenceLength, ink: game.length, collected: game.collected.size,
          pointerEvents: getComputedStyle(game.overlay.hintLayer).pointerEvents };
      });
      assert.ok(Math.abs(answer.actual - answer.expected) < 2, 'hint displays the complete budgeted reference route');
      assert.equal(answer.ink, 0);
      assert.equal(answer.collected, 0);
      assert.equal(answer.pointerEvents, 'none');
      assert.deepEqual(await page.evaluate(() => globalThis.__PAGEPATH__.instance.overlay.getReservedRects()), reservedBeforeHint);
      if (type === 'simple') await page.screenshot({ path: path.join(root, 'test-results/pagepath-hint.png') });
      await hint.click();
      assert.equal(await hint.getAttribute('aria-pressed'), 'false');
      await hint.click();
      await solve(page, true);
      const hell = await verifyTrail(page, 'hell');
      assert.ok(hell.nodes >= 14 && hell.nodes <= 16, 'roomy fixtures restore the 14–16-target Hell layout');
      assert.deepEqual(await page.locator('#content').boundingBox(), before);
      if (type === 'simple') {
        await page.screenshot({ path: path.join(root,'test-results/pagepath-hell.png') });
        await page.locator('[data-pagepath-root] .retry').click();
        await waitState(page, 'READY');
        assert.equal(await hint.getAttribute('aria-pressed'), 'true', 'same-map retry keeps the answer available');
        assert.equal(await page.locator('[data-pagepath-root] .mode-select').inputValue(), 'hell');
        const previousPositions = await page.evaluate(() => globalThis.__PAGEPATH__.instance.level.nodes.map(({ x, y }) => ({ x, y })));
        await page.locator('[data-pagepath-root] .new-puzzle').click();
        await waitState(page, 'READY');
        assert.equal(await hint.getAttribute('aria-pressed'), 'false', 'a new map clears the previous answer');
        assert.equal(await page.evaluate(() => globalThis.__PAGEPATH__.instance.level.mode), 'hell');
        const variety = await page.evaluate(previous => {
          const game = globalThis.__PAGEPATH__.instance;
          const distances = game.level.nodes.map(point => Math.min(...previous.map(other => Math.hypot(point.x - other.x, point.y - other.y))));
          return { moved: distances.filter(value => value >= 48).length, total: distances.length,
            averageDistance: distances.reduce((sum, value) => sum + value, 0) / distances.length,
            historyCount: game.recentLayouts.length };
        }, previousPositions);
        assert.ok(variety.moved >= variety.total / 2, 'New Puzzle changes actual positions, not just node order or endpoints');
        assert.equal(variety.historyCount, 3, 'Normal, Hell and New Puzzle positions are tracked on this page');
        metrics.newPuzzleVariation = variety;
        await hint.click();
        await page.screenshot({ path: path.join(root, 'test-results/pagepath-variety-new-map.png') });
        await solve(page, true);
        await page.locator('[data-pagepath-root] .mode-select').focus();
        await page.keyboard.press('Home');
        await waitState(page, 'READY');
        assert.equal(await page.evaluate(() => globalThis.__PAGEPATH__.instance.level.inkMultiplier), 1.22);
      }
      await page.locator('[data-pagepath-root] .mode-select').selectOption('immortal');
      await waitState(page, 'READY');
      assert.match(await page.locator('[data-pagepath-root] .mode-select').getAttribute('title'), /神仙.*10%/);
      await hint.click();
      await solve(page, true);
      const immortal = await verifyTrail(page, 'immortal');
      assert.ok(immortal.nodes >= 14 && immortal.nodes <= 16);
      assert.match(await page.locator('[data-pagepath-root] .message').textContent(), /神仙.*得分/);
      if (type === 'simple') {
        await page.screenshot({ path: path.join(root, 'test-results/pagepath-immortal.png') });
        await page.locator('[data-pagepath-root] .retry').click();
        await waitState(page, 'READY');
        assert.equal(await hint.getAttribute('aria-pressed'), 'true');
        await page.locator('[data-pagepath-root] .new-puzzle').click();
        await waitState(page, 'READY');
        assert.equal(await page.locator('[data-pagepath-root] .mode-select').inputValue(), 'immortal');
        assert.equal(await hint.getAttribute('aria-pressed'), 'false');
        assert.equal(await page.evaluate(() => globalThis.__PAGEPATH__.instance.level.inkMultiplier), 1.10);
      }
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('[data-pagepath-root]').count(), 0);
      assert.deepEqual(await page.locator('#content').boundingBox(), before);
      results.push({ type, ...metrics, completed: true, hellNodes: hell.nodes, hellCompleted: true,
        immortalNodes: immortal.nodes, immortalCompleted: true, displayedAnswerCompleted: true });
    }

    await page.goto('http://127.0.0.1:4173/?type=simple');
    await ready(page);
    const original = await page.evaluate(() => JSON.stringify(globalThis.__PAGEPATH__.instance.level.nodes));
    const start = await page.evaluate(() => globalThis.__PAGEPATH__.instance.level.nodes[0]);
    await page.mouse.move(start.x,start.y); await page.mouse.down(); await page.mouse.up();
    assert.equal(await state(page), 'FAILED');
    await waitState(page,'READY');
    assert.equal(await page.evaluate(() => JSON.stringify(globalThis.__PAGEPATH__.instance.level.nodes)), original);
    await page.mouse.move(start.x,start.y); await page.mouse.down();
    const obstacle = await page.evaluate(() => globalThis.__PAGEPATH__.instance.analysis.rects.find(r => r.width > 30 && r.y > 150));
    await page.mouse.move(obstacle.x + obstacle.width/2, obstacle.y + obstacle.height/2);
    assert.equal(await state(page), 'FAILED'); await page.mouse.up();
    await waitState(page,'READY');
    await page.evaluate(() => { globalThis.__PAGEPATH__.instance.level.maxInk = 0.1; });
    await page.mouse.move(start.x,start.y); await page.mouse.down();
    await page.mouse.move(start.x + 2, start.y + 2);
    assert.equal(await state(page),'FAILED'); await page.mouse.up();
    await page.keyboard.press('Escape');

    // Right-click exits both an idle map and an active left-button stroke.
    await page.evaluate(() => {
      window.pageContextMenus = 0;
      document.addEventListener('contextmenu', () => window.pageContextMenus++);
    });
    for (const drawing of [false, true]) {
      await ready(page);
      if (drawing) {
        const start = await page.evaluate(() => globalThis.__PAGEPATH__.instance.level.nodes[0]);
        await page.mouse.move(start.x, start.y); await page.mouse.down();
        await waitState(page, 'DRAWING');
      } else await page.mouse.move(1100, 820);
      await page.mouse.down({ button: 'right' });
      await page.mouse.up({ button: 'right' });
      await page.waitForFunction(() => !document.querySelector('[data-pagepath-root]'));
      if (drawing) await page.mouse.up();
      assert.equal(await page.evaluate(() => window.pageContextMenus), 0, 'right-click does not open the website context menu');
    }

    for (let repeat = 0; repeat < 5; repeat++) {
      await ready(page);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('[data-pagepath-root]').count(), 0);
    }
    await ready(page);
    await page.evaluate(() => window.scrollTo(0,180));
    await waitState(page,'PAUSED');
    await page.locator('#__pagepath_overlay__').locator('.regenerate').click();
    await waitState(page,'READY');
    await page.setViewportSize({ width: 1100, height: 800 });
    await waitState(page,'PAUSED');
    await page.keyboard.press('Escape');

    await page.goto('http://127.0.0.1:4173/?type=spa');
    await ready(page);
    await page.waitForTimeout(1200);
    assert.equal(await state(page), 'READY', 'equal-width clock tick must not pause');
    await page.evaluate(() => document.getElementById('mutate').click());
    await waitState(page,'PAUSED');
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ browser: executablePath || 'Playwright Chromium', results, additionalChecks: ['release and retry same map','segment collision','ink exhaustion','right-click exits idle and drawing maps','repeated cleanup','scroll/regenerate','resize','SPA clock and structural change'], errors }, null, 2));
  } finally { await browser?.close(); server.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
