const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

function worker(storageData = {}, sessionData = {}, locale = 'zh-CN') {
  const handlers = {}, calls = [], injections = [], captures = [], waits = [], imports = [], analyses = [];
  const hintBatches = [];
  const storageCalls = [];
  const backgroundTimers = new Map();
  let timerId = 0;
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const activeTabs = new Map([
    [3, { id: 7, windowId: 3, url: 'https://example.com/article' }],
    [4, { id: 8, windowId: 4, url: 'https://example.com/other' }],
  ]);
  let now = 1000;
  class TestDate extends Date { static now() { return now; } }
  const action = Object.fromEntries(['setBadgeText','setBadgeBackgroundColor','setTitle','setPopup','openPopup'].map(method => [method, async data => { calls.push([method, data]); }]));
  const chrome = { i18n: { getUILanguage: () => locale },
    action: { ...action, onClicked: { addListener: f => handlers.click = f } },
    runtime: { id: 'pagepath-test', onMessage: { addListener: f => handlers.message = f } },
    storage: { local: {
      get: async key => {
        storageCalls.push(['get', key]);
        await Promise.resolve();
        return { [key]: clone(storageData[key]) };
      },
      set: async values => {
        storageCalls.push(['set', clone(values)]);
        await Promise.resolve();
        Object.assign(storageData, clone(values));
      },
    }, session: {
      get: async key => ({ [key]: clone(sessionData[key]) }),
      set: async values => { Object.assign(sessionData, clone(values)); },
    } },
    tabs: {
      onUpdated: { addListener: f => handlers.update = f },
      onActivated: { addListener: f => handlers.activate = f },
      onRemoved: { addListener: f => handlers.remove = f },
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
  for (const file of ['i18n', 'config', 'compactMask', 'scoring', 'progression']) {
    vm.runInNewContext(fs.readFileSync(path.join(root, `src/content/${file}.js`), 'utf8'), { __PAGEPATH__: P, chrome });
  }
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() { return { drawImage() {}, getImageData: () => ({ width: this.width, height: this.height }) }; }
  }
  const context = vm.createContext({
    chrome, URL, Set, Map, Promise, Date: TestDate, Blob, Uint8Array, atob, TextEncoder,
    __PAGEPATH__: P, importScripts: (...files) => imports.push(...files), OffscreenCanvas: Canvas,
    createImageBitmap: async () => ({ width: 1200, height: 800, close() { calls.push(['closeBitmap']); } }),
    setTimeout: (callback, delay) => {
      const id = ++timerId;
      if (delay >= 10000) backgroundTimers.set(id, callback);
      else { waits.push(delay); now += delay; callback(); }
      return id;
    },
    clearTimeout: id => backgroundTimers.delete(id),
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'src/generationHost.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root,'src/background.js'),'utf8'), context);
  function request(sender = {}, message = {}) {
    const origin = { id: chrome.runtime.id, frameId: 0, tab: { ...activeTabs.get(3) },
      url: 'https://example.com/article', ...sender };
    return new Promise(resolve => {
      assert.equal(handlers.message({ type: 'PAGEPATH_CAPTURE', bounds: { width: 1200, height: 800, dpr: 1 }, ...message }, origin, resolve), true);
    });
  }
  return { handlers, calls, injections, captures, waits, activeTabs, chrome, request, imports, analyses, P,
    hintBatches, storageData, storageCalls, sessionData, backgroundTimers,
    async runBackgroundTimers() {
      const pending = [...backgroundTimers.values()]; backgroundTimers.clear();
      for (const callback of pending) callback();
      await new Promise(resolve => setImmediate(resolve));
    } };
}

test('MV3 package has minimal permissions, local assets, ordered scripts and strict CSP', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['activeTab','scripting','storage','offscreen']);
  assert.equal(manifest.minimum_chrome_version, '109');
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

test('extension metadata has complete English, Japanese and Simplified Chinese translations', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.default_locale, 'en');
  const fields = [manifest.name, manifest.description, manifest.action.default_title];
  assert.ok(fields.every(value => /^__MSG_\w+__$/.test(value)));
  for (const [locale, brand] of [['en', 'PageWander'], ['ja', '迷いページ'], ['zh_CN', '迷页']]) {
    const messages = JSON.parse(fs.readFileSync(path.join(root, `_locales/${locale}/messages.json`), 'utf8'));
    for (const value of fields) assert.ok(messages[value.slice(6, -2)]?.message.trim(), `${locale}: ${value}`);
    assert.ok(messages.extensionDescription.message.length <= 132, `${locale}: Chrome description limit`);
    assert.equal(messages.extensionName.message, brand);
    assert.equal(worker({}, {}, locale.replace('_', '-')).P.I18n.t('迷页'), brand);
    if (locale === 'en') assert.doesNotMatch(messages.extensionDescription.message, /[\u3400-\u9fff]/);
  }
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(root, '_locales/zh_TW/messages.json'), 'utf8')),
    JSON.parse(fs.readFileSync(path.join(root, '_locales/zh_CN/messages.json'), 'utf8')),
    'the Chinese regional fallback uses the same Simplified Chinese translation');
});

