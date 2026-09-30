(() => {
  'use strict';
  const P = globalThis.__PAGEPATH__ ||= {};

  function breadthFirst(grid, start, random = Math.random) {
    if (grid.weighted) return shortestPaths(grid, start);
    const distances = new Int32Array(grid.walkable.length).fill(-1);
    const parents = new Int32Array(grid.walkable.length).fill(-1);
    const queue = new Int32Array(grid.walkableCount);
    let head = 0, tail = 1;
    queue[0] = start;
    distances[start] = 0;
    while (head < tail) {
      const current = queue[head++];
      const neighbors = grid.neighbors(current);
      // Random tie-breaking changes same-page puzzles without sacrificing reachability.
      const offset = Math.floor(random() * Math.max(1, neighbors.length));
      for (let j = 0; j < neighbors.length; j++) {
        const next = neighbors[(j + offset) % neighbors.length];
        if (distances[next] !== -1) continue;
        distances[next] = distances[current] + 1;
        parents[next] = current;
        queue[tail++] = next;
      }
    }
    return { distances, parents };
  }

  function shortestPaths(grid, start) {
    const count = grid.walkable.length;
    const distances = new Float64Array(count).fill(Infinity);
    const parents = new Int32Array(count).fill(-1);
    const positions = new Int32Array(count).fill(-1);
    const heap = new Int32Array(count);
    let size = 0;
    function swap(a, b) {
      [heap[a], heap[b]] = [heap[b], heap[a]];
      positions[heap[a]] = a; positions[heap[b]] = b;
    }
    function update(id) {
      let position = positions[id];
      if (position < 0) { position = size++; heap[position] = id; positions[id] = position; }
      while (position > 0) {
        const parent = (position - 1) >> 1;
        if (distances[heap[parent]] <= distances[id]) break;
        swap(position, parent); position = parent;
      }
    }
    function pop() {
      const id = heap[0];
      positions[id] = -2; size--;
      if (size) {
        heap[0] = heap[size]; positions[heap[0]] = 0;
        let position = 0;
        while (position * 2 + 1 < size) {
          let child = position * 2 + 1;
          if (child + 1 < size && distances[heap[child + 1]] < distances[heap[child]]) child++;
          if (distances[heap[position]] <= distances[heap[child]]) break;
          swap(position, child); position = child;
        }
      }
      return id;
    }
    if (!Number.isInteger(start) || !grid.walkable[start]) return { distances, parents };
    distances[start] = 0; update(start);
    while (size) {
      const current = pop();
      for (const next of grid.neighbors(current)) {
        if (positions[next] === -2) continue;
        const distance = distances[current] + grid.edgeLength(current, next);
        if (distance + 1e-9 >= distances[next]) continue;
        distances[next] = distance; parents[next] = current; update(next);
      }
    }
    return { distances, parents };
  }

  function trace(parents, start, finish) {
    const path = [];
    let current = finish;
    while (current !== -1 && path.length <= parents.length) {
      path.push(current);
      if (current === start) return path.reverse();
      current = parents[current];
    }
    return [];
  }

  function simplify(points, obstacleIndex) {
    if (points.length <= 2) return points.slice();
    const result = [points[0]];
    let anchor = 0;
    while (anchor < points.length - 1) {
      let next = anchor + 1;
      // Stop at the first blocked shortcut: linear-time and conservative.
      while (next + 1 < points.length &&
        !P.Collision.segmentHits(points[anchor], points[next + 1], obstacleIndex, P.Config.PLAYER_RADIUS + 1)) next++;
      result.push(points[next]);
      anchor = next;
    }
    return result;
  }

  function improveVisitOrder(order, lengths) {
    // Open-path 2-opt can change either free endpoint as well as reverse an
    // interior section. A fixed pass cap keeps generation bounded on any page.
    for (let pass = 0; pass < order.length * 2; pass++) {
      let saving = 0.001, from = -1, through = -1;
      for (let i = 0; i < order.length - 1; i++) for (let j = i + 1; j < order.length; j++) {
        if (i === 0 && j === order.length - 1) continue;
        let oldCost = 0, newCost = 0;
        if (i > 0) {
          oldCost += lengths[order[i - 1]][order[i]];
          newCost += lengths[order[i - 1]][order[j]];
        }
        if (j + 1 < order.length) {
          oldCost += lengths[order[j]][order[j + 1]];
          newCost += lengths[order[i]][order[j + 1]];
        }
        if (oldCost - newCost > saving) { saving = oldCost - newCost; from = i; through = j; }
      }
      if (from < 0) break;
      while (from < through) {
        [order[from], order[through]] = [order[through], order[from]];
        from++; through--;
      }
    }
    return order;
  }

  function approximateVisitOrder(lengths) {
    const count = lengths.length;
    let best, bestCost = Infinity;
    function consider(order) {
      improveVisitOrder(order, lengths);
      let cost = 0;
      for (let i = 1; i < count; i++) cost += lengths[order[i - 1]][order[i]];
      if (cost < bestCost) { best = order; bestCost = cost; }
    }
    for (let start = 0; start < count; start++) {
      const nearest = [start], remaining = new Set(Array.from({ length: count }, (_, i) => i));
      remaining.delete(start);
      while (remaining.size) {
        let next = -1, distance = Infinity;
        for (const candidate of remaining) {
          if (lengths[nearest.at(-1)][candidate] < distance) {
            distance = lengths[nearest.at(-1)][candidate]; next = candidate;
          }
        }
        nearest.push(next); remaining.delete(next);
      }
      consider(nearest);

      // Cheapest insertion explores different tours from nearest-neighbor,
      // especially when the page has a cluster reached through one corridor.
      const inserted = [start];
      for (let i = 0; i < count; i++) if (i !== start) remaining.add(i);
      while (remaining.size) {
        let next = -1, position = -1, increase = Infinity;
        for (const candidate of remaining) for (let i = 0; i <= inserted.length; i++) {
          let delta = 0;
          if (i > 0) delta += lengths[inserted[i - 1]][candidate];
          if (i < inserted.length) delta += lengths[candidate][inserted[i]];
          if (i > 0 && i < inserted.length) delta -= lengths[inserted[i - 1]][inserted[i]];
          if (delta < increase) { increase = delta; next = candidate; position = i; }
        }
        inserted.splice(position, 0, next); remaining.delete(next);
      }
      consider(inserted);
    }
    return best;
  }

  function shortestVisitOrder(lengths) {
    const count = lengths.length;
    if (!count) return [];
    if (count > 12) return approximateVisitOrder(lengths);
    // Held–Karp with free endpoints. The 12-node cap keeps this below 50,000
    // states and gives unordered checkpoints a practical efficient reference.
    const states = 1 << count;
    const costs = new Float64Array(states * count).fill(Infinity);
    const previous = new Int8Array(states * count).fill(-1);
    for (let i = 0; i < count; i++) costs[(1 << i) * count + i] = 0;
    for (let mask = 1; mask < states; mask++) {
      for (let last = 0; last < count; last++) {
        const cost = costs[mask * count + last];
        if (!Number.isFinite(cost)) continue;
        for (let next = 0; next < count; next++) {
          if (mask & (1 << next)) continue;
          const index = (mask | (1 << next)) * count + next;
          const candidate = cost + lengths[last][next];
          if (candidate < costs[index]) { costs[index] = candidate; previous[index] = last; }
        }
      }
    }
    let mask = states - 1, last = 0;
    for (let i = 1; i < count; i++) if (costs[mask * count + i] < costs[mask * count + last]) last = i;
    const order = [];
    while (last !== -1) {
      order.push(last);
      const next = previous[mask * count + last];
      mask ^= 1 << last;
      last = next;
    }
    return order.reverse();
  }

  P.Pathfinding = Object.freeze({ breadthFirst, shortestPaths, trace, simplify, shortestVisitOrder });
})();
