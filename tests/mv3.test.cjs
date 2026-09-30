// Real unpacked MV3 smoke test. Uses the original manifest and genuine extension
// actions via Chromium's browser-level CDP Extensions.triggerAction command.
// No host permission is added, and the service-worker handler is not mocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.resolve(path.dirname(process.execPath), '../node_modules/playwright')); }

const candidate = process.env.PAGEPATH_BROWSER || (process.platform === 'win32'
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined);
const executablePath = candidate && fs.existsSync(candidate) ? candidate : undefined;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(read, predicate, label) {
  const deadline = Date.now() + 15000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail(`Timed out: ${label}; last value ${JSON.stringify(value)}`);
}
function assertLockedMazeDetails(info) {
  assert.equal(info.disabled, true);
  assert.equal(info.availability.available, false);
  assert.equal(info.availability.obstacleRatio, info.sourceObstacleRatio, 'hover statistics come from the original screenshot');
  assert.equal(info.availability.occupiedRegions, info.sourceOccupiedRegions, 'dispersion comes from original foreground pixels');
  assert.equal(info.title, ''); assert.equal(info.hoverTitle, '', 'the locked entry has no native long title');
  assert.equal(info.tooltipVisible, true);
  assert.equal(info.tooltipText.replace(/\s/g, ''), '寻找复杂的页面来解锁第二关。复杂度分散度', 'the tooltip contains the unlock instruction and two criteria');
  assert.doesNotMatch(info.tooltipText, /[0-9%≥≤]|目标|原因/);
  assert.deepEqual(info.criteria.map(item => item.kind), ['complexity', 'distribution']);
  const expected = [info.sourceObstacleRatio >= .2, info.sourceOccupiedRegions >= 30];
  info.criteria.forEach((item, index) => {
    assert.equal(item.passed, String(expected[index]));
    assert.equal(item.color, expected[index] ? 'rgb(57, 115, 63)' : 'rgb(179, 69, 63)', 'checks are green and crosses are red');
    assert.equal(item.mark, expected[index] ? 'M3 8L6.5 11.5L13 4.5' : 'M4 4L12 12M12 4L4 12', 'the mark shows the corresponding check or cross');
  });
  assert.ok(info.opacities.every(value => value === '1'), 'the locked padlock retains normal opacity');
  assert.notEqual(info.lockedDisplay, 'none');
  assert.equal(info.unlockedDisplay, 'none');
}

