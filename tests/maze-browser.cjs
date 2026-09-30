'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.resolve(path.dirname(process.execPath), '../node_modules/playwright')); }
const candidate = process.env.PAGEPATH_BROWSER || (process.platform === 'win32'
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined);
const executablePath = candidate && fs.existsSync(candidate) ? candidate : undefined;
const control = (page, selector) => page.locator(`[data-pagepath-root] ${selector}`);
const state = page => page.evaluate(() => globalThis.__PAGEPATH__?.instance?.state);
function assertLockedMazeDetails(info) {
  assert.equal(info.disabled, true);
  assert.equal(info.availability.available, false);
  assert.equal(info.availability.obstacleRatio, info.sourceObstacleRatio, 'the unlock tooltip uses original screenshot density');
  assert.equal(info.availability.occupiedRegions, info.sourceOccupiedRegions, 'dispersion comes from original foreground pixels');
  assert.equal(info.title, ''); assert.equal(info.hoverTitle, '', 'the locked entry has no native long title');
  assert.equal(info.tooltipVisible, true);
  assert.equal(info.tooltipText.replace(/\s/g, ''), '寻找复杂的页面来解锁第二关。复杂度分散度', 'the tooltip contains the unlock instruction and two criteria');
  assert.doesNotMatch(info.tooltipText, /[0-9%≥≤]|目标|原因/);
  assert.deepEqual(info.criteria.map(item => item.kind), ['complexity', 'distribution']);
  const expected = [info.sourceObstacleRatio >= .2, info.sourceOccupiedRegions >= 30];
  info.criteria.forEach((item, index) => {
    assert.equal(item.passed, String(expected[index]));
    assert.equal(item.color, expected[index] ? 'rgb(57, 115, 63)' : 'rgb(179, 69, 63)', 'checks are green and crosses are red');
    assert.equal(item.mark, expected[index] ? 'M3 8L6.5 11.5L13 4.5' : 'M4 4L12 12M12 4L4 12', 'the mark shows the corresponding check or cross');
  });
  assert.ok(info.opacities.every(value => value === '1'), 'the locked padlock retains normal opacity');
  assert.notEqual(info.lockedDisplay, 'none');
  assert.equal(info.unlockedDisplay, 'none');
}
async function verifyUnlockedMaze(page) {
  const entry = control(page, '.mode-button[data-mode="maze"]');
  assert.equal(await entry.isDisabled(), false);
  assert.equal(await entry.getAttribute('title'), '第二关');
  assert.equal(await control(page, '.maze-mode-slot').getAttribute('title'), '第二关');
  assert.equal(await entry.locator('.maze-locked-mark').isVisible(), false);
  assert.equal(await entry.locator('.maze-unlocked-mark').isVisible(), true);
  await control(page, '.maze-mode-slot').hover();
  assert.equal(await control(page, '.maze-tooltip').isVisible(), false, 'unlocked stars do not show the locked criteria tooltip');
}
async function ready(page) {
  await page.waitForFunction(() => {
    const game = globalThis.__PAGEPATH__?.instance;
    return ['READY', 'PAUSED'].includes(game?.state) || game?.state === 'FAILED' && game.generationFailed;
  }, null, { timeout: 60000 });
  assert.equal(await state(page), 'READY', await control(page, '.message').textContent());
}
async function preserveSource(page) {
  await page.evaluate(() => {
    const game = __PAGEPATH__.instance, source = game.snapshot.analysis;
    window.mazeSource = { source, snapshot: game.snapshot,
      obstacle: source.obstacleMask.slice(), walkable: source.walkableMask.slice(),
      distance: source.distanceMap.slice(), contours: source.contours.segments.slice() };
  });
}
async function sourceUnchanged(page) {
  assert.equal(await page.evaluate(() => {
    const { source, snapshot, obstacle, walkable, distance, contours } = mazeSource;
    const game = __PAGEPATH__.instance;
    return game.snapshot === snapshot && game.snapshot.analysis === source &&
      source.obstacleMask.every((value, index) => value === obstacle[index]) &&
      source.walkableMask.every((value, index) => value === walkable[index]) &&
      source.distanceMap.every((value, index) => value === distance[index]) &&
      source.contours.segments.every((value, index) => value === contours[index]);
  }), true, 'maze walls never mutate the cached screenshot maps or trigger a recapture');
}

