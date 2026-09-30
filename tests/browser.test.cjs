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
  await page.waitForFunction(target => globalThis.__PAGEPATH__?.instance?.state === target, target, { timeout: 30000 });
}
async function verifyToolbarFold(page, folded) {
  const result = await page.evaluate(() => {
    const overlay = __PAGEPATH__.instance.overlay;
    return { visibility: getComputedStyle(overlay.toolbarMain).visibility,
      inert: overlay.toolbarMain.inert, pointerEvents: getComputedStyle(overlay.toolbar).pointerEvents };
  });
  assert.equal(result.visibility, folded ? 'hidden' : 'visible');
  assert.equal(result.inert, folded);
  assert.equal(result.pointerEvents, folded ? 'none' : 'auto');
}
async function verifyCursor(page, drawing) {
  const result = await page.evaluate(() => {
    const overlay = __PAGEPATH__.instance.overlay;
    return { cursor: getComputedStyle(overlay.surface).cursor,
      brush: getComputedStyle(overlay.brushCursor).display !== 'none',
      ink: getComputedStyle(overlay.cursorInk).display !== 'none' };
  });
  assert.deepEqual(result, { cursor: drawing ? 'none' : 'default', brush: drawing, ink: drawing },
    'the brush and ink appear only after clicking the start, and the system cursor returns afterward');
}
async function ready(page) {
  await page.locator('#launch').click();
  await page.waitForFunction(() => ['READY','PAUSED'].includes(globalThis.__PAGEPATH__?.instance?.state));
  assert.equal(await state(page), 'READY', await page.locator('#__pagepath_overlay__').evaluate(el => el.shadowRoot.querySelector('.message').textContent));
  assert.equal(await page.evaluate(() => __PAGEPATH__.instance.overlay.observedFlashes), 1,
    'the first completed map flashes its complete obstacle boundary once');
  await verifyCursor(page, false);
}
async function solve(page, shownAnswer = false) {
  const toolbarBefore = await page.locator('[data-pagepath-root] .toolbar').boundingBox();
  const route = await page.evaluate(shown => {
    const game = globalThis.__PAGEPATH__.instance;
    // Following the displayed SVG verifies the hint itself, not just hidden data.
    return shown ? Array.from(game.overlay.hintLayer.querySelector('.hint-path').points, p => ({ x: p.x, y: p.y }))
      : game.level.referencePath;
  }, shownAnswer);
  await page.mouse.move(route[0].x, route[0].y);
  await page.mouse.click(route[0].x, route[0].y);
  assert.equal(await state(page), 'DRAWING', 'releasing the start click must continue drawing');
  await verifyCursor(page, true);
  await verifyToolbarFold(page, true);
  await page.waitForFunction(() => [...document.querySelector('[data-pagepath-root]').shadowRoot.querySelectorAll('.mode-button')].every(button => button.disabled));
  assert.equal(await page.locator('[data-pagepath-root] .hint').isDisabled(), true);
  await page.evaluate(() => {
    window.nextDrawingMoveButtons = null;
    __PAGEPATH__.instance.overlay.surface.addEventListener('pointermove', event => {
      window.nextDrawingMoveButtons = event.buttons;
    }, { once: true });
  });
  for (const point of route.slice(1)) {
    await page.mouse.move(point.x, point.y, { steps: 2 });
    if (await state(page) === 'SUCCESS') break;
  }
  assert.equal(await state(page), 'SUCCESS');
  assert.equal(await page.evaluate(() => window.nextDrawingMoveButtons), 0,
    'the actual route is drawn with no mouse buttons held');
  await verifyToolbarFold(page, false);
  await verifyCursor(page, false);
  assert.deepEqual(await page.locator('[data-pagepath-root] .toolbar').boundingBox(), toolbarBefore,
    'finishing restores the toolbar in its original position');
}

