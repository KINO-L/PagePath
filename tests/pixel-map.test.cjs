'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const context = vm.createContext({});
for (const name of ['config', 'collision', 'grid', 'pathfinding', 'scoring', 'levelGenerator']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/content', `${name}.js`), 'utf8'), context);
}
const P = context.__PAGEPATH__;

function random(seed) {
  return () => {
    seed = Math.imul(seed, 1664525) + 1013904223 | 0;
    return (seed >>> 0) / 4294967296;
  };
}

// Geometry fixtures start with the already-cleared player-center mask. Image
// segmentation and Euclidean distance accuracy are tested by the image suite.
function map(width, height, isFree, clearance = 30) {
  const walkableMask = new Uint8Array(width * height);
  const obstacleMask = new Uint8Array(width * height);
  const distanceMap = new Float32Array(width * height);
  const componentLabels = new Int32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    walkableMask[i] = isFree(x, y) ? 1 : 0;
    obstacleMask[i] = 1 - walkableMask[i];
    distanceMap[i] = walkableMask[i] ? clearance : 0;
  }
  const components = [], queue = new Int32Array(width * height);
  for (let i = 0; i < walkableMask.length; i++) {
    if (!walkableMask[i] || componentLabels[i]) continue;
    const label = components.length + 1;
    let head = 0, tail = 1;
    queue[0] = i; componentLabels[i] = label;
    while (head < tail) {
      const at = queue[head++], x = at % width, y = Math.floor(at / width);
      for (const next of [x ? at - 1 : -1, x + 1 < width ? at + 1 : -1,
        y ? at - width : -1, y + 1 < height ? at + width : -1]) {
        if (next >= 0 && walkableMask[next] && !componentLabels[next]) {
          componentLabels[next] = label; queue[tail++] = next;
        }
      }
    }
    components.push({ label, area: tail });
  }
  return { kind: 'pixel-mask', width, height, maskWidth: width, maskHeight: height,
    obstacleMask, walkableMask, distanceMap, componentLabels, components, stats: {} };
}

// Small, independent boundary fixtures use one edge per free pixel face. The
// production analyzer may merge collinear runs; assertions compare their exact
// unit-edge geometry rather than requiring a particular contour representation.
function withContours(analysis) {
  const { width, height, walkableMask } = analysis;
  const lines = [], bucketSize = 4, buckets = Object.create(null);
  const free = (x, y) => x >= 0 && y >= 0 && x < width && y < height && walkableMask[y * width + x];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!free(x, y)) continue;
    if (!free(x, y - 1)) lines.push(x, y, x + 1, y);
    if (!free(x, y + 1)) lines.push(x, y + 1, x + 1, y + 1);
    if (!free(x - 1, y)) lines.push(x, y, x, y + 1);
    if (!free(x + 1, y)) lines.push(x + 1, y, x + 1, y + 1);
  }
  for (let i = 0; i < lines.length; i += 4) {
    for (let by = Math.floor(lines[i + 1] / bucketSize); by <= Math.floor(lines[i + 3] / bucketSize); by++) {
      for (let bx = Math.floor(lines[i] / bucketSize); bx <= Math.floor(lines[i + 2] / bucketSize); bx++) {
        (buckets[`${bx},${by}`] ||= []).push(i / 4);
      }
    }
  }
  analysis.contours = { segments: new Float32Array(lines), bucketSize, buckets };
  return analysis;
}

function edgeKey(x1, y1, x2, y2) {
  return `${x1},${y1}:${x2},${y2}`;
}

function unitEdges(contours) {
  const edges = new Set();
  assert.ok(contours && contours.segments, 'reachable boundaries must remain a contour index');
  for (let i = 0; i < contours.segments.length; i += 4) {
    const [ax, ay, bx, by] = Array.from(contours.segments.slice(i, i + 4));
    assert.ok([ax, ay, bx, by].every(Number.isInteger), 'filtering must keep exact pixel edges');
    assert.ok((ax === bx) !== (ay === by), 'edges must remain nonempty and axis aligned');
    if (ay === by) for (let x = Math.min(ax, bx); x < Math.max(ax, bx); x++) edges.add(edgeKey(x, ay, x + 1, ay));
    else for (let y = Math.min(ay, by); y < Math.max(ay, by); y++) edges.add(edgeKey(ax, y, ax, y + 1));
  }
  return edges;
}