async function verifyTransparentWalls(page, requireLocalWall = false) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  const result = await page.evaluate(() => {
    const game = __PAGEPATH__.instance, overlay = game.overlay, map = game.analysis,
      source = game.level?.mazeSourceAnalysis || mazeSource.source;
    const read = (mask, x, y) => x >= 0 && y >= 0 && x < map.width && y < map.height && Boolean(mask[y * map.width + x]);
    function inspect(path, local) {
      let invalid = 0, addedBoundary = 0, count = 0, far = 0;
      for (const part of path.matchAll(/M([-\d.e+]+),([-\d.e+]+)L([-\d.e+]+),([-\d.e+]+)/g)) {
        const [x1, y1, x2, y2] = part.slice(1).map(Number), horizontal = y1 === y2;
        if (!horizontal && x1 !== x2) { invalid++; continue; }
        const first = horizontal ? Math.min(x1, x2) : Math.min(y1, y2);
        const last = horizontal ? Math.max(x1, x2) : Math.max(y1, y2);
        for (let at = Math.floor(first); at < last; at++) {
          const a = horizontal ? [at, y1 - 1] : [x1 - 1, at], b = horizontal ? [at, y1] : [x1, at];
          const freeA = read(map.walkableMask, ...a), freeB = read(map.walkableMask, ...b);
          if (freeA === freeB) invalid++;
          else if (read(source.walkableMask, ...(freeA ? b : a))) addedBoundary++;
          if (local && overlay.lastBrushPoint) {
            const middle = (Math.max(first, at) + Math.min(last, at + 1)) / 2;
            const x = horizontal ? middle : x1, y = horizontal ? y1 : middle;
            if (Math.hypot(x - overlay.lastBrushPoint.x, y - overlay.lastBrushPoint.y) > __PAGEPATH__.Config.PIXEL_MAP.WARNING_DISTANCE + .01) far++;
          }
          count++;
        }
      }
      return { invalid, addedBoundary, count, far };
    }
    return { children: overlay.mazeWallLayer.childElementCount,
      global: inspect(overlay.obstacleShape.getAttribute('d') || '', false),
      local: inspect(overlay.obstacleWarning.getAttribute('d') || '', true),
      allHref: overlay.allObstacles.getAttribute('href'), flashHref: overlay.obstacleFlash.getAttribute('href'),
      opacity: Number(overlay.obstacleWarning.getAttribute('opacity')) };
  });
  assert.equal(result.children, 0, 'new maze walls have no always-visible geometry');
  assert.equal(result.global.invalid, 0, 'global outlines still follow exact collision boundaries');
  assert.equal(result.global.addedBoundary, 0, 'the new-map flash cannot reveal newly added wall boundaries globally');
  assert.equal(result.allHref, '#pagepath-obstacles'); assert.equal(result.flashHref, result.allHref);
  assert.equal(result.local.invalid, 0, 'local red warnings follow actual final walkable boundaries');
  assert.equal(result.local.far, 0, 'new walls only reveal the nearby contour segment');
  if (requireLocalWall) assert.ok(result.local.addedBoundary > 0 && result.opacity > 0, 'approaching an invisible wall reveals its collision contour without a hint feature');
}

async function verifyNoMazeHint(page) {
  const result = await page.evaluate(() => {
    const game = __PAGEPATH__.instance, overlay = game.overlay;
    game.toggleHint();
    overlay.renderHint(true);
    return { mode: game.mode, hidden: overlay.hintButton.hidden, disabled: overlay.hintButton.disabled,
      visible: getComputedStyle(overlay.hintButton).display !== 'none', pressed: overlay.hintButton.getAttribute('aria-pressed'),
      hintVisible: game.hintVisible, answerChildren: overlay.hintLayer.childElementCount,
      obstacles: getComputedStyle(overlay.allObstacles).visibility };
  });
  assert.deepEqual(result, { mode: 'maze', hidden: true, disabled: true, visible: false,
    pressed: 'false', hintVisible: false, answerChildren: 0, obstacles: 'hidden' },
  'the second level hides and disables hints, including programmatic game and rendering calls');
}

