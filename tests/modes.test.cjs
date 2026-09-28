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
const openPage = { width: 1200, height: 760, rects: [] };

function random(seed) {
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function verifyPlayable(level, analysis, exclusions = []) {
  const mode = P.getMode(level.mode);
  const inkMultiplier = P.getInkMultiplier(level.mode, level.nodes.length);
  assert.ok(level.nodes.length >= P.Config.MIN_NODES && level.nodes.length <= mode.maxNodes);
  assert.equal(level.inkMultiplier, inkMultiplier);
  assert.equal(level.trailLength, mode.trailLength);
  assert.equal(level.modeLabel, mode.label);
  assert.ok(Math.abs(level.maxInk / level.referenceLength - inkMultiplier) < 1e-10);
  const index = P.Collision.createIndex([...analysis.rects, ...exclusions]);
  let length = 0;
  for (let i = 1; i < level.referencePath.length; i++) {
    const a = level.referencePath[i - 1], b = level.referencePath[i];
    assert.equal(P.Collision.segmentHits(a, b, index, P.Config.PLAYER_RADIUS), false);
    length += distance(a, b);
  }
  for (const [i, node] of level.nodes.entries()) {
    assert.equal(P.Collision.pointHits(node, index, P.Config.NODE_CLEARANCE), false);
    assert.ok(level.referencePath.some(point => point.x === node.x && point.y === node.y));
    for (const other of level.nodes.slice(i + 1)) {
      assert.ok(distance(node, other) >= P.Config.NODE_MIN_DISTANCE);
    }
  }
  assert.ok(Math.abs(length - level.referenceLength) < 0.001);
  assert.equal(distance(level.referencePath[0], level.nodes[0]), 0);
  assert.equal(distance(level.referencePath.at(-1), level.nodes.at(-1)), 0);
  assert.ok(level.difficulty >= 0 && level.difficulty <= 100);
}

test('Normal, Hell and Immortal settings are separate, immutable, and have a safe default', () => {
  assert.equal(P.Config.DEFAULT_MODE, 'normal');
  assert.equal(P.getMode('normal').targetNodes, 10);
  assert.equal(P.getMode('normal').maxNodes, 12);
  assert.equal(P.getMode('normal').inkMultiplier, 1.22);
  assert.equal(P.getMode('hell').targetNodes, 14);
  assert.equal(P.getMode('hell').maxNodes, 16);
  assert.equal(P.getMode('hell').inkMultiplier, 1.1);
  assert.equal(P.getMode('hell').inkBaselineNodes, 5);
  assert.equal(P.getMode('hell').inkPerNode, 0.015);
  assert.equal(P.getMode('immortal').id, 'immortal');
  assert.equal(P.getMode('immortal').label, '神仙');
  assert.equal(P.getMode('immortal').targetNodes, 14);
  assert.equal(P.getMode('immortal').maxNodes, 16);
  assert.equal(P.getMode('immortal').inkMultiplier, 1.1);
  assert.equal(P.getMode('immortal').trailLength, 45);
  assert.notEqual(P.getMode('immortal'), P.getMode('hell'));
  for (const mode of ['normal', 'hell', 'immortal']) assert.equal(P.getMode(mode).trailLength, 45);
  for (const value of [P.Config, P.Config.MODES, P.getMode('normal'), P.getMode('hell'), P.getMode('immortal')]) {
    assert.equal(Object.isFrozen(value), true);
  }
  for (const unknown of [undefined, null, '', '__proto__', 'constructor', 'toString', 'IMMORTAL', 'impossible']) {
    assert.equal(P.getMode(unknown), P.getMode('normal'));
  }
});

test('Hell ink grows with actual target count while Normal and Immortal keep fixed allowances', () => {
  const expected = [[4, 1.1], [5, 1.1], [8, 1.145], [12, 1.205], [14, 1.235], [15, 1.25], [16, 1.265]];
  for (const [count, multiplier] of expected) {
    assert.ok(Math.abs(P.getInkMultiplier('hell', count) - multiplier) < 1e-12, `${count} targets need ${multiplier}x ink`);
  }
  let previous = 1.1;
  for (let count = 0; count <= 16; count++) {
    const current = P.getInkMultiplier('hell', count);
    assert.ok(current >= previous, 'adding a target can never lower the ink allowance');
    if (count > 5) assert.ok(Math.abs(current - previous - 0.015) < 1e-12);
    assert.equal(P.getInkMultiplier('normal', count), 1.22);
    assert.equal(P.getInkMultiplier('immortal', count), 1.1);
    previous = current;
  }
  assert.equal(P.getInkMultiplier('hell', -100), 1.1);
  assert.ok(Math.abs(P.getInkMultiplier('hell', 100) - 1.265) < 1e-12, 'caller-supplied counts cannot bypass the mode cap');
  assert.equal(P.getInkMultiplier('unknown', 16), 1.22);
});

test('Normal keeps 10–12 targets; Hell restores 14–16 with dynamic ink; Immortal keeps 14–16 and 10%', () => {
  const pages = [openPage,
    { width: 1200, height: 760, rects: [rect(400, 250, 400, 240)] },
    { width: 1200, height: 760, rects: Array.from({ length: 6 }, (_, i) =>
      rect(100 + i % 3 * 350, 110 + Math.floor(i / 3) * 285, 270, 210)) },
  ];
  for (const analysis of pages) for (let seed = 1; seed <= 8; seed++) {
    const normal = P.LevelGenerator.generate(analysis, reserved, random(seed));
    verifyPlayable(normal, analysis, reserved);
    assert.equal(normal.mode, 'normal');
    assert.ok(normal.nodes.length >= 10 && normal.nodes.length <= 12);
    for (const mode of ['hell', 'immortal']) {
      const level = P.LevelGenerator.generate(analysis, reserved, random(seed), mode);
      verifyPlayable(level, analysis, reserved);
      assert.equal(level.mode, mode);
      const inkMultiplier = P.getInkMultiplier(mode, level.nodes.length);
      assert.equal(level.maxInk, level.referenceLength * inkMultiplier);
      assert.ok(level.nodes.length >= 14 && level.nodes.length <= 16);
      assert.ok(level.nodes.length > normal.nodes.length);
    }
  }
});

test('Hell and Immortal fall back to the safe available targets on small and narrow pages', () => {
  const pages = [{ width: 180, height: 180, rects: [] },
    { width: 800, height: 760, rects: [rect(0, 0, 360, 760), rect(440, 0, 360, 760)] },
  ];
  const fallbackCounts = new Set();
  for (const mode of ['hell', 'immortal']) for (const analysis of pages) for (let seed = 1; seed <= 8; seed++) {
    const level = P.LevelGenerator.generate(analysis, [], random(seed), mode);
    verifyPlayable(level, analysis);
    assert.ok(level.nodes.length < 14);
    assert.equal(level.mode, mode);
    if (mode === 'hell') {
      fallbackCounts.add(level.nodes.length);
      const expected = 1.1 + Math.max(0, level.nodes.length - 5) * 0.015;
      assert.ok(Math.abs(level.inkMultiplier - expected) < 1e-12);
      assert.ok(level.inkMultiplier < P.getInkMultiplier('hell', 14), 'a fallback must use its real count instead of the configured target');
    }
  }
  assert.ok([...fallbackCounts].some(count => count <= 5) && [...fallbackCounts].some(count => count > 5),
    'small and narrow fixtures exercise both baseline and growing fallback budgets');
});

test('mode switches never change any profile or seed reproducibility', () => {
  const normal = P.LevelGenerator.generate(openPage, reserved, random(842), 'normal');
  const hell = P.LevelGenerator.generate(openPage, reserved, random(842), 'hell');
  const immortal = P.LevelGenerator.generate(openPage, reserved, random(842), 'immortal');
  const normalAgain = P.LevelGenerator.generate(openPage, reserved, random(842), 'normal');
  const hellAgain = P.LevelGenerator.generate(openPage, reserved, random(842), 'hell');
  const immortalAgain = P.LevelGenerator.generate(openPage, reserved, random(842), 'immortal');
  for (const [first, next] of [[normal, normalAgain], [hell, hellAgain], [immortal, immortalAgain]]) {
    assert.deepEqual(first.nodes, next.nodes);
    assert.deepEqual(first.referencePath, next.referencePath);
    assert.equal(first.maxInk, next.maxInk);
  }
  const unknown = P.LevelGenerator.generate(openPage, reserved, random(842), 'unknown');
  assert.equal(unknown.mode, 'normal');
  assert.deepEqual(unknown.nodes, normal.nodes);
});

test('the 16-node solver uses bounded work and improves an inefficient visit order', () => {
  const positions = [0, 15, 1, 14, 2, 13, 3, 12, 4, 11, 5, 10, 6, 9, 7, 8];
  let reads = 0;
  const lengths = positions.map(x => new Proxy(positions.map(y => Math.abs(x - y)), {
    get(target, key) {
      if (/^\d+$/.test(String(key))) reads++;
      assert.ok(reads < 500000, 'large routes must avoid exponential subset search');
      return Reflect.get(target, key);
    },
  }));
  const order = P.Pathfinding.shortestVisitOrder(lengths);
  assert.equal(new Set(order).size, 16);
  assert.deepEqual(Array.from(order).sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i));
  const length = order.slice(1).reduce((sum, at, i) => sum + lengths[order[i]][at], 0);
  assert.equal(length, 15, 'the staggered line should become a single efficient traversal');
});

test('large Hell maps keep 14–16 targets and remain within the grid cap', () => {
  const analysis = { width: 3840, height: 2160, rects: [rect(1300, 650, 1200, 800)] };
  const level = P.LevelGenerator.generate(analysis, [], random(19), 'hell');
  verifyPlayable(level, analysis);
  assert.ok(level.nodes.length >= 14 && level.nodes.length <= 16);
  assert.ok(level.grid.walkable.length <= P.Config.MAX_GRID_CELLS);
});

test('additional Immortal targets raise complexity without changing Normal ratings', () => {
  const grid = { walkableCount: 100, walkable: new Uint8Array(100), narrowRatio: 0 };
  assert.equal(P.Scoring.difficulty(openPage, grid, 10), 15);
  assert.equal(P.Scoring.difficulty(openPage, grid, 12), 20);
  assert.equal(P.Scoring.difficulty(openPage, grid, 16), 30);
});