function rectangleEdges(x, y, width, height) {
  const edges = new Set();
  for (let xx = x; xx < x + width; xx++) {
    edges.add(edgeKey(xx, y, xx + 1, y));
    edges.add(edgeKey(xx, y + height, xx + 1, y + height));
  }
  for (let yy = y; yy < y + height; yy++) {
    edges.add(edgeKey(x, yy, x, yy + 1));
    edges.add(edgeKey(x + width, yy, x + width, yy + 1));
  }
  return edges;
}

function ringMap(open = () => false) {
  return withContours(map(24, 24, (x, y) => {
    const ring = x >= 6 && x <= 17 && y >= 6 && y <= 17 && (x === 6 || x === 17 || y === 6 || y === 17);
    const island = x >= 11 && x <= 12 && y >= 11 && y <= 12;
    return !island && (!ring || open(x, y));
  }));
}

function assertContourBuckets(contours) {
  const { segments, bucketSize, buckets } = contours;
  const entries = new Set();
  for (const [key, indices] of Object.entries(buckets)) {
    const [bx, by] = key.split(',').map(Number);
    for (const index of indices) {
      assert.ok(Number.isInteger(index) && index >= 0 && index * 4 + 3 < segments.length, 'bucket must reference a retained segment');
      const [x1, y1, x2, y2] = Array.from(segments.slice(index * 4, index * 4 + 4));
      assert.ok(bx >= Math.floor(Math.min(x1, x2) / bucketSize) && bx <= Math.floor(Math.max(x1, x2) / bucketSize));
      assert.ok(by >= Math.floor(Math.min(y1, y2) / bucketSize) && by <= Math.floor(Math.max(y1, y2) / bucketSize));
      entries.add(`${key}:${index}`);
    }
  }
  for (let i = 0; i < segments.length; i += 4) {
    const [x1, y1, x2, y2] = Array.from(segments.slice(i, i + 4));
    for (let by = Math.floor(Math.min(y1, y2) / bucketSize); by <= Math.floor(Math.max(y1, y2) / bucketSize); by++) {
      for (let bx = Math.floor(Math.min(x1, x2) / bucketSize); bx <= Math.floor(Math.max(x1, x2) / bucketSize); bx++) {
        assert.ok(entries.has(`${bx},${by}:${i / 4}`), 'near-pointer lookup must find each retained edge');
      }
    }
  }
}

test('reachable contours hide an enclosed island and the inaccessible inner wall, preserving the exact exterior boundary', () => {
  const analysis = ringMap();
  assert.equal(analysis.components.length, 2);
  const visible = P.Collision.reachableContours(analysis, { x: 2.5, y: 2.5 });
  const expected = new Set([...rectangleEdges(0, 0, 24, 24), ...rectangleEdges(6, 6, 12, 12)]);
  assert.deepEqual(unitEdges(visible), expected);
  assert.ok(unitEdges(analysis.contours).has(edgeKey(11, 11, 12, 11)), 'the cached source still contains the enclosed island');
  assertContourBuckets(visible);
});

test('reachable contours retain the inner island when an actual walkable doorway connects the ring', () => {
  const analysis = ringMap((x, y) => x === 10 && y === 6);
  assert.equal(analysis.components.length, 1);
  const visible = P.Collision.reachableContours(analysis, { x: 2.5, y: 2.5 });
  assert.deepEqual(unitEdges(visible), unitEdges(analysis.contours));
  for (const edge of rectangleEdges(11, 11, 2, 2)) assert.ok(unitEdges(visible).has(edge));
  assertContourBuckets(visible);
});

