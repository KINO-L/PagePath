(() => {
  'use strict';
  const P = globalThis.__PAGEPATH__ ||= {};
  const EPSILON = 1e-8;

  function createIndex(rects, cellSize = P.Config.HASH_CELL_SIZE) {
    const size = Math.max(8, Number(cellSize) || 64);
    const normalized = (rects || []).filter(rect =>
      [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
      rect.width > 0 && rect.height > 0
    ).map(rect => ({ ...rect, right: rect.x + rect.width, bottom: rect.y + rect.height }));
    const buckets = new Map();
    const large = [];
    normalized.forEach((rect, id) => {
      const x0 = Math.floor(rect.x / size), x1 = Math.floor(rect.right / size);
      const y0 = Math.floor(rect.y / size), y1 = Math.floor(rect.bottom / size);
      // A viewport-sized background must not create an unbounded hash table.
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) {
        large.push(id);
        return;
      }
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const key = `${x},${y}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(id);
      }
    });
    function query(left, top, right, bottom) {
      const x0 = Math.floor(left / size), x1 = Math.floor(right / size);
      const y0 = Math.floor(top / size), y1 = Math.floor(bottom / size);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) return normalized;
      const ids = new Set(large);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const bucket = buckets.get(`${x},${y}`);
        if (bucket) for (const id of bucket) ids.add(id);
      }
      return Array.from(ids, id => normalized[id]);
    }
    return { rects: normalized, cellSize: size, query };
  }

  // Slab intersection checks the entire motion segment, including contact.
  // Rectangles already include OBSTACLE_PADDING; radius adds the line width.
  function segmentRect(a, b, rect, radius) {
    let enter = 0, leave = 1;
    for (const [start, delta, low, high] of [
      [a.x, b.x - a.x, rect.x - radius, rect.right + radius],
      [a.y, b.y - a.y, rect.y - radius, rect.bottom + radius],
    ]) {
      if (Math.abs(delta) < EPSILON) {
        if (start < low - EPSILON || start > high + EPSILON) return false;
      } else {
        let first = (low - start) / delta, last = (high - start) / delta;
        if (first > last) [first, last] = [last, first];
        enter = Math.max(enter, first);
        leave = Math.min(leave, last);
        if (enter > leave + EPSILON) return false;
      }
    }
    return true;
  }

  function validPoint(point) {
    return point && Number.isFinite(point.x) && Number.isFinite(point.y);
  }

  function segmentHits(a, b, index, radius = P.Config.PLAYER_RADIUS) {
    if (!validPoint(a) || !validPoint(b)) return true;
    const padding = Math.max(0, radius);
    return index.query(Math.min(a.x, b.x) - padding, Math.min(a.y, b.y) - padding,
      Math.max(a.x, b.x) + padding, Math.max(a.y, b.y) + padding)
      .some(rect => segmentRect(a, b, rect, padding));
  }

  function pointHits(point, index, radius = P.Config.PLAYER_RADIUS) {
    return segmentHits(point, point, index, radius);
  }

  function segmentCircleEntry(a, b, center, radius) {
    if (!validPoint(a) || !validPoint(b) || !validPoint(center)) return null;
    const dx = b.x - a.x, dy = b.y - a.y;
    const ox = a.x - center.x, oy = a.y - center.y;
    const outside = ox * ox + oy * oy - radius * radius;
    if (outside <= EPSILON) return 0;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared < EPSILON) return null;
    const projection = ox * dx + oy * dy;
    const discriminant = projection * projection - lengthSquared * outside;
    if (discriminant < -EPSILON) return null;
    const t = (-projection - Math.sqrt(Math.max(0, discriminant))) / lengthSquared;
    return t >= -EPSILON && t <= 1 + EPSILON ? Math.max(0, Math.min(1, t)) : null;
  }

  P.Collision = Object.freeze({ createIndex, segmentHits, pointHits, segmentCircleEntry,
    distance: (a, b) => Math.hypot(b.x - a.x, b.y - a.y) });
})();
