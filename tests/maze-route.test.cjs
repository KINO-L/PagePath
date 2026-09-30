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
test('solid foreground opens one declared narrow irregular path and preserves the original mask', () => {
  const map = source([[0, 0, 640, 480]]), before = map.obstacleMask.slice(), result = P.MazeRoute.plan(map, [], random(11), 6);
  extent(result, map); assert.deepEqual(map.obstacleMask, before); assert.equal(result.carvedPaths.length, 1);
  assert.equal(result.carvedPaths[0].radius, 16);
  assert.ok(result.meta.carvedPixels < map.width * map.height * 0.4);
  for (let at = 0; at < result.obstacleMask.length; at++) {
    if (result.obstacleMask[at]) continue;
    const x = at % map.width + 0.5, y = Math.floor(at / map.width) + 0.5, points = result.carvedPaths[0].points;
    const covered = points.slice(1).some((b, i) => { const a = points[i], dx = b.x - a.x, dy = b.y - a.y,
      t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(x - a.x - t * dx, y - a.y - t * dy) <= 16 + 1e-6; });
    assert.ok(covered);
  }
});
test('reserved toolbar is excluded from natural route endpoints', () => {
  const rects = [];
  for (let row = 0; row < 4; row++) for (let col = 0; col < 5; col++) rects.push([20 + col * 124, 18 + row * 116, 90, 80]);
  const map = source(rects), reserved = [{ x: 20, y: 18, width: 372, height: 48 }], result = P.MazeRoute.plan(map, reserved, random(15));
  extent(result, map);
  for (const p of [result.referencePath[0], result.referencePath.at(-1)]) assert.ok(p.x < 8 || p.x > 404 || p.y < 6 || p.y > 78);
});
test('relocated toolbar uses its actual clamped size and leaves both opened-route endpoints clear', () => {
  const map = source([[0, 0, 320, 300]], 320, 300),
    result = P.MazeRoute.plan(map, [{ x: 0, y: 0, width: 320, height: 300 }], random(11), 12);
  extent(result, map);
  const r = result.toolbarRect;
  assert.ok(r, 'an all-covering reservation needs a verified replacement position');
  assert.equal(r.width, Math.min(372, map.width - 20)); assert.equal(r.height, 48);
  assert.ok(r.x >= 6 && r.x <= map.width - r.width - 6);
  assert.ok(r.y >= 6 && r.y <= map.height - r.height - 6);
  for (const p of [result.referencePath[0], result.referencePath.at(-1)]) {
    assert.ok(p.x < r.x - 18 || p.x > r.x + r.width + 18 || p.y < r.y - 18 || p.y > r.y + r.height + 18,
      'neither endpoint is covered after positionToolbar applies the real CSS geometry');
  }
});