test('reachable contours switch with the current starting component and never alter cached maps or contours', () => {
  const analysis = ringMap();
  const arrayNames = ['obstacleMask', 'walkableMask', 'distanceMap', 'componentLabels'];
  const before = Object.fromEntries(arrayNames.map(name => [name, analysis[name].slice()]));
  const sourceSegments = analysis.contours.segments.slice();
  const sourceBuckets = JSON.stringify(analysis.contours.buckets);
  const inside = P.Collision.reachableContours(analysis, { x: 8.5, y: 8.5 });
  assert.deepEqual(unitEdges(inside), new Set([...rectangleEdges(7, 7, 10, 10), ...rectangleEdges(11, 11, 2, 2)]));
  const outside = P.Collision.reachableContours(analysis, { x: 2.5, y: 2.5 });
  assert.deepEqual(unitEdges(outside), new Set([...rectangleEdges(0, 0, 24, 24), ...rectangleEdges(6, 6, 12, 12)]));
  assert.deepEqual(unitEdges(P.Collision.reachableContours(analysis, { x: 8.5, y: 8.5 })), unitEdges(inside));
  for (const name of arrayNames) assert.deepEqual(analysis[name], before[name], `${name} must not change when choosing display contours`);
  assert.deepEqual(analysis.contours.segments, sourceSegments);
  assert.equal(JSON.stringify(analysis.contours.buckets), sourceBuckets);
  assertContourBuckets(inside);
  assertContourBuckets(outside);
});

test('a visual slit excluded by clearance cannot reveal contours in an unreachable inner pocket', () => {
  const analysis = ringMap();
  // Raw screenshot foreground has a slit, but player-center clearance closes it.
  analysis.obstacleMask[6 * analysis.width + 10] = 0;
  analysis.distanceMap[6 * analysis.width + 10] = 1;
  const visible = P.Collision.reachableContours(analysis, { x: 2.5, y: 2.5 });
  assert.deepEqual(unitEdges(visible), new Set([...rectangleEdges(0, 0, 24, 24), ...rectangleEdges(6, 6, 12, 12)]));
  assert.equal(analysis.walkableMask[6 * analysis.width + 10], 0);
});

test('a corner-only gap cannot reveal an enclosed island across a diagonal connection', () => {
  const analysis = ringMap((x, y) => x === 6 && y === 6);
  assert.equal(analysis.components.length, 2);
  const visible = P.Collision.reachableContours(analysis, { x: 2.5, y: 2.5 });
  const edges = unitEdges(visible);
  for (const edge of rectangleEdges(11, 11, 2, 2)) assert.equal(edges.has(edge), false, 'diagonal touching is not player reachability');
  assert.ok(edges.has(edgeKey(7, 6, 8, 6)), 'reachable exterior ring remains visible');
  assert.ok(edges.has(edgeKey(6, 7, 7, 7)), 'the diagonal opening preserves its actual outside-facing edge');
  const inside = P.Collision.reachableContours(analysis, { x: 8.5, y: 8.5 });
  for (const edge of rectangleEdges(11, 11, 2, 2)) assert.ok(unitEdges(inside).has(edge));
  assertContourBuckets(visible);
});

test('pixel collision catches a one-pixel wall at any speed and applies clearance only once', () => {
  const analysis = map(300, 80, x => x !== 143);
  const index = P.Collision.createMaskIndex(analysis);
  assert.equal(index.walkableMask, analysis.walkableMask);
  assert.equal(P.Collision.segmentHits({ x: 1.5, y: 30.5 }, { x: 298.5, y: 30.5 }, index), true);
  assert.equal(P.Collision.segmentHits({ x: 298.5, y: 30.5 }, { x: 1.5, y: 30.5 }, index), true);
  for (const radius of [0, 1, 2, 14, 50]) {
    assert.equal(P.Collision.pointHits({ x: 142.5, y: 30.5 }, index, radius), false);
    assert.equal(P.Collision.segmentHits({ x: 142.5, y: 2.5 }, { x: 142.5, y: 77.5 }, index, radius), false);
  }
  assert.equal(P.Collision.segmentHits({ x: 143, y: 2.5 }, { x: 143, y: 77.5 }, index), true);
  assert.equal(P.Collision.segmentHits({ x: 144, y: 2.5 }, { x: 144, y: 77.5 }, index), true);
  assert.equal(P.Collision.pointHits({ x: NaN, y: 1 }, index), true);
  assert.equal(P.Collision.pointHits({ x: 0, y: 10 }, index), true);
  assert.equal(P.Collision.pointHits({ x: 300, y: 10 }, index), true);
});

