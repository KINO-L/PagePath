(() => {
  'use strict';
  const P = globalThis.__PAGEPATH__ ||= {};

  function limits(width, height) {
    const config = P.Config?.HYBRID_DOM || {};
    return {
      maxWidth: config.MAX_WIDTH ?? 240,
      maxHeight: config.MAX_HEIGHT ?? 96,
      maxArea: Math.min(config.MAX_AREA ?? 14000, width * height * (config.MAX_VIEWPORT_RATIO ?? 0.018)),
      minSize: config.MIN_SIZE ?? 4,
      maxHints: config.MAX_HINTS ?? 512
    };
  }

  function validViewport(width, height) {
    return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
      width * height <= (P.Config?.PIXEL_MAP?.MAX_PIXELS ?? 8500000);
  }

  // The worker accepts geometry only. Large or clipped elements always retain
  // their screenshot contours, even if a caller supplies an overbroad hint.
  function validate(hint, width, height, bounds) {
    if (!hint || (hint.kind !== 'box' && hint.kind !== 'content')) return null;
    const { x, y, width: w, height: h, radius = 0 } = hint;
    if (![x, y, w, h, radius].every(value => typeof value === 'number' && Number.isFinite(value)) ||
        x < 0 || y < 0 || w < bounds.minSize || h < bounds.minSize ||
        w > bounds.maxWidth || h > bounds.maxHeight || w * h > bounds.maxArea ||
        x + w > width || y + h > height || radius < 0 || radius > Math.min(w, h) / 2) return null;
    return { x, y, width: w, height: h, kind: hint.kind, radius };
  }

  function validated(hints, width, height) {
    if (!validViewport(width, height) || !Array.isArray(hints)) return [];
    const bounds = limits(width, height), result = [], seen = new Set();
    for (const input of hints.slice(0, bounds.maxHints)) {
      const hint = validate(input, width, height, bounds);
      if (!hint) continue;
      const key = [hint.x, hint.y, hint.width, hint.height, hint.kind, hint.radius].join(',');
      if (!seen.has(key)) { result.push(hint); seen.add(key); }
    }
    return result;
  }

  // Moving controls cannot safely explain the intervening screenshot. Tiny
  // subpixel rounding differences are allowed; geometry is otherwise stable.
  function stable(before, after, { width, height } = {}) {
    const first = validated(before, width, height), second = validated(after, width, height);
    const used = new Set(), result = [];
    for (const hint of first) {
      const at = second.findIndex((other, index) => !used.has(index) && hint.kind === other.kind &&
        ['x', 'y', 'width', 'height', 'radius'].every(key => Math.abs(hint[key] - other[key]) <= 0.5));
      if (at >= 0) { used.add(at); result.push(hint); }
    }
    return result;
  }

  function rectangle(hint) {
    return {
      left: Math.ceil(hint.x - 0.5), top: Math.ceil(hint.y - 0.5),
      right: Math.ceil(hint.x + hint.width - 0.5), bottom: Math.ceil(hint.y + hint.height - 0.5)
    };
  }

  function insideRounded(hint, x, y) {
    const r = hint.radius;
    if (!r) return true;
    const dx = Math.max(hint.x + r - (x + 0.5), 0, (x + 0.5) - (hint.x + hint.width - r));
    const dy = Math.max(hint.y + r - (y + 0.5), 0, (y + 0.5) - (hint.y + hint.height - r));
    return dx * dx + dy * dy <= r * r;
  }

  function longestGap(values, start, end) {
    let longest = 0, run = 0;
    for (let i = start; i < end; i++) {
      run = values[i] ? 0 : run + 1;
      longest = Math.max(longest, run);
    }
    return longest;
  }

  function evidence(source, width, hint, box) {
    let left = box.right, top = box.bottom, right = box.left, bottom = box.top, count = 0;
    const columns = new Uint8Array(box.right - box.left), rows = new Uint8Array(box.bottom - box.top);
    for (let y = box.top; y < box.bottom; y++) for (let x = box.left; x < box.right; x++) {
      if (!source[y * width + x] || (hint.kind === 'box' && !insideRounded(hint, x, y))) continue;
      count++; columns[x - box.left] = 1; rows[y - box.top] = 1;
      left = Math.min(left, x); right = Math.max(right, x + 1);
      top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
    }
    const w = right - left, h = bottom - top;
    // A stray pixel or a divider is insufficient evidence for a solid object.
    if (count < 6 || w < 3 || h < 3) return null;
    let occupiedColumns = 0, occupiedRows = 0;
    for (const value of columns) occupiedColumns += value;
    for (const value of rows) occupiedRows += value;
    // Two visible remnants around an occluder do not justify bridging the
    // blank middle. Ordinary letter spacing remains within this small gap.
    if (longestGap(columns, left - box.left, right - box.left) > Math.max(12, w * 0.35) ||
        longestGap(rows, top - box.top, bottom - box.top) > Math.max(12, h * 0.35)) return null;
    // Hit testing cannot detect a pointer-events:none cover. A narrow visible
    // strip or a central label therefore cannot justify the whole DOM box.
    // Full boxes need image evidence spanning most of both dimensions.
    if (hint.kind === 'box' && count / (hint.width * hint.height) >= 0.012 &&
        w >= hint.width * 0.65 && h >= hint.height * 0.65 &&
        occupiedColumns >= hint.width * 0.65 && occupiedRows >= hint.height * 0.65) {
      return { bounds: box, rounded: true };
    }
    if (count / (w * h) < 0.06 || occupiedColumns / w < 0.35 || occupiedRows / h < 0.35) return null;
    return { bounds: { left, top, right, bottom }, rounded: false };
  }

  function apply(obstacleMask, width, height, domHints = []) {
    const stats = { compactDomCandidates: 0, compactDomMerged: 0, compactDomAddedPixels: 0 };
    if (!validViewport(width, height) || !obstacleMask || obstacleMask.length !== width * height) return stats;
    const hints = validated(domHints, width, height);
    stats.compactDomCandidates = hints.length;
    if (!hints.length) return stats;
    // A previously filled hint must never manufacture evidence for its neighbor.
    const screenshot = new Uint8Array(obstacleMask);
    for (const hint of hints) {
      const box = rectangle(hint), ink = evidence(screenshot, width, hint, box);
      if (!ink) continue;
      const target = ink.bounds;
      stats.compactDomMerged++;
      for (let y = target.top; y < target.bottom; y++) for (let x = target.left; x < target.right; x++) {
        if (ink.rounded && !insideRounded(hint, x, y)) continue;
        const at = y * width + x;
        if (!obstacleMask[at]) { obstacleMask[at] = 1; stats.compactDomAddedPixels++; }
      }
    }
    return stats;
  }

  P.CompactMask = Object.freeze({ stable, apply });
})();
