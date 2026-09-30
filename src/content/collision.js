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

  function createMaskIndex(analysis) {
    const width = analysis.maskWidth, height = analysis.maskHeight;
    if (analysis.kind !== 'pixel-mask' || !Number.isInteger(width) || !Number.isInteger(height) ||
        width < 1 || height < 1 || width !== analysis.width || height !== analysis.height ||
        analysis.walkableMask?.length !== width * height) {
      throw new Error('截图地图尺寸无效，请重新生成关卡。');
    }
    return { kind: 'pixel-mask', width, height, walkableMask: analysis.walkableMask,
      obstacleMask: analysis.obstacleMask, distanceMap: analysis.distanceMap,
      componentLabels: analysis.componentLabels, analysis };
  }

  // Traverse every closed pixel square touched by the segment. Pixel boundaries
  // belong to both neighbors, including a corner crossed at exactly one instant.
  // The mask already includes brush clearance; never inflate it a second time.
  function maskSegmentHits(a, b, index) {
    const { width, height, walkableMask } = index;
    const blocked = (x, y) => x < 0 || y < 0 || x >= width || y >= height || !walkableMask[y * width + x];
    const boundary = value => Math.abs(value - Math.round(value)) < EPSILON;
    function contact(x, y) {
      const onX = boundary(x), onY = boundary(y);
      const px = onX ? Math.round(x) : Math.floor(x), py = onY ? Math.round(y) : Math.floor(y);
      return blocked(px, py) || onX && blocked(px - 1, py) || onY && blocked(px, py - 1) ||
        onX && onY && blocked(px - 1, py - 1);
    }
    if (a.x < 0 || a.y < 0 || b.x < 0 || b.y < 0 ||
        a.x >= width || b.x >= width || a.y >= height || b.y >= height ||
        contact(a.x, a.y) || contact(b.x, b.y)) return true;
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.abs(dx) < EPSILON && Math.abs(dy) < EPSILON) return false;
    const stepX = Math.sign(dx), stepY = Math.sign(dy);
    let x = boundary(a.x) ? Math.round(a.x) : Math.floor(a.x);
    let y = boundary(a.y) ? Math.round(a.y) : Math.floor(a.y);
    if (stepX < 0 && boundary(a.x)) x--;
    if (stepY < 0 && boundary(a.y)) y--;
    const verticalBoundary = Math.abs(dx) < EPSILON && boundary(a.x);
    const horizontalBoundary = Math.abs(dy) < EPSILON && boundary(a.y);
    let tX = stepX ? ((stepX > 0 ? x + 1 : x) - a.x) / dx : Infinity;
    let tY = stepY ? ((stepY > 0 ? y + 1 : y) - a.y) / dy : Infinity;
    const dtX = stepX ? 1 / Math.abs(dx) : Infinity;
    const dtY = stepY ? 1 / Math.abs(dy) : Infinity;
    // At most width + height boundary crossings for an in-viewport segment.
    for (let count = 0; count <= width + height + 2; count++) {
      if (blocked(x, y) || verticalBoundary && blocked(x - 1, y) ||
          horizontalBoundary && blocked(x, y - 1)) return true;
      const next = Math.min(tX, tY);
      if (next > 1 - EPSILON) return false; // endpoint checked above
      if (Math.abs(tX - tY) < EPSILON) {
        if (blocked(x + stepX, y) || blocked(x, y + stepY)) return true;
        x += stepX; y += stepY; tX += dtX; tY += dtY;
      } else if (tX < tY) { x += stepX; tX += dtX; }
      else { y += stepY; tY += dtY; }
    }
    return true;
  }

  function segmentHits(a, b, index, radius = P.Config.PLAYER_RADIUS) {
    if (!validPoint(a) || !validPoint(b)) return true;
    if (index?.kind === 'pixel-mask') return maskSegmentHits(a, b, index);
    const padding = Math.max(0, radius);
    return index.query(Math.min(a.x, b.x) - padding, Math.min(a.y, b.y) - padding,
      Math.max(a.x, b.x) + padding, Math.max(a.y, b.y) + padding)
      .some(rect => segmentRect(a, b, rect, padding));
  }

  function pointHits(point, index, radius = P.Config.PLAYER_RADIUS) {
    return segmentHits(point, point, index, radius);
  }

  function reachableContours(analysis, origin) {
    const source = analysis?.contours || { segments: new Float32Array(), bucketSize: 64, buckets: Object.create(null) };
    const { width, height, componentLabels: labels } = analysis || {};
    // A standalone preview without a selected puzzle can still show the map.
    // Actual levels always supply the start point and cached component labels.
    if (!origin || labels?.length !== width * height) return source;
    const labelAt = (x, y) => x >= 0 && y >= 0 && x < width && y < height &&
      analysis.walkableMask[y * width + x] ? labels[y * width + x] : 0;
    const componentId = validPoint(origin) ? labelAt(Math.floor(origin.x), Math.floor(origin.y)) : 0;
    const segments = source.segments, lines = [];
    const buckets = Object.create(null), bucketSize = source.bucketSize;
    if (componentId) for (let i = 0; i < segments.length; i += 4) {
      const x1 = segments[i], y1 = segments[i + 1], x2 = segments[i + 2], y2 = segments[i + 3];
      const x = Math.floor((x1 + x2) / 2), y = Math.floor((y1 + y2) / 2);
      // Each merged straight edge has one continuous row/column of free cells
      // on its open side, so their four-connected label is constant along it.
      const reachable = y1 === y2
        ? labelAt(x, y - 1) === componentId || labelAt(x, y) === componentId
        : labelAt(x - 1, y) === componentId || labelAt(x, y) === componentId;
      if (!reachable) continue;
      const id = lines.length / 4;
      lines.push(x1, y1, x2, y2);
      for (let by = Math.floor(Math.min(y1, y2) / bucketSize); by <= Math.floor(Math.max(y1, y2) / bucketSize); by++) {
        for (let bx = Math.floor(Math.min(x1, x2) / bucketSize); bx <= Math.floor(Math.max(x1, x2) / bucketSize); bx++) {
          (buckets[`${bx},${by}`] ||= []).push(id);
        }
      }
    }
    // Display-only selection: do not fill holes, erase small obstacles, or
    // change the collision mask that produced the verified reference route.
    return { segments: new Float32Array(lines), bucketSize, buckets, componentId };
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

  P.Collision = Object.freeze({ createIndex, createMaskIndex, segmentHits, pointHits, segmentCircleEntry, reachableContours,
    distance: (a, b) => Math.hypot(b.x - a.x, b.y - a.y) });
})();
