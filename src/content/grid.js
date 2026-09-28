(() => {
  'use strict';
  const P = globalThis.__PAGEPATH__ ||= {};
  const DIRECTIONS = [[1, 0, 1, 2], [-1, 0, 2, 1], [0, 1, 4, 8], [0, -1, 8, 4]];

  function build(width, height, rects, exclusionRects = []) {
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

  P.Grid = Object.freeze({ build });
})();