async function auditMaze(page, natural = true) {
  const result = await page.evaluate(natural => {
    const P = __PAGEPATH__, game = P.instance, level = game.level, source = mazeSource.source, map = game.analysis;
    const assert = {
      ok(value, message) { if (!value) throw new Error(message || 'expected true'); },
      equal(actual, expected, message) { if (actual !== expected) throw new Error((message || 'values differ') + ': ' + actual + ' / ' + expected); }
    };
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
  assert.ok(passageEdges >= 4, 'main passage is too simple: '+JSON.stringify({passageEdges,width,height,nodes,
    directBlocked:P.Collision.segmentHits(nodes[0],nodes[1],P.Collision.createMaskIndex(map))}));
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

    let audit;
    try { audit = verify(level, source, { allowCarving: !natural, toolbar: game.overlay.getReservedRects() }); }
    catch (error) { throw new Error(error.message+' | planning='+JSON.stringify(level.maze.construction)); }
    assert.equal(game.collisionIndex.walkableMask, map.walkableMask);
    assert.equal(game.overlay.pixelMap, map);
    const openings = level.mazeOpenings || [], openingMask = new Uint8Array(source.width * source.height), mergedMask = new Uint8Array(openingMask.length);
    paintRects(openingMask, source.width, source.height, openings);
    paintRects(mergedMask, source.width, source.height, level.mazeMergedObstacles);
    for (let i = 0; i < openingMask.length; i++) assert.equal(openingMask[i],
      (source.obstacleMask[i] || mergedMask[i]) && !level.mazeSourceAnalysis.obstacleMask[i] ? 1 : 0,
      'opening fill covers only foreground actually removed before adding walls');
    if (openings.length) {
      const layer = game.overlay.mazeFloorLayer, shape = layer.querySelector('path');
      assert.equal(layer.childElementCount, 1, 'only the actual opening pixel runs are painted');
      assert.equal(shape?.getAttribute('d'), openings.map(r => 'M'+r.x+','+r.y+'h'+r.width+'v'+r.height+'h-'+r.width+'Z').join(''));
    } else assert.equal(game.overlay.mazeFloorLayer?.childElementCount || 0, 0, 'native pages have no opening overlay');
    assert.equal(game.overlay.mazeWallLayer.childElementCount, 0, 'thin walls stay transparent');
    return { ...audit, connectors: level.mazeWallSegments.length, openings: level.mazeCarvedPaths.length,
      referenceLength: level.referenceLength, turns: level.challenge.turns,
      originalObstacleRatio: game.mazeAvailability.obstacleRatio };
  }, natural);
  return result;
}

