(() => {
  'use strict';
  const P = globalThis.__PAGEPATH__ ||= {};

  function historyWeights(grid, candidates, recentLayouts) {
    // Only position matters: changing IDs, visit order, or Start/Finish does not
    // make a map new. Keep this preference bounded even for malformed callers.
    const history = (Array.isArray(recentLayouts) ? recentLayouts.slice(-4) : [])
      .filter(Array.isArray).map(layout => layout.slice(0, 16).filter(point =>
        point && Number.isFinite(point.x) && Number.isFinite(point.y))).filter(layout => layout.length);
    const weights = new Float64Array(grid.walkable.length).fill(1);
    if (!history.length) return weights;
    const radius = P.Config.NODE_MIN_DISTANCE * 1.5;
    for (const id of candidates) {
      const point = grid.point(id);
      let sum = 0, total = 0;
      history.forEach((layout, index) => {
        const recency = index === history.length - 1 ? 4 : 1;
        let nearest = Infinity;
        for (const previous of layout) nearest = Math.min(nearest, P.Collision.distance(point, previous));
        sum += recency * Math.min(1, nearest / radius) ** 2;
        total += recency;
      });
      weights[id] = sum / total;
    }
    return weights;
  }

  function weightedChoice(items, weight, random) {
    let total = 0;
    const weights = items.map(item => { const value = weight(item); total += value; return value; });
    let draw = random() * total;
    for (let i = 0; i < items.length; i++) {
      draw -= weights[i];
      if (draw <= 0) return items[i];
    }
    return items.at(-1);
  }

  function landmarkPool(grid, candidates, desired, random, freshness) {
    const points = candidates.map(id => ({ id, ...grid.point(id) }));
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const point of points) {
      left = Math.min(left, point.x); right = Math.max(right, point.x);
      top = Math.min(top, point.y); bottom = Math.max(bottom, point.y);
    }
    const width = Math.max(grid.cellSize, right - left), height = Math.max(grid.cellSize, bottom - top);
    const cols = Math.max(1, Math.min(desired,
      Math.round(Math.sqrt(desired * width / height) * (0.85 + random() * 0.3))));
    const rows = Math.ceil(desired / cols);
    // Shift the internal sector boundaries as well as sampling within them.
    // A fixed grid otherwise keeps snapping landmarks to the same corridors.
    const xCuts = Array.from({ length: cols - 1 }, (_, i) => left + (i + 0.75 + random() * 0.5) * width / cols);
    const yCuts = Array.from({ length: rows - 1 }, (_, i) => top + (i + 0.75 + random() * 0.5) * height / rows);
    const sector = point => xCuts.filter(cut => point.x >= cut).length +
      cols * yCuts.filter(cut => point.y >= cut).length;
    const buckets = Array.from({ length: cols * rows }, () => []);
    for (const point of points) buckets[sector(point)].push(point);
    const pool = new Set();
    for (let s = 0; s < buckets.length; s++) {
      if (!buckets[s].length) continue;
      // Sample real safe cells, not just the nearest cell to a sector center.
      // This lets successive maps use the length of a narrow passage too.
      for (let sample = 0; sample < 8; sample++) {
        pool.add(buckets[s][Math.floor(random() * buckets[s].length)].id);
      }
    }
    const roomy = width >= P.Config.NODE_MIN_DISTANCE * 3 && height >= P.Config.NODE_MIN_DISTANCE * 3;
    const corner = points.reduce((best, point) => point.x + point.y < best.x + best.y ? point : best);
    const center = { x: left + width * (0.3 + random() * 0.4),
      y: top + height * (0.3 + random() * 0.4) };
    const interior = points.filter(point => point.x > left + width * 0.26 && point.x < right - width * 0.26 &&
      point.y > top + height * 0.26 && point.y < bottom - height * 0.26);
    const central = interior.length ? weightedChoice(interior, point => 0.08 + freshness[point.id] ** 2, random)
      : points.reduce((best, point) =>
        P.Collision.distance(point, center) < P.Collision.distance(best, center) ? point : best);
    // Retain an interior anchor, but choose its actual position anew. This
    // preserves interior passages without pinning every map to one center.
    pool.add(central.id);
    return { pool: [...pool], sector, initial: roomy ? central.id : corner.id };
  }

  function selectLandmarks(grid, candidates, desired, random, initial, pool, sector, freshness) {
    const selected = [], usedSectors = new Set();
    const minimumSquared = P.Config.NODE_MIN_DISTANCE ** 2;
    let next = initial;
    while (next !== undefined && selected.length < desired) {
      selected.push(next);
      usedSectors.add(sector(grid.point(next)));
      if (selected.length === desired) break;
      const chosenPoints = selected.map(grid.point);
      function choose(source) {
        const eligible = [];
        let bestScore = 0;
        for (const id of source) {
          const point = grid.point(id);
          let separation = Infinity;
          for (const other of chosenPoints) {
            separation = Math.min(separation, (point.x - other.x) ** 2 + (point.y - other.y) ** 2);
          }
          if (separation < minimumSquared) continue;
          let score = Math.sqrt(separation);
          if (!usedSectors.has(sector(point))) score *= 1.55;
          // History is a soft preference, so cramped pages can reuse cells.
          score *= 0.18 + 0.82 * freshness[id];
          // Prefer another side of a real obstacle when distances are similar.
          // This is bounded to the small stratified pool, not every grid cell.
          if (source === pool && chosenPoints.some(other =>
            P.Collision.segmentHits(point, other, grid.obstacleIndex, P.Config.PLAYER_RADIUS + 1))) score *= 1.18;
          eligible.push({ id, score });
          bestScore = Math.max(bestScore, score);
        }
        // Pick among several strong candidates instead of always taking the
        // one farthest cell, which repeatedly chooses the same extreme points.
        const shortlist = eligible.filter(item => item.score >= bestScore * 0.68);
        return weightedChoice(shortlist, item => (item.score / bestScore) ** 3, random)?.id;
      }
      next = choose(pool);
      // Small pages can use remaining safe grid points rather than failing
      // merely because two jittered sector targets were too close together.
      if (next === undefined) next = choose(candidates);
    }
    return { selected };
  }

  function layoutQuality(grid, selected, freshness) {
    const points = selected.map(grid.point).sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const hull = [];
    for (const point of points) {
      while (hull.length > 1 && cross(hull.at(-2), hull.at(-1), point) <= 0) hull.pop();
      hull.push(point);
    }
    const lowerLength = hull.length;
    for (let i = points.length - 2; i >= 0; i--) {
      while (hull.length > lowerLength && cross(hull.at(-2), hull.at(-1), points[i]) <= 0) hull.pop();
      hull.push(points[i]);
    }
    hull.pop();
    const area = Math.abs(hull.reduce((sum, point, i) => {
      const next = hull[(i + 1) % hull.length];
      return sum + point.x * next.y - point.y * next.x;
    }, 0)) / 2;
    const coverage = Math.min(1, area / (grid.width * grid.height * 0.5));
    const novelty = selected.reduce((sum, id) => sum + freshness[id], 0) / selected.length;
    return coverage + novelty * 1.5;
  }

  function pathLength(path) {
    let length = 0;
    for (let i = 1; i < path.length; i++) length += P.Collision.distance(path[i - 1], path[i]);
    return length;
  }

  function connectLandmarks(grid, selected, searches) {
    const count = selected.length;
    const paths = Array.from({ length: count }, () => Array(count));
    const lengths = Array.from({ length: count }, () => new Float64Array(count));
    let blockedPairs = 0;
    for (let i = 0; i < count; i++) {
      paths[i][i] = [grid.point(selected[i])];
      for (let j = i + 1; j < count; j++) {
        const direct = [grid.point(selected[i]), grid.point(selected[j])];
        let path = direct;
        if (P.Collision.segmentHits(...direct, grid.obstacleIndex, P.Config.PLAYER_RADIUS + 1)) {
          blockedPairs++;
          const forward = P.Pathfinding.simplify(
            P.Pathfinding.trace(searches[i].parents, selected[i], selected[j]).map(grid.point), grid.obstacleIndex);
          const backward = P.Pathfinding.simplify(
            P.Pathfinding.trace(searches[j].parents, selected[j], selected[i]).map(grid.point), grid.obstacleIndex).reverse();
          path = pathLength(forward) <= pathLength(backward) ? forward : backward;
        }
        paths[i][j] = path;
        paths[j][i] = path.slice().reverse();
        lengths[i][j] = lengths[j][i] = pathLength(path);
      }
    }
    // A third landmark can provide a shorter feasible detour. Metric closure
    // keeps the budget from rewarding avoidable backtracking in a grid route.
    for (let k = 0; k < count; k++) for (let i = 0; i < count; i++) for (let j = 0; j < count; j++) {
      if (lengths[i][k] + lengths[k][j] + 0.001 < lengths[i][j]) {
        lengths[i][j] = lengths[i][k] + lengths[k][j];
        paths[i][j] = paths[i][k].concat(paths[k][j].slice(1));
      }
    }
    return { paths, lengths, blockedSightlineRatio: blockedPairs / (count * (count - 1) / 2) };
  }

  function challengeMetrics(nodes, path, analysis, blockedSightlineRatio) {
    let turns = 0;
    for (let i = 1; i < path.length - 1; i++) {
      const ax = path[i].x - path[i - 1].x, ay = path[i].y - path[i - 1].y;
      const bx = path[i + 1].x - path[i].x, by = path[i + 1].y - path[i].y;
      const scale = Math.hypot(ax, ay) * Math.hypot(bx, by);
      if (scale && (ax * bx + ay * by) / scale < Math.cos(Math.PI / 6)) turns++;
    }
    const xs = nodes.map(node => node.x), ys = nodes.map(node => node.y);
    const routeExtent = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)) /
      (analysis.width * analysis.height);
    return { turns, blockedSightlineRatio, routeExtent };
  }

  function generate(analysis, reservedRects = [], random = Math.random, modeId = P.Config.DEFAULT_MODE, recentLayouts = []) {
    const C = P.Config;
    const mode = P.getMode(modeId);
    if (!Number.isFinite(analysis.width) || !Number.isFinite(analysis.height) ||
      analysis.width < 160 || analysis.height < 160) {
      throw new Error('窗口太小，无法生成路线。请扩大浏览器窗口后重试。');
    }
    const grid = P.Grid.build(analysis.width, analysis.height, analysis.rects, reservedRects);
    const candidates = grid.largestComponent.filter(id => {
      const point = grid.point(id);
      const margin = C.EDGE_MARGIN + C.HIT_RADIUS;
      return point.x >= margin && point.y >= margin && point.x <= analysis.width - margin &&
        point.y <= analysis.height - margin && !P.Collision.pointHits(point, grid.obstacleIndex, C.NODE_CLEARANCE);
    });
    if (candidates.length < C.MIN_NODES) {
      throw new Error('这片页面空白不足。请滚动到更宽敞的区域，再生成关卡。');
    }
    const baseDifficulty = P.Scoring.difficulty(analysis, grid, C.MIN_NODES);
    const desired = Math.min(mode.maxNodes, mode.targetNodes + Math.floor(baseDifficulty / 14));
    const freshness = historyWeights(grid, candidates, recentLayouts);
    let best, bestQuality = -Infinity, sector;
    // Only the winning proposal gets full graph searches and a reference tour.
    // Three small candidate pools improve variation without tripling pathfinding.
    for (let attempt = 0; attempt < 3; attempt++) {
      const sample = landmarkPool(grid, candidates, desired, random, freshness);
      sector = sample.sector;
      const proposal = selectLandmarks(grid, candidates, desired, random, sample.initial,
        sample.pool, sample.sector, freshness);
      const quality = layoutQuality(grid, proposal.selected, freshness);
      if (!best || proposal.selected.length > best.selected.length ||
          proposal.selected.length === best.selected.length && quality > bestQuality) {
        best = proposal; bestQuality = quality;
      }
    }
    // Starting at an extreme can fit four spaced nodes that a central first
    // choice would exclude on an awkward small component.
    for (let attempt = 1; best.selected.length < C.MIN_NODES && attempt < C.GENERATION_ATTEMPTS; attempt++) {
      const corner = candidates.reduce((id, candidate) => {
        const a = grid.point(id), b = grid.point(candidate);
        const sx = attempt & 1 ? -1 : 1, sy = attempt & 2 ? -1 : 1;
        return sx * b.x + sy * b.y < sx * a.x + sy * a.y ? candidate : id;
      });
      const proposal = selectLandmarks(grid, candidates, desired, random, corner, candidates, sector, freshness);
      if (proposal.selected.length > best.selected.length) best = proposal;
    }
    if (best.selected.length < C.MIN_NODES) {
      throw new Error('没有找到足够宽敞的连续路线。请换一个页面位置，再试一次。');
    }
    const searches = best.selected.map(id => P.Pathfinding.breadthFirst(grid, id, random));
    const connections = connectLandmarks(grid, best.selected, searches);
    const order = P.Pathfinding.shortestVisitOrder(connections.lengths);
    if (random() < 0.5) order.reverse();
    const nodes = order.map((index, id) => ({ id, ...grid.point(best.selected[index]),
      kind: id === 0 ? 'start' : id === order.length - 1 ? 'finish' : 'checkpoint' }));
    const referencePath = [];
    for (let i = 1; i < order.length; i++) {
      const section = connections.paths[order[i - 1]][order[i]];
      referencePath.push(...(referencePath.length ? section.slice(1) : section));
    }
    const referenceLength = pathLength(referencePath);
    const challenge = challengeMetrics(nodes, referencePath, analysis, connections.blockedSightlineRatio);
    const inkMultiplier = P.getInkMultiplier(mode.id, nodes.length);
    return { nodes, candidates, referencePath, referenceLength, maxInk: referenceLength * inkMultiplier,
      mode: mode.id, modeLabel: mode.label, inkMultiplier, trailLength: mode.trailLength,
      difficulty: P.Scoring.difficulty(analysis, grid, nodes.length, challenge), challenge,
      grid, obstacleIndex: grid.obstacleIndex };
  }

  P.LevelGenerator = Object.freeze({ generate });
})();
