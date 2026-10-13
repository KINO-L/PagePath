'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const context = vm.createContext({});
for (const file of ['config', 'collision']) {
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

test('finish hits include crossings, tangency, and an already collected position', () => {
  const center = { x: 50, y: 50 };
  assert.equal(P.Collision.segmentCircleEntry({ x: 0, y: 50 }, { x: 100, y: 50 }, center, 10), 0.4);
  assert.equal(P.Collision.segmentCircleEntry({ x: 0, y: 40 }, { x: 100, y: 40 }, center, 10), 0.5);
  assert.equal(P.Collision.segmentCircleEntry({ x: 50, y: 50 }, { x: 50, y: 50 }, center, 10), 0);
  assert.equal(P.Collision.segmentCircleEntry({ x: 0, y: 39 }, { x: 100, y: 39 }, center, 10), null);
  assert.equal(P.Collision.segmentCircleEntry({ x: 0, y: 0 }, { x: 0, y: 0 }, center, 10), null);
});
