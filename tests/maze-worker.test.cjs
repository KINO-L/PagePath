'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { Worker } = require('node:worker_threads');
const root = path.join(__dirname, '..');
const context = vm.createContext({ CompressionStream, DecompressionStream, ReadableStream, TextEncoder, atob, btoa,
  setTimeout, clearTimeout, performance });
for (const file of ['config', 'collision', 'mazeCleanup', 'mazeRoute', 'mazeConnectors', 'routeMazeGenerator',
  'mazeGenerator', 'levelGenerator', 'mapCodec', 'mazeTransport']) {
  vm.runInContext(fs.readFileSync(path.join(root, 'src/content', file + '.js'), 'utf8'), context);
}
const P = context.__PAGEPATH__, plain = value => JSON.parse(JSON.stringify(value));
function fixture(kind = 'blank', width = 480, height = 320) {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    mask[y * width + x] = kind === 'solid' ? 1 : kind === 'cards' ? Number(x % 158 < 120 && y % 116 < 84) : 0;
  }
  return P.MazeGeometry.rebuild({ width, height, obstacleMask: mask, stats: {} }, [], mask);
}
function geometry(level) {
  return Object.fromEntries(Object.entries(level).filter(([key]) =>
    !['analysis', 'obstacleIndex', 'mazeOriginalAnalysis', 'mazeSourceAnalysis'].includes(key)));
}
function sameMap(actual, expected) {
  for (const key of ['obstacleMask', 'walkableMask', 'distanceMap', 'componentLabels']) {
    assert.deepEqual(Buffer.from(actual[key].buffer, actual[key].byteOffset, actual[key].byteLength),
      Buffer.from(expected[key].buffer, expected[key].byteOffset, expected[key].byteLength), key);
  }
  assert.deepEqual(Array.from(actual.contours.segments), Array.from(expected.contours.segments));
  assert.deepEqual(plain(actual.stats), plain(expected.stats));
  assert.deepEqual(plain(actual.components), plain(expected.components));
}