async function verifyWarningsAndCollision(page) {
  const start = await page.evaluate(() => __PAGEPATH__.instance.level.nodes[0]);
  await verifyNoMazeHint(page);
  await page.mouse.move(start.x, start.y);
  await page.mouse.click(start.x, start.y);
  assert.equal(await state(page), 'DRAWING', 'one click starts the mouse stroke without holding the button');
  await page.waitForFunction(() => __PAGEPATH__.instance.overlay.obstacleWarning.getAttribute('d'));
  const warning = await page.evaluate(() => {
    const overlay = __PAGEPATH__.instance.overlay;
    return { visible: Number(overlay.obstacleWarning.getAttribute('opacity')) > 0,
      stroke: Number(overlay.obstacleWarning.getAttribute('stroke-width')),
      ink: overlay.cursorInk.textContent, inkLabel: overlay.cursorInk.getAttribute('aria-label') };
  });
  assert.equal(warning.visible, true, 'nearby maze collision boundaries retain the red warning');
  assert.ok(warning.stroke >= 1.8);
  assert.equal(warning.ink, '∞');
  assert.equal(warning.inkLabel, '无限墨水');
  const approach = await page.evaluate(() => {
    const P = __PAGEPATH__, { level } = P.instance, start = level.nodes[0], finish = level.nodes[1];
    const { width, height, walkableMask } = level.analysis;
    const originalIndex = P.Collision.createMaskIndex(mazeSource.source), targets = [];
    for (const line of level.mazeWallSegments) for (let i = 1; i < line.points.length; i++) {
      const a = line.points[i - 1], b = line.points[i], length = Math.hypot(b.x-a.x,b.y-a.y);
      if (!length) continue;
      const nx = -(b.y-a.y)/length, ny = (b.x-a.x)/length;
      for (const fraction of [.25,.5,.75]) {
        const wall = { x:a.x+(b.x-a.x)*fraction, y:a.y+(b.y-a.y)*fraction };
        for (const sign of [-1,1]) {
          const near = { x:Math.floor(wall.x+nx*sign*7)+.5, y:Math.floor(wall.y+ny*sign*7)+.5 };
          if (near.x<0||near.y<0||near.x>=width||near.y>=height ||
              P.Collision.pointHits(near,level.obstacleIndex) ||
              P.Collision.segmentHits(near,wall,originalIndex) ||
              !P.Collision.segmentHits(near,wall,level.obstacleIndex)) continue;
          targets.push({near,wall,at:Math.floor(near.y)*width+Math.floor(near.x)});
        }
      }
    }
    const parent = new Int32Array(width * height).fill(-1), queue = new Int32Array(width * height);
    const from = Math.floor(start.y) * width + Math.floor(start.x);
    parent[from] = from; queue[0] = from;
    let head = 0, tail = 1, chosen;
    while (head < tail && !chosen) {
      const at = queue[head++], x = at % width;
      chosen = targets.find(target => target.at === at);
      if (chosen) break;
      for (const next of [x ? at - 1 : -1, x + 1 < width ? at + 1 : -1, at - width, at + width]) {
        if (next < 0 || next >= parent.length || !walkableMask[next] || parent[next] !== -1 ||
            Math.hypot(next % width + 0.5 - finish.x, Math.floor(next / width) + 0.5 - finish.y) <= P.Config.HIT_RADIUS + 1) continue;
        parent[next] = at; queue[tail++] = next;
      }
    }
    if (!chosen) return null;
    const pixels = [];
    for (let at = chosen.at; ; at = parent[at]) {
      pixels.push({ x: at % width + 0.5, y: Math.floor(at / width) + 0.5 });
      if (at === from) break;
    }
    pixels.reverse();
    const route = [start];
    for (let i = 1; i + 1 < pixels.length; i++) {
      const a = pixels[i - 1], b = pixels[i], c = pixels[i + 1];
      if (b.x - a.x !== c.x - b.x || b.y - a.y !== c.y - b.y) route.push(b);
    }
    route.push(chosen.near);
    return { route, wall: chosen.wall };
  });
  assert.ok(approach, 'a connector can be approached through original background');
  await verifyNoMazeHint(page);
  assert.equal(await state(page), 'DRAWING');
  for (const point of approach.route.slice(1)) await page.mouse.move(point.x, point.y);
  assert.equal(await state(page), 'DRAWING', 'the real pointer safely reaches the connector');
  await verifyTransparentWalls(page, true);
  await page.mouse.move(approach.wall.x, approach.wall.y);
  assert.equal(await state(page), 'FAILED', 'crossing a new red connector fails on a segment that was originally free');
  await ready(page);
  await verifyNoMazeHint(page);
}

async function solveMaze(page, repeatStroke = false, screenshotName = null) {
  await verifyNoMazeHint(page);
  // Read the generator witness inside the test harness only. Production UI
  // deliberately exposes neither a hint button nor an answer layer in maze mode.
  const answer = await page.evaluate(() => {
    const route = __PAGEPATH__.instance.level.referencePath;
    return { points: route.map(point => ({ x: point.x, y: point.y })),
      actualLength: route.slice(1).reduce((sum, point, index) =>
        sum + Math.hypot(point.x - route[index].x, point.y - route[index].y), 0),
      expectedLength: __PAGEPATH__.instance.level.referenceLength };
  });
  await verifyTransparentWalls(page);
  assert.ok(Math.abs(answer.actualLength - answer.expectedLength) < 2);
  const [start, next] = answer.points;
  await page.mouse.move(start.x, start.y);
  if (screenshotName) await page.screenshot({ path: path.join(root, 'test-results', screenshotName) });
  await page.mouse.click(start.x, start.y);
  assert.equal(await state(page), 'DRAWING');
  if (repeatStroke) {
    // Spending arbitrarily more ink on a safe corridor must not end this mode.
    for (let i = 0; i < 40; i++) {
      await page.mouse.move(next.x, next.y);
      await page.mouse.move(start.x, start.y);
    }
    assert.equal(await state(page), 'DRAWING');
    assert.equal(await page.evaluate(() => __PAGEPATH__.instance.overlay.cursorInk.textContent), '∞');
  }
  for (const point of answer.points.slice(1)) {
    await page.mouse.move(point.x, point.y, { steps: 2 });
    if (await state(page) === 'SUCCESS') break;
  }
  assert.equal(await state(page), 'SUCCESS', 'the internal generation witness is completable with actual pointer events');
  await verifyNoMazeHint(page);
  assert.doesNotMatch(await control(page, '.message').textContent(), /NaN|Infinity/);
}

