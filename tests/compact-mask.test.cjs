'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const context = vm.createContext({ setTimeout, DOMException });
for (const name of ['config', 'compactMask', 'imageMapAnalyzer']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/content', `${name}.js`), 'utf8'), context);
}
const P = context.__PAGEPATH__, width = 600, height = 400;
const hint = (x, y, w, h, kind = 'content', radius = 0) => ({ x, y, width: w, height: h, kind, radius });
const blank = () => new Uint8Array(width * height);
const at = (mask, x, y) => mask[y * width + x];
function rect(mask, x, y, w, h) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) mask[yy * width + xx] = 1;
}
function outline(mask, x, y, w, h) {
  rect(mask, x, y, w, 1); rect(mask, x, y + h - 1, w, 1);
  rect(mask, x, y, 1, h); rect(mask, x + w - 1, y, 1, h);
}
function roundedOutline(mask, x, y, w, h, radius) {
  const inside = (xx, yy) => {
    if (xx < x || yy < y || xx >= x + w || yy >= y + h) return false;
    const dx = Math.max(x + radius - xx - 0.5, 0, xx + 0.5 - x - w + radius);
    const dy = Math.max(y + radius - yy - 0.5, 0, yy + 0.5 - y - h + radius);
    return dx * dx + dy * dy <= radius * radius;
  };
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    if (inside(xx, yy) && [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dy]) => !inside(xx + dx, yy + dy))) {
      mask[yy * width + xx] = 1;
    }
  }
}

test('small text pieces become one tight obstacle without consuming the DOM padding', () => {
  const mask = blank();
  outline(mask, 45, 59, 8, 20); outline(mask, 65, 59, 8, 20);
  const stats = P.CompactMask.apply(mask, width, height, [hint(40, 50, 50, 40)]);
  assert.equal(stats.compactDomMerged, 1);
  assert.ok(stats.compactDomAddedPixels > 0);
  assert.equal(at(mask, 59, 68), 1, 'the letter gap is unified');
  assert.equal(at(mask, 49, 68), 1, 'enclosed glyph hole is filled');
  for (const [x, y] of [[40, 50], [44, 68], [74, 68], [59, 58], [59, 79]]) {
    assert.equal(at(mask, x, y), 0, 'blank padding stays available');
  }
});

test('painted rounded controls preserve their rounded outside corners', () => {
  const mask = blank(); rect(mask, 66, 65, 28, 8);
  roundedOutline(mask, 40, 50, 80, 40, 12);
  const stats = P.CompactMask.apply(mask, width, height, [hint(40, 50, 80, 40, 'box', 12)]);
  assert.equal(stats.compactDomMerged, 1);
  assert.equal(at(mask, 40, 50), 0);
  assert.equal(at(mask, 119, 50), 0);
  assert.equal(at(mask, 40, 89), 0);
  assert.equal(at(mask, 80, 50), 1);
  assert.equal(at(mask, 40, 70), 1);
  assert.equal(at(mask, 80, 85), 1);
});

test('a mostly covered button cannot turn its invisible DOM area into an obstacle', () => {
  const viewportWidth = 1000, viewportHeight = 800;
  const mask = new Uint8Array(viewportWidth * viewportHeight);
  // A pointer-events:none white cover hides 190px of this 200px-wide button.
  for (let y = 50; y < 110; y++) for (let x = 40; x < 50; x++) mask[y * viewportWidth + x] = 1;
  const before = mask.slice();
  const stats = P.CompactMask.apply(mask, viewportWidth, viewportHeight, [hint(40, 50, 200, 60, 'box')]);
  assert.equal(stats.compactDomCandidates, 1);
  assert.equal(stats.compactDomAddedPixels, 0);
  assert.deepEqual(mask, before, 'only the visible 10px strip remains blocked');
});

test('a borderless control with only a visible central label keeps surrounding whitespace', () => {
  const mask = blank();
  outline(mask, 67, 65, 8, 12); outline(mask, 81, 65, 8, 12);
  const stats = P.CompactMask.apply(mask, width, height, [hint(40, 50, 80, 40, 'box')]);
  assert.equal(stats.compactDomMerged, 1);
  assert.equal(at(mask, 78, 70), 1, 'the visible compact label can still be unified');
  for (const [x, y] of [[40, 50], [60, 70], [96, 70], [78, 60], [78, 80]]) {
    assert.equal(at(mask, x, y), 0, 'invisible control padding remains open');
  }
});

test('a central cover leaving both sides visible cannot be bridged by box or content hints', () => {
  const viewportWidth = 1000, viewportHeight = 800;
  const original = new Uint8Array(viewportWidth * viewportHeight);
  // The middle 120px is covered, but the two 40px side strips span the whole box.
  for (let y = 50; y < 110; y++) for (let x = 40; x < 240; x++) {
    if (x < 80 || x >= 200) original[y * viewportWidth + x] = 1;
  }
  for (const kind of ['box', 'content']) {
    const mask = original.slice();
    const stats = P.CompactMask.apply(mask, viewportWidth, viewportHeight, [hint(40, 50, 200, 60, kind)]);
    assert.equal(stats.compactDomCandidates, 1);
    assert.equal(stats.compactDomMerged, 0);
    assert.equal(stats.compactDomAddedPixels, 0);
    assert.deepEqual(mask, original, `${kind} cannot reconnect content across the hidden middle`);
  }
});