test('restricted-page popup loads CSP-safe scripts and follows the browser UI language', () => {
  const html = fs.readFileSync(path.join(root, 'src/unavailable.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\s+src="([^"]+)"\s+defer><\/script>/g)].map(match => match[1]);
  assert.deepEqual(scripts, ['content/i18n.js', 'unavailable.js']);
  assert.equal((html.match(/<script\b/g) || []).length, scripts.length, 'no inline script');
  for (const [locale, expectedLang] of [['zh-CN', 'zh-CN'], ['ja-JP', 'ja'], ['en-US', 'en'], ['fr-FR', 'en']]) {
    const elements = [...html.matchAll(/data-i18n="([^"]+)"/g)].map(match => ({ dataset: { i18n: match[1] }, textContent: '' }));
    assert.equal(elements.length, 6);
    const document = { documentElement: { lang: '' }, querySelectorAll: () => elements };
    const context = vm.createContext({ document, chrome: { i18n: { getUILanguage: () => locale } } });
    for (const file of scripts) vm.runInContext(fs.readFileSync(path.join(root, 'src', file), 'utf8'), context);
    assert.equal(document.documentElement.lang, expectedLang);
    for (const element of elements) {
      assert.ok(element.textContent.trim());
      if (expectedLang === 'zh-CN') assert.equal(element.textContent, element.dataset.i18n);
      else assert.notEqual(element.textContent, element.dataset.i18n, `${locale}: ${element.dataset.i18n}`);
      if (expectedLang === 'en') assert.doesNotMatch(element.textContent, /[\u3400-\u9fff]/);
    }
  }
});

test('release archive contains only installable assets and user documentation', { skip: process.platform !== 'win32' }, t => {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const fixtureRoot = fs.mkdtempSync(path.join(temporaryRoot, 'pagepath-release-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(fixtureRoot)), temporaryRoot, 'cleanup stays within the temporary directory');
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });
  const fixtureFiles = {
    'manifest.json': JSON.stringify({ version: '1.0.0', default_locale: 'en', name: '__MSG_extensionName__', description: '__MSG_extensionDescription__', background: { service_worker: 'src/background.js' }, icons: { 16: 'icons/icon16.png' } }),
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
    '_locales/translation-notes.md': 'Do not package translation notes',
  };
  for (const locale of ['en', 'ja', 'zh_CN', 'zh_TW']) {
    fixtureFiles[`_locales/${locale}/messages.json`] = fs.readFileSync(path.join(root, `_locales/${locale}/messages.json`), 'utf8');
  }
  for (const [relativePath, contents] of Object.entries(fixtureFiles)) {
    const destination = path.join(fixtureRoot, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
  }
  fs.mkdirSync(path.join(fixtureRoot, 'scripts'));
  const packageScript = path.join(fixtureRoot, 'scripts/package.ps1');
  fs.copyFileSync(path.join(root, 'scripts/package.ps1'), packageScript);
  const archivePath = path.join(fixtureRoot, 'dist/Miye-v1.0.0.zip');
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
    '_locales/en/messages.json', '_locales/ja/messages.json', '_locales/zh_CN/messages.json', '_locales/zh_TW/messages.json',
  ].sort());
  assert.equal(fs.readFileSync(path.join(fixtureRoot, 'dist/old-release.zip'), 'utf8'), fixtureFiles['dist/old-release.zip']);
  assert.ok(!fs.readdirSync(path.join(fixtureRoot, 'dist')).some(name => name.endsWith('.tmp')));
  fs.writeFileSync(path.join(fixtureRoot, '_locales/ja/messages.json'), '{}');
  const incomplete = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', packageScript], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  assert.notEqual(incomplete.status, 0, 'incomplete locales must fail before creating a release');
  assert.match(incomplete.stderr, /Missing locale message/);
});

test('toolbar injects locally into the top frame isolated world', async () => {
  const { handlers, injections, calls, imports } = worker();
  await handlers.click({ id: 7, url: 'https://example.com/article' });
  assert.equal(injections.length, 1);
  assert.equal(injections[0].world, 'ISOLATED');
  assert.deepEqual(Array.from(injections[0].target.frameIds), [0]);
  assert.equal(injections[0].files.at(-1), 'src/content/index.js');
  assert.equal(injections[0].files[0], 'src/content/i18n.js');
  assert.ok(injections[0].files.indexOf('src/content/pageSnapshot.js') < injections[0].files.indexOf('src/content/game.js'));
  for (const file of injections[0].files) assert.ok(fs.existsSync(path.join(root,file)));
  assert.ok(injections[0].files.includes('src/content/mapCodec.js'));
  assert.ok(injections[0].files.includes('src/content/compactDom.js'));
  assert.equal(injections[0].files[injections[0].files.indexOf('src/content/scoring.js') + 1], 'src/content/progression.js');
  assert.ok(!injections[0].files.some(file => /obstacleDetector|pageAnalyzer/.test(file)), 'legacy DOM obstacle discovery is no longer injected');
  assert.ok(!injections[0].files.some(file => /opencv|imageMapAnalyzer/i.test(file)), 'webpages receive cached maps, not WASM');
  assert.ok(imports.includes('../vendor/opencv/opencv.js'));
  assert.equal(imports[0], 'content/i18n.js');
  assert.ok(imports.includes('content/imageMapAnalyzer.js'));
  assert.ok(imports.includes('content/compactMask.js'));
  assert.ok(imports.includes('content/scoring.js'));
  assert.ok(imports.includes('content/progression.js'));
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

test('browser action titles use the UI locale and retain localized defaults after navigation', async () => {
  for (const [locale, resource] of [['zh-CN', 'zh_CN'], ['ja-JP', 'ja'], ['en-US', 'en'], ['de-DE', 'en']]) {
    const { handlers, calls } = worker({}, {}, locale);
    const messages = JSON.parse(fs.readFileSync(path.join(root, `_locales/${resource}/messages.json`), 'utf8'));
    await handlers.click({ id: 7, url: 'https://example.com/article' });
    assert.ok(calls.some(([type, data]) => type === 'setTitle' && data.title === messages.extensionActionTitle.message), locale);
    await handlers.click({ id: 9, url: 'chrome://extensions' });
    const restricted = calls.filter(([type, data]) => type === 'setTitle' && data.tabId === 9).at(-1)[1].title;
    assert.ok(restricted.trim());
    if (resource === 'en') assert.doesNotMatch(restricted, /[\u3400-\u9fff]/);
    if (resource === 'ja') assert.match(restricted, /[\u3040-\u30ff]/);
    handlers.update(9, { status: 'loading' });
    const reset = calls.filter(([type, data]) => type === 'setTitle' && data.tabId === 9).at(-1)[1].title;
    assert.equal(reset, messages.extensionActionTitle.message);
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
  const { handlers, calls, chrome } = worker();
  handlers.message({ type: 'PAGEPATH_CLOSED' }, { id: chrome.runtime.id, frameId: 0,
    tab: { id: 8, url: 'https://example.com/' }, url: 'https://example.com/' });
  assert.ok(calls.some(([type, data]) => type === 'setBadgeText' && data.tabId === 8 && data.text === ''));
});

test('capture restores the generating controls after PNG acquisition and before analysis', async () => {
  const w = worker();
  const notifications = [];
  w.chrome.tabs.sendMessage = async (tabId, message, target) => {
    assert.equal(w.captures.length, 1);
    assert.equal(w.analyses.length, 0, 'the spinner and exit return before heavy OpenCV analysis');
    notifications.push({ tabId, message, target });
  };
  const response = await w.request({ documentId: 'document-7' }, { captureId: 'capture-id' });
  assert.equal(response.ok, true);
  assert.equal(notifications[0].tabId, 7);
  assert.equal(notifications[0].message.type, 'PAGEPATH_CAPTURE_READY');
  assert.equal(notifications[0].message.captureId, 'capture-id');
  assert.equal(notifications[0].target.documentId, 'document-7');
});

test('closing, navigation and tab removal forward generation cancellation', () => {
  const w = worker(), cancelled = [];
  w.chrome.runtime.sendMessage = async message => { cancelled.push(message); };
  w.handlers.message({ type: 'PAGEPATH_CLOSED' }, { id: w.chrome.runtime.id, frameId: 0,
    tab: { id: 7, url: 'https://example.com/' }, url: 'https://example.com/', documentId: 'old-document' });
  w.handlers.update(8, { status: 'loading' });
  w.handlers.remove(9);
  assert.ok(cancelled.some(message => message.type === 'PAGEPATH_OFFSCREEN_CANCEL_OWNER' && message.owner.documentId === 'old-document'));
  assert.ok(cancelled.some(message => message.type === 'PAGEPATH_OFFSCREEN_CANCEL_TAB' && message.tabId === 8));
  assert.ok(cancelled.some(message => message.type === 'PAGEPATH_OFFSCREEN_CANCEL_TAB' && message.tabId === 9));
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

const PROFILE_KEY = 'pagepath.progress.v3';
const completion = (runId, difficulty = 40) => ({ type: 'PAGEPATH_COMPLETE', runId,
  level: { difficulty, challenge: { complexity: difficulty / 100 } },
  stats: { collectedXp: 0, collectedCount: 0, multiplier: 1 } });
const profileMessage = { type: 'PAGEPATH_PROFILE' };

test('progression persists across webpages and worker restarts without retaining page data', async () => {
  const w = worker();
  const initial = await w.request({}, profileMessage);
  assert.equal(initial.ok, true);
  assert.equal(initial.profile.level, 1);
  assert.equal(initial.profile.totalXp, 0);
  const message = completion('first-run');
  const first = await w.request({}, { ...message, score: 999999, xp: 999999 });
  const expected = w.P.Scoring.calculate(message.level, message.stats);
  assert.equal(first.ok, true);
  assert.equal(first.result.score, expected.score, 'worker computes points instead of trusting requested reward');
  assert.equal(first.result.xp, expected.xp);
  assert.equal(first.result.awarded, true);
  assert.equal(first.profile.totalXp, expected.xp);
  const other = { tab: { id: 8, windowId: 4, url: 'https://another.example/maze' }, url: 'https://another.example/maze' };
  assert.equal((await w.request(other, profileMessage)).profile.totalXp, expected.xp);
  const restarted = worker(w.storageData);
  assert.equal((await restarted.request({}, profileMessage)).profile.totalXp, expected.xp);
  assert.ok(w.storageData[PROFILE_KEY]);
  assert.deepEqual(Object.keys(w.storageData), [PROFILE_KEY]);
  assert.ok(!JSON.stringify(w.storageData).includes('https://'));
  assert.ok(!JSON.stringify(w.storageData).includes('data:image'));
});

test('simultaneous completions in different tabs accumulate every reward exactly once', async () => {
  const w = worker();
  const requests = Array.from({ length: 20 }, (_, i) => {
    const sender = i % 2 ? { tab: { ...w.activeTabs.get(4) }, url: w.activeTabs.get(4).url } : {};
    const message = completion(`parallel-${i}`, i * 5);
    return { sender, message, expected: w.P.Scoring.calculate(message.level, message.stats) };
  });
  const results = await Promise.all(requests.map(({ sender, message }) => w.request(sender, message)));
  assert.ok(results.every(result => result.ok && result.result.awarded));
  const view = (await w.request({}, profileMessage)).profile;
  assert.equal(view.wins, 20);
  assert.equal(view.totalXp, requests.reduce((sum, item) => sum + item.expected.xp, 0));
  assert.equal(view.totalScore, requests.reduce((sum, item) => sum + item.expected.score, 0));
  assert.equal(w.storageData[PROFILE_KEY].recentRuns.length, 20);
});

test('settlement accepts the full difficulty range without a mode and retains legacy receipt compatibility', async () => {
  const w = worker();
  for (const difficulty of [0, 20, 50, 80, 100]) {
    const message = completion(`difficulty-${difficulty}`, difficulty);
    const result = await w.request({}, message);
    assert.equal(result.ok, true);
    assert.equal(result.result.scoringDifficulty, difficulty);
    assert.ok(result.result.xp > 0);
  }
  const legacy = completion('without-complexity');
  delete legacy.level.challenge.complexity;
  const result = await w.request({}, legacy);
  assert.equal(result.ok, true);
  assert.equal(result.result.scoringDifficulty, legacy.level.difficulty);
});

test('worker awards collection XP and one multiplier without changing the difficulty score', async () => {
  const w = worker(), plain = completion('plain', 65), collected = completion('collected', 65);
  collected.stats = { collectedXp: 70, collectedCount: 3, multiplier: 5 };
  const a = await w.request({}, plain), b = await w.request({}, collected);
  assert.equal(a.result.score, 1900);
  assert.equal(b.result.score, a.result.score);
  assert.equal(b.result.baseXp, 190);
  assert.equal(b.result.xp, (190 + 70) * 5);
  assert.equal(b.profile.totalXp, a.result.xp + b.result.xp);
  for (const key of ['grade', 'efficiency', 'elapsedMs', 'targetTimeMs', 'distance', 'failures']) assert.equal(b.result[key], undefined);
});

test('duplicate completions are deduplicated while pending and after a worker restart', async () => {
  const w = worker(), message = completion('shared-run', 75);
  const results = await Promise.all(Array.from({ length: 8 }, () => w.request({}, message)));
  assert.ok(results.every(result => result.ok));
  assert.equal(results.filter(result => result.result.awarded).length, 1);
  assert.equal(results.reduce((total, result) => total + result.result.xp, 0), w.P.Scoring.calculate(message.level, message.stats).xp);
  const restarted = worker(w.storageData);
  const repeated = await restarted.request({}, message);
  assert.equal(repeated.ok, true);
  assert.equal(repeated.result.xp, 0);
  assert.equal(repeated.result.awarded, false);
  assert.equal(repeated.profile.wins, 1);
});

test('legacy local progress keeps XP and deduplication while dropping mode groups on the next save', async () => {
  const legacy = { version: 1, totalXp: 720, totalScore: 7200, totalRuns: 7, bestScore: 1700,
    modeBests: { normal: 1900, hell: 2300 },
    recentRuns: [{ id: 'already-won', mode: 'hell', difficulty: 75, score: 2300, xp: 230, elapsedMs: 50000 }] };
  const w = worker({ [PROFILE_KEY]: legacy });
  const loaded = await w.request({}, profileMessage);
  assert.equal(loaded.profile.totalXp, 720);
  assert.equal(loaded.profile.bestScore, 2300);
  const duplicate = await w.request({}, completion('already-won'));
  assert.equal(duplicate.result.awarded, false);
  assert.equal(duplicate.result.xp, 0);
  const next = await w.request({}, completion('new-win'));
  assert.equal(next.profile.totalXp, 720 + next.result.xp);
  assert.equal(next.profile.wins, 8);
  const saved = w.storageData[PROFILE_KEY];
  assert.equal(saved.version, 3);
  assert.equal(saved.modeBests, undefined);
  assert.ok(saved.recentRuns.every(run => !Object.hasOwn(run, 'mode')));
  assert.ok(saved.recentRuns.every(run => !Object.hasOwn(run, 'elapsedMs')));
  assert.equal(saved.recentRuns[0].id, 'already-won');
});

test('a transient storage failure automatically retries the received receipt before responding', async () => {
  const w = worker(), set = w.chrome.storage.local.set;
  let attempts = 0;
  w.chrome.storage.local.set = async values => {
    if (++attempts === 1) throw new Error('temporary storage failure');
    return set(values);
  };
  const result = await w.request({}, completion('automatic-retry'));
  assert.equal(result.ok, true);
  assert.equal(result.profile.wins, 1);
  assert.equal(attempts, 2);
  assert.ok(w.waits.includes(250));
  assert.equal(result.profileData.recentRuns[0].id, 'automatic-retry');
  assert.equal(result.profileData.totalXp, result.profile.totalXp);
});

test('receipts survive exhausted retries and the next profile request completes them without the game', async () => {
  const w = worker(), set = w.chrome.storage.local.set;
  w.chrome.storage.local.set = async () => { throw new Error('private storage implementation detail'); };
  const first = await w.request({}, completion('retry-this-run'));
  assert.equal(first.ok, false);
  assert.ok(!String(first.error).includes('private'));
  assert.equal(w.storageData[PROFILE_KEY], undefined);
  assert.equal(w.sessionData['pagepath.pending.v3'][0].runId, 'retry-this-run');
  w.chrome.storage.local.set = set;
  const recovered = await w.request({}, profileMessage);
  assert.equal(recovered.profile.wins, 1, 'no further completion message from the closed game is needed');
  const retry = await w.request({}, completion('retry-this-run'));
  assert.equal(retry.ok, true);
  assert.equal(retry.result.awarded, false);
  assert.equal(retry.result.xp, 0);
  assert.equal(retry.profile.wins, 1);
  const next = await w.request({}, completion('next-run'));
  assert.equal(next.ok, true);
  assert.equal(next.profile.wins, 2);
});

test('background retry credits a closed game after local storage recovers without any new requests', async () => {
  const w = worker(), set = w.chrome.storage.local.set, message = completion('closed-game');
  w.chrome.storage.local.set = async () => { throw new Error('temporary local storage outage'); };
  assert.equal((await w.request({}, message)).ok, false);
  assert.equal(w.backgroundTimers.size, 1);
  w.chrome.storage.local.set = set;
  await w.runBackgroundTimers();
  assert.equal(w.storageData[PROFILE_KEY].totalXp, w.P.Scoring.calculate(message.level, message.stats).xp);
  assert.equal(w.storageData[PROFILE_KEY].totalRuns, 1);
  assert.equal(w.sessionData['pagepath.pending.v3'].length, 0);
  assert.equal(w.backgroundTimers.size, 0);
});

test('worker restart restores unconfirmed session receipts and credits each only once', async () => {
  const w = worker(), message = completion('before-worker-suspension', 60);
  w.chrome.storage.local.set = async () => { throw new Error('storage temporarily unavailable'); };
  assert.equal((await w.request({}, message)).ok, false);
  w.backgroundTimers.clear(); // Simulate suspension: only browser storage survives.
  const restarted = worker(w.storageData, w.sessionData);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(restarted.backgroundTimers.size, 1);
  await restarted.runBackgroundTimers();
  assert.equal(restarted.storageData[PROFILE_KEY].totalRuns, 1);
  assert.equal(restarted.sessionData['pagepath.pending.v3'].length, 0);
  const duplicate = await restarted.request({}, message);
  assert.equal(duplicate.result.xp, 0);
  assert.equal(duplicate.profile.wins, 1);
});

test('legacy queued receipts migrate to base XP without retaining old timing or route telemetry', async () => {
  const legacy = { type: 'PAGEPATH_COMPLETE', runId: 'old-unconfirmed',
    level: { difficulty: 80, referenceLength: 1234, challenge: { complexity: 0.5, turns: 8, deadEnds: 12 } },
    stats: { elapsedMs: 50000, distance: 5678, failures: 15 } };
  const w = worker({}, { 'pagepath.pending.v3': [legacy] });
  const set = w.chrome.storage.local.set;
  w.chrome.storage.local.set = async () => { throw new Error('wait for local storage'); };
  assert.equal((await w.request({}, legacy)).ok, false);
  const queued = w.sessionData['pagepath.pending.v3'][0];
  // An already restored receipt is normalized before its next session mirror.
  const another = completion('new-unconfirmed');
  assert.equal((await w.request({}, another)).ok, false);
  const migrated = w.sessionData['pagepath.pending.v3'].find(receipt => receipt.runId === legacy.runId);
  assert.deepEqual(migrated.stats, { collectedXp: 0, collectedCount: 0, multiplier: 1 });
  assert.deepEqual(migrated.level, { difficulty: 80, challenge: { complexity: 0.5 } });
  assert.equal(queued.runId, legacy.runId);
  w.chrome.storage.local.set = set;
  const loaded = await w.request({}, profileMessage);
  assert.equal(loaded.profile.totalXp, 160 + w.P.Scoring.calculate(another.level, another.stats).xp);
  assert.equal(loaded.profile.wins, 2);
  const duplicate = await w.request({}, legacy);
  assert.equal(duplicate.result.xp, 0);
  assert.equal(duplicate.profile.wins, 2);
});

test('a temporarily unreadable session queue is not overwritten before old receipts can be merged', async () => {
  const old = completion('previous-worker'), current = completion('current-worker', 65);
  const w = worker({}, { 'pagepath.pending.v3': [old] }), get = w.chrome.storage.session.get;
  w.chrome.storage.session.get = async () => { throw new Error('session read temporarily unavailable'); };
  const fresh = await w.request({}, current);
  assert.equal(fresh.ok, true, 'new local persistence can proceed independently');
  assert.equal(w.sessionData['pagepath.pending.v3'].length, 1);
  assert.equal(w.sessionData['pagepath.pending.v3'][0].runId, old.runId);
  w.chrome.storage.session.get = get;
  const merged = await w.request({}, profileMessage);
  assert.equal(merged.profile.wins, 2);
  assert.equal(merged.profile.totalXp, w.P.Scoring.calculate(old.level, old.stats).xp + fresh.result.xp);
  assert.equal(w.sessionData['pagepath.pending.v3'].length, 0);
});

test('a profile read failure is contained and a later request can recover', async () => {
  const w = worker(), get = w.chrome.storage.local.get;
  w.chrome.storage.local.get = async () => { throw new Error('private storage detail'); };
  const first = await w.request({}, profileMessage);
  assert.equal(first.ok, false);
  assert.ok(!String(first.error).includes('private'));
  w.chrome.storage.local.get = get;
  assert.equal((await w.request({}, profileMessage)).ok, true);
  assert.equal((await w.request({}, completion('after-read-error'))).ok, true);
});

test('progression messages reject unrelated extensions, subframes and unsupported pages before storage access', async () => {
  for (const sender of [
    { id: 'other-extension' }, { frameId: 1 }, { frameId: undefined }, { tab: undefined },
    { tab: { id: -1, windowId: 3 } }, { url: 'chrome://settings' },
    { url: 'https://chromewebstore.google.com/detail/id' },
  ]) {
    for (const message of [profileMessage, completion('invalid-sender')]) {
      const w = worker();
      const result = await w.request(sender, message);
      assert.equal(result.ok, false);
      assert.equal(w.storageCalls.length, 0);
    }
  }
});

test('invalid settlement metrics and difficulty ranges never grant profile rewards', async () => {
  const base = completion('valid-id');
  const invalid = [
    { runId: '' }, { runId: 'x'.repeat(200) }, { runId: 'path/invalid' },
    { level: null }, { stats: null },
    { level: { ...base.level, difficulty: -0.01 } },
    { level: { ...base.level, difficulty: 100.01 } },
    { level: { ...base.level, difficulty: '40' } },
    { level: { ...base.level, difficulty: Infinity } },
    ...[-0.01, 1.01, NaN, Infinity, null, '0.5'].map(complexity => ({
      level: { ...base.level, challenge: { ...base.level.challenge, complexity } },
    })),
    { stats: { collectedXp: 10 } },
    { stats: { ...base.stats, collectedCount: 11 } },
    { stats: { ...base.stats, collectedCount: -1 } },
    { stats: { ...base.stats, collectedCount: 1.5 } },
    { stats: { ...base.stats, collectedXp: -10 } },
    { stats: { ...base.stats, collectedXp: Infinity } },
    { stats: { ...base.stats, collectedXp: 410, collectedCount: 10 } },
    { stats: { ...base.stats, collectedXp: 30, collectedCount: 1 } },
    { stats: { ...base.stats, collectedXp: 35, collectedCount: 2 } },
    ...[0, 4, 6, 7, 9, '2', Infinity].map(multiplier => ({ stats: { ...base.stats, multiplier } })),
  ];
  const w = worker();
  for (const override of invalid) {
    const result = await w.request({}, { ...base, ...override });
    assert.equal(result.ok, false, JSON.stringify(override));
  }
  assert.equal(w.storageData[PROFILE_KEY], undefined);
  assert.equal((await w.request({}, profileMessage)).profile.wins, 0);
});