test('supercover includes both sides of grid edges and all four pixels at a corner', () => {
  const index = P.Collision.createMaskIndex(map(9, 9, (x, y) => !(x === 4 && y === 3)));
  assert.equal(P.Collision.segmentHits({ x: 2.5, y: 2.5 }, { x: 6.5, y: 6.5 }, index), true);
  assert.equal(P.Collision.segmentHits({ x: 6.5, y: 6.5 }, { x: 2.5, y: 2.5 }, index), true);
  assert.equal(P.Collision.segmentHits({ x: 1.5, y: 4 }, { x: 7.5, y: 4 }, index), true);
  assert.equal(P.Collision.segmentHits({ x: 4, y: 1.5 }, { x: 4, y: 7.5 }, index), true);
  assert.equal(P.Collision.segmentHits({ x: 2.5, y: 2.5 }, { x: 4, y: 4 }, index), true);
  assert.equal(P.Collision.segmentHits({ x: 1.5, y: 4.01 }, { x: 7.5, y: 4.01 }, index), false);
  assert.equal(P.Collision.pointHits({ x: 4, y: 4 }, index), true);
});

test('supercover agrees with closed-square intersection over random subpixel motion', () => {
  const analysis = map(17, 13, (x, y) => (x * 3 + y * 7) % 11 > 1);
  const maskIndex = P.Collision.createMaskIndex(analysis);
  const walls = [];
  for (let y = 0; y < analysis.height; y++) for (let x = 0; x < analysis.width; x++) {
    if (!analysis.walkableMask[y * analysis.width + x]) walls.push({ x, y, width: 1, height: 1 });
  }
  const oracle = P.Collision.createIndex(walls);
  const rng = random(211);
  for (let i = 0; i < 1500; i++) {
    const a = { x: 0.1 + rng() * 16.8, y: 0.1 + rng() * 12.8 };
    const b = { x: 0.1 + rng() * 16.8, y: 0.1 + rng() * 12.8 };
    if (i % 3 === 0) a.x = 1 + i % 15;
    if (i % 5 === 0) b.y = 1 + i % 11;
    assert.equal(P.Collision.segmentHits(a, b, maskIndex), P.Collision.segmentHits(a, b, oracle, 0), JSON.stringify({ a, b }));
  }
});

test('compressed navigation preserves an off-grid one-pixel door and every graph edge is collision-safe', () => {
  const analysis = map(512, 320, (x, y) => x !== 255 || y === 157);
  const grid = P.Grid.buildMask(analysis);
  assert.equal(grid.components.length, 1);
  assert.equal(grid.walkableMask, analysis.walkableMask);
  assert.ok(grid.walkable.length < analysis.walkableMask.length / 8, 'navigation must be compressed, not a pixel BFS per landmark');
  const left = grid.candidateIds.find(id => grid.point(id).x < 100 && grid.point(id).y > 200);
  const right = grid.candidateIds.find(id => grid.point(id).x > 400 && grid.point(id).y < 100);
  const search = P.Pathfinding.breadthFirst(grid, left);
  assert.ok(Number.isFinite(search.distances[right]));
  const route = P.Pathfinding.simplify(P.Pathfinding.trace(search.parents, left, right).map(grid.point), grid.obstacleIndex);
  assert.ok(route.length > 2);
  for (let id = 0; id < grid.walkable.length; id++) for (const next of grid.neighbors(id)) {
    assert.equal(P.Collision.segmentHits(grid.point(id), grid.point(next), grid.obstacleIndex), false);
  }
  for (let i = 1; i < route.length; i++) {
    assert.equal(P.Collision.segmentHits(route[i - 1], route[i], grid.obstacleIndex), false);
  }
});