async function verifyTrail(page, mode) {
  const result = await page.evaluate(() => {
    const game = globalThis.__PAGEPATH__.instance;
    return { mode: game.mode, levelMode: game.level.mode, length: game.length,
      drawn: game.overlay.path.getTotalLength(), cap: game.level.trailLength,
      inkMultiplier: game.level.inkMultiplier, nodes: game.level.nodes.length,
      maxInk: game.level.maxInk, referenceLength: game.level.referenceLength,
      modeTitle: game.overlay.modeButtons.find(button => button.dataset.mode === game.mode).title, controlTitle: game.overlay.modeControl.title,
      consumed: game.level.maxInk - game.length };
  });
  assert.equal(result.mode, mode);
  assert.equal(result.levelMode, mode);
  const sparePercent = mode === 'hell' ? 6 + Math.max(0, result.nodes - 8) * 0.5 : mode === 'normal' ? 15 : 4;
  const expectedMultiplier = 1 + sparePercent / 100;
  assert.ok(Math.abs(result.inkMultiplier - expectedMultiplier) < 1e-12,
    'Hell budgets depend on this map\'s actual node count; the other modes keep their fixed allowance');
  assert.ok(Math.abs(result.maxInk / result.referenceLength - expectedMultiplier) < 1e-12);
  assert.equal(result.modeTitle, { normal: '萌新', hell: '糕手', immortal: '神仙' }[mode]);
  assert.equal(result.controlTitle, result.modeTitle, 'difficulty tooltips contain only the name');
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
    await require('./screenshot-harness.cjs')(page);
    // The demo loads its scripts only after Launch. Observe actual production
    // flash calls at script load, before the first asynchronous capture begins.
    await page.route('**/src/content/overlay.js', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: await response.text() + `
        (() => {
          const prototype = __PAGEPATH__.Overlay.prototype, flash = prototype.flashObstacles;
          prototype.flashObstacles = function (...args) {
            this.observedFlashes = (this.observedFlashes || 0) + 1;
            return flash.apply(this, args);
          };
        })();` });
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const results = [];
    for (const type of ['simple','article','github','dashboard','shop','spa']) {
      await page.goto(`http://127.0.0.1:4173/?type=${type}`);
      await page.evaluate(() => document.fonts.ready);
      const before = await page.locator('#content').boundingBox();
      await ready(page);
      assert.equal(await page.locator('[data-pagepath-root] select').count(), 0, 'difficulty has no native dropdown');
      assert.equal(await page.locator('[data-pagepath-root] .mode-button').count(), 4);
      assert.equal(await page.locator('[data-pagepath-root] .mode-button[aria-pressed="true"]').getAttribute('data-mode'), 'normal');
      const metrics = await page.evaluate(() => {
        const { level, analysis } = globalThis.__PAGEPATH__.instance;
        const C = globalThis.__PAGEPATH__.Collision;
        return { nodes: level.nodes.length, analysisMs: analysis.stats.analysisMs, obstacleCount: analysis.stats.obstaclePixels,
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
      await page.locator('[data-pagepath-root] .mode-button[data-mode="hell"]').click();
      await waitState(page, 'READY');
      const readyBudget = await page.evaluate(() => {
        const game = globalThis.__PAGEPATH__.instance;
        return { nodes: game.level.nodes.length, title: game.overlay.modeButtons.find(button => button.dataset.mode === game.mode).title };
      });
      assert.equal(readyBudget.title, '糕手');
      const hint = page.locator('[data-pagepath-root] .hint');
      assert.equal(await hint.getAttribute('aria-pressed'), 'false');
      const reservedBeforeHint = await page.evaluate(() => globalThis.__PAGEPATH__.instance.overlay.getReservedRects());
      await hint.click();
      assert.equal(await hint.getAttribute('aria-pressed'), 'true');
      const answer = await page.evaluate(() => {
        const game = globalThis.__PAGEPATH__.instance;
        const overlay = game.overlay, segments = overlay.visibleContours.segments;
        const start = game.level.nodes[0];
        const startComponent = game.analysis.componentLabels[Math.floor(start.y) * game.analysis.width + Math.floor(start.x)];
        const encoded = (overlay.obstacleShape.getAttribute('d').match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi) || []).map(Number);
        return { actual: game.overlay.hintLayer.querySelector('.hint-path').getTotalLength(),
          expected: game.level.referenceLength, ink: game.length, collected: game.collected.size,
          pointerEvents: getComputedStyle(game.overlay.hintLayer).pointerEvents,
          obstaclesVisible: getComputedStyle(overlay.allObstacles).visibility,
          obstaclePointerEvents: getComputedStyle(overlay.allObstacles).pointerEvents,
          selectedComponent: overlay.visibleContours.componentId === startComponent,
          completeContours: encoded.length === segments.length && encoded.every((coordinate, i) => coordinate === segments[i]) };
      });
      assert.ok(Math.abs(answer.actual - answer.expected) < 2, 'hint displays the complete budgeted reference route');
      assert.equal(answer.ink, 0);
      assert.equal(answer.collected, 0);
      assert.equal(answer.pointerEvents, 'none');
      assert.equal(answer.obstaclesVisible, 'hidden', 'showing the answer must reveal only the reference route');
      assert.equal(answer.obstaclePointerEvents, 'none', 'global obstacles never intercept drawing or controls');
      assert.equal(answer.selectedComponent, true, 'visible contours follow this puzzle start, not an unrelated region');
      assert.equal(answer.completeContours, true, 'route hints preserve the cached exact reachable contours without displaying them');
      assert.deepEqual(await page.evaluate(() => globalThis.__PAGEPATH__.instance.overlay.getReservedRects()), reservedBeforeHint);
      if (type === 'simple') await page.screenshot({ path: path.join(root, 'test-results/pagepath-hint.png') });
      await hint.click();
      assert.equal(await hint.getAttribute('aria-pressed'), 'false');
      assert.equal(await page.evaluate(() => getComputedStyle(__PAGEPATH__.instance.overlay.allObstacles).visibility), 'hidden',
        'opening or closing the hint keeps global obstacle outlines hidden');
      await hint.click();
      await solve(page, true);
      const hell = await verifyTrail(page, 'hell');
      assert.ok(hell.nodes >= 16 && hell.nodes <= 18, 'roomy fixtures use the tougher 16–18-target layout');
      assert.deepEqual(await page.locator('#content').boundingBox(), before);
      if (type === 'simple') {
        await page.screenshot({ path: path.join(root,'test-results/pagepath-hell.png') });
        const beforeRetryFlashes = await page.evaluate(() => __PAGEPATH__.instance.overlay.observedFlashes);
        await page.locator('[data-pagepath-root] .retry').click();
        await waitState(page, 'READY');
        assert.equal(await page.evaluate(() => __PAGEPATH__.instance.overlay.observedFlashes), beforeRetryFlashes,
          'retrying the same map must not replay the new-map obstacle flash');
        assert.equal(await hint.getAttribute('aria-pressed'), 'true', 'same-map retry keeps the answer available');
        assert.equal(await page.locator('[data-pagepath-root] .mode-button[aria-pressed="true"]').getAttribute('data-mode'), 'hell');
        const previousPositions = await page.evaluate(() => globalThis.__PAGEPATH__.instance.level.nodes.map(({ x, y }) => ({ x, y })));
        await page.locator('[data-pagepath-root] .new-puzzle').click();
        await waitState(page, 'READY');
        assert.equal(await page.evaluate(() => __PAGEPATH__.instance.overlay.observedFlashes), beforeRetryFlashes + 1,
          'generating another layout from the cached screenshot flashes all obstacles once again');
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
        await page.locator('[data-pagepath-root] .mode-button[data-mode="normal"]').focus();
        await page.keyboard.press('Space');
        await waitState(page, 'READY');
        assert.equal(await page.evaluate(() => globalThis.__PAGEPATH__.instance.level.inkMultiplier), 1.15);
      }
      await page.locator('[data-pagepath-root] .mode-button[data-mode="immortal"]').click();
      await waitState(page, 'READY');
      assert.equal(await page.locator('[data-pagepath-root] .mode-button[data-mode="immortal"]').getAttribute('title'), '神仙');
      await hint.click();
      await solve(page, true);
      const immortal = await verifyTrail(page, 'immortal');
      assert.ok(immortal.nodes >= 18 && immortal.nodes <= 20);
      assert.match(await page.locator('[data-pagepath-root] .message').textContent(), /神仙.*得分/);
      if (type === 'simple') {
        await page.screenshot({ path: path.join(root, 'test-results/pagepath-immortal.png') });
        const previousFlashes = await page.evaluate(() => __PAGEPATH__.instance.overlay.observedFlashes);
        await page.locator('[data-pagepath-root] .retry').click();
        await waitState(page, 'READY');
        assert.equal(await page.evaluate(() => __PAGEPATH__.instance.overlay.observedFlashes), previousFlashes);
        assert.equal(await hint.getAttribute('aria-pressed'), 'true');
        await page.locator('[data-pagepath-root] .new-puzzle').click();
        await waitState(page, 'READY');
        assert.equal(await page.evaluate(() => __PAGEPATH__.instance.overlay.observedFlashes), previousFlashes + 1);
        assert.equal(await page.locator('[data-pagepath-root] .mode-button[aria-pressed="true"]').getAttribute('data-mode'), 'immortal');
        assert.equal(await hint.getAttribute('aria-pressed'), 'false');
        assert.equal(await page.evaluate(() => globalThis.__PAGEPATH__.instance.level.inkMultiplier), 1.04);
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
    await page.mouse.click(start.x,start.y);
    assert.equal(await state(page), 'DRAWING');
    await verifyToolbarFold(page, true);
    await verifyCursor(page, true);
    assert.equal(await page.evaluate(() => JSON.stringify(globalThis.__PAGEPATH__.instance.level.nodes)), original);
    const obstacle = await page.evaluate(() => {
      const map = globalThis.__PAGEPATH__.instance.analysis;
      const index = map.obstacleMask.findIndex((value, i) => value && i > map.width * 150);
      return { x: index % map.width + 0.5, y: Math.floor(index / map.width) + 0.5 };
    });
    await page.mouse.move(obstacle.x, obstacle.y);
    assert.equal(await state(page), 'FAILED');
    await verifyToolbarFold(page, false);
    await verifyCursor(page, false);
    await waitState(page,'READY');
    await verifyCursor(page, false);
    await page.evaluate(() => { globalThis.__PAGEPATH__.instance.level.maxInk = 0.1; });
    await page.mouse.click(start.x,start.y);
    await page.mouse.move(start.x + 2, start.y + 2);
    assert.equal(await state(page),'FAILED');
    await verifyCursor(page, false);
    await page.keyboard.press('Escape');

    // Right-click exits both an idle map and drawing without held buttons.
    await page.evaluate(() => {
      window.pageContextMenus = 0;
      document.addEventListener('contextmenu', () => window.pageContextMenus++);
    });
    for (const drawing of [false, true]) {
      await ready(page);
      if (drawing) {
        const start = await page.evaluate(() => globalThis.__PAGEPATH__.instance.level.nodes[0]);
        await page.mouse.click(start.x, start.y);
        await waitState(page, 'DRAWING');
      } else await page.mouse.move(1100, 820);
      await page.mouse.down({ button: 'right' });
      await page.mouse.up({ button: 'right' });
      await page.waitForFunction(() => !document.querySelector('[data-pagepath-root]'));
      assert.equal(await page.evaluate(() => window.pageContextMenus), 0, 'right-click does not open the website context menu');
    }

    for (let repeat = 0; repeat < 5; repeat++) {
      await ready(page);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('[data-pagepath-root]').count(), 0);
    }
    await ready(page);
    await page.evaluate(() => { window.frozenMap = __PAGEPATH__.instance.analysis; });
    await page.evaluate(() => window.scrollTo(0,180));
    await page.waitForTimeout(400);
    assert.equal(await state(page), 'READY', 'background scrolling leaves the captured map unchanged');
    assert.equal(await page.evaluate(() => frozenMap === __PAGEPATH__.instance.analysis), true);
    await page.setViewportSize({ width: 1100, height: 800 });
    await waitState(page,'PAUSED');
    await page.keyboard.press('Escape');

    await page.goto('http://127.0.0.1:4173/?type=spa');
    await ready(page);
    await page.waitForTimeout(1200);
    assert.equal(await state(page), 'READY', 'equal-width clock tick must not pause');
    await page.evaluate(() => document.getElementById('mutate').click());
    await page.waitForTimeout(400);
    assert.equal(await state(page), 'READY', 'DOM changes cannot invalidate screenshot geometry');
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ browser: executablePath || 'Playwright Chromium', results, additionalChecks: ['click start and draw with no held buttons','cursor restores after failure and success','segment collision','ink exhaustion','right-click exits idle and drawing maps','repeated cleanup','scroll/regenerate','resize','SPA clock and structural change'], errors }, null, 2));
  } finally { await browser?.close(); server.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
