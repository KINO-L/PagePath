'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const context = vm.createContext({});
for (const name of ['config', 'mazeConnectors']) vm.runInContext(
  fs.readFileSync(path.join(__dirname, '../src/content', `${name}.js`), 'utf8'), context);
const { MazeConnectors } = context.__PAGEPATH__;
const random = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
function source(width, height, rects) {
  const obstacleMask = new Uint8Array(width * height);
  for (const [left, top, w, h] of rects) for (let y = top; y < top + h; y++) {
    obstacleMask.fill(1, y * width + left, y * width + left + w);
  }
  return { width, height, obstacleMask, stats: { walkableThreshold: 2 + Math.SQRT1_2 } };
}
function distance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, q = dx * dx + dy * dy;
  const t = q ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / q)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
function audit(original, answer, result) {
  const { width, height } = original;
  const declared = new Uint8Array(width * height);
  for (const wall of result.wallSegments) {
    assert.equal(wall.width, 3);
    assert.ok(wall.points.length >= 2);
    assert.equal(wall.anchors.length, wall.kind === 'baffle' ? 1 : 2);
    for (const anchor of wall.anchors) {
      const x = Math.floor(anchor.x), y = Math.floor(anchor.y);
      assert.ok(original.obstacleMask[y * width + x] || x === 0 || y === 0 || x === width - 1 || y === height - 1,
        'every connector begins and ends on original foreground or the viewport');
    }
    // Independent exhaustive capsule rasterisation; diagonal bounding boxes
    // would add pixels outside this geometry and immediately fail this audit.
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = { x: x + 0.5, y: y + 0.5 };
      if (wall.points.some((b, i) => i && distance(p, wall.points[i - 1], b) <= 1.5 + 1e-8)) declared[y * width + x] = 1;
    }
  }
  let added = 0;
  for (let at = 0; at < declared.length; at++) {
    assert.equal(result.obstacleMask[at], original.obstacleMask[at] || declared[at], 'mask exactly matches declared thin strokes');
    if (result.obstacleMask[at] && !original.obstacleMask[at]) {
      added++;
      const p = { x: at % width + 0.5, y: Math.floor(at / width) + 0.5 };
      for (let i = 1; i < answer.length; i++) assert.ok(distance(p, answer[i - 1], answer[i]) > original.stats.walkableThreshold + 3,
        'the fixed answer retains clearance and hand movement allowance');
      for (const endpoint of [answer[0], answer.at(-1)]) assert.ok(Math.hypot(p.x - endpoint.x, p.y - endpoint.y) > 14,
        'the inkstone and paper retain room around them');
    }
  }
  assert.equal(added, result.meta.addedPixels);
  assert.equal(result.meta.connectors, result.wallSegments.length);
}

test('connects tiny islands at free angles while preserving a fixed answer', () => {
  const map = source(180, 150, [[70, 34, 1, 1], [95, 51, 14, 18], [122, 90, 15, 20], [47, 105, 12, 9]]);
  const before = new Uint8Array(map.obstacleMask);
  const answer = [{ x: 23.5, y: 19.5 }, { x: 23.5, y: 129.5 }];
  const result = MazeConnectors.plan(map, answer, random(21));
  assert.equal(result.meta.complete, true);
  assert.equal(result.meta.unresolvedComponents, 0);
  assert.ok(result.wallSegments.some(wall => wall.points.some((p, i) => i && p.x !== wall.points[i - 1].x && p.y !== wall.points[i - 1].y)),
    'the connectors are not restricted to horizontal and vertical bars');
  assert.ok(result.wallSegments.some(wall => wall.anchors.some(p => Math.floor(p.x) === 70 && Math.floor(p.y) === 34)),
    'a one-pixel island must not be lost between axis scan samples');
  audit(map, answer, result);
  assert.deepEqual(map.obstacleMask, before);
});

test('connectors may cross a gap longer than the obsolete 96 pixel limit', () => {
  const map = source(350, 310, [[170, 150, 9, 9]]);
  const answer = [{ x: 23.5, y: 30.5 }, { x: 23.5, y: 280.5 }];
  const result = MazeConnectors.plan(map, answer, random(9));
  assert.equal(result.meta.complete, true);
  assert.equal(result.wallSegments.length, 1);
  const wall = result.wallSegments[0];
  assert.ok(wall.points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - wall.points[i].x, p.y - wall.points[i].y), 0) > 96);
  audit(map, answer, result);
});

test('all viewport-touching foreground belongs to one exterior component', () => {
  const map = source(180, 150, [[0, 0, 60, 150], [120, 0, 60, 150]]);
  const answer = [{ x: 89.5, y: 20.5 }, { x: 89.5, y: 129.5 }];
  const result = MazeConnectors.plan(map, answer, random(1));
  assert.equal(result.meta.originalComponents, 1);
  assert.equal(result.meta.complete, true);
  assert.equal(result.wallSegments.length, 0, 'do not close the only existing corridor to join two parts of the same exterior');
  assert.deepEqual(Array.from(result.obstacleMask), Array.from(map.obstacleMask));
});

test('a winding answer gains one-ended diagonal baffles in an existing straight passage', () => {
  const map = source(180, 270, [[0, 0, 60, 270], [120, 0, 60, 270]]);
  const answer = [{ x: 89.5, y: 20.5 }, { x: 75.5, y: 65.5 }, { x: 103.5, y: 112.5 },
    { x: 75.5, y: 160.5 }, { x: 103.5, y: 207.5 }, { x: 89.5, y: 248.5 }];
  const result = MazeConnectors.plan(map, answer, random(7));
  assert.equal(result.meta.complete, true);
  assert.ok(result.meta.baffles >= 3, 'the answer must not simplify back to a straight line');
  assert.ok(result.wallSegments.every(wall => wall.kind === 'baffle' && wall.anchors.length === 1));
  assert.ok(result.wallSegments.some(wall => wall.points[0].x !== wall.points[1].x && wall.points[0].y !== wall.points[1].y));
  audit(map, answer, result);
});

test('reports a protected enclosure instead of cutting through the answer', () => {
  const map = source(160, 140, [[73, 63, 9, 9]]);
  const answer = [{ x: 50.5, y: 42.5 }, { x: 107.5, y: 42.5 }, { x: 107.5, y: 99.5 },
    { x: 50.5, y: 99.5 }, { x: 50.5, y: 50.5 }];
  const result = MazeConnectors.plan(map, answer, random(3));
  assert.equal(result.meta.complete, false);
  assert.ok(result.meta.unresolvedComponents > 0);
  audit(map, answer, result);
});

test('seeded maps are reproducible and invalid answers are rejected', () => {
  const map = source(130, 120, [[65, 42, 5, 5], [88, 79, 8, 8]]);
  const answer = [{ x: 20.5, y: 20.5 }, { x: 20.5, y: 98.5 }];
  const first = MazeConnectors.plan(map, answer, random(39));
  const second = MazeConnectors.plan(map, answer, random(39));
  assert.deepEqual(first.wallSegments, second.wallSegments);
  assert.deepEqual(first.obstacleMask, second.obstacleMask);
  assert.throws(() => MazeConnectors.plan(map, [{ x: NaN, y: 20 }, { x: 40, y: 60 }]), /有效/);
});
