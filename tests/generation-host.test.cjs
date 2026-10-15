const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function harness({ legacy = false, opening = null, closing = null } = {}) {
  const workers = [], timers = new Map(), calls = [];
  let present = false, listener, nextTimer = 0;
  const extensionURL = 'chrome-extension://pagepath-test/';
  const background = { id: 'pagepath-test', url: extensionURL + 'src/background.js' };
  class FakeWorker {
    constructor(url) { this.url = url; this.terminated = 0; workers.push(this); }
    postMessage(message) { this.request = message; }
    terminate() { this.terminated++; }
    complete(level = { marker: 'generated' }) { this.onmessage?.({ data: { ok: true, level } }); }
  }
  const chrome = {
    runtime: {
      id: 'pagepath-test', getURL: value => extensionURL + value,
      onMessage: { addListener: callback => { listener = callback; } },
      ...(!legacy ? { getContexts: async () => present ? [{ documentUrl: extensionURL + 'src/offscreen.html' }] : [] } : {}),
      sendMessage: message => {
        calls.push(message);
        if (!present) return Promise.reject(new Error('No receiving end'));
        return new Promise((resolve, reject) => {
          let responded = false;
          const result = listener(message, background, value => { responded = true; resolve(value); });
          if (result !== true && !responded) reject(new Error('No response'));
        });
      },
    },
    offscreen: {
      createDocument: async options => { calls.push({ create: options }); await opening?.promise; present = true; },
      closeDocument: async () => { calls.push({ close: true }); await closing?.promise; present = false; },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/offscreen.js'), 'utf8'), { chrome, Worker: FakeWorker, Map, Set });
  const P = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/generationHost.js'), 'utf8'), {
    __PAGEPATH__: P, chrome, TextEncoder, Map, Set, Date, Math,
    clients: { matchAll: async () => present ? [{ url: extensionURL + 'src/offscreen.html' }] : [] },
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const makeHost = () => P.GenerationHost.create({ supportedPage: url => /^(?:https?|file):/.test(url || '') });
  let host = makeHost();
  const sender = (tabId = 7, documentId = 'doc-a') => ({ id: chrome.runtime.id, frameId: 0,
    tab: { id: tabId, url: 'https://example.com/' }, url: 'https://example.com/', documentId });
  const message = (requestId = 'request-a') => ({ type: 'PAGEPATH_GENERATE', requestId, seed: 123,
    packet: { format: 'pagepath-pixel-map', version: 1, encoding: 'gzip-base64', width: 16, height: 16, payload: 'AAAA' },
    reservedRects: [], history: [] });
  const start = (request = message(), source = sender()) => new Promise(resolve => host.generate(request, source, resolve));
  const cancel = (requestId = 'request-a', source = sender()) => new Promise(resolve => host.cancel({ requestId }, source, resolve));
  async function runTimers(delay) {
    const selected = [...timers].filter(([, value]) => value.delay === delay);
    await Promise.all(selected.map(([id, value]) => { timers.delete(id); return value.callback(); }));
    await flush();
  }
  return { get host() { return host; }, chrome, workers, timers, calls, start, cancel, sender, message, runTimers, background,
    restartHost: () => { host = makeHost(); },
    sendDirect: (message, sender) => { let response; const keepAlive = listener(message, sender, value => { response = value; }); return { response, keepAlive }; } };
}

test('generation uses a dedicated local worker and closes its offscreen document after completion', async () => {
  const h = harness(), result = h.start();
  await flush();
  assert.equal(h.workers.length, 1);
  assert.equal(h.workers[0].url, 'mazeWorker.js');
  assert.equal(h.workers[0].request.seed, 123);
  assert.equal(h.calls.find(value => value.create).create.reasons[0], 'WORKERS');
  h.workers[0].complete();
  assert.equal((await result).level.marker, 'generated');
  assert.equal(h.workers[0].terminated, 1);
  await h.runTimers(1000);
  assert.equal(h.calls.filter(value => value.close).length, 1);
  assert.equal(h.timers.size, 0);
});

test('cancellation while offscreen creation is pending cannot start a late worker', async () => {
  const opening = deferred(), h = harness({ opening }), result = h.start();
  await flush();
  await h.cancel();
  assert.equal((await result).cancelled, true);
  const idle = h.runTimers(1000);
  opening.resolve(); await idle;
  assert.equal(h.workers.length, 0);
  assert.equal(h.calls.filter(value => value.close).length, 1);
});

test('cancellation terminates a busy worker immediately and ignores late completion', async () => {
  const h = harness(), result = h.start(); await flush();
  const worker = h.workers[0], late = worker.onmessage;
  await h.cancel();
  assert.equal(worker.terminated, 1);
  assert.equal((await result).cancelled, true);
  late({ data: { ok: true, level: { stale: true } } });
  assert.equal(worker.terminated, 1);
});

test('navigation and removal cancellation affect only their tab, including jobs in another document', async () => {
  const h = harness(), a = h.start(), b = h.start(h.message('request-b'), h.sender(8, 'doc-b'));
  await flush();
  assert.equal(h.calls.filter(value => value.create).length, 1, 'concurrent startup is serialized');
  h.host.cancelTab(7);
  assert.equal((await a).cancelled, true);
  assert.equal(h.workers[0].terminated, 1);
  assert.equal(h.workers[1].terminated, 0);
  await h.runTimers(1000);
  assert.equal(h.calls.filter(value => value.close).length, 0, 'another tab still owns a worker');
  h.host.cancelTab(8);
  assert.equal((await b).cancelled, true);
  assert.equal(h.workers[1].terminated, 1);
});

test('matching request ids in another document or tab cannot cancel the current document', async () => {
  const h = harness(), result = h.start(); await flush();
  await h.cancel('request-a', h.sender(7, 'another-document'));
  await h.cancel('request-a', h.sender(8));
  await h.cancel('another-request');
  assert.equal(h.workers[0].terminated, 0);
  h.workers[0].complete(); assert.equal((await result).ok, true);
});

test('a replacement request cancels only its previous owner and uses a fresh worker', async () => {
  const h = harness(), first = h.start(); await flush();
  const second = h.start(h.message('request-b')); await flush();
  assert.equal((await first).cancelled, true);
  assert.equal(h.workers[0].terminated, 1);
  assert.equal(h.workers[1].terminated, 0);
  h.workers[1].complete(); assert.equal((await second).ok, true);
});

test('new generation waits for an in-flight offscreen close before reopening', async () => {
  const closing = deferred(), h = harness({ closing }), first = h.start(); await flush();
  h.workers[0].complete(); await first;
  const idle = h.runTimers(1000); await flush();
  const second = h.start(h.message('request-b')); await flush();
  assert.equal(h.workers.length, 1);
  closing.resolve(); await idle; await flush();
  assert.equal(h.workers.length, 2);
  assert.equal(h.calls.filter(value => value.create).length, 2);
  h.workers[1].complete(); assert.equal((await second).ok, true);
});

test('older Chrome uses clients.matchAll without requiring runtime.getContexts', async () => {
  const h = harness({ legacy: true }), result = h.start(); await flush();
  h.workers[0].complete(); assert.equal((await result).ok, true);
});

test('unauthorized origins and malformed work are rejected before creating workers', async () => {
  const h = harness();
  for (const override of [{ id: 'other-extension' }, { frameId: 1 }, { frameId: undefined }, { tab: undefined },
    { tab: { id: -1 } }, { url: 'chrome://settings' }]) {
    assert.equal((await h.start(h.message(), { ...h.sender(), ...override })).ok, false);
  }
  for (const override of [{ seed: -1 }, { seed: 2 ** 32 }, { requestId: '' }, { packet: {} },
    { reservedRects: [{ x: NaN, y: 1, width: 3, height: 3 }] }, { history: Array(9).fill([]) }]) {
    assert.equal((await h.start({ ...h.message(), ...override })).ok, false);
  }
  assert.equal(h.calls.length, 0); assert.equal(h.workers.length, 0);
});

test('offscreen worker endpoint rejects content-script and unrelated-extension spoofing', async () => {
  const h = harness();
  const message = { target: 'pagepath-offscreen', type: 'PAGEPATH_OFFSCREEN_GENERATE', jobId: 'spoof' };
  for (const sender of [h.sender(), { id: 'other-extension' },
    { id: 'pagepath-test', url: 'chrome-extension://pagepath-test/src/unavailable.html' }]) {
    assert.equal(h.sendDirect(message, sender).response, undefined);
  }
  assert.equal(h.workers.length, 0);
});

test('worker faults and timeout terminate jobs and release pending responses', async () => {
  const h = harness(), fault = h.start(); await flush();
  h.workers[0].onerror({ preventDefault() {} });
  assert.equal((await fault).ok, false); assert.equal(h.workers[0].terminated, 1);
  const timed = h.start(h.message('timeout')); await flush();
  await h.runTimers(120000);
  assert.equal((await timed).ok, false); assert.equal(h.workers[1].terminated, 1);
});

test('cancellation after a background restart still releases the offscreen worker and document', async () => {
  const h = harness(), result = h.start(); await flush();
  h.restartHost();
  await h.cancel();
  assert.equal(h.workers[0].terminated, 1);
  assert.equal((await result).cancelled, true);
  await h.runTimers(1000);
  assert.ok(h.calls.some(value => value.close));
});

test('offscreen cancellation arriving before its generation message prevents late work', () => {
  const h = harness();
  h.sendDirect({ target: 'pagepath-offscreen', type: 'PAGEPATH_OFFSCREEN_CANCEL', jobId: 'cancel-first' }, h.background);
  const reply = h.sendDirect({ target: 'pagepath-offscreen', type: 'PAGEPATH_OFFSCREEN_GENERATE', jobId: 'cancel-first' }, h.background);
  assert.equal(reply.response.cancelled, true);
  assert.equal(h.workers.length, 0);
});