async function verifyConstructedMaze(page) {
  await page.goto('http://127.0.0.1:4173/tests/fixtures/natural-maze.html');
  // Real dense content with three full-height panels and two straight natural
  // gaps meets both entry metrics, but has no natural branching maze. The
  // fallback must add transparent walls inside the safe spaces without
  // cutting through the original content.
  await page.addStyleTag({ content: `main{inset:0!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;
    grid-template-rows:minmax(0,1fr)!important;gap:64px!important}
    article{grid-column:auto!important;margin:0!important}article:nth-child(n+4){display:none!important}
    article:first-child::after{content:'';position:absolute;left:90px;top:330px;width:140px;height:40px;background:#fffdf5;border-radius:3px}` });
  await page.locator('#launch').click(); await ready(page);
  await preserveSource(page);
  assert.equal(await page.evaluate(() => {
    const source = mazeSource.source;
    return Boolean(source.walkableMask[350 * source.width + 160]);
  }), true, 'actual screenshot analysis contains a small white pocket inside the dense foreground');
  const entry = control(page, '.mode-button[data-mode="maze"]');
  assert.equal(await entry.isDisabled(), false, 'meeting 20% and 30/48 unlocks the entry before route feasibility is known');
  await verifyUnlockedMaze(page);
  await entry.click(); await ready(page);
  let audit;
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(await page.evaluate(() => __PAGEPATH__.instance.generationFailed), false);
    assert.equal(await page.evaluate(() => {
      const level = __PAGEPATH__.instance.level;
      return level.nodes.every(p => !(p.x >= 90 && p.x <= 230 && p.y >= 330 && p.y <= 370));
    }), true, 'the foreground interior pocket is never a maze endpoint');
    assert.equal(await control(page, '.generation-error').isVisible(), false);
    await verifyUnlockedMaze(page);
    await verifyNoMazeHint(page);
    audit = await auditMaze(page, true);
    await verifyTransparentWalls(page);
    await sourceUnchanged(page);
    if (!attempt) {
      await page.waitForFunction(() => __PAGEPATH__.instance.overlay.obstacleFlash.getAnimations().length === 0);
      await page.screenshot({ path: path.join(root, 'test-results/pagepath-maze-constructed.png') });
      await verifyWarningsAndCollision(page);
    }
    await solveMaze(page, false, !attempt ? 'pagepath-maze-constructed-ready.png' : null);
    if (!attempt) {
      await control(page, '.new-puzzle').click();
      await ready(page);
    }
  }
  await control(page, '.mode-button[data-mode="normal"]').click(); await ready(page);
  assert.equal(await control(page, '.generation-error').isVisible(), false);
  assert.equal(await page.evaluate(() => __PAGEPATH__.instance.mode), 'normal');
  await sourceUnchanged(page);
  await page.keyboard.press('Escape');
  return { type: 'native-straight-gutter', ...audit, completed: true, regeneratedCompleted: true };
}

async function auditCarvedMaze(page) { return auditMaze(page, false); }

async function verifyBackgroundlessMaze(page) {
  await page.goto('http://127.0.0.1:4173/tests/fixtures/natural-maze.html');
  await page.addStyleTag({ content: `main{inset:0!important;display:block!important}
    article{margin:0!important;width:100%;height:100%}article:nth-child(n+2){display:none!important}` });
  await page.locator('#launch').click();
  await page.waitForFunction(() => ['FAILED', 'PAUSED'].includes(globalThis.__PAGEPATH__?.instance?.state));
  assert.equal(await state(page), 'FAILED');
  assert.equal(await page.evaluate(() => {
    const game = __PAGEPATH__.instance, source = game.snapshot?.analysis;
    return game.mode === 'normal' && !game.level && source?.stats.backgroundRegions === 0 &&
      source.obstacleMask.every(v => v === 1) && source.walkableMask.every(v => v === 0);
  }), true, 'no background remains a valid conservative screenshot map and does not fabricate ordinary nodes');
  await preserveSource(page); await verifyUnlockedMaze(page);
  await control(page, '.mode-button[data-mode="maze"]').click(); await ready(page);
  const audit = await auditCarvedMaze(page); await sourceUnchanged(page);
  await solveMaze(page, false, 'pagepath-maze-backgroundless-ready.png');
  await control(page, '.mode-button[data-mode="normal"]').click();
  await page.waitForFunction(() => __PAGEPATH__.instance?.state === 'FAILED');
  assert.equal(await page.evaluate(() => {
    const game = __PAGEPATH__.instance;
    return !game.level && game.analysis === mazeSource.source && (game.overlay.mazeFloorLayer?.childElementCount || 0) === 0;
  }), true, 'ordinary mode retains its original unavailable space, while maze entry remains usable');
  await sourceUnchanged(page); await verifyUnlockedMaze(page);
  await control(page, '.mode-button[data-mode="maze"]').click(); await ready(page);
  await sourceUnchanged(page); await solveMaze(page);
  await page.keyboard.press('Escape');
  return { type: 'backgroundless-limited-opening', ...audit, completed: true, reopenedCompleted: true };
}

