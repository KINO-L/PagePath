'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const context = vm.createContext({});
for (const file of ['config', 'mazeCleanup']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/content', `${file}.js`), 'utf8'), context);
const P = context.__PAGEPATH__;
const rect = (x, y, width, height) => ({ x, y, width, height });

function fixture(rects, width = 180, height = 120) {
  const obstacleMask = new Uint8Array(width * height), walkableMask = new Uint8Array(width * height), distanceMap = new Float32Array(width * height);
  const threshold = 2 + Math.SQRT1_2;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let distance = Math.min(x + 0.5, y + 0.5, width - x - 0.5, height - y - 0.5);
    for (const r of rects) {
      const dx = Math.max(0, r.x - x, x - (r.x + r.width - 1)), dy = Math.max(0, r.y - y, y - (r.y + r.height - 1));
      distance = Math.min(distance, Math.hypot(dx, dy));
    }
    const at = y * width + x;
    obstacleMask[at] = distance === 0 ? 1 : 0;
    walkableMask[at] = distance > threshold ? 1 : 0;
    distanceMap[at] = distance;
  }
  return { kind: 'pixel-mask', width, height, obstacleMask, walkableMask, distanceMap,
    stats: { clearance: 2, walkableThreshold: threshold } };
}
function components(mask, width, connectivity = 8) {
  const seen = new Uint8Array(mask.length), sizes = [], height = mask.length / width;
  for (let first = 0; first < mask.length; first++) if (mask[first] && !seen[first]) {
    const queue = [first]; seen[first] = 1;
    for (let head = 0; head < queue.length; head++) {
      const at = queue[head], x = at % width, y = Math.floor(at / width);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy || connectivity === 4 && dx && dy || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
        const next = at + dy * width + dx;
        if (mask[next] && !seen[next]) { seen[next] = 1; queue.push(next); }
      }
    }
    sizes.push(queue.length);
  }
  return sizes.sort((a, b) => b - a);
}
const textCluster = (x, y) => [0, 1].flatMap(row => [0, 1, 2].map(column => rect(x + column * 7, y + row * 9, 4, 6)));

test('compact groups of separate tiny foreground become one obstacle without mutating analysis', () => {
  const originals = textCluster(30, 40), source = fixture(originals);
  const masks = [source.obstacleMask, source.walkableMask, source.distanceMap].map(a => a.slice());
  const result = P.MazeCleanup.merge(source), final = fixture([...originals, ...result.rects]);
  assert.equal(result.rects.length, 1);
  assert.equal(result.stats.componentsBefore, 6);
  assert.equal(result.stats.componentsAfter, 1);
  assert.equal(components(final.obstacleMask, final.width).length, 1);
  assert.equal(components(final.walkableMask, final.width, 4).length, 1);
  assert.ok(result.stats.addedPixels > 0);
  let added = 0;
  for (let i = 0; i < source.obstacleMask.length; i++) {
    assert.ok(final.obstacleMask[i] >= source.obstacleMask[i], 'cleanup never erases original foreground');
    added += final.obstacleMask[i] && !source.obstacleMask[i] ? 1 : 0;
  }
  assert.equal(added, result.stats.addedPixels);
  [source.obstacleMask, source.walkableMask, source.distanceMap].forEach((a, i) => assert.deepEqual(a, masks[i]));
});

test('large foreground keeps its original silhouette, with no replacement rectangle', () => {
  const originals = [rect(80, 20, 70, 60), rect(105, 80, 45, 20), ...textCluster(20, 40)], source = fixture(originals);
  const result = P.MazeCleanup.merge(source);
  assert.equal(result.rects.length, 1, 'only the small text cluster is merged');
  for (const r of result.rects) assert.ok(r.x + r.width < 80);
  const final = fixture([...originals, ...result.rects]);
  assert.equal(final.obstacleMask[90 * final.width + 85], 0, 'large foreground notch is not filled by a bounding box');
  assert.equal(final.obstacleMask[50 * final.width + 100], 1);
});

