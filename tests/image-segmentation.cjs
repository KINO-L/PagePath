'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, before } = require('node:test');

const calls = Object.create(null);
let P;
before(async () => {
  const cv = require(path.join(__dirname, '../vendor/opencv/opencv.js'));
  await new Promise(resolve => {
    const ready = () => { delete cv.then; resolve(); };
    if (cv.Mat && cv.calledRun) ready();
    else cv.then(ready);
  });
  const observed = new Proxy(cv, { get(target, name) {
    const value = target[name];
    if (!['cvtColor', 'morphologyEx', 'distanceTransform', 'connectedComponentsWithStats'].includes(name)) return value;
    return (...args) => { calls[name] = (calls[name] || 0) + 1; return value.apply(target, args); };
  } });
  const context = vm.createContext({ setTimeout, DOMException, AbortController,
    CompressionStream, DecompressionStream, ReadableStream, TextEncoder, atob, btoa });
  for (const file of ['config', 'imageMapAnalyzer', 'mapCodec']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/content', `${file}.js`), 'utf8'), context);
  }
  P = context.__PAGEPATH__;
  P.OpenCV = { ready: async () => observed };
});

function picture(width = 320, height = 240, rgb = [255, 255, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { data.set(rgb, i); data[i + 3] = 255; }
  return { width, height, data };
}
function pixel(image, x, y, rgb) {
  if (x < 0 || x >= image.width || y < 0 || y >= image.height) return;
  image.data.set([...rgb, 255], (y * image.width + x) * 4);
}
function rect(image, x, y, width, height, rgb) {
  for (let yy = y; yy < y + height; yy++) for (let xx = x; xx < x + width; xx++) pixel(image, xx, yy, rgb);
}
const at = (map, x, y, field = 'walkableMask') => map[field][y * map.width + x];
const analyze = image => P.ImageMapAnalyzer.analyze(image);

test('real OpenCV handles light and dark blank viewports without inventing walls', async () => {
  for (const color of [[255, 255, 255], [36, 36, 36]]) {
    const map = await analyze(picture(320, 240, color));
    assert.equal(map.kind, 'pixel-mask');
    assert.equal(map.stats.obstaclePixels, 0);
    assert.equal(map.components.length, 1);
    assert.equal(at(map, 160, 120), 1);
    assert.equal(at(map, 2, 120), 0);
    assert.equal(at(map, 3, 120), 1);
    assert.equal(at(map, 160, 120, 'distanceMap'), 119.5);
  }
  for (const name of ['cvtColor', 'morphologyEx', 'distanceTransform', 'connectedComponentsWithStats']) {
    assert.ok(calls[name] > 0, `${name} must run in the actual OpenCV runtime`);
  }
});

test('nearby white, grey and dark cards keep their own backgrounds and text contours', async () => {
  const image = picture(480, 300);
  rect(image, 30, 40, 190, 210, [230, 230, 230]);
  rect(image, 260, 40, 190, 210, [30, 30, 30]);
  for (let n = 0; n < 9; n++) {
    rect(image, 50 + n * 16, 100, 4, 14, [35, 35, 35]);
    rect(image, 280 + n * 16, 100, 4, 14, [235, 235, 235]);
  }
  const map = await analyze(image);
  assert.ok(map.stats.backgroundRegions >= 3);
  for (const [x, y] of [[15, 150], [100, 180], [350, 180], [235, 180]]) assert.equal(at(map, x, y), 1);
  for (const [x, y] of [[260, 40], [449, 40], [260, 249], [449, 249]]) {
    assert.equal(at(map, x, y, 'obstacleMask'), 0, 'a flat card corner must not become a tiny false obstacle');
  }
  assert.equal(at(map, 51, 106, 'obstacleMask'), 1);
  assert.equal(at(map, 281, 106, 'obstacleMask'), 1);
  assert.equal(at(map, 57, 106, 'obstacleMask'), 0, 'glyph whitespace remains genuine whitespace');
  assert.equal(at(map, 50, 106), 0);
  assert.equal(at(map, 281, 106), 0);
});

test('smooth background gradients use nearby seed colors instead of a global color', async () => {
  const image = picture();
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const grey = Math.round(180 + x * 70 / (image.width - 1));
    pixel(image, x, y, [grey, grey, grey]);
  }
  rect(image, 140, 90, 5, 16, [30, 30, 30]);
  const map = await analyze(image);
  for (const x of [10, 80, 160, 240, 310]) assert.equal(at(map, x, 160), 1);
  assert.equal(at(map, 142, 98, 'obstacleMask'), 1);
  assert.ok(map.stats.obstacleRatio < 0.01);
});

