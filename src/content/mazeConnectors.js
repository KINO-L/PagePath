(() => {
  'use strict';
  const P = globalThis.__PAGEPATH__ ||= {};
  const WIDTH = 3, RADIUS = WIDTH / 2;
  const clampRandom = random => Math.max(0, Math.min(0.999999999, Number(random()) || 0));

  // Pixel centres and round caps are shared by planning and the declared
  // geometry. No bounding rectangles are substituted for diagonal lines.
  function stroke(a, b, radius, width, height, visit) {
    const dx = b.x - a.x, dy = b.y - a.y, squared = dx * dx + dy * dy;
    const left = Math.max(0, Math.ceil(Math.min(a.x, b.x) - radius - 0.5));
    const right = Math.min(width - 1, Math.floor(Math.max(a.x, b.x) + radius - 0.5));
    const top = Math.max(0, Math.ceil(Math.min(a.y, b.y) - radius - 0.5));
    const bottom = Math.min(height - 1, Math.floor(Math.max(a.y, b.y) + radius - 0.5));
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
      const px = x + 0.5 - a.x, py = y + 0.5 - a.y;
      const t = squared ? Math.max(0, Math.min(1, (px * dx + py * dy) / squared)) : 0;
      if ((px - t * dx) ** 2 + (py - t * dy) ** 2 <= radius * radius + 1e-8 &&
          visit(y * width + x) === false) return false;
    }
    return true;
  }

  function plan(source, referencePath, random = Math.random) {
    const { width, height, obstacleMask: original } = source || {};
    const size = width * height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 ||
        size > (P.Config?.PIXEL_MAP?.MAX_PIXELS || 8500000) || original?.length !== size ||
        !Array.isArray(referencePath) || referencePath.length < 2 || referencePath.some(p =>
          !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x >= width || p.y >= height)) {
      throw new Error('迷宫连线缺少有效的地图或答案路线');
    }
    const obstacleMask = new Uint8Array(original), protectedPixels = new Uint8Array(size);
    const blockedCenters = new Uint8Array(size), labels = new Int32Array(size);
    const queue = new Int32Array(size), parents = new Int32Array(size).fill(-1);
    const distances = new Uint32Array(size), owner = new Int32Array(size);
    const clearance = source.stats?.walkableThreshold ?? 2 + Math.SQRT1_2;
    const protectionRadius = clearance + 3, centreRadius = protectionRadius + RADIUS + Math.SQRT1_2;
    const endpointRadius = Math.max(14, protectionRadius);
    for (let i = 1; i < referencePath.length; i++) {
      stroke(referencePath[i - 1], referencePath[i], protectionRadius, width, height, at => { protectedPixels[at] = 1; });
      stroke(referencePath[i - 1], referencePath[i], centreRadius, width, height, at => { blockedCenters[at] = 1; });
    }
    for (const p of [referencePath[0], referencePath.at(-1)]) {
      stroke(p, p, endpointRadius, width, height, at => { protectedPixels[at] = 1; });
      stroke(p, p, endpointRadius + RADIUS + Math.SQRT1_2, width, height, at => { blockedCenters[at] = 1; });
    }

    // Label original foreground with 8-connectivity; every edge-touching
    // component belongs to the same exterior component (id 1).
    const componentInfo = [null, { id: 1, area: 0, exterior: true }];
    let nextId = 2;
    for (let first = 0; first < size; first++) {
      if (!original[first] || labels[first]) continue;
      const provisional = nextId++;
      let head = 0, tail = 1, exterior = false;
      queue[0] = first; labels[first] = provisional;
      while (head < tail) {
        const at = queue[head++], x = at % width, y = Math.floor(at / width);
        exterior ||= !x || !y || x === width - 1 || y === height - 1;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
          const next = at + dy * width + dx;
          if (original[next] && !labels[next]) { labels[next] = provisional; queue[tail++] = next; }
        }
      }
      if (exterior) {
        for (let i = 0; i < tail; i++) labels[queue[i]] = 1;
        componentInfo[1].area += tail;
      } else componentInfo[provisional] = { id: provisional, area: tail, exterior: false };
    }
    const ids = componentInfo.filter(Boolean).map(item => item.id);
    const groups = new Int32Array(nextId);
    for (const id of ids) groups[id] = id;
    function find(id) {
      let root = id;
      while (groups[root] !== root) root = groups[root];
      while (groups[id] !== id) { const next = groups[id]; groups[id] = root; id = next; }
      return root;
    }
    function join(a, b) { a = find(a); b = find(b); if (a !== b) groups[b] = a; }

    // A geodesic Voronoi diagram supplies connectors at all angles, including
    // tiny glyphs that a spaced horizontal/vertical scan can miss entirely.
    // The answer corridor is excluded before propagation, not checked after
    // walls have already blocked the player's intended route.
    owner.set(labels);
    let head = 0, tail = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const at = y * width + x;
      if (blockedCenters[at]) continue;
      if (!x || !y || x === width - 1 || y === height - 1) {
        if (!owner[at]) owner[at] = 1;
        queue[tail++] = at;
      } else if (labels[at] && (!original[at - 1] || !original[at + 1] ||
          !original[at - width] || !original[at + width])) queue[tail++] = at;
    }
    const banks = new Map();
    function offer(a, b) {
      const first = owner[a], second = owner[b];
      if (!first || !second || first === second) return;
      const key = first < second ? `${first}:${second}` : `${second}:${first}`;
      const cost = distances[a] + distances[b] + 1;
      const current = banks.get(key);
      if (!current || cost < current.cost || cost === current.cost && clampRandom(random) < 0.1) {
        banks.set(key, { a, b, first, second, cost });
      }
    }
    const directions = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];
    const rotation = Math.floor(clampRandom(random) * directions.length);
    while (head < tail) {
      const at = queue[head++], x = at % width, y = Math.floor(at / width);
      for (let n = 0; n < directions.length; n++) {
        const [dx, dy] = directions[(n + rotation) % directions.length];
        if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
        const next = at + dy * width + dx;
        if (blockedCenters[next]) continue;
        if (owner[next]) { offer(at, next); continue; }
        owner[next] = owner[at]; parents[next] = at; distances[next] = distances[at] + 1;
        queue[tail++] = next;
      }
    }

    const point = at => ({ x: at % width + 0.5, y: Math.floor(at / width) + 0.5 });
    const wallSegments = [];
    let addedPixels = 0, rejectedProtected = 0, rejectedGeometry = 0;
    function clear(a, b) {
      if (!stroke(a, b, RADIUS, width, height, at => !protectedPixels[at])) return false;
      // Shortcuts stay in original background between their obstacle anchors.
      const length = Math.hypot(b.x - a.x, b.y - a.y), samples = Math.max(1, Math.ceil(length * 2));
      for (let i = 1; i < samples; i++) {
        const distance = i / samples * length;
        if (distance <= 1.6 || length - distance <= 1.6) continue;
        const x = Math.floor(a.x + (b.x - a.x) * i / samples);
        const y = Math.floor(a.y + (b.y - a.y) * i / samples);
        if (original[y * width + x]) return false;
      }
      return true;
    }
    function simplify(points) {
      const result = [points[0]];
      for (let anchor = 0; anchor + 1 < points.length;) {
        let next = anchor + 1;
        if (!clear(points[anchor], points[next])) return null;
        // Try the whole connection first: most Voronoi links are a single
        // diagonal stroke. Curved gaps keep only the bends they actually need.
        if (clear(points[anchor], points.at(-1))) next = points.length - 1;
        else while (next + 1 < points.length && clear(points[anchor], points[next + 1])) next++;
        result.push(points[next]); anchor = next;
      }
      return result;
    }
    const choices = [...banks.values()].map(candidate => ({ ...candidate,
      priority: candidate.cost * (0.78 + clampRandom(random) * 0.44) })).sort((a, b) => a.priority - b.priority);
    for (const candidate of choices) {
      if (find(candidate.first) === find(candidate.second)) continue;
      const left = [], right = [];
      for (let at = candidate.a; at >= 0; at = parents[at]) left.push(point(at));
      for (let at = candidate.b; at >= 0; at = parents[at]) right.push(point(at));
      left.reverse();
      const points = simplify(left.concat(right));
      if (!points) { rejectedGeometry++; continue; }
      const pixels = new Set(), touched = new Set([candidate.first, candidate.second]);
      let safe = true;
      for (let i = 1; i < points.length && safe; i++) safe = stroke(points[i - 1], points[i], RADIUS, width, height, at => {
        if (protectedPixels[at]) return false;
        pixels.add(at); if (labels[at]) touched.add(labels[at]);
      });
      if (!safe) { rejectedProtected++; continue; }
      const anchor = (p, componentId) => ({ ...p, componentId,
        kind: original[Math.floor(p.y) * width + Math.floor(p.x)] ? 'obstacle' : 'viewport' });
      wallSegments.push({ points, width: WIDTH, anchors: [anchor(points[0], candidate.first),
        anchor(points.at(-1), candidate.second)], components: [...touched] });
      for (const at of pixels) {
        if (!obstacleMask[at]) { obstacleMask[at] = 1; addedPixels++; }
        // Later strokes can attach to an earlier connector without confusing
        // it with a new foreground island or crossing a protected route.
        if (!labels[at]) labels[at] = candidate.first;
      }
      for (const id of touched) join(candidate.first, id);
    }
    // A naturally straight passage has no foreground islands to connect.
    // Preserve a planned winding answer by growing an occasional one-ended
    // baffle from the opposite original bank. The tip stops outside the
    // protected answer; no new room, enclosing outline, or grid is created.
    let baffles = 0;
    for (let i = 1; i + 1 < referencePath.length; i++) {
      const a = referencePath[i - 1], b = referencePath[i], c = referencePath[i + 1];
      const ab = Math.hypot(b.x - a.x, b.y - a.y), bc = Math.hypot(c.x - b.x, c.y - b.y);
      if (ab < 25 || bc < 25) continue;
      const q = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 };
      const dx = q.x - b.x, dy = q.y - b.y, bend = Math.hypot(dx, dy);
      if (bend < 12 || ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / ab / bc > 0.88) continue;
      // If the screenshot already obstructs this shortcut, another wall is
      // unnecessary. This keeps irregular website corridors largely intact.
      if (!stroke(a, c, clearance + 0.5, width, height, at => !original[at])) continue;
      const baseAngle = Math.atan2(dy, dx), sign = clampRandom(random) < 0.5 ? -1 : 1;
      const angles = [sign * 0.12, -sign * 0.12, 0, sign * 0.24, -sign * 0.24];
      let selected = null;
      for (const offset of angles) {
        const ux = Math.cos(baseAngle + offset), uy = Math.sin(baseAngle + offset);
        let tip = -1, anchorAt = -1, previousAt = -1;
        for (let d = 1; d <= Math.hypot(width, height); d += 0.75) {
          const x = Math.floor(b.x + ux * d), y = Math.floor(b.y + uy * d);
          if (x < 0 || y < 0 || x >= width || y >= height) break;
          const at = y * width + x;
          if (at === previousAt) continue;
          previousAt = at;
          if (blockedCenters[at]) { if (tip >= 0) break; continue; }
          if (original[at] || !x || !y || x === width - 1 || y === height - 1) {
            if (tip >= 0) anchorAt = at;
            break;
          }
          if (tip < 0) tip = at;
        }
        if (anchorAt < 0 || tip < 0) continue;
        const anchorPoint = point(anchorAt), tipPoint = point(tip);
        if (Math.hypot(anchorPoint.x - tipPoint.x, anchorPoint.y - tipPoint.y) < 8) continue;
        const pixels = new Set();
        let blocksShortcut = false;
        const acx = c.x - a.x, acy = c.y - a.y, ac2 = acx * acx + acy * acy;
        const valid = stroke(anchorPoint, tipPoint, RADIUS, width, height, at => {
          if (protectedPixels[at]) return false;
          const p = point(at), nearAnchor = Math.hypot(p.x - anchorPoint.x, p.y - anchorPoint.y) <= 4;
          if (obstacleMask[at] && !original[at] && !nearAnchor) return false;
          if (original[at] && !nearAnchor) return false;
          const t = ac2 ? Math.max(0, Math.min(1, ((p.x - a.x) * acx + (p.y - a.y) * acy) / ac2)) : 0;
          if (Math.hypot(p.x - a.x - t * acx, p.y - a.y - t * acy) <= clearance) blocksShortcut = true;
          pixels.add(at);
        });
        if (valid && blocksShortcut) { selected = { anchorPoint, tipPoint, anchorAt, pixels }; break; }
      }
      if (!selected) continue;
      const { anchorPoint, tipPoint, anchorAt, pixels } = selected;
      const componentId = labels[anchorAt] || 1;
      wallSegments.push({ kind: 'baffle', points: [anchorPoint, tipPoint], width: WIDTH,
        anchors: [{ ...anchorPoint, componentId, kind: original[anchorAt] ? 'obstacle' : 'viewport' }],
        components: [componentId] });
      for (const at of pixels) {
        if (!obstacleMask[at]) { obstacleMask[at] = 1; addedPixels++; }
        if (!labels[at]) labels[at] = componentId;
      }
      baffles++;
    }
    const roots = new Set(ids.map(find)), exterior = find(1);
    const unresolved = ids.filter(id => find(id) !== exterior);
    return { obstacleMask, wallSegments, meta: { kind: 'route-first-connectors',
      originalComponents: ids.length, remainingGroups: roots.size,
      unresolvedComponents: unresolved.length, unresolved, complete: roots.size === 1,
      candidates: choices.length, connectors: wallSegments.length, baffles, addedPixels,
      protectionRadius, endpointRadius, rejectedProtected, rejectedGeometry } };
  }
  P.MazeConnectors = Object.freeze({ plan });
})();