test('separate text groups remain separate and paragraph-length chains stay bounded', () => {
  const originals = [...textCluster(20, 30), ...textCluster(100, 30)], source = fixture(originals);
  const result = P.MazeCleanup.merge(source), final = fixture([...originals, ...result.rects]);
  assert.equal(result.rects.length, 2);
  assert.equal(components(final.obstacleMask, final.width).length, 2);
  assert.equal(final.obstacleMask[40 * final.width + 75], 0);
  const chain = Array.from({ length: 90 }, (_, i) => rect(20 + i * 7, 30, 4, 6));
  const bounded = P.MazeCleanup.merge(fixture(chain, 700, 90));
  assert.ok(bounded.rects.length > 1);
  for (const r of bounded.rects) assert.ok(r.width <= 72 && r.height <= 36 && r.width * r.height <= 1800);
});

test('a compact merge that would close the only narrow connection is rejected', () => {
  const originals = [rect(0, 0, 50, 120), rect(70, 0, 50, 120), rect(52, 54, 5, 6), rect(62, 54, 5, 6)];
  const source = fixture(originals, 120, 120);
  assert.equal(source.walkableMask[56 * source.width + 59], 1, 'the original central mouse passage exists');
  assert.equal(components(source.walkableMask, source.width, 4).length, 1);
  const unsafe = fixture([...originals, rect(52, 54, 15, 6)], 120, 120);
  assert.equal(components(unsafe.walkableMask, unsafe.width, 4).length, 2, 'the test genuinely exercises a severed passage');
  const result = P.MazeCleanup.merge(source);
  assert.equal(result.rects.length, 0);
  assert.equal(result.stats.skippedConnectivity, 1);
});

test('filling tiny background holes is allowed but wide sparse gaps are not', () => {
  const ring = [rect(30, 30, 3, 8), rect(37, 30, 3, 8), rect(33, 27, 4, 2), rect(33, 39, 4, 2)];
  const result = P.MazeCleanup.merge(fixture(ring));
  assert.equal(result.rects.length, 1);
  const sparse = P.MazeCleanup.merge(fixture([rect(20, 20, 1, 8), rect(26, 26, 1, 8)]));
  assert.equal(sparse.rects.length, 0);
  assert.equal(sparse.stats.skippedSparse, 1);
});

test('noise cleanup keeps long page corridors traversable', () => {
  const originals = [rect(0, 0, 171, 480), rect(235, 0, 171, 480), rect(469, 0, 171, 480)];
  for (const left of [181, 416]) for (let y = 12; y < 456; y += 24) originals.push(rect(left, y, 4, 6), rect(left + 7, y, 4, 6));
  const source = fixture(originals, 640, 480), result = P.MazeCleanup.merge(source);
  assert.ok(result.rects.length >= 30, 'small paired glyphs are cleaned throughout the screenshot');
  assert.equal(result.stats.componentsAfter, result.stats.componentsBefore - result.rects.length);
  const final = fixture([...originals, ...result.rects], 640, 480);
  assert.equal(components(final.walkableMask, final.width, 4).length, components(source.walkableMask, source.width, 4).length);
  assert.equal(components(final.obstacleMask, final.width).length, result.stats.componentsAfter);
  for (let y = 3; y < 477; y++) assert.equal(final.walkableMask[y * final.width + 218], 1);
});

test('invalid analysis and empty foreground are harmless, and overrides cannot enlarge merge limits', () => {
  assert.equal(P.MazeCleanup.merge(null).stats.invalidSource, true);
  assert.equal(P.MazeCleanup.merge(fixture([])).rects.length, 0);
  const source = fixture([rect(20, 30, 4, 6), rect(60, 30, 4, 6)]);
  assert.equal(P.MazeCleanup.merge(source, { maxGap: 1000, maxWidth: 1000 }).rects.length, 0);
});
