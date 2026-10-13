(() => {
  'use strict';
  const P = globalThis.__PAGEPATH__ ||= {};
  const draw = random => Math.max(0, Math.min(1 - Number.EPSILON, Number(random()) || 0));
  const squareDistance = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

  function weighted(weights, random) {
    let ticket = draw(random) * weights.reduce((sum, item) => sum + item.weight, 0);
    for (const item of weights) { if (ticket < item.weight) return item.value; ticket -= item.weight; }
    return weights.at(-1).value;
  }

  function reachableBeforeFinish(analysis, start, finish) {
    const { width, height, walkableMask } = analysis;
    const reached = new Uint8Array(walkableMask.length), radius = P.Config.HIT_RADIUS + 2;
    const radiusSquared = radius * radius;
    const open = (x, y) => walkableMask[y * width + x] &&
      ((x + .5 - finish.x) ** 2 + (y + .5 - finish.y) ** 2 > radiusSquared);
    const startX = Math.floor(start.x), startY = Math.floor(start.y);
    if (!open(startX, startY)) return reached;
    const pending = [startY * width + startX];
    reached[pending[0]] = 2;
    // Scanline flood needs one byte per pixel plus pending row runs, avoiding
    // another full-size integer pixel queue. The finish's trigger disk is a
    // temporary barrier only; the actual gameplay mask remains untouched.
    while (pending.length) {
      const at = pending.pop(), y = Math.floor(at / width), x = at % width;
      if (reached[at] === 1) continue;
      let left = x, right = x;
      while (left && reached[y * width + left - 1] !== 1 && open(left - 1, y)) left--;
      while (right + 1 < width && reached[y * width + right + 1] !== 1 && open(right + 1, y)) right++;
      reached.fill(1, y * width + left, y * width + right + 1);
      for (const row of [y - 1, y + 1]) {
        if (row < 0 || row >= height) continue;
        let inRun = false;
        for (let column = left; column <= right; column++) {
          const next = row * width + column;
          if (reached[next] === 1 || !open(column, row)) { inRun = false; continue; }
          if (!inRun && !reached[next]) { reached[next] = 2; pending.push(next); }
          inRun = true;
        }
      }
    }
    return reached;
  }

  function compactMultiplier(level, reachable, reservedRects, random) {
    const { analysis, nodes } = level, { width, height, walkableMask, distanceMap, componentLabels } = analysis;
    const rules = P.Config.COLLECTIBLES, start = nodes[0], finish = nodes.at(-1);
    const label = componentLabels[Math.floor(start.y) * width + Math.floor(start.x)];
    const threshold = analysis.stats?.walkableThreshold || 0, diagonal = Math.hypot(width, height);
    // A relocated toolbar replaces its former reservation. In drawing mode it
    // folds and stops receiving pointer events, so it cannot make a narrow but
    // playable maze ineligible for its guaranteed multiplier.
    const reserved = level.toolbarRect ? [level.toolbarRect] : reservedRects;
    const radii = [...new Set([rules.radius, 6, 4, 2, 1].filter(radius => radius <= rules.radius))];
    const disks = radii.map(radius => {
      const border = Math.ceil(radius), offsets = [];
      for (let y = -border; y <= border; y++) for (let x = -border; x <= border; x++) {
        if (Math.max(0, Math.abs(x) - .5) ** 2 + Math.max(0, Math.abs(y) - .5) ** 2 <= radius * radius) offsets.push([x, y]);
      }
      return offsets;
    });
    const fitsReservation = (point, radius) => reserved.every(rect => {
      const dx = Math.max(rect.x - point.x, 0, point.x - rect.x - rect.width);
      const dy = Math.max(rect.y - point.y, 0, point.y - rect.y - rect.height);
      return dx * dx + dy * dy > radius * radius;
    });
    let best = null, rank = -Infinity, score = -Infinity, center = null, centerRank = -Infinity, centerScore = -Infinity;
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
      const at = y * width + x;
      if (reachable[at] !== 1 || componentLabels[at] !== label) continue;
      const point = { x: x + .5, y: y + .5 };
      const endpointDistance = Math.sqrt(Math.min(squareDistance(point, start), squareDistance(point, finish)));
      if (endpointDistance <= P.Config.HIT_RADIUS + 2) continue;
      const candidateScore = endpointDistance / diagonal + draw(random) * .1;
      const pointRank = Number(fitsReservation(point, 1));
      if (pointRank > centerRank || pointRank === centerRank && candidateScore > centerScore) {
        center = { ...point, radius: 1 }; centerRank = pointRank; centerScore = candidateScore;
      }
      for (let i = 0; i < radii.length; i++) {
        const radius = radii[i], margin = P.Config.HIT_RADIUS + radius + 2;
        if (endpointDistance < margin || distanceMap[at] < radius + threshold + Math.SQRT1_2 ||
            point.x - radius < 0 || point.y - radius < 0 || point.x + radius > width || point.y + radius > height) continue;
        const candidateRank = (fitsReservation(point, radius) ? 100 : 0) + radius;
        if (candidateRank < rank || candidateRank === rank && candidateScore <= score) continue;
        if (!disks[i].every(([dx, dy]) => walkableMask[(y + dy) * width + x + dx] &&
            componentLabels[(y + dy) * width + x + dx] === label)) continue;
        best = { ...point, radius }; rank = candidateRank; score = candidateScore;
      }
    }
    // A subpixel passage can have a legal player center without accommodating
    // a whole visible disk. Keep the smallest glyph at that reachable center;
    // pickup still checks the gameplay mask and line of sight to the center.
    if (!best && !center) throw new Error('迷宫没有可放置倍率泡泡的通道');
    return best || center;
  }

  function placeCollectibles(level, reservedRects, random) {
    const rules = P.Config.COLLECTIBLES;
    const count = Math.min(rules.maxXpCount, 3 + level.stars + Math.floor(draw(random) * 3));
    const multiplier = weighted(rules.multiplierWeights, random), rewards = [];
    // Every map receives one multiplier. Roll it before geometry sampling so a
    // scarce placement cannot change rarity, and give it first choice of space.
    rewards.push({ id: 'multiplier-0', kind: 'multiplier', value: multiplier });
    for (let i = 0; i < count; i++) rewards.push({ id: 'xp-' + i, kind: 'xp', value: weighted(rules.xpWeights, random) });

    const { analysis, nodes } = level, { width, height, walkableMask, distanceMap, componentLabels } = analysis;
    const start = nodes[0], label = componentLabels[Math.floor(start.y) * width + Math.floor(start.x)];
    if (!label) throw new Error('迷宫起点不在可通行区域');
    const reachable = reachableBeforeFinish(analysis, start, nodes.at(-1));
    const radius = rules.radius, border = Math.ceil(radius), threshold = analysis.stats?.walkableThreshold || 0;
    const reserved = [...reservedRects, ...(level.toolbarRect ? [level.toolbarRect] : [])];
    const buckets = Array.from({ length: 24 }, () => ({ count: 0, points: [] }));
    const fitsReservation = (x, y) => reserved.every(rect => {
      const dx = Math.max(rect.x - x, 0, x - rect.x - rect.width);
      const dy = Math.max(rect.y - y, 0, y - rect.y - rect.height);
      return dx * dx + dy * dy > radius * radius;
    });
    // Reservoir sampling keeps bounded memory while retaining candidates from
    // each part of the page. A staggered 3px sampling lattice avoids a full-image
    // random draw per pixel while retaining narrow 20px+ bubble-sized passages.
    const sampleStep = 3;
    for (let y = border; y < height - border; y += sampleStep) for (let x = border + Math.floor((y - border) / sampleStep) % sampleStep;
      x < width - border; x += sampleStep) {
      const at = y * width + x;
      if (reachable[at] !== 1 || componentLabels[at] !== label || distanceMap[at] < radius + threshold + Math.SQRT1_2) continue;
      const p = { x: x + .5, y: y + .5 };
      if (nodes.some(node => squareDistance(p, node) < rules.endpointMargin ** 2) || !fitsReservation(p.x, p.y)) continue;
      const bucket = buckets[Math.min(3, Math.floor(y * 4 / height)) * 6 + Math.min(5, Math.floor(x * 6 / width))];
      const slot = Math.floor(draw(random) * ++bucket.count);
      if (bucket.points.length < 64) bucket.points.push(p);
      else if (slot < 64) bucket.points[slot] = p;
    }
    const offsets = [];
    for (let y = -border; y <= border; y++) for (let x = -border; x <= border; x++) {
      // Test every closed pixel square touched by the visible circle, not just
      // its center or four cardinal points. The whole bubble stays on the same
      // walkable mask used by collision and never straddles a thin wall.
      if (Math.max(0, Math.abs(x) - .5) ** 2 + Math.max(0, Math.abs(y) - .5) ** 2 <= radius * radius) offsets.push([x, y]);
    }
    const candidates = buckets.flatMap(bucket => bucket.points).filter(p => {
      const x = Math.floor(p.x), y = Math.floor(p.y);
      return offsets.every(([dx, dy]) => walkableMask[(y + dy) * width + x + dx] && componentLabels[(y + dy) * width + x + dx] === label);
    });
    const result = [], diagonal = Math.hypot(width, height), spacingSquared = rules.minSpacing ** 2;
    for (const reward of rewards) {
      let best = -1, bestScore = -Infinity;
      for (let i = 0; i < candidates.length; i++) {
        const p = candidates[i];
        const nearest = result.length ? Math.min(...result.map(other => squareDistance(p, other))) : Infinity;
        if (nearest < spacingSquared) continue;
        const score = (result.length ? Math.sqrt(nearest) / diagonal : 0) + draw(random) * .35;
        if (score > bestScore) { bestScore = score; best = i; }
      }
      if (best < 0) {
        if (reward.kind !== 'multiplier') break;
        result.push({ ...reward, ...compactMultiplier(level, reachable, reservedRects, random) });
        continue;
      }
      const [point] = candidates.splice(best, 1);
      result.push({ ...reward, ...point, radius });
    }
    return result;
  }

  // Rewards read the final maze only. They never alter its original content,
  // generated walls, collision mask, route, difficulty or connected regions.
  P.LevelGenerator = Object.freeze({
    generate(analysis, reservedRects = [], random = Math.random, history = []) {
      const level = P.MazeGenerator.generate(analysis, reservedRects, random, history);
      return { ...level, collectibles: placeCollectibles(level, reservedRects, random) };
    }
  });
})();
