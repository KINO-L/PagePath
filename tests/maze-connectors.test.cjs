'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const context = vm.createContext({});
for (const name of ['config', 'collision', 'mazeGenerator', 'mazeConnectors']) vm.runInContext(
  fs.readFileSync(path.join(__dirname, '../src/content', `${name}.js`), 'utf8'), context);
const { MazeConnectors } = context.__PAGEPATH__;
const { MazeGeometry, Collision } = context.__PAGEPATH__;
const random = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
function source(width, height, rects) {
  const obstacleMask = new Uint8Array(width * height);
  for (const [left, top, w, h] of rects) for (let y = top; y < top + h; y++) {
    obstacleMask.fill(1, y * width + left, y * width + left + w);
  }
  return { width, height, obstacleMask, stats: { walkableThreshold: 2 + Math.SQRT1_2 } };
}
function distance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, q = dx * dx + dy * dy;
  const t = q ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / q)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
function audit(original, answer, result) {
  const { width, height } = original;
  const declared = new Uint8Array(width * height);
  for (const wall of result.wallSegments) {
    assert.equal(wall.width, 3);
    assert.ok(wall.points.length >= 2);
    assert.equal(wall.anchors.length, wall.kind === 'baffle' ? 1 : 2);
    for (const anchor of wall.anchors) {
      const x = Math.floor(anchor.x), y = Math.floor(anchor.y);
      assert.ok(original.obstacleMask[y * width + x] || x === 0 || y === 0 || x === width - 1 || y === height - 1,
        'every connector begins and ends on original foreground or the viewport');
    }
    // Independent exhaustive capsule rasterisation; diagonal bounding boxes
    // would add pixels outside this geometry and immediately fail this audit.
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = { x: x + 0.5, y: y + 0.5 };
      if (wall.points.some((b, i) => i && distance(p, wall.points[i - 1], b) <= 1.5 + 1e-8)) declared[y * width + x] = 1;
    }
  }
  let added = 0;
  for (let at = 0; at < declared.length; at++) {
    assert.equal(result.obstacleMask[at], original.obstacleMask[at] || declared[at], 'mask exactly matches declared thin strokes');
    if (result.obstacleMask[at] && !original.obstacleMask[at]) {
      added++;
      const p = { x: at % width + 0.5, y: Math.floor(at / width) + 0.5 };
      for (let i = 1; i < answer.length; i++) assert.ok(distance(p, answer[i - 1], answer[i]) > original.stats.walkableThreshold + 3,
        'the fixed answer retains clearance and hand movement allowance');
      for (const endpoint of [answer[0], answer.at(-1)]) assert.ok(Math.hypot(p.x - endpoint.x, p.y - endpoint.y) > 14,
        'the inkstone and paper retain room around them');
    }
  }
  assert.equal(added, result.meta.addedPixels);
  assert.equal(result.meta.connectors, result.wallSegments.length);
}

test('connects tiny islands at free angles while preserving a fixed answer', () => {
  const map = source(180, 150, [[70, 34, 1, 1], [95, 51, 14, 18], [122, 90, 15, 20], [47, 105, 12, 9]]);
  const before = new Uint8Array(map.obstacleMask);
  const answer = [{ x: 23.5, y: 19.5 }, { x: 23.5, y: 129.5 }];
  const result = MazeConnectors.plan(map, answer, random(21));
  assert.equal(result.meta.complete, true);
  assert.equal(result.meta.unresolvedComponents, 0);
  assert.ok(result.wallSegments.some(wall => wall.points.some((p, i) => i && p.x !== wall.points[i - 1].x && p.y !== wall.points[i - 1].y)),
    'the connectors are not restricted to horizontal and vertical bars');
  assert.ok(result.wallSegments.some(wall => wall.anchors.some(p => Math.floor(p.x) === 70 && Math.floor(p.y) === 34)),
    'a one-pixel island must not be lost between axis scan samples');
  audit(map, answer, result);
  assert.deepEqual(map.obstacleMask, before);
});

test('connectors may cross a gap longer than the obsolete 96 pixel limit', () => {
  const map = source(350, 310, [[170, 150, 9, 9]]);
  const answer = [{ x: 23.5, y: 30.5 }, { x: 23.5, y: 280.5 }];
  const result = MazeConnectors.plan(map, answer, random(9));
  assert.equal(result.meta.complete, true);
  assert.equal(result.wallSegments.length, 1);
  const wall = result.wallSegments[0];
  assert.ok(wall.points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - wall.points[i].x, p.y - wall.points[i].y), 0) > 96);
  audit(map, answer, result);
});

