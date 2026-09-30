const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

function worker() {
  const handlers = {}, calls = [], injections = [], captures = [], waits = [], imports = [], analyses = [];
  const hintBatches = [];
  const activeTabs = new Map([
    [3, { id: 7, windowId: 3, url: 'https://example.com/article' }],
    [4, { id: 8, windowId: 4, url: 'https://example.com/other' }],
  ]);
  let now = 1000;
  class TestDate extends Date { static now() { return now; } }
  const action = Object.fromEntries(['setBadgeText','setBadgeBackgroundColor','setTitle','setPopup','openPopup'].map(method => [method, async data => { calls.push([method, data]); }]));
  const chrome = { action: { ...action, onClicked: { addListener: f => handlers.click = f } },
    runtime: { id: 'pagepath-test', onMessage: { addListener: f => handlers.message = f } },
    tabs: {
      onUpdated: { addListener: f => handlers.update = f },
      onActivated: { addListener: f => handlers.activate = f },
      query: async options => {
        calls.push(['query', options]);
        const tab = activeTabs.get(options.windowId);
        return tab ? [{ ...tab }] : [];
      },
      captureVisibleTab: async (windowId, options) => {
        captures.push({ windowId, options, time: now });
        return 'data:image/png;base64,c25hcHNob3Q=';
      },
    },
    scripting: { executeScript: async options => {
      injections.push(options);
      if (options.args) {
        calls.push(['compactHints']);
        return [{ frameId: 0, documentId: options.target.documentIds?.[0], result: hintBatches.shift() || [] }];
      }
      if (options.target.documentIds) {
        const tab = [...activeTabs.values()].find(tab => tab.id === options.target.tabId);
        return [{ frameId: 0, documentId: options.target.documentIds[0], result: tab?.url }];
      }
      return [{ result: { active: true } }];
    } } };
  const P = { Config: { PIXEL_MAP: { MAX_PIXELS: 8500000 } },
    ImageMapAnalyzer: { analyze: async (pixels, bounds) => {
      analyses.push({ width: pixels.width, height: pixels.height, bounds });
      return { kind: 'pixel-mask' };
    } }, MapCodec: { encode: async analysis => ({ testEncodedMap: analysis.kind }) } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/content/compactMask.js'), 'utf8'), { __PAGEPATH__: P });
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() { return { drawImage() {}, getImageData: () => ({ width: this.width, height: this.height }) }; }
  }
  vm.runInNewContext(fs.readFileSync(path.join(root,'src/background.js'),'utf8'), {
    chrome, URL, Set, Map, Promise, Date: TestDate, Blob, Uint8Array, atob, TextEncoder,
    __PAGEPATH__: P, importScripts: (...files) => imports.push(...files), OffscreenCanvas: Canvas,
    createImageBitmap: async () => ({ width: 1200, height: 800, close() { calls.push(['closeBitmap']); } }),
    setTimeout: (callback, delay) => { waits.push(delay); now += delay; callback(); },
  });
  function request(sender = {}, message = {}) {
    const origin = { id: chrome.runtime.id, frameId: 0, tab: { ...activeTabs.get(3) },
      url: 'https://example.com/article', ...sender };
    return new Promise(resolve => {
      assert.equal(handlers.message({ type: 'PAGEPATH_CAPTURE', bounds: { width: 1200, height: 800, dpr: 1 }, ...message }, origin, resolve), true);
    });
  }
  return { handlers, calls, injections, captures, waits, activeTabs, chrome, request, imports, analyses, P, hintBatches };
}

test('MV3 package has minimal permissions, local assets, ordered scripts and strict CSP', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['activeTab','scripting']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.match(manifest.content_security_policy.extension_pages, /'wasm-unsafe-eval'/);
  assert.doesNotMatch(manifest.content_security_policy.extension_pages, /(?:^|\s)'unsafe-eval'|'unsafe-inline'/);
  assert.match(manifest.content_security_policy.extension_pages, /connect-src 'none'/);
  for (const file of [manifest.background.service_worker, ...Object.values(manifest.icons)]) assert.ok(fs.statSync(path.join(root,file)).size > 0);
});

