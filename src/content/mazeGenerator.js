(() => {
  'use strict';
  const P = globalThis.__PAGEPATH__ ||= {};
  const cache = new WeakMap();
  const cleanupCache = new WeakMap();
  const eligibilityCache = new WeakMap(), attempts = new WeakMap();
  // Connection count follows the original passages. Runtime work is bounded
  // by candidate sampling and search attempts, never by an unlock quota.
  const LIMITS = Object.freeze({ thickness: 3, maxLength: 96,
    maxBoundaryConnections: 1, ...P.Config.MAZE_REQUIREMENTS });
  const reasons = {
    topology: '本次未找到连接原障碍且可通行的迷宫方案，可点新地图重试或换个页面位置',
    passage: '当前截图没有足够的连通通道生成迷宫，可换个页面位置后重试',
    toolbar: '工具栏遮挡了迷宫端点，请拖动工具栏后再试' };
  const key = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;
  const point = rect => ({ x: Math.floor((rect.left + rect.right - 1) / 2) + 0.5,
    y: Math.floor((rect.top + rect.bottom - 1) / 2) + 0.5 });
  const length = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function rng(seed) {
    return () => {
      seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const pick = (n, random) => Math.max(0, Math.min(n - 1, Math.floor(random() * n)));

  // These describe an actual playable maze, not additional unlock criteria.
  // A tiny hole in a photo cannot become a level just because its pixels are
  // connected, and a 32px segment is not a fallback maze.
  const routeScale = source => {
    const diagonal = Math.hypot(source.width, source.height);
    return { separation: Math.max(80, diagonal * 0.18),
      span: Math.max(128, diagonal * 0.32), length: Math.max(220, diagonal * 0.65) };
  };
  function coversPage(path, source, routeLength) {
    const scale = routeScale(source);
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const p of path) {
      left = Math.min(left, p.x); right = Math.max(right, p.x);
      top = Math.min(top, p.y); bottom = Math.max(bottom, p.y);
    }
    return routeLength >= scale.length && length(path[0], path.at(-1)) >= scale.separation &&
      Math.hypot(right - left, bottom - top) >= scale.span;
  }

  function mazeRegions(source, free) {
    const { width, height, obstacleMask, distanceMap } = source, area = width * height;
    const scale = routeScale(source);
    const candidates = free.list.filter(region => region.area >= Math.max(900, area * 0.006) &&
      Math.hypot(region.width, region.height) >= scale.span);
    if (!candidates.length) return [];
    // Flood the raw background from the viewport edge. This distinguishes
    // holes enclosed by foreground from the page's outer passages without
    // treating every bounded card interior as an obstacle or altering masks.
    const exterior = new Uint8Array(area), queue = new Int32Array(area);
    let head = 0, tail = 0;
    const offer = at => { if (!obstacleMask[at] && !exterior[at]) { exterior[at] = 1; queue[tail++] = at; } };
    for (let x = 0; x < width; x++) { offer(x); offer((height - 1) * width + x); }
    for (let y = 0; y < height; y++) { offer(y * width); offer(y * width + width - 1); }
    while (head < tail) {
      const at = queue[head++], x = at % width;
      if (x) offer(at - 1);
      if (x + 1 < width) offer(at + 1);
      if (at >= width) offer(at - width);
      if (at + width < area) offer(at + width);
    }
    const usable = new Set(candidates.filter(region => exterior[region.first] ||
      region.area >= area * 0.08 && Math.hypot(region.width, region.height) >= scale.span * 1.4).map(region => region.id));
    const roomy = new Set();
    for (let i = 0; i < area; i++) if (usable.has(free.labels[i]) && distanceMap[i] >= 12) roomy.add(free.labels[i]);
    return candidates.filter(region => roomy.has(region.id)).sort((a, b) =>
      Math.hypot(b.width, b.height) - Math.hypot(a.width, a.height) || b.area - a.area);
  }

  function sourceMetrics(source) {
    const { width, height, obstacleMask } = source;
    const bins = new Uint32Array(48);
    let obstaclePixels = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const blocked = obstacleMask[y * width + x];
        if (blocked) {
          obstaclePixels++;
          bins[Math.min(5, Math.floor(y * 6 / height)) * 8 + Math.min(7, Math.floor(x * 8 / width))]++;
        }
      }
    }
    return { obstacleRatio: obstaclePixels / (width * height),
      occupiedRegions: bins.filter(count => count >= width * height / 48 * 0.1).length };
  }

  // Exact horizontal-run decomposition of one connected free region. Each
  // convex rectangle is contractible and each shared overlap is one interval.
  // Consequently this adjacency graph has the same holes as the pixel region;
  // a connected E = V - 1 graph proves there is no alternative passage around
  // an obstacle. No grid rooms, synthetic border, or unreported walls are made.
  function decompose(mask, labels, label, width, height) {
    const vertices = [], edges = [], edgeKeys = new Set();
    let previous = [];
    for (let y = 0; y < height; y++) {
      const current = [], prior = new Map(previous.map(run => [`${run.left}:${run.right}`, run]));
      for (let x = 0; x < width;) {
        if (!mask[y * width + x] || labels[y * width + x] !== label) { x++; continue; }
        const left = x;
        while (x < width && mask[y * width + x] && labels[y * width + x] === label) x++;
        const right = x, above = prior.get(`${left}:${right}`);
        let id;
        if (above) { id = above.id; vertices[id].bottom = y + 1; }
        else {
          id = vertices.length; vertices.push({ id, left, right, top: y, bottom: y + 1 });
          if (vertices.length > 60000) return null;
        }
        current.push({ id, left, right });
      }
      let a = 0, b = 0;
      while (a < previous.length && b < current.length) {
        const first = previous[a], second = current[b], left = Math.max(first.left, second.left), right = Math.min(first.right, second.right);
        if (first.id !== second.id && left < right && !edgeKeys.has(key(first.id, second.id))) {
          edgeKeys.add(key(first.id, second.id));
          edges.push({ a: first.id, b: second.id, portal: { x: left, y, width: right - left, height: 1 },
            point: { x: Math.floor((left + right - 1) / 2) + 0.5, y } });
        }
        if (first.right <= second.right) a++;
        if (second.right <= first.right) b++;
      }
      previous = current;
    }
    const adjacency = vertices.map(() => []);
    for (const vertex of vertices) vertex.point = point(vertex);
    for (const [id, edge] of edges.entries()) {
      edge.length = length(vertices[edge.a].point, edge.point) + length(edge.point, vertices[edge.b].point);
      adjacency[edge.a].push({ id: edge.b, edge: id }); adjacency[edge.b].push({ id: edge.a, edge: id });
    }
    return { vertices, edges, adjacency, cycles: edges.length - vertices.length + 1 };
  }

  function boundaryLabels(mask, freeLabels, label, blockedLabels, width) {
    const result = new Set();
    for (let i = 0; i < mask.length; i++) if (mask[i] && freeLabels[i] === label) {
      const x = i % width;
      if (x && !mask[i - 1]) result.add(blockedLabels[i - 1]);
      if (x + 1 < width && !mask[i + 1]) result.add(blockedLabels[i + 1]);
      if (i >= width && !mask[i - width]) result.add(blockedLabels[i - width]);
      if (i + width < mask.length && !mask[i + width]) result.add(blockedLabels[i + width]);
    }
    result.delete(0); return result;
  }

  function bridgeCandidates(source, labels, blockedLabels, targetLabels) {
    const { width, height, obstacleMask: mask } = source, banks = new Map();
    function offer(a, b, fixed, vertical, boundaryA, boundaryB) {
      if (b - a + 1 > LIMITS.maxLength || b - a < 8 || boundaryA && boundaryB) return;
      const ax = vertical ? fixed : a, ay = vertical ? a : fixed, bx = vertical ? fixed : b, by = vertical ? b : fixed;
      const region = labels[Math.floor((ay + by) / 2) * width + Math.floor((ax + bx) / 2)];
      if (!targetLabels.has(region)) return;
      const first = blockedLabels[ay * width + ax], second = blockedLabels[by * width + bx];
      if (!first || !second || first === second) return;
      for (let offset = -1; offset <= 1; offset++) {
        const ai = (ay + (vertical ? 0 : offset)) * width + ax + (vertical ? offset : 0);
        const bi = (by + (vertical ? 0 : offset)) * width + bx + (vertical ? offset : 0);
        if (!boundaryA && !mask[ai] || !boundaryB && !mask[bi]) return;
        // A connector crosses exactly one existing gap and touches original
        // foreground at both ends, never another generated line or a third island.
        for (let at = a + 1; at < b; at++) {
          const x = vertical ? fixed + offset : at, y = vertical ? at : fixed + offset;
          if (mask[y * width + x]) return;
        }
      }
      const rect = vertical ? { x: fixed - 1, y: a, width: 3, height: b - a + 1 }
        : { x: a, y: fixed - 1, width: b - a + 1, height: 3 };
      const candidate = { rect, a: first, b: second, region, boundary: boundaryA || boundaryB,
        anchors: [{ kind: boundaryA ? 'viewport' : 'obstacle', x: ax, y: ay },
          { kind: boundaryB ? 'viewport' : 'obstacle', x: bx, y: by }],
        order: ((Math.imul(ax + bx, 73856093) ^ Math.imul(ay + by, 19349663)) >>> 0) };
      const bankKey = `${region}/${key(first, second)}`;
      const bank = banks.get(bankKey) || [];
      bank.push(candidate); bank.sort((u, v) => u.order - v.order);
      if (bank.length > 20) bank.length = 20;
      banks.set(bankKey, bank);
    }
    // The scan follows actual foreground boundaries; its stride only bounds
    // candidate sampling and never determines placement of a wall lattice.
    for (let y = 2; y < height - 2; y += 3) for (let x = 0; x < width;) {
      if (mask[y * width + x]) { x++; continue; }
      const start = x;
      while (x < width && !mask[y * width + x]) x++;
      offer(start ? start - 1 : 0, x < width ? x : width - 1, y, false, start === 0, x === width);
    }
    for (let x = 2; x < width - 2; x += 3) for (let y = 0; y < height;) {
      if (mask[y * width + x]) { y++; continue; }
      const start = y;
      while (y < height && !mask[y * width + x]) y++;
      offer(start ? start - 1 : 0, y < height ? y : height - 1, x, true, start === 0, y === height);
    }
    return [...banks.values()].flat();
  }

  function chooseConnections(boundaries, candidates, random) {
    const parent = new Map([...boundaries].map(id => [id, id])), selected = [];
    const buckets = new Map(), bucketSize = LIMITS.maxLength, separation = 6;
    function nearSelected(r) {
      for (let y = Math.floor((r.y - separation) / bucketSize); y <= Math.floor((r.y + r.height + separation) / bucketSize); y++) {
        for (let x = Math.floor((r.x - separation) / bucketSize); x <= Math.floor((r.x + r.width + separation) / bucketSize); x++) {
          for (const q of buckets.get(`${x}:${y}`) || []) {
            if (r.x < q.x + q.width + separation && r.x + r.width + separation > q.x &&
                r.y < q.y + q.height + separation && r.y + r.height + separation > q.y) return true;
          }
        }
      }
      return false;
    }
    function remember(r) {
      for (let y = Math.floor(r.y / bucketSize); y <= Math.floor((r.y + r.height) / bucketSize); y++) {
        for (let x = Math.floor(r.x / bucketSize); x <= Math.floor((r.x + r.width) / bucketSize); x++) {
          const key = `${x}:${y}`, bucket = buckets.get(key);
          if (bucket) bucket.push(r); else buckets.set(key, [r]);
        }
      }
    }
    function find(id) {
      let root = id;
      while (parent.get(root) !== root) root = parent.get(root);
      while (parent.get(id) !== id) { const next = parent.get(id); parent.set(id, root); id = next; }
      return root;
    }
    let boundaryCount = 0;
    const ordered = candidates.map(candidate => ({ candidate, weight: Math.max(candidate.rect.width, candidate.rect.height) *
      (0.85 + random() * 0.3) + (candidate.boundary ? 50 : 0) })).sort((a, b) => a.weight - b.weight);
    for (const { candidate } of ordered) {
      // Joining only distinct original blocked components keeps the obstacle
      // graph a forest: no line may close a loop around background. Anchors
      // never come from added lines, and lines cannot cross or touch each other.
      if (!parent.has(candidate.a) || !parent.has(candidate.b) || find(candidate.a) === find(candidate.b)) continue;
      if (candidate.boundary && boundaryCount >= LIMITS.maxBoundaryConnections) continue;
      const r = candidate.rect;
      if (nearSelected(r)) continue;
      parent.set(find(candidate.a), find(candidate.b)); selected.push(candidate);
      remember(r);
      boundaryCount += candidate.boundary ? 1 : 0;
      if (selected.length === boundaries.size - 1) break;
    }
    return selected.length === boundaries.size - 1 ? selected : null;
  }

  function closeMask(source, connections) {
    const { width, height } = source, mask = new Uint8Array(source.walkableMask);
    const threshold = source.stats?.walkableThreshold ?? 2 + Math.SQRT1_2, radius = Math.ceil(threshold);
    for (const { rect } of connections) {
      for (let y = Math.max(0, rect.y - radius); y < Math.min(height, rect.y + rect.height + radius); y++) {
        for (let x = Math.max(0, rect.x - radius); x < Math.min(width, rect.x + rect.width + radius); x++) {
          const dx = Math.max(rect.x - x, 0, x - (rect.x + rect.width - 1));
          const dy = Math.max(rect.y - y, 0, y - (rect.y + rect.height - 1));
          if (dx * dx + dy * dy <= threshold * threshold) mask[y * width + x] = 0;
        }
      }
    }
    return mask;
  }

  function simplify(points, index) {
    const result = [points[0]];
    for (let anchor = 0; anchor < points.length - 1;) {
      let next = anchor + 1;
      while (next + 1 < points.length && !P.Collision.segmentHits(points[anchor], points[next + 1], index)) next++;
      result.push(points[next]); anchor = next;
    }
    return result;
  }

  function endpoints(graph, analysis) {
    const result = [];
    for (const leaf of graph.vertices) {
      if (graph.adjacency[leaf.id].length !== 1) continue;
      let prior = -1, at = leaf.id, distance = 0, selected = -1;
      while (true) {
        const p = graph.vertices[at].point, index = Math.floor(p.y) * analysis.width + Math.floor(p.x);
        if (selected < 0 && analysis.distanceMap[index] >= 12) selected = at;
        if (at !== leaf.id && graph.adjacency[at].length !== 2) break;
        const next = graph.adjacency[at].find(item => item.id !== prior);
        if (!next) break;
        distance += graph.edges[next.edge].length; prior = at; at = next.id;
      }
      if (distance >= 48 && selected >= 0) result.push(selected);
    }
    return [...new Set(result)];
  }

  function routeFor(plan, reserved, random = () => 0) {
    if (plan.routes) {
      const suitable = plan.routes.filter(route => [route.referencePath[0], route.referencePath.at(-1)].every(p =>
        !reserved.some(rect => p.x >= rect.x - 12 && p.y >= rect.y - 12 &&
          p.x <= rect.x + rect.width + 12 && p.y <= rect.y + rect.height + 12)));
      return suitable.length ? suitable[pick(suitable.length, random)] : null;
    }
    const { graph, analysis } = plan;
    const separation = routeScale(analysis).separation;
    const allowed = new Set(plan.endpoints.filter(id => {
      const p = graph.vertices[id].point;
      return !reserved.some(rect => p.x >= rect.x - 12 && p.y >= rect.y - 12 &&
        p.x <= rect.x + rect.width + 12 && p.y <= rect.y + rect.height + 12);
    }));
    if (allowed.size < 2) return null;
    function farthest(start, separated = false) {
      const queue = [start], parents = new Int32Array(graph.vertices.length).fill(-1), via = new Int32Array(graph.vertices.length).fill(-1);
      const distances = new Float64Array(graph.vertices.length).fill(-1); distances[start] = 0;
      let finish = -1;
      for (let head = 0; head < queue.length; head++) {
        const at = queue[head];
        if (allowed.has(at) && (!separated || length(graph.vertices[start].point, graph.vertices[at].point) >= separation) &&
            (finish < 0 || distances[at] > distances[finish])) finish = at;
        for (const next of graph.adjacency[at]) if (distances[next.id] < 0) {
          parents[next.id] = at; via[next.id] = next.edge;
          distances[next.id] = distances[at] + graph.edges[next.edge].length; queue.push(next.id);
        }
      }
      return { finish, parents, via };
    }
    const start = farthest([...allowed][pick(allowed.size, random)]).finish;
    const { finish, parents, via } = farthest(start, true), ids = [], points = [];
    if (finish < 0) return null;
    for (let at = finish; at !== -1; at = parents[at]) ids.push(at);
    ids.reverse();
    for (let i = 0; i < ids.length; i++) {
      if (i) points.push(graph.edges[via[ids[i]]].point);
      points.push(graph.vertices[ids[i]].point);
    }
    const referencePath = simplify(points, plan.index);
    let referenceLength = 0, turns = 0;
    for (let i = 1; i < referencePath.length; i++) referenceLength += length(referencePath[i - 1], referencePath[i]);
    for (let i = 1; i + 1 < referencePath.length; i++) {
      const a = referencePath[i - 1], b = referencePath[i], c = referencePath[i + 1], ab = length(a, b), bc = length(b, c);
      if (ab >= 12 && bc >= 12 && ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / ab / bc < Math.cos(Math.PI / 6)) turns++;
    }
    const direct = length(referencePath[0], referencePath.at(-1));
    plan.routeMetrics = { turns, referenceLength, detourRatio: referenceLength / Math.max(1, direct) };
    if (!coversPage(referencePath, analysis, referenceLength)) return null;
    if (plan.constructed ? turns < 4 :
      turns < 8 || referenceLength < Math.hypot(analysis.width, analysis.height) * 1.3 || referenceLength < direct * 1.7) return null;
    return { referencePath, referenceLength, turns, ids };
  }
  // Exact separable squared Euclidean distance transform. This is a one-time
  // local JS rebuild; gameplay reads the resulting cache and never loads WASM.
  function distances(mask, width, height) {
    const result = new Float32Array(mask.length), span = Math.max(width, height);
    const f = new Float64Array(span), d = new Float64Array(span), v = new Int32Array(span), z = new Float64Array(span + 1);
    function axis(n) {
      let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
      for (let q = 1; q < n; q++) {
        let s;
        do {
          const at = v[k]; s = ((f[q] + q * q) - (f[at] + at * at)) / (2 * (q - at));
          if (s > z[k]) break;
          k--;
        } while (k >= 0);
        k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
      }
      k = 0;
      for (let q = 0; q < n; q++) {
        while (z[k + 1] < q) k++;
        d[q] = (q - v[k]) ** 2 + f[v[k]];
      }
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) f[x] = mask[y * width + x] ? 0 : 1e12;
      axis(width);
      for (let x = 0; x < width; x++) result[y * width + x] = d[x];
    }
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) f[y] = result[y * width + x];
      axis(height);
      for (let y = 0; y < height; y++) result[y * width + x] = Math.min(Math.sqrt(d[y]),
        x + 0.5, y + 0.5, width - x - 0.5, height - y - 0.5);
    }
    return result;
  }

  function components(mask, width, height, connectivity = 4) {
    const labels = new Int32Array(mask.length), queue = new Int32Array(mask.length), list = [];
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i] || labels[i]) continue;
      const id = list.length + 1;
      let head = 0, tail = 1, left = width, right = 0, top = height, bottom = 0, sumX = 0, sumY = 0;
      queue[0] = i; labels[i] = id;
      while (head < tail) {
        const at = queue[head++], x = at % width, y = Math.floor(at / width);
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
        sumX += x; sumY += y;
        if (x && mask[at - 1] && !labels[at - 1]) { labels[at - 1] = id; queue[tail++] = at - 1; }
        if (x + 1 < width && mask[at + 1] && !labels[at + 1]) { labels[at + 1] = id; queue[tail++] = at + 1; }
        if (at >= width && mask[at - width] && !labels[at - width]) { labels[at - width] = id; queue[tail++] = at - width; }
        if (at + width < mask.length && mask[at + width] && !labels[at + width]) { labels[at + width] = id; queue[tail++] = at + width; }
        if (connectivity === 8) {
          for (const delta of [-width - 1, -width + 1, width - 1, width + 1]) {
            const next = at + delta;
            if (next >= 0 && next < mask.length && Math.abs(next % width - x) === 1 && mask[next] && !labels[next]) {
              labels[next] = id; queue[tail++] = next;
            }
          }
        }
      }
      list.push({ id, first: i, area: tail, left, top, width: right - left + 1, height: bottom - top + 1,
        bounds: { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }, cx: sumX / tail, cy: sumY / tail });
    }
    return { labels, list: list.sort((a, b) => b.area - a.area) };
  }

  function contours(mask, width, height) {
    const lines = [], bucketSize = P.Config.PIXEL_MAP?.CONTOUR_BUCKET_SIZE ?? 64;
    for (let y = 0; y <= height; y++) {
      let start = -1, polarity = 0;
      for (let x = 0; x <= width; x++) {
        const next = (y < height && x < width ? mask[y * width + x] : 0) -
          (y > 0 && x < width ? mask[(y - 1) * width + x] : 0);
        if (start >= 0 && next !== polarity) { lines.push(start, y, x, y); start = -1; }
        if (next && start < 0) { start = x; polarity = next; }
      }
    }
    for (let x = 0; x <= width; x++) {
      let start = -1, polarity = 0;
      for (let y = 0; y <= height; y++) {
        const next = (x < width && y < height ? mask[y * width + x] : 0) -
          (x > 0 && y < height ? mask[y * width + x - 1] : 0);
        if (start >= 0 && next !== polarity) { lines.push(x, start, x, y); start = -1; }
        if (next && start < 0) { start = y; polarity = next; }
      }
    }
    const buckets = Object.create(null);
    for (let i = 0; i < lines.length; i += 4) {
      for (let by = Math.floor(Math.min(lines[i + 1], lines[i + 3]) / bucketSize); by <= Math.floor(Math.max(lines[i + 1], lines[i + 3]) / bucketSize); by++) {
        for (let bx = Math.floor(Math.min(lines[i], lines[i + 2]) / bucketSize); bx <= Math.floor(Math.max(lines[i], lines[i + 2]) / bucketSize); bx++) {
          (buckets[`${bx},${by}`] ||= []).push(i / 4);
        }
      }
    }
    return { segments: new Float32Array(lines), bucketSize, buckets };
  }

  function rebuild(source, walls, carvedMask = null) {
    const { width, height } = source, obstacleMask = new Uint8Array(carvedMask || source.obstacleMask);
    for (const rect of walls) for (let y = rect.y; y < rect.y + rect.height; y++) {
      obstacleMask.fill(1, y * width + rect.x, y * width + rect.x + rect.width);
    }
    const distanceMap = distances(obstacleMask, width, height);
    const clearance = source.stats?.clearance ?? ((P.Config.PLAYER_RADIUS ?? 1) + (P.Config.PIXEL_MAP?.SAFETY_MARGIN ?? 1));
    const walkableThreshold = source.stats?.walkableThreshold ?? clearance + Math.SQRT1_2;
    const walkableMask = new Uint8Array(obstacleMask.length);
    let obstaclePixels = 0, walkablePixels = 0;
    for (let i = 0; i < walkableMask.length; i++) {
      // Ordinary connectors and cleanup only remove floor. The explicit last
      // resort opens foreground, so its final EDT must also admit that floor.
      walkableMask[i] = (carvedMask || source.walkableMask[i]) && distanceMap[i] > walkableThreshold ? 1 : 0;
      obstaclePixels += obstacleMask[i]; walkablePixels += walkableMask[i];
    }
    const playable = components(walkableMask, width, height);
    return { kind: 'pixel-mask', width, height, maskWidth: width, maskHeight: height,
      obstacleMask, walkableMask, distanceMap, componentLabels: playable.labels, components: playable.list,
      contours: contours(walkableMask, width, height), stats: { ...source.stats, obstaclePixels, walkablePixels,
        obstacleRatio: obstaclePixels / obstacleMask.length, walkableRatio: walkablePixels / obstacleMask.length,
        componentCount: playable.list.length, clearance, walkableThreshold, maze: true } };
  }

  function prepare(source, attempt) {
    const eligibility = assess(source);
    const metrics = { obstacleRatio: eligibility.obstacleRatio, occupiedRegions: eligibility.occupiedRegions };
    const status = { plans: [], reason: eligibility.available ? reasons.topology : eligibility.reason, details: {}, metrics };
    if (!eligibility.available) return status;
    const { width, height } = source, area = width * height;
    const free = components(source.walkableMask, width, height);
    const candidates = mazeRegions(source, free).filter(component => component.area >= area * 0.12).slice(0, 3);
    if (!candidates.length) { status.reason = reasons.passage; return status; }
    const blockedMask = Uint8Array.from(source.walkableMask, value => value ? 0 : 1);
    const blocked = components(blockedMask, width, height, 8);
    const bridges = bridgeCandidates(source, free.labels, blocked.labels, new Set(candidates.map(item => item.id)));
    status.details.bridgeCandidates = bridges.length;
    const signatures = new Set();
    for (const component of candidates) {
      const boundaries = boundaryLabels(source.walkableMask, free.labels, component.id, blocked.labels, width);
      status.details.boundaries = boundaries.size;
      // Each original boundary island needs one bridge into the surrounding
      // blocked component. Final pixel topology is checked after adding them.
      status.details.originalCycles = boundaries.size - 1;
      if (!boundaries.size) continue;
      const choices = bridges.filter(candidate => candidate.region === component.id);
      for (let variant = 0; variant < 20 && status.plans.length < 3; variant++) {
        const connections = chooseConnections(boundaries, choices, rng(0x75b1 + attempt * 104729 + variant * 137));
        status.details.connections = connections?.length ?? -1;
        if (!connections) continue;
        const signature = connections.map(item => JSON.stringify(item.rect)).sort().join('/');
        if (signatures.has(signature)) continue;
        signatures.add(signature);
        let addedPixels = 0;
        for (const { rect } of connections) for (let y = rect.y; y < rect.y + rect.height; y++) {
          for (let x = rect.x; x < rect.x + rect.width; x++) if (!source.obstacleMask[y * width + x]) addedPixels++;
        }
        const mask = closeMask(source, connections), playable = components(mask, width, height);
        const region = playable.list.find(item => item.area >= component.area * 0.85 &&
          free.labels[item.first] === component.id);
        status.details.regionRatio = region ? region.area / area : 0;
        if (!region || region.area < area * 0.12) continue;
        let narrow = 0, stranded = false;
        const survivingLabels = new Int32Array(free.list.length + 1);
        for (let i = 0; i < mask.length; i++) {
          // Clearance around a connector can reach a third obstacle even when
          // its visible red pixels do not. Reject any newly separated pocket,
          // including tiny ones, rather than hiding it outside the chosen maze.
          if (mask[i]) {
            const before = free.labels[i], after = playable.labels[i];
            if (survivingLabels[before] && survivingLabels[before] !== after) { stranded = true; break; }
            survivingLabels[before] = after;
          }
          if (playable.labels[i] === region.id && source.distanceMap[i] <= 24) narrow++;
        }
        if (stranded) continue;
        if (narrow / region.area < 0.7) continue;
        status.details.narrowRatio = narrow / region.area;
        const graph = decompose(mask, playable.labels, region.id, width, height);
        status.details.finalCycles = graph?.cycles;
        if (!graph || graph.cycles !== 0 || graph.edges.length !== graph.vertices.length - 1) continue;
        const trial = { kind: 'pixel-mask', width, height, maskWidth: width, maskHeight: height,
          obstacleMask: source.obstacleMask, walkableMask: mask, componentLabels: playable.labels, distanceMap: source.distanceMap };
        const plan = { analysis: trial, graph, index: P.Collision.createMaskIndex(trial), connections,
          componentId: region.id, addedPixels, narrowRatio: narrow / region.area, metrics };
        plan.endpoints = endpoints(graph, trial);
        status.details.endpoints = plan.endpoints.length;
        const route = routeFor(plan, []);
        status.details.route = plan.routeMetrics;
        if (plan.endpoints.length < 3 || !route) continue;
        // A successful trial is rebuilt with the exact cached EDT, labels and
        // contours. Trials only add local clearance; equality checks prove the
        // final mask still has the topology that passed the natural-route test.
        const analysis = rebuild(source, connections.map(item => item.rect));
        for (let i = 0; i < mask.length; i++) if (analysis.walkableMask[i] !== mask[i]) throw new Error('迷宫像素边界验证失败');
        plan.analysis = analysis; plan.index = P.Collision.createMaskIndex(analysis);
        plan.componentId = analysis.componentLabels[region.first];
        plan.endpoints = endpoints(graph, analysis);
        if (plan.endpoints.length < 3 || !routeFor(plan, [])) continue;
        // Cache only the small bridge/topology/route witnesses. Full-size EDT,
        // labels and masks are recreated once for the selected generated map.
        // This also makes every randomly chosen route a prevalidated witness.
        const routes = [routeFor(plan, [])], terminals = plan.endpoints.slice();
        // More natural branches must not cause an unbounded quadratic search
        // for alternatives. The first route is already a validated solution.
        let routeAttempts = 0;
        for (let a = 0; a < terminals.length && routes.length < 16 && routeAttempts < 128; a++) {
          for (let b = a + 1; b < terminals.length && routes.length < 16 && routeAttempts < 128; b++) {
            routeAttempts++;
            const candidate = routeFor({ ...plan, endpoints: [terminals[a], terminals[b]] }, []);
            if (candidate && !routes.some(item => key(item.ids[0], item.ids.at(-1)) === key(candidate.ids[0], candidate.ids.at(-1)))) routes.push(candidate);
          }
        }
        status.plans.push({ graph, connections, addedPixels, metrics, routes,
          narrowRatio: plan.narrowRatio, deadEnds: terminals.length });
      }
      if (status.plans.length) break;
    }
    return status;
  }

  function prepared(source) {
    if (!source || typeof source !== 'object') return { plans: [], reason: reasons.topology };
    if (cache.has(source)) return cache.get(source);
    const attempt = attempts.get(source) || 0;
    const status = prepare(source, attempt);
    // A failed search must not poison a qualifying page's cache forever.
    // Retrying searches different bridge arrangements on the same screenshot.
    attempts.set(source, attempt + 1);
    if (status.plans.length) cache.set(source, status);
    return status;
  }

  function safeRoute(graph, analysis, reserved) {
    const index = P.Collision.createMaskIndex(analysis);
    const uncovered = p => !reserved.some(r => p.x >= r.x - 12 && p.y >= r.y - 12 &&
      p.x <= r.x + r.width + 12 && p.y <= r.y + r.height + 12);
    const terminals = graph.vertices.filter(vertex => {
      const p = vertex.point;
      return uncovered(p) && analysis.distanceMap[Math.floor(p.y) * analysis.width + Math.floor(p.x)] >= 12;
    }).map(vertex => vertex.id);
    if (terminals.length < 2) return null;
    const route = routeFor({ graph, analysis, index, endpoints: terminals, constructed: true }, []);
    return route ? { ...route, endpointClearance: 12 } : null;
  }

  // Extend a thin line into an existing foreground boundary. This adds no
  // artificial frame or closed room: every baffle is a single anchored stub.
  function anchoredStub(source, vertex, position, vertical, reverse, gap) {
    const { width, height, obstacleMask } = source;
    const low = vertical ? vertex.top : vertex.left, high = vertical ? vertex.bottom : vertex.right;
    let anchor = reverse ? high : low - 1;
    const limit = vertical ? height : width, step = reverse ? 1 : -1;
    const blocked = along => [-1, 0, 1].some(offset => obstacleMask[
      (vertical ? along : position + offset) * width + (vertical ? position + offset : along)]);
    while (anchor > 0 && anchor < limit - 1 && !blocked(anchor)) anchor += step;
    anchor = Math.max(0, Math.min(limit - 1, anchor));
    const tip = reverse ? low + gap : high - gap - 1;
    const from = Math.min(anchor, tip), to = Math.max(anchor, tip);
    const rect = vertical ? { x: position - 1, y: from, width: 3, height: to - from + 1 }
      : { x: from, y: position - 1, width: to - from + 1, height: 3 };
    return { rect, anchors: [{ kind: anchor === 0 || anchor === limit - 1 ? 'viewport' : 'obstacle',
      x: vertical ? position : anchor, y: vertical ? anchor : position }] };
  }

  // Horizontal-run vertices are a topology representation, not rooms. A few
  // letters beside a long corridor can split it into dozens of short vertices.
  // Recover long, actually empty rectangles across those artificial seams.
  function baffleCorridors(source, graph, minimumCross) {
    const { width, height } = source, mask = new Uint8Array(width * height);
    for (const vertex of graph.vertices) for (let y = vertex.top; y < vertex.bottom; y++) {
      mask.fill(1, y * width + vertex.left, y * width + vertex.right);
    }
    const eligible = r => Math.min(r.right - r.left, r.bottom - r.top) >= minimumCross &&
      Math.max(r.right - r.left, r.bottom - r.top) >= 60;
    const original = graph.vertices.filter(eligible), bands = new Map(), heights = new Int32Array(width);
    for (let y = 0; y < height; y++) {
      const stack = [];
      for (let x = 0; x <= width; x++) {
        const tall = x === width ? 0 : heights[x] = mask[y * width + x] ? heights[x] + 1 : 0;
        let left = x;
        while (stack.length && stack.at(-1).height > tall) {
          const prior = stack.pop(); left = prior.left;
          const rect = { left, right: x, top: y + 1 - prior.height, bottom: y + 1 };
          if (!eligible(rect)) continue;
          const id = `${left}:${x}`, previous = bands.get(id);
          if (!previous || previous.bottom - previous.top < prior.height) bands.set(id, rect);
        }
        if (tall && (!stack.length || stack.at(-1).height < tall)) stack.push({ left, height: tall });
      }
    }
    const rectArea = r => (r.right - r.left) * (r.bottom - r.top);
    const candidates = [...bands.values()].sort((a, b) => rectArea(b) - rectArea(a));
    const corridors = original.slice();
    for (const rect of candidates) {
      if (corridors.some(prior => Math.max(0, Math.min(rect.right, prior.right) - Math.max(rect.left, prior.left)) *
        Math.max(0, Math.min(rect.bottom, prior.bottom) - Math.max(rect.top, prior.top)) >= rectArea(rect) * 0.6)) continue;
      corridors.push({ ...rect, acrossRuns: true });
      if (corridors.length >= original.length + 24) break;
    }
    return { mask, corridors };
  }

  function baffles(source, graph, variant) {
    const walls = [], margin = Math.ceil(source.stats?.walkableThreshold ?? 2 + Math.SQRT1_2);
    // This is measured from the already-safe source boundary. After the new
    // wall's clearance is applied, at least eight center pixels remain open.
    const gap = Math.max(14, margin + 8);
    const { mask, corridors } = baffleCorridors(source, graph, gap + 12);
    const { width, height } = source, queue = new Int32Array(mask.length), visited = new Uint32Array(mask.length);
    let remaining = 0, firstOpen = -1, stamp = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) { remaining++; if (firstOpen < 0) firstOpen = i; }
    // Check each proposal with the real player clearance. One bad local wall
    // must not throw away every useful baffle in the rest of the corridor.
    function accept(wall) {
      const r = wall.rect, removed = [], threshold = source.stats?.walkableThreshold ?? 2 + Math.SQRT1_2;
      for (let y = Math.max(0, r.y - margin); y < Math.min(height, r.y + r.height + margin); y++) {
        for (let x = Math.max(0, r.x - margin); x < Math.min(width, r.x + r.width + margin); x++) {
          const dx = Math.max(r.x - x, 0, x - (r.x + r.width - 1));
          const dy = Math.max(r.y - y, 0, y - (r.y + r.height - 1)), at = y * width + x;
          if (mask[at] && dx * dx + dy * dy <= threshold * threshold) { mask[at] = 0; removed.push(at); }
        }
      }
      if (!removed.length) return false;
      let start = firstOpen;
      if (!mask[start]) start = mask.findIndex(value => value);
      let head = 0, tail = 0; stamp++;
      if (start >= 0) { queue[tail++] = start; visited[start] = stamp; }
      const offer = at => { if (mask[at] && visited[at] !== stamp) { visited[at] = stamp; queue[tail++] = at; } };
      while (head < tail) {
        const at = queue[head++], x = at % width;
        if (x) offer(at - 1); if (x + 1 < width) offer(at + 1);
        if (at >= width) offer(at - width); if (at + width < mask.length) offer(at + width);
      }
      if (!tail || tail !== remaining - removed.length) { for (const at of removed) mask[at] = 1; return false; }
      remaining = tail; firstOpen = start; walls.push(wall); return true;
    }
    for (const vertex of corridors) {
      const w = vertex.right - vertex.left, h = vertex.bottom - vertex.top;
      const vertical = w > h, cross = vertical ? h : w, span = vertical ? w : h;
      if (cross < gap + 12 || span < 60) continue;
      const pitch = Math.max(26, Math.min(40, Math.round(cross * 0.55)));
      const low = vertical ? vertex.left : vertex.top;
      let first = low + 14 + variant * 3;
      // When the native end wall has enough width, a short central stub makes
      // two genuinely separate dead-end arms before the winding main passage.
      // It touches only that original end wall and stops before all crossbars.
      if (cross >= 40 && span >= 80) {
        const position = Math.floor(((vertical ? vertex.top + vertex.bottom : vertex.left + vertex.right) - 1) / 2);
        const depth = Math.min(30, Math.floor(span / 4));
        const splitter = anchoredStub(source, vertex, position, !vertical, false, span - depth);
        const anchor = splitter.anchors[0];
        const anchorAt = vertical ? anchor.x : anchor.y;
        if (Math.abs(anchorAt - low) <= margin + 3 && accept(splitter)) first = low + depth + 16 + variant * 3;
      }
      const end = (vertical ? vertex.right : vertex.bottom) - 12;
      for (let at = first, count = 0; at < end; at += pitch, count++) {
        // Repeated sides form real accessible dead ends between baffles;
        // alternating sides keep the main passage long and winding.
        const reverse = ((count + variant) % 5 === 1 || (count + variant) % 5 === 4);
        const wall = anchoredStub(source, vertex, at, vertical, reverse, gap);
        // A vertex edge can be an internal rectangle-decomposition boundary.
        // Do not cross unrelated open floor while searching for an anchor.
        const before = reverse ? (vertical ? vertex.bottom : vertex.right) : (vertical ? vertex.top : vertex.left);
        const anchor = wall.anchors[0], distance = Math.abs((vertical ? anchor.y : anchor.x) - before);
        if (distance <= (vertex.acrossRuns ? Math.min(48, cross) : margin + 3)) accept(wall);
      }
    }
    return walls;
  }

  function intactRegions(source, original, mask) {
    const playable = components(mask, source.width, source.height), surviving = new Int32Array(original.list.length + 1);
    for (let i = 0; i < mask.length; i++) if (mask[i]) {
      const before = original.labels[i], after = playable.labels[i];
      if (surviving[before] && surviving[before] !== after) return null;
      surviving[before] = after;
    }
    return { ...playable, surviving };
  }

  function construct(source, reserved, random) {
    const { width, height } = source, original = components(source.walkableMask, width, height);
    const eligibility = assess(source), metrics = { obstacleRatio: eligibility.obstacleRatio, occupiedRegions: eligibility.occupiedRegions };
    let best = null;
    for (const region of mazeRegions(source, original).slice(0, 8)) {
      const initial = decompose(source.walkableMask, original.labels, region.id, width, height);
      if (!initial) continue;
      for (let variant = 0; variant < 3; variant++) {
        const visited = new Uint8Array(initial.vertices.length), tree = new Set();
        const queue = [pick(initial.vertices.length, random)]; visited[queue[0]] = 1;
        for (let head = 0; head < queue.length; head++) {
          const edges = initial.adjacency[queue[head]].slice();
          if (variant & 1) edges.reverse();
          for (const next of edges) if (!visited[next.id]) { visited[next.id] = 1; queue.push(next.id); tree.add(next.edge); }
        }
        // Close only the overlaps outside a spanning tree of the real pixel
        // region. Clearance may affect neighboring overlaps, so this abstract
        // choice is accepted only after checking every surviving source pixel.
        const cuts = initial.edges.filter((_, id) => !tree.has(id)).map(edge => {
          const x = Math.max(0, edge.portal.x), y = Math.max(0, Math.min(height - 3, edge.portal.y - 1));
          return { rect: { x, y, width: Math.min(width - x, edge.portal.width), height: Math.min(3, height) }, anchors: [] };
        });
        const baseMask = closeMask(source, cuts), base = intactRegions(source, original, baseMask);
        if (!base || !base.surviving[region.id]) continue;
        const baseGraph = decompose(baseMask, base.labels, base.surviving[region.id], width, height);
        if (!baseGraph || baseGraph.cycles !== 0) continue;
        const extra = baffles(source, baseGraph, variant);
        for (const additions of extra.length ? [extra, []] : [[]]) {
          const connections = [...cuts, ...additions], mask = closeMask(source, connections);
          const playable = intactRegions(source, original, mask), componentId = playable?.surviving[region.id];
          if (!componentId) continue;
          const graph = decompose(mask, playable.labels, componentId, width, height);
          if (!graph || graph.cycles !== 0) continue;
          const analysis = rebuild(source, connections.map(item => item.rect));
          let same = true, narrow = 0;
          for (let i = 0; i < mask.length; i++) {
            if (analysis.walkableMask[i] !== mask[i]) { same = false; break; }
            if (analysis.componentLabels[i] === componentId && analysis.distanceMap[i] <= 24) narrow++;
          }
          if (!same) continue;
          const route = safeRoute(graph, analysis, reserved);
          if (!route) continue;
          const deadEnds = graph.adjacency.filter(edges => edges.length === 1).length;
          const score = route.referenceLength * (1 + Math.min(24, route.turns) * 0.025) * (deadEnds >= 3 ? 1.15 : 1);
          if (!best || score > best.score) best = { kind: 'constructed-corridors', score, analysis, graph, route,
            connections, componentId, metrics, deadEnds,
            narrowRatio: narrow / analysis.components.find(item => item.id === componentId).area,
            addedPixels: analysis.stats.obstaclePixels - Math.round(metrics.obstacleRatio * width * height),
            construction: { baffles: additions.length, topologyCuts: cuts.length, endpointClearance: route.endpointClearance } };
          if (additions.length) break;
        }
      }
      // Compare the actual validated routes across the main page passages;
      // the first locally solvable component is not necessarily the best maze.
    }
    return best;
  }

  function assess(source) {
    const requirements = P.Config.MAZE_REQUIREMENTS;
    if (!source || source.kind !== 'pixel-mask' || !Number.isInteger(source.width) || !Number.isInteger(source.height) ||
        source.width < 1 || source.height < 1 || source.width * source.height > (P.Config.PIXEL_MAP?.MAX_PIXELS ?? 8500000) ||
        source.obstacleMask?.length !== source.width * source.height || source.walkableMask?.length !== source.width * source.height ||
        source.distanceMap?.length !== source.width * source.height) {
      return { available: false, reason: '请先完成当前页面的截图分析', requirements };
    }
    if (!eligibilityCache.has(source)) {
      // Unlocking is deliberately cheap and has exactly the two advertised
      // conditions. Wall count, route search and toolbar placement belong to
      // generation after the player selects this mode, never to this check.
      const metrics = sourceMetrics(source);
      const reason = metrics.obstacleRatio < requirements.minObstacleRatio
        ? `原网页障碍仅 ${Math.floor(metrics.obstacleRatio * 1000) / 10}%，第二关至少需要 ${requirements.minObstacleRatio * 100}%（不含补线）`
        : metrics.occupiedRegions < requirements.minOccupiedRegions
          ? `障碍仅分布在 ${metrics.occupiedRegions}/48 个区域，需要至少 ${requirements.minOccupiedRegions} 个区域有密集内容` : '';
      eligibilityCache.set(source, { available: !reason, reason, requirements, ...metrics });
    }
    return { ...eligibilityCache.get(source) };
  }

  function generate(source, reservedRects = [], random = Math.random) {
    return P.RouteMazeGenerator.generate(source, reservedRects, random);
  }
  // Keep the proven pixel geometry shared by the route-first planner. The
  // former grid-carving generator is no longer a playable entry point.
  P.MazeGeometry = Object.freeze({ components, decompose, rebuild, simplify, mazeRegions, coversPage });
  P.MazeGenerator = Object.freeze({ assess, generate });
})();
