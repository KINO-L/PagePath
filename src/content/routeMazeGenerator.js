(() => {
  'use strict';
  const P = globalThis.__PAGEPATH__ ||= {};
  const cleanupCache = new WeakMap();
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // The exact run graph represents the topology of the final free pixels.
  // A unique start-to-end path uses only bridges. Cycles in unrelated dead-end
  // branches need not be removed to establish a unique route to the finish.
  function topology(analysis, start, finish) {
    const { width, height, walkableMask, componentLabels } = analysis;
    const labelAt = p => componentLabels[Math.floor(p.y) * width + Math.floor(p.x)];
    const componentId = labelAt(start);
    if (!componentId || labelAt(finish) !== componentId) return { unique: false };
    const graph = P.MazeGeometry.decompose(walkableMask, componentLabels, componentId, width, height);
    if (!graph) return { unique: false };
    const vertexAt = p => graph.vertices.findIndex(v => p.x >= v.left && p.x < v.right && p.y >= v.top && p.y < v.bottom);
    const a = vertexAt(start), b = vertexAt(finish), n = graph.vertices.length;
    if (a < 0 || b < 0) return { unique: false };
    const entered = new Int32Array(n), low = new Int32Array(n), parent = new Int32Array(n).fill(-1);
    const via = new Int32Array(n).fill(-1), cursor = new Int32Array(n), bridges = new Uint8Array(graph.edges.length);
    const stack = [a]; let time = 1; entered[a] = low[a] = time;
    while (stack.length) {
      const at = stack[stack.length - 1];
      if (cursor[at] < graph.adjacency[at].length) {
        const next = graph.adjacency[at][cursor[at]++];
        if (next.edge === via[at]) continue;
        if (!entered[next.id]) {
          parent[next.id] = at; via[next.id] = next.edge;
          entered[next.id] = low[next.id] = ++time; stack.push(next.id);
        } else low[at] = Math.min(low[at], entered[next.id]);
      } else {
        stack.pop();
        if (parent[at] >= 0) {
          if (low[at] > entered[parent[at]]) bridges[via[at]] = 1;
          low[parent[at]] = Math.min(low[parent[at]], low[at]);
        }
      }
    }
    const ids = [], routeEdges = []; let unique = Boolean(entered[b]);
    for (let at = b; at >= 0; at = parent[at]) {
      ids.push(at);
      if (via[at] >= 0) { routeEdges.push(via[at]); if (!bridges[via[at]]) unique = false; }
    }
    ids.reverse(); routeEdges.reverse();
    return { unique, componentId, graph, ids, routeEdges,
      deadEnds: graph.adjacency.filter(edges => edges.length === 1).length };
  }

  function routeMetrics(path) {
    let referenceLength = 0, turns = 0;
    for (let i = 1; i < path.length; i++) referenceLength += distance(path[i - 1], path[i]);
    for (let i = 1; i + 1 < path.length; i++) {
      const a = path[i - 1], b = path[i], c = path[i + 1], ab = distance(a, b), bc = distance(b, c);
      if (ab >= 12 && bc >= 12 && ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / ab / bc < Math.cos(Math.PI / 6)) turns++;
    }
    return { referenceLength, turns };
  }

  function visibleRoute(points, index) {
    const result = [points[0]];
    let checks = 0;
    for (let at = 0; at + 1 < points.length;) {
      let next = points.length - 1;
      for (; next > at + 1; next--) {
        if (++checks > 12000) return result.slice(0, -1).concat(P.MazeGeometry.simplify(points.slice(at), index));
        if (!P.Collision.segmentHits(points[at], points[next], index)) break;
      }
      result.push(points[next]); at = next;
    }
    return result;
  }

  function openedPixels(before, after, width, height) {
    const result = []; let previous = new Map();
    for (let y = 0; y < height; y++) {
      const current = new Map();
      for (let x = 0; x < width;) {
        const i = y * width + x;
        if (!before[i] || after[i]) { x++; continue; }
        const left = x;
        while (x < width && before[y * width + x] && !after[y * width + x]) x++;
        const key = left + ':' + x, old = previous.get(key);
        if (old) { old.height++; current.set(key, old); }
        else { const rect = { x: left, y, width: x - left, height: 1 }; result.push(rect); current.set(key, rect); }
      }
      previous = current;
    }
    return result;
  }

  function generate(source, reservedRects = [], random = Math.random) {
    const G = P.MazeGeometry, eligibility = P.MazeGenerator.assess(source);
    if (!eligibility.available) throw new Error(eligibility.reason);
    // Give each attempt a real deterministic stream even when a caller uses a
    // constant RNG. Repeating the identical failed proposal is not a retry.
    let seed = Math.floor(random() * 4294967296) >>> 0;
    const nextRandom = () => {
      seed = seed + 0x6D2B79F5 | 0;
      let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
      value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
      return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
    if (!cleanupCache.has(source)) cleanupCache.set(source, P.MazeCleanup.merge(source));
    const cleanup = cleanupCache.get(source);
    const cleaned = cleanup.rects.length ? G.rebuild(source, cleanup.rects) : source;
    let selected = null;
    // The answer is committed before adding any walls. Neither connector
    // placement nor validation may move its endpoints to a convenient pocket.
    for (let attempt = 0; attempt < 14 && !selected; attempt++) {
      const planned = P.MazeRoute.plan(cleaned, reservedRects, nextRandom, attempt);
      if (!planned?.referencePath?.length) continue;
      const base = planned.obstacleMask ? G.rebuild(cleaned, [], planned.obstacleMask) : cleaned;
      const fixedPath = planned.referencePath.map(p => ({ ...p }));
      const walls = P.MazeConnectors.plan(base, fixedPath, nextRandom);
      if (!walls?.obstacleMask) continue;
      const analysis = G.rebuild(base, [], walls.obstacleMask), obstacleIndex = P.Collision.createMaskIndex(analysis);
      if (fixedPath.some((p, i) => P.Collision.pointHits(p, obstacleIndex) ||
        i && P.Collision.segmentHits(fixedPath[i - 1], p, obstacleIndex))) continue;
      if ([fixedPath[0], fixedPath.at(-1)].some(p => analysis.distanceMap[Math.floor(p.y) * analysis.width + Math.floor(p.x)] < 12)) continue;
      const proof = topology(analysis, fixedPath[0], fixedPath.at(-1));
      if (!proof.unique) continue;
      // Planning uses extra clearance; the final player mask can expose a
      // shorter passage. Strip excursions into side branches using the proven
      // unique S-T chain, so difficulty is measured on the necessary route.
      const mainPassage = [fixedPath[0]];
      for (let i = 0; i < proof.routeEdges.length; i++) {
        mainPassage.push(proof.graph.edges[proof.routeEdges[i]].point);
        // Two portals can touch the same side of a free rectangle. Travel
        // through its interior rather than along a blocked pixel boundary.
        if (i + 1 < proof.routeEdges.length) mainPassage.push(proof.graph.vertices[proof.ids[i + 1]].point);
      }
      mainPassage.push(fixedPath.at(-1));
      if (mainPassage.some((p, i) => i && P.Collision.segmentHits(mainPassage[i - 1], p, obstacleIndex))) continue;
      const referencePath = visibleRoute(mainPassage, obstacleIndex), metrics = routeMetrics(referencePath);
      if (!G.coversPage(referencePath, source, metrics.referenceLength) || metrics.turns < 4) continue;
      selected = { planned, base, walls, analysis, obstacleIndex, fixedPath, proof, referencePath, ...metrics };
    }
    if (!selected) throw Object.assign(new Error('当前答案路线的绕行通道尚未完全封闭，请重新生成'), { code: 'MAZE_GENERATION_FAILED' });
    const { planned, base, walls, analysis, obstacleIndex, fixedPath, proof, referencePath, referenceLength, turns } = selected;
    const wallSegments = walls.wallSegments.map(wall => ({ ...wall,
      points: wall.points.map(p => ({ ...p })), anchors: (wall.anchors || []).map(p => ({ ...p })) }));
    return { analysis, obstacleIndex, mazeOriginalAnalysis: source, mazeSourceAnalysis: base,
      mazeMergedObstacles: cleanup.rects.map(rect => ({ ...rect })),
      plannedReferencePath: fixedPath, mazeWallSegments: wallSegments, mazeWalls: [], mazeFloorRects: [],
      mazeCarvedPaths: planned.carvedPaths || [],
      mazeOpenings: planned.obstacleMask ? openedPixels(cleaned.obstacleMask, base.obstacleMask, source.width, source.height) : [],
      ...(planned.toolbarRect ? { toolbarRect: planned.toolbarRect } : {}),
      nodes: [{ ...referencePath[0], id: 0, kind: 'start' }, { ...referencePath.at(-1), id: 1, kind: 'finish' }],
      referencePath, referenceLength, maxInk: Infinity, unlimitedInk: true, inkMultiplier: Infinity,
      mode: 'maze', modeLabel: '第二关', difficulty: Math.min(100, 60 + turns * 2), trailLength: 45,
      challenge: { turns, deadEnds: proof.deadEnds, narrowRatio: 0 },
      maze: { kind: 'route-first', componentId: proof.componentId, obstacleRatio: eligibility.obstacleRatio,
        occupiedRegions: eligibility.occupiedRegions, cleanup: cleanup.stats,
        construction: { ...planned.meta, ...walls.meta, routeKind: planned.meta?.kind, answerChosenFirst: true, uniqueStartFinish: true },
        limits: { thickness: 3, ...P.Config.MAZE_REQUIREMENTS }, connections: wallSegments, addedPixels: walls.meta?.addedPixels,
        vertices: proof.graph.vertices.map(v => ({ ...v, point: { ...v.point } })),
        edges: proof.graph.edges.map(e => ({ a: e.a, b: e.b, portal: { ...e.portal } })),
        routeVertexIds: proof.ids, routeEdgeIds: proof.routeEdges } };
  }
  P.RouteMazeGenerator = Object.freeze({ generate, topology, routeMetrics });
})();
