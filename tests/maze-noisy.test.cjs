'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const context = vm.createContext({});
for (const file of ['config', 'collision', 'mazeCleanup', 'mazeRoute', 'mazeConnectors', 'mazeGenerator', 'routeMazeGenerator']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/content', `${file}.js`), 'utf8'), context);
}
const P = context.__PAGEPATH__;
function random(seed) {
  return () => {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Real 64px page gutters beside three solid content columns. Tiny independent
// glyphs repeatedly change the gutter outline without removing its long main
// passage. This used to qualify and then fail in all three construction tries.
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

function flood(mask, width, starts) {
  const queue = new Int32Array(mask.length), seen = new Uint8Array(mask.length);
  let head = 0, tail = 0;
  for (const start of starts) if (mask[start] && !seen[start]) { seen[start] = 1; queue[tail++] = start; }
  while (head < tail) {
    const at = queue[head++], x = at % width;
    for (const next of [x ? at - 1 : -1, x + 1 < width ? at + 1 : -1, at - width, at + width]) {
      if (next >= 0 && next < mask.length && mask[next] && !seen[next]) { seen[next] = 1; queue[tail++] = next; }
    }
  }
  return seen;
}

function pointSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, sq = dx * dx + dy * dy;
  const t = sq ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / sq)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
function segmentDistance(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  if (cross(a,b,c) * cross(a,b,d) < 0 && cross(c,d,a) * cross(c,d,b) < 0) return 0;
  return Math.min(pointSegment(a,c,d), pointSegment(b,c,d), pointSegment(c,a,b), pointSegment(d,a,b));
}
function paintTube(target, width, height, points, radius) {
  assert.ok(points.length >= 2 && radius > 0);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    for (let y = Math.max(0, Math.floor(Math.min(a.y, b.y) - radius)); y < Math.min(height, Math.ceil(Math.max(a.y, b.y) + radius)); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(a.x, b.x) - radius)); x < Math.min(width, Math.ceil(Math.max(a.x, b.x) + radius)); x++) {
        if (pointSegment({ x:x+.5, y:y+.5 }, a, b) <= radius + 1e-8) target[y * width + x] = 1;
      }
    }
  }
}
function paintRects(mask, width, height, rects) {
  for (const r of rects) {
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= width && r.y + r.height <= height);
    for (let y = r.y; y < r.y + r.height; y++) mask.fill(1, y * width + r.x, y * width + r.x + r.width);
  }
}

// Independently decompose the final reachable pixels, rather than trusting the
// planner's graph witness. Only edges on the start-to-finish path must be
// bridges: cycles attached to an unrelated dead-end branch are harmless.
function verifyUniquePassage(map, nodes) {
  const { width, height, walkableMask } = map, at = p => Math.floor(p.y) * width + Math.floor(p.x);
  const start = at(nodes[0]), finish = at(nodes[1]), reached = flood(walkableMask, width, [start]);
  assert.equal(reached[finish], 1, 'final pixels connect the actual endpoints');
  const owners = new Int32Array(walkableMask.length).fill(-1), adjacency = [], edges = [], keys = new Set();
  let previous = [];
  for (let y = 0; y < height; y++) {
    const current = [], exact = new Map(previous.map(r => [r.left + ':' + r.right, r.id]));
    for (let x = 0; x < width;) {
      if (!reached[y * width + x]) { x++; continue; }
      const left = x;
      while (x < width && reached[y * width + x]) x++;
      const right = x, key = left + ':' + right;
      let id = exact.get(key);
      if (id === undefined) { id = adjacency.length; adjacency.push([]); }
      current.push({ id, left, right }); owners.fill(id, y * width + left, y * width + right);
    }
    let a = 0, b = 0;
    while (a < previous.length && b < current.length) {
      const p = previous[a], q = current[b];
      if (p.id !== q.id && Math.max(p.left, q.left) < Math.min(p.right, q.right)) {
        const key = Math.min(p.id,q.id) + ':' + Math.max(p.id,q.id);
        if (!keys.has(key)) {
          keys.add(key); const id = edges.length; edges.push([p.id,q.id]);
          adjacency[p.id].push({ v:q.id, e:id }); adjacency[q.id].push({ v:p.id, e:id });
        }
      }
      if (p.right <= q.right) a++;
      if (q.right <= p.right) b++;
    }
    previous = current;
  }
  const from = owners[start], to = owners[finish];
  const seen = new Int32Array(adjacency.length), low = new Int32Array(adjacency.length), bridge = new Uint8Array(edges.length);
  let tick = 1; seen[from] = low[from] = tick;
  const stack = [{ v:from, parent:-1, edge:-1, next:0 }];
  while (stack.length) {
    const frame = stack.at(-1);
    if (frame.next < adjacency[frame.v].length) {
      const next = adjacency[frame.v][frame.next++];
      if (next.e === frame.edge) continue;
      if (seen[next.v]) low[frame.v] = Math.min(low[frame.v], seen[next.v]);
      else {
        seen[next.v] = low[next.v] = ++tick;
        stack.push({ v:next.v, parent:frame.v, edge:next.e, next:0 });
      }
    } else {
      stack.pop();
      if (frame.parent >= 0) {
        if (low[frame.v] > seen[frame.parent]) bridge[frame.edge] = 1;
        low[frame.parent] = Math.min(low[frame.parent], low[frame.v]);
      }
    }
  }
  const parents = new Int32Array(adjacency.length).fill(-1), via = new Int32Array(adjacency.length).fill(-1), queue = [from];
  parents[from] = from;
  for (let head = 0; head < queue.length && parents[to] < 0; head++) {
    for (const next of adjacency[queue[head]]) if (parents[next.v] < 0) {
      parents[next.v] = queue[head]; via[next.v] = next.e; queue.push(next.v);
    }
  }
  assert.ok(parents[to] >= 0);
  let passageEdges = 0;
  for (let v = to; v !== from; v = parents[v]) {
    assert.equal(bridge[via[v]], 1, 'each main-route passage must have no alternative around an obstacle');
    passageEdges++;
  }
  assert.ok(passageEdges >= 4, 'a local empty rectangle cannot masquerade as a winding maze');
}


