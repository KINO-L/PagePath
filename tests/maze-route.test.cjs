const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({});
for (const file of ['config', 'collision', 'mazeRoute']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/content', file + '.js'), 'utf8'), context);
const P = context.__PAGEPATH__;
function random(seed) { return () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function source(rects, width = 640, height = 480) {
  const obstacleMask = new Uint8Array(width * height), distanceMap = new Float32Array(width * height), walkableMask = new Uint8Array(width * height);
  for (const [left, top, w, h] of rects) for (let y = Math.max(0, top); y < Math.min(height, top + h); y++)
    obstacleMask.fill(1, y * width + Math.max(0, left), y * width + Math.min(width, left + w));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let d = Math.min(x + 1, y + 1, width - x, height - y);
    for (const [left, top, w, h] of rects) d = Math.min(d, Math.hypot(Math.max(0, left - x, x - (left + w - 1)), Math.max(0, top - y, y - (top + h - 1))));
    const at = y * width + x; distanceMap[at] = obstacleMask[at] ? 0 : d; walkableMask[at] = distanceMap[at] > 2 + Math.SQRT1_2 ? 1 : 0;
  }
  return { kind: 'pixel-mask', width, height, maskWidth: width, maskHeight: height, obstacleMask, walkableMask, distanceMap,
    stats: { clearance: 2, walkableThreshold: 2 + Math.SQRT1_2 } };
}
function extent(result, map) {
  const p = result.referencePath, diagonal = Math.hypot(map.width, map.height);
  assert.ok(Math.hypot(p[0].x - p.at(-1).x, p[0].y - p.at(-1).y) >= Math.max(80, diagonal * 0.18));
  assert.ok(result.referenceLength >= Math.max(220, diagonal * 0.65));
  assert.ok(result.turns >= 4);
  for (const point of p) assert.ok(point.x >= 0 && point.x < map.width && point.y >= 0 && point.y < map.height);
}
test('answer uses the original card passages before any obstacle is opened', () => {
  const rects = [];
  for (let row = 0; row < 4; row++) for (let col = 0; col < 5; col++) rects.push([20 + col * 124, 18 + row * 116, 90, 80]);
  const map = source(rects), before = map.obstacleMask.slice(), result = P.MazeRoute.plan(map, [], random(19));
  extent(result, map); assert.equal(result.obstacleMask, undefined); assert.equal(result.carvedPaths, undefined);
  assert.deepEqual(map.obstacleMask, before);
  const index = P.Collision.createMaskIndex(map);
  for (let i = 1; i < result.referencePath.length; i++) assert.equal(P.Collision.segmentHits(result.referencePath[i - 1], result.referencePath[i], index), false);
});
test('wide straight native corridors receive an answer with local bends, without carving a full-page maze', () => {
  const map = source([[0, 0, 170, 480], [234, 0, 171, 480], [469, 0, 171, 480]]);
  const result = P.MazeRoute.plan(map, [], random(7)); extent(result, map);
  assert.equal(result.obstacleMask, undefined); assert.equal(result.meta.kind, 'native-corridor-route');
  const index = P.Collision.createMaskIndex(map);
  for (let i = 1; i < result.referencePath.length; i++) assert.equal(P.Collision.segmentHits(result.referencePath[i - 1], result.referencePath[i], index), false);
});
test('ordinary retries never excavate solid foreground without explicit forceOpen', () => {
  const map = source([[0, 0, 640, 480]]), before = map.obstacleMask.slice();
  assert.equal(P.MazeRoute.plan(map, [], random(11)), null);
  assert.equal(P.MazeRoute.plan(map, [], random(11), 99, { intensity: 1 }), null);
  assert.deepEqual(map.obstacleMask, before);
});
test('reserved toolbar is excluded from natural route endpoints', () => {
  const rects = [];
  for (let row = 0; row < 4; row++) for (let col = 0; col < 5; col++) rects.push([20 + col * 124, 18 + row * 116, 90, 80]);
  const map = source(rects), reserved = [{ x: 20, y: 18, width: 372, height: 48 }], result = P.MazeRoute.plan(map, reserved, random(15));
  extent(result, map);
  for (const p of [result.referencePath[0], result.referencePath.at(-1)]) assert.ok(p.x < 8 || p.x > 404 || p.y < 6 || p.y > 78);
});

test('explicit opening restores a narrow path without adding walls or changing untouched content', () => {
  const map = source([[0, 0, 640, 480]]), before = map.obstacleMask.slice();
  const route = P.MazeRoute.plan(map, [], random(29), 10, { intensity: .5, forceOpen: true });
  assert.ok(route); extent(route, map); assert.equal(route.meta.kind, 'opened-route');
  let removed = 0;
  for (let i = 0; i < before.length; i++) { assert.ok(route.obstacleMask[i] <= before[i], 'opening cannot add a shell or walls'); removed += before[i] && !route.obstacleMask[i]; }
  assert.equal(removed, route.meta.carvedPixels); assert.ok(removed > 0 && removed < before.length * .15);
  for (const p of [route.referencePath[0], route.referencePath.at(-1)]) {
    for (let y = Math.floor(p.y) - 12; y <= Math.floor(p.y) + 12; y++) for (let x = Math.floor(p.x) - 12; x <= Math.floor(p.x) + 12; x++) {
      if (Math.hypot(x + .5 - p.x, y + .5 - p.y) <= 12) assert.equal(route.obstacleMask[y * map.width + x], 0, 'endpoint has full icon clearance');
    }
  }
  assert.deepEqual(map.obstacleMask, before);
});
test('continuous intensity steers actual native route geometry without excavation', () => {
  const map = source([]), results = [];
  for (const intensity of [0, .25, .5, .75, 1]) {
    const route = P.MazeRoute.plan(map, [], random(31), 0, { intensity });
    assert.ok(route, String(intensity)); assert.equal(route.obstacleMask, undefined);
    assert.equal(route.meta.kind, 'native-corridor-route');
    for (const p of [route.referencePath[0], route.referencePath.at(-1)]) assert.ok(map.distanceMap[Math.floor(p.y) * map.width + Math.floor(p.x)] >= 12);
    for (let i = 1; i < route.referencePath.length; i++) assert.ok(Math.abs(route.referencePath[i].x - route.referencePath[i - 1].x) > 1 && Math.abs(route.referencePath[i].y - route.referencePath[i - 1].y) > 1, 'bends are diagonal');
    results.push(route);
  }
  assert.ok(new Set(results.map(route=>route.turns)).size >= 4, 'intermediate intensities create intermediate structures, not two hidden profiles');
  assert.ok(results.at(-1).turns > results[0].turns + 5);
  assert.ok(results.at(-1).referenceLength > results[0].referenceLength * 2);
  assert.ok(results[0].turns <= 2, 'the easiest maps permit one or two meaningful bends');
  assert.ok(results.at(-1).referencePath.length <= 25, 'high difficulty adds bounded irregular bends, not a room grid');
});

test('dense-page openings vary actual complexity and add single-ended foreground arms', () => {
  const map = source([[0, 0, 640, 480]]), routes = [];
  for (const intensity of [0, 1]) {
    const route = P.MazeRoute.plan(map, [], random(29), 0, { intensity, forceOpen: true });
    assert.ok(route); routes.push(route);
    assert.ok(route.meta.openedDeadEnds >= 0);
    assert.ok(route.meta.openedDeadEnds <= Math.round(intensity * 4));
    assert.equal(route.carvedPaths.length, route.meta.openedDeadEnds + 1);
    for (let i = 0; i < route.obstacleMask.length; i++) assert.ok(route.obstacleMask[i] <= map.obstacleMask[i]);
    for (const branch of route.carvedPaths.slice(1)) {
      assert.equal(branch.points.length, 2); assert.ok(branch.radius < route.carvedPaths[0].radius);
      assert.ok(route.referencePath.some(p => p.x === branch.points[0].x && p.y === branch.points[0].y));
      assert.ok(Math.hypot(branch.points[1].x - branch.points[0].x, branch.points[1].y - branch.points[0].y) >= 39);
    }
  }
  assert.ok(routes[1].turns > routes[0].turns);
  assert.ok(routes[1].referenceLength > routes[0].referenceLength * 1.25);
  assert.ok(routes[1].meta.openedDeadEnds > routes[0].meta.openedDeadEnds);
});