test('diagonally touching pixel regions remain disconnected', () => {
  const analysis = map(100, 100, (x, y) => x < 50 && y < 50 || x >= 50 && y >= 50);
  const grid = P.Grid.buildMask(analysis);
  assert.equal(grid.components.length, 2);
  const start = grid.components[0][0], other = grid.components[1][0];
  const search = P.Pathfinding.breadthFirst(grid, start);
  assert.equal(search.distances[other], Infinity);
  assert.equal(P.Collision.segmentHits({ x: 49.5, y: 49.5 }, { x: 50.5, y: 50.5 }, grid.obstacleIndex), true);
});

test('mask-generated reference routes collect every node with the same collision map and ink budget', () => {
  const analysis = map(960, 640, (x, y) =>
    !(x >= 300 && x < 305 && y !== 211) && !(x >= 650 && x < 655 && y !== 429));
  const reserved = [{ x: 350, y: 40, width: 260, height: 48 }];
  const before = analysis.walkableMask.slice();
  for (const mode of ['normal', 'hell', 'immortal']) for (const seed of [1, 7, 23]) {
    const level = P.LevelGenerator.generate(analysis, reserved, random(seed), mode);
    assert.equal(level.obstacleIndex.walkableMask, analysis.walkableMask);
    assert.ok(level.nodes.some(node => node.x < 300));
    assert.ok(level.nodes.some(node => node.x > 655));
    const collected = new Set([0]);
    let length = 0;
    for (let i = 1; i < level.referencePath.length; i++) {
      const a = level.referencePath[i - 1], b = level.referencePath[i];
      assert.equal(P.Collision.segmentHits(a, b, level.obstacleIndex), false);
      length += P.Collision.distance(a, b);
      for (const node of level.nodes) {
        if (P.Collision.segmentCircleEntry(a, b, node, P.Config.HIT_RADIUS) !== null) collected.add(node.id);
      }
    }
    assert.equal(collected.size, level.nodes.length);
    assert.ok(length <= level.maxInk);
    assert.ok(Math.abs(length - level.referenceLength) < 1e-8);
    const label = analysis.componentLabels[Math.floor(level.nodes[0].y) * analysis.width + Math.floor(level.nodes[0].x)];
    for (const node of level.nodes) {
      assert.equal(P.Collision.pointHits(node, level.obstacleIndex), false);
      assert.equal(analysis.componentLabels[Math.floor(node.y) * analysis.width + Math.floor(node.x)], label);
      assert.equal(node.x >= reserved[0].x - 14 && node.x <= reserved[0].x + reserved[0].width + 14 &&
        node.y >= reserved[0].y - 14 && node.y <= reserved[0].y + reserved[0].height + 14, false);
    }
  }
  assert.deepEqual(analysis.walkableMask, before, 'toolbar reservations must never mutate the collision mask');
  const index = P.Collision.createMaskIndex(analysis);
  assert.equal(P.Collision.segmentHits({ x: 350.5, y: 60.5 }, { x: 610.5, y: 60.5 }, index), false);
});

test('a traversable thin strip can generate a puzzle without an artificial node-clearance wall', () => {
  const analysis = map(720, 200, (_x, y) => y === 100, 3);
  const level = P.LevelGenerator.generate(analysis, [], random(9));
  assert.ok(level.nodes.length >= P.Config.MIN_NODES);
  assert.ok(level.nodes.every(node => node.y === 100.5));
  for (let i = 1; i < level.referencePath.length; i++) {
    assert.equal(P.Collision.segmentHits(level.referencePath[i - 1], level.referencePath[i], level.obstacleIndex), false);
  }
});

