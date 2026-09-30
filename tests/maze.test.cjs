'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const context = vm.createContext({});
for (const file of ['config', 'collision', 'mazeCleanup', 'mazeRoute', 'mazeConnectors', 'mazeGenerator', 'routeMazeGenerator']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/content', `${file}.js`), 'utf8'), context);
const P = context.__PAGEPATH__;
function random(seed) {
  return () => {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rect = (x, y, width, height) => ({ x, y, width, height });
// Staggered foreground content; the browser suite independently analyzes a
// real editorial gallery screenshot with the same kind of natural passages.
const wideRects = [rect(0, 34, 516, 251), rect(556, 34, 690, 251), rect(34, 325, 795, 250),
  rect(869, 325, 377, 250), rect(34, 615, 377, 251), rect(451, 615, 795, 251)];
const compactRects = [rect(28, 28, 333, 381), rect(393, 28, 242, 381), rect(667, 28, 425, 381),
  rect(28, 441, 242, 381), rect(302, 441, 425, 381), rect(759, 441, 333, 381)];
const crowdedRects = [[4, 3, 5], [3, 5, 4], [5, 4, 3], [3, 4, 5]].flatMap((spans, row) => {
  const unit = (1280 - 56 - 11 * 32) / 12;
  let used = 0;
  return spans.map((span, column) => {
    const x = row === 0 && column === 0 ? 0 : Math.round(28 + used * (unit + 32));
    const right = Math.round(28 + (used + span) * (unit + 32) - 32);
    used += span;
    return rect(x, 28 + row * 244, right - x, 212);
  });
});
// Seventy-two separate pieces of page content, with staggered column widths
// and 32px existing gaps. Only the first piece touches the viewport boundary.
const manyIslandRects = Array.from({ length: 8 }, (_, row) => {
  const weights = [8, 10, 9, 11, 8, 10, 9, 11, 9];
  const spans = weights.map((_, column) => weights[(column + row * 2) % weights.length]);
  const contentWidth = 1400 - 56 - 8 * 32, total = spans.reduce((sum, value) => sum + value, 0);
  const top = Math.round(28 + row * 134.5), bottom = Math.round(28 + row * 134.5 + 102.5);
  let used = 0;
  return spans.map((span, column) => {
    const x = row === 0 && column === 0 ? 0 : Math.round(28 + used / total * contentWidth + column * 32);
    used += span;
    const right = Math.round(28 + used / total * contentWidth + column * 32);
    return rect(x, top, right - x, bottom - top);
  });
}).flat();
function fixture(rects, width, height) {
  const obstacleMask = new Uint8Array(width * height), walkableMask = new Uint8Array(width * height);
  const distanceMap = new Float32Array(width * height), threshold = 2 + Math.SQRT1_2;
  const bounds = rects.map(r => [r.x, r.y, r.x + r.width - 1, r.y + r.height - 1]);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const edge = Math.min(x + 0.5, y + 0.5, width - x - 0.5, height - y - 0.5);
    let squared = edge * edge;
    for (const [left, top, right, bottom] of bounds) {
      const dx = x < left ? left - x : x > right ? x - right : 0;
      const dy = y < top ? top - y : y > bottom ? y - bottom : 0;
      squared = Math.min(squared, dx * dx + dy * dy);
      if (squared === 0) break;
    }
    const distance = Math.sqrt(squared);
    const at = y * width + x;
    obstacleMask[at] = distance === 0 ? 1 : 0; distanceMap[at] = distance;
    walkableMask[at] = distance > threshold ? 1 : 0;
  }
  return { kind: 'pixel-mask', width, height, maskWidth: width, maskHeight: height,
    obstacleMask, walkableMask, distanceMap, stats: { clearance: 2, walkableThreshold: threshold } };
}
function enclosedPocket(width = 640, height = 480, hole = rect(250, 220, 110, 34)) {
  return fixture([rect(0, 0, width, hole.y),
    rect(0, hole.y + hole.height, width, height - hole.y - hole.height),
    rect(0, hole.y, hole.x, hole.height),
    rect(hole.x + hole.width, hole.y, width - hole.x - hole.width, hole.height)], width, height);
}
const wide = fixture(wideRects, 1280, 900), compact = fixture(compactRects, 1120, 850);
const reserved = [rect(410, 12, 340, 60)];
function verifyMazeExtent(level, source) {
  const diagonal = Math.hypot(source.width, source.height), [a, b] = level.nodes;
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= Math.max(80, diagonal * 0.18), 'endpoints cannot cluster in a local pocket');
  assert.ok(level.referenceLength >= Math.max(220, diagonal * 0.65), 'a short local segment is not a maze');
  const xs = level.referencePath.map(p => p.x), ys = level.referencePath.map(p => p.y);
  assert.ok(Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) >= Math.max(128, diagonal * 0.32));
  for (const p of level.nodes) assert.ok(level.analysis.distanceMap[Math.floor(p.y) * source.width + Math.floor(p.x)] >= 12,
    'the inkstone and paper must fit without overlapping foreground or new walls');
  assert.ok(level.challenge.turns >= 4, 'do not replace a failed maze with a straight path');
}
function flood(mask, width, start, connectivity = 4) {
  const visited = new Uint8Array(mask.length), queue = new Int32Array(mask.length);
  let head = 0, tail = 0;
  for (const at of start) if (mask[at] && !visited[at]) { visited[at] = 1; queue[tail++] = at; }
  while (head < tail) {
    const at = queue[head++], x = at % width;
    const next = [x ? at - 1 : -1, x + 1 < width ? at + 1 : -1, at - width, at + width];
    if (connectivity === 8) next.push(x ? at - width - 1 : -1, x + 1 < width ? at - width + 1 : -1,
      x ? at + width - 1 : -1, x + 1 < width ? at + width + 1 : -1);
    for (const i of next) if (i >= 0 && i < mask.length && mask[i] && !visited[i]) { visited[i] = 1; queue[tail++] = i; }
  }
  return visited;
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

function verify(level, source, { allowCarving = false, toolbar = [] } = {}) {
  verifyMazeExtent(level, source);
  assert.equal(level.mode, 'maze'); assert.equal(level.maze.kind, 'route-first');
  assert.equal(level.mazeOriginalAnalysis, source);
  assert.equal(level.unlimitedInk, true); assert.equal(level.maxInk, Infinity);
  assert.equal(level.obstacleIndex.walkableMask, level.analysis.walkableMask);
  assert.equal(level.mazeFloorRects.length, 0, 'no full-page paper roads or grid-floor replacement');
  assert.ok(Array.isArray(level.mazeWallSegments));
  assert.ok(Array.isArray(level.plannedReferencePath) && level.plannedReferencePath.length >= 2, 'the route must be fixed before placing walls');
  const planned = level.plannedReferencePath, same = (a,b) => Math.hypot(a.x-b.x,a.y-b.y) < 1e-7;
  assert.ok(same(planned[0], level.nodes[0]) && same(planned.at(-1), level.nodes[1]) ||
    same(planned[0], level.nodes[1]) && same(planned.at(-1), level.nodes[0]), 'wall placement cannot replace the planned endpoints');
  const { width, height } = source, count = width * height, merged = new Uint8Array(count), walls = new Uint8Array(count), opened = new Uint8Array(count);
  paintRects(merged, width, height, level.mazeMergedObstacles);
  const carved = level.mazeCarvedPaths || [];
  if (!allowCarving) assert.equal(carved.length, 0, 'usable native passages must not be replaced by an excavated map');
  assert.ok(carved.length <= 3, 'exceptional opening remains a few route tubes, not a whole branching grid');
  for (const opening of carved) {
    assert.ok(opening.radius <= 18, 'exceptional opening must remain a narrow route tube');
    paintTube(opened, width, height, opening.points, opening.radius);
  }
  for (const wall of level.mazeWallSegments) {
    assert.equal(wall.width, 3);
    assert.ok(wall.points.length >= 2 && wall.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
    assert.ok(wall.anchors.length >= 1, 'added lines must attach to existing content');
    for (const anchor of wall.anchors) {
      const x = Math.floor(anchor.x), y = Math.floor(anchor.y);
      assert.ok(x >= 0 && y >= 0 && x < width && y < height);
      if (anchor.kind === 'viewport') assert.ok(x === 0 || y === 0 || x === width-1 || y === height-1);
      else {
        assert.equal(anchor.kind, 'obstacle');
        assert.ok(source.obstacleMask[y*width+x] || merged[y*width+x], 'anchors come from the pre-wall page, never another generated line');
      }
      assert.ok(same(anchor, wall.points[0]) || same(anchor, wall.points.at(-1)), 'anchors are actual polyline endpoints');
    }
    paintTube(walls, width, height, wall.points, wall.width/2);
    for (let i = 1; i < wall.points.length; i++) for (let j = 1; j < planned.length; j++) {
      assert.ok(segmentDistance(wall.points[i-1],wall.points[i],planned[j-1],planned[j]) >=
        wall.width/2 + (source.stats.clearance ?? 2) - 1e-6, 'real wall geometry must leave player clearance around the protected answer');
    }
  }
  let removed = 0, newBlocked = 0;
  for (let i = 0; i < count; i++) {
    const before = source.obstacleMask[i], after = level.analysis.obstacleMask[i];
    if (before && !after) { assert.equal(opened[i], 1, 'foreground may only be opened inside declared narrow tubes'); removed++; }
    if (!before && after) { assert.ok(merged[i] || walls[i], 'every added obstacle pixel must be a cleanup region or real polyline stroke'); newBlocked++; }
    if (!allowCarving) assert.equal(after, before || merged[i] || walls[i], 'native page content is preserved exactly plus declared additions');
  }
  if (carved.length) assert.ok(removed > 0);
  assert.ok(removed / count < 0.5, 'even an exceptional opening cannot erase most of the screenshot');
  for (const name of ['rows','columns','gridRows','gridColumns']) assert.equal(Object.hasOwn(level.maze.construction || {}, name), false);
  let routeLength = 0, turns = 0;
  for (const route of [planned, level.referencePath]) for (let i = 1; i < route.length; i++) {
    assert.equal(P.Collision.segmentHits(route[i-1], route[i], level.obstacleIndex), false, 'planned and final routes both fit the final cached mask');
  }
  for (let i = 1; i < level.referencePath.length; i++) routeLength += Math.hypot(level.referencePath[i].x-level.referencePath[i-1].x,level.referencePath[i].y-level.referencePath[i-1].y);
  for (let i = 1; i+1 < level.referencePath.length; i++) {
    const a=level.referencePath[i-1],b=level.referencePath[i],c=level.referencePath[i+1], ab=Math.hypot(b.x-a.x,b.y-a.y),bc=Math.hypot(c.x-b.x,c.y-b.y);
    if (ab>=12 && bc>=12 && ((b.x-a.x)*(c.x-b.x)+(b.y-a.y)*(c.y-b.y))/ab/bc < Math.cos(Math.PI/6)) turns++;
  }
  assert.ok(turns >= 4, 'measure genuine turns instead of trusting challenge metadata');
  assert.ok(Math.abs(routeLength-level.referenceLength) < 1e-6);
  const reserved = level.toolbarRect ? [level.toolbarRect] : toolbar;
  for (const node of level.nodes) for (const r of reserved) assert.equal(
    node.x>=r.x-12 && node.x<=r.x+r.width+12 && node.y>=r.y-12 && node.y<=r.y+r.height+12, false);
  verifyUniquePassage(level.analysis, level.nodes);
  return { removed, newBlocked };
}
function preserve(source, action) {
  const before = ['obstacleMask','walkableMask','distanceMap'].map(name => source[name].slice());
  const result = action();
  for (const [i,name] of ['obstacleMask','walkableMask','distanceMap'].entries()) assert.deepEqual(source[name],before[i]);
  return result;
}

test('the original two advertised metrics still govern unlocking', () => {
  const expected = P.Config.MAZE_REQUIREMENTS;
  assert.deepEqual(Object.keys(expected).sort(), ['minObstacleRatio','minOccupiedRegions']);
  assert.equal(expected.minObstacleRatio,.2); assert.equal(expected.minOccupiedRegions,30);
  for (const source of [null, fixture([],400,300), fixture([rect(80,60,30,30)],640,480)]) {
    const status=P.MazeGenerator.assess(source); assert.equal(status.available,false); assert.deepEqual(status.requirements,expected);
  }
  const exact=fixture(Array.from({length:8},(_,col)=>rect(col*50,0,10,300)),400,300);
  assert.equal(P.MazeGenerator.assess(exact).available,true);
  assert.equal(P.MazeGenerator.assess(exact).obstacleRatio,.2);
  const below={...exact,obstacleMask:exact.obstacleMask.slice(),stats:{...exact.stats,obstacleRatio:.99}};
  below.obstacleMask[0]=0; assert.equal(P.MazeGenerator.assess(below).available,false);
  assert.throws(()=>P.MazeGenerator.generate(below), /20%/);
});

test('wide and compact native galleries retain their content while the fixed answer receives safe connectors', () => {
  for (const source of [wide,compact]) preserve(source,()=> {
    const signatures=new Set();
    for (const seed of [1,7,82]) {
      const level=P.MazeGenerator.generate(source,reserved,random(seed));
      verify(level,source,{toolbar:reserved});
      signatures.add(JSON.stringify({nodes:level.nodes,walls:level.mazeWallSegments}));
    }
    assert.ok(signatures.size>=2,'new maps vary endpoint or connector choices');
  });
});
test('twelve and seventy-two content islands can be connected without line-count quotas or artificial grid walls', () => {
  for (const source of [fixture(crowdedRects,1280,1000),fixture(manyIslandRects,1400,1100)]) {
    assert.equal(P.MazeGenerator.assess(source).available,true);
    preserve(source,()=>verify(P.MazeGenerator.generate(source,reserved,random(17)),source,{toolbar:reserved}));
  }
});
test('a broad native background remains eligible and is not paved over with a grid', () => {
  const source=fixture(wideRects,1280,990);
  assert.equal(P.MazeGenerator.assess(source).available,true);
  preserve(source,()=>verify(P.MazeGenerator.generate(source,reserved,random(19)),source,{toolbar:reserved}));
});
test('solid foreground and tiny isolated holes permit only limited route-shaped openings', () => {
  for (const source of [fixture([rect(0,0,640,480)],640,480),enclosedPocket(),enclosedPocket(640,480,rect(150,200,340,64))]) {
    assert.equal(P.MazeGenerator.assess(source).available,true);
    preserve(source,()=> {
      for (const seed of [1,17]) {
        const level=P.MazeGenerator.generate(source,[],random(seed));
        const audit=verify(level,source,{allowCarving:true});
        assert.ok(audit.removed>0 && level.mazeCarvedPaths.length>0);
      }
    });
  }
});
test('a large bounded background room uses its own space without cutting a replacement map', () => {
  const source=enclosedPocket(640,480,rect(40,110,560,260));
  preserve(source,()=>verify(P.MazeGenerator.generate(source,[],random(7)),source));
});
test('fragmented cells and a narrow passage keep endpoint space and maze extent through limited opening', () => {
  const bars=[0,140,280,420,560].map(x=>rect(x,0,40,430));
  bars.push(...[0,140,280,420].map(y=>rect(0,y,620,Math.min(40,430-y))));
  for (const source of [fixture(bars,620,430),fixture([rect(0,0,152,300),rect(168,0,152,300)],320,300)]) {
    preserve(source,()=> {
      try { verify(P.MazeGenerator.generate(source,[],random(44)),source,{allowCarving:true}); }
      catch(error) { error.message=source.width+'x'+source.height+': '+error.message; throw error; }
    });
  }
});
test('toolbar movement changes endpoint reservation without becoming an eligibility condition', () => {
  const natural=P.MazeGenerator.generate(wide,reserved,random(11));
  const toolbar=natural.nodes.map(p=>rect(p.x-35,p.y-35,70,70));
  assert.equal(P.MazeGenerator.assess(wide,toolbar).available,true);
  preserve(wide,()=>verify(P.MazeGenerator.generate(wide,toolbar,random(23)),wide,{toolbar}));
});
test('seeded regeneration owns independent final masks and keeps the original screenshot immutable', () => {
  preserve(wide,()=> {
    const a=P.MazeGenerator.generate(wide,reserved,random(32)),b=P.MazeGenerator.generate(wide,reserved,random(32));
    assert.deepEqual(a.mazeWallSegments,b.mazeWallSegments); assert.deepEqual(a.nodes,b.nodes);
    assert.deepEqual(a.analysis.walkableMask,b.analysis.walkableMask);
    assert.notEqual(a.analysis.walkableMask,b.analysis.walkableMask);
  });
});
test('cached distance and contour boundaries agree with final pixels for the same collision map', () => {
  const level=P.MazeGenerator.generate(wide,reserved,random(231));
  const {width,height,obstacleMask,walkableMask,distanceMap,contours}=level.analysis,rand=random(9191),threshold=level.analysis.stats.walkableThreshold;
  for (let sample=0;sample<300;sample++) {
    const x=Math.floor(rand()*width),y=Math.floor(rand()*height),at=y*width+x;
    assert.equal(Boolean(walkableMask[at]),distanceMap[at]>threshold && !obstacleMask[at]);
    assert.equal(P.Collision.pointHits({x:x+.5,y:y+.5},level.obstacleIndex),!walkableMask[at]);
  }
  const free=(x,y)=>x>=0&&y>=0&&x<width&&y<height?walkableMask[y*width+x]:0;
  for(let i=0;i<contours.segments.length;i+=4) {
    const [x1,y1,x2,y2]=contours.segments.slice(i,i+4);
    if(x1===x2) for(let y=y1;y<y2;y++) assert.notEqual(free(x1-1,y),free(x1,y));
    else for(let x=x1;x<x2;x++) assert.notEqual(free(x,y1-1),free(x,y1));
  }
});