async function verifyCarvedMaze(page) {
  await page.goto('http://127.0.0.1:4173/tests/fixtures/natural-maze.html');
  // Actual textured page content leaves only narrow straight gaps and small
  // enclosed white pockets. No masks, generator calls or analysis are mocked.
  await page.addStyleTag({ content: `main{inset:0!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;
    grid-template-rows:minmax(0,1fr)!important;gap:28px!important}
    article{grid-column:auto!important;margin:0!important}article:nth-child(n+4){display:none!important}
    article::after{content:'';position:absolute;left:75px;top:300px;width:240px;height:200px;background:#fffdf5;border-radius:2px}` });
  await page.locator('#launch').click(); await ready(page); await preserveSource(page);
  await verifyUnlockedMaze(page);
  await control(page, '.mode-button[data-mode="maze"]').click(); await ready(page);
  let audit;
  for (let attempt = 0; attempt < 2; attempt++) {
    audit = await auditCarvedMaze(page); await sourceUnchanged(page); await verifyTransparentWalls(page);
    assert.equal(await control(page, '.generation-error').isVisible(), false);
    if (!attempt) {
      await page.waitForFunction(() => __PAGEPATH__.instance.overlay.obstacleFlash.getAnimations().length === 0);
      await page.screenshot({ path: path.join(root, 'test-results/pagepath-maze-carved.png') });
      const probe = await page.evaluate(() => {
        const { level, analysis: map } = __PAGEPATH__.instance, path = level.referencePath;
        for (let i = 1; i < path.length; i++) {
          const a = path[i-1], b = path[i], span = Math.hypot(b.x-a.x,b.y-a.y), dx = -(b.y-a.y)/span, dy = (b.x-a.x)/span;
          for (const fraction of [.5,.25,.75]) {
            const origin = { x:a.x+(b.x-a.x)*fraction,y:a.y+(b.y-a.y)*fraction };
            if (Math.hypot(origin.x-path.at(-1).x,origin.y-path.at(-1).y)<30) continue;
            for (const sign of [-1,1]) for (let step=1;step<150;step++) {
              const x=Math.floor(origin.x+dx*step*sign),y=Math.floor(origin.y+dy*step*sign);
              if(x<0||y<0||x>=map.width||y>=map.height) break;
              if(!map.walkableMask[y*map.width+x]) {
                for(const back of [5,8,12]) {
                  const near={x:x+.5-dx*sign*back,y:y+.5-dy*sign*back},wall={x:x+.5,y:y+.5};
                  if(!__PAGEPATH__.Collision.segmentHits(a,origin,level.obstacleIndex)&&
                      !__PAGEPATH__.Collision.segmentHits(origin,near,level.obstacleIndex)) return {
                    start:path[0],route:[...path.slice(1,i),origin,near],wall };
                }
                break;
              }
            }
          }
        }
      });
      assert.ok(probe);
      await page.mouse.move(probe.start.x, probe.start.y); await page.mouse.click(probe.start.x, probe.start.y);
      for (const point of probe.route) await page.mouse.move(point.x, point.y);
      assert.equal(await state(page), 'DRAWING');
      await page.waitForFunction(() => Boolean(__PAGEPATH__.instance.overlay.obstacleWarning.getAttribute('d')));
      await verifyTransparentWalls(page);
      assert.equal(await page.evaluate(() => Number(__PAGEPATH__.instance.overlay.obstacleWarning.getAttribute('opacity')) > 0), true);
      await page.screenshot({ path: path.join(root, 'test-results/pagepath-maze-carved-near-wall.png') });
      await page.mouse.move(probe.wall.x, probe.wall.y);
      assert.equal(await state(page), 'FAILED', 'the opened floor still collides with its new exact boundary');
      await ready(page);
    }
    await solveMaze(page, false, !attempt ? 'pagepath-maze-carved-ready.png' : null);
    if (!attempt) { await control(page, '.new-puzzle').click(); await ready(page); }
  }
  await control(page, '.mode-button[data-mode="normal"]').click(); await ready(page);
  assert.equal(await page.evaluate(() => {
    const game = __PAGEPATH__.instance;
    return game.analysis === mazeSource.source && (game.overlay.mazeFloorLayer?.childElementCount || 0) === 0 &&
      game.overlay.mazeWallLayer.childElementCount === 0 && !game.level.unlimitedInk;
  }), true, 'leaving the maze restores original collision and removes all paper floor');
  await sourceUnchanged(page); await page.keyboard.press('Escape');
  return { type: 'limited-openings', ...audit, completed: true, regeneratedCompleted: true };
}

