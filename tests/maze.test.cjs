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
    mask[y * width + x] = kind === 'solid' ? 1 : kind === 'cards' || kind === 'mixed' ? Number((kind !== 'mixed' || x < width * .6) && x % 158 < 120 && y % 116 < 84)
      : kind === 'noise' ? Number(x % 37 < 22 && y % 19 < 12) : 0;
  }
  return P.MazeGeometry.rebuild({ width, height, obstacleMask: mask, stats: {} }, [], mask);
}

// Independent four-neighbour flood, deliberately ignoring cached component
// labels and the generator's graph. A portal removes adjacency across its row,
// not pixels or an entire passage that could accidentally hide a bypass.
function flood(mask, width, start, portal = null, seen = new Uint8Array(mask.length)) {
  const queue = new Int32Array(mask.length), height = mask.length / width;
  if (!mask[start] || seen[start]) return { seen, count: 0 };
  let head = 0, tail = 1; queue[0] = start; seen[start] = 1;
  while (head < tail) {
    const at = queue[head++], x = at % width, y = Math.floor(at / width);
    const visit = next => { if (mask[next] && !seen[next]) { seen[next] = 1; queue[tail++] = next; } };
    if (x) visit(at - 1);
    if (x + 1 < width) visit(at + 1);
    const portalX = portal && x >= portal.x && x < portal.x + portal.width;
    if (y && !(portalX && y === portal.y)) visit(at - width);
    if (y + 1 < height && !(portalX && y + 1 === portal.y)) visit(at + width);
  }
  return { seen, count: tail };
}
function largestComponent(mask, width) {
  const seen = new Uint8Array(mask.length); let largest = 0;
  for (let at = 0; at < mask.length; at++) if (mask[at] && !seen[at]) largest = Math.max(largest, flood(mask, width, at, null, seen).count);
  return largest;
}
function pixelPortalAudit(level) {
  const { width, height, walkableMask } = level.analysis;
  const cell = p => Math.floor(p.y) * width + Math.floor(p.x);
  const start = cell(level.nodes[0]), finish = cell(level.nodes[1]);
  assert.equal(flood(walkableMask, width, start).seen[finish], 1, 'final pixels connect start and finish');
  const routeEdges = level.maze.routeEdgeIds;
  if (!routeEdges.length) {
    assert.equal(level.stars,1,'only an easy route can stay in one convex passage');
    const vertex=level.maze.vertices[level.maze.routeVertexIds[0]];
    for(const p of level.nodes)assert.ok(p.x>=vertex.left&&p.x<vertex.right&&p.y>=vertex.top&&p.y<vertex.bottom);
  }
  const count = Math.min(12, routeEdges.length);
  for (let i = 0; i < count; i++) {
    const edgeId = routeEdges[count === 1 ? 0 : Math.round(i * (routeEdges.length - 1) / (count - 1))];
    const portal = level.maze.edges[edgeId].portal;
    assert.ok(portal && [portal.x, portal.y, portal.width].every(Number.isInteger) &&
      portal.x >= 0 && portal.width > 0 && portal.x + portal.width <= width && portal.y > 0 && portal.y < height);
    assert.equal(flood(walkableMask, width, start, portal).seen[finish], 0,
      'closing one claimed bridge must disconnect the actual pixels, not only the reported graph');
  }
}
function rasterThinWalls(walls, width, height) {
  const mask = new Uint8Array(width * height);
  for (const wall of walls) {
    assert.equal(wall.width, 3, 'all added maze walls are three-pixel strokes');
    assert.ok(Array.isArray(wall.points) && wall.points.length >= 2);
    for (const p of wall.points) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
    for (let i = 1; i < wall.points.length; i++) {
      const a = wall.points[i - 1], b = wall.points[i], dx = b.x - a.x, dy = b.y - a.y, square = dx * dx + dy * dy;
      const left = Math.max(0, Math.floor(Math.min(a.x,b.x) - 2)), right = Math.min(width, Math.ceil(Math.max(a.x,b.x) + 2));
      const top = Math.max(0, Math.floor(Math.min(a.y,b.y) - 2)), bottom = Math.min(height, Math.ceil(Math.max(a.y,b.y) + 2));
      for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
        const px = x + .5 - a.x, py = y + .5 - a.y;
        const t = square ? Math.max(0, Math.min(1, (px * dx + py * dy) / square)) : 0;
        if ((px - t * dx) ** 2 + (py - t * dy) ** 2 <= 2.25 + 1e-8) mask[y * width + x] = 1;
      }
    }
  }
  return mask;
}
function wallAttachmentAudit(walls, base, width) {
  const seen = new Uint8Array(walls.length), queue = new Int32Array(walls.length), height = walls.length / width;
  for (let first = 0; first < walls.length; first++) if (walls[first] && !seen[first]) {
    let head = 0, tail = 1, anchored = false; queue[0] = first; seen[first] = 1;
    while (head < tail) {
      const at = queue[head++], x = at % width, y = Math.floor(at / width);
      anchored ||= Boolean(base[at] || !x || !y || x === width - 1 || y === height - 1);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
        const next = at + dy * width + dx;
        anchored ||= Boolean(base[next]);
        if (walls[next] && !seen[next]) { seen[next] = 1; queue[tail++] = next; }
      }
    }
    assert.equal(anchored, true, 'new wall components attach to page foreground or the viewport, never a floating outline');
  }
}
function pagePreservationAudit(level, source, kind) {
  const { width, height, obstacleMask: original, walkableMask: originalWalkable } = source;
  const final = level.analysis.obstacleMask, base = new Uint8Array(original);
  assert.equal(level.mazeOpenings.length, 0, 'a page with connected natural background needs no foreground excavation');
  assert.equal(level.mazeCarvedPaths.length, 0, 'natural background must not be replaced with a carved answer tube');
  for (const rect of level.mazeMergedObstacles) {
    assert.ok([rect.x,rect.y,rect.width,rect.height].every(Number.isInteger));
    assert.ok(rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 &&
      rect.x + rect.width <= width && rect.y + rect.height <= height);
    assert.ok(rect.width <= 72 && rect.height <= 36 && rect.width * rect.height <= 1800, 'only compact foreground clusters can merge');
    for (let y = rect.y; y < rect.y + rect.height; y++) base.fill(1, y * width + rect.x, y * width + rect.x + rect.width);
  }
  assert.ok(level.mazeWallSegments.length > 0, 'new walls are declared as auditable geometry');
  const added = rasterThinWalls(level.mazeWallSegments, width, height);
  let cleared = 0, unexplained = 0, missing = 0;
  for (let at = 0; at < original.length; at++) {
    cleared += original[at] && !final[at] ? 1 : 0;
    const expected = Boolean(base[at] || added[at]);
    unexplained += final[at] && !expected ? 1 : 0;
    missing += expected && !final[at] ? 1 : 0;
  }
  assert.equal(cleared, 0, 'existing content pixels and large obstacle silhouettes remain intact');
  assert.equal(unexplained, 0, 'no unreported shells, filled rooms or bounding-box walls may be added');
  assert.equal(missing, 0, 'the final obstacle mask exactly includes the declared thin strokes and compact merges');
  wallAttachmentAudit(added, base, width);
  const start = Math.floor(level.nodes[0].y) * width + Math.floor(level.nodes[0].x);
  const reachable = flood(level.analysis.walkableMask, width, start).seen;
  let retained = 0;
  for (let at = 0; at < reachable.length; at++) retained += reachable[at] && originalWalkable[at] ? 1 : 0;
  const sourceArea = largestComponent(originalWalkable, width), minimum = kind === 'blank' ? .70 : .60;
  assert.ok(retained >= sourceArea * minimum,
    'the player must retain access to ' + Math.round(minimum * 100) + '% of the native background, not an isolated answer tube (' + retained + '/' + sourceArea + ')');
  const sourceIndex = P.Collision.createMaskIndex(source);
  for (let i = 1; i < level.referencePath.length; i++) assert.equal(P.Collision.segmentHits(level.referencePath[i - 1],level.referencePath[i],sourceIndex), false,
    'the final answer stays inside original page passages');
  if (kind === 'blank') assert.ok(level.mazeWallSegments.some(wall => wall.points.some((p,i) => i &&
    Math.abs(p.x-wall.points[i-1].x)>=8 && Math.abs(p.y-wall.points[i-1].y)>=8 &&
    Math.hypot(p.x-wall.points[i-1].x,p.y-wall.points[i-1].y)>=32)), 'empty pages use noticeable slanted walls, not a rectangular grid');
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

test('every valid screenshot is eligible, with no obstacle area or distribution lock',()=>{
  for(const kind of ['blank','solid','cards','mixed','noise']) assert.equal(P.MazeGenerator.assess(fixture(kind)).available,true);
  assert.equal(P.MazeGenerator.assess(null).available,false);
  assert.equal(P.MazeGenerator.assess({kind:'pixel-mask',width:1,height:1}).available,false);
});
for(const kind of ['blank','solid','cards','mixed','noise']) test(kind+' screenshots always create a unique playable maze across random intensities',()=>{
  const source=fixture(kind),before=source.obstacleMask.slice();
  for(const seed of [29,62]) {
    const level=P.LevelGenerator.generate(source,[],rng(seed));verify(level,source);
    assert.ok(level.stars===1||level.challenge.deadEnds>=1,'harder maps retain real wrong-turn arms');
    assert.equal(level.maze.construction.uniqueStartFinish,true);
    const opened=new Uint8Array(source.width*source.height);
    for(const r of level.mazeOpenings)for(let y=r.y;y<r.y+r.height;y++)opened.fill(1,y*source.width+r.x,y*source.width+r.x+r.width);
    for(let i=0;i<opened.length;i++)if(source.obstacleMask[i]&&!level.analysis.obstacleMask[i]) assert.equal(opened[i],1,'opened foreground is recorded in map metadata');
    assert.deepEqual(source.obstacleMask,before);
    pixelPortalAudit(level);
    if (['blank','cards','mixed'].includes(kind)) pagePreservationAudit(level,source,kind);
  }
});
test('compact and portrait viewports remain playable with a reserved toolbar',()=>{
  for(const [width,height]of[[320,240],[360,640]])for(const seed of [8,25]){
    const source=fixture('solid',width,height),reserved=[{x:0,y:0,width:280,height:60}];
    const level=P.LevelGenerator.generate(source,reserved,rng(seed));verify(level,source);
    const rect=level.toolbarRect||reserved[0];
    for(const p of level.nodes)assert.ok(p.x<rect.x-12||p.x>rect.x+rect.width+12||p.y<rect.y-12||p.y>rect.y+rect.height+12);
  }
});
test('contours, distance map, collisions and routes all share final pixels',()=>{
  const source=fixture('cards'),level=P.LevelGenerator.generate(source,[],rng(31)),m=level.analysis;
  assert.equal(m.contours.segments.length%4,0);
  for(let i=0;i<m.walkableMask.length;i++)assert.equal(Boolean(m.walkableMask[i]),m.distanceMap[i]>m.stats.walkableThreshold);
  for(let i=0;i<m.contours.segments.length;i+=4){
    const [x,y,x2,y2]=m.contours.segments.slice(i,i+4),mx=(x+x2)/2,my=(y+y2)/2;
    const read=(xx,yy)=>xx<0||yy<0||xx>=m.width||yy>=m.height?0:m.walkableMask[Math.floor(yy)*m.width+Math.floor(xx)];
    assert.notEqual(x===x2?read(mx-.5,my):read(mx,my-.5),x===x2?read(mx+.5,my):read(mx,my+.5));
  }
});
