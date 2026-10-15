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
    // Pixel portals often put several very short segments around one bend.
    // Measure headings over pen-sized movement so such a bend is neither lost
    // nor counted once for every stair in the source image.
    const samples = [path[0]];
    for (let i = 1; i < path.length; i++) if (distance(samples.at(-1), path[i]) >= 18 || i === path.length - 1) samples.push(path[i]);
    for (let i = 1; i + 1 < samples.length; i++) {
      const a = samples[i - 1], b = samples[i], c = samples[i + 1], ab = distance(a, b), bc = distance(b, c);
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

  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const outside = (p, reserved, radius = 18) => !reserved.some(r => p.x >= r.x - radius && p.x <= r.x + r.width + radius &&
    p.y >= r.y - radius && p.y <= r.y + r.height + radius);

  function routeBranches(graph, path) {
    if (!graph) return [];
    const start = path[0], finish = path.at(-1);
    const distanceToAnswer = p => {
      let nearest = Infinity;
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1], b = path[i], dx = b.x - a.x, dy = b.y - a.y;
        const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / Math.max(1e-9, dx * dx + dy * dy), 0, 1);
        nearest = Math.min(nearest, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
      }
      return nearest;
    };
    const vertexAt = p => graph.vertices.findIndex(v => p.x >= v.left && p.x < v.right && p.y >= v.top && p.y < v.bottom);
    const a = vertexAt(start), b = vertexAt(finish);
    if (a < 0 || b < 0) return [];
    const parent = new Int32Array(graph.vertices.length).fill(-1), queue = [a]; parent[a] = a;
    for (let i = 0; i < queue.length && parent[b] < 0; i++) for (const next of graph.adjacency[queue[i]]) {
      if (parent[next.id] < 0) { parent[next.id] = queue[i]; queue.push(next.id); }
    }
    if (parent[b] < 0) return [];
    const onRoute = new Uint8Array(parent.length);
    for (let at = b;; at = parent[at]) { onRoute[at] = 1; if (at === a) break; }
    const seen = onRoute.slice(), branches = [];
    for (let at = 0; at < onRoute.length; at++) if (onRoute[at]) for (const next of graph.adjacency[at]) {
      if (seen[next.id]) continue;
      const ids = [next.id], entry = graph.edges[next.edge].point; seen[next.id] = 1;
      let depth = 0, area = 0;
      for (let i = 0; i < ids.length; i++) {
        const vertex = graph.vertices[ids[i]];
        depth = Math.max(depth, distance(entry, vertex.point));
        area += (vertex.right - vertex.left) * (vertex.bottom - vertex.top);
        for (const item of graph.adjacency[ids[i]]) if (!seen[item.id]) { seen[item.id] = 1; ids.push(item.id); }
      }
      // One decision on the answer is one branch, even if the remote subtree
      // contains hundreds of text-shaped leaves. Tiny wall-tip pixels don't count.
      // A long run rectangle may reach from the answer into a remote subtree.
      // Its far-away portals are choices inside that subtree, not on the answer.
      if (depth >= 26 && area >= 72 && distanceToAnswer(entry) <= 56) branches.push({ edge: next.edge, from: at, ids, depth });
    }
    return branches;
  }

  function measuredChallenge(analysis, referencePath, proof) {
    const metrics = routeMetrics(referencePath), diagonal = Math.hypot(analysis.width, analysis.height);
    let samples = 0, narrow = 0, widthTotal = 0;
    for (let i = 1; i < referencePath.length; i++) {
      const a = referencePath[i - 1], b = referencePath[i], count = Math.max(1, Math.ceil(distance(a, b) / 4));
      for (let j = 0; j < count; j++) {
        const x = clamp(Math.floor(a.x + (b.x - a.x) * (j + .5) / count), 0, analysis.width - 1);
        const y = clamp(Math.floor(a.y + (b.y - a.y) * (j + .5) / count), 0, analysis.height - 1);
        const span = distance(a, b), nx = -(b.y - a.y) / Math.max(1e-6, span), ny = (b.x - a.x) / Math.max(1e-6, span);
        let passageWidth = 0;
        for (const sign of [-1, 1]) for (let step = 1; step <= 64; step++) {
          const sx = Math.floor(x + .5 + sign * nx * step), sy = Math.floor(y + .5 + sign * ny * step);
          if (sx < 0 || sy < 0 || sx >= analysis.width || sy >= analysis.height || !analysis.walkableMask[sy * analysis.width + sx]) break;
          passageWidth++;
        }
        if (passageWidth < 27) narrow++;
        widthTotal += passageWidth; samples++;
      }
    }
    // Tiny pixel steps at the end of a slanted wall are not additional choices.
    // Count only arms with enough depth to invite a meaningful wrong turn.
    // A horizontal spur can collapse into one horizontal run rectangle. Audit
    // both axes of the actual reachable pixels so rotating the same maze does
    // not erase its wrong turns from the score.
    const transposed = new Uint8Array(analysis.width * analysis.height);
    for (let y = 0; y < analysis.height; y++) for (let x = 0; x < analysis.width; x++) {
      const at = y * analysis.width + x;
      if (analysis.walkableMask[at] && analysis.componentLabels[at] === proof.componentId) transposed[x * analysis.height + y] = 1;
    }
    const across = P.MazeGeometry.decompose(transposed, transposed, 1, analysis.height, analysis.width);
    const deadEnds = Math.max(routeBranches(proof.graph, referencePath).length,
      routeBranches(across, referencePath.map(p => ({ x: p.y, y: p.x }))).length);
    const narrowRatio = narrow / Math.max(1, samples), routeRatio = metrics.referenceLength / diagonal;
    // The finished geometry sets one universal score. Requested intensity is
    // only a construction preference and never determines stars by itself.
    const complexity = clamp(.35 * clamp((routeRatio - .5) / 4, 0, 1) +
      .35 * Math.min(1, metrics.turns / 16) + .30 * Math.min(1, deadEnds / 12), 0, 1);
    const difficulty = Math.round(complexity * 100);
    return { ...metrics, deadEnds, narrowRatio, routeRatio, corridorWidth: widthTotal / Math.max(1, samples),
      complexity, difficulty };
  }

  function inspect(analysis, points) {
    const obstacleIndex = P.Collision.createMaskIndex(analysis);
    if (points.some((p, i) => P.Collision.pointHits(p, obstacleIndex) || i && P.Collision.segmentHits(points[i - 1], p, obstacleIndex))) return null;
    const proof = topology(analysis, points[0], points.at(-1));
    if (!proof.unique) return null;
    // Drop optional excursions using the actual pixel graph, then shorten the
    // route only across lines accepted by the same collision sampler as play.
    const main = [points[0]];
    for (let i = 0; i < proof.routeEdges.length; i++) {
      main.push(proof.graph.edges[proof.routeEdges[i]].point);
      if (i + 1 < proof.routeEdges.length) main.push(proof.graph.vertices[proof.ids[i + 1]].point);
    }
    main.push(points.at(-1));
    if (main.some((p, i) => i && P.Collision.segmentHits(main[i - 1], p, obstacleIndex))) return null;
    const referencePath = visibleRoute(main, obstacleIndex);
    return { analysis, obstacleIndex, proof, referencePath, challenge: measuredChallenge(analysis, referencePath, proof) };
  }

  function toolbarPosition(source, points, reserved) {
    if (points.every(p => outside(p, reserved))) return null;
    const width = Math.min(source.width - 12, Math.max(354, ...reserved.map(rect => rect.width))),
      height = Math.min(source.height - 12, Math.max(88, ...reserved.map(rect => rect.height)));
    for (const y of [6, source.height - height - 6, (source.height - height) / 2]) {
      for (const x of [6, source.width - width - 6, (source.width - width) / 2]) {
        const rect = { x: Math.max(0, x), y: Math.max(0, y), width, height };
        if (points.every(p => outside(p, [rect]))) return rect;
      }
    }
    return { x: 6, y: 6, width, height };
  }

  function generate(source, reservedRects = [], random = Math.random, history = []) {
    const G = P.MazeGeometry, eligibility = P.MazeGenerator.assess(source);
    if (!eligibility.available) throw new Error(eligibility.reason);
    let seed = Math.floor(clamp(Number(random()) || 0, 0, .9999999999) * 4294967296) >>> 0;
    const nextRandom = () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const request = P.Difficulty.draw(source, nextRandom);
    let intensity = request.intensity, lowerIntensity = 0, upperIntensity = 1;
    if (!cleanupCache.has(source)) cleanupCache.set(source, P.MazeCleanup.merge(source));
    const cleanup = cleanupCache.get(source), cleaned = cleanup.rects.length ? G.rebuild(source, cleanup.rects) : source;
    let selected = null;
    const evaluate = (planned, options) => {
      if (!planned?.referencePath?.length) return null;
      const base = planned.obstacleMask ? G.rebuild(cleaned, [], planned.obstacleMask) : cleaned;
      let fixedPath = planned.referencePath.map(p => ({ ...p }));
      // This is the original answer-first algorithm: join webpage obstacles
      // with fine lines while protecting the selected background route.
      // Broad empty areas receive inward-growing irregular baffles as well.
      let walls = P.MazeConnectors.plan(base, fixedPath, nextRandom, options);
      if (!walls?.obstacleMask) return null;
      let candidate = inspect(G.rebuild(base, [], walls.obstacleMask), fixedPath);
      if (!candidate || !G.coversPage(candidate.referencePath, source, candidate.challenge.referenceLength)) return null;
      if (options.sealBranches && request.targetStars <= 2 && candidate.challenge.difficulty > request.targetStars * 20) {
        const sealed = P.MazeConnectors.sealBranches(candidate.analysis, candidate.referencePath);
        if (sealed.wallSegments.length) {
          const simpler = inspect(G.rebuild(candidate.analysis, [], sealed.obstacleMask), candidate.referencePath);
          if (simpler && Math.abs(simpler.challenge.difficulty - request.targetDifficulty) <
              Math.abs(candidate.challenge.difficulty - request.targetDifficulty)) {
            fixedPath = candidate.referencePath.map(p => ({ ...p }));
            candidate = simpler;
            let added = 0;
            for (let i = 0; i < sealed.obstacleMask.length; i++) added += sealed.obstacleMask[i] && !walls.obstacleMask[i];
            walls = { ...walls, obstacleMask: sealed.obstacleMask, wallSegments: walls.wallSegments.concat(sealed.wallSegments),
              meta: { ...walls.meta, addedPixels: walls.meta.addedPixels + added, sealedBranches: sealed.wallSegments.length } };
          }
        }
      }
      const ends = [candidate.referencePath[0], candidate.referencePath.at(-1)];
      if (ends.some(p => candidate.analysis.distanceMap[Math.floor(p.y) * source.width + Math.floor(p.x)] < 12)) return null;
      return { ...candidate, base, planned, fixedPath, walls, intensity: options.intensity };
    };
    const matched = () => selected && P.Difficulty.stars(selected.challenge.difficulty) === request.targetStars;
    const consider = candidate => {
      if (!candidate) return;
      if (!selected || P.Difficulty.stars(candidate.challenge.difficulty) === request.targetStars ||
          Math.abs(candidate.challenge.difficulty - request.targetDifficulty) <
          Math.abs(selected.challenge.difficulty - request.targetDifficulty)) selected = candidate;
      // Feed the measured, shortcut-free difficulty back to construction. The
      // requested star never replaces the score earned by the final geometry.
      if (candidate.challenge.difficulty < request.targetDifficulty) lowerIntensity = Math.max(lowerIntensity, candidate.intensity);
      else upperIntensity = Math.min(upperIntensity, candidate.intensity);
      intensity = lowerIntensity < upperIntensity && (lowerIntensity > 0 && upperIntensity < 1)
        ? (lowerIntensity + upperIntensity) / 2
        : clamp(candidate.intensity + (request.targetDifficulty - candidate.challenge.difficulty) / 100, 0, 1);
    };
    // Every tier is sampled before construction. Prefer native terrain, then
    // adjust the actual route instead of accepting the first playable maze.
    const hasEndpointRoom = cleaned.distanceMap.some((distance, at) => distance >= 12 && cleaned.walkableMask[at]);
    const nativeAttempts = request.targetStars === 5 ? 6 : 10;
    for (let attempt = 0; hasEndpointRoom && attempt < nativeAttempts && !matched(); attempt++) {
      // First look for an easy route that keeps the surrounding native area
      // open. Seal distracting side passages only after those candidates fail.
      const options = { intensity, targetStars: request.targetStars, sealBranches: attempt >= 4 };
      const planned = P.MazeRoute.plan(cleaned, reservedRects, nextRandom, attempt, options);
      // No usable native route is different from a chosen route whose loops
      // still need sealing. Repeating the former cannot create free space.
      if (!planned) break;
      consider(evaluate(planned, options));
    }
    if (!selected && hasEndpointRoom && reservedRects.length) {
      const options = { intensity, targetStars: request.targetStars };
      consider(evaluate(P.MazeRoute.plan(cleaned, [], nextRandom, nativeAttempts, options), options));
    }
    // Missing or unsuitable native passages may need a local opening. It adds
    // no enclosing shell and never blocks background outside the opened route.
    lowerIntensity = 0; upperIntensity = 1; intensity = request.intensity;
    for (let attempt = 0; attempt < 6 && !matched(); attempt++) {
      const options = { intensity, targetStars: request.targetStars, forceOpen: true, sealBranches: true };
      const candidate = evaluate(P.MazeRoute.plan(cleaned, reservedRects, nextRandom, attempt, options), options);
      consider(candidate);
      // A small viewport may not fit the requested sweep at all. An invalid
      // plan supplies no score feedback, so reduce its spatial demand explicitly.
      if (!candidate && !selected && attempt >= 2) intensity *= .7;
    }
    for (let attempt = 0; attempt < 2 && !selected; attempt++) {
      const options = { intensity: attempt * .2, targetStars: request.targetStars, forceOpen: true };
      consider(evaluate(P.MazeRoute.plan(cleaned, reservedRects, nextRandom, attempt, options), options));
    }
    if (!selected) throw Object.assign(new Error('可用视口太小，请放大浏览器窗口后开始'), { code: 'VIEWPORT_TOO_SMALL' });
    const { analysis, obstacleIndex, proof, referencePath, challenge, planned, walls, base, fixedPath } = selected;
    const wallSegments = walls.wallSegments.map(wall => ({ ...wall, points: wall.points.map(p => ({ ...p })),
      anchors: (wall.anchors || []).map(p => ({ ...p })) }));
    const toolbarRect = toolbarPosition(source, [referencePath[0], referencePath.at(-1)], reservedRects);
    return { analysis, obstacleIndex, mazeOriginalAnalysis: source, mazeSourceAnalysis: base,
      mazeMergedObstacles: cleanup.rects.map(rect => ({ ...rect })), plannedReferencePath: fixedPath,
      mazeWallSegments: wallSegments, mazeWalls: [], mazeFloorRects: [], mazeCarvedPaths: planned.carvedPaths || [],
      mazeOpenings: planned.obstacleMask ? openedPixels(cleaned.obstacleMask, base.obstacleMask, source.width, source.height) : [],
      ...(toolbarRect ? { toolbarRect } : {}),
      nodes: [{ ...referencePath[0], id: 0, kind: 'start' }, { ...referencePath.at(-1), id: 1, kind: 'finish' }],
      referencePath, referenceLength: challenge.referenceLength, maxInk: Infinity, unlimitedInk: true,
      difficulty: challenge.difficulty, stars: P.Difficulty.stars(challenge.difficulty), trailLength: P.Config.TRAIL_LENGTH,
      challenge: { ...challenge, intensity: selected.intensity, targetStars: request.targetStars,
        targetDifficulty: request.targetDifficulty, pageComplexity: request.pageComplexity },
      maze: { kind: 'route-first', componentId: proof.componentId, cleanup: cleanup.stats,
        construction: { ...planned.meta, ...walls.meta, routeKind: planned.meta?.kind,
          answerChosenFirst: true, uniqueStartFinish: true },
        connections: wallSegments, addedPixels: walls.meta.addedPixels, obstacleRatio: eligibility.obstacleRatio,
        vertices: proof.graph.vertices.map(v => ({ ...v, point: { ...v.point } })),
        edges: proof.graph.edges.map(e => ({ a: e.a, b: e.b, portal: { ...e.portal } })),
        routeVertexIds: proof.ids, routeEdgeIds: proof.routeEdges } };
  }
  P.RouteMazeGenerator = Object.freeze({ generate, topology, routeMetrics, measuredChallenge });
})();
