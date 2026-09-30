(() => {
  'use strict';
  const P = globalThis.__PAGEPATH__ ||= {};
  const SQRT_HALF = Math.SQRT1_2;
  const abort = signal => {
    if (signal?.aborted) throw new DOMException('地图生成已取消', 'AbortError');
  };
  const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));
  const deltaSquared = (data, a, b) => {
    const dl = (data[a] - data[b]) / 2.55;
    const da = data[a + 1] - data[b + 1];
    const db = data[a + 2] - data[b + 2];
    return dl * dl + da * da + db * db;
  };

  function connected(cv, mask, width, height, connectivity = 4) {
    const source = cv.matFromArray(height, width, cv.CV_8UC1, mask);
    const labels = new cv.Mat(), stats = new cv.Mat(), centroids = new cv.Mat();
    try {
      const count = cv.connectedComponentsWithStats(source, labels, stats, centroids, connectivity, cv.CV_32S);
      const result = [];
      for (let id = 1; id < count; id++) {
        const row = id * stats.cols;
        const left = stats.data32S[row + cv.CC_STAT_LEFT];
        const top = stats.data32S[row + cv.CC_STAT_TOP];
        const spanX = stats.data32S[row + cv.CC_STAT_WIDTH];
        const spanY = stats.data32S[row + cv.CC_STAT_HEIGHT];
        result.push({ id, area: stats.data32S[row + cv.CC_STAT_AREA], left, top,
          width: spanX, height: spanY, bounds: { x: left, y: top, width: spanX, height: spanY },
          cx: centroids.data64F[id * 2], cy: centroids.data64F[id * 2 + 1] });
      }
      return { labels: new Int32Array(labels.data32S), components: result, count };
    } finally {
      source.delete(); labels.delete(); stats.delete(); centroids.delete();
    }
  }

  // Sample the corners of a flat region, rather than covering its contents with
  // a rectangle. This rejects large solid circles and silhouettes as background.
  function rectangularCorners(region, labels, width) {
    const sx = Math.max(2, Math.floor(region.width * 0.12));
    const sy = Math.max(2, Math.floor(region.height * 0.12));
    let corners = 0;
    for (const right of [false, true]) for (const bottom of [false, true]) {
      const x0 = region.left + (right ? region.width - sx : 0);
      const y0 = region.top + (bottom ? region.height - sy : 0);
      let hits = 0;
      for (let y = y0; y < y0 + sy; y++) for (let x = x0; x < x0 + sx; x++) {
        if (labels[y * width + x] === region.id) hits++;
      }
      if (hits / (sx * sy) >= 0.42) corners++;
    }
    return corners >= 3;
  }

  // Exact cell edges of the very same mask used for movement. Straight runs are
  // merged without changing their geometry; no contour approximation is used.
  function collisionContours(mask, width, height, bucketSize) {
    const lines = [];
    for (let y = 0; y <= height; y++) {
      let start = -1, polarity = 0;
      for (let x = 0; x <= width; x++) {
        const above = y > 0 && x < width ? mask[(y - 1) * width + x] : 0;
        const below = y < height && x < width ? mask[y * width + x] : 0;
        const next = below - above;
        if (start >= 0 && next !== polarity) { lines.push(start, y, x, y); start = -1; }
        if (next && start < 0) { start = x; polarity = next; }
      }
    }
    for (let x = 0; x <= width; x++) {
      let start = -1, polarity = 0;
      for (let y = 0; y <= height; y++) {
        const left = x > 0 && y < height ? mask[y * width + x - 1] : 0;
        const right = x < width && y < height ? mask[y * width + x] : 0;
        const next = right - left;
        if (start >= 0 && next !== polarity) { lines.push(x, start, x, y); start = -1; }
        if (next && start < 0) { start = y; polarity = next; }
      }
    }
    const buckets = Object.create(null);
    for (let i = 0; i < lines.length; i += 4) {
      const x0 = Math.floor(Math.min(lines[i], lines[i + 2]) / bucketSize);
      const x1 = Math.floor(Math.max(lines[i], lines[i + 2]) / bucketSize);
      const y0 = Math.floor(Math.min(lines[i + 1], lines[i + 3]) / bucketSize);
      const y1 = Math.floor(Math.max(lines[i + 1], lines[i + 3]) / bucketSize);
      for (let by = y0; by <= y1; by++) for (let bx = x0; bx <= x1; bx++) {
        (buckets[`${bx},${by}`] ||= []).push(i / 4);
      }
    }
    return { segments: new Float32Array(lines), bucketSize, buckets };
  }

  async function analyze(imageData, { width = imageData?.width, height = imageData?.height, signal, domHints = [] } = {}) {
    const settings = P.Config?.PIXEL_MAP || {};
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 8 || height < 8 ||
        imageData?.width !== width || imageData?.height !== height || imageData?.data?.length !== width * height * 4) {
      throw new Error('截图尺寸无效，无法生成地图');
    }
    const length = width * height;
    if (length > (settings.MAX_PIXELS ?? 8500000)) throw new Error('当前视口过大，请缩小浏览器窗口后重新生成地图');
    abort(signal);
    const cv = await P.OpenCV.ready({ signal });
    abort(signal);
    const started = Date.now();
    const rgba = cv.matFromArray(height, width, cv.CV_8UC4, imageData.data);
    const rgb = new cv.Mat(), lab = new cv.Mat();
    let colors;
    try {
      cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
      cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
      // Own this array: later WASM allocations can grow and detach Mat views.
      colors = new Uint8Array(lab.data);
    } finally { rgba.delete(); rgb.delete(); lab.delete(); }

    const flat = new Uint8Array(length);
    const flatLimit = (settings.BACKGROUND_FLAT_DELTA ?? 3) ** 2;
    const samples = [[-2, 0], [2, 0], [0, -2], [0, 2], [-1, -1], [1, 1]];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const at = y * width + x, p = at * 3;
      let smooth = true;
      for (const [dx, dy] of samples) {
        const xx = Math.max(0, Math.min(width - 1, x + dx));
        const yy = Math.max(0, Math.min(height - 1, y + dy));
        if (deltaSquared(colors, p, (yy * width + xx) * 3) > flatLimit) { smooth = false; break; }
      }
      flat[at] = smooth ? 255 : 0;
    }
    const regions = connected(cv, flat, width, height);
    const sums = new Float64Array(regions.count * 3);
    for (let i = 0; i < length; i++) {
      const id = regions.labels[i];
      if (!id) continue;
      sums[id * 3] += colors[i * 3]; sums[id * 3 + 1] += colors[i * 3 + 1]; sums[id * 3 + 2] += colors[i * 3 + 2];
    }
    const backgrounds = new Uint8Array(regions.count);
    let backgroundRegions = 0;
    const minimumArea = Math.max(512, Math.min(1800, length * 0.001));
    for (const region of regions.components) {
      const id = region.id, p = id * 3;
      sums[p] /= region.area; sums[p + 1] /= region.area; sums[p + 2] /= region.area;
      const chroma = Math.hypot(sums[p + 1] - 128, sums[p + 2] - 128);
      const touchesEdge = region.left === 0 || region.top === 0 || region.left + region.width === width || region.top + region.height === height;
      const broadSurface = region.area >= length * 0.15 && touchesEdge;
      const suitableShape = touchesEdge || (region.area / (region.width * region.height) >= 0.45 && rectangularCorners(region, regions.labels, width));
      if (region.area >= minimumArea && Math.min(region.width, region.height) >= 40 &&
          suitableShape && (chroma <= 28 || broadSurface)) {
        backgrounds[id] = 1; backgroundRegions++;
      }
    }
    await yieldTask(); abort(signal);

    let obstacleMask = new Uint8Array(length);
    const differences = new Float32Array(length);
    const foregroundDelta = settings.FOREGROUND_DELTA ?? 9;
    const backgroundUnavailable = backgroundRegions === 0;
    if (backgroundUnavailable) {
      // A fully textured screenshot is still a valid map. With no reliable
      // background seed, conservatively retain every pixel as foreground;
      // only the maze's explicit carved floor may create passages later.
      // Keep the shared cleanup / EDT / components / contour pipeline below.
      obstacleMask.fill(1);
      differences.fill(Math.max(foregroundDelta, settings.DECORATIVE_LINE_MAX_DELTA ?? 22) + 1);
    } else {
      // Multi-source propagation estimates the nearest local background. A dark
      // card supplies its own background; it does not inherit the white page's.
      const owners = regions.labels;
      const queue = new Int32Array(length);
      let head = 0, tail = 0;
      for (let i = 0; i < length; i++) {
        if (backgrounds[owners[i]]) { owners[i] = i + 1; queue[tail++] = i; }
        else owners[i] = 0;
      }
      while (head < tail) {
        const i = queue[head++], x = i % width, owner = owners[i];
        if (x && !owners[i - 1]) { owners[i - 1] = owner; queue[tail++] = i - 1; }
        if (x + 1 < width && !owners[i + 1]) { owners[i + 1] = owner; queue[tail++] = i + 1; }
        if (i >= width && !owners[i - width]) { owners[i - width] = owner; queue[tail++] = i - width; }
        if (i + width < length && !owners[i + width]) { owners[i + width] = owner; queue[tail++] = i + width; }
      }
      const backgroundCorners = [[-2, -2], [2, -2], [-2, 2], [2, 2]];
      for (let i = 0; i < length; i++) {
        const p = i * 3, bg = (owners[i] - 1) * 3;
        const dl = (colors[p] - colors[bg]) / 2.55;
        const da = colors[p + 1] - colors[bg + 1], db = colors[p + 2] - colors[bg + 2];
        differences[i] = Math.sqrt(dl * dl + da * da + db * db);
        obstacleMask[i] = differences[i] > foregroundDelta ? 1 : 0;
        if (obstacleMask[i]) {
          // At a card corner the exterior can be spatially closer than the
          // interior seed. Accept a matching nearby *actual* background seed;
          // propagated pixels and rejected solid subjects cannot supply one.
          const x = i % width, y = Math.floor(i / width);
          for (const [dx, dy] of backgroundCorners) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || xx >= width || yy < 0 || yy >= height) continue;
            const near = yy * width + xx;
            if (owners[near] === near + 1 && deltaSquared(colors, p, near * 3) <= foregroundDelta ** 2) {
              obstacleMask[i] = 0; break;
            }
          }
        }
      }
    }

    // Only isolated, long, thin, low-contrast strokes qualify as decoration.
    // Attached text, thick rules and high-contrast barriers stay obstacles.
    const foreground = connected(cv, obstacleMask, width, height);
    const maximumDelta = new Float32Array(foreground.count);
    for (let i = 0; i < length; i++) {
      const id = foreground.labels[i];
      if (id && differences[i] > maximumDelta[id]) maximumDelta[id] = differences[i];
    }
    const ignored = new Uint8Array(foreground.count);
    let decorativeLines = 0;
    for (const component of foreground.components) {
      const thin = Math.min(component.width, component.height), long = Math.max(component.width, component.height);
      if (thin <= 3 && long >= 48 && long / thin >= 20 && component.area / (thin * long) >= 0.55 &&
          maximumDelta[component.id] <= (settings.DECORATIVE_LINE_MAX_DELTA ?? 22)) {
        ignored[component.id] = 1; decorativeLines++;
      }
    }
    for (let i = 0; i < length; i++) if (ignored[foreground.labels[i]]) obstacleMask[i] = 0;
    await yieldTask(); abort(signal);

    const source = cv.matFromArray(height, width, cv.CV_8UC1, obstacleMask);
    const cleaned = new cv.Mat();
    const kernel = cv.getStructuringElement(cv.MORPH_CROSS, new cv.Size(3, 3));
    try {
      // Close one-pixel anti-aliasing holes, keeping thin foreground strokes.
      cv.morphologyEx(source, cleaned, cv.MORPH_CLOSE, kernel);
      obstacleMask = new Uint8Array(cleaned.data);
    } finally { source.delete(); cleaned.delete(); kernel.delete(); }
    // DOM contributes only small, screenshot-validated shapes. Merge before
    // clearance, components and contours so every consumer uses one map.
    const compactStats = P.CompactMask?.apply(obstacleMask, width, height, domHints) ||
      { compactDomCandidates: 0, compactDomMerged: 0, compactDomAddedPixels: 0 };
    const free = new Uint8Array(length);
    let obstaclePixels = 0;
    for (let i = 0; i < length; i++) { obstacleMask[i] = obstacleMask[i] ? 1 : 0; free[i] = obstacleMask[i] ? 0 : 255; obstaclePixels += obstacleMask[i]; }
    const freeMat = cv.matFromArray(height, width, cv.CV_8UC1, free), distance = new cv.Mat();
    let distanceMap;
    try {
      cv.distanceTransform(freeMat, distance, cv.DIST_L2, cv.DIST_MASK_PRECISE);
      distanceMap = new Float32Array(distance.data32F);
    } finally { freeMat.delete(); distance.delete(); }
    const clearance = (P.Config?.PLAYER_RADIUS ?? 1) + (settings.SAFETY_MARGIN ?? P.Config?.OBSTACLE_PADDING ?? 1);
    const walkableThreshold = clearance + SQRT_HALF;
    const walkableMask = new Uint8Array(length);
    let walkablePixels = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x;
      distanceMap[i] = Math.min(distanceMap[i], x + 0.5, y + 0.5, width - x - 0.5, height - y - 0.5);
      walkableMask[i] = distanceMap[i] > walkableThreshold ? 1 : 0;
      walkablePixels += walkableMask[i];
    }
    const playable = connected(cv, walkableMask, width, height, 4);
    playable.components.sort((a, b) => b.area - a.area);
    await yieldTask(); abort(signal);
    const contours = collisionContours(walkableMask, width, height, settings.CONTOUR_BUCKET_SIZE ?? 64);
    return { kind: 'pixel-mask', width, height, maskWidth: width, maskHeight: height,
      obstacleMask, walkableMask, distanceMap, componentLabels: playable.labels,
      components: playable.components, contours,
      stats: { backgroundRegions, backgroundUnavailable, decorativeLines, obstaclePixels, walkablePixels, ...compactStats,
        obstacleComponentCount: foreground.components.length - decorativeLines,
        obstacleRatio: obstaclePixels / length, walkableRatio: walkablePixels / length,
        componentCount: playable.components.length, clearance, walkableThreshold,
        analysisMs: Date.now() - started } };
  }

  P.ImageMapAnalyzer = Object.freeze({ analyze });
})();
