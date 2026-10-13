'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const context = vm.createContext({});
for (const file of ['config','collision','mazeCleanup','mazeRoute','mazeConnectors','mazeGenerator','routeMazeGenerator','levelGenerator'])
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/content', file + '.js'), 'utf8'), context);
const P = context.__PAGEPATH__;
function rng(seed) { return () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function fixture(kind = 'blank', width = 640, height = 480) {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    mask[y * width + x] = kind === 'solid' ? 1 : kind === 'cards' ? Number(x % 158 < 120 && y % 116 < 84)
      : kind === 'noise' ? Number(x % 37 < 22 && y % 19 < 12) : 0;
  }
  return P.MazeGeometry.rebuild({ width, height, obstacleMask: mask, stats: {} }, [], mask);
}
function verify(level, source) {
  assert.equal(level.nodes.length, 2); assert.equal(level.nodes[0].kind, 'start'); assert.equal(level.nodes[1].kind, 'finish');
  assert.equal(level.unlimitedInk, true); assert.equal(level.maxInk, Infinity);
  assert.equal(level.obstacleIndex.walkableMask, level.analysis.walkableMask);
  assert.ok(Number.isInteger(level.difficulty) && level.difficulty >= 0 && level.difficulty <= 100);
  assert.equal(level.stars, P.Difficulty.stars(level.difficulty));
  assert.equal(level.mode, undefined); assert.equal(level.modeLabel, undefined);
  let measured = 0;
  for (let i = 0; i < level.referencePath.length; i++) {
    const p = level.referencePath[i]; assert.equal(P.Collision.pointHits(p, level.obstacleIndex), false);
    if (i) { const a = level.referencePath[i - 1]; assert.equal(P.Collision.segmentHits(a, p, level.obstacleIndex), false); measured += Math.hypot(a.x-p.x,a.y-p.y); }
  }
  assert.ok(Math.abs(measured - level.referenceLength) < 1e-5);
  const [a,b] = level.nodes;
  assert.ok(Math.hypot(a.x-b.x,a.y-b.y) > Math.hypot(source.width,source.height)*.3, 'endpoints span the page');
  assert.ok(measured > Math.hypot(source.width,source.height)*.65, 'a short pocket is not a maze');
  for (const p of level.nodes) assert.ok(level.analysis.distanceMap[Math.floor(p.y)*source.width+Math.floor(p.x)] >= 12, 'both endpoint icons fit');
  // Independently remove every reported route portal from the graph. Each one
  // must disconnect S/T; a cycle or shortcut on the answer fails this audit.
  const adjacency=level.maze.vertices.map(()=>[]);
  level.maze.edges.forEach((e,i)=>{adjacency[e.a].push([e.b,i]);adjacency[e.b].push([e.a,i]);});
  const ids=level.maze.routeVertexIds, start=ids[0], finish=ids.at(-1);
  for(const removed of level.maze.routeEdgeIds) {
    const seen=new Set([start]),queue=[start];
    for(let i=0;i<queue.length;i++)for(const [next,edge]of adjacency[queue[i]])if(edge!==removed&&!seen.has(next)){seen.add(next);queue.push(next);}
    assert.ok(!seen.has(finish),'all S/T route portals are bridges');
  }
}
function noisyGutters(step, rotated = false) {
  const rects = [];
  for (let column = 0; column < 3; column++) {
    const left = Math.round(column * (512 / 3 + 64));
    const right = Math.round(column * (512 / 3 + 64) + 512 / 3);
    rects.push([left, 0, right - left, 480]);
    if (column < 2) for (let y = 12; y < 468; y += step) rects.push([right + 10, y, 4, 6]);
  }
  const width = rotated ? 480 : 640, height = rotated ? 640 : 480;
  const bounds = rects.map(([x, y, w, h]) => rotated ? [y, x, y + h - 1, x + w - 1] : [x, y, x + w - 1, y + h - 1]);
  const obstacleMask = new Uint8Array(width * height), walkableMask = new Uint8Array(width * height);
  const distanceMap = new Float32Array(width * height), threshold = 2 + Math.SQRT1_2;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let distance = Math.min(x + 0.5, y + 0.5, width - x - 0.5, height - y - 0.5);
    for (const [left, top, right, bottom] of bounds) {
      distance = Math.min(distance, Math.hypot(Math.max(left - x, 0, x - right), Math.max(top - y, 0, y - bottom)));
      if (!distance) break;
    }
    const at = y * width + x;
    obstacleMask[at] = distance === 0 ? 1 : 0;
    walkableMask[at] = distance > threshold ? 1 : 0; distanceMap[at] = distance;
  }
  return { kind: 'pixel-mask', width, height, maskWidth: width, maskHeight: height,
    obstacleMask, walkableMask, distanceMap, stats: { clearance: 2, walkableThreshold: threshold } };
}

for(const rotated of [false,true])test('tiny glyph noise in '+(rotated?'horizontal':'vertical')+' gutters cannot prevent maze generation',()=>{
  for(const seed of [9,29]){
    const source=noisyGutters(24,rotated),before=source.obstacleMask.slice();
    const level=P.LevelGenerator.generate(source,[],rng(seed));verify(level,source);assert.deepEqual(source.obstacleMask,before);
  }
});
