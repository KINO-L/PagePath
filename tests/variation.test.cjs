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
const rect = (x, y, width, height) => ({ x, y, width, height });
const reserved = [rect(254, 6, 692, 91)];
const pages = {
  spacious: { width: 1200, height: 760, rects: [] },
  cards: { width: 1200, height: 760, rects: Array.from({ length: 6 }, (_, i) =>
    rect(100 + i % 3 * 350, 110 + Math.floor(i / 3) * 285, 270, 210)) },
  article: { width: 1200, height: 760, rects: [
    rect(40, 150, 160, 510), rect(300, 150, 660, 52), rect(300, 242, 580, 70),
    rect(300, 350, 660, 84), rect(300, 478, 610, 84), rect(300, 608, 660, 64),
  ] },
};
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function random(seed) {
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Every new point is compared with its closest OLD position, never its old
// index. Reversing a route or exchanging start/finish therefore scores zero.
function placementDifference(current, previous) {
  const nearest = current.map(point => Math.min(...previous.map(other => distance(point, other))));
  return {
    mean: nearest.reduce((sum, value) => sum + value, 0) / nearest.length,
    moved48: nearest.filter(value => value >= 48).length / nearest.length,
    moved64: nearest.filter(value => value >= 64).length / nearest.length,
  };
}

function remember(history, level) {
  const points = Object.freeze(level.nodes.map(({ x, y }) => Object.freeze({ x, y })));
  return Object.freeze([...history, points].slice(-4));
}

function generate(analysis, exclusions, rng, mode, history) {
  const before = JSON.stringify(history);
  const level = P.LevelGenerator.generate(analysis, exclusions, rng, mode, history);
  assert.equal(JSON.stringify(history), before, 'generation must not edit its caller-owned history');
  return level;
}

function verifyPlayable(level, analysis, exclusions, mode) {
  const expectedInk = P.getInkMultiplier(mode, level.nodes.length);
  const index = P.Collision.createIndex([...analysis.rects, ...exclusions]);
  assert.equal(level.mode, mode);
  assert.ok(level.nodes.length >= P.Config.MIN_NODES && level.nodes.length <= P.getMode(mode).maxNodes);
  assert.equal(level.inkMultiplier, expectedInk);
  assert.ok(Math.abs(level.maxInk / level.referenceLength - expectedInk) < 1e-10);
  let length = 0;
  for (let i = 1; i < level.referencePath.length; i++) {
    const start = level.referencePath[i - 1], end = level.referencePath[i];
    assert.equal(P.Collision.segmentHits(start, end, index, P.Config.PLAYER_RADIUS), false,
      'varying placements must preserve every obstacle and toolbar exclusion');
    length += distance(start, end);
  }
  for (let i = 0; i < level.nodes.length; i++) {
    const node = level.nodes[i];
    assert.equal(P.Collision.pointHits(node, index, P.Config.NODE_CLEARANCE), false);
    assert.ok(level.referencePath.some(point => point.x === node.x && point.y === node.y),
      'the budget reference must really pass through every relocated target');
    for (const other of level.nodes.slice(i + 1)) {
      assert.ok(distance(node, other) >= P.Config.NODE_MIN_DISTANCE, 'targets cannot overlap to obtain variety');
    }
  }
  assert.ok(Math.abs(length - level.referenceLength) < 0.001);
  assert.equal(distance(level.referencePath[0], level.nodes[0]), 0);
  assert.equal(distance(level.referencePath.at(-1), level.nodes.at(-1)), 0);
  assert.ok(level.maxInk > length);
}

test('placement comparison rejects reordered copies and small coordinate jitter', () => {
  const points = [{ x: 40, y: 40 }, { x: 240, y: 40 }, { x: 240, y: 240 }, { x: 40, y: 240 }];
  assert.deepEqual(placementDifference([...points].reverse(), points), { mean: 0, moved48: 0, moved64: 0 });
  assert.equal(placementDifference(points.map(point => ({ x: point.x + 8, y: point.y })), points).moved48, 0);
  assert.equal(placementDifference(points.map(point => ({ x: point.x + 64, y: point.y })), points).moved64, 1);
});

for (const [name, analysis] of Object.entries(pages)) for (const mode of ['normal', 'hell', 'immortal']) {
  test(`${name} ${mode}: successive maps relocate most targets instead of reordering the same layout`, () => {
    for (const seed of [92142, 81083]) {
      const rng = random(seed);
      let history = Object.freeze([]);
      const differences = [];
      for (let map = 0; map < 8; map++) {
        const level = generate(analysis, reserved, rng, mode, history);
        verifyPlayable(level, analysis, reserved, mode);
        if (history.length) {
          const delta = placementDifference(level.nodes, history.at(-1));
          const detail = `${name} ${mode} seed ${seed} map ${map}: ${JSON.stringify(delta)}`;
          assert.ok(delta.moved48 > 0.5, `most nodes must move at least three grid cells; ${detail}`);
          assert.ok(delta.mean >= 60, `average visual relocation must be meaningful; ${detail}`);
          differences.push(delta);
          for (const previous of history) {
            assert.ok(placementDifference(level.nodes, previous).mean >= 24,
              'the next four maps should not cycle back to a recently used placement');
          }
        }
        history = remember(history, level);
      }
      const averageMoved64 = differences.reduce((sum, value) => sum + value.moved64, 0) / differences.length;
      assert.ok(averageMoved64 >= 0.6,
        `most nodes should move a full node-spacing across the sequence; ${name} ${mode} ${seed}: ${averageMoved64}`);
    }
  });
}

test('the recent four maps avoid repetition even when the random seed repeats', () => {
  for (const analysis of Object.values(pages)) for (const mode of ['normal', 'hell', 'immortal']) {
    let history = Object.freeze([]);
    for (let map = 0; map < 6; map++) {
      const level = generate(analysis, reserved, random(842), mode, history);
      verifyPlayable(level, analysis, reserved, mode);
      if (history.length) {
        const delta = placementDifference(level.nodes, history.at(-1));
        assert.ok(delta.moved48 > 0.5, `history must prevent same-seed lookalikes: ${mode} ${JSON.stringify(delta)}`);
        for (const previous of history) {
          assert.ok(placementDifference(level.nodes, previous).mean >= 24,
            'history must also reject layouts from two, three, and four maps ago');
        }
      }
      history = remember(history, level);
    }
  }
});

test('identical seed and immutable history reproduce nodes, reference route, and ink exactly', () => {
  for (const mode of ['normal', 'hell', 'immortal']) {
    let history = Object.freeze([]);
    const rng = random(12345);
    for (let map = 0; map < 4; map++) {
      history = remember(history, generate(pages.cards, reserved, rng, mode, history));
    }
    const first = generate(pages.cards, reserved, random(9876), mode, history);
    const second = generate(pages.cards, reserved, random(9876), mode, history);
    assert.deepEqual(first.nodes, second.nodes);
    assert.deepEqual(first.referencePath, second.referencePath);
    assert.equal(first.referenceLength, second.referenceLength);
    assert.equal(first.maxInk, second.maxInk);
    verifyPlayable(first, pages.cards, reserved, mode);
  }
});

test('history never sacrifices a safe fallback on tiny pages or narrow corridors', () => {
  const constrained = [
    { width: 180, height: 180, rects: [] },
    { width: 800, height: 760, rects: [rect(0, 0, 360, 760), rect(440, 0, 360, 760)] },
  ];
  for (const analysis of constrained) for (const mode of ['normal', 'hell', 'immortal']) {
    let history = Object.freeze([]);
    for (let map = 0; map < 6; map++) {
      const level = generate(analysis, [], random(407 + map), mode, history);
      verifyPlayable(level, analysis, [], mode);
      history = remember(history, level);
    }
  }
});

test('recent-layout avoidance includes the last four targets of a twenty-node map', () => {
  const analysis = pages.spacious;
  // A full-sized previous layout: all twenty points fit with real target
  // spacing, even if this new page's density asks for only eighteen targets.
  const previous = { nodes: Array.from({ length: 20 }, (_, i) => ({
    x: 120 + i % 5 * 220, y: 160 + Math.floor(i / 5) * 160,
  })) };
  const complete = remember([], previous);
  const truncated = Object.freeze([Object.freeze(complete[0].slice(0, 16))]);
  const fullHistoryMap = generate(analysis, reserved, random(842), 'immortal', complete);
  const oldLimitMap = generate(analysis, reserved, random(842), 'immortal', truncated);
  verifyPlayable(fullHistoryMap, analysis, reserved, 'immortal');
  assert.notDeepEqual(fullHistoryMap.nodes, oldLimitMap.nodes,
    'the final four previous positions must influence the next placement instead of being discarded');
});
