// Real unpacked MV3 smoke test: activeTab access, cancellable extension workers,
// screenshot analysis, genuine mouse input and persistent extension storage.
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
async function until(read, predicate, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    if (value?.state === 'PAUSED' && value?.generationFailed) assert.fail(`${label}: ${value.message}`);
    await delay(30);
  } while (Date.now() < deadline);
  assert.fail(`Timed out: ${label}; last value ${JSON.stringify(value)}`);
}

(async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; script-src 'none'; img-src 'none'; style-src 'unsafe-inline'" });
    const content = request.url === '/content' ? '<main><h1>The webpage is the maze.</h1><p>Original page content remains part of the playable map.</p><button>Page content</button></main>' : '';
    response.end(`<!doctype html><html><head><title>PagePath MV3 maze</title><style>
      html,body{margin:0;min-height:100%;background:#fff;color:#263930;font:18px Georgia}
      main{position:absolute;left:28%;top:35%;width:45%;padding:24px;background:#edf1ed;border-radius:16px}
      h1{font-size:28px}p{line-height:1.7}button{padding:12px;border:1px solid #263930;border-radius:8px}
      </style></head><body>${content}</body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(temporaryRoot, 'pagepath-mv3-'));
  const errors = [];
  const cancellationTimes = [];
  let context, worker, browserCDP, extensionId;
  async function launch() {
    context = await playwright.chromium.launchPersistentContext(profile, {
      executablePath, headless: true, viewport: { width: 1280, height: 900 },
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--enable-unsafe-extension-debugging'],
    });
    context.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
    extensionId = new URL(worker.url()).hostname;
    assert.match(worker.url(), /\/src\/background\.js$/);
    await until(() => worker.evaluate(() => chrome.action.onClicked.hasListeners()), Boolean, 'extension action registration');
    browserCDP = await context.browser().newBrowserCDPSession();
    await browserCDP.send('Target.setDiscoverTargets', { discover: true, filter: [{}] });
  }
  async function action(page) {
    await page.bringToFront();
    const { targetInfos } = await browserCDP.send('Target.getTargets', { filter: [{}] });
    const tab = targetInfos.find(target => target.type === 'tab' && target.url === page.url());
    assert.ok(tab, `Tab target exists for ${page.url()}`);
    await browserCDP.send('Extensions.triggerAction', { id: extensionId, targetId: tab.targetId });
  }
  const activeTabId = () => worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id);
  const savedProfile = () => worker.evaluate(async () => (await chrome.storage.local.get('pagepath.progress.v3'))['pagepath.progress.v3']);
  async function readGame(tabId) {
    const [read] = await worker.evaluate(tabId => chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED', func: () => {
        const game = globalThis.__PAGEPATH__?.instance;
        if (!game) return null;
        return { state: game.state, locale: globalThis.__PAGEPATH__.I18n.locale, difficulty: game.level?.difficulty, stars: game.level?.stars,
          nodes: game.level?.nodes.length, referencePath: game.level?.referencePath,
          referenceLength: game.level?.referenceLength, message: game.message, generationFailed: game.generationFailed,
          snapshotMode: game.snapshot?.mode, mapKind: game.analysis?.kind,
          snapshotSize: game.snapshot?.analysis && { width: game.snapshot.analysis.width, height: game.snapshot.analysis.height },
          sharedMask: game.collisionIndex?.walkableMask === game.analysis?.walkableMask,
          unique: game.level?.maze?.construction?.uniqueStartFinish,
          profile: game.profile, result: game.result, run: game.run,
          collectibles: game.level?.collectibles,
          multiplierVisible: game.overlay.surface.querySelector('.collectible[data-kind="multiplier"]')?.dataset.visible,
          multiplierBreathing: game.overlay.surface.querySelector('.collectible[data-kind="multiplier"] .bubble-glow') &&
            getComputedStyle(game.overlay.surface.querySelector('.collectible[data-kind="multiplier"] .bubble-glow')).animationName,
          timeControls: game.overlay.shadowRoot.querySelectorAll('.timer-value,.hud-timer').length,
          cursor: getComputedStyle(game.overlay.surface).cursor,
          toolbarVisible: getComputedStyle(game.overlay.toolbar.querySelector('.toolbar-main')).visibility,
          loadingAnimation: getComputedStyle(game.overlay.toolbar.querySelector('.status-icon')).animationName,
          loadingTransform: getComputedStyle(game.overlay.toolbar.querySelector('.status-icon')).transform,
          busy: game.overlay.toolbar.getAttribute('aria-busy'),
          exitEnabled: !game.overlay.exitButton.disabled && !game.overlay.toolbarMain.inert,
          modes: game.overlay.shadowRoot.querySelectorAll('.mode-button').length,
          resultPanels: game.overlay.shadowRoot.querySelectorAll('.result-panel').length,
          starLabel: game.overlay.toolbar.querySelector('.star-rating')?.getAttribute('aria-label'),
          displayedStars: Number(game.overlay.toolbar.querySelector('.star-rating')?.dataset.stars),
          starsVisible: game.overlay.toolbar.querySelector('.star-rating')?.checkVisibility(),
          xpVisible: game.overlay.toolbar.querySelector('.xp-value')?.checkVisibility(),
          xpInToolbar: Boolean(game.overlay.toolbar.querySelector('.xp-value')),
          xpText: game.overlay.toolbar.querySelector('.xp-value')?.textContent,
          toolbarCursor: getComputedStyle(game.overlay.toolbar).cursor,
          retryCursor: getComputedStyle(game.overlay.toolbar.querySelector('.retry')).cursor,
          saveControls: game.overlay.toolbar.querySelectorAll('.save-result,.settlement-note,.result-meta').length,
          hints: game.overlay.shadowRoot.querySelectorAll('.hint').length };
      },
    }), tabId);
    return read.result;
  }
  const ready = tabId => until(() => readGame(tabId), value => value?.state === 'READY', 'maze ready');
  const gone = page => page.waitForFunction(() => !document.querySelector('[data-pagepath-root]'));
  async function mazeWorkers() {
    const { targetInfos } = await browserCDP.send('Target.getTargets', { filter: [{}] });
    // Edge leaves extension-created worker URLs empty. This fresh profile only
    // loads PagePath, and the fixture's script-src 'none' rules out page workers.
    return targetInfos.filter(target => target.type === 'worker' &&
      (!target.url || target.url === `chrome-extension://${extensionId}/src/mazeWorker.js`));
  }
  async function checkCancellableGeneration(page, tabId) {
    await page.setViewportSize({ width: 3840, height: 2160 });
    try {
      for (const method of ['button', 'escape', 'right']) {
        await action(page);
        const started = await until(async () => ({ game: await readGame(tabId), workers: await mazeWorkers() }),
          value => {
            if (value.game?.generationFailed) assert.fail('4K worker startup: ' + value.game.message);
            return value.game?.state === 'GENERATING' && value.workers.length > 0;
          }, 'dedicated maze worker running on a 4K blank webpage');
        assert.equal(started.workers.length, 1, 'one dedicated worker serves the active map');
        assert.deepEqual(started.game.snapshotSize, { width: 3840, height: 2160 });
        assert.equal(started.game.toolbarVisible, 'visible');
        assert.equal(started.game.loadingAnimation, 'map-loading');
        assert.equal(started.game.busy, 'true'); assert.equal(started.game.exitEnabled, true);
        const heartbeat = await page.evaluate(async () => {
          const start = performance.now(); let previous = start, maximumGap = 0;
          for (let frames = 0; frames < 8; frames++) {
            const now = await new Promise(requestAnimationFrame);
            maximumGap = Math.max(maximumGap, now - previous); previous = now;
          }
          return { elapsed: performance.now() - start, maximumGap };
        });
        assert.ok(heartbeat.elapsed < 1000 && heartbeat.maximumGap < 500,
          'page animation frames remain responsive during real 4K maze computation: ' + JSON.stringify(heartbeat));
        const animated = await readGame(tabId);
        assert.equal(animated.state, 'GENERATING', 'cancellation is exercised while the large maze is still running');
        assert.notEqual(animated.loadingTransform, started.game.loadingTransform,
          'the actual extension loading indicator continues rotating while the worker computes');
        assert.ok((await mazeWorkers()).some(target => target.targetId === started.workers[0].targetId));
        const beforeExit = performance.now();
        if (method === 'button') await page.locator('[data-pagepath-root] .exit').click();
        else if (method === 'escape') await page.keyboard.press('Escape');
        else await page.mouse.click(10, 150, { button: 'right' });
        await gone(page);
        const exitMs = performance.now() - beforeExit;
        assert.ok(exitMs < 1000, method + ': exit removes the overlay within one second, got ' + Math.round(exitMs) + ' ms');
        await until(mazeWorkers, targets => !targets.some(target => target.targetId === started.workers[0].targetId),
          method + ': cancelling terminates the actual maze worker', 5000);
        await page.evaluate(async () => {
          await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
        });
        assert.equal(await readGame(tabId), null, 'late worker replies never resurrect a closed game');
        assert.equal(await page.locator('[data-pagepath-root]').count(), 0);
        assert.equal((await savedProfile())?.totalRuns || 0, 0, 'cancelled maps do not award experience');
        cancellationTimes.push(method + ' ' + Math.round(exitMs) + ' ms');
      }
    } finally { await page.setViewportSize({ width: 1280, height: 900 }); }
  }
  async function routeThroughBubble(tabId) {
    const [read] = await worker.evaluate(tabId => chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED', func: () => {
        const game = globalThis.__PAGEPATH__.instance;
        const { width, height, walkableMask } = game.analysis;
        const [start, finish] = game.level.nodes;
        const toCell = point => Math.floor(point.y) * width + Math.floor(point.x);
        const candidates = new Map(game.level.collectibles.filter(b => b.kind === 'multiplier').map(b => [toCell(b), b]));
        function search(from, target, avoidFinish) {
          const previous = new Int32Array(width * height); previous.fill(-2);
          const queue = new Int32Array(previous.length); let head = 0, tail = 1;
          const first = toCell(from); queue[0] = first; previous[first] = -1;
          let found = -1;
          while (head < tail) {
            const at = queue[head++], x = at % width, y = Math.floor(at / width);
            if (target(at)) { found = at; break; }
            for (const next of [x ? at - 1 : -1, x + 1 < width ? at + 1 : -1, y ? at - width : -1, y + 1 < height ? at + width : -1]) {
              if (next < 0 || !walkableMask[next] || previous[next] !== -2) continue;
              if (avoidFinish && Math.hypot(next % width + .5 - finish.x, Math.floor(next / width) + .5 - finish.y) <= globalThis.__PAGEPATH__.Config.HIT_RADIUS + 2) continue;
              previous[next] = at; queue[tail++] = next;
            }
          }
          if (found < 0) return null;
          const cells = [];
          for (let at = found; at >= 0; at = previous[at]) cells.push({ x: at % width + .5, y: Math.floor(at / width) + .5 });
          cells.reverse();
          const path = [cells[0]];
          for (let i = 1; i + 1 < cells.length; i++) {
            if (cells[i].x - cells[i - 1].x !== cells[i + 1].x - cells[i].x || cells[i].y - cells[i - 1].y !== cells[i + 1].y - cells[i].y) path.push(cells[i]);
          }
          if (cells.length > 1) path.push(cells.at(-1));
          return { found, path };
        }
        const pickup = search(start, at => candidates.has(at), true);
        if (!pickup) return null;
        const bubble = candidates.get(pickup.found), escape = search(bubble, at => at === toCell(finish), false);
        return escape ? { bubble, route: [start, ...pickup.path, ...escape.path, finish] } : null;
      },
    }), tabId);
    return read.result;
  }
  async function complete(page, tabId) {
    const before = await ready(tabId);
    assert.equal(before.nodes, 2);
    assert.equal(before.mapKind, 'pixel-mask');
    assert.equal(before.sharedMask, true);
    assert.equal(before.hints, 0);
    assert.equal(before.cursor, 'default');
    assert.equal(before.modes, 0);
    assert.equal(before.resultPanels, 0);
    assert.ok(before.difficulty >= 0 && before.difficulty <= 100);
    assert.equal(before.stars, Math.max(1, Math.ceil(before.difficulty / 20)));
    assert.equal(before.displayedStars, before.stars);
    assert.equal(before.starsVisible, true);
    assert.equal(before.xpVisible, false);
    assert.equal(before.toolbarCursor, 'default');
    assert.equal(before.retryCursor, 'default');
    assert.equal(before.saveControls, 0);
    assert.equal(before.timeControls, 0);
    assert.ok(before.collectibles.some(bubble => bubble.kind === 'xp'));
    assert.equal(before.collectibles.filter(bubble => bubble.kind === 'multiplier').length, 1);
    assert.equal(before.multiplierVisible, 'true');
    assert.equal(before.multiplierBreathing, 'bubble-breathe');
    const witness = await routeThroughBubble(tabId); // Test-only mask search; the product has no answer control.
    assert.ok(witness, 'the guaranteed multiplier can be reached before the finish');
    const route = witness.route;
    assert.ok(route.length > 2 && before.referenceLength > 200);
    await page.mouse.click(route[0].x, route[0].y);
    const drawing = await readGame(tabId);
    assert.equal(drawing.state, 'DRAWING', 'click and release begins free mouse drawing');
    assert.equal(drawing.cursor, 'none');
    assert.equal(drawing.toolbarVisible, 'hidden');
    for (let i = 1; i < route.length; i++) {
      const previous = route[i - 1], point = route[i];
      await page.mouse.move(point.x, point.y, { steps: Math.max(1, Math.ceil(Math.hypot(point.x - previous.x, point.y - previous.y) / 24)) });
    }
    const finished = await until(() => readGame(tabId), value => value?.state === 'SUCCESS' && value.result, 'completion and immediate experience');
    assert.equal(finished.cursor, 'default');
    assert.equal(finished.toolbarVisible, 'visible');
    assert.ok(finished.run.collectedIds.includes(witness.bubble.id));
    assert.equal(finished.run.multiplier, witness.bubble.value);
    assert.equal(finished.result.multiplier, witness.bubble.value);
    assert.ok(finished.result.score > 0 && finished.result.xp > 0);
    assert.equal(finished.result.xp, (finished.result.baseXp + finished.result.collectedXp) * finished.result.multiplier);
    assert.equal(finished.result.score, Math.round(600 + 20 * finished.result.scoringDifficulty));
    assert.equal(Object.hasOwn(finished.result, 'elapsedMs'), false);
    assert.equal(finished.result.awarded, true);
    assert.equal(finished.profile.totalXp, before.profile.totalXp + finished.result.xp, 'experience is credited as soon as completion appears');
    assert.equal(finished.resultPanels, 0);
    assert.equal(finished.xpInToolbar, true);
    assert.equal(finished.xpVisible, true);
    assert.equal(finished.starsVisible, false);
    assert.equal(finished.xpText, `+${finished.result.xp.toLocaleString(finished.locale)}`);
    assert.equal(finished.saveControls, 0);
    return finished;
  }

  try {
    await launch();
    const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
    assert.equal(manifest.version, JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version);
    assert.equal(manifest.name, await worker.evaluate(() => chrome.i18n.getMessage('extensionName')));
    assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage', 'offscreen']);
    assert.equal(manifest.host_permissions, undefined);
    const page = await context.newPage();
    await page.goto(`${origin}/blank`);
    const tabId = await activeTabId();
    assert.equal(await worker.evaluate(async tabId => {
      try { await chrome.scripting.executeScript({ target: { tabId }, func: () => true }); return false; }
      catch { return true; }
    }, tabId), true, 'activeTab requires a real extension action');
    await checkCancellableGeneration(page, tabId);
    await action(page);
    await ready(tabId);
    assert.equal(await page.evaluate(() => typeof globalThis.__PAGEPATH__), 'undefined');
    // Simulate a temporary disk/storage error beyond the immediate retry
    // window. Rewards must still be credited now and saved after exit.
    await worker.evaluate(() => {
      const write = chrome.storage.local.set.bind(chrome.storage.local);
      let failures = 5;
      chrome.storage.local.set = async values => {
        if (values['pagepath.progress.v3'] && failures-- > 0) throw new Error('simulated transient storage failure');
        return write(values);
      };
    });
    const first = await complete(page, tabId);
    await page.locator('[data-pagepath-root] .new-puzzle').click();
    const second = await complete(page, tabId);
    assert.notEqual(first.run.id, second.run.id);
    assert.equal(second.profile.wins, 2);
    assert.equal(second.profile.totalXp, first.result.xp + second.result.xp);
    await page.keyboard.press('Escape');
    await gone(page);
    const saved = await until(savedProfile, value => value?.totalRuns === 2 && value.totalXp === second.profile.totalXp, 'automatic reward persistence');
    assert.equal(saved.totalRuns, 2);
    assert.equal(saved.totalXp, second.profile.totalXp);

    // Reopening on a different page reads the extension-wide profile.
    await page.goto(`${origin}/content`);
    await action(page);
    await ready(tabId);
    const restored = await until(() => readGame(tabId), value => value?.profile?.totalXp === saved.totalXp, 'cross-page profile');
    assert.equal(restored.profile.wins, 2);
    await page.mouse.click(10, 150, { button: 'right' });
    await gone(page);

    // Persist the exact temporary browser profile across a genuine restart.
    await context.close(); context = null;
    await launch();
    const persisted = await savedProfile();
    assert.equal(persisted.totalXp, saved.totalXp);
    assert.equal(persisted.totalRuns, 2);
    const restartedPage = await context.newPage();
    await restartedPage.goto(`${origin}/blank-restarted`);
    const restartedTab = await activeTabId();
    await action(restartedPage);
    await ready(restartedTab);
    const reopened = await until(() => readGame(restartedTab), value => value?.profile?.totalXp === saved.totalXp, 'restarted game profile');
    assert.equal(reopened.profile.wins, 2);
    await restartedPage.keyboard.press('Escape');
    await gone(restartedPage);
    assert.deepEqual(errors, [], 'no browser JavaScript or CSP errors');
    console.log('MV3 maze smoke passed: responsive 4K worker cancellation (' + cancellationTimes.join(', ') +
      '), one guaranteed visible breathing multiplier per map, genuine pickup, difficulty-only score, collectible XP and automatic persistence across storage failures, game exit and browser restart.');
  } finally {
    try { await context?.close(); }
    finally {
      await new Promise(resolve => server.close(resolve));
      assert.equal(path.dirname(path.resolve(profile)), temporaryRoot, 'cleanup is limited to the created temporary profile');
      assert.ok(path.basename(profile).startsWith('pagepath-mv3-'));
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
