'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const context = vm.createContext({});
for (const filename of ['config.js', 'overlay.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/content', filename), 'utf8'), context);
}
const P = context.__PAGEPATH__;
const clip = (points, length) => JSON.parse(JSON.stringify(P.Trail.clip(points, length)));
const arcLength = points => points.slice(1).reduce((sum, point, index) =>
  sum + Math.hypot(point.x - points[index].x, point.y - points[index].y), 0);

test('tail keeps short routes unchanged and handles empty and single points', () => {
  assert.deepEqual(clip([], 120), []);
  assert.deepEqual(clip([{ x: 8, y: 9 }], 120), [{ x: 8, y: 9 }]);
  const route = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 30 }];
  assert.deepEqual(clip(route, 120), route);
});

test('tail clips a fast movement inside its only segment', () => {
  assert.deepEqual(clip([{ x: 0, y: 0 }, { x: 1000, y: 0 }], 120),
    [{ x: 880, y: 0 }, { x: 1000, y: 0 }]);
});

test('tail measures bends by arc length instead of distance from the head', () => {
  const route = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const tail = clip(route, 120);
  assert.deepEqual(tail, [{ x: 100, y: 80 }, { x: 100, y: 100 }, { x: 0, y: 100 }]);
  assert.equal(arcLength(tail), 120);
});

test('tail interpolates diagonal segments and preserves exact cut endpoints', () => {
  const diagonal = clip([{ x: 0, y: 0 }, { x: 300, y: 400 }], 70);
  assert.deepEqual(diagonal, [{ x: 258, y: 344 }, { x: 300, y: 400 }]);
  const route = [{ x: 0, y: 0 }, { x: 70, y: 0 }, { x: 70, y: 70 }];
  assert.deepEqual(clip(route, 70), route.slice(1));
});

test('duplicate stationary samples cannot hide an older long segment', () => {
  const tail = clip([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 0 }], 70);
  assert.deepEqual(tail, [{ x: 930, y: 0 }, { x: 1000, y: 0 }]);
});

test('tail clipping never mutates the complete gameplay route', () => {
  const route = Object.freeze([Object.freeze({ x: 0, y: 0 }), Object.freeze({ x: 1000, y: 0 })]);
  const original = JSON.stringify(route);
  clip(route, 120);
  assert.equal(JSON.stringify(route), original);
  for (const invalidLength of [0, -1, Infinity, NaN]) assert.deepEqual(clip(route, invalidLength), []);
});

test('overlay applies mode length to both colored path and outline in every terminal state', () => {
  const attributes = {}, outline = {};
  const overlay = {
    path: { setAttribute: (name, value) => { attributes[name] = value; } },
    pathOutline: { setAttribute: (name, value) => { outline[name] = value; } },
  };
  const route = [{ x: 0, y: 0 }, { x: 1000, y: 0 }];
  for (const state of ['DRAWING', 'SUCCESS', 'FAILED']) {
    for (const [mode, expectedStart] of [['normal', '955.0'], ['hell', '955.0'], ['immortal', '955.0']]) {
      Object.assign(overlay, { state, mode, level: { mode } });
      P.Overlay.prototype.renderPath.call(overlay, route);
      assert.equal(attributes.points, `${expectedStart},0.0 1000.0,0.0`);
      assert.equal(outline.points, attributes.points);
    }
  }
  overlay.level.trailLength = 50;
  P.Overlay.prototype.renderPath.call(overlay, route);
  assert.equal(attributes.points, '950.0,0.0 1000.0,0.0');
  P.Overlay.prototype.renderPath.call(overlay, []);
  assert.equal(attributes.points, '');
  assert.equal(outline.points, '');
});
