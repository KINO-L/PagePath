(() => {
  'use strict';

  const P = globalThis.__PAGEPATH__ ||= {};
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Kept here so a programmatically injected content script can style its shadow
  // root synchronously, without fetches, host permissions, or exposed resources.
  P.OVERLAY_CSS = `
    :host { color-scheme: light; }
    *, *::before, *::after { box-sizing: border-box; }
    .snapshot-layer { position:absolute;inset:0;display:block;width:100%;height:100%;max-width:none;max-height:none;margin:0;padding:0;border:0;object-fit:fill;pointer-events:none;user-select:none; }
    .surface { position:absolute;inset:0;display:block;width:100%;height:100%;overflow:hidden;pointer-events:auto;touch-action:none;cursor:default;user-select:none;-webkit-user-select:none; }
    .surface[data-state="DRAWING"] { cursor:none; }
    .surface[data-generation-failed="true"] { cursor:default; }
    .visual-layer { pointer-events:none; }
    .obstacle-warning,.obstacle-map,.obstacle-flash { fill:none;stroke-linejoin:round;vector-effect:non-scaling-stroke; }
    .hint-route,.hint-outline,.path,.path-outline { fill:none;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke; }
    .hint-route { stroke:#ad654a;stroke-width:1.4;stroke-dasharray:4 7;opacity:.78; }
    .hint-outline { stroke:rgba(255,253,247,.8);stroke-width:4; }
    .hint-arrow { fill:none;stroke:#a86046;stroke-width:1.3;stroke-linecap:round;stroke-linejoin:round; }
    .hint-step { fill:#99543e;font:600 9px ui-monospace,Consolas,monospace;paint-order:stroke;stroke:rgba(255,253,247,.96);stroke-width:3;stroke-linejoin:round; }
    .path,.path-outline { display:none; }
    .ink-stroke { color:#595247; }
    .ink-stroke-piece { fill:currentColor;stroke:rgba(255,253,247,.45);stroke-width:.35;stroke-linejoin:round; }
    .ink-bristle { fill:none;stroke:#faf6ea;stroke-width:.35;stroke-linecap:round;opacity:.5; }
    .surface[data-state="FAILED"] .ink-stroke { color:#a66f58; }
    .node { color:#74766a; }
    .node .ink-halo { fill:#faf8f1;opacity:.9; }
    .node .ink-drop { fill:currentColor;stroke:#faf8f1;stroke-width:1; }
    .node .ink-grain { fill:#838779;opacity:.3; }
    .node .stone-body { fill:#76796d;stroke:#fffdf6;stroke-width:1.3; }
    .node .stone-well { fill:#555b50;stroke:#989c8f;stroke-width:.7; }
    .node .stone-shine { fill:none;stroke:#c8cbb9;stroke-width:.9;stroke-linecap:round;opacity:.75; }
    .node .paper-body { fill:#fffaf0;stroke:#656458;stroke-width:1;stroke-linejoin:round; }
    .node .paper-fold { fill:#e6dfcd;stroke:#8e8875;stroke-width:.65;stroke-linejoin:round; }
    .node .paper-line { fill:none;stroke:#c5beaa;stroke-width:.8;stroke-linecap:round; }
    .node .collected-mark { opacity:0;fill:#b1644c; }
    .node[data-collected="true"] .collected-mark { opacity:1; }
    .node[data-collected="true"] .ink-drop { fill:#f5eee1;stroke:#a87358;stroke-width:1.15; }
    .node[data-collected="true"] .ink-grain { opacity:0; }
    .node[data-collected="true"] .stone-well { fill:#8b8979; }
    .node[data-collected="true"] .paper-line { stroke:#bfa786; }
    .brush-cursor { position:absolute;left:0;top:0;width:24px;height:36px;z-index:1;overflow:visible;pointer-events:none;display:none;filter:drop-shadow(.5px 1px .6px rgba(29,29,22,.15)); }
    .cursor-ink { position:absolute;left:0;top:0;z-index:1;display:none;pointer-events:none;color:#655f52;background:rgba(250,247,238,.88);border-radius:3px;padding:0 2px;font:10px/14px ui-monospace,Consolas,monospace;font-variant-numeric:tabular-nums;white-space:nowrap; }
    .cursor-ink[data-low="true"] { color:#a35d44; }
    .cursor-ink[data-unlimited="true"] { font-size:13px; }
    .brush-cursor[data-visible="true"],.cursor-ink[data-visible="true"] { display:block; }
    .toolbar { position:absolute;top:12px;left:50%;transform:translateX(-50%);width:min(372px,calc(100% - 20px));height:48px;z-index:2;padding:8px 7px;overflow:hidden;pointer-events:auto;border:1px solid rgba(63,59,46,.17);border-radius:17px;background:rgba(249,246,236,.97);color:#4d4b40;box-shadow:0 3px 14px rgba(43,39,25,.09),inset 0 1px 0 rgba(255,255,250,.9);font:11px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased;user-select:none;touch-action:none;cursor:grab; }
    .toolbar[data-dragging="true"],.toolbar[data-dragging="true"] .drag-handle { cursor:grabbing; }
    .toolbar-main { display:flex;align-items:center;gap:4px;height:30px; }
    /* Keep the saved drag position and node reservation fixed while the visual
       controls fold away. The entire old footprint lets the brush pass through. */
    .toolbar[data-state="DRAWING"] { background:transparent;border-color:transparent;box-shadow:none;pointer-events:none;cursor:none; }
    .toolbar[data-state="DRAWING"] .toolbar-main { visibility:hidden; }
    .toolbar[data-state="DRAWING"]::after { content:"";position:absolute;left:calc(50% - 14px);top:calc(50% - 3px);width:28px;height:6px;border-radius:3px;background:rgba(155,144,119,.55);pointer-events:none; }
    .status { width:20px;height:28px;flex:none;display:grid;place-items:center;color:#777264;outline-offset:0; }
    .status-icon { width:16px;height:16px; }
    .toolbar[data-state="SUCCESS"] .status { color:#91754d; }
    .toolbar[data-state="FAILED"] .status,.toolbar[data-state="PAUSED"] .status { color:#ad654b; }
    .metrics { display:flex;align-items:center;flex:1;min-width:43px; }
    .metric { display:flex;align-items:center;gap:3px;white-space:nowrap; }
    .metric-symbol { display:block;width:8px;height:11px;flex:none; }
    .metric-value { font-size:10px;font-variant-numeric:tabular-nums;letter-spacing:-.3px; }
    .node-count { width:34px; }
    .maze-goal-icon { width:35px;height:17px; }
    .actions { display:flex;align-items:center;gap:1px;flex:none; }
    button { appearance:none;position:relative;display:grid;place-items:center;flex:none;margin:0;padding:0;width:28px;height:30px;border:0;border-radius:8px;background:transparent;color:#565345;cursor:pointer;touch-action:manipulation; }
    .control-icon { display:block;width:16px;height:16px;pointer-events:none; }
    button.drag-handle { width:18px;color:#aaa28f;cursor:grab; }
    .drag-handle .control-icon { width:12px;height:16px; }
    button:hover { background:#eee8da;color:#302f28; }
    button:active { background:#e7dfce; }
    button:focus-visible { outline:1.5px solid #a47556;outline-offset:-2px; }
    button:disabled { opacity:.3;cursor:default;background:transparent; }
    .mode-control { display:flex;align-items:center;gap:1px;flex:none;height:30px;padding:2px;border-radius:9px;background:#eee8dc; }
    button.mode-button { width:26px;height:26px;border-radius:7px;color:#999080; }
    .maze-mode-slot { display:block;flex:none;height:26px;border-radius:7px; }
    .maze-mode-slot[data-unavailable="true"] { cursor:not-allowed; }
    .maze-mode-slot:focus-visible { outline:1.5px solid #a47556;outline-offset:1px; }
    .maze-mode-slot[data-unavailable="true"] .mode-button { pointer-events:none;opacity:1;color:#665b4b; }
    .maze-locked-mark { display:none; }
    .maze-mode-slot[data-unavailable="true"] .maze-locked-mark { display:inline; }
    .maze-mode-slot[data-unavailable="true"] .maze-unlocked-mark { display:none; }
    .maze-tooltip { position:absolute;z-index:3;width:190px;max-width:calc(100% - 12px);padding:8px 10px;border:1px solid rgba(63,59,46,.17);border-radius:9px;background:#fffcf3;box-shadow:0 3px 12px rgba(43,39,25,.12);color:#565345;font:11px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;pointer-events:none; }
    .maze-tooltip-guide { margin:0 0 7px;color:#766d5e; }
    .maze-criterion { display:flex;align-items:center;justify-content:space-between;gap:12px; }
    .maze-criterion + .maze-criterion { margin-top:4px; }
    .criterion-mark { width:14px;height:14px;flex:none;color:#b3453f; }
    .maze-criterion[data-passed="true"] .criterion-mark { color:#39733f; }
    .mode-button[aria-pressed="true"] { color:#965d40;background:#fffcf3;box-shadow:0 1px 3px rgba(65,47,26,.13),inset 0 0 0 1px rgba(154,101,75,.17); }
    .mode-button[aria-pressed="true"] .control-icon { stroke-width:1.8; }
    .hint[aria-pressed="true"] { background:#eee0ce;color:#995e40; }
    .hint[aria-pressed="true"] .hint-slash { display:block; }
    .hint-slash { display:none; }
    .new-slot { position:relative;flex:none;width:28px;height:30px; }
    .new-slot button { position:absolute;inset:0; }
    .exit { color:#8c8272; }
    .exit:hover { color:#ac5f46;background:#f0e2d7; }
    .sr-only,.message,.state-label { position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;clip-path:inset(50%)!important;white-space:nowrap!important;border:0!important; }
    .generation-error { position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(400px,calc(100% - 32px));padding:14px 16px;border:1px solid rgba(151,84,57,.25);border-radius:12px;background:rgba(255,250,240,.97);color:#87573f;box-shadow:0 3px 16px rgba(43,39,25,.1);font:12px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;overflow-wrap:anywhere;pointer-events:none; }
    [hidden] { display:none!important; }
    @media(max-width:400px) { .toolbar-main { gap:3px; } button,.new-slot,button.mode-button { width:24px; } button.drag-handle { width:14px; } .status { width:16px; } .metrics { min-width:41px; } .node-count { width:30px;font-size:9.5px; } }
    @media(max-width:360px) { .toolbar-main { gap:2px; } button,.new-slot,button.mode-button { width:22px; } button.drag-handle { width:12px; } .drag-handle .control-icon { width:10px; } .status,.status-icon { width:14px; } }
    @media(prefers-reduced-motion:reduce) { * { animation:none!important; } }
  `;

  const element = (name, attributes = {}) => {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
  };
  const pointString = points => points.map(point => `${Number(point.x).toFixed(1)},${Number(point.y).toFixed(1)}`).join(' ');
  const rectangle = rect => ({
    x: rect.x ?? rect.left ?? 0,
    y: rect.y ?? rect.top ?? 0,
    width: rect.width ?? ((rect.right ?? 0) - (rect.left ?? rect.x ?? 0)),
    height: rect.height ?? ((rect.bottom ?? 0) - (rect.top ?? rect.y ?? 0)),
  });
  const iconMarkup = content => `<svg class="control-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${content}</svg>`;
  const mazeCriteria = availability => {
    const requirements = { ...P.Config.MAZE_REQUIREMENTS, ...availability.requirements };
    const densityKnown = Number.isFinite(availability.obstacleRatio) && availability.obstacleRatio >= 0 && availability.obstacleRatio <= 1;
    const distributionKnown = Number.isInteger(availability.occupiedRegions) && availability.occupiedRegions >= 0 && availability.occupiedRegions <= 48;
    return [
      { id: 'complexity', label: '复杂度', known: densityKnown,
        passed: densityKnown && availability.obstacleRatio >= requirements.minObstacleRatio },
      { id: 'distribution', label: '分散度', known: distributionKnown,
        passed: distributionKnown && availability.occupiedRegions >= requirements.minOccupiedRegions },
    ];
  };

  // Split only the final reachable collision edges. A merged straight edge can
  // touch old page content for part of its length and added wall clearance for
  // the rest, so classify unit edges before merging equal runs again.
  const splitMazeContours = (contour, map, source) => {
    const bucketSize = contour.bucketSize || 64;
    const make = () => ({ segments: [], bucketSize, buckets: Object.create(null), componentId: contour.componentId });
    const original = make(), added = make();
    if (source?.width !== map.width || source?.height !== map.height || source.walkableMask?.length !== map.width * map.height) {
      return { original: { ...original, segments: new Float32Array() }, added: contour };
    }
    const newlyBlocked = (x, y) => x >= 0 && y >= 0 && x < map.width && y < map.height &&
      Boolean(source.walkableMask[y * map.width + x] && !map.walkableMask[y * map.width + x]);
    const append = (target, x1, y1, x2, y2) => {
      const id = target.segments.length / 4;
      target.segments.push(x1, y1, x2, y2);
      for (let by = Math.floor(y1 / bucketSize); by <= Math.floor(y2 / bucketSize); by++) {
        for (let bx = Math.floor(x1 / bucketSize); bx <= Math.floor(x2 / bucketSize); bx++) {
          (target.buckets[`${bx},${by}`] ||= []).push(id);
        }
      }
    };
    const edges = contour.segments;
    for (let i = 0; i < edges.length; i += 4) {
      const horizontal = edges[i + 1] === edges[i + 3];
      const fixed = horizontal ? edges[i + 1] : edges[i];
      const low = Math.min(edges[i + (horizontal ? 0 : 1)], edges[i + (horizontal ? 2 : 3)]);
      const high = Math.max(edges[i + (horizontal ? 0 : 1)], edges[i + (horizontal ? 2 : 3)]);
      const isAdded = at => horizontal ? newlyBlocked(at, fixed - 1) || newlyBlocked(at, fixed)
        : newlyBlocked(fixed - 1, at) || newlyBlocked(fixed, at);
      let run = low, addedRun = isAdded(low);
      const flush = end => append(addedRun ? added : original,
        horizontal ? run : fixed, horizontal ? fixed : run, horizontal ? end : fixed, horizontal ? fixed : end);
      for (let at = low + 1; at < high; at++) {
        const next = isAdded(at);
        if (next !== addedRun) { flush(at); run = at; addedRun = next; }
      }
      if (low < high) flush(high);
    }
    original.segments = new Float32Array(original.segments);
    added.segments = new Float32Array(added.segments);
    return { original, added };
  };
  const icons = {
    hint: '<path d="M2 12C7 4 17 4 22 12C17 20 7 20 2 12Z"/><circle cx="12" cy="12" r="2.7"/><path class="hint-slash" d="M4 4L20 20"/>',
    retry: '<path d="M5 9a7.4 7.4 0 1 1-.4 7M5 4v5h5"/>',
    newPuzzle: '<rect x="4" y="4" width="16" height="16" rx="3" transform="rotate(-7 12 12)"/><circle cx="8" cy="8" r=".8" fill="currentColor"/><circle cx="16" cy="8" r=".8" fill="currentColor"/><circle cx="12" cy="12" r=".8" fill="currentColor"/><circle cx="8" cy="16" r=".8" fill="currentColor"/><circle cx="16" cy="16" r=".8" fill="currentColor"/>',
    regenerate: '<path d="M5 8a8 8 0 0 1 13-2l2 2M20 3v5h-5M19 16a8 8 0 0 1-13 2l-2-2M4 21v-5h5"/>',
    exit: '<path d="M6 6L18 18M18 6L6 18"/>',
    debug: '<path d="M4 8h16M4 16h16M8 4v16M16 4v16"/>',
  };

  // Keep only the newest arc-length portion. Clipping inside the oldest segment
  // also bounds the visible tail when one fast pointer move crosses the screen.
  P.Trail = Object.freeze({
    clip(points, maxLength) {
      if (!Array.isArray(points) || !points.length || !Number.isFinite(maxLength) || maxLength <= 0) return [];
      const tail = [points[points.length - 1]];
      let remaining = maxLength;
      for (let index = points.length - 2; index >= 0; index--) {
        const start = points[index];
        const end = points[index + 1];
        const length = Math.hypot(end.x - start.x, end.y - start.y);
        if (length === 0) continue;
        if (length > remaining) {
          const ratio = remaining / length;
          tail.push({ x: end.x + (start.x - end.x) * ratio, y: end.y + (start.y - end.y) * ratio });
          break;
        }
        tail.push(start);
        remaining -= length;
        if (remaining <= 0) break;
      }
      return tail.reverse();
    },
  });

  P.Overlay = class Overlay {
    constructor({ onRetry, onNewPuzzle, onExit, onRegenerate, onDebug, onModeChange, onHint, onToolbarMove } = {}) {
      this.mode = P.Config?.DEFAULT_MODE || 'normal';
      this.mazeAvailability = { available: false, reason: '正在检查页面是否适合生成迷宫' };
      this.unlimitedInk = false;
      this.generationFailed = false;
      this.inkPercentage = 100;
      this.host = document.createElement('div');
      this.host.id = '__pagepath_overlay__';
      this.host.setAttribute('data-pagepath-root', '');
      this.host.setAttribute('data-pagepath-overlay', 'true');
      // Inline !important prevents a site's div/reset selectors from moving or
      // concealing the host. Descendants are isolated from site CSS by shadow DOM.
      this.host.style.cssText = 'all:initial !important;position:fixed !important;inset:0 !important;width:100vw !important;height:100vh !important;display:block !important;margin:0 !important;padding:0 !important;border:0 !important;z-index:2147483647 !important;pointer-events:none !important;overflow:hidden !important;isolation:isolate !important;contain:layout style size !important;';
      this.shadowRoot = this.host.attachShadow({ mode: 'open' });
      this.root = this.shadowRoot;
      const style = document.createElement('style');
      style.textContent = P.OVERLAY_CSS;
      this.shadowRoot.append(style);

      this.surface = element('svg', { class: 'surface', xmlns: SVG_NS, 'aria-label': 'PagePath 一笔画地图', role: 'img' });
      this.svg = this.surface;
      this.debugLayer = element('g', { class: 'visual-layer', 'aria-hidden': 'true' });
      this.mazeWallLayer = element('g', { class: 'visual-layer maze-walls', 'aria-hidden': 'true' });
      this.mazeFloorLayer = element('g', { class: 'visual-layer maze-openings', 'aria-hidden': 'true' });
      const warningDefs = element('defs');
      this.warningGradient = element('radialGradient', { id: 'pagepath-warning', gradientUnits: 'userSpaceOnUse' });
      this.warningGradient.append(element('stop', { offset: '0%', 'stop-color': '#dc3029', 'stop-opacity': 1 }),
        element('stop', { offset: '65%', 'stop-color': '#dc3029', 'stop-opacity': .95 }),
        element('stop', { offset: '100%', 'stop-color': '#dc3029', 'stop-opacity': 0 }));
      this.obstacleShape = element('path', { id: 'pagepath-obstacles' });
      warningDefs.append(this.warningGradient, this.obstacleShape);
      this.allObstacles = element('use', { class: 'obstacle-map visual-layer', href: '#pagepath-obstacles',
        stroke: '#d72f29', 'stroke-width': 1.5, opacity: .8, visibility: 'hidden', 'aria-hidden': 'true' });
      this.obstacleFlash = element('use', { class: 'obstacle-flash visual-layer', href: '#pagepath-obstacles',
        stroke: '#e33128', 'stroke-width': 2, opacity: 0, 'aria-hidden': 'true' });
      this.flashAnimation = null;
      this.routeHintVisible = false;
      this.obstacleWarning = element('path', { class: 'obstacle-warning visual-layer',
        fill: 'none', stroke: 'url(#pagepath-warning)', 'stroke-width': 1.8, 'aria-hidden': 'true' });
      this.hintLayer = element('g', { class: 'visual-layer hint-layer', 'aria-hidden': 'true' });
      this.pathLayer = element('g', { class: 'visual-layer', 'aria-hidden': 'true' });
      this.pathOutline = element('polyline', { class: 'path-outline' });
      this.path = element('polyline', { class: 'path' });
      this.inkStroke = element('g', { class: 'ink-stroke' });
      this.pathLayer.append(this.pathOutline, this.path, this.inkStroke);
      this.nodeLayer = element('g', { class: 'visual-layer', 'aria-hidden': 'true' });
      this.surface.append(warningDefs, this.mazeFloorLayer, this.mazeWallLayer, this.debugLayer, this.allObstacles, this.obstacleFlash,
        this.obstacleWarning, this.hintLayer, this.pathLayer, this.nodeLayer);
      this.shadowRoot.append(this.surface);
      this.brushCursor = element('svg', {
        class: 'brush-cursor', viewBox: '0 0 24 36', width: 24, height: 36,
        'aria-hidden': 'true', 'data-visible': 'false',
      });
      // Rotate the complete brush around its tip so the nib and handle keep
      // one straight axis while the pointer hotspot stays fixed.
      const brushBody = element('g', { class: 'brush-body', transform: 'rotate(28 7 32)' });
      brushBody.append(
        element('path', { d: 'M4.8 21V3Q4.8 1.2 7 1.2Q9.2 1.2 9.2 3V21Z', fill: '#ba9861', stroke: '#75674f', 'stroke-width': .55 }),
        element('path', { d: 'M6 3V20', fill: 'none', stroke: '#e9cfa2', 'stroke-width': .7 }),
        element('path', { d: 'M4.5 20.5H9.5V23H4.5Z', fill: '#766550' }),
        element('path', { d: 'M4.5 20H9.5', stroke: '#a7543e', 'stroke-width': .9 }),
        element('path', { class: 'brush-tip', d: 'M4.5 23Q4.5 26.5 7 32Q9.5 26.5 9.5 23Z', fill: '#33332d', stroke: '#f7f0dd', 'stroke-width': .45 }),
        element('path', { d: 'M6.3 24L7 30', fill: 'none', stroke: '#9c9787', 'stroke-width': .45 }),
      );
      this.brushCursor.append(brushBody);
      this.shadowRoot.append(this.brushCursor);
      this.cursorInk = document.createElement('span');
      this.cursorInk.className = 'cursor-ink';
      this.cursorInk.textContent = '100%';
      this.cursorInk.setAttribute('aria-label', '剩余墨水 100%');
      this.shadowRoot.append(this.cursorInk);

      this.toolbar = document.createElement('section');
      this.toolbar.className = 'toolbar';
      this.toolbar.setAttribute('aria-label', 'PagePath 游戏控制');
      // All markup is extension-owned constant text; page content is never HTML.
      this.toolbar.innerHTML = `
        <div class="toolbar-main">
          <button class="drag-handle" type="button" aria-label="移动悬浮栏" title="拖动悬浮栏 · 方向键微调">${iconMarkup('<path d="M8 5h.1M16 5h.1M8 12h.1M16 12h.1M8 19h.1M16 19h.1" stroke-width="3"/>')}</button>
          <span class="status" tabindex="0" role="img" aria-label="正在准备">
            <svg class="status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path/></svg>
            <span class="state-label">准备中</span>
          </span>
          <div class="metrics">
            <span class="metric metric-nodes" title="已收集的墨点">
              <svg class="metric-symbol" viewBox="0 0 10 12" aria-hidden="true"><path d="M2 4C1 1 7 1 8 4C11 7 6 11 3 9C0 8 0 5 2 4Z" fill="currentColor"/></svg>
              <span class="metric-value node-count">0 / 0</span>
            </span>
            <span class="metric metric-maze" title="穿过迷宫，到达纸张" aria-label="穿过迷宫，到达纸张" hidden>
              <svg class="maze-goal-icon" viewBox="0 0 35 17" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12V6Q2 3 6 3Q10 3 10 6V12Z"/><ellipse cx="6" cy="7" rx="2.2" ry="2.7"/><path d="M13 8H21M18 5L21 8L18 11M25 2H30L33 5V15H25ZM30 2V5H33"/></svg>
            </span>
          </div>
          <div class="actions">
            <div class="mode-control" role="group" aria-label="游戏难度" data-mode="normal">
              <button class="mode-button" type="button" data-mode="normal" aria-pressed="true" aria-label="萌新">${iconMarkup('<path d="M4 18L12 5L20 18Z"/>')}</button>
              <button class="mode-button" type="button" data-mode="hell" aria-pressed="false" aria-label="糕手">${iconMarkup('<path d="M2 18L8 7L14 18M10 18L16 7L22 18"/>')}</button>
              <button class="mode-button" type="button" data-mode="immortal" aria-pressed="false" aria-label="神仙">${iconMarkup('<path d="M1 18L6 9L11 18M7 18L12 4L17 18M13 18L18 9L23 18"/>')}</button>
              <span class="maze-mode-slot" data-unavailable="true" role="group" aria-label="第二关" title="">
                <button class="mode-button" type="button" data-mode="maze" aria-pressed="false" aria-label="第二关" aria-describedby="pagepath-maze-reason" disabled>${iconMarkup('<g class="maze-locked-mark" stroke-width="1.7"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></g><g class="maze-unlocked-mark"><path d="M12 2.5L14.9 8.5L21.5 9.4L16.8 14L17.9 20.6L12 17.5L6.1 20.6L7.2 14L2.5 9.4L9.1 8.5Z"/></g>')}</button>
              </span>
            </div>
            <button class="hint" type="button" aria-label="提示" aria-pressed="false" title="显示参考路线">${iconMarkup(icons.hint)}<span class="control-label sr-only">提示</span></button>
            <button class="retry" type="button" aria-label="重试" title="重试当前关卡">${iconMarkup(icons.retry)}<span class="sr-only">重试</span></button>
            <span class="new-slot">
              <button class="new-puzzle" type="button" aria-label="新地图" title="生成新地图">${iconMarkup(icons.newPuzzle)}<span class="sr-only">新地图</span></button>
              <button class="regenerate" type="button" aria-label="重新生成" title="重新截取页面并生成关卡" hidden>${iconMarkup(icons.regenerate)}<span class="sr-only">重新生成</span></button>
            </span>
            <button class="exit" type="button" aria-label="退出游戏" title="退出游戏 · 右键 / Esc">${iconMarkup(icons.exit)}<span class="sr-only">退出</span></button>
          </div>
        </div>
        <span id="pagepath-maze-reason" class="sr-only"></span>
        <span class="message" role="status" aria-live="polite" aria-atomic="true"></span>`;
      this.shadowRoot.append(this.toolbar);
      this.mazeTooltip = document.createElement('div');
      this.mazeTooltip.className = 'maze-tooltip';
      this.mazeTooltip.setAttribute('role', 'tooltip');
      this.mazeTooltip.hidden = true;
      this.mazeTooltip.innerHTML = '<p class="maze-tooltip-guide">寻找复杂的页面来解锁第二关。</p>' + ['complexity', 'distribution'].map(id =>
        `<div class="maze-criterion" data-criterion="${id}"><span></span><svg class="criterion-mark" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path/></svg></div>`).join('');
      this.shadowRoot.append(this.mazeTooltip);
      this.generationError = document.createElement('div');
      this.generationError.className = 'generation-error';
      this.generationError.setAttribute('aria-hidden', 'true');
      this.generationError.hidden = true;
      this.shadowRoot.append(this.generationError);
      this.toolbarMain = this.toolbar.querySelector('.toolbar-main');
      this.retryButton = this.toolbar.querySelector('.retry');
      this.hintButton = this.toolbar.querySelector('.hint');
      this.modeButtons = [...this.toolbar.querySelectorAll('.mode-button')];
      this.modeControl = this.toolbar.querySelector('.mode-control');
      this.mazeModeSlot = this.toolbar.querySelector('.maze-mode-slot');
      this.mazeReason = this.toolbar.querySelector('#pagepath-maze-reason');
      this.newPuzzleButton = this.toolbar.querySelector('.new-puzzle');
      this.regenerateButton = this.toolbar.querySelector('.regenerate');
      this.exitButton = this.toolbar.querySelector('.exit');
      this.message = this.toolbar.querySelector('.message');
      this.stateLabel = this.toolbar.querySelector('.state-label');
      this.status = this.toolbar.querySelector('.status');
      this.statusPath = this.toolbar.querySelector('.status-icon path');
      this.nodeCount = this.toolbar.querySelector('.node-count');
      this.dragHandle = this.toolbar.querySelector('.drag-handle');
      this.onToolbarMove = onToolbarMove;
      this.toolbarPosition = null;
      this.toolbarDrag = null;
      this.nodeMetric = this.toolbar.querySelector('.metric-nodes');
      this.mazeMetric = this.toolbar.querySelector('.metric-maze');
      this.listeners = [];
      this.bind(this.retryButton, 'click', () => {
        if (this.retryButton.disabled) return;
        if (this.generationFailed) (onRegenerate || onNewPuzzle)?.();
        else onRetry?.();
      });
      this.bind(this.hintButton, 'click', onHint);
      this.bind(this.newPuzzleButton, 'click', onNewPuzzle);
      this.bind(this.regenerateButton, 'click', onRegenerate || onNewPuzzle);
      this.bind(this.exitButton, 'click', onExit);
      this.listen(this.mazeModeSlot, 'pointerenter', () => { this.mazeTooltipHovered = true; this.refreshMazeTooltip(); });
      this.listen(this.mazeModeSlot, 'pointerleave', () => { this.mazeTooltipHovered = false; this.refreshMazeTooltip(); });
      this.listen(this.mazeModeSlot, 'focusin', () => { this.mazeTooltipFocused = true; this.refreshMazeTooltip(); });
      this.listen(this.mazeModeSlot, 'focusout', () => { this.mazeTooltipFocused = false; this.refreshMazeTooltip(); });
      this.listen(window, 'blur', () => this.hideMazeTooltip());
      for (const button of this.modeButtons) {
        this.bind(button, 'click', () => {
          if (!button.disabled && button.dataset.mode !== this.mode) onModeChange?.(button.dataset.mode);
        });
      }
      if (onDebug) {
        this.debugButton = document.createElement('button');
        this.debugButton.className = 'debug-button';
        this.debugButton.type = 'button';
        this.debugButton.innerHTML = iconMarkup(icons.debug);
        this.debugButton.setAttribute('aria-label', '地图分析视图');
        this.debugButton.title = '切换地图分析视图';
        this.toolbar.querySelector('.actions').insertBefore(this.debugButton, this.exitButton);
        this.bind(this.debugButton, 'click', onDebug);
        this.toolbar.dataset.debug = 'true';
      }
      for (const type of ['pointerenter', 'pointermove']) this.listen(this.surface, type, event => this.moveBrush(event));
      this.listen(this.surface, 'pointerleave', () => this.hideBrush());
      this.listen(this.surface, 'pointercancel', () => this.hideBrush());
      this.listen(this.toolbar, 'pointerenter', () => { if (this.state !== 'DRAWING') this.hideBrush(); });
      this.listen(window, 'blur', () => this.hideBrush());
      this.listen(this.toolbar, 'pointerdown', event => this.startToolbarDrag(event));
      this.listen(this.toolbar, 'pointermove', event => this.moveToolbarDrag(event));
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        this.listen(this.toolbar, type, event => this.endToolbarDrag(event));
      }
      this.listen(this.dragHandle, 'keydown', event => this.moveToolbarWithKeys(event));
      this.listen(window, 'blur', () => this.endToolbarDrag());
      this.listen(window, 'resize', () => this.clampToolbar());
      this.nodeElements = new Map();
      document.documentElement.append(this.host);
      this.resize();
      this.update({ state: 'GENERATING', mode: this.mode, message: '正在寻找网页中的空白…' });
    }

    bind(target, type, callback) {
      if (typeof callback !== 'function') return;
      const handler = event => { event.preventDefault(); event.stopPropagation(); callback(event); };
      target.addEventListener(type, handler);
      this.listeners.push(() => target.removeEventListener(type, handler));
    }

    listen(target, type, callback) {
      target.addEventListener(type, callback);
      this.listeners.push(() => target.removeEventListener(type, callback));
    }

    hideMazeTooltip() {
      this.mazeTooltipHovered = false;
      this.mazeTooltipFocused = false;
      this.mazeTooltip.hidden = true;
    }

    refreshMazeTooltip() {
      const canShow = !this.mazeAvailability.available && !this.captureHidden &&
        !['GENERATING', 'DRAWING', 'DESTROYED'].includes(this.state);
      this.mazeModeSlot.tabIndex = canShow ? 0 : -1;
      if (!canShow) { this.hideMazeTooltip(); return; }
      this.mazeTooltip.hidden = !this.mazeTooltipHovered && !this.mazeTooltipFocused;
      this.positionMazeTooltip();
    }

    positionMazeTooltip() {
      if (this.mazeTooltip.hidden) return;
      const anchor = this.mazeModeSlot.getBoundingClientRect(), box = this.mazeTooltip.getBoundingClientRect();
      const margin = 6;
      const left = Math.max(margin, Math.min(window.innerWidth - box.width - margin, anchor.left + (anchor.width - box.width) / 2));
      const below = anchor.bottom + margin;
      const top = below + box.height <= window.innerHeight - margin ? below : anchor.top - box.height - margin;
      this.mazeTooltip.style.left = `${left}px`;
      this.mazeTooltip.style.top = `${Math.max(margin, Math.min(window.innerHeight - box.height - margin, top))}px`;
    }

    positionToolbar(x, y) {
      const bounds = this.toolbar.getBoundingClientRect();
      const margin = 6;
      const left = Math.max(margin, Math.min(window.innerWidth - bounds.width - margin, x));
      const top = Math.max(margin, Math.min(window.innerHeight - bounds.height - margin, y));
      this.toolbarPosition = { x: left, y: top };
      this.toolbar.style.left = `${left}px`;
      this.toolbar.style.top = `${top}px`;
      this.toolbar.style.transform = 'none';
      this.positionMazeTooltip();
    }

    clampToolbar() {
      if (this.toolbarPosition) this.positionToolbar(this.toolbarPosition.x, this.toolbarPosition.y);
      else this.positionMazeTooltip();
    }

    startToolbarDrag(event) {
      if (event.button !== 0 || event.isPrimary === false || this.toolbarDrag ||
          ['DRAWING', 'GENERATING', 'DESTROYED'].includes(this.state)) return;
      const control = event.target.closest?.('button,select,input,textarea,.maze-mode-slot');
      if (control && control !== this.dragHandle) return;
      const rect = this.toolbar.getBoundingClientRect();
      this.toolbarDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
        left: rect.left, top: rect.top, previousRect: rectangle(rect) };
      this.toolbar.dataset.dragging = 'true';
      this.hideBrush();
      this.toolbar.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    }

    moveToolbarDrag(event) {
      const drag = this.toolbarDrag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      this.positionToolbar(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
      event.preventDefault();
      event.stopPropagation();
    }

    endToolbarDrag(event, notify = true) {
      const drag = this.toolbarDrag;
      if (!drag || (event && event.pointerId !== drag.pointerId)) return;
      if (event?.type === 'pointerup') this.moveToolbarDrag(event);
      this.toolbarDrag = null;
      delete this.toolbar.dataset.dragging;
      if (this.toolbar.hasPointerCapture?.(drag.pointerId)) {
        try { this.toolbar.releasePointerCapture(drag.pointerId); } catch { /* Pointer already released. */ }
      }
      if (notify) this.onToolbarMove?.({ rect: rectangle(this.toolbar.getBoundingClientRect()), previousRect: drag.previousRect });
    }

    moveToolbarWithKeys(event) {
      if (this.dragHandle.disabled) return;
      const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!direction) return;
      event.preventDefault();
      event.stopPropagation();
      const previousRect = rectangle(this.toolbar.getBoundingClientRect());
      const step = event.shiftKey ? 24 : 8;
      this.positionToolbar(previousRect.x + direction[0] * step, previousRect.y + direction[1] * step);
      this.onToolbarMove?.({ rect: rectangle(this.toolbar.getBoundingClientRect()), previousRect });
    }

    hideBrush() {
      this.brushCursor.setAttribute('data-visible', 'false');
      this.cursorInk.setAttribute('data-visible', 'false');
      this.lastBrushPoint = null;
      cancelAnimationFrame(this.warningFrame);
      this.warningFrame = 0;
      this.obstacleWarning.setAttribute('d', '');
    }

    setMap(map) {
      this.cancelObstacleFlash();
      this.pixelMap = map?.kind === 'pixel-mask' ? map : null;
      this.visibleContours = this.pixelMap
        ? P.Collision.reachableContours(this.pixelMap, this.level?.nodes?.[0]) : null;
      if (this.visibleContours && this.level?.mode === 'maze') {
        const parts = splitMazeContours(this.visibleContours, this.pixelMap, this.level.mazeSourceAnalysis);
        this.sourceContours = parts.original;
        this.mazeContours = parts.added;
      } else {
        this.sourceContours = this.visibleContours;
        this.mazeContours = null;
      }
      this.obstacleWarning.setAttribute('d', '');
      // The one-shot new-map flash uses original page content only. Added maze
      // walls stay hidden until approached, and hints never reveal obstacles.
      const segments = this.sourceContours?.segments || [], lines = [];
      for (let i = 0; i < segments.length; i += 4) {
        lines.push(`M${segments[i]},${segments[i + 1]}L${segments[i + 2]},${segments[i + 3]}`);
      }
      this.obstacleShape.setAttribute('d', lines.join(''));
      this.allObstacles.setAttribute('visibility', 'hidden');
    }

    cancelObstacleFlash() {
      if (!this.flashAnimation) return;
      this.flashAnimation.onfinish = null;
      this.flashAnimation.cancel();
      this.flashAnimation = null;
    }

    flashObstacles() {
      this.cancelObstacleFlash();
      if (!this.sourceContours?.segments?.length || this.captureHidden ||
          ['PAUSED', 'DESTROYED', 'GENERATING'].includes(this.state)) return;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const frames = reduced ? [{ opacity: .75 }, { opacity: .75 }]
        : [{ opacity: 0 }, { opacity: 1, offset: .18 }, { opacity: .9, offset: .38 }, { opacity: 0 }];
      const animation = this.obstacleFlash.animate(frames, { duration: 700, easing: 'ease-out' });
      this.flashAnimation = animation;
      animation.onfinish = () => {
        if (this.flashAnimation === animation) this.cancelObstacleFlash();
      };
    }

    renderProximity(point) {
      const map = this.pixelMap, contour = this.visibleContours;
      if (!point || !contour || !map?.walkableMask) {
        this.obstacleWarning.setAttribute('d', ''); return;
      }
      const { x, y } = point;
      const col = Math.floor(x), row = Math.floor(y), radius = P.Config.PIXEL_MAP.WARNING_DISTANCE;
      if (col < 0 || row < 0 || col >= map.width || row >= map.height) {
        this.obstacleWarning.setAttribute('d', ''); return;
      }
      const distance = Math.max(0, map.distanceMap[row * map.width + col] -
        (map.stats?.clearance ?? P.Config.PLAYER_RADIUS + P.Config.PIXEL_MAP.SAFETY_MARGIN));
      if (distance >= radius) { this.obstacleWarning.setAttribute('d', ''); return; }
      const ids = new Set(), size = contour.bucketSize;
      for (let by = Math.floor((y - radius) / size); by <= Math.floor((y + radius) / size); by++) {
        for (let bx = Math.floor((x - radius) / size); bx <= Math.floor((x + radius) / size); bx++) {
          for (const id of contour.buckets[`${bx},${by}`] || []) ids.add(id);
        }
      }
      const lines = [], segments = contour.segments;
      for (const id of ids) {
        let x1 = segments[id * 4], y1 = segments[id * 4 + 1];
        let x2 = segments[id * 4 + 2], y2 = segments[id * 4 + 3];
        // Clip only the visible portion of an exact mask-cell edge. Never
        // approximate the collision contour or highlight a far-away whole wall.
        if (y1 === y2) {
          if (Math.abs(y1 - y) >= radius) continue;
          const reach = Math.sqrt(radius * radius - (y1 - y) ** 2);
          const low = Math.max(Math.min(x1, x2), x - reach), high = Math.min(Math.max(x1, x2), x + reach);
          if (low >= high) continue;
          x1 = low; x2 = high;
        } else {
          if (Math.abs(x1 - x) >= radius) continue;
          const reach = Math.sqrt(radius * radius - (x1 - x) ** 2);
          const low = Math.max(Math.min(y1, y2), y - reach), high = Math.min(Math.max(y1, y2), y + reach);
          if (low >= high) continue;
          y1 = low; y2 = high;
        }
        lines.push(`M${x1},${y1}L${x2},${y2}`);
      }
      this.warningGradient.setAttribute('cx', x);
      this.warningGradient.setAttribute('cy', y);
      this.warningGradient.setAttribute('r', radius);
      this.obstacleWarning.setAttribute('d', lines.join(''));
      this.obstacleWarning.setAttribute('opacity', .4 + .6 * (1 - distance / radius));
    }

    moveBrush(event) {
      if (this.captureHidden || this.generationFailed || this.state !== 'DRAWING' || event.pointerType === 'touch') {
        this.hideBrush();
        return;
      }
      const x = event.clientX, y = event.clientY;
      const toolbar = this.toolbar.getBoundingClientRect();
      // The expanded toolbar hides the brush even during captured events.
      // Folded controls let drawing continue across their former footprint.
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight ||
          (this.state !== 'DRAWING' && x >= toolbar.left && x <= toolbar.right && y >= toolbar.top && y <= toolbar.bottom)) {
        this.hideBrush();
        return;
      }
      this.lastBrushPoint = { x, y };
      // The whole brush tilts around its fixed nib tip at local (7,32).
      this.brushCursor.style.transform = `translate(${x - 7}px, ${y - 32}px)`;
      this.brushCursor.setAttribute('data-visible', 'true');
      const inkX = x + 10 + 32 < window.innerWidth ? x + 10 : x - 40;
      this.cursorInk.style.transform = `translate(${Math.max(2, inkX)}px, ${Math.max(2, Math.min(window.innerHeight - 16, y - 13))}px)`;
      this.cursorInk.setAttribute('data-visible', 'true');
      if (!this.warningFrame) this.warningFrame = requestAnimationFrame(() => {
        this.warningFrame = 0;
        this.renderProximity(this.lastBrushPoint);
      });
    }

    setCaptureHidden(hidden) {
      this.captureHidden = Boolean(hidden);
      this.hideBrush();
      if (hidden) this.cancelObstacleFlash();
      if (hidden) this.hideMazeTooltip();
      if (hidden) this.host.style.setProperty('opacity', '0', 'important');
      else this.host.style.removeProperty('opacity');
    }

    setSnapshot(image) {
      this.clearSnapshot();
      image.className = 'page-snapshot';
      image.style.cssText = 'position:absolute;inset:0;display:block;width:100%;height:100%;max-width:none;max-height:none;margin:0;padding:0;border:0;object-fit:fill;pointer-events:none;';
      image.alt = '';
      image.draggable = false;
      image.setAttribute('aria-hidden', 'true');
      // A screenshot may contain cross-origin embedded content. Keep its pixels
      // and data URL out of the webpage's accessible DOM; only the isolated
      // extension world retains this image reference.
      this.snapshotLayer = document.createElement('div');
      this.snapshotLayer.className = 'snapshot-layer';
      this.snapshotLayer.attachShadow({ mode: 'closed' }).append(image);
      this.shadowRoot.insertBefore(this.snapshotLayer, this.surface);
      this.snapshotImage = image;
      this.host.dataset.pagepathFrozen = 'true';
    }

    clearSnapshot() {
      this.snapshotImage?.remove();
      this.snapshotLayer?.remove();
      this.snapshotLayer = null;
      this.snapshotImage = null;
      delete this.host.dataset.pagepathFrozen;
    }

    resize() {
      this.clampToolbar();
      const width = window.innerWidth;
      const height = window.innerHeight;
      this.surface.setAttribute('viewBox', `0 0 ${width} ${height}`);
      this.surface.setAttribute('width', width);
      this.surface.setAttribute('height', height);
    }

    getReservedRects() {
      this.resize();
      const rect = this.toolbar.getBoundingClientRect();
      const pad = 6;
      const left = Math.max(0, rect.left - pad);
      const top = Math.max(0, rect.top - pad);
      const right = Math.min(window.innerWidth, rect.right + pad);
      const bottom = Math.min(window.innerHeight, rect.bottom + pad);
      return [{ x: left, y: top, left, top, right, bottom, width: right - left, height: bottom - top }];
    }

    renderLevel(level) {
      this.level = level;
      this.mazeWallLayer.replaceChildren();
      this.mazeFloorLayer.replaceChildren();
      if (level?.mazeOpenings?.length) {
        // Only erase pixels actually opened through original foreground.
        // Natural page background is never covered with a maze-shaped floor.
        const d = level.mazeOpenings.map(r => `M${r.x},${r.y}h${r.width}v${r.height}h-${r.width}Z`).join('');
        this.mazeFloorLayer.append(element('path', { d, fill: '#fffaf0', 'fill-opacity': 0.98 }));
      }
      if (!level) this.setMap(null);
      this.renderHint(false);
      this.update({ hintVisible: false });
      if (level?.mode) this.update({ mode: level.mode, unlimitedInk: Boolean(level.unlimitedInk || level.mode === 'maze') });
      this.resize();
      this.nodeLayer.replaceChildren();
      this.nodeElements.clear();
      this.renderPath([]);
      if (!level?.nodes?.length) return;
      level.nodes.forEach((node, index) => {
        const kind = node.kind || node.type || (index === 0 ? 'start' : index === level.nodes.length - 1 ? 'finish' : 'checkpoint');
        const group = element('g', {
          class: `node ${kind === 'start' ? 'inkstone' : kind === 'finish' || kind === 'end' ? 'paper' : 'ink-dot'}`,
          transform: `translate(${node.x} ${node.y})`,
          'data-node-id': node.id ?? index, 'data-collected': Boolean(node.collected),
        });
        if (kind === 'start') {
          group.append(
            element('path', { class: 'stone-body', d: 'M-8-8Q-1-10 6-8Q10-6 10 1Q10 8 6 9L-6 10Q-11 8-11 2L-10-4Q-10-7-8-8Z' }),
            element('path', { class: 'stone-well', d: 'M-5-5Q0-7 5-5Q7-3 6 3Q5 6 0 6Q-6 6-7 2Q-8-2-5-5Z' }),
            element('path', { class: 'stone-shine', d: 'M-6-4Q-2-6 3-5M-7 7L-2 8' }),
            element('circle', { class: 'collected-mark', cx: 5.8, cy: 5.8, r: 2 }),
          );
        } else if (kind === 'finish' || kind === 'end') {
          group.append(
            element('path', { d: 'M-7-9H3L7-5V9H-7Z', fill: '#fffdf5', stroke: '#fffdf5', 'stroke-width': 2.1, 'stroke-linejoin': 'round' }),
            element('path', { class: 'paper-body', d: 'M-7-9H3L7-5V9L-7 8Z' }),
            element('path', { class: 'paper-fold', d: 'M3-9L7-5H3Z' }),
            element('path', { class: 'paper-line', d: 'M-4-3H0M-4 1H3M-4 5H0' }),
            element('rect', { class: 'collected-mark', x: 1.5, y: 4, width: 3.5, height: 3.5, rx: .5, transform: 'rotate(-8 3.3 5.8)' }),
          );
        } else {
          group.append(
            element('circle', { class: 'ink-halo', r: 6.4 }),
            element('path', { class: 'ink-drop', d: 'M-4-3C-3-6 1-5 3-4C6-3 5 0 5 2C4 5 0 6-2 4C-5 5-6 0-4-3Z', transform: `rotate(${(index * 47) % 180})` }),
            element('circle', { class: 'ink-grain', cx: -6, cy: 2, r: .75 }),
            element('circle', { class: 'collected-mark', r: 1.65 }),
          );
        }
        this.nodeLayer.append(group);
        this.nodeElements.set(node.id ?? index, group);
      });
    }

    markNode(id, collected = true) {
      const group = this.nodeElements.get(id);
      if (group) group.setAttribute('data-collected', String(Boolean(collected)));
    }

    resetNodes() {
      for (const group of this.nodeElements.values()) group.setAttribute('data-collected', 'false');
    }

    renderPath(points = []) {
      const mode = P.getMode(this.level?.mode || this.mode);
      const tailLength = this.level?.trailLength ?? mode.trailLength;
      const tail = P.Trail.clip(points, tailLength);
      const coordinates = pointString(tail);
      this.path.setAttribute('points', coordinates);
      this.pathOutline.setAttribute('points', coordinates);
      if (!this.inkStroke) return;
      this.inkStroke.replaceChildren();
      if (tail.length < 2) return;
      // Sample by arc length, so the brush texture is the same for a slow
      // gesture and a single fast movement. Only this short tail is rendered.
      const lengths = tail.slice(1).map((point, i) => Math.hypot(point.x - tail[i].x, point.y - tail[i].y));
      const length = lengths.reduce((sum, value) => sum + value, 0);
      if (!length) return;
      const count = Math.max(2, Math.ceil(length / 1.4));
      const samples = [];
      let segment = 0, before = 0;
      for (let i = 0; i <= count; i++) {
        const distance = length * i / count;
        while (segment < lengths.length - 1 && before + lengths[segment] < distance) before += lengths[segment++];
        const ratio = lengths[segment] ? (distance - before) / lengths[segment] : 0;
        samples.push({ x: tail[segment].x + (tail[segment + 1].x - tail[segment].x) * ratio,
          y: tail[segment].y + (tail[segment + 1].y - tail[segment].y) * ratio });
      }
      const edges = samples.map((point, i) => {
        const previous = samples[Math.max(0, i - 1)], next = samples[Math.min(count, i + 1)];
        const dx = next.x - previous.x, dy = next.y - previous.y, magnitude = Math.hypot(dx, dy) || 1;
        const t = i / count;
        const width = (.12 + 1.05 * Math.sin(t * Math.PI / 2)) * (.94 + .06 * Math.sin(i * 2.3));
        return { left: { x: point.x - dy / magnitude * width, y: point.y + dx / magnitude * width },
          right: { x: point.x + dy / magnitude * width, y: point.y - dx / magnitude * width } };
      });
      const xy = point => `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
      for (let i = 1; i <= count; i++) {
        this.inkStroke.append(element('path', { class: 'ink-stroke-piece',
          d: `M${xy(edges[i - 1].left)}L${xy(edges[i].left)}L${xy(edges[i].right)}L${xy(edges[i - 1].right)}Z`,
          opacity: (.12 + .62 * i / count).toFixed(2) }));
      }
      // A fine broken fibre gives the stroke a dry-brush edge instead of a
      // uniform black wire. It is visual only; ink counts the original points.
      const fibre = samples.slice(Math.floor(count * .25), Math.floor(count * .85))
        .map((point, i) => ({ x: point.x + (edges[i + Math.floor(count * .25)].left.x - point.x) * .35,
          y: point.y + (edges[i + Math.floor(count * .25)].left.y - point.y) * .35 }));
      if (fibre.length > 1) this.inkStroke.append(element('polyline', {
        class: 'ink-bristle', points: pointString(fibre), 'stroke-dasharray': '2.5 1.4 4 .8' }));
    }

    renderHint(visible) {
      this.hintLayer.replaceChildren();
      const route = this.level?.referencePath;
      this.routeHintVisible = Boolean(visible && route?.length && this.mode !== 'maze' && this.level?.mode !== 'maze');
      this.allObstacles.setAttribute('visibility', 'hidden');
      if (this.routeHintVisible) this.cancelObstacleFlash();
      this.renderProximity(this.lastBrushPoint);
      if (!this.routeHintVisible) return;
      const points = pointString(route);
      this.hintLayer.append(
        element('polyline', { class: 'hint-outline', points }),
        element('polyline', { class: 'hint-route hint-path', points }),
      );
      // Place direction chevrons by distance rather than at every grid corner,
      // so both long straight sections and dense bends remain easy to read.
      let untilArrow = 38;
      for (let index = 1; index < route.length; index++) {
        const start = route[index - 1], end = route[index];
        const dx = end.x - start.x, dy = end.y - start.y;
        const length = Math.hypot(dx, dy);
        if (!length) continue;
        for (; untilArrow < length; untilArrow += 84) {
          const ratio = untilArrow / length;
          const x = start.x + dx * ratio, y = start.y + dy * ratio;
          const angle = Math.atan2(dy, dx) * 180 / Math.PI;
          this.hintLayer.append(element('path', {
            class: 'hint-arrow', d: 'M-4,-3 L0,0 L-4,3',
            transform: `translate(${x} ${y}) rotate(${angle})`,
          }));
        }
        untilArrow -= length;
      }
      for (const [index, node] of (this.level.nodes || []).entries()) {
        const label = element('text', { class: 'hint-step', x: node.x + 10, y: node.y + 4 });
        label.textContent = String(index + 1);
        this.hintLayer.append(label);
      }
    }

    update({ state, nodes, total, ink, inkMultiplier, message, score, difficulty, efficiency, mode, hintVisible,
      mazeAvailability, unlimitedInk, generationFailed } = {}) {
      if (generationFailed !== undefined) this.generationFailed = Boolean(generationFailed);
      if (mazeAvailability !== undefined) {
        // Replace the measured snapshot instead of merging it: a new capture
        // may be pending, and must not display numbers from the previous page.
        this.mazeAvailability = { ...mazeAvailability, available: Boolean(mazeAvailability?.available),
          reason: typeof mazeAvailability?.reason === 'string' && mazeAvailability.reason.trim()
            ? mazeAvailability.reason.trim() : '此页面暂不适合生成迷宫' };
      }
      if (mazeAvailability !== undefined || !this.mazeReason.textContent) {
        const criteria = mazeCriteria(this.mazeAvailability);
        for (const criterion of criteria) {
          const row = this.mazeTooltip.querySelector(`[data-criterion="${criterion.id}"]`);
          row.dataset.passed = String(criterion.passed);
          row.querySelector('span').textContent = criterion.label;
          row.setAttribute('aria-label', `${criterion.label}：${criterion.known ? criterion.passed ? '已达标' : '未达标' : '待检测'}`);
          row.querySelector('path').setAttribute('d', criterion.passed ? 'M3 8L6.5 11.5L13 4.5' : 'M4 4L12 12M12 4L4 12');
        }
        this.mazeReason.textContent = criteria.map(criterion => `${criterion.label}：${criterion.known ? criterion.passed ? '已达标' : '未达标' : '待检测'}`).join('；');
      }
      if (mode !== undefined || inkMultiplier !== undefined || mazeAvailability !== undefined) {
        const profile = P.getMode(mode ?? this.mode);
        this.mode = profile.id;
        this.modeControl.dataset.mode = this.mode;
        this.toolbar.dataset.mode = this.mode;
        for (const button of this.modeButtons) {
          const option = P.getMode(button.dataset.mode), selected = option.id === this.mode;
          button.setAttribute('aria-pressed', String(selected));
          button.setAttribute('aria-label', option.label);
          button.title = option.id === 'maze' && !this.mazeAvailability.available ? '' : option.label;
          if (option.id === 'maze') {
            this.mazeModeSlot.title = button.title;
            this.mazeModeSlot.dataset.unavailable = String(!this.mazeAvailability.available);
            for (const control of [button, this.mazeModeSlot]) {
              if (this.mazeAvailability.available) control.removeAttribute('aria-describedby');
              else control.setAttribute('aria-describedby', 'pagepath-maze-reason');
            }
          }
          if (selected) this.modeControl.title = button.title;
        }
        this.surface.setAttribute('aria-label', this.mode === 'maze' ? 'PagePath 第二关迷宫地图' : 'PagePath 一笔画地图');
      }
      const noHint = this.mode === 'maze' || this.level?.mode === 'maze';
      if (noHint) {
        this.renderHint(false);
        hintVisible = false;
      }
      if (hintVisible !== undefined) {
        this.hintButton.querySelector('.control-label').textContent = hintVisible ? '收起' : '提示';
        this.hintButton.setAttribute('aria-label', hintVisible ? '收起提示' : '提示');
        this.hintButton.setAttribute('aria-pressed', String(Boolean(hintVisible)));
      }
      this.hintButton.hidden = noHint;
      this.hintButton.title = `${this.hintButton.getAttribute('aria-pressed') === 'true' ? '收起' : '显示'}参考路线`;
      if (state) {
        this.state = state;
        if (['PAUSED', 'GENERATING', 'DESTROYED'].includes(state)) this.cancelObstacleFlash();
        this.toolbar.dataset.state = state;
        this.toolbarMain.inert = state === 'DRAWING';
        this.surface.dataset.state = state;
        this.stateLabel.textContent = {
          IDLE: '待开始', GENERATING: '生成中', READY: '待开始', DRAWING: '描绘中',
          FAILED: this.generationFailed ? '生成失败' : '再试一次', SUCCESS: '已完成', PAUSED: '已暂停', DESTROYED: '已退出',
        }[state] || state;
        this.statusPath.setAttribute('d', {
          IDLE: 'M8 5Q4 6 4 12Q4 19 12 19Q20 19 20 12Q20 4 12 4Q10 4 8 5ZM8 9Q12 6 16 9',
          READY: 'M8 5Q4 6 4 12Q4 19 12 19Q20 19 20 12Q20 4 12 4Q10 4 8 5ZM8 9Q12 6 16 9',
          GENERATING: 'M12 3V6M12 18V21M3 12H6M18 12H21M5.6 5.6L7.8 7.8M16.2 16.2L18.4 18.4M5.6 18.4L7.8 16.2M16.2 7.8L18.4 5.6',
          DRAWING: 'M5 19L8 12L16 4L20 8L12 16ZM8 12L12 16',
          SUCCESS: 'M5 12L10 17L20 6', FAILED: 'M7 7L17 17M17 7L7 17',
          PAUSED: 'M9 6V18M15 6V18', DESTROYED: 'M7 7L17 17M17 7L7 17',
        }[state] || '');
        if (this.generationFailed || state !== 'DRAWING') this.hideBrush();
        const busy = state === 'GENERATING';
        const paused = state === 'PAUSED';
        this.dragHandle.disabled = busy || state === 'DRAWING' || state === 'DESTROYED';
        if (this.dragHandle.disabled) this.endToolbarDrag();
        this.retryButton.disabled = busy || paused || (!this.level && !this.generationFailed);
        const retryLabel = this.generationFailed ? '刷新地图' : '重试';
        this.retryButton.setAttribute('aria-label', retryLabel);
        this.retryButton.title = this.generationFailed ? '重新截取页面并生成关卡' : '重试当前关卡';
        if (this.retryButton.dataset.refresh !== String(this.generationFailed)) {
          this.retryButton.innerHTML = `${iconMarkup(this.generationFailed ? icons.regenerate : icons.retry)}<span class="sr-only">${retryLabel}</span>`;
          this.retryButton.dataset.refresh = String(this.generationFailed);
        }
        this.newPuzzleButton.disabled = busy;
        this.newPuzzleButton.hidden = paused;
        this.regenerateButton.hidden = !paused;
      }
      for (const button of this.modeButtons) {
        button.disabled = ['GENERATING', 'DRAWING', 'DESTROYED'].includes(this.state) ||
          (button.dataset.mode === 'maze' && !this.mazeAvailability.available);
      }
      this.refreshMazeTooltip();
      this.hintButton.disabled = noHint || !this.level?.referencePath?.length ||
        ['GENERATING', 'DRAWING', 'PAUSED', 'DESTROYED'].includes(this.state);
      if (nodes !== undefined) this.collected = nodes;
      if (total !== undefined) this.total = total;
      this.nodeCount.textContent = `${this.collected ?? 0} / ${this.total ?? 0}`;
      this.nodeMetric.title = `已收集墨点 ${this.collected ?? 0} / ${this.total ?? 0}`;
      this.nodeMetric.setAttribute('aria-label', this.nodeMetric.title);
      const maze = this.mode === 'maze';
      this.nodeMetric.hidden = maze;
      this.mazeMetric.hidden = !maze;
      this.mazeMetric.title = this.state === 'SUCCESS' ? '已走出迷宫' : '穿过迷宫，到达纸张';
      this.mazeMetric.setAttribute('aria-label', this.mazeMetric.title);
      if (unlimitedInk !== undefined) this.unlimitedInk = Boolean(unlimitedInk);
      else if (mode !== undefined) this.unlimitedInk = maze;
      if (Number.isFinite(ink)) this.inkPercentage = Math.max(0, Math.min(100, Math.round(ink)));
      this.cursorInk.textContent = this.unlimitedInk ? '∞' : `${this.inkPercentage}%`;
      this.cursorInk.dataset.low = String(!this.unlimitedInk && this.inkPercentage <= 20);
      this.cursorInk.dataset.unlimited = String(this.unlimitedInk);
      this.cursorInk.setAttribute('aria-label', this.unlimitedInk ? '无限墨水' : `剩余墨水 ${this.inkPercentage}%`);
      if (this.state === 'SUCCESS' && maze) {
        this.message.textContent = message ?? '第二关 · 已走出迷宫';
        this.message.classList.add('result');
      } else if (this.state === 'SUCCESS' && score !== undefined) {
        const parts = [P.getMode(this.mode).label, `得分 ${Math.round(score)}`];
        if (difficulty !== undefined) parts.push(`难度 ${Math.round(difficulty)}`);
        if (efficiency !== undefined) parts.push(`效率 ${Math.round(efficiency)}%`);
        this.message.textContent = parts.join('  ·  ');
        this.message.classList.add('result');
      } else if (message !== undefined || state) {
        const defaultMessages = {
          GENERATING: '正在寻找网页中的空白…',
          READY: '单击砚台开始，移动毛笔经过所有墨点，再到纸张。',
          DRAWING: '移动毛笔 · 避开网页内容 · 收集所有墨点',
          FAILED: this.generationFailed
            ? (this.mode === 'maze' ? '第二关生成失败，可重试新地图、刷新页面截图或切换难度。'
              : '当前页面空隙不足，可点击五角星进入第二关。')
            : '点击重试，或再次单击砚台开始。',
          SUCCESS: '路径完成。试试下一张地图。',
          PAUSED: '页面布局发生变化，请重新生成地图。',
          ...(maze ? { GENERATING: '正在生成迷宫…', READY: '单击砚台开始，移动毛笔穿过迷宫，到达纸张。',
            DRAWING: '移动毛笔 · 避开墙壁 · 找到通往纸张的路', SUCCESS: '已走出迷宫。试试下一张地图。' } : {}),
        };
        this.message.textContent = message ?? defaultMessages[this.state] ?? '';
        this.message.classList.remove('result');
      }
      this.message.title = this.message.textContent;
      this.surface.dataset.generationFailed = String(this.generationFailed);
      this.generationError.hidden = !this.generationFailed || this.state !== 'FAILED';
      this.generationError.textContent = this.generationError.hidden ? '' : this.message.textContent;
      this.status.title = `${this.stateLabel.textContent} · ${this.message.textContent}`;
      this.status.setAttribute('aria-label', this.status.title);
    }

    showDebug(analysis, level, enabled) {
      this.debugLayer.replaceChildren();
      if (!enabled) return;
      if (analysis?.kind === 'pixel-mask') {
        const edges = (this.pixelMap === analysis ? this.sourceContours : analysis.contours)?.segments || [], lines = [];
        for (let i = 0; i < Math.min(edges.length, 200000); i += 4) {
          lines.push(`M${edges[i]},${edges[i + 1]}L${edges[i + 2]},${edges[i + 3]}`);
        }
        this.debugLayer.append(element('path', { d: lines.join(''), fill: 'none',
          stroke: '#d83f39', 'stroke-width': .7, opacity: .55 }));
      }
      const grid = level?.grid || analysis?.grid;
      // A single SVG path per component keeps the diagnostic grid inexpensive.
      if (grid?.components && typeof grid.point === 'function') {
        grid.components.forEach((component, index) => {
          const color = `hsl(${(index * 73 + 155) % 360} 65% 47%)`;
          const half = (grid.cellSize || 4) * .39;
          const cells = component.map(cell => {
            const point = grid.point(cell);
            return `M${point.x - half},${point.y - half}h${half * 2}v${half * 2}h${-half * 2}Z`;
          }).join('');
          this.debugLayer.append(element('path', { d: cells, fill: color, opacity: .13 }));
        });
      }
      for (const rect of analysis?.rects || analysis?.obstacles || []) {
        const r = rectangle(rect);
        this.debugLayer.append(element('rect', { ...r, fill: '#cf5e53', 'fill-opacity': .09, stroke: '#bd6259', 'stroke-width': .7, 'stroke-opacity': .6 }));
      }
      const reference = level?.referencePath || level?.referenceRoute || [];
      if (reference.length) this.debugLayer.append(element('polyline', {
        points: pointString(reference), fill: 'none', stroke: '#7470cb',
        'stroke-width': 1.5, 'stroke-dasharray': '4 4', opacity: .75,
      }));
      for (const candidate of level?.candidates || level?.checkpointCandidates || []) {
        const point = typeof candidate === 'number' && grid?.point ? grid.point(candidate) : candidate;
        if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) this.debugLayer.append(element('circle', {
          cx: point.x, cy: point.y, r: 3, fill: 'none', stroke: '#ac719d', 'stroke-width': 1,
        }));
      }
    }

    destroy() {
      this.hideMazeTooltip();
      this.endToolbarDrag(null, false);
      this.hideBrush();
      this.setMap(null);
      for (const remove of this.listeners.splice(0)) remove();
      this.clearSnapshot();
      this.host.remove();
      this.nodeElements.clear();
      this.mazeWallLayer.replaceChildren();
      this.mazeFloorLayer.replaceChildren();
      this.level = null;
      this.pixelMap = null;
      this.state = 'DESTROYED';
    }
  };
})();