test('extension and development package publish the same three-part version', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, packageInfo.version);
});

test('release archive contains only installable assets and user documentation', { skip: process.platform !== 'win32' }, t => {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const fixtureRoot = fs.mkdtempSync(path.join(temporaryRoot, 'pagepath-release-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(fixtureRoot)), temporaryRoot, 'cleanup stays within the temporary directory');
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });
  const fixtureFiles = {
    'manifest.json': JSON.stringify({ version: '1.0.0', name: 'PagePath · 网页一笔画', description: '把截图变成地图。', background: { service_worker: 'src/background.js' }, icons: { 16: 'icons/icon16.png' } }),
    'README.md': 'Release introduction',
    'docs/USAGE.md': 'User instructions',
    'docs/PRIVACY.md': 'Privacy statement',
    'src/background.js': 'console.log("fixture");',
    'src/content/styles.css': 'body { color: black; }',
    'icons/icon16.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    'icons/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'icons/design-notes.md': 'Do not package',
    'docs/DEVELOPMENT.md': 'Do not package',
    'package.json': '{"version":"1.0.0"}',
    'tests/example.test.cjs': 'Do not package',
    'shuoming.md': 'Do not package',
    'test-results/screenshot.png': 'Do not package',
    '.env': 'EXAMPLE=not-a-secret',
    '.git/config': 'Do not package',
    'dist/old-release.zip': 'Preserve this old local archive',
    'vendor/opencv/opencv.js': 'Packaged runtime',
    'vendor/opencv/LICENSE': 'OpenCV license',
    'vendor/opencv/LICENSE.emscripten': 'Emscripten license',
    'vendor/opencv/README.md': 'Runtime provenance',
    'vendor/opencv/prepare.cjs': 'Do not package developer utilities',
  };
  for (const [relativePath, contents] of Object.entries(fixtureFiles)) {
    const destination = path.join(fixtureRoot, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
  }
  fs.mkdirSync(path.join(fixtureRoot, 'scripts'));
  const packageScript = path.join(fixtureRoot, 'scripts/package.ps1');
  fs.copyFileSync(path.join(root, 'scripts/package.ps1'), packageScript);
  const archivePath = path.join(fixtureRoot, 'dist/PagePath-v1.0.0.zip');
  // A second run must safely replace the same release without removing older archives.
  for (let run = 0; run < 2; run++) {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', packageScript], {
      encoding: 'utf8', timeout: 30000, windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.ok(fs.statSync(archivePath).size > 0);
  }
  const inspection = spawnSync('powershell.exe', ['-NoProfile', '-Command', `
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($env:PAGEPATH_TEST_ARCHIVE)
    try {
      $entries = @($archive.Entries | ForEach-Object { $_.FullName })
      $reader = [System.IO.StreamReader]::new($archive.GetEntry('manifest.json').Open())
      try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
      @{ entries = $entries; version = $manifest.version } | ConvertTo-Json -Compress
    } finally { $archive.Dispose() }
  `], {
    env: { ...process.env, PAGEPATH_TEST_ARCHIVE: archivePath },
    encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  assert.equal(inspection.status, 0, inspection.stderr || inspection.error?.message);
  const contents = JSON.parse(inspection.stdout);
  assert.equal(contents.version, '1.0.0');
  assert.deepEqual(contents.entries.sort(), [
    'README.md', 'docs/PRIVACY.md', 'docs/USAGE.md', 'icons/icon.svg',
    'icons/icon16.png', 'manifest.json', 'src/background.js', 'src/content/styles.css',
    'vendor/opencv/opencv.js', 'vendor/opencv/LICENSE', 'vendor/opencv/LICENSE.emscripten', 'vendor/opencv/README.md',
  ].sort());
  assert.equal(fs.readFileSync(path.join(fixtureRoot, 'dist/old-release.zip'), 'utf8'), fixtureFiles['dist/old-release.zip']);
  assert.ok(!fs.readdirSync(path.join(fixtureRoot, 'dist')).some(name => name.endsWith('.tmp')));
});

test('toolbar injects locally into the top frame isolated world', async () => {
  const { handlers, injections, calls, imports } = worker();
  await handlers.click({ id: 7, url: 'https://example.com/article' });
  assert.equal(injections.length, 1);
  assert.equal(injections[0].world, 'ISOLATED');
  assert.deepEqual(Array.from(injections[0].target.frameIds), [0]);
  assert.equal(injections[0].files.at(-1), 'src/content/index.js');
  assert.ok(injections[0].files.indexOf('src/content/pageSnapshot.js') < injections[0].files.indexOf('src/content/game.js'));
  for (const file of injections[0].files) assert.ok(fs.existsSync(path.join(root,file)));
  assert.ok(injections[0].files.includes('src/content/mapCodec.js'));
  assert.ok(injections[0].files.includes('src/content/compactDom.js'));
  assert.ok(!injections[0].files.some(file => /opencv|imageMapAnalyzer/i.test(file)), 'webpages receive cached maps, not WASM');
  assert.ok(imports.includes('../vendor/opencv/opencv.js'));
  assert.ok(imports.includes('content/imageMapAnalyzer.js'));
  assert.ok(imports.includes('content/compactMask.js'));
  for (const file of imports) assert.ok(fs.existsSync(path.resolve(root, 'src', file)));
  assert.ok(calls.some(([type, data]) => type === 'setBadgeText' && data.text === 'ON'));
});

test('system pages and extension stores show an explanation without injection', async () => {
  for (const url of ['chrome://extensions', 'edge://settings', 'about:blank', 'https://chromewebstore.google.com/detail/id', 'https://chrome.google.com/webstore/detail/id']) {
    const { handlers, injections, calls } = worker();
    await handlers.click({ id: 9, url });
    assert.equal(injections.length, 0);
    assert.ok(calls.some(([type, data]) => type === 'setPopup' && data.popup === 'src/unavailable.html'));
  }
});

test('injection denial is contained and navigation resets the restricted popup', async () => {
  const { handlers, calls, chrome } = worker();
  chrome.scripting.executeScript = async () => { throw new Error('Cannot access contents'); };
  await assert.doesNotReject(handlers.click({ id: 3, url: 'https://example.com/private' }));
  handlers.update(3, { status: 'loading' });
  assert.ok(calls.some(([type, data]) => type === 'setPopup' && data.popup === ''));
});

test('Escape/Exit status message clears the originating tab badge', () => {
  const { handlers, calls } = worker();
  handlers.message({ type: 'PAGEPATH_CLOSED' }, { tab: { id: 8 } });
  assert.ok(calls.some(([type, data]) => type === 'setBadgeText' && data.tabId === 8 && data.text === ''));
});

test('snapshot captures only the requesting active tab and returns PNG without extra permissions', async () => {
  const { request, captures, calls, analyses } = worker();
  const result = await request();
  assert.equal(result.ok, true);
  assert.equal(result.dataUrl, 'data:image/png;base64,c25hcHNob3Q=');
  assert.equal(result.map.testEncodedMap, 'pixel-mask');
  assert.equal(analyses.length, 1);
  assert.equal(analyses[0].width, 1200);
  assert.equal(analyses[0].height, 800);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].windowId, 3);
  assert.equal(captures[0].options.format, 'png');
  const queries = calls.filter(([type]) => type === 'query');
  assert.equal(queries.length, 3, 'active tab is checked before/after capture and after image analysis');
  assert.ok(queries.every(([, options]) => options.active === true && options.windowId === 3));
});

test('snapshot validates the top-frame document before and after capture when available', async () => {
  const { request, injections } = worker();
  assert.equal((await request({ documentId: 'document-7' })).ok, true);
  assert.equal(injections.length, 5, 'three document checks and two compact geometry reads');
  assert.ok(injections.every(options => options.target.tabId === 7 &&
    options.target.documentIds[0] === 'document-7' && options.world === 'ISOLATED'));
});

test('capture brackets the actual PNG with stable, geometry-only compact hints', async () => {
  const { request, chrome, hintBatches, analyses } = worker();
  const stable = { x: 20, y: 20, width: 90, height: 30, kind: 'box', radius: 8 };
  const moving = { x: 220, y: 40, width: 30, height: 30, kind: 'content', radius: 0 };
  hintBatches.push([stable, moving]);
  const original = chrome.tabs.captureVisibleTab;
  chrome.tabs.captureVisibleTab = async (...args) => {
    assert.equal(hintBatches.length, 0, 'first read happened before PNG capture');
    hintBatches.push([{ ...stable, privateText: 'never copy this' }, { ...moving, x: 260 }]);
    return original(...args);
  };
  assert.equal((await request({ documentId: 'document-7' })).ok, true);
  assert.equal(hintBatches.length, 0, 'second read happened after PNG capture');
  assert.deepEqual(JSON.parse(JSON.stringify(analyses[0].bounds.domHints)), [stable]);
});

test('optional DOM read failures fall back to the same screenshot analysis', async () => {
  const { request, chrome, analyses } = worker();
  const execute = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async options => {
    if (options.args) throw new Error('unsupported geometry');
    return execute(options);
  };
  assert.equal((await request({ documentId: 'document-7' })).ok, true);
  assert.equal(analyses.length, 1);
  assert.equal(analyses[0].bounds.domHints.length, 0);
});

test('snapshot rejects other extensions, subframes, unsupported URLs and missing tab identity', async () => {
  for (const sender of [
    { id: 'another-extension' }, { frameId: 1 }, { frameId: undefined },
    { tab: undefined }, { tab: { id: 7 } },
    { url: 'chrome://settings' }, { tab: { id: -1, windowId: 3 } },
  ]) {
    const { request, captures } = worker();
    const result = await request(sender);
    assert.equal(result.ok, false);
    assert.equal(result.dataUrl, undefined);
    assert.equal(captures.length, 0);
  }
});

test('snapshot rejects inactive tabs and pages whose URL changed before capture', async () => {
  for (const change of [{ id: 9 }, { url: 'https://example.org/private' }, { pendingUrl: 'https://example.org/next' }]) {
    const { request, activeTabs, captures } = worker();
    activeTabs.set(3, { ...activeTabs.get(3), ...change });
    const result = await request({ tab: { id: 7, windowId: 3, url: 'https://example.com/article' } });
    assert.equal(result.ok, false);
    assert.equal(result.dataUrl, undefined);
    assert.equal(captures.length, 0);
  }
});

test('snapshot discards bytes when tab activation or same-URL navigation changes during capture', async () => {
  for (const change of ['active-tab', 'same-url-reload', 'switch-away-and-back', 'route-away-and-back']) {
    const { request, activeTabs, chrome, handlers } = worker();
    chrome.tabs.captureVisibleTab = async () => {
      if (change === 'active-tab') activeTabs.set(3, { id: 9, windowId: 3, url: 'https://example.org/private' });
      else if (change === 'same-url-reload') handlers.update(7, { status: 'loading' });
      else if (change === 'switch-away-and-back') {
        handlers.activate({ tabId: 9, windowId: 3 });
        handlers.activate({ tabId: 7, windowId: 3 });
      } else {
        handlers.update(7, { url: 'https://example.com/temporary-route' });
        handlers.update(7, { url: 'https://example.com/article' });
      }
      return 'data:image/png;base64,b3RoZXItcGFnZQ==';
    };
    const result = await request();
    assert.equal(result.ok, false);
    assert.match(result.error, /页面已切换/);
    assert.equal(result.dataUrl, undefined);
  }
});

test('snapshot rejects a stale document even when its URL is unchanged', async () => {
  const { request, chrome, captures } = worker();
  chrome.scripting.executeScript = async () => [{ frameId: 0, documentId: 'new-document', result: 'https://example.com/article' }];
  const result = await request({ documentId: 'old-document' });
  assert.equal(result.ok, false);
  assert.equal(captures.length, 0);
});

test('snapshot refuses invalid or oversized viewport dimensions before capture', async () => {
  for (const bounds of [undefined, null, { width: 0, height: 800, dpr: 1 },
    { width: 1200.5, height: 800, dpr: 1 }, { width: 100000, height: 100000, dpr: 1 },
    { width: 1200, height: 800, dpr: 0 }, { width: 1200, height: 800, dpr: Infinity }]) {
    const { request, captures } = worker();
    assert.equal((await request({}, { bounds })).ok, false);
    assert.equal(captures.length, 0);
  }
});

test('analysis failure closes decoded screenshot and does not leak partial maps', async () => {
  const { request, P, calls } = worker();
  P.ImageMapAnalyzer.analyze = async () => { throw new Error('private pixel data'); };
  const result = await request();
  assert.equal(result.ok, false);
  assert.equal(result.map, undefined);
  assert.equal(result.dataUrl, undefined);
  assert.ok(!result.error.includes('private'));
  assert.ok(calls.some(([type]) => type === 'closeBitmap'));
});

test('navigation during analysis discards both screenshot and generated mask', async () => {
  const { request, P, handlers } = worker();
  P.ImageMapAnalyzer.analyze = async () => {
    handlers.update(7, { status: 'loading' });
    return { kind: 'pixel-mask' };
  };
  const result = await request();
  assert.equal(result.ok, false);
  assert.match(result.error, /页面已切换/);
  assert.equal(result.map, undefined);
  assert.equal(result.dataUrl, undefined);
});

test('screenshot dimensions must match the requesting viewport aspect ratio', async () => {
  const { request, analyses, calls } = worker();
  const result = await request({}, { bounds: { width: 1200, height: 700, dpr: 2 } });
  assert.equal(result.ok, false);
  assert.match(result.error, /页面已切换/);
  assert.equal(analyses.length, 0);
  assert.ok(calls.some(([type]) => type === 'closeBitmap'));
});

test('CSS-resolution captures normalize correctly even when page DPR differs', async () => {
  const { request, analyses } = worker();
  assert.equal((await request({}, { bounds: { width: 1200, height: 800, dpr: 2 } })).ok, true);
  assert.equal(analyses[0].width, 1200);
  assert.equal(analyses[0].height, 800);
});

test('analysis gives a specific safe explanation when no background is found', async () => {
  const { request, P } = worker();
  P.ImageMapAnalyzer.analyze = async () => { throw new Error('截图中未找到足够清晰的背景空隙，请更换页面位置后重试'); };
  const result = await request();
  assert.equal(result.ok, false);
  assert.match(result.error, /未找到足够清晰的背景/);
});

test('combined PNG and mask transport is bounded below the browser message limit', async () => {
  const { request, P } = worker();
  P.MapCodec.encode = async () => ({ payload: 'A'.repeat(60 * 1024 * 1024) });
  const result = await request();
  assert.equal(result.ok, false);
  assert.match(result.error, /数据过大.*缩小浏览器/);
  assert.equal(result.map, undefined);
  assert.equal(result.dataUrl, undefined);
});

test('capture errors return a safe message and do not block later requests', async () => {
  const { request, chrome, captures, waits } = worker();
  const capture = chrome.tabs.captureVisibleTab;
  chrome.tabs.captureVisibleTab = async () => { throw new Error('private URL / browser implementation details'); };
  const failed = await request();
  assert.equal(failed.ok, false);
  assert.match(failed.error, /暂时无法固定页面/);
  assert.ok(!failed.error.includes('private'));
  chrome.tabs.captureVisibleTab = capture;
  const retry = await request();
  assert.equal(retry.ok, true);
  assert.equal(captures.length, 1);
  assert.ok(waits[0] >= 550, 'failed captures also count against the browser rate limit');
});

test('snapshot serializes captures across windows and rejects a duplicate pending request', async () => {
  const { request, chrome, activeTabs, captures } = worker();
  const capture = chrome.tabs.captureVisibleTab;
  let release;
  chrome.tabs.captureVisibleTab = async (...args) => {
    const dataUrl = await capture(...args);
    if (args[0] === 3) await new Promise(resolve => { release = resolve; });
    return dataUrl;
  };
  const first = request();
  const duplicate = await request();
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /正在固定页面/);
  const second = request({ tab: activeTabs.get(4), url: activeTabs.get(4).url });
  for (let turn = 0; turn < 10 && !release; turn++) await Promise.resolve();
  assert.equal(typeof release, 'function');
  assert.equal(captures.length, 1);
  release();
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result.ok));
  assert.equal(captures.length, 2);
  assert.ok(captures[1].time - captures[0].time >= 550);
});