function verifyNoisy(level, source) {
  const {width,height}=source, count=width*height;
  assert.equal(level.maze.kind,'route-first');
  assert.equal(level.mazeOriginalAnalysis,source);
  assert.equal(level.mazeFloorRects.length,0);
  assert.equal(level.mazeCarvedPaths.length,0,'a usable long gutter must retain its original content');
  assert.equal(level.obstacleIndex.walkableMask,level.analysis.walkableMask);
  const merged=new Uint8Array(count), added=new Uint8Array(count);
  paintRects(merged,width,height,level.mazeMergedObstacles);
  const planned=level.plannedReferencePath;
  assert.ok(planned.length>=2);
  for(const wall of level.mazeWallSegments) {
    assert.equal(wall.width,3);
    assert.ok(wall.anchors.length>=1,'straight gutters may use a short one-ended anchored baffle');
    for(const anchor of wall.anchors) {
      const x=Math.floor(anchor.x), y=Math.floor(anchor.y);
      if(anchor.kind==='viewport') assert.ok(x===0||y===0||x===width-1||y===height-1);
      else assert.ok(source.obstacleMask[y*width+x]||merged[y*width+x],'baffles anchor to the page, not a synthetic frame');
    }
    paintTube(added,width,height,wall.points,wall.width/2);
    for(let i=1;i<wall.points.length;i++) for(let j=1;j<planned.length;j++) {
      assert.ok(segmentDistance(wall.points[i-1],wall.points[i],planned[j-1],planned[j])>=3.5-1e-6,
        'the complete diagonal baffle, including its cap and player radius, avoids the preselected answer');
    }
  }
  for(let i=0;i<count;i++) {
    assert.equal(level.analysis.obstacleMask[i],source.obstacleMask[i]||merged[i]||added[i]);
    if(!source.walkableMask[i]) assert.equal(level.analysis.walkableMask[i],0);
  }
  assert.ok(level.challenge.turns>=4);
  assert.ok(level.referenceLength>=Math.hypot(width,height)*.65);
  assert.ok(Math.hypot(level.nodes[0].x-level.nodes[1].x,level.nodes[0].y-level.nodes[1].y)>=Math.hypot(width,height)*.18);
  for(const node of level.nodes) assert.ok(level.analysis.distanceMap[Math.floor(node.y)*width+Math.floor(node.x)]>=12);
  for(const route of [planned,level.referencePath]) for(let i=1;i<route.length;i++) {
    assert.equal(P.Collision.segmentHits(route[i-1],route[i],level.obstacleIndex),false);
  }
  verifyUniquePassage(level.analysis,level.nodes);
}
for(const step of [24,36,48]) test('noisy 64px native gutter, spacing '+step+', keeps the answer and foreground',()=>{
  const source=noisyGutters(step), before=['obstacleMask','walkableMask','distanceMap'].map(k=>source[k].slice());
  assert.equal(P.MazeGenerator.assess(source).available,true);
  for(const seed of [1,9]) verifyNoisy(P.MazeGenerator.generate(source,[],random(seed)),source);
  for(const [i,key] of ['obstacleMask','walkableMask','distanceMap'].entries()) assert.deepEqual(source[key],before[i]);
});
test('horizontal noisy gutters receive contour-based baffles without full-page replacement',()=>{
  const source=noisyGutters(24,true),level=P.MazeGenerator.generate(source,[],random(1));
  verifyNoisy(level,source);
  for(const node of level.nodes) assert.ok(node.y>170&&node.y<235||node.y>404&&node.y<470,'nodes stay in the original long gutter');
});