(async () => {
  // The repository fixture has insufficient foreground and stays unavailable;
  // the dense natural-obstacle fixture tests only short links between content.
  // Both run under strict CSP with no page scripts.
  const openPageContent = `<div class="eyebrow">PAGEPATH / REPOSITORY</div><h1>pagepath</h1>
    <div class="tags"><button>Code</button><button>Issues 12</button><button>Pull requests 3</button><input aria-label="Search" placeholder="Search files"></div>
    <div class="columns"><pre class="code">function createPuzzle(viewport) {
  const obstacles = analyze(viewport);
  const grid = buildGrid(obstacles);
  const route = findSafeRoute(grid);
  return sampleNodes(route);
}

// The webpage is the level.
export { createPuzzle };</pre><aside class="panel"><h2>About</h2><p>Turn any webpage into a puzzle.</p><button>Star project</button></aside></div>`;
  const openPageHTML = fs.readFileSync(path.join(root, 'tests/fixtures/index.html'), 'utf8')
    .replace('<link rel="stylesheet" href="/tests/fixtures/fixture.css">',
      `<style>${fs.readFileSync(path.join(root, 'tests/fixtures/fixture.css'), 'utf8')}</style>`)
    .replace('<main id="content"></main>', `<main id="content">${openPageContent}</main>`)
    .replace('<script src="/tests/fixtures/fixture.js"></script>', '<div class="scroll-space"></div>');
  const mazeHTML = fs.readFileSync(path.join(root, 'tests/fixtures/natural-maze.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const noRouteHTML = mazeHTML.replace('</style>', `main{inset:0!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;
    grid-template-rows:minmax(0,1fr)!important;gap:64px!important}
    article{grid-column:auto!important;margin:0!important}article:nth-child(n+4){display:none!important}</style>`);
  const distributedHTML = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;height:100%;background:#fff}main{display:grid;width:100%;height:100%;
      grid-template-columns:repeat(8,1fr);grid-template-rows:repeat(6,1fr);place-items:center}
    article{width:80px;height:50px;background:repeating-linear-gradient(135deg,#29372f 0 2px,#344539 2px 4px)}
    </style></head><body><main>${'<article></article>'.repeat(48)}</main></body></html>`;
  const server = http.createServer((request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; script-src 'none'; img-src 'none'; style-src 'unsafe-inline'",
    });
    if (request.url === '/maze') { response.end(mazeHTML); return; }
    if (request.url === '/maze-no-route') { response.end(noRouteHTML); return; }
    if (request.url === '/maze-open') { response.end(openPageHTML); return; }
    if (request.url === '/maze-distributed') { response.end(distributedHTML); return; }
    response.end(`<!doctype html><html lang="en"><head><title>PagePath MV3 test</title>
      <style>body{margin:0;background:#fafbf7;color:#233b30;font:18px Georgia}
      main{position:absolute;left:30%;top:35%;width:40%}h1{font-size:32px}
      p{font-size:16px;line-height:1.7}
      #compact{position:absolute;left:900px;top:240px;width:100px;height:48px;
      border:2px solid #233b30;border-radius:8px;background:white}</style></head><body><main>
      <h1>The webpage is the level.</h1><p>This is an ordinary webpage with a strict
      content security policy. PagePath runs in the extension's isolated world.</p>
      </main><button id="compact" aria-label="Compact outlined button"></button></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pagepath-mv3-'));
  let context;
  try {
    context = await playwright.chromium.launchPersistentContext(profile, {
      executablePath, headless: true, viewport: { width: 1280, height: 900 },
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`,
        '--enable-unsafe-extension-debugging'],
    });
    const errors = [];
    context.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
    const id = new URL(worker.url()).hostname;
    assert.match(worker.url(), /\/src\/background\.js$/);
    const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.permissions, ['activeTab', 'scripting']);
    assert.equal(manifest.host_permissions, undefined);
    await until(() => worker.evaluate(() => chrome.action.onClicked.hasListeners()), Boolean, 'action registration');
    const browserCDP = await context.browser().newBrowserCDPSession();
    async function action(page) {
      await page.bringToFront();
      // Default getTargets filtering omits the tab targets required by this API.
      const { targetInfos } = await browserCDP.send('Target.getTargets', { filter: [{}] });
      const tab = targetInfos.find(target => target.type === 'tab' && target.url === page.url());
      assert.ok(tab, `Tab target exists for ${page.url()}`);
      await browserCDP.send('Extensions.triggerAction', { id, targetId: tab.targetId });
    }
    const activeTabId = () => worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id);
    const badge = tabId => worker.evaluate(tabId => chrome.action.getBadgeText({ tabId }), tabId);
    const ready = page => page.waitForFunction(() =>
      document.querySelector('[data-pagepath-root]')?.shadowRoot.querySelector('.toolbar').dataset.state === 'READY');
    const gone = page => page.waitForFunction(() => !document.querySelector('[data-pagepath-root]'));
    async function verifyOrdinaryHint(targetPage) {
      assert.equal(await targetPage.locator('[data-pagepath-root] .hint').isVisible(), true);
      assert.equal(await targetPage.locator('[data-pagepath-root] .hint').getAttribute('aria-pressed'), 'true');
      assert.ok(await targetPage.locator('[data-pagepath-root] .hint-path').count() > 0);
      assert.equal(await targetPage.locator('[data-pagepath-root] .obstacle-map').evaluate(el => getComputedStyle(el).visibility), 'hidden',
        'ordinary hints display the answer route without showing global obstacle outlines');
    }
    async function verifyNoMazeHint(targetPage, targetTabId) {
      const [read] = await worker.evaluate(tabId => chrome.scripting.executeScript({
        target: { tabId }, world: 'ISOLATED', func: () => {
          const game = __PAGEPATH__.instance, overlay = game.overlay;
          game.toggleHint();
          overlay.renderHint(true);
          return { mode: game.mode, hidden: overlay.hintButton.hidden, disabled: overlay.hintButton.disabled,
            display: getComputedStyle(overlay.hintButton).display, pressed: overlay.hintButton.getAttribute('aria-pressed'),
            hintVisible: game.hintVisible, children: overlay.hintLayer.childElementCount,
            obstacles: getComputedStyle(overlay.allObstacles).visibility,
            route: game.level.referencePath.map(({ x, y }) => ({ x, y })) };
        }
      }), targetTabId);
      const { route, ...status } = read.result;
      assert.deepEqual(status, { mode: 'maze', hidden: true, disabled: true, display: 'none', pressed: 'false',
        hintVisible: false, children: 0, obstacles: 'hidden' },
      'the real second level cannot expose a hint through game or render calls');
      assert.equal(await targetPage.locator('[data-pagepath-root] .hint').isVisible(), false);
      return route; // Internal test witness; the extension exposes no displayed maze answer.
    }
    async function verifyLockedMaze(targetPage, targetTabId) {
      await targetPage.locator('[data-pagepath-root] .maze-mode-slot').hover();
      assert.equal(await targetPage.locator('[data-pagepath-root] .maze-tooltip').isVisible(), true,
        'hovering the locked icon opens the custom tooltip');
      const [read] = await worker.evaluate(tabId => chrome.scripting.executeScript({
        target: { tabId }, world: 'ISOLATED', func: () => {
          const game = __PAGEPATH__.instance, overlay = game.overlay;
          const button = overlay.modeButtons.find(item => item.dataset.mode === 'maze');
          const icon = button.querySelector('.control-icon'), lock = button.querySelector('.maze-locked-mark');
          const source = game.sourceAnalysis;
          const bins = new Uint32Array(48);
          for (let index = 0; index < source.obstacleMask.length; index++) if (source.obstacleMask[index]) {
            const x = index % source.width, y = Math.floor(index / source.width);
            bins[Math.floor(y * 6 / source.height) * 8 + Math.floor(x * 8 / source.width)]++;
          }
          const tooltip = overlay.mazeTooltip;
          return { availability: game.mazeAvailability, disabled: button.disabled, title: button.title,
            hoverTitle: overlay.mazeModeSlot.title, mode: game.mode, state: game.state,
            sourceObstacleRatio: source.obstacleMask.reduce((sum, value) => sum + Number(Boolean(value)), 0) / source.obstacleMask.length,
            sourceOccupiedRegions: bins.filter(count => count >= source.width * source.height / 48 * .1).length,
            tooltipVisible: !tooltip.hidden && getComputedStyle(tooltip).display !== 'none', tooltipText: tooltip.textContent,
            criteria: [...tooltip.querySelectorAll('.maze-criterion')].map(row => ({ kind: row.dataset.criterion,
              passed: row.dataset.passed, color: getComputedStyle(row.querySelector('.criterion-mark')).color,
              mark: row.querySelector('.criterion-mark path')?.getAttribute('d') })),
            opacities: [overlay.mazeModeSlot, button, icon, lock].map(element => getComputedStyle(element).opacity),
            lockedDisplay: getComputedStyle(lock).display,
            unlockedDisplay: getComputedStyle(button.querySelector('.maze-unlocked-mark')).display };
        }
      }), targetTabId);
      assertLockedMazeDetails(read.result);
      const bounds = await targetPage.locator('[data-pagepath-root] .mode-button[data-mode="maze"]').boundingBox();
      await targetPage.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      const [afterClick] = await worker.evaluate(tabId => chrome.scripting.executeScript({
        target: { tabId }, world: 'ISOLATED', func: () => ({ mode: __PAGEPATH__.instance.mode, state: __PAGEPATH__.instance.state })
      }), targetTabId);
      assert.deepEqual(afterClick.result, { mode: read.result.mode, state: read.result.state }, 'the clear padlock stays disabled');
      const [afterProgrammatic] = await worker.evaluate(tabId => chrome.scripting.executeScript({
        target: { tabId }, world: 'ISOLATED', func: () => {
          const game = __PAGEPATH__.instance; game.setMode('maze');
          return { mode: game.mode, state: game.state };
        }
      }), targetTabId);
      assert.deepEqual(afterProgrammatic.result, afterClick.result, 'programmatic changes cannot bypass locked availability');
      return read.result;
    }
    async function verifyUnlockedMaze(targetPage) {
      const entry = targetPage.locator('[data-pagepath-root] .mode-button[data-mode="maze"]');
      const slot = targetPage.locator('[data-pagepath-root] .maze-mode-slot');
      assert.equal(await entry.isDisabled(), false);
      assert.equal(await entry.getAttribute('title'), '第二关');
      assert.equal(await slot.getAttribute('title'), '第二关');
      assert.equal(await entry.locator('.maze-locked-mark').isVisible(), false);
      assert.equal(await entry.locator('.maze-unlocked-mark').isVisible(), true);
      await slot.hover();
      assert.equal(await targetPage.locator('[data-pagepath-root] .maze-tooltip').isVisible(), false,
        'the unlocked star only offers its short native name');
    }
    async function verifyTransparentMaze(targetTabId) {
      const [read] = await worker.evaluate(tabId => chrome.scripting.executeScript({
        target: { tabId }, world: 'ISOLATED', func: () => {
          const game = __PAGEPATH__.instance, overlay = game.overlay, source = game.sourceAnalysis;
          const segments = overlay.sourceContours?.segments || [], paths = [];
          for (let i = 0; i < segments.length; i += 4) paths.push(`M${segments[i]},${segments[i + 1]}L${segments[i + 2]},${segments[i + 3]}`);
          let newEdges = 0, invalidEdges = 0;
          const free = (map, x, y) => x >= 0 && y >= 0 && x < map.width && y < map.height && Boolean(map.walkableMask[y * map.width + x]);
          for (let i = 0; i < segments.length; i += 4) {
            const [x1, y1, x2, y2] = segments.slice(i, i + 4), horizontal = y1 === y2;
            const low = horizontal ? Math.min(x1, x2) : Math.min(y1, y2), high = horizontal ? Math.max(x1, x2) : Math.max(y1, y2);
            for (let at = low; at < high; at++) {
              const a = horizontal ? [at, y1 - 1] : [x1 - 1, at], b = horizontal ? [at, y1] : [x1, at];
              const first = free(game.analysis, ...a), second = free(game.analysis, ...b);
              if (first === second) invalidEdges++;
              else if (free(source, ...(first ? b : a))) newEdges++;
            }
          }
          return { source: game.level.mazeSourceAnalysis === source, permanent: overlay.mazeWallLayer.childElementCount,
            globalShape: overlay.obstacleShape.getAttribute('d') === paths.join(''), newEdges, invalidEdges,
            localEdges: overlay.mazeContours?.segments?.length || 0,
            flashHref: overlay.obstacleFlash.getAttribute('href'), hintHref: overlay.allObstacles.getAttribute('href') };
        }
      }), targetTabId);
      assert.equal(read.result.source && read.result.globalShape, true);
      assert.equal(read.result.permanent, 0, 'added maze walls have no global visible geometry');
      assert.equal(read.result.newEdges, 0, 'the new-map flash omits added-wall boundaries');
      assert.equal(read.result.invalidEdges, 0, 'shown outlines remain exact collision edges');
      assert.ok(read.result.localEdges > 0, 'added-wall edges are cached for proximity warnings');
      assert.equal(read.result.flashHref, '#pagepath-obstacles'); assert.equal(read.result.hintHref, read.result.flashHref);
    }
    const page = await context.newPage();
    await page.goto(origin);
    const tabId = await activeTabId();
    const deniedBeforeGesture = await worker.evaluate(async tabId => {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, func: () => true });
        return false;
      } catch { return true; }
    }, tabId);
    assert.equal(deniedBeforeGesture, true, 'activeTab must require a user action');

    await worker.evaluate(() => {
      const original = __PAGEPATH__.ImageMapAnalyzer;
      globalThis.pixelAnalysisRuns = 0;
      __PAGEPATH__.ImageMapAnalyzer = { async analyze(...args) {
        pixelAnalysisRuns++; return original.analyze(...args);
      } };
    });

    await action(page);
    await ready(page);
    await until(() => badge(tabId), text => text === 'ON', 'ON badge');
    assert.equal(await page.evaluate(() => typeof globalThis.__PAGEPATH__), 'undefined', 'game state is isolated from page JS');
    const [injection] = await worker.evaluate(tabId => chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED', func: () => ({
        state: globalThis.__PAGEPATH__.instance.state,
        nodes: globalThis.__PAGEPATH__.instance.level.nodes.length,
        snapshotMode: globalThis.__PAGEPATH__.instance.snapshot?.mode,
        mapKind: globalThis.__PAGEPATH__.instance.analysis?.kind,
        commonMask: globalThis.__PAGEPATH__.instance.collisionIndex.walkableMask === globalThis.__PAGEPATH__.instance.analysis.walkableMask &&
          globalThis.__PAGEPATH__.instance.level.grid.walkableMask === globalThis.__PAGEPATH__.instance.analysis.walkableMask,
        contentOpenCV: Boolean(globalThis.__PAGEPATH_OPENCV__),
        domAnalyzer: Boolean(globalThis.__PAGEPATH__.PageAnalyzer),
        hybridMerges: globalThis.__PAGEPATH__.instance.analysis.stats.compactDomMerged,
        compactInterior: globalThis.__PAGEPATH__.instance.analysis.obstacleMask[264 * innerWidth + 950],
      }),
    }), tabId);
    assert.equal(injection.result.state, 'READY');
    assert.ok(injection.result.nodes >= 4);
    assert.equal(injection.result.snapshotMode, 'screenshot');
    assert.equal(injection.result.mapKind, 'pixel-mask');
    assert.equal(injection.result.commonMask, true);
    assert.equal(injection.result.contentOpenCV, false, 'WASM stays in the extension worker');
    assert.equal(injection.result.domAnalyzer, false);
    assert.ok(injection.result.hybridMerges > 0, 'the real extension supplies screenshot-validated compact geometry');
    assert.equal(injection.result.compactInterior, 1, 'small outlined control becomes a single obstacle before distance transform');
    await worker.evaluate(tabId => chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: () => {
      const original = __PAGEPATH__.CompactDOM;
      globalThis.compactDOMReadsAfterCapture = 0;
      __PAGEPATH__.CompactDOM = { collect(...args) { compactDOMReadsAfterCapture++; return original.collect(...args); } };
    } }), tabId);
    // Play the actual generated route with real pointer input on the frozen page.
    // This checks that a harder multi-region puzzle still fits its tighter ink budget.
    const [witness] = await worker.evaluate(tabId => chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED',
      func: () => globalThis.__PAGEPATH__.instance.level.referencePath
    }), tabId);
    await page.locator('[data-pagepath-root] .hint').click();
    await verifyOrdinaryHint(page);
    const route = await page.locator('[data-pagepath-root] .hint-path').evaluate(el =>
      Array.from(el.points, point => ({ x: point.x, y: point.y })));
    assert.deepEqual(route, witness.result, 'normal mode displays its complete generated route');
    await page.mouse.move(route[0].x, route[0].y);
    assert.equal(await page.locator('[data-pagepath-root] .surface').evaluate(el => getComputedStyle(el).cursor), 'default');
    await page.mouse.click(route[0].x, route[0].y);
    assert.equal(await page.locator('[data-pagepath-root] .toolbar').getAttribute('data-state'), 'DRAWING', 'the starting click remains active after release');
    assert.equal(await page.locator('[data-pagepath-root] .brush-cursor').getAttribute('data-visible'), 'true');
    for (const point of route.slice(1)) await page.mouse.move(point.x, point.y, { steps: 2 });
    assert.equal(await page.locator('[data-pagepath-root] .surface').evaluate(el => getComputedStyle(el).cursor), 'default');
    assert.equal(await page.locator('[data-pagepath-root] .brush-cursor').getAttribute('data-visible'), 'false');
    const [completed] = await worker.evaluate(tabId => chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED', func: () => {
        const game = globalThis.__PAGEPATH__.instance;
        return { state: game.state, collected: game.collected.size,
          total: game.level.nodes.length, remaining: game.level.maxInk - game.length };
      }
    }), tabId);
    assert.equal(completed.result.state, 'SUCCESS');
    assert.equal(completed.result.collected, completed.result.total);
    assert.ok(completed.result.remaining > 0);
    await page.locator('[data-pagepath-root]').locator('.retry').click();
    await ready(page);
    const readSnapshot = () => worker.evaluate(async tabId => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId }, world: 'ISOLATED', func: () => {
          const image = globalThis.__PAGEPATH__.instance?.overlay.snapshotImage;
          if (!image) return null;
          const rect = image.getBoundingClientRect();
          return { src: image.src, complete: image.complete, width: image.naturalWidth,
            connected: image.isConnected, visible: getComputedStyle(image).visibility === 'visible',
            bounds: { width: rect.width, height: rect.height } };
        },
      });
      return result.result;
    }, tabId);
    const snapshot = await until(readSnapshot, image => image?.complete && image.width > 0, 'snapshot image decoding');
    assert.equal(snapshot.connected && snapshot.visible, true, 'decoded screenshot is visible');
    assert.deepEqual(snapshot.bounds, { width: 1280, height: 900 });
    const initialSnapshot = snapshot.src;
    assert.match(initialSnapshot, /^data:image\/png;base64,/, 'capture is an in-memory screenshot');
    const pageCanReadScreenshot = await page.evaluate(() => {
      const root = document.querySelector('[data-pagepath-root]').shadowRoot;
      const layer = root.querySelector('.snapshot-layer');
      return !layer || layer.shadowRoot !== null || root.querySelector('img.page-snapshot') !== null;
    });
    assert.equal(pageCanReadScreenshot, false, 'page scripts cannot read screenshot pixels through the open overlay DOM');
    assert.equal(await page.locator('[data-pagepath-root] select').count(), 0);
    assert.equal(await page.locator('[data-pagepath-root] .mode-button').count(), 4);
    const simpleMaze = page.locator('[data-pagepath-root] .mode-button[data-mode="maze"]');
    assert.equal(await simpleMaze.isDisabled(), true, 'the simple page must not unlock an artificial empty-page maze');
    await verifyLockedMaze(page, tabId);
    await page.locator('[data-pagepath-root] .mode-button[data-mode="hell"]').click();
    await ready(page);
    assert.ok((await readSnapshot()).src === initialSnapshot, 'difficulty switch reuses the frozen webpage');
    const [hellWitness] = await worker.evaluate(tabId => chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED', func: () => {
        const game = globalThis.__PAGEPATH__.instance;
        return { mode: game.mode, nodes: game.level.nodes.length, ink: game.level.inkMultiplier,
          maxInk: game.level.maxInk, referenceLength: game.level.referenceLength,
          title: game.overlay.modeButtons.find(button => button.dataset.mode === game.mode).title, controlTitle: game.overlay.modeControl.title,
          route: game.level.referencePath, positions: game.level.nodes.map(({ x, y }) => ({ x, y })) };
      }
    }), tabId);
    assert.equal(hellWitness.result.mode, 'hell');
    assert.ok(hellWitness.result.nodes >= 16 && hellWitness.result.nodes <= 18);
    const hellSpare = 6 + Math.max(0, hellWitness.result.nodes - 8) * 0.5;
    assert.ok(Math.abs(hellWitness.result.ink - (1 + hellSpare / 100)) < 1e-12);
    assert.ok(Math.abs(hellWitness.result.maxInk / hellWitness.result.referenceLength - (1 + hellSpare / 100)) < 1e-12);
    assert.equal(hellWitness.result.title, '糕手', 'the real extension shows only the difficulty name');
    assert.equal(hellWitness.result.controlTitle, hellWitness.result.title);
    await page.locator('[data-pagepath-root] .hint').click();
    await verifyOrdinaryHint(page);
    assert.equal(await page.locator('[data-pagepath-root] .hint').getAttribute('aria-pressed'), 'true');
    assert.ok((await readSnapshot()).src === initialSnapshot, 'answer overlay keeps the same frozen page');
    const hellRoute = await page.locator('[data-pagepath-root] .hint-path').evaluate(el =>
      Array.from(el.points, p => ({ x: p.x, y: p.y })));
    assert.equal(hellRoute.length, hellWitness.result.route.length, 'the displayed answer includes every route segment');
    await page.mouse.move(hellRoute[0].x, hellRoute[0].y);
    await page.mouse.click(hellRoute[0].x, hellRoute[0].y);
    await page.waitForFunction(() => [...document.querySelector('[data-pagepath-root]').shadowRoot.querySelectorAll('.mode-button')].every(button => button.disabled));
    assert.equal(await page.locator('[data-pagepath-root] .toolbar-main').isVisible(), false,
      'drawing folds the controls out of view');
    assert.equal(await page.locator('[data-pagepath-root] .toolbar').evaluate(el => getComputedStyle(el).pointerEvents), 'none');
    for (const point of hellRoute.slice(1)) await page.mouse.move(point.x, point.y, { steps: 2 });
    const [hellCompleted] = await worker.evaluate(tabId => chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED', func: () => {
        const game = globalThis.__PAGEPATH__.instance;
        return { state: game.state, drawn: game.overlay.path.getTotalLength(), length: game.length,
          inkLeft: game.level.maxInk - game.length };
      }
    }), tabId);
    assert.equal(hellCompleted.result.state, 'SUCCESS');
    assert.equal(await page.locator('[data-pagepath-root] .toolbar-main').isVisible(), true,
      'success automatically expands the controls');
    assert.ok(hellCompleted.result.drawn > 0 && hellCompleted.result.drawn <= 71);
    assert.ok(hellCompleted.result.length > hellCompleted.result.drawn * 3 && hellCompleted.result.inkLeft > 0);
    assert.equal(await page.locator('[data-pagepath-root] .hint').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-pagepath-root] .new-puzzle').click();
    await ready(page);
    assert.equal(await page.locator('[data-pagepath-root] .hint').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('[data-pagepath-root] .mode-button[aria-pressed="true"]').getAttribute('data-mode'), 'hell');
    const [variation] = await worker.evaluate(({ tabId, previous }) => chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED', args: [previous], func: previous => {
        const game = globalThis.__PAGEPATH__.instance;
        return { total: game.level.nodes.length, moved: game.level.nodes.filter(point =>
          previous.every(other => Math.hypot(point.x - other.x, point.y - other.y) >= 48)).length,
          historyCount: game.recentLayouts.length };
      }
    }), { tabId, previous: hellWitness.result.positions });
    assert.ok(variation.result.moved >= variation.result.total / 2, 'same frozen page gets visibly different node positions');
    assert.equal(variation.result.historyCount, 3);
    await page.locator('[data-pagepath-root] .mode-button[data-mode="immortal"]').click();
    await ready(page);
    assert.ok((await readSnapshot()).src === initialSnapshot, 'Immortal also reuses the same frozen page');
    await page.locator('[data-pagepath-root] .hint').click();
    await verifyOrdinaryHint(page);
    const immortalRoute = await page.locator('[data-pagepath-root] .hint-path').evaluate(el =>
      Array.from(el.points, p => ({ x: p.x, y: p.y })));
    await page.mouse.move(immortalRoute[0].x, immortalRoute[0].y);
    await page.mouse.click(immortalRoute[0].x, immortalRoute[0].y);
    for (const point of immortalRoute.slice(1)) await page.mouse.move(point.x, point.y, { steps: 2 });
    const [immortalCompleted] = await worker.evaluate(tabId => chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED', func: () => {
        const game = globalThis.__PAGEPATH__.instance;
        return { state: game.state, mode: game.mode, ink: game.level.inkMultiplier,
          inkLeft: game.level.maxInk - game.length, label: game.overlay.message.textContent };
      }
    }), tabId);
    assert.equal(immortalCompleted.result.state, 'SUCCESS');
    assert.equal(immortalCompleted.result.mode, 'immortal');
    assert.equal(immortalCompleted.result.ink, 1.04);
    assert.ok(immortalCompleted.result.inkLeft > 0);
    assert.match(immortalCompleted.result.label, /神仙.*得分/);
    await page.locator('[data-pagepath-root] .mode-button[data-mode="normal"]').click();
    await ready(page);
    assert.ok((await readSnapshot()).src === initialSnapshot, 'returning to Normal retains the same snapshot');
    await page.waitForFunction(() =>
      document.querySelector('[data-pagepath-root]')?.shadowRoot.querySelector('.obstacle-flash').getAnimations().length === 0);
    const scene = { x: 0, y: 130, width: 1280, height: 770 };
    const frozenBefore = await page.screenshot({ clip: scene });
    await page.evaluate(() => {
      const main = document.querySelector('main');
      main.style.transform = 'translate(170px, 140px)';
      main.innerHTML = '<h1>The live page changed.</h1><p>The frozen game must stay still.</p>';
      document.body.style.background = '#ffcbba';
      // Existing layout monitoring used both mutation observers and a periodic
      // geometry check. Leave enough time for either regression to surface.
    });
    await delay(1200);
    assert.equal(await page.locator('[data-pagepath-root] .toolbar').getAttribute('data-state'), 'READY',
      'changes to the live page must not pause the frozen puzzle');
    const frozenAfter = await page.screenshot({ clip: scene });
    assert.deepEqual(frozenAfter, frozenBefore, 'visible game pixels stay identical while the live DOM changes');
    await page.locator('[data-pagepath-root] .new-puzzle').click();
    await ready(page);
    assert.ok((await readSnapshot()).src === initialSnapshot, 'new maps reuse the same frozen page');
    assert.equal(await worker.evaluate(() => pixelAnalysisRuns), 1,
      'playing all modes, showing hints, retrying and new maps never rerun OpenCV');
    const [domReads] = await worker.evaluate(tabId => chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED', func: () => globalThis.compactDOMReadsAfterCapture
    }), tabId);
    assert.equal(domReads.result, 0, 'playing and generating puzzles use the frozen merged map without rereading DOM');
    fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'test-results/pagepath-mv3.png') });

    await action(page);
    await gone(page);
    await until(() => badge(tabId), text => text === '', 'second action clears badge');
    const restoredLivePage = await page.screenshot({ clip: scene });
    assert.notDeepEqual(restoredLivePage, frozenBefore, 'leaving the game reveals the changed live page');
    assert.equal(await page.locator('main h1').textContent(), 'The live page changed.');
    await action(page);
    await ready(page);
    const beforeResize = await readSnapshot();
    await page.setViewportSize({ width: 1180, height: 850 });
    await page.waitForFunction(() =>
      document.querySelector('[data-pagepath-root]')?.shadowRoot.querySelector('.toolbar').dataset.state === 'PAUSED');
    await page.locator('[data-pagepath-root] .regenerate').click();
    await ready(page);
    const refreshedSnapshot = await readSnapshot();
    assert.equal(refreshedSnapshot.width, 1180, 'regeneration captures the resized viewport');
    assert.deepEqual(refreshedSnapshot.bounds, { width: 1180, height: 850 });
    assert.ok(refreshedSnapshot.src !== beforeResize.src, 'regeneration replaces the old screenshot');
    await page.keyboard.press('Escape');
    await gone(page);
    await until(() => badge(tabId), text => text === '', 'Escape reports PAGEPATH_CLOSED');
    assert.equal(await page.locator('img.page-snapshot').count(), 0, 'Escape removes the screenshot along with its host');
    assert.equal(await readSnapshot(), null, 'Escape releases the isolated snapshot reference');

    await action(page);
    await ready(page);
    await page.mouse.click(900, 700, { button: 'right' });
    await gone(page);
    await until(() => badge(tabId), text => text === '', 'right-click reports PAGEPATH_CLOSED');
    assert.equal(await readSnapshot(), null, 'right-click releases the frozen snapshot');

    await page.setViewportSize({ width: 1280, height: 900 });
    await action(page);
    await ready(page);
    await page.goto(`${origin}/next-page`);
    await gone(page);
    await until(() => badge(tabId), text => text === '', 'navigation clears badge');
    const resetPopup = await worker.evaluate(tabId => chrome.action.getPopup({ tabId }), tabId);
    assert.equal(resetPopup, '');

    // The repository fixture stays below the original foreground requirement.
    // Unrelated content counts cannot unlock an artificial grid or frame.
    const mazePage = await context.newPage();
    await mazePage.goto(`${origin}/maze-open`);
    await mazePage.evaluate(() => document.fonts.ready);
    await action(mazePage);
    await ready(mazePage);
    const openMazeButton = mazePage.locator('[data-pagepath-root] .mode-button[data-mode="maze"]');
    assert.equal(await openMazeButton.isDisabled(), true, 'the repository page has insufficient original foreground for a natural maze');
    await verifyLockedMaze(mazePage, await activeTabId());
    await mazePage.keyboard.press('Escape');
    await gone(mazePage);

    // An actual screenshot with sparse content spread across all 48 regions
    // exercises a green dispersion check next to a red complexity cross.
    await mazePage.goto(`${origin}/maze-distributed`);
    await action(mazePage); await ready(mazePage);
    const mixedCriteria = await verifyLockedMaze(mazePage, await activeTabId());
    assert.ok(mixedCriteria.sourceObstacleRatio < .2 && mixedCriteria.sourceOccupiedRegions >= 30);
    await mazePage.locator('[data-pagepath-root] .maze-mode-slot').hover();
    await mazePage.screenshot({ path: path.join(root, 'test-results/pagepath-mv3-maze-locked-tooltip.png') });
    await mazePage.keyboard.press('Escape'); await gone(mazePage);

    // This qualified screenshot previously failed because its straight gaps
    // had no natural maze. Added transparent walls now supply a safe fallback.
    await mazePage.goto(`${origin}/maze-no-route`);
    const fallbackTabId = await activeTabId();
    const analysesBeforeFallback = await worker.evaluate(() => pixelAnalysisRuns);
    await action(mazePage); await ready(mazePage);
    const fallbackButton = mazePage.locator('[data-pagepath-root] .mode-button[data-mode="maze"]');
    assert.equal(await fallbackButton.isDisabled(), false, 'qualifying density and distribution unlock before route generation');
    await verifyUnlockedMaze(mazePage);
    await worker.evaluate(tabId => chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED', func: () => {
        const game = __PAGEPATH__.instance, source = game.sourceAnalysis;
        globalThis.__mv3GenerationSource = { source, snapshot: game.snapshot,
          obstacle: source.obstacleMask.slice(), walkable: source.walkableMask.slice(),
          distance: source.distanceMap.slice(), contours: source.contours.segments.slice() };
      }
    }), fallbackTabId);
    await fallbackButton.click(); await ready(mazePage);
    for (let attempt = 0; attempt < 2; attempt++) {
      const [constructed] = await worker.evaluate(tabId => chrome.scripting.executeScript({
        target: { tabId }, world: 'ISOLATED', func: () => {
          const game = __PAGEPATH__.instance, prior = __mv3GenerationSource, source = prior.source;
          const level = game.level;
          return { mode: game.mode, state: game.state, generationFailed: game.generationFailed, available: game.mazeAvailability.available,
            density: game.mazeAvailability.obstacleRatio, distribution: game.mazeAvailability.occupiedRegions,
            kind: level.maze.kind, nodes: level.nodes.length, unlimited: level.maxInk === Infinity && level.unlimitedInk,
            spread: Math.hypot(level.nodes[0].x - level.nodes[1].x, level.nodes[0].y - level.nodes[1].y) >=
              Math.max(80, Math.hypot(source.width, source.height) * .18),
            enoughRoute: level.referenceLength >= Math.max(220, Math.hypot(source.width, source.height) * .65) && level.challenge.turns >= 4,
            nodeRoom: level.nodes.every(p => game.analysis.distanceMap[Math.floor(p.y) * source.width + Math.floor(p.x)] >= 12),
            commonMask: level.analysis === game.analysis && game.collisionIndex.walkableMask === game.analysis.walkableMask,
            safe: level.referencePath.every((point, i, route) => !i || !__PAGEPATH__.Collision.segmentHits(route[i - 1], point, game.collisionIndex)),
            originalObstaclesPreserved: source.obstacleMask.every((value, i) => !value || game.analysis.obstacleMask[i]),
            preserved: game.snapshot === prior.snapshot && game.sourceAnalysis === source && game.analysis !== source &&
              source.obstacleMask.every((value, i) => value === prior.obstacle[i]) &&
              source.walkableMask.every((value, i) => value === prior.walkable[i]) &&
              source.distanceMap.every((value, i) => value === prior.distance[i]) &&
              source.contours.segments.every((value, i) => value === prior.contours[i]) };
        }
      }), fallbackTabId);
      assert.equal(constructed.result.mode, 'maze'); assert.equal(constructed.result.state, 'READY');
      assert.equal(constructed.result.kind, 'route-first'); assert.equal(constructed.result.nodes, 2);
      assert.equal(constructed.result.generationFailed, false);
      for (const key of ['available', 'unlimited', 'commonMask', 'safe', 'preserved', 'originalObstaclesPreserved', 'spread', 'enoughRoute', 'nodeRoom']) assert.equal(constructed.result[key], true, key);
      assert.ok(constructed.result.density >= .2 && constructed.result.distribution >= 30);
      assert.equal(await mazePage.locator('[data-pagepath-root] .generation-error').isVisible(), false);
      await verifyUnlockedMaze(mazePage);
      await verifyTransparentMaze(fallbackTabId);
      assert.equal(await worker.evaluate(() => pixelAnalysisRuns), analysesBeforeFallback + 1, 'fallback generation reuses the original capture');
      const route = await verifyNoMazeHint(mazePage, fallbackTabId);
      await verifyTransparentMaze(fallbackTabId);
      if (!attempt) await mazePage.screenshot({ path: path.join(root, 'test-results/pagepath-mv3-maze-constructed.png') });
      await mazePage.mouse.click(route[0].x, route[0].y);
      for (const point of route.slice(1)) await mazePage.mouse.move(point.x, point.y, { steps: 2 });
      assert.equal(await mazePage.locator('[data-pagepath-root] .toolbar').getAttribute('data-state'), 'SUCCESS', 'the fallback answer completes with real pointer events');
      assert.equal(await mazePage.locator('[data-pagepath-root] .cursor-ink').textContent(), '∞');
      await verifyNoMazeHint(mazePage, fallbackTabId);
      if (!attempt) { await mazePage.locator('[data-pagepath-root] .new-puzzle').click(); await ready(mazePage); }
    }
    await mazePage.locator('[data-pagepath-root] .mode-button[data-mode="normal"]').click(); await ready(mazePage);
    const [fallbackRestored] = await worker.evaluate(tabId => chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED', func: () => {
        const game = __PAGEPATH__.instance;
        return game.mode === 'normal' && !game.generationFailed && game.level &&
          game.snapshot === __mv3GenerationSource.snapshot && game.analysis === __mv3GenerationSource.source;
      }
    }), fallbackTabId);
    assert.equal(Boolean(fallbackRestored.result), true, 'normal mode restores the original map after constructed maze play');
    assert.equal(await mazePage.locator('[data-pagepath-root] .generation-error').isVisible(), false);
    await mazePage.keyboard.press('Escape'); await gone(mazePage);

    // A separate dense webpage exercises real activeTab capture, worker CV,
    // short red obstacle connections, actual drawing and return to the source.
    await mazePage.goto(`${origin}/maze`);
    await mazePage.evaluate(() => document.fonts.ready);
    const mazeTabId = await activeTabId();
    const analysesBeforeMaze = await worker.evaluate(() => pixelAnalysisRuns);
    await action(mazePage);
    await ready(mazePage);
    assert.equal(await worker.evaluate(() => pixelAnalysisRuns), analysesBeforeMaze + 1);
    const mazeButton = mazePage.locator('[data-pagepath-root] .mode-button[data-mode="maze"]');
    const [naturalAvailability] = await worker.evaluate(mazeTabId => chrome.scripting.executeScript({
      target: { tabId: mazeTabId }, world: 'ISOLATED', func: () => __PAGEPATH__.instance.mazeAvailability,
    }), mazeTabId);
    assert.equal(await mazeButton.isDisabled(), false,
      `dense natural obstacles can support the second level: ${JSON.stringify(naturalAvailability.result)}`);
    assert.equal(await mazeButton.getAttribute('title'), '第二关');
    await verifyUnlockedMaze(mazePage);
    await worker.evaluate(mazeTabId => chrome.scripting.executeScript({
      target: { tabId: mazeTabId }, world: 'ISOLATED', func: () => {
        const game = __PAGEPATH__.instance, source = game.sourceAnalysis;
        globalThis.__mv3MazeSource = { snapshot: game.snapshot, source,
          obstacle: source.obstacleMask.slice(), walkable: source.walkableMask.slice(),
          distance: source.distanceMap.slice(), contours: source.contours.segments.slice() };
      }
    }), mazeTabId);
    await mazeButton.click();
    await ready(mazePage);
    const [mazeWitness] = await worker.evaluate(mazeTabId => chrome.scripting.executeScript({
      target: { tabId: mazeTabId }, world: 'ISOLATED', func: () => {
        const game = __PAGEPATH__.instance, level = game.level;
        const source = __mv3MazeSource.source, { width, height } = source;
        const expectedMask = new Uint8Array(source.obstacleMask);
        for (const r of level.mazeMergedObstacles) for (let y = r.y; y < r.y + r.height; y++) {
          expectedMask.fill(1, y * width + r.x, y * width + r.x + r.width);
        }
        let originalAnchors = true;
        const baseMask = level.mazeSourceAnalysis.obstacleMask;
        const originalAt = p => p.x < 0 || p.y < 0 || p.x >= width || p.y >= height ||
          Boolean(baseMask[Math.floor(p.y) * width + Math.floor(p.x)]);
        for (const wall of level.mazeWallSegments) {
          originalAnchors &&= wall.anchors.length >= 1 && wall.anchors.every(p => originalAt(p) || p.kind === 'viewport');
          for (let i = 1; i < wall.points.length; i++) {
            const a = wall.points[i - 1], b = wall.points[i], r = wall.width / 2;
            const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
            for (let y = Math.max(0, Math.floor(Math.min(a.y, b.y) - r)); y < Math.min(height, Math.ceil(Math.max(a.y, b.y) + r)); y++) {
              for (let x = Math.max(0, Math.floor(Math.min(a.x, b.x) - r)); x < Math.min(width, Math.ceil(Math.max(a.x, b.x) + r)); x++) {
                const t = d2 ? Math.max(0, Math.min(1, ((x + .5 - a.x) * dx + (y + .5 - a.y) * dy) / d2)) : 0;
                if ((x + .5 - a.x - t * dx) ** 2 + (y + .5 - a.y - t * dy) ** 2 <= r * r + 1e-9) expectedMask[y * width + x] = 1;
              }
            }
          }
        }
        return { state: game.state, mode: game.mode, nodes: level.nodes.length,
          unlimited: level.unlimitedInk && level.maxInk === Infinity,
          inkLabel: game.overlay.cursorInk.textContent, walls: level.mazeWallSegments.length,
          permanentWalls: game.overlay.mazeWallLayer.childElementCount,
          sourceObstacleRatio: __mv3MazeSource.source.obstacleMask.reduce((sum, value) => sum + Number(Boolean(value)), 0) /
            __mv3MazeSource.source.obstacleMask.length,
          connectionThicknesses: level.mazeWallSegments.map(wall => wall.width), originalAnchors,
          noOverlayMaze: !level.mazeCarvedPaths.length && !game.overlay.mazeFloorLayer.childElementCount,
          fixedAnswerSafe: level.plannedReferencePath.every((p, i, route) => !i || !__PAGEPATH__.Collision.segmentHits(route[i - 1], p, level.obstacleIndex)),
          exactObstacleUnion: expectedMask.every((value, i) => value === game.analysis.obstacleMask[i]),
          addedPixelRatio: game.analysis.obstacleMask.reduce((sum, value, i) => sum +
            Number(Boolean(value) && !__mv3MazeSource.source.obstacleMask[i]), 0) / game.analysis.obstacleMask.length,
          ownMap: game.analysis !== __mv3MazeSource.source,
          commonMask: game.analysis.walkableMask === game.collisionIndex.walkableMask &&
            game.overlay.pixelMap === game.analysis && level.analysis === game.analysis,
          sameSnapshot: game.snapshot === __mv3MazeSource.snapshot,
          route: level.referencePath };
      }
    }), mazeTabId);
    assert.equal(mazeWitness.result.state, 'READY');
    assert.equal(mazeWitness.result.mode, 'maze');
    assert.equal(mazeWitness.result.nodes, 2);
    assert.equal(mazeWitness.result.unlimited, true);
    assert.equal(mazeWitness.result.inkLabel, '∞');
    assert.ok(mazeWitness.result.walls > 0);
    assert.equal(mazeWitness.result.permanentWalls, 0, 'added connectors stay transparent until approached');
    assert.ok(mazeWitness.result.connectionThicknesses.every(width => width === 3), 'connections use three-pixel circular-cap strokes');
    assert.equal(mazeWitness.result.noOverlayMaze, true, 'natural page content is not replaced by a grid or paper floor');
    assert.equal(mazeWitness.result.fixedAnswerSafe, true, 'walls preserve the answer that was chosen before they were placed');
    assert.ok(mazeWitness.result.addedPixelRatio > 0, 'connections add foreground only where the original gap is closed');
    assert.ok(mazeWitness.result.sourceObstacleRatio >= .20, 'the maze needs at least 20% original natural foreground');
    assert.equal(mazeWitness.result.originalAnchors, true, 'each connector attaches directly to original content or the existing boundary');
    assert.equal(mazeWitness.result.exactObstacleUnion, true, 'the final mask is exactly original content plus declared connectors');
    assert.equal(mazeWitness.result.ownMap && mazeWitness.result.commonMask && mazeWitness.result.sameSnapshot, true,
      'the maze uses a derived collision map while retaining the frozen screenshot');
    await verifyTransparentMaze(mazeTabId);
    const mazeRoute = await verifyNoMazeHint(mazePage, mazeTabId);
    await verifyTransparentMaze(mazeTabId);
    assert.deepEqual(mazeRoute, mazeWitness.result.route);
    await mazePage.screenshot({ path: path.join(root, 'test-results/pagepath-maze-mv3.png') });
    await mazePage.mouse.move(mazeRoute[0].x, mazeRoute[0].y);
    await mazePage.mouse.click(mazeRoute[0].x, mazeRoute[0].y);
    assert.equal(await mazePage.locator('[data-pagepath-root] .toolbar-main').isVisible(), false);
    for (const point of mazeRoute.slice(1)) await mazePage.mouse.move(point.x, point.y, { steps: 2 });
    const [mazeCompleted] = await worker.evaluate(mazeTabId => chrome.scripting.executeScript({
      target: { tabId: mazeTabId }, world: 'ISOLATED', func: () => {
        const game = __PAGEPATH__.instance;
        return { state: game.state, collected: game.collected.size, ink: game.overlay.cursorInk.textContent,
          message: game.overlay.message.textContent, length: game.length };
      }
    }), mazeTabId);
    assert.equal(mazeCompleted.result.state, 'SUCCESS', 'the real extension maze reference is completable with mouse events');
    assert.equal(mazeCompleted.result.collected, 2);
    assert.equal(mazeCompleted.result.ink, '∞');
    assert.ok(mazeCompleted.result.length > 0);
    assert.doesNotMatch(mazeCompleted.result.message, /NaN|Infinity/);
    assert.equal(await mazePage.locator('[data-pagepath-root] .toolbar-main').isVisible(), true);
    await verifyNoMazeHint(mazePage, mazeTabId);
    await mazePage.locator('[data-pagepath-root] .mode-button[data-mode="normal"]').click();
    await ready(mazePage);
    const [mazeRestored] = await worker.evaluate(mazeTabId => chrome.scripting.executeScript({
      target: { tabId: mazeTabId }, world: 'ISOLATED', func: () => {
        const game = __PAGEPATH__.instance, { snapshot, source, obstacle, walkable, distance, contours } = __mv3MazeSource;
        return { mode: game.mode, restored: game.analysis === source && game.sourceAnalysis === source &&
          game.snapshot === snapshot && source.obstacleMask.every((value, i) => value === obstacle[i]) &&
          source.walkableMask.every((value, i) => value === walkable[i]) &&
          source.distanceMap.every((value, i) => value === distance[i]) &&
          source.contours.segments.every((value, i) => value === contours[i]),
          finiteInk: Number.isFinite(game.level.maxInk) && !game.level.unlimitedInk,
          walls: game.overlay.mazeWallLayer.childElementCount, ink: game.overlay.cursorInk.textContent };
      }
    }), mazeTabId);
    assert.deepEqual(mazeRestored.result, { mode: 'normal', restored: true, finiteInk: true, walls: 0, ink: '100%' });
    assert.equal(await worker.evaluate(() => pixelAnalysisRuns), analysesBeforeMaze + 1,
      'the second level uses cached screenshot analysis throughout generation, play and return');
    await mazePage.keyboard.press('Escape');
    await gone(mazePage);

    const restricted = await context.newPage();
    await restricted.goto('chrome://version');
    const restrictedId = await activeTabId();
    await action(restricted);
    await until(() => badge(restrictedId), text => text === '!', 'restricted-page badge');
    const unavailable = await worker.evaluate(async tabId => ({
      popup: await chrome.action.getPopup({ tabId }),
      title: await chrome.action.getTitle({ tabId }),
    }), restrictedId);
    assert.match(unavailable.popup, /\/src\/unavailable\.html$/);
    assert.match(unavailable.title, /此页面不允许扩展运行/);
    assert.equal(await restricted.locator('[data-pagepath-root]').count(), 0);
    assert.deepEqual(errors, [], 'no browser JavaScript or CSP console errors');
    console.log(JSON.stringify({ mv3: 'passed', browser: context.browser().version(), extensionId: id,
      originalManifest: true, actionGrantsActiveTab: true, isolatedWorld: true,
      toolbarToggle: true, escapeMessage: true, rightClickExit: true, navigationReset: true,
      frozenScreenshot: true, liveDOMDoesNotPause: true, newMapReusesSnapshot: true,
      viewportResizeRegeneratesSnapshot: true,
      strictImageCSP: true, screenshotHiddenFromPage: true, livePageRestored: true,
      restrictedPageFeedback: true, referenceRouteCompleted: true, hellRouteCompleted: true, immortalRouteCompleted: true,
      mazeSimplePageDisabled: true, mazeRouteCompleted: true, mazeUnlimitedInk: true,
      mazeLockedPadlockClear: true, mazeSourceDrivenCriterionChecks: true, mazeUnlockedStarOnly: true, mazeDisabledCannotSwitch: true,
      mazeConstructedFallbackCompleted: true, mazeFallbackPreservesCapture: true,
      mazeOpenBackgroundDisabled: true, mazeNaturalObstacles: true, mazeWallsTransparentWithoutHints: true,
      ordinaryHintsShowRoutesOnly: true, mazeHintsUnavailable: true,
      mazeUsesCachedScreenshot: true, mazeReturnRestoresOriginalMap: true,
      modeSwitchKeepsSnapshot: true, shortTailPreservesFullInk: true, nodes: injection.result.nodes,
      screenshot: 'test-results/pagepath-mv3.png' }, null, 2));
  } finally {
    await context?.close();
    await new Promise(resolve => server.close(resolve));
    // Delete only the exact temporary profile created above, never a real profile.
    const temp = path.resolve(os.tmpdir());
    assert.ok(path.resolve(profile).startsWith(temp + path.sep) && path.basename(profile).startsWith('pagepath-mv3-'));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
