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

test('seeded maps reproduce geometry without mutating earlier cached masks',()=>{
  const source=fixture('solid'),first=P.LevelGenerator.generate(source,[],rng(19)),before=first.analysis.obstacleMask.slice();
  const again=P.LevelGenerator.generate(source,[],rng(19));
  assert.deepEqual(again.referencePath,first.referencePath);assert.equal(again.difficulty,first.difficulty);assert.deepEqual(again.analysis.obstacleMask,first.analysis.obstacleMask);
  const next=P.LevelGenerator.generate(source,[],rng(25),[first.nodes]);verify(next,source);
  assert.deepEqual(first.analysis.obstacleMask,before);assert.notEqual(next.analysis.obstacleMask,first.analysis.obstacleMask);
});
test('successive maps change actual endpoints, bends and difficulty',()=>{
  const source=fixture(),history=[],signatures=new Set(),scores=new Set();
  for(const seed of [4,17,36,65,99]){
    const level=P.LevelGenerator.generate(source,[],rng(seed),history);verify(level,source);
    signatures.add(level.referencePath.map(p=>Math.round(p.x)+','+Math.round(p.y)).join('/'));scores.add(level.difficulty);history.push(level.nodes);
  }
  assert.equal(signatures.size,5);assert.ok(scores.size>=2);
});
