(() => {
  'use strict';
  const P = globalThis.__PAGEPATH__ ||= {};
  const key = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;
  const point = rect => ({ x: Math.floor((rect.left + rect.right - 1) / 2) + 0.5,
    y: Math.floor((rect.top + rect.bottom - 1) / 2) + 0.5 });
  const length = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
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

  function simplify(points, index) {
    const result = [points[0]];
    for (let anchor = 0; anchor < points.length - 1;) {
      let next = anchor + 1;
      while (next + 1 < points.length && !P.Collision.segmentHits(points[anchor], points[next + 1], index)) next++;
      result.push(points[next]); anchor = next;
    }
    return result;
  }

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

  // Eligibility is only structural validation: no webpage density, distribution
  // or connected-area requirement can lock a difficulty in version 3.
  function assess(source) {
    const size = source?.width * source?.height;
    const available = source?.kind === 'pixel-mask' && Number.isInteger(source.width) && Number.isInteger(source.height) &&
      source.width > 0 && source.height > 0 && size <= (P.Config.PIXEL_MAP?.MAX_PIXELS ?? 8500000) &&
      source.obstacleMask?.length === size && source.walkableMask?.length === size && source.distanceMap?.length === size;
    return { available, reason: available ? '' : '请先完成当前页面的截图分析', ...(available ? sourceMetrics(source) : {}) };
  }
  function generate(source, reservedRects = [], random = Math.random, history = []) {
    return P.RouteMazeGenerator.generate(source, reservedRects, random, history);
  }
  P.MazeGeometry = Object.freeze({ components, decompose, rebuild, simplify, coversPage, contours });
  P.MazeGenerator = Object.freeze({ assess, generate });
})();
