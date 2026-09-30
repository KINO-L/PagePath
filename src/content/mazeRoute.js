(() => {
  'use strict';
  const P = globalThis.__PAGEPATH__ ||= {};
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const scale = source => { const diagonal = Math.hypot(source.width, source.height); return {
    separation: Math.max(80, diagonal * 0.18), span: Math.max(128, diagonal * 0.32), length: Math.max(220, diagonal * 0.65) }; };
  const outside = (p, reserved, radius = 12) => !reserved.some(r => p.x >= r.x - radius && p.x <= r.x + r.width + radius &&
    p.y >= r.y - radius && p.y <= r.y + r.height + radius);

  // Navigation cells follow exact foreground runs. They are never drawn or
  // turned into a lattice: only their centers and overlaps guide the answer.
  function graphFor(source, clearance) {
    const { width, height, distanceMap, walkableMask } = source, vertices = [], edges = [], adjacency = [];
    let prior = [];
    for (let y = 0; y < height; y++) {
      const row = [], same = new Map(prior.map(r => [`${r.left}:${r.right}`, r]));
      for (let x = 0; x < width;) {
        if (!walkableMask[y * width + x] || distanceMap[y * width + x] < clearance) { x++; continue; }
        const left = x;
        while (x < width && walkableMask[y * width + x] && distanceMap[y * width + x] >= clearance) x++;
        const right = x, above = same.get(`${left}:${right}`);
        let id;
        if (above) { id = above.id; vertices[id].bottom = y + 1; }
        else { id = vertices.length; vertices.push({ left, right, top: y, bottom: y + 1 }); adjacency.push([]); }
        if (vertices.length > 60000) return null;
        row.push({ left, right, id });
      }
      let a = 0, b = 0;
      while (a < prior.length && b < row.length) {
        const first = prior[a], second = row[b], left = Math.max(first.left, second.left), right = Math.min(first.right, second.right);
        if (first.id !== second.id && left < right) {
          const edge = edges.length, point = { x: Math.floor((left + right - 1) / 2) + 0.5, y };
          edges.push({ a: first.id, b: second.id, point });
          adjacency[first.id].push({ id: second.id, edge }); adjacency[second.id].push({ id: first.id, edge });
        }
        if (first.right <= second.right) a++;
        if (second.right <= first.right) b++;
      }
      prior = row;
    }
    for (const v of vertices) v.point = { x: Math.floor((v.left + v.right - 1) / 2) + 0.5,
      y: Math.floor((v.top + v.bottom - 1) / 2) + 0.5 };
    for (const e of edges) e.length = distance(vertices[e.a].point, e.point) + distance(e.point, vertices[e.b].point);
    const seen = new Uint8Array(vertices.length), components = [];
    for (let i = 0; i < vertices.length; i++) if (!seen[i]) {
      const ids = [i]; seen[i] = 1;
      let area = 0, left = width, right = 0, top = height, bottom = 0;
      for (let head = 0; head < ids.length; head++) {
        const v = vertices[ids[head]]; area += (v.right - v.left) * (v.bottom - v.top);
        left = Math.min(left, v.left); right = Math.max(right, v.right); top = Math.min(top, v.top); bottom = Math.max(bottom, v.bottom);
        for (const e of adjacency[ids[head]]) if (!seen[e.id]) { seen[e.id] = 1; ids.push(e.id); }
      }
      components.push({ ids, area, left, right, top, bottom });
    }
    components.sort((a, b) => b.area - a.area);
    return { vertices, edges, adjacency, components };
  }

  function compress(points) {
    const result = [];
    for (const p of points) {
      if (result.length && distance(result.at(-1), p) < 1e-6) continue;
      while (result.length > 1) {
        const a = result.at(-2), b = result.at(-1), cross = (b.x - a.x) * (p.y - b.y) - (b.y - a.y) * (p.x - b.x);
        if (Math.abs(cross) > 1e-6 || (b.x - a.x) * (p.x - b.x) + (b.y - a.y) * (p.y - b.y) < 0) break;
        result.pop();
      }
      result.push({ x: p.x, y: p.y });
    }
    return result;
  }

  function metrics(path) {
    let referenceLength = 0, left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    for (let i = 0; i < path.length; i++) {
      const p = path[i]; left = Math.min(left, p.x); right = Math.max(right, p.x); top = Math.min(top, p.y); bottom = Math.max(bottom, p.y);
      if (i) referenceLength += distance(path[i - 1], p);
    }
    // Sample headings over a useful pen movement rather than counting every
    // pixel stair on the screenshot boundary as another difficulty turn.
    const samples = [path[0]];
    for (let i = 1; i < path.length; i++) if (distance(samples.at(-1), path[i]) >= 18 || i === path.length - 1) samples.push(path[i]);
    let turns = 0;
    for (let i = 1; i + 1 < samples.length; i++) {
      const a = samples[i - 1], b = samples[i], c = samples[i + 1], ab = distance(a, b), bc = distance(b, c);
      if (ab >= 12 && bc >= 12 && ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / ab / bc < Math.cos(Math.PI / 6)) turns++;
    }
    return { referenceLength, turns, direct: distance(path[0], path.at(-1)), span: Math.hypot(right - left, bottom - top) };
  }

  function properPath(path) {
    // A simple graph route stays in distinct convex navigation cells. Check
    // pixel-degenerate portal contacts too, since a protected self-crossing
    // answer would make it impossible to seal all alternative passages.
    const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const inBox = (a, b, p) => p.x >= Math.min(a.x, b.x) - 1e-7 && p.x <= Math.max(a.x, b.x) + 1e-7 &&
      p.y >= Math.min(a.y, b.y) - 1e-7 && p.y <= Math.max(a.y, b.y) + 1e-7;
    for (let i = 1; i < path.length; i++) for (let j = 1; j < i - 1; j++) {
      const a = path[i - 1], b = path[i], c = path[j - 1], d = path[j];
      if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.min(a.x, b.x) > Math.max(c.x, d.x) ||
          Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.min(a.y, b.y) > Math.max(c.y, d.y)) continue;
      const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
      if (abC * abD < 0 && cdA * cdB < 0 || Math.abs(abC) < 1e-7 && inBox(a, b, c) ||
          Math.abs(abD) < 1e-7 && inBox(a, b, d) || Math.abs(cdA) < 1e-7 && inBox(c, d, a) ||
          Math.abs(cdB) < 1e-7 && inBox(c, d, b)) return false;
    }
    return true;
  }

  function corridorPaths(source, clearance, random) {
    const { width, height } = source, heights = new Int32Array(width), candidates = [];
    const largestFirst = (a, b) => Math.max(b.right - b.left, b.bottom - b.top) - Math.max(a.right - a.left, a.bottom - a.top) ||
      (b.right - b.left) * (b.bottom - b.top) - (a.right - a.left) * (a.bottom - a.top);
    const retain = r => {
      const w = r.right - r.left, h = r.bottom - r.top;
      if (Math.min(w, h) < 26 || Math.max(w, h) < 160) return;
      candidates.push(r);
      if (candidates.length > 120) { candidates.sort(largestFirst); candidates.length = 60; }
    };
    for (let y = 0; y < height; y++) {
      const stack = [];
      for (let x = 0; x <= width; x++) {
        const h = x === width ? 0 : heights[x] = source.walkableMask[y * width + x] && source.distanceMap[y * width + x] >= clearance ? heights[x] + 1 : 0;
        let left = x;
        while (stack.length && stack.at(-1).height > h) { const previous = stack.pop(); left = previous.left;
          retain({ left, right: x, top: y + 1 - previous.height, bottom: y + 1 }); }
        if (h && (!stack.length || stack.at(-1).height < h)) stack.push({ left, height: h });
      }
    }
    candidates.sort(largestFirst);
    const result = [], accepted = [];
    for (const r of candidates) {
      if (accepted.some(a => r.left >= a.left && r.right <= a.right && r.top >= a.top && r.bottom <= a.bottom)) continue;
      accepted.push(r);
      const horizontal = r.right - r.left > r.bottom - r.top, low = horizontal ? r.left : r.top, high = horizontal ? r.right : r.bottom,
        sideLow = (horizontal ? r.top : r.left) + 3, sideHigh = (horizontal ? r.bottom : r.right) - 4;
      if (sideHigh - sideLow < 14) continue;
      const start = low + 14, finish = high - 15, points = [], cross = sideHigh - sideLow,
        pitch = Math.max(48, Math.min(62, cross * 1.15)), steps = Math.max(4, Math.floor((finish - start) / pitch));
      for (let i = 0; i <= steps; i++) {
        const along = start + (finish - start) * i / steps,
          side = i === 0 || i === steps ? (sideLow + sideHigh) / 2 : i % 2 ? sideLow + random() * 2 : sideHigh - random() * 2;
        points.push(horizontal ? { x: along, y: side } : { x: side, y: along });
      }
      result.push(points);
      if (result.length >= 12) break;
    }
    return result;
  }

  function natural(source, reserved, random, attempt) {
    const target = scale(source), { width, height } = source;
    let best = null;
    for (const clearance of [7, 5, 3]) {
      const graph = graphFor(source, Math.max(clearance, (source.stats?.walkableThreshold ?? 2.71) + 0.01));
      if (!graph) continue;
      for (const component of graph.components.slice(0, 4)) {
        if (component.area < Math.max(900, width * height * 0.006) ||
            Math.hypot(component.right - component.left, component.bottom - component.top) < target.span) continue;
        const eligible = component.ids.filter(id => { const p = graph.vertices[id].point; return outside(p, reserved) &&
          source.distanceMap[Math.floor(p.y) * width + Math.floor(p.x)] >= 12; });
        if (eligible.length < 2) continue;
        for (let trial = 0; trial < 24; trial++) {
          const start = eligible[Math.min(eligible.length - 1, Math.floor(random() * eligible.length))], seen = new Uint8Array(graph.vertices.length),
            parents = new Int32Array(graph.vertices.length).fill(-1), via = new Int32Array(graph.vertices.length).fill(-1),
            distances = new Float64Array(graph.vertices.length), stack = [start]; seen[start] = 1;
          while (stack.length) {
            const at = stack.pop(), neighbors = graph.adjacency[at].map(e => ({ e, rank: random() })).sort((a, b) => b.rank - a.rank);
            for (const { e } of neighbors) if (!seen[e.id]) { seen[e.id] = 1; parents[e.id] = at; via[e.id] = e.edge;
              distances[e.id] = distances[at] + graph.edges[e.edge].length; stack.push(e.id); }
          }
          const finishes = eligible.filter(id => distance(graph.vertices[start].point, graph.vertices[id].point) >= target.separation)
            .sort((a, b) => distances[b] - distances[a]).slice(0, 3);
          for (const finish of finishes) {
            const ids = [];
            for (let at = finish; at !== -1; at = parents[at]) ids.push(at);
            ids.reverse(); if (ids[0] !== start) continue;
            const points = [];
            for (let i = 0; i < ids.length; i++) { if (i) points.push(graph.edges[via[ids[i]]].point); points.push(graph.vertices[ids[i]].point); }
            const referencePath = compress(points), m = metrics(referencePath);
            if (m.referenceLength < target.length || m.span < target.span || !properPath(referencePath)) continue;
            const score = Math.min(m.referenceLength, Math.hypot(width, height) * 5) * (1 + Math.min(20, m.turns) * 0.03);
            if (!best || m.turns >= 4 && best.turns < 4 || (m.turns >= 4) === (best.turns >= 4) && score > best.score) best = { referencePath, ...m, score,
              meta: { kind: 'native-route', planningClearance: clearance, nativeArea: component.area,
                graphVertices: graph.vertices.length, attempt, carvedPixels: 0 } };
          }
        }
      }
      if (!best || best.turns < 4) for (const referencePath of corridorPaths(source, clearance, random)) {
        const m = metrics(referencePath);
        if (m.referenceLength < target.length || m.direct < target.separation || m.span < target.span || m.turns < 4 ||
            ![referencePath[0], referencePath.at(-1)].every(p => outside(p, reserved) && source.distanceMap[Math.floor(p.y) * width + Math.floor(p.x)] >= 12)) continue;
        const score = m.referenceLength * (1 + Math.min(20, m.turns) * 0.03);
        if (!best || best.turns < 4 || score > best.score) best = { referencePath, ...m, score,
          meta: { kind: 'native-corridor-route', planningClearance: clearance, attempt, carvedPixels: 0 } };
      }
      if (best?.turns >= 4) break;
    }
    return best;
  }

  function paintTube(mask, width, height, points, radius) {
    let removed = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], dx = b.x - a.x, dy = b.y - a.y, squared = dx * dx + dy * dy;
      for (let y = Math.max(0, Math.floor(Math.min(a.y, b.y) - radius)); y < Math.min(height, Math.ceil(Math.max(a.y, b.y) + radius)); y++) {
        for (let x = Math.max(0, Math.floor(Math.min(a.x, b.x) - radius)); x < Math.min(width, Math.ceil(Math.max(a.x, b.x) + radius)); x++) {
          const t = squared ? Math.max(0, Math.min(1, ((x + 0.5 - a.x) * dx + (y + 0.5 - a.y) * dy) / squared)) : 0;
          if (Math.hypot(x + 0.5 - a.x - t * dx, y + 0.5 - a.y - t * dy) <= radius) {
            const at = y * width + x; removed += mask[at]; mask[at] = 0;
          }
        }
      }
    }
    return removed;
  }

  // Only exceptional disconnected/solid pages need opening. The candidate is
  // one irregular, simple sweep with no cell grid, rooms or added shell walls.
  // Evaluate variants against original foreground so the least excavation wins.
  function opened(source, reserved, random, attempt) {
    const { width, height } = source, target = scale(source), radius = 16;
    const margin = Math.min(30, Math.max(18, Math.min(width, height) * 0.09));
    let best = null, originalLabels = null;
    const repeatsBackground = points => {
      if (!originalLabels) return false;
      const departed = new Map(); let previous = 0, traveled = 0, entryPoint = null, entryDistance = 0;
      for (let segment = 1; segment < points.length; segment++) {
        const a = points[segment - 1], b = points[segment], span = distance(a, b), steps = Math.max(1, Math.ceil(span / 3));
        for (let i = segment === 1 ? 0 : 1; i <= steps; i++) {
          const p = { x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps }, along = traveled + span * i / steps,
            label = originalLabels[Math.min(height - 1, Math.max(0, Math.floor(p.y))) * width + Math.min(width - 1, Math.max(0, Math.floor(p.x)))];
          if (label !== previous) {
            if (previous) departed.set(previous, along);
            // Re-entering one wide background room makes earlier bends
            // optional side excursions after pixel-topology verification.
            if (label && departed.has(label) && along - departed.get(label) > radius * 2) return true;
            previous = label; entryPoint = p; entryDistance = along;
          } else if (label && along - entryDistance > 80 && along - entryDistance > distance(entryPoint, p) * 1.7) return true;
        }
        traveled += span;
      }
      return false;
    };
    const consider = points => {
      if (!outside(points[0], reserved, 18) || !outside(points.at(-1), reserved, 18)) return;
      const m = metrics(points);
      // The player may cut the inside of each rounded turn. Reserve that
      // geometric saving before comparing difficulty, rather than counting
      // only the tube's decorative centerline as necessary travel.
      if (m.referenceLength < target.length + radius * 2 * m.turns || m.direct < target.separation ||
          m.span < target.span || m.turns < 4 || !properPath(points) || repeatsBackground(points)) return;
      const obstacleMask = new Uint8Array(source.obstacleMask), carvedPixels = paintTube(obstacleMask, width, height, points, radius);
      if (originalLabels?.some(label => label)) {
        // Existing background rooms can cut much larger corners than the
        // newly opened tube. Sample its centerline before visibility pruning
        // so the estimate can move the corner instead of merely dropping one
        // of the six original control points. Use raw floor conservatively:
        // the final player-clearance map can only remove these shortcuts.
        const samples = [points[0]], rawFloor = Uint8Array.from(obstacleMask, value => value ? 0 : 1),
          index = { kind: 'pixel-mask', width, height, walkableMask: rawFloor };
        for (let i = 1; i < points.length; i++) {
          const a = points[i - 1], b = points[i], count = Math.max(1, Math.ceil(distance(a, b) / 10));
          for (let at = 1; at <= count; at++) samples.push({ x: a.x + (b.x - a.x) * at / count, y: a.y + (b.y - a.y) * at / count });
        }
        const direct = [samples[0]];
        for (let anchor = 0; anchor + 1 < samples.length;) {
          let next = anchor + 1;
          while (next + 1 < samples.length && !P.Collision.segmentHits(samples[anchor], samples[next + 1], index)) next++;
          direct.push(samples[next]); anchor = next;
        }
        const necessary = metrics(direct);
        if (necessary.referenceLength < target.length * 1.04 || necessary.turns < 4) return;
      }
      // Actual pixels removed dominate selection. A short local opening in
      // a real passage wins over a new path drawn through all page content.
      const score = carvedPixels + m.referenceLength * 0.05;
      if (!best || score < best.score) best = { referencePath: points, ...m, score, obstacleMask,
        carvedPaths: [{ points: points.map(p => ({ ...p })), radius }],
        meta: { kind: 'opened-route', planningClearance: radius - 1, carvedPixels, attempt } };
    };
    // Favor existing long narrow background first. Such a passage may need
    // only small side openings to fit the inkstone and a few local bends.
    const graph = graphFor(source, Math.max(3, (source.stats?.walkableThreshold ?? 2.71) + 0.01));
    if (graph) {
      originalLabels = new Int32Array(width * height);
      for (let i = 0; i < graph.components.length; i++) for (const id of graph.components[i].ids) {
        const r = graph.vertices[id];
        for (let y = r.top; y < r.bottom; y++) originalLabels.fill(i + 1, y * width + r.left, y * width + r.right);
      }
    }
    if (graph) for (const r of graph.vertices.filter(r => Math.max(r.right - r.left, r.bottom - r.top) >= target.span)
      .sort((a, b) => Math.max(b.right - b.left, b.bottom - b.top) - Math.max(a.right - a.left, a.bottom - a.top)).slice(0, 24)) {
      const horizontal = r.right - r.left > r.bottom - r.top,
        low = Math.max(margin, horizontal ? r.left : r.top), high = Math.min((horizontal ? width : height) - margin, horizontal ? r.right : r.bottom),
        center = (horizontal ? r.top + r.bottom : r.left + r.right) / 2, span = high - low;
      const amplitude = Math.min(30, center - margin, (horizontal ? height : width) - margin - center);
      if (amplitude < 20 || span < target.separation) continue;
      const steps = Math.max(5, Math.floor(span / 48)), points = [];
      for (let i = 0; i <= steps; i++) {
        const along = low + span * i / steps, side = center + (i % 2 ? amplitude : -amplitude) * (0.92 + random() * 0.08);
        points.push(horizontal ? { x: along, y: side } : { x: side, y: along });
      }
      consider(points);
    }
    // On completely solid or highly fragmented screenshots there is no long
    // original passage to keep. Open a single local irregular polyline, not
    // a viewport-filling maze. Six staggered points already give four turns.
    for (let variant = 0; variant < 48; variant++) {
      const horizontal = variant % 2 === 0, long = horizontal ? width : height, cross = horizontal ? height : width, count = variant < 24 ? 6 : 8,
        span = Math.min(long - margin * 2, Math.max(230, Math.hypot(width, height) * (count === 6 ? 0.40 + random() * 0.09 : 0.55 + random() * 0.1)));
      if (span < 210 || span / (count - 1) < 40) continue;
      const amplitude = Math.min(cross * (count === 6 ? 0.18 : 0.23), span * (0.15 + random() * 0.03), (cross - margin * 2) / 2),
        alongStart = margin + random() * Math.max(0, long - margin * 2 - span),
        sideCenter = margin + amplitude + random() * Math.max(0, cross - margin * 2 - amplitude * 2), points = [];
      for (let i = 0; i < count; i++) {
        const along = alongStart + span * i / (count - 1),
          side = sideCenter + (i % 2 ? amplitude : -amplitude) * (0.88 + random() * 0.12);
        points.push(horizontal ? { x: along, y: side } : { x: side, y: along });
      }
      consider(points);
    }
    if (best) return best;
    for (let variant = 0; variant < 40; variant++) {
      const horizontal = variant % 2 === 0, long = horizontal ? width : height, cross = horizontal ? height : width;
      if (long <= margin * 2 + 80 || cross <= margin * 2 + 60) continue;
      const rows = 3;
      const points = [], bias = variant % 4 >= 2;
      for (let row = 0; row < rows; row++) {
        const along = margin + (cross - margin * 2) * row / (rows - 1);
        const low = margin + random() * Math.min(40, long * 0.08), high = long - margin - random() * Math.min(40, long * 0.08);
        const first = (row % 2 === 0) !== bias ? low : high, second = first === low ? high : low;
        // Different slants, bend positions and ends break the rectangular
        // pattern while preserving a strictly monotone non-crossing sweep.
        const tilt = (random() - 0.5) * Math.min(18, (cross - margin * 2) / rows * 0.22);
        const a = horizontal ? { x: first, y: along + (row ? tilt : 0) } : { x: along + (row ? tilt : 0), y: first };
        const b = horizontal ? { x: second, y: along - (row + 1 < rows ? tilt : 0) } : { x: along - (row + 1 < rows ? tilt : 0), y: second };
        points.push(a, b);
      }
      if (variant % 3 === 0) points.reverse();
      consider(points);
    }
    if (best) return best;
    // A dragged toolbar may cover all useful endpoints. Relocate it once; it
    // must not turn an otherwise qualified viewport into a generation failure.
    if (reserved.length) {
      const toolbarWidth = Math.min(372, width - 20), toolbarHeight = 48, margin = 6, clearance = 18;
      // Match the rendered width and positionToolbar's clamp; shrinking only
      // metadata would still leave the real controls covering the endpoint.
      const clampX = value => Math.max(margin, Math.min(width - toolbarWidth - margin, Math.round(value))),
        clampY = value => Math.max(margin, Math.min(height - toolbarHeight - margin, Math.round(value)));
      for (let retryNumber = 0; retryNumber < 4; retryNumber++) {
        const retry = opened(source, [], random, attempt);
        if (!retry) continue;
        const ends = [retry.referencePath[0], retry.referencePath.at(-1)],
          xs = new Set([margin, width - toolbarWidth - margin, (width - toolbarWidth) / 2,
            ...ends.flatMap(p => [p.x + clearance + 1, p.x - toolbarWidth - clearance - 1])].map(clampX)),
          ys = new Set([margin, height - toolbarHeight - margin, (height - toolbarHeight) / 2,
            ...ends.flatMap(p => [p.y + clearance + 1, p.y - toolbarHeight - clearance - 1])].map(clampY));
        for (const y of ys) for (const x of xs) {
          const toolbarRect = { x, y, width: toolbarWidth, height: toolbarHeight };
          if (ends.every(p => outside(p, [toolbarRect], clearance))) return { ...retry, toolbarRect };
        }
      }
    }
    return null;
  }

  function plan(source, reservedRects = [], random = Math.random, attempt = 0) {
    if (!source || source.obstacleMask?.length !== source.width * source.height || source.walkableMask?.length !== source.width * source.height ||
        source.distanceMap?.length !== source.width * source.height) throw new Error('迷宫缺少有效截图地图');
    let route = natural(source, reservedRects, random, attempt);
    // Several different original-terrain answers get a chance to be sealed
    // before the caller may request a last-resort opening at attempt six.
    if ((!route || route.turns < 4) && attempt >= 6 || attempt >= 12) route = opened(source, reservedRects, random, attempt) || route;
    if (!route) return null;
    const { score, direct, span, ...result } = route;
    return result;
  }
  P.MazeRoute = Object.freeze({ plan });
})();