test('saturated image subjects and neutral rounded silhouettes stay filled obstacles', async () => {
  const image = picture(420, 260);
  rect(image, 50, 70, 100, 120, [15, 150, 75]);
  for (let y = 60; y <= 180; y++) for (let x = 230; x <= 350; x++) {
    if ((x - 290) ** 2 + (y - 120) ** 2 <= 55 ** 2) pixel(image, x, y, [30, 30, 30]);
  }
  const map = await analyze(image);
  for (const [x, y] of [[90, 120], [290, 120], [285, 85]]) assert.equal(at(map, x, y, 'obstacleMask'), 1);
  assert.equal(at(map, 235, 65, 'obstacleMask'), 0, 'circle corners are not rectangularized');
  assert.equal(at(map, 210, 120), 1);
});

test('textured image content is foreground while nearby blank space is playable', async () => {
  const image = picture();
  for (let y = 60; y < 180; y++) for (let x = 100; x < 220; x++) {
    pixel(image, x, y, [30 + (x * 17 + y * 7) % 150, 20 + (x * 13 + y * 29) % 150, 30 + (x * 31 + y * 11) % 140]);
  }
  const map = await analyze(image);
  let hits = 0;
  for (let y = 65; y < 175; y++) for (let x = 105; x < 215; x++) hits += at(map, x, y, 'obstacleMask');
  assert.ok(hits / (110 * 110) > 0.97);
  assert.equal(at(map, 70, 120), 1);
});

test('only low-contrast thin decorative separators are ignored', async () => {
  const decoration = picture();
  rect(decoration, 0, 120, 320, 1, [210, 210, 210]);
  const ignored = await analyze(decoration);
  assert.equal(ignored.stats.decorativeLines, 1);
  assert.equal(ignored.stats.obstaclePixels, 0);
  assert.equal(ignored.components.length, 1);
  assert.equal(at(ignored, 160, 120), 1);

  const strong = picture();
  rect(strong, 0, 120, 320, 1, [40, 40, 40]);
  const barrier = await analyze(strong);
  assert.equal(barrier.stats.decorativeLines, 0);
  assert.equal(at(barrier, 160, 120, 'obstacleMask'), 1);
  assert.equal(barrier.components.length, 2);
  assert.notEqual(at(barrier, 160, 90, 'componentLabels'), at(barrier, 160, 150, 'componentLabels'));

  const thick = picture();
  rect(thick, 0, 120, 320, 7, [210, 210, 210]);
  const thickBarrier = await analyze(thick);
  assert.equal(thickBarrier.stats.decorativeLines, 0);
  assert.equal(at(thickBarrier, 160, 123, 'obstacleMask'), 1);
});

test('distance transform consistently closes too-narrow gaps and preserves wider gaps', async () => {
  for (const gap of [4, 6, 10]) {
    const image = picture();
    rect(image, 130, 50, 10, 140, [20, 20, 20]);
    rect(image, 140 + gap, 50, 10, 140, [20, 20, 20]);
    const map = await analyze(image);
    const middle = 140 + Math.floor((gap - 1) / 2);
    assert.equal(at(map, middle, 120), gap >= 6 ? 1 : 0, `${gap}px corridor`);
    for (let i = 0; i < map.walkableMask.length; i++) {
      assert.equal(map.walkableMask[i], map.distanceMap[i] > map.stats.walkableThreshold ? 1 : 0);
      if (map.walkableMask[i]) assert.equal(map.obstacleMask[i], 0);
    }
    assert.ok(Math.abs(map.stats.walkableThreshold - (2 + Math.SQRT1_2)) < 1e-6);
  }
});

