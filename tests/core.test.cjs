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
function random(seed) {
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

test('segments cannot tunnel through obstacles; tangent contact and line radius count', () => {
  const index = P.Collision.createIndex([{ x: 100, y: 100, width: 30, height: 60 }]);
  assert.equal(P.Collision.segmentHits({ x: 0, y: 120 }, { x: 300, y: 120 }, index, 0), true);
  assert.equal(P.Collision.segmentHits({ x: 0, y: 100 }, { x: 300, y: 100 }, index, 0), true);
  assert.equal(P.Collision.segmentHits({ x: 0, y: 97 }, { x: 300, y: 97 }, index, 3), true);
  assert.equal(P.Collision.segmentHits({ x: 0, y: 96 }, { x: 300, y: 96 }, index, 3), false);
  assert.equal(P.Collision.segmentHits({ x: 120, y: 0 }, { x: 120, y: 300 }, index), true);
  assert.equal(P.Collision.pointHits({ x: 115, y: 130 }, index), true);
  assert.equal(P.Collision.pointHits({ x: 10, y: 10 }, index), false);
  assert.equal(P.Collision.segmentHits({ x: NaN, y: 10 }, { x: 0, y: 0 }, index), true);
});

test('spatial hash agrees with full rectangle intersection across cell boundaries', () => {
  const rects = [{ x: 63, y: 62, width: 4, height: 4 }, { x: -20, y: 120, width: 160, height: 20 }];
  const small = P.Collision.createIndex(rects, 16);
  const large = P.Collision.createIndex(rects, 1024);
  const rng = random(921);
  for (let i = 0; i < 250; i++) {
    const a = { x: rng() * 200 - 30, y: rng() * 200 - 30 };
    const b = { x: rng() * 200 - 30, y: rng() * 200 - 30 };
    assert.equal(P.Collision.segmentHits(a, b, small), P.Collision.segmentHits(a, b, large));
  }
});

test('checkpoint hits include crossings, tangency, and an already collected position', () => {
  const center = { x: 50, y: 50 };
  assert.equal(P.Collision.segmentCircleEntry({ x: 0, y: 50 }, { x: 100, y: 50 }, center, 10), 0.4);
  assert.equal(P.Collision.segmentCircleEntry({ x: 0, y: 40 }, { x: 100, y: 40 }, center, 10), 0.5);
  assert.equal(P.Collision.segmentCircleEntry({ x: 50, y: 50 }, { x: 50, y: 50 }, center, 10), 0);
  assert.equal(P.Collision.segmentCircleEntry({ x: 0, y: 39 }, { x: 100, y: 39 }, center, 10), null);
  assert.equal(P.Collision.segmentCircleEntry({ x: 0, y: 0 }, { x: 0, y: 0 }, center, 10), null);
});

test('thin walls between grid centers cannot connect opposite components', () => {
  const grid = P.Grid.build(320, 240, [{ x: 63, y: 0, width: 1, height: 240 }]);
  assert.equal(grid.components.length, 2);
  for (let id = 0; id < grid.walkable.length; id++) {
    for (const next of grid.neighbors(id)) {
      assert.equal(P.Collision.segmentHits(grid.point(id), grid.point(next), grid.obstacleIndex), false);
    }
  }
});

const layouts = {
  blank: [],
  article: [
    { x: 200, y: 90, width: 730, height: 72 },
    ...Array.from({ length: 18 }, (_, i) => ({ x: 260, y: 200 + i * 23, width: 610 + i % 3 * 14, height: 17 })),
  ],
  github: [
    { x: 0, y: 0, width: 1200, height: 62 },
    { x: 28, y: 100, width: 180, height: 470 },
    { x: 276, y: 146, width: 690, height: 360 },
    { x: 1000, y: 100, width: 178, height: 290 },
  ],
  dashboard: Array.from({ length: 6 }, (_, i) => ({ x: 100 + i % 3 * 350, y: 110 + Math.floor(i / 3) * 285, width: 270, height: 210 })),
  ecommerce: Array.from({ length: 8 }, (_, i) => ({ x: 75 + i % 4 * 280, y: 90 + Math.floor(i / 4) * 300, width: 215, height: 235 })),
  spa: [
    { x: 0, y: 0, width: 1200, height: 64 },
    { x: 0, y: 64, width: 192, height: 696 },
    { x: 272, y: 130, width: 590, height: 350 },
    { x: 920, y: 180, width: 180, height: 400 },
  ],
};

function verifyLevel(level, analysis, reserved) {
  const C = P.Config;
  assert.ok(level.nodes.length >= C.MIN_NODES && level.nodes.length <= C.MAX_NODES);
  assert.equal(level.nodes[0].kind, 'start');
  assert.equal(level.nodes.at(-1).kind, 'finish');
  assert.equal(level.referencePath[0].x, level.nodes[0].x);
  assert.equal(level.referencePath[0].y, level.nodes[0].y);
  assert.equal(level.referencePath.at(-1).x, level.nodes.at(-1).x);
  assert.equal(level.referencePath.at(-1).y, level.nodes.at(-1).y);
  const index = P.Collision.createIndex([...analysis.rects, ...reserved]);
  let measured = 0;
  for (let i = 1; i < level.referencePath.length; i++) {
    const a = level.referencePath[i - 1], b = level.referencePath[i];
    assert.equal(P.Collision.segmentHits(a, b, index, C.PLAYER_RADIUS), false);
    measured += P.Collision.distance(a, b);
  }
  for (let i = 0; i < level.nodes.length; i++) {
    const point = level.nodes[i];
    assert.equal(P.Collision.pointHits(point, index, C.NODE_CLEARANCE), false);
    assert.ok(point.x >= C.EDGE_MARGIN + C.HIT_RADIUS && point.x <= analysis.width - C.EDGE_MARGIN - C.HIT_RADIUS);
    assert.ok(point.y >= C.EDGE_MARGIN + C.HIT_RADIUS && point.y <= analysis.height - C.EDGE_MARGIN - C.HIT_RADIUS);
    assert.ok(level.referencePath.some(p => p.x === point.x && p.y === point.y), 'reference must actually visit every node');
    for (let j = i + 1; j < level.nodes.length; j++) assert.ok(P.Collision.distance(point, level.nodes[j]) >= C.NODE_MIN_DISTANCE);
  }
  assert.ok(Math.abs(measured - level.referenceLength) < 0.001);
  assert.equal(level.maxInk, measured * C.MAX_INK_MULTIPLIER);
  assert.ok(level.maxInk > measured && measured > 0);
  assert.ok(level.difficulty >= 0 && level.difficulty <= 100);
}

for (const [name, rects] of Object.entries(layouts)) {
  test(`reference route is playable with spaced nodes and enough ink: ${name}, 12 seeds`, () => {
    const analysis = { width: 1200, height: 760, rects, stats: {} };
    const reserved = [{ x: 390, y: 12, width: 420, height: 46 }];
    const signatures = new Set();
    for (let seed = 1; seed <= 12; seed++) {
      const level = P.LevelGenerator.generate(analysis, reserved, random(seed));
      verifyLevel(level, analysis, reserved);
      signatures.add(JSON.stringify(level.nodes));
    }
    assert.ok(signatures.size > 8, 'New Puzzle must vary the route on the same page');
  });
}

test('small, fully obstructed, and unusably narrow maps fail gracefully', () => {
  assert.throws(() => P.LevelGenerator.generate({ width: 100, height: 500, rects: [] }), /窗口/);
  assert.throws(() => P.LevelGenerator.generate({ width: 800, height: 600, rects: [{ x: 0, y: 0, width: 800, height: 600 }] }), /空白/);
  assert.throws(() => P.LevelGenerator.generate({ width: 800, height: 600, rects: [
    { x: 0, y: 0, width: 390, height: 600 }, { x: 410, y: 0, width: 390, height: 600 },
  ] }), /空白/);
});

test('efficiency and difficulty contribute to score with a bounded efficiency', () => {
  const base = { referenceLength: 1000, nodes: Array(6), difficulty: 30 };
  const efficient = P.Scoring.calculate(base, 1000);
  const long = P.Scoring.calculate(base, 1250);
  assert.equal(efficient.efficiency, 100);
  assert.equal(long.efficiency, 80);
  assert.ok(efficient.score > long.score);
  assert.equal(P.Scoring.calculate(base, 700).efficiency, 100);
  assert.ok(P.Scoring.calculate({ ...base, difficulty: 90 }, 1000).score > efficient.score);
});
