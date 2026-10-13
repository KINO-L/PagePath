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

test('one immutable full-range difficulty replaces the old profiles',()=>{
  assert.equal(P.Config.MODES,undefined);assert.equal(P.Config.DEFAULT_MODE,undefined);assert.equal(P.getMode,undefined);
  assert.ok(Object.isFrozen(P.Config.DIFFICULTY));assert.equal(P.Config.DIFFICULTY.min,0);assert.equal(P.Config.DIFFICULTY.max,100);
  assert.ok(Object.isFrozen(P.Difficulty));
});
test('stars follow the measured score with exact inclusive upper boundaries',()=>{
  for(const [score,stars]of [[0,1],[20,1],[20.0001,2],[40,2],[40.0001,3],[60,3],[60.0001,4],[80,4],[80.0001,5],[100,5],[-10,1],[120,5],[NaN,1]]){
    assert.equal(P.Difficulty.stars(score),stars, String(score));
  }
});
test('page profiles retain all five tiers while busy screenshots favor higher stars',()=>{
  const profiles = ['blank', 'cards', 'noise', 'solid'].map(kind => P.Difficulty.profile(fixture(kind)));
  for (const profile of profiles) {
    assert.ok(profile.pageComplexity >= 0 && profile.pageComplexity <= 1);
    assert.ok(Object.isFrozen(profile) && Object.isFrozen(profile.probabilities));
    assert.equal(profile.probabilities.length, 5);
    assert.ok(Math.abs(profile.probabilities.reduce((sum, chance) => sum + chance, 0) - 1) < 1e-12);
    for (const chance of profile.probabilities) assert.ok(chance >= .05 - 1e-12);
  }
  assert.deepEqual(Array.from(profiles[0].probabilities), [.36, .29, .20, .10, .05]);
  for (const profile of profiles.slice(1)) {
    assert.ok(profile.pageComplexity > .5, 'cards, fragmented content and solid foreground are complex');
    assert.ok(profile.probabilities[4] > profile.probabilities[0]);
    assert.ok(profile.probabilities[0] < profiles[0].probabilities[0]);
    assert.ok(profile.probabilities[4] > profiles[0].probabilities[4]);
  }
});
test('distributed fragmented content raises complexity at the same foreground area',()=>{
  const width = 160, height = 120, block = new Uint8Array(width * height), scattered = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    block[y * width + x] = Number(x < 40);
    scattered[y * width + x] = Number(x % 4 === 0);
  }
  const concentrated = P.Difficulty.profile({width, height, obstacleMask:block});
  const dispersed = P.Difficulty.profile({width, height, obstacleMask:scattered});
  assert.ok(dispersed.pageComplexity > concentrated.pageComplexity + .25);
});
test('drawing a tier reaches every CDF interval and stays within its real score range',()=>{
  for (const kind of ['blank', 'cards', 'noise', 'solid']) {
    const source = fixture(kind), profile = P.Difficulty.profile(source);
    let cumulative = 0;
    for (let index = 0; index < 5; index++) {
      for (const jitter of [0, .5, 1]) {
        const values = [(cumulative + profile.probabilities[index] / 2), jitter];
        const draw = P.Difficulty.draw(source, () => values.shift());
        assert.equal(draw.targetStars, index + 1);
        assert.equal(P.Difficulty.stars(draw.targetDifficulty), draw.targetStars);
        assert.ok(draw.targetDifficulty >= index * 20 + 6 && draw.targetDifficulty <= index * 20 + 14);
        assert.equal(draw.intensity, draw.targetDifficulty / 100);
        assert.equal(draw.pageComplexity, profile.pageComplexity);
      }
      cumulative += profile.probabilities[index];
    }
  }
});
test('seeded draws reproduce the same targets without changing the screenshot mask',()=>{
  const source = fixture('cards'), before = Uint8Array.from(source.obstacleMask);
  const a = rng(719), b = rng(719), first = P.Difficulty.profile(source);
  const stars = new Set();
  for (let i = 0; i < 500; i++) {
    const left = P.Difficulty.draw(source, a), right = P.Difficulty.draw(source, b);
    assert.deepEqual(left, right); stars.add(left.targetStars);
  }
  assert.equal(stars.size, 5);
  assert.equal(P.Difficulty.profile(source), first, 'reuse the immutable profile for this screenshot');
  assert.deepEqual(Uint8Array.from(source.obstacleMask), before);
});
test('the unified maze works on pages formerly locked out',()=>{
  const source=fixture(),level=P.LevelGenerator.generate(source,[],rng(20));verify(level,source);assert.ok(level.maze);
});