test('all viewport-touching foreground belongs to one exterior component', () => {
  const map = source(180, 150, [[0, 0, 60, 150], [120, 0, 60, 150]]);
  const answer = [{ x: 89.5, y: 20.5 }, { x: 89.5, y: 129.5 }];
  const result = MazeConnectors.plan(map, answer, random(1));
  assert.equal(result.meta.originalComponents, 1);
  assert.equal(result.meta.complete, true);
  assert.equal(result.wallSegments.length, 0, 'do not close the only existing corridor to join two parts of the same exterior');
  assert.deepEqual(Array.from(result.obstacleMask), Array.from(map.obstacleMask));
});

test('a winding answer gains one-ended diagonal baffles in an existing straight passage', () => {
  const map = source(180, 270, [[0, 0, 60, 270], [120, 0, 60, 270]]);
  const answer = [{ x: 89.5, y: 20.5 }, { x: 75.5, y: 65.5 }, { x: 103.5, y: 112.5 },
    { x: 75.5, y: 160.5 }, { x: 103.5, y: 207.5 }, { x: 89.5, y: 248.5 }];
  const result = MazeConnectors.plan(map, answer, random(7));
  assert.equal(result.meta.complete, true);
  assert.ok(result.meta.baffles >= 3, 'the answer must not simplify back to a straight line');
  assert.ok(result.wallSegments.every(wall => wall.kind === 'baffle' && wall.anchors.length === 1));
  assert.ok(result.wallSegments.some(wall => wall.points[0].x !== wall.points[1].x && wall.points[0].y !== wall.points[1].y));
  audit(map, answer, result);
});

test('reports a protected enclosure instead of cutting through the answer', () => {
  const map = source(160, 140, [[73, 63, 9, 9]]);
  const answer = [{ x: 50.5, y: 42.5 }, { x: 107.5, y: 42.5 }, { x: 107.5, y: 99.5 },
    { x: 50.5, y: 99.5 }, { x: 50.5, y: 50.5 }];
  const result = MazeConnectors.plan(map, answer, random(3));
  assert.equal(result.meta.complete, false);
  assert.ok(result.meta.unresolvedComponents > 0);
  audit(map, answer, result);
});

test('seeded maps are reproducible and invalid answers are rejected', () => {
  const map = source(130, 120, [[65, 42, 5, 5], [88, 79, 8, 8]]);
  const answer = [{ x: 20.5, y: 20.5 }, { x: 20.5, y: 98.5 }];
  const first = MazeConnectors.plan(map, answer, random(39));
  const second = MazeConnectors.plan(map, answer, random(39));
  assert.deepEqual(first.wallSegments, second.wallSegments);
  assert.deepEqual(first.obstacleMask, second.obstacleMask);
  assert.throws(() => MazeConnectors.plan(map, [{ x: NaN, y: 20 }, { x: 40, y: 60 }]), /有效/);
});

test('continuous intensity varies real baffle clearances while protecting the answer', () => {
  const map = source(300, 270, []), answer = [{x:20.5,y:135.5},{x:85.5,y:100.5},{x:150.5,y:170.5},{x:215.5,y:100.5},{x:280.5,y:135.5}];
  const signatures = new Set(), gaps = [];
  for (const intensity of [0,.25,.5,.75,1]) {
    const result = MazeConnectors.plan(map, answer, random(7), {intensity});
    assert.ok(result.meta.baffles>=2);audit(map,answer,result);
    signatures.add(JSON.stringify(result.wallSegments.map(wall=>wall.points)));
    gaps.push(Math.min(...result.wallSegments.map(wall=>{
      const tip=wall.points.at(-1);
      return Math.min(...answer.slice(1,-1).map(p=>Math.hypot(p.x-tip.x,p.y-tip.y)));
    })));
  }
  assert.ok(signatures.size>=4,'intermediate intensities produce intermediate wall geometry');
  assert.ok(gaps[0]>gaps.at(-1)+5,'higher intensity leaves less room around the required bends');
});

