(() => {
  'use strict';
  const P = globalThis.__PAGEPATH__ ||= {};
  const DIRECTIONS = [[1, 0, 1, 2], [-1, 0, 2, 1], [0, 1, 4, 8], [0, -1, 8, 4]];

  function build(width, height, rects, exclusionRects = []) {
    if (width?.kind === 'pixel-mask') return buildMask(width);
    if (rects?.kind === 'pixel-mask') return buildMask(rects);
    const C = P.Config;
    const cellSize = Math.max(C.GRID_SIZE, Math.ceil(Math.sqrt(width * height / C.MAX_GRID_CELLS)));
    const cols = Math.max(0, Math.floor(width / cellSize));
    const rows = Math.max(0, Math.floor(height / cellSize));
    const walkable = new Uint8Array(cols * rows);
    const edgeMasks = new Uint8Array(cols * rows);
    const obstacleIndex = P.Collision.createIndex([...rects, ...exclusionRects]);
    const point = id => ({ x: (id % cols + 0.5) * cellSize, y: (Math.floor(id / cols) + 0.5) * cellSize });
    for (let id = 0; id < walkable.length; id++) {
      const p = point(id);
      walkable[id] = p.x >= C.EDGE_MARGIN && p.y >= C.EDGE_MARGIN &&
        p.x <= width - C.EDGE_MARGIN && p.y <= height - C.EDGE_MARGIN &&
        !P.Collision.pointHits(p, obstacleIndex, C.PLAYER_RADIUS + 1) ? 1 : 0;
    }
    // Checking centers alone misses thin obstacles between neighboring cells.
    // Cache only edges whose complete line segment has safe clearance.
    for (let id = 0; id < walkable.length; id++) {
      if (!walkable[id]) continue;
      const x = id % cols, y = Math.floor(id / cols);
      for (const [dx, dy, bit, opposite] of [DIRECTIONS[0], DIRECTIONS[2]]) {
        if (x + dx >= cols || y + dy >= rows) continue;
        const next = id + dx + dy * cols;
        if (walkable[next] && !P.Collision.segmentHits(point(id), point(next), obstacleIndex, C.PLAYER_RADIUS + 1)) {
          edgeMasks[id] |= bit;
          edgeMasks[next] |= opposite;
        }
      }
    }
    function neighbors(id) {
      const result = [];
      for (const [dx, dy, bit] of DIRECTIONS) if (edgeMasks[id] & bit) result.push(id + dx + dy * cols);
      return result;
    }
    const visited = new Uint8Array(walkable.length);
    const components = [];
    let narrowCount = 0, walkableCount = 0;
    for (let id = 0; id < walkable.length; id++) {
      if (!walkable[id]) continue;
      walkableCount++;
      const degree = neighbors(id).length;
      if (degree <= 2) narrowCount++;
      if (visited[id]) continue;
      const component = [id];
      visited[id] = 1;
      for (let head = 0; head < component.length; head++) {
        for (const next of neighbors(component[head])) {
          if (!visited[next]) { visited[next] = 1; component.push(next); }
        }
      }
      components.push(component);
    }
    components.sort((a, b) => b.length - a.length);
    return { width, height, cellSize, cols, rows, walkable, edgeMasks, components,
      largestComponent: components[0] || [], obstacleIndex, point, neighbors,
      walkableCount, narrowRatio: walkableCount ? narrowCount / walkableCount : 1 };
  }

  function buildMask(analysis) {
    const obstacleIndex = P.Collision.createMaskIndex(analysis);
    const { width, height, walkableMask: mask } = obstacleIndex;
    const labels = analysis.componentLabels;
    if (labels?.length !== mask.length) throw new Error('截图地图缺少连通区域，请重新生成。');
    const C = P.Config;
    const cellSize = Math.max(C.GRID_SIZE, Math.ceil(Math.sqrt(width * height / C.MAX_GRID_CELLS)));
    const MAX_NAV_NODES = 120000;
    const rectangles = [], joins = [];
    let previous = [], walkablePixelCount = 0;
    const areas = new Map();
    // Run-length decomposition preserves even a one-pixel passage. Equal runs
    // on successive rows become a single convex navigation block.
    for (let y = 0; y < height; y++) {
      const current = [];
      const prior = new Map(previous.map(run => [`${run.left},${run.right}`, run]));
      for (let x = 0; x < width;) {
        if (!mask[y * width + x]) { x++; continue; }
        const left = x, label = labels[y * width + x];
        while (x < width && mask[y * width + x] && labels[y * width + x] === label) x++;
        const right = x;
        walkablePixelCount += right - left;
        areas.set(label, (areas.get(label) || 0) + right - left);
        const above = prior.get(`${left},${right}`);
        let id;
        if (above && above.label === label) {
          id = above.id; rectangles[id].bottom = y + 1;
        } else {
          id = rectangles.length;
          rectangles.push({ left, right, top: y, bottom: y + 1, label });
          if (rectangles.length > MAX_NAV_NODES) {
            throw new Error('截图细节过于密集，无法稳定生成路线。请换一个页面位置。');
          }
        }
        current.push({ left, right, id, label });
      }
      let a = 0, b = 0;
      while (a < previous.length && b < current.length) {
        const first = previous[a], second = current[b];
        const left = Math.max(first.left, second.left), right = Math.min(first.right, second.right);
        if (left < right && first.id !== second.id && first.label === second.label) {
          joins.push({ a: first.id, b: second.id, x: Math.floor((left + right - 1) / 2) + 0.5, y });
          if (joins.length > MAX_NAV_NODES) {
            throw new Error('截图细节过于密集，无法稳定生成路线。请换一个页面位置。');
          }
        }
        if (first.right <= second.right) a++;
        if (second.right <= first.right) b++;
      }
      previous = current;
    }

    const points = [], adjacency = [], nodeLabels = [], candidateIds = [];
    const groups = new Map();
    function addPoint(x, y, label, candidate = false) {
      if (points.length >= MAX_NAV_NODES) {
        throw new Error('截图细节过于密集，无法稳定生成路线。请换一个页面位置。');
      }
      const id = points.length;
      points.push({ x, y }); adjacency.push([]); nodeLabels.push(label);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(id);
      if (candidate) candidateIds.push(id);
      return id;
    }
    function connect(a, b) {
      if (a === b) return;
      adjacency[a].push(b); adjacency[b].push(a);
    }
    // Rectangle centers and portals form a sparse graph with exactly the same
    // four-connected topology as the mask. All edges stay inside their convex
    // block or cross one verified overlap; no coarse-grid gap can sever a route.
    for (const rect of rectangles) {
      rect.center = addPoint(Math.floor((rect.left + rect.right - 1) / 2) + 0.5,
        Math.floor((rect.top + rect.bottom - 1) / 2) + 0.5, rect.label, true);
    }
    for (const join of joins) {
      const portal = addPoint(join.x, join.y, rectangles[join.a].label);
      connect(rectangles[join.a].center, portal);
      connect(rectangles[join.b].center, portal);
    }
    // Bounded candidates sample roomy blocks and the length of thin blocks.
    // They affect puzzle placement, never the underlying collision topology.
    let sampled = 0;
    for (const rect of rectangles) {
      const xs = [], ys = [];
      for (let x = Math.ceil((rect.left - 0.5) / cellSize) * cellSize + 0.5; x < rect.right; x += cellSize) xs.push(x);
      for (let y = Math.ceil((rect.top - 0.5) / cellSize) * cellSize + 0.5; y < rect.bottom; y += cellSize) ys.push(y);
      if (!xs.length) xs.push(points[rect.center].x);
      if (!ys.length) ys.push(points[rect.center].y);
      for (const y of ys) for (const x of xs) {
        if (sampled >= C.MAX_GRID_CELLS) break;
        if (x === points[rect.center].x && y === points[rect.center].y) continue;
        const id = addPoint(x, y, rect.label, true);
        connect(id, rect.center); sampled++;
      }
    }
    const components = [...groups.entries()].sort((a, b) => areas.get(b[0]) - areas.get(a[0]))
      .map(([, ids]) => ids);
    let narrowPixels = 0;
    if (analysis.distanceMap?.length === mask.length) {
      for (let i = 0; i < mask.length; i++) if (mask[i] && analysis.distanceMap[i] < C.NODE_CLEARANCE) narrowPixels++;
    }
    return { kind: 'pixel-mask', width, height, cellSize, cols: 0, rows: 0,
      walkable: new Uint8Array(points.length).fill(1), walkableMask: mask,
      edgeMasks: null, components, largestComponent: components[0] || [], candidateIds,
      obstacleIndex, point: id => points[id], neighbors: id => adjacency[id],
      edgeLength: (a, b) => P.Collision.distance(points[a], points[b]), weighted: true,
      componentLabels: Int32Array.from(nodeLabels), walkableCount: points.length,
      walkablePixelCount, narrowRatio: walkablePixelCount ? narrowPixels / walkablePixelCount : 1 };
  }

  P.Grid = Object.freeze({ build, buildMask });
})();