test('blank hints, thin decorative rules, and sparse separated evidence do not become walls', () => {
  const mask = blank(); rect(mask, 50, 80, 80, 1);
  rect(mask, 202, 102, 3, 3); rect(mask, 292, 112, 3, 3);
  const before = mask.slice();
  const stats = P.CompactMask.apply(mask, width, height, [
    hint(20, 20, 50, 30, 'box'), hint(50, 70, 80, 20, 'box'),
    hint(50, 70, 80, 20), hint(200, 100, 100, 20)
  ]);
  assert.equal(stats.compactDomMerged, 0);
  assert.deepEqual(mask, before);
});

test('large, clipped, malformed, and unknown hints fall back to screenshot contours', () => {
  const mask = blank(); rect(mask, 30, 30, 300, 100);
  const before = mask.slice();
  const bad = [hint(20, 20, 300, 30), hint(20, 20, 50, 100),
    hint(20, 20, 200, 30), // exceeds this viewport\'s 1.8% area limit
    hint(-1, 20, 20, 20), hint(590, 20, 20, 20), hint(20, 390, 20, 20),
    hint(20, 20, 2, 20), hint(NaN, 20, 20, 20), hint(20, 20, Infinity, 20),
    hint('20', 20, 20, 20), hint(20, 20, 20, 20, 'container'),
    hint(20, 20, 20, 20, 'box', -1), hint(20, 20, 20, 20, 'box', 11), null];
  const stats = P.CompactMask.apply(mask, width, height, bad);
  assert.equal(stats.compactDomCandidates, 0);
  assert.deepEqual(mask, before);
});

test('overlapping hints cannot manufacture image evidence and the result is order-independent', () => {
  const original = blank(); rect(original, 10, 10, 20, 20);
  const first = hint(10, 10, 30, 30, 'box'), second = hint(32, 10, 30, 30, 'box');
  const forward = original.slice(), reverse = original.slice();
  const stats = P.CompactMask.apply(forward, width, height, [first, second]);
  P.CompactMask.apply(reverse, width, height, [second, first]);
  assert.equal(stats.compactDomMerged, 1);
  assert.equal(at(forward, 38, 20), 1);
  assert.equal(at(forward, 50, 20), 0);
  assert.deepEqual(forward, reverse);
});

test('stable geometry excludes moved or removed elements and strips all private fields', () => {
  const fixed = { ...hint(20, 30, 50, 20), text: 'private text', url: 'https://private.invalid/', node: {} };
  const moved = hint(100, 40, 30, 20), removed = hint(160, 40, 30, 20);
  const after = [{ ...fixed, x: 20.25, width: 49.75 }, { ...moved, x: 102 }];
  const result = P.CompactMask.stable([fixed, moved, removed], after, { width, height });
  assert.equal(result.length, 1);
  assert.deepEqual(Object.keys(result[0]).sort(), ['height', 'kind', 'radius', 'width', 'x', 'y']);
  assert.equal(result[0].x, 20);
  assert.equal(P.CompactMask.stable([fixed], [{ ...fixed, kind: 'box' }], { width, height }).length, 0);
});

test('hint count is bounded and duplicate geometry is merged once', () => {
  const hints = Array.from({ length: 600 }, (_, i) => hint((i % 100) * 5, Math.floor(i / 100) * 5, 4, 4));
  assert.equal(P.CompactMask.stable(hints, hints, { width, height }).length, 512);
  const mask = blank(); rect(mask, 22, 22, 8, 8);
  const small = hint(20, 20, 20, 20, 'box');
  const stats = P.CompactMask.apply(mask, width, height, [small, small]);
  assert.equal(stats.compactDomCandidates, 1);
  assert.equal(stats.compactDomMerged, 1);
});

test('the image-only mask is unchanged when no compact hints are supplied', () => {
  const mask = blank(); outline(mask, 20, 30, 50, 20);
  const before = mask.slice();
  const stats = P.CompactMask.apply(mask, width, height);
  assert.equal(stats.compactDomCandidates, 0);
  assert.equal(stats.compactDomAddedPixels, 0);
  assert.deepEqual(mask, before);
});

test('real OpenCV computes distance, collision clearance, and contours after compact fusion', async () => {
  const cv = require(path.join(__dirname, '../vendor/opencv/opencv.js'));
  await new Promise(resolve => {
    const ready = () => { delete cv.then; resolve(); };
    if (cv.Mat && cv.calledRun) ready(); else cv.then(ready);
  });
  P.OpenCV = { ready: async () => cv };
  const ink = blank(); outline(ink, 45, 59, 8, 20); outline(ink, 65, 59, 8, 20);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < ink.length; i++) {
    const color = ink[i] ? 0 : 255;
    data[i * 4] = color; data[i * 4 + 1] = color; data[i * 4 + 2] = color; data[i * 4 + 3] = 255;
  }
  const image = { data, width, height };
  const pure = await P.ImageMapAnalyzer.analyze(image);
  const hybrid = await P.ImageMapAnalyzer.analyze(image, { domHints: [hint(40, 50, 50, 40)] });
  const index = 68 * width + 59;
  assert.equal(pure.walkableMask[index], 1, 'the original wide letter gap is traversable');
  assert.equal(hybrid.obstacleMask[index], 1);
  assert.equal(hybrid.walkableMask[index], 0);
  assert.equal(hybrid.distanceMap[index], 0);
  assert.equal(hybrid.componentLabels[index], 0);
  assert.equal(hybrid.stats.compactDomMerged, 1);
  assert.ok(hybrid.stats.compactDomAddedPixels > 0);
  assert.ok(hybrid.contours.segments.length < pure.contours.segments.length, 'glyph inner contours disappear');
  assert.equal(hybrid.walkableMask[90 * width + 80], 1, 'surrounding blank space remains playable');
});