test('cached contours are exact boundaries of the collision mask, including bucket indices', async () => {
  const image = picture();
  rect(image, 140, 80, 8, 45, [20, 20, 20]);
  const map = await analyze(image), { segments, buckets, bucketSize } = map.contours;
  assert.ok(segments.length > 0);
  const sample = (x, y) => x < 0 || x >= map.width || y < 0 || y >= map.height ? 0 : at(map, Math.floor(x), Math.floor(y));
  for (let i = 0; i < segments.length; i += 4) {
    const [x1, y1, x2, y2] = segments.slice(i, i + 4);
    assert.ok((x1 === x2) !== (y1 === y2));
    const x = (x1 + x2) / 2, y = (y1 + y2) / 2;
    assert.notEqual(sample(x + (x1 === x2 ? -0.1 : 0), y + (y1 === y2 ? -0.1 : 0)),
      sample(x + (x1 === x2 ? 0.1 : 0), y + (y1 === y2 ? 0.1 : 0)));
    assert.ok(buckets[`${Math.floor(x / bucketSize)},${Math.floor(y / bucketSize)}`].includes(i / 4));
  }
  const second = await analyze(image);
  assert.deepEqual(Buffer.from(map.obstacleMask), Buffer.from(second.obstacleMask));
  assert.deepEqual(Buffer.from(map.walkableMask), Buffer.from(second.walkableMask));
});

test('invalid, oversized, cancelled, and unavailable OpenCV inputs still fail explicitly', async () => {
  await assert.rejects(analyze({ width: 20, height: 20, data: new Uint8Array(2) }), /截图尺寸无效/);
  await assert.rejects(analyze({ width: 9000, height: 1000, data: { length: 36000000 } }), /视口过大/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(P.ImageMapAnalyzer.analyze(picture(), { signal: controller.signal }), { name: 'AbortError' });
  const runtime = P.OpenCV;
  try {
    P.OpenCV = { ready: async () => { throw new Error('OpenCV unavailable'); } };
    await assert.rejects(analyze(picture()), /OpenCV unavailable/);
  } finally { P.OpenCV = runtime; }
});

test('real OpenCV texture-only input returns a conservative complete map and survives codec transport', async () => {
  const beforeCalls = { ...calls }, texture = picture(103, 79);
  for (let y = 0; y < texture.height; y++) for (let x = 0; x < texture.width; x++) {
    pixel(texture, x, y, (x + y) % 3 ? [20, 80, 150] : [230, 190, 120]);
  }
  const map = await analyze(texture), pixels = texture.width * texture.height;
  assert.equal(map.kind, 'pixel-mask');
  assert.equal(map.stats.backgroundRegions, 0);
  assert.equal(map.stats.backgroundUnavailable, true);
  assert.equal(map.stats.decorativeLines, 0);
  assert.equal(map.stats.obstaclePixels, pixels);
  assert.equal(map.stats.obstacleRatio, 1);
  assert.equal(map.stats.obstacleComponentCount, 1);
  assert.equal(map.stats.walkablePixels, 0);
  assert.equal(map.stats.walkableRatio, 0);
  assert.equal(map.stats.componentCount, 0);
  assert.equal(map.components.length, 0);
  assert.equal(map.contours.segments.length, 0, 'no accessible collision boundary is invented');
  assert.equal(Object.keys(map.contours.buckets).length, 0);
  assert.ok(map.obstacleMask.every(value => value === 1), 'even edges remain original foreground');
  for (const field of ['walkableMask', 'distanceMap', 'componentLabels']) assert.ok(map[field].every(value => value === 0), field);
  for (const name of ['cvtColor', 'morphologyEx', 'distanceTransform', 'connectedComponentsWithStats']) {
    assert.ok(calls[name] > (beforeCalls[name] || 0), `${name} still runs in the real OpenCV pipeline`);
  }
  const packet = JSON.parse(JSON.stringify(await P.MapCodec.encode(map)));
  const decoded = await P.MapCodec.decode(packet);
  assert.equal(decoded.width, texture.width); assert.equal(decoded.height, texture.height);
  assert.equal(decoded.stats.backgroundUnavailable, true); assert.equal(decoded.stats.backgroundRegions, 0);
  assert.equal(decoded.components.length, 0); assert.equal(decoded.contours.segments.length, 0);
  for (const field of ['obstacleMask', 'walkableMask', 'distanceMap', 'componentLabels']) {
    assert.deepEqual(Array.from(decoded[field]), Array.from(map[field]), `${field} remains exact after Chrome JSON transport`);
  }
});
