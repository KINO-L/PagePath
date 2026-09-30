'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const context = vm.createContext({});
for (const file of ['config', 'collision', 'grid', 'pathfinding', 'scoring', 'levelGenerator']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/content', `${file}.js`), 'utf8'), context);
}
const P = context.__PAGEPATH__;
const rect = (x, y, width, height) => ({ x, y, width, height });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const reserved = [rect(390, 12, 420, 46)];

function random(seed) {
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function hullArea(points) {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const hull = [];
  for (const point of sorted) {
    while (hull.length > 1 && cross(hull.at(-2), hull.at(-1), point) <= 0) hull.pop();
    hull.push(point);
  }
  const lowerLength = hull.length;
  for (let i = sorted.length - 2; i >= 0; i--) {
    while (hull.length > lowerLength && cross(hull.at(-2), hull.at(-1), sorted[i]) <= 0) hull.pop();
    hull.push(sorted[i]);
  }
  hull.pop();
  return Math.abs(hull.reduce((sum, point, i) => {
    const next = hull[(i + 1) % hull.length];
    return sum + point.x * next.y - point.y * next.x;
  }, 0)) / 2;
}

function realTurns(route) {
  let turns = 0;
  for (let i = 1; i < route.length - 1; i++) {
    const before = route[i - 1], at = route[i], after = route[i + 1];
    const incoming = distance(before, at), outgoing = distance(at, after);
    if (!incoming || !outgoing) continue;
    const cosine = ((at.x - before.x) * (after.x - at.x) +
      (at.y - before.y) * (after.y - at.y)) / incoming / outgoing;
    // Exclude near-straight grid artifacts: this counts turns of more than 30 degrees.
    if (cosine < Math.cos(Math.PI / 6)) turns++;
  }
  return turns;
}

function verifyPlayable(level, analysis, exclusions = []) {
  const C = P.Config;
  assert.ok(level.nodes.length >= C.MIN_NODES && level.nodes.length <= P.getMode('normal').maxNodes);
  const index = P.Collision.createIndex([...analysis.rects, ...exclusions]);
  let length = 0;
  for (let i = 1; i < level.referencePath.length; i++) {
    const a = level.referencePath[i - 1], b = level.referencePath[i];
    assert.equal(P.Collision.segmentHits(a, b, index, C.PLAYER_RADIUS), false,
      'the harder route must still clear every obstacle and reserved control');
    length += distance(a, b);
  }
  for (const [i, node] of level.nodes.entries()) {
    assert.equal(P.Collision.pointHits(node, index, C.NODE_CLEARANCE), false);
    assert.ok(level.referencePath.some(point => point.x === node.x && point.y === node.y),
      'the ink allowance must be based on a route that really visits every node');
    for (const other of level.nodes.slice(i + 1)) {
      assert.ok(distance(node, other) >= C.NODE_MIN_DISTANCE, 'hit targets must remain distinct');
    }
  }
  assert.ok(Math.abs(length - level.referenceLength) < 0.001);
  assert.ok(level.maxInk > length, 'the verified route needs drawing tolerance');
  assert.ok(Math.abs(level.maxInk / length - 1.15) < 1e-10,
    '萌新 must use the revised 15% spare ink allowance on its verified route');
  assert.equal(distance(level.referencePath[0], level.nodes[0]), 0);
  assert.equal(distance(level.referencePath.at(-1), level.nodes.at(-1)), 0);
}

function generateSeeds(analysis, exclusions, inspect) {
  const signatures = new Set();
  for (let seed = 1; seed <= 12; seed++) {
    const level = P.LevelGenerator.generate(analysis, exclusions, random(seed));
    verifyPlayable(level, analysis, exclusions);
    signatures.add(JSON.stringify(level.nodes));
    inspect(level, seed);
  }
  assert.ok(signatures.size >= 10, 'new maps should vary the actual node placement');
}

test('spacious pages require a two-dimensional tour with interior targets, 12 seeds', () => {
  const analysis = { width: 1200, height: 760, rects: [] };
  generateSeeds(analysis, reserved, level => {
    assert.ok(level.nodes.length >= 12, 'a spacious 萌新 map should reach the revised target count');
    assert.ok(hullArea(level.nodes) > analysis.width * analysis.height * 0.3,
      'targets must cover an area instead of clustering on one nearly straight shortest path');
    assert.ok(level.nodes.some(point => point.x > 240 && point.x < 960 && point.y > 152 && point.y < 608),
      'a tour around only the outer page border is not enough');
    assert.ok(realTurns(level.referencePath) >= 3, 'collecting the targets must involve real changes of direction');
  });
});

test('a central obstacle gets targets on every side instead of one easy bypass, 12 seeds', () => {
  const analysis = { width: 1200, height: 760, rects: [rect(400, 250, 400, 240)] };
  generateSeeds(analysis, reserved, level => {
    assert.ok(level.nodes.length >= 12);
    for (const [side, contains] of [
      ['left', point => point.x < 400], ['right', point => point.x > 800],
      ['above', point => point.y < 250], ['below', point => point.y > 490],
    ]) assert.ok(level.nodes.some(contains), `there must be a target ${side} of the obstacle`);
    assert.ok(hullArea(level.nodes) > analysis.width * analysis.height * 0.3);
    assert.ok(realTurns(level.referencePath) >= 3);
  });
});

test('card layouts send players through interior corridors in both directions, 12 seeds', () => {
  const analysis = { width: 1200, height: 760, rects: Array.from({ length: 6 }, (_, i) =>
    rect(100 + i % 3 * 350, 110 + Math.floor(i / 3) * 285, 270, 210)) };
  generateSeeds(analysis, reserved, level => {
    assert.ok(level.nodes.length >= 12);
    const columns = new Set(level.nodes.map(point => Math.min(2, Math.floor(point.x / 400))));
    const rows = new Set(level.nodes.map(point => Math.min(2, Math.floor(point.y / (760 / 3)))));
    assert.equal(columns.size, 3);
    assert.equal(rows.size, 3);
    assert.ok(level.nodes.some(point => point.x > 300 && point.x < 900 && point.y > 190 && point.y < 570),
      'at least one target should make an interior corridor matter');
    assert.ok(realTurns(level.referencePath) >= 4);
  });
});

test('a narrow reachable corridor keeps a safe playable fallback, 12 seeds', () => {
  const analysis = { width: 800, height: 760, rects: [rect(0, 0, 360, 760), rect(440, 0, 360, 760)] };
  generateSeeds(analysis, [], level => {
    assert.ok(level.nodes.every(point => point.x > 360 && point.x < 440));
  });
});

test('a small map that fits four spaced targets remains playable, 12 seeds', () => {
  const analysis = { width: 180, height: 180, rects: [] };
  // Variation is intentionally not required: fitting valid targets takes priority on a tiny map.
  for (let seed = 1; seed <= 12; seed++) {
    const level = P.LevelGenerator.generate(analysis, [], random(seed));
    verifyPlayable(level, analysis);
    assert.ok(hullArea(level.nodes) > 0, 'use the small available area rather than failing on a short diameter');
  }
});

test('the same seed reproduces a map, including its verified route and ink allowance', () => {
  const analysis = { width: 1200, height: 760, rects: [rect(400, 250, 400, 240)] };
  const first = P.LevelGenerator.generate(analysis, reserved, random(842));
  const second = P.LevelGenerator.generate(analysis, reserved, random(842));
  assert.deepEqual(first.nodes, second.nodes);
  assert.deepEqual(first.referencePath, second.referencePath);
  assert.equal(first.maxInk, second.maxInk);
});

test('large viewport generation keeps the route safe and grid work bounded', () => {
  const analysis = { width: 3840, height: 2160, rects: [rect(1300, 650, 1200, 800)] };
  for (const seed of [1, 19, 60]) {
    const level = P.LevelGenerator.generate(analysis, [], random(seed));
    verifyPlayable(level, analysis);
    assert.ok(level.grid.walkable.length <= P.Config.MAX_GRID_CELLS);
    assert.ok(level.nodes.length >= 12);
    assert.ok(hullArea(level.nodes) > analysis.width * analysis.height * 0.3);
  }
});
