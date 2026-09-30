(() => {
  'use strict';
  const P = globalThis.__PAGEPATH__ ||= {};
  const DEFAULTS = Object.freeze({ maxComponentArea: 144, maxComponentSide: 24, maxGap: 5,
    maxWidth: 72, maxHeight: 36, maxArea: 1800, minDensity: 0.3,
    maxMembers: 24, maxCandidates: 30000, maxGroups: 1024, maxAddedRatio: 0.08 });

  // This pass belongs to the maze, not screenshot analysis. It only proposes
  // additional foreground rectangles. The caller rebuilds the single final
  // obstacle / clearance map together with the maze's line walls.
  function merge(source, options = {}) {
    const stats = { componentsBefore: 0, componentsAfter: 0, smallComponents: 0,
      candidateGroups: 0, mergedGroups: 0, mergedComponents: 0, addedPixels: 0,
      skippedConnectivity: 0, skippedLargeContent: 0, skippedSparse: 0, skippedBudget: 0 };
    const rects = [];
    const { width, height, obstacleMask, walkableMask } = source || {};
    const size = width * height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        size > (P.Config?.PIXEL_MAP?.MAX_PIXELS || 8500000) ||
        obstacleMask?.length !== size || walkableMask?.length !== size) {
      return { rects, stats: { ...stats, invalidSource: true } };
    }
    const limits = { ...DEFAULTS };
    for (const name of Object.keys(limits)) if (Number.isFinite(options[name]) && options[name] > 0) {
      // Options can tighten the conservative bounds; they cannot turn this
      // cleanup into arbitrary large rectangles over the original screenshot.
      limits[name] = name === 'minDensity' ? Math.max(limits[name], Math.min(1, options[name]))
        : Math.min(limits[name], options[name]);
    }
    const threshold = Number.isFinite(source.stats?.walkableThreshold) && source.stats.walkableThreshold >= 0
      ? source.stats.walkableThreshold
      : (source.stats?.clearance ?? (P.Config?.PLAYER_RADIUS || 1) + (P.Config?.PIXEL_MAP?.SAFETY_MARGIN || 1)) + Math.SQRT1_2;
    // Full-map arrays are allocated once; candidate connectivity checks use
    // bounded local patches, never a fresh viewport flood for each text glyph.
    const labels = new Int32Array(size), queue = new Int32Array(size), candidates = [];
    let label = 0;
    for (let first = 0; first < size; first++) {
      if (!obstacleMask[first] || labels[first]) continue;
      label++;
      let head = 0, tail = 1, left = first % width, right = left + 1,
        top = Math.floor(first / width), bottom = top + 1;
      labels[first] = label; queue[0] = first;
      while (head < tail) {
        const at = queue[head++], x = at % width, y = Math.floor(at / width);
        left = Math.min(left, x); right = Math.max(right, x + 1);
        top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
          const next = at + dy * width + dx;
          if (obstacleMask[next] && !labels[next]) { labels[next] = label; queue[tail++] = next; }
        }
      }
      if (tail <= limits.maxComponentArea && right - left <= limits.maxComponentSide && bottom - top <= limits.maxComponentSide) {
        stats.smallComponents++;
        if (candidates.length < limits.maxCandidates) candidates.push({ label, left, right, top, bottom, area: tail });
        else stats.skippedBudget++;
      }
    }
    stats.componentsBefore = stats.componentsAfter = label;
    if (candidates.length < 2) return { rects, stats };

    const parents = candidates.map((_, i) => i);
    const groups = candidates.map((c, i) => ({ ...c, members: [i] }));
    const find = i => { while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i]; } return i; };
    const buckets = new Map(), bucketSize = DEFAULTS.maxComponentSide + DEFAULTS.maxGap + 1;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i], bx = Math.floor((c.left + c.right) / 2 / bucketSize),
        by = Math.floor((c.top + c.bottom) / 2 / bucketSize), nearby = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        for (const j of buckets.get(`${bx + dx}:${by + dy}`) || []) {
          const b = candidates[j], gx = Math.max(0, c.left - b.right, b.left - c.right),
            gy = Math.max(0, c.top - b.bottom, b.top - c.bottom), distance = Math.hypot(gx, gy);
          if (distance <= limits.maxGap) nearby.push({ j, distance });
        }
      }
      nearby.sort((a, b) => a.distance - b.distance || a.j - b.j);
      for (const { j } of nearby) {
        const a = find(i), b = find(j);
        if (a === b) continue;
        const first = groups[a], second = groups[b], left = Math.min(first.left, second.left),
          right = Math.max(first.right, second.right), top = Math.min(first.top, second.top), bottom = Math.max(first.bottom, second.bottom);
        if (right - left > limits.maxWidth || bottom - top > limits.maxHeight ||
            (right - left) * (bottom - top) > limits.maxArea || first.members.length + second.members.length > limits.maxMembers) continue;
        // Grow rows or compact clusters first. Attaching one glyph from the
        // next row to a long text run would prematurely create a sparse box.
        if ((first.area + second.area) / ((right - left) * (bottom - top)) < limits.minDensity) {
          stats.skippedSparse++; continue;
        }
        parents[b] = a;
        groups[a] = { left, right, top, bottom, area: first.area + second.area, members: first.members.concat(second.members) };
      }
      const key = `${bx}:${by}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(i);
    }

    const working = new Uint8Array(walkableMask), addedBudget = Math.floor(size * limits.maxAddedRatio);
    const proposals = groups.filter((g, i) => find(i) === i && g.members.length > 1)
      .sort((a, b) => b.members.length - a.members.length || b.area - a.area || a.top - b.top || a.left - b.left);
    stats.candidateGroups = proposals.length;
    for (const group of proposals) {
      const { left, right, top, bottom } = group, area = (right - left) * (bottom - top), added = area - group.area;
      if (rects.length >= limits.maxGroups || stats.addedPixels + added > addedBudget) { stats.skippedBudget++; continue; }
      const members = new Set(group.members.map(i => candidates[i].label));
      let foreign = false;
      // Also check one surrounding pixel. A compact text block must not join
      // unrelated large foreground or a neighboring accepted cleanup block.
      for (let y = Math.max(0, top - 1); y < Math.min(height, bottom + 1) && !foreign; y++) {
        for (let x = Math.max(0, left - 1); x < Math.min(width, right + 1); x++) {
          const id = labels[y * width + x];
          if (id && !members.has(id)) { foreign = true; break; }
        }
      }
      if (!foreign) foreign = rects.some(r => left <= r.x + r.width && right >= r.x && top <= r.y + r.height && bottom >= r.y);
      if (foreign) { stats.skippedLargeContent++; continue; }
      const patch = clearancePatch(working, width, height, group, threshold);
      if (!preservesPassages(patch)) { stats.skippedConnectivity++; continue; }
      for (const at of patch.removed) working[at] = 0;
      rects.push({ x: left, y: top, width: right - left, height: bottom - top });
      stats.mergedGroups++; stats.mergedComponents += group.members.length;
      stats.componentsAfter -= group.members.length - 1; stats.addedPixels += added;
    }
    return { rects, stats };
  }

  function clearancePatch(working, width, height, rect, threshold) {
    const pad = Math.ceil(threshold) + 2, left = Math.max(0, rect.left - pad), top = Math.max(0, rect.top - pad),
      right = Math.min(width, rect.right + pad), bottom = Math.min(height, rect.bottom + pad),
      w = right - left, h = bottom - top, before = new Uint8Array(w * h), after = new Uint8Array(w * h), removed = [];
    const squared = threshold * threshold;
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const i = (y - top) * w + x - left, at = y * width + x;
      if (!working[at]) continue;
      before[i] = 1;
      const dx = Math.max(0, rect.left - x, x - (rect.right - 1)), dy = Math.max(0, rect.top - y, y - (rect.bottom - 1));
      if (dx * dx + dy * dy <= squared) removed.push(at);
      else after[i] = 1;
    }
    return { before, after, width: w, height: h, removed };
  }

  function preservesPassages({ before, after, width, height, removed }) {
    if (!removed.length) return true;
    const labels = new Int32Array(before.length), queue = new Int32Array(before.length), counts = [0];
    let id = 0;
    const flood = (mask, visited, first, value, visit) => {
      let head = 0, tail = 1;
      visited[first] = value; queue[0] = first;
      while (head < tail) {
        const at = queue[head++], x = at % width, y = Math.floor(at / width);
        visit(at);
        const offer = next => { if (mask[next] && !visited[next]) { visited[next] = value; queue[tail++] = next; } };
        if (x) offer(at - 1);
        if (x + 1 < width) offer(at + 1);
        if (y) offer(at - width);
        if (y + 1 < height) offer(at + width);
      }
    };
    for (let i = 0; i < before.length; i++) if (before[i] && !labels[i]) {
      counts[++id] = 0;
      flood(before, labels, i, id, () => counts[id]++);
    }
    const seen = new Uint8Array(id + 1), visited = new Uint8Array(after.length);
    for (let i = 0; i < after.length; i++) if (after[i] && !visited[i]) {
      const component = labels[i];
      // The surviving portion of every original local passage must remain
      // connected. This stricter local check also protects global connectivity
      // without assuming an alternate route exists elsewhere on the page.
      if (seen[component]) return false;
      seen[component] = 1;
      flood(after, visited, i, 1, () => {});
    }
    for (let i = 1; i <= id; i++) if (!seen[i] && counts[i] > 64) return false;
    return true;
  }

  P.MazeCleanup = Object.freeze({ merge });
})();