test('a larger cramped component cannot hide a smaller component that fits spaced checkpoints', () => {
  const analysis = map(720, 320, (x, y) =>
    x >= 40 && x < 90 && y >= 40 && y < 90 || x >= 200 && x < 650 && y === 180);
  assert.equal(analysis.components.length, 2);
  assert.ok(analysis.components[0].area > analysis.components[1].area);
  for (const seed of [1, 7, 23]) {
    const level = P.LevelGenerator.generate(analysis, [], random(seed));
    assert.ok(level.nodes.length >= P.Config.MIN_NODES);
    assert.ok(level.nodes.every(node => node.y === 180.5 && node.x >= 200));
    const labels = new Set(level.nodes.map(node =>
      analysis.componentLabels[Math.floor(node.y) * analysis.width + Math.floor(node.x)]));
    assert.equal(labels.size, 1, 'fallback must never mix disconnected components');
    for (let i = 1; i < level.referencePath.length; i++) {
      assert.equal(P.Collision.segmentHits(level.referencePath[i - 1], level.referencePath[i], level.obstacleIndex), false);
    }
  }
});

test('weighted navigation chooses physical distance rather than number of graph edges', () => {
  const graph = { weighted: true, walkable: new Uint8Array(4).fill(1),
    neighbors: id => [[1, 2], [0, 3], [0, 3], [1, 2]][id],
    edgeLength: (a, b) => a === 1 || b === 1 ? 100 : 2 };
  const result = P.Pathfinding.breadthFirst(graph, 0);
  assert.equal(result.distances[3], 4);
  assert.deepEqual(Array.from(P.Pathfinding.trace(result.parents, 0, 3)), [0, 2, 3]);
});

test('real OpenCV card-and-text masks generate compressed, collision-valid puzzles', async t => {
  const cv = require('../vendor/opencv/opencv.js');
  await new Promise(resolve => {
    const ready = () => { delete cv.then; resolve(); };
    if (cv.Mat && cv.calledRun) ready();
    else cv.then(ready);
  });
  const imageContext = vm.createContext({ setTimeout, DOMException });
  for (const file of ['config', 'imageMapAnalyzer']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/content', `${file}.js`), 'utf8'), imageContext);
  }
  imageContext.__PAGEPATH__.OpenCV = { ready: async () => cv };
  const width = 1200, height = 760, data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([245, 245, 245, 255], i);
  function rect(x, y, w, h, rgb) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      data.set([...rgb, 255], (yy * width + xx) * 4);
    }
  }
  rect(40, 80, 510, 570, [230, 230, 230]);
  rect(620, 80, 520, 570, [32, 32, 32]);
  for (let row = 0; row < 15; row++) for (let col = 0; col < 23; col++) {
    const rgb = row % 3 ? [55, 55, 55] : [100, 100, 100];
    rect(68 + col * 20, 115 + row * 32, 4 + col % 3, 13, rgb);
    rect(650 + col * 20, 115 + row * 32, 4 + col % 3, 13, [225, 225, 225]);
  }
  // A pale full-width divider must not split either card into graph components.
  rect(0, 700, width, 1, [220, 220, 220]);
  const started = performance.now();
  const analysis = await imageContext.__PAGEPATH__.ImageMapAnalyzer.analyze({ width, height, data });
  const analyzed = performance.now();
  const counts = [];
  for (const mode of ['normal', 'hell', 'immortal']) {
    const level = P.LevelGenerator.generate(analysis, [], random(147), mode);
    counts.push(level.grid.walkable.length);
    assert.ok(level.grid.walkable.length < analysis.walkableMask.length / 8);
    assert.ok(level.nodes.some(node => node.x > 620), 'dark card background is playable');
    for (let i = 1; i < level.referencePath.length; i++) {
      assert.equal(P.Collision.segmentHits(level.referencePath[i - 1], level.referencePath[i], level.obstacleIndex), false);
    }
  }
  t.diagnostic(`1200x760 OpenCV ${Math.round(analyzed - started)}ms; three modes ${Math.round(performance.now() - analyzed)}ms; graph nodes ${counts.join('/')}`);
});
