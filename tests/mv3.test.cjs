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

(async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; script-src 'none'; img-src 'none'; style-src 'unsafe-inline'",
    });
    response.end(`<!doctype html><html lang="en"><head><title>PagePath MV3 test</title>
      <style>body{margin:0;background:#fafbf7;color:#233b30;font:18px Georgia}
      main{position:absolute;left:30%;top:35%;width:40%}h1{font-size:32px}
      p{font-size:16px;line-height:1.7}</style></head><body><main>
      <h1>The webpage is the level.</h1><p>This is an ordinary webpage with a strict
      content security policy. PagePath runs in the extension's isolated world.</p>
      </main></body></html>`);
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

    await action(page);
    await ready(page);
    await until(() => badge(tabId), text => text === 'ON', 'ON badge');
    assert.equal(await page.evaluate(() => typeof globalThis.__PAGEPATH__), 'undefined', 'game state is isolated from page JS');
    const [injection] = await worker.evaluate(tabId => chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED', func: () => ({
        state: globalThis.__PAGEPATH__.instance.state,
        nodes: globalThis.__PAGEPATH__.instance.level.nodes.length,
        snapshotMode: globalThis.__PAGEPATH__.instance.snapshot?.mode,
      }),
    }), tabId);
    assert.equal(injection.result.state, 'READY');
    assert.ok(injection.result.nodes >= 4);
    assert.equal(injection.result.snapshotMode, 'screenshot');
    // Play the actual generated route with real pointer input on the frozen page.
    // This checks that a harder multi-region puzzle still fits its tighter ink budget.
    const [witness] = await worker.evaluate(tabId => chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED',
      func: () => globalThis.__PAGEPATH__.instance.level.referencePath
    }), tabId);
    const route = witness.result;
    await page.mouse.move(route[0].x, route[0].y);
    await page.mouse.down();
    for (const point of route.slice(1)) await page.mouse.move(point.x, point.y, { steps: 2 });
    await page.mouse.up();
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
    await page.locator('[data-pagepath-root] .mode-select').selectOption('hell');
    await ready(page);
    assert.ok((await readSnapshot()).src === initialSnapshot, 'difficulty switch reuses the frozen webpage');
    const [hellWitness] = await worker.evaluate(tabId => chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED', func: () => {
        const game = globalThis.__PAGEPATH__.instance;
        return { mode: game.mode, nodes: game.level.nodes.length, ink: game.level.inkMultiplier,
          maxInk: game.level.maxInk, referenceLength: game.level.referenceLength,
          title: game.overlay.modeSelect.title, controlTitle: game.overlay.modeControl.title,
          route: game.level.referencePath, positions: game.level.nodes.map(({ x, y }) => ({ x, y })) };
      }
    }), tabId);
    assert.equal(hellWitness.result.mode, 'hell');
    assert.ok(hellWitness.result.nodes >= 14 && hellWitness.result.nodes <= 16);
    const hellSpare = 10 + Math.max(0, hellWitness.result.nodes - 5) * 1.5;
    assert.ok(Math.abs(hellWitness.result.ink - (1 + hellSpare / 100)) < 1e-12);
    assert.ok(Math.abs(hellWitness.result.maxInk / hellWitness.result.referenceLength - (1 + hellSpare / 100)) < 1e-12);
    assert.match(hellWitness.result.title, new RegExp(`(?:^|[^\\d.])${String(hellSpare).replace('.', '\\.')}%`),
      'the real extension must show its actual node-adjusted ink allowance');
    assert.doesNotMatch(hellWitness.result.title, /(?:^|[^\d.])10%/);
    assert.equal(hellWitness.result.controlTitle, hellWitness.result.title);
    await page.locator('[data-pagepath-root] .hint').click();
    assert.equal(await page.locator('[data-pagepath-root] .hint').getAttribute('aria-pressed'), 'true');
    assert.ok((await readSnapshot()).src === initialSnapshot, 'answer overlay keeps the same frozen page');
    const hellRoute = await page.locator('[data-pagepath-root] .hint-path').evaluate(el =>
      Array.from(el.points, p => ({ x: p.x, y: p.y })));
    assert.equal(hellRoute.length, hellWitness.result.route.length, 'the displayed answer includes every route segment');
    await page.mouse.move(hellRoute[0].x, hellRoute[0].y);
    await page.mouse.down();
    await page.waitForFunction(() => document.querySelector('[data-pagepath-root]').shadowRoot.querySelector('.mode-select').disabled);
    for (const point of hellRoute.slice(1)) await page.mouse.move(point.x, point.y, { steps: 2 });
    await page.mouse.up();
    const [hellCompleted] = await worker.evaluate(tabId => chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED', func: () => {
        const game = globalThis.__PAGEPATH__.instance;
        return { state: game.state, drawn: game.overlay.path.getTotalLength(), length: game.length,
          inkLeft: game.level.maxInk - game.length };
      }
    }), tabId);
    assert.equal(hellCompleted.result.state, 'SUCCESS');
    assert.ok(hellCompleted.result.drawn > 0 && hellCompleted.result.drawn <= 71);
    assert.ok(hellCompleted.result.length > hellCompleted.result.drawn * 3 && hellCompleted.result.inkLeft > 0);
    assert.equal(await page.locator('[data-pagepath-root] .hint').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-pagepath-root] .new-puzzle').click();
    await ready(page);
    assert.equal(await page.locator('[data-pagepath-root] .hint').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('[data-pagepath-root] .mode-select').inputValue(), 'hell');
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
    await page.locator('[data-pagepath-root] .mode-select').selectOption('immortal');
    await ready(page);
    assert.ok((await readSnapshot()).src === initialSnapshot, 'Immortal also reuses the same frozen page');
    await page.locator('[data-pagepath-root] .hint').click();
    const immortalRoute = await page.locator('[data-pagepath-root] .hint-path').evaluate(el =>
      Array.from(el.points, p => ({ x: p.x, y: p.y })));
    await page.mouse.move(immortalRoute[0].x, immortalRoute[0].y);
    await page.mouse.down();
    for (const point of immortalRoute.slice(1)) await page.mouse.move(point.x, point.y, { steps: 2 });
    await page.mouse.up();
    const [immortalCompleted] = await worker.evaluate(tabId => chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED', func: () => {
        const game = globalThis.__PAGEPATH__.instance;
        return { state: game.state, mode: game.mode, ink: game.level.inkMultiplier,
          inkLeft: game.level.maxInk - game.length, label: game.overlay.message.textContent };
      }
    }), tabId);
    assert.equal(immortalCompleted.result.state, 'SUCCESS');
    assert.equal(immortalCompleted.result.mode, 'immortal');
    assert.equal(immortalCompleted.result.ink, 1.10);
    assert.ok(immortalCompleted.result.inkLeft > 0);
    assert.match(immortalCompleted.result.label, /神仙.*得分/);
    await page.locator('[data-pagepath-root] .mode-select').selectOption('normal');
    await ready(page);
    assert.ok((await readSnapshot()).src === initialSnapshot, 'returning to Normal retains the same snapshot');
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