(async () => {
  const server = spawn(process.execPath, ['scripts/serve.cjs'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let browser;
  try {
    await new Promise((resolve, reject) => {
      server.stdout.once('data', resolve); server.once('error', reject);
      server.once('exit', code => reject(new Error(`Fixture server exited ${code}`)));
    });
    browser = await playwright.chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(60000);
    await require('./screenshot-harness.cjs')(page);
    const errors = []; page.on('pageerror', error => errors.push(error.message));

    for (const type of ['blank', 'simple', 'github', 'dashboard']) {
      await page.goto(`http://127.0.0.1:4173/?type=${type === 'blank' ? 'simple' : type}`);
      if (type === 'blank') await page.evaluate(() => {
        document.querySelector('#content').replaceChildren();
        document.querySelector('footer').remove();
        document.querySelectorAll('header a').forEach(link => link.remove());
      });
      await page.locator('#launch').click(); await ready(page);
      const entry = control(page, '.mode-button[data-mode="maze"]');
      assert.equal(await entry.isDisabled(), true, `${type} page has insufficient original foreground and keeps the maze entry disabled`);
      await control(page, '.maze-mode-slot').hover();
      assert.equal(await control(page, '.maze-tooltip').isVisible(), true, 'hovering the locked icon opens the custom tooltip');
      const lockedInfo = await page.evaluate(() => {
        const game = __PAGEPATH__.instance, overlay = game.overlay;
        const button = overlay.modeButtons.find(item => item.dataset.mode === 'maze');
        const icon = button.querySelector('.control-icon'), lock = button.querySelector('.maze-locked-mark');
        const source = game.sourceAnalysis;
        const bins = new Uint32Array(48);
        for (let index = 0; index < source.obstacleMask.length; index++) if (source.obstacleMask[index]) {
          const x = index % source.width, y = Math.floor(index / source.width);
          bins[Math.floor(y * 6 / source.height) * 8 + Math.floor(x * 8 / source.width)]++;
        }
        const tooltip = overlay.mazeTooltip;
        return { availability: game.mazeAvailability, disabled: button.disabled, title: button.title,
          hoverTitle: overlay.mazeModeSlot.title,
          sourceObstacleRatio: source.obstacleMask.reduce((sum, value) => sum + Number(Boolean(value)), 0) / source.obstacleMask.length,
          sourceOccupiedRegions: bins.filter(count => count >= source.width * source.height / 48 * .1).length,
          tooltipVisible: !tooltip.hidden && getComputedStyle(tooltip).display !== 'none', tooltipText: tooltip.textContent,
          criteria: [...tooltip.querySelectorAll('.maze-criterion')].map(row => ({ kind: row.dataset.criterion,
            passed: row.dataset.passed, color: getComputedStyle(row.querySelector('.criterion-mark')).color,
            mark: row.querySelector('.criterion-mark path')?.getAttribute('d') })),
          opacities: [overlay.mazeModeSlot, button, icon, lock].map(element => getComputedStyle(element).opacity),
          lockedDisplay: getComputedStyle(lock).display,
          unlockedDisplay: getComputedStyle(button.querySelector('.maze-unlocked-mark')).display };
      });
      assertLockedMazeDetails(lockedInfo);
      const bounds = await entry.boundingBox();
      await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      assert.equal(await page.evaluate(() => __PAGEPATH__.instance.mode), 'normal', 'clicking the padlock cannot switch modes');
      await page.evaluate(() => __PAGEPATH__.instance.setMode('maze'));
      assert.equal(await page.evaluate(() => __PAGEPATH__.instance.mode), 'normal', 'programmatic mode changes obey availability too');
      await page.keyboard.press('Escape');
    }

    fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
    const results = [await verifyConstructedMaze(page), await verifyCarvedMaze(page), await verifyBackgroundlessMaze(page)];
    for (const layout of [{ type: 'natural-wide', width: 1280, height: 900 },
      { type: 'natural-compact', width: 1120, height: 850 }]) {
      const { type, width, height } = layout;
      console.log('maze-browser layout: '+type+' '+width+'x'+height);
      await page.setViewportSize({ width, height });
      await page.goto('http://127.0.0.1:4173/tests/fixtures/natural-maze.html');
      await page.evaluate(() => document.fonts.ready);
      await page.locator('#launch').click(); await ready(page);
      await preserveSource(page);
      assert.equal(await control(page, '.mode-button[data-mode="maze"]').isDisabled(), false,
        `${type} should offer the natural second level: ${JSON.stringify(await page.evaluate(() => __PAGEPATH__.instance.mazeAvailability))}`);
      await verifyUnlockedMaze(page);
      await control(page, '.mode-button[data-mode="maze"]').click(); await ready(page);
      const audit = await auditMaze(page);
      await verifyTransparentWalls(page);
      await sourceUnchanged(page);
      await page.waitForFunction(() => {
        const overlay = __PAGEPATH__.instance.overlay;
        return overlay.obstacleFlash.getAnimations().length === 0 && getComputedStyle(overlay.allObstacles).visibility === 'hidden';
      });
      await page.screenshot({ path: path.join(root, 'test-results', `pagepath-maze-${type}.png`) });
      await verifyWarningsAndCollision(page);
      await solveMaze(page, type === 'natural-wide', `pagepath-maze-${type}-ready.png`);
      const variants = await page.evaluate(() => {
        const game = __PAGEPATH__.instance;
        return new Set([0.01, 0.35, 0.65, 0.99].map(value => {
          try {
            const level = __PAGEPATH__.MazeGenerator.generate(mazeSource.source, game.overlay.getReservedRects(), () => value);
            if (level.mazeCarvedPaths.length) throw new Error('a native gallery variant unnecessarily opened foreground');
            return JSON.stringify({ walls: level.mazeWallSegments, nodes: level.nodes });
          } catch (error) {
            throw new Error('constant RNG=' + value + ', viewport=' + mazeSource.source.width + 'x' + mazeSource.source.height + ': ' + error.message);
          }
        })).size;
      });
      assert.ok(variants > 1, 'different choices can vary connectors or endpoints within the natural layout');
      await control(page, '.new-puzzle').click(); await ready(page);
      assert.equal(await control(page, '.hint').getAttribute('aria-pressed'), 'false');
      await sourceUnchanged(page);
      await solveMaze(page);
      await control(page, '.mode-button[data-mode="normal"]').click(); await ready(page);
      assert.equal(await page.evaluate(() => {
        const game = __PAGEPATH__.instance;
        return game.analysis === mazeSource.source && Number.isFinite(game.level.maxInk) &&
          !game.level.unlimitedInk && !game.overlay.mazeWallLayer.querySelector('path') &&
          game.overlay.cursorInk.textContent !== '∞';
      }), true, 'returning to the first level restores the original map and normal ink');
      await sourceUnchanged(page);
      await page.keyboard.press('Escape');
      results.push({ type, ...audit, variants, completed: true, regeneratedCompleted: true });
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ browser: executablePath || 'Playwright Chromium', results,
      checks: ['blank and sparse pages disabled', 'dense natural content at two viewport sizes',
        '20% original foreground gate', 'locked padlock with two source-driven green checks or red crosses',
        'unlocked star with only the second-level name',
        'qualifying straight gaps become a uniquely connected maze with transparent added walls',
        'real dense screenshot opens foreground when original passages are too narrow',
        'limited openings affect only removed foreground; no full-page paper grid',
        'contour connectors protect a preselected answer',
        'independent final-pixel main-path bridge proof', 'unlimited ink',
        'second-level hints hidden and impossible to enable',
        'added walls hidden globally but warned locally', 'actual pointer collision and completion', 'new maze variety',
        'cached screenshot unchanged', 'return to first level'], errors }, null, 2));
  } finally { await browser?.close(); server.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