function branchingCorridor(vertical = false) {
  const width = 340, height = 240, obstacleMask = new Uint8Array(width * height).fill(1);
  const carve = (left, top, w, h) => {
    for (let y = top; y < top + h; y++) obstacleMask.fill(0, y * width + left, y * width + left + w);
  };
  carve(14, 100, 312, 40);
  for (const x of [60, 115, 170, 225, 280]) carve(x, 25, 20, 190);
  let mask = obstacleMask, w = width, h = height;
  if (vertical) {
    mask = new Uint8Array(width * height); w = height; h = width;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) mask[x * height + y] = obstacleMask[y * width + x];
  }
  const convert = p => vertical ? { x: p.y, y: p.x } : p;
  return {
    map: MazeGeometry.rebuild({ width: w, height: h, obstacleMask: mask, stats: {} }, [], mask),
    answer: [{ x: 31.5, y: 120.5 }, { x: 308.5, y: 120.5 }].map(convert),
    branches: [60, 115, 170, 225, 280].flatMap(x => [25, 190].map(y => convert({ x: x + 10.5, y: y + 10.5 }))),
  };
}

function auditSeals(map, answer, result) {
  const { width, height } = map, declared = Uint8Array.from(map.obstacleMask);
  assert.ok(result.wallSegments.length > 0, 'the fixture must actually generate branch seals');
  for (const wall of result.wallSegments) {
    assert.equal(wall.width, 3);
    assert.equal(wall.anchors.length, 2);
    const length = wall.points.slice(1).reduce((sum, b, i) => sum + Math.hypot(b.x - wall.points[i].x, b.y - wall.points[i].y), 0);
    assert.ok(length <= 80, 'a branch seal is a short foreground connector');
    for (const anchor of wall.anchors) {
      const x = Math.floor(anchor.x), y = Math.floor(anchor.y);
      assert.ok(declared[y * width + x] || x === 0 || y === 0 || x === width - 1 || y === height - 1,
        'both ends attach to an obstacle, an earlier declared line, or the viewport');
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = { x: x + .5, y: y + .5 };
      if (wall.points.some((b, i) => i && distance(p, wall.points[i - 1], b) <= 1.5 + 1e-8)) declared[y * width + x] = 1;
    }
  }
  assert.deepEqual(Uint8Array.from(result.obstacleMask), declared, 'only the declared 3px capsules may add foreground');
  for (let at = 0; at < declared.length; at++) if (declared[at] && !map.obstacleMask[at]) {
    const p = { x: at % width + .5, y: Math.floor(at / width) + .5 };
    for (let i = 1; i < answer.length; i++) assert.ok(distance(p, answer[i - 1], answer[i]) > 8, 'preserve 8px along the actual answer');
    for (const endpoint of [answer[0], answer.at(-1)]) assert.ok(Math.hypot(p.x - endpoint.x, p.y - endpoint.y) > 14,
      'preserve 14px around both endpoint icons');
  }
}

test('branch seals close dense side passages using declared thin lines without changing the source mask', () => {
  const { map, answer, branches } = branchingCorridor(), before = Uint8Array.from(map.obstacleMask);
  const result = MazeConnectors.sealBranches(map, answer);
  auditSeals(map, answer, result);
  assert.deepEqual(Uint8Array.from(map.obstacleMask), before);
  const final = MazeGeometry.rebuild(map, [], result.obstacleMask);
  const labelAt = p => final.componentLabels[Math.floor(p.y) * final.width + Math.floor(p.x)];
  const startLabel = labelAt(answer[0]);
  assert.ok(startLabel);
  assert.equal(labelAt(answer.at(-1)), startLabel);
  for (const branch of branches) {
    const at = Math.floor(branch.y) * final.width + Math.floor(branch.x);
    assert.equal(final.walkableMask[at], 1, 'the branch interior is not replaced by a solid obstacle');
    assert.notEqual(labelAt(branch), startLabel, 'the added mouth line removes a real reachable wrong turn');
  }
});

test('transposed branch mouths seal without sacrificing pen clearance or endpoint room', () => {
  const { map, answer, branches } = branchingCorridor(true), before = Uint8Array.from(map.obstacleMask);
  const result = MazeConnectors.sealBranches(map, answer);
  auditSeals(map, answer, result);
  assert.deepEqual(Uint8Array.from(map.obstacleMask), before);
  const final = MazeGeometry.rebuild(map, [], result.obstacleMask), index = Collision.createMaskIndex(final);
  for (const point of answer) {
    assert.equal(Collision.pointHits(point, index), false);
    assert.ok(final.distanceMap[Math.floor(point.y) * final.width + Math.floor(point.x)] >= 14);
  }
  assert.equal(Collision.segmentHits(answer[0], answer[1], index), false, 'the whole answer stays playable with the shared collision map');
  const startLabel = final.componentLabels[Math.floor(answer[0].y) * final.width + Math.floor(answer[0].x)];
  assert.ok(branches.every(p => final.componentLabels[Math.floor(p.y) * final.width + Math.floor(p.x)] !== startLabel),
    'horizontal spurs must be removed as well as vertical ones');
});