// Execute the actual browser worker in a real, separate JS thread. Only the
// Web Worker host API is adapted; all shipped imports and message code run as-is.
function startWorker({ phases = false } = {}) {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
    globalThis.self = globalThis;
    globalThis.postMessage = data => parentPort.postMessage(data);
    globalThis.importScripts = (...files) => {
      for (const file of files) vm.runInThisContext(fs.readFileSync(path.join(workerData.root, 'src', file), 'utf8'), { filename: file });
    };
    vm.runInThisContext(fs.readFileSync(path.join(workerData.root, 'src/mazeWorker.js'), 'utf8'), { filename: 'mazeWorker.js' });
    if (workerData.phases) {
      const generator = globalThis.__PAGEPATH__.LevelGenerator;
      globalThis.__PAGEPATH__.LevelGenerator = { generate(...args) {
        postMessage({ phase: 'generating' }); return generator.generate(...args);
      } };
    }
    parentPort.on('message', data => self.onmessage({ data }));
    parentPort.postMessage({ phase: 'ready' });
  `, { eval: true, workerData: { root, phases } });
  const next = predicate => new Promise((resolve, reject) => {
    const onMessage = message => { if (predicate(message)) { cleanup(); resolve(message); } };
    const onError = error => { cleanup(); reject(error); };
    const cleanup = () => { worker.off('message', onMessage); worker.off('error', onError); };
    worker.on('message', onMessage); worker.on('error', onError);
  });
  return { worker, ready: next(message => message.phase === 'ready'), next,
    async request(data) { const response = next(message => typeof message.ok === 'boolean'); worker.postMessage(data); return response; } };
}

test('worker preserves the exact existing maze geometry, masks, rewards and difficulty for seeded page types', async t => {
  const client = startWorker(); t.after(() => client.worker.terminate()); await client.ready;
  for (const [kind, seed] of [['blank', 0], ['cards', 122773], ['solid', 0xffffffff]]) {
    const source = fixture(kind), reservedRects = [{ x: 6, y: 6, width: 220, height: 58 }];
    const history = [[{ x: 30, y: 90 }, { x: 420, y: 280 }]];
    const expected = P.LevelGenerator.generate(source, reservedRects, P.MazeTransport.random(seed), history);
    const request = { packet: await P.MapCodec.encode(source), reservedRects, history, seed };
    const result = await client.request(plain(request));
    assert.equal(result.ok, true, result.error);
    assert.ok(Buffer.byteLength(JSON.stringify(result.level)) < P.MazeTransport.maxBytes);
    const decoded = await P.MazeTransport.decode(plain(result.level), source);
    assert.deepEqual(plain(geometry(decoded)), plain(geometry(expected)), kind + ' geometry and rewards');
    sameMap(decoded.analysis, expected.analysis); sameMap(decoded.mazeSourceAnalysis, expected.mazeSourceAnalysis);
    assert.equal(decoded.maxInk, Infinity); assert.equal(decoded.mazeOriginalAnalysis, source);
    assert.equal(decoded.obstacleIndex.walkableMask, decoded.analysis.walkableMask);
    assert.equal(decoded.obstacleIndex.analysis, decoded.analysis);
    if (kind === 'blank') {
      const repeated = await client.request(request);
      assert.deepEqual(repeated, result, 'worker reuse with the same seed/history cannot leak previous generation state');
    }
  }
});

test('transport avoids duplicate base maps and restores exact identity tags after Chrome JSON serialization', async () => {
  const source = fixture(), generated = P.LevelGenerator.generate(source, [], P.MazeTransport.random(51));
  for (const [base, tag] of [[source, 'source'], [generated.analysis, 'final']]) {
    const packet = plain(await P.MazeTransport.encode({ ...generated, mazeSourceAnalysis: base }));
    assert.equal(packet.base, tag);
    for (const key of ['analysis', 'obstacleIndex', 'mazeOriginalAnalysis', 'mazeSourceAnalysis']) assert.equal(packet.metadata[key], undefined);
    const level = await P.MazeTransport.decode(packet, source);
    assert.equal(level.mazeSourceAnalysis, tag === 'source' ? source : level.analysis);
    assert.equal(level.maxInk, Infinity);
  }
});

test('transport rejects invalid metadata, dimensions and routes rather than returning a mismatched collision map', async () => {
  const source = fixture(), level = P.LevelGenerator.generate(source, [], P.MazeTransport.random(19));
  const packet = plain(await P.MazeTransport.encode(level));
  for (const change of [{ format: 'other' }, { version: 2 }, { width: 1 }, { base: 'unknown' },
    { metadata: { ...packet.metadata, maxInk: 100 } }, { metadata: { ...packet.metadata, stars: 8 } },
    { metadata: { ...packet.metadata, analysis: {} } }, { metadata: { ...packet.metadata, nodes: [] } },
    { metadata: { ...packet.metadata, referencePath: [{ x: -1, y: 0 }, ...packet.metadata.referencePath] } },
    { metadata: { ...packet.metadata, collectibles: [{ id: 'bad', kind: 'xp', value: 10, x: 0, y: -1, radius: 6 }] } }]) {
    await assert.rejects(P.MazeTransport.decode({ ...packet, ...change }, source), /地图暂未准备好/);
  }
  await assert.rejects(P.MazeTransport.decode(packet, { ...source, height: source.height + 1 }), /地图暂未准备好/);
  const brokenMap = { ...packet.analysis, byteLength: 1 };
  await assert.rejects(P.MazeTransport.decode({ ...packet, analysis: brokenMap }, source), /地图传输失败/);
  const oversized = { ...packet.analysis, payload: 'A'.repeat(31 * 1024 * 1024) };
  await assert.rejects(P.MazeTransport.decode({ ...packet, analysis: oversized, base: oversized }, source), /地图暂未准备好/,
    'the combined final and base maps must fit below the Chrome message budget, even when each map fits separately');
});

test('an aborted decode returns no level, including cancellation while the compressed map is being decoded', async () => {
  const source = fixture(), level = P.LevelGenerator.generate(source, [], P.MazeTransport.random(8));
  const packet = await P.MazeTransport.encode(level);
  const already = new AbortController(); already.abort();
  await assert.rejects(P.MazeTransport.decode(packet, source, { signal: already.signal }), { name: 'AbortError' });
  const pending = new AbortController();
  const decoding = P.MazeTransport.decode(packet, source, { signal: pending.signal });
  pending.abort();
  await assert.rejects(decoding, { name: 'AbortError' });
});

test('worker validates seed and requests and only exposes known user-facing errors', async t => {
  const client = startWorker(); t.after(() => client.worker.terminate()); await client.ready;
  const packet = await P.MapCodec.encode(fixture());
  for (const seed of [undefined, null, -1, 1.1, 0x100000000, '12']) {
    assert.deepEqual(await client.request({ packet, seed }), { ok: false, error: '地图暂未准备好，请刷新后重试' });
  }
  for (const request of [{ reservedRects: [{ x: NaN, y: 0, width: 50, height: 50 }] }, { history: [null] }]) {
    assert.deepEqual(await client.request({ packet, seed: 1, ...request }), { ok: false, error: '地图暂未准备好，请刷新后重试' });
  }
  const corrupt = await client.request({ seed: 1, packet: { ...packet, payload: '!!!!' } });
  assert.equal(corrupt.ok, false); assert.match(corrupt.error, /^地图传输失败：/);
});

test('a running high-resolution synchronous maze search can be terminated without blocking its host', async t => {
  const source = fixture('blank', 1920, 1080), packet = await P.MapCodec.encode(source);
  const client = startWorker({ phases: true }); t.after(() => client.worker.terminate()); await client.ready;
  let completed = false;
  client.worker.on('message', message => { if (message.ok) completed = true; });
  const generating = client.next(message => message.phase === 'generating');
  client.worker.postMessage({ packet, seed: 31 });
  await generating;
  let heartbeat = false;
  await new Promise(resolve => setTimeout(() => { heartbeat = true; resolve(); }, 10));
  assert.equal(heartbeat, true, 'host can render and handle input during the unchanged synchronous algorithm');
  await client.worker.terminate();
  assert.equal(completed, false, 'termination discards the active search instead of delivering a late maze');
});
