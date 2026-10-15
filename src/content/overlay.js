(() => {
  'use strict';

  const P = globalThis.__PAGEPATH__ ||= {};
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const t = (message, params = {}) => P.I18n?.t(message, params) ??
    message.replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(params, key) ? String(params[key]) : match);
  const number = value => P.I18n?.number(value) ?? Number(value).toLocaleString('zh-CN');
  const html = message => t(message).replace(/[&<>"']/g, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

  // Kept here so a programmatically injected content script can style its shadow
  // root synchronously, without fetches, host permissions, or exposed resources.
  P.OVERLAY_CSS = `
    :host { color-scheme:light; }
    *,*::before,*::after { box-sizing:border-box; }
    .snapshot-layer { position:absolute;inset:0;display:block;width:100%;height:100%;max-width:none;max-height:none;margin:0;padding:0;border:0;object-fit:fill;pointer-events:none;user-select:none; }
    .surface { position:absolute;inset:0;display:block;width:100%;height:100%;overflow:hidden;pointer-events:auto;touch-action:none;cursor:default;user-select:none;-webkit-user-select:none; }
    .surface[data-state="DRAWING"] { cursor:none; }
    .surface[data-generation-failed="true"] { cursor:default; }
    .visual-layer { pointer-events:none; }
    .obstacle-warning,.obstacle-flash { fill:none;stroke-linejoin:round;vector-effect:non-scaling-stroke; }
    .path,.path-outline { display:none; }
    .ember-trail { color:#d8964e; }
    .ember-trail-glow,.ember-trail-thread { fill:none;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round; }
    .ember-trail-glow { stroke-width:3; }
    .ember-trail-thread { stroke-width:.8;stroke-dasharray:1.2 2; }
    .ember-trail-spark { fill:#ffe6a1;stroke:#c88740;stroke-width:.3; }
    .surface[data-state="FAILED"] .ember-trail { color:#bc816b;opacity:.5; }
    .surface[data-state="SUCCESS"] .ember-trail { opacity:0;transition:opacity .4s ease-out; }
    .campfire { opacity:1;transition:opacity .3s ease-out; }
    .camp-log-underlay,.camp-log,.camp-log-grain { fill:none;stroke-linecap:round; }
    .camp-log-underlay { stroke:#fff4db;stroke-width:3.8; }
    .camp-log { stroke:#947058;stroke-width:2.4; }
    .camp-log-grain { stroke:#c5a27a;stroke-width:.6; }
    .camp-flame { opacity:1;transition:opacity .18s ease-out; }
    .flame-shape { transform-box:fill-box;transform-origin:50% 100%;animation:flame-flicker 1.45s ease-in-out infinite; }
    .flame-body { fill:url(#pagepath-flame);stroke:#bd793e;stroke-width:.4;stroke-linejoin:round; }
    .flame-inner { fill:#fff0b1; }
    .flame-core { fill:#fff9df;stroke:#b77937;stroke-width:.35; }
    .surface[data-state="DRAWING"] .campfire[data-collected="true"] { opacity:.22; }
    .surface[data-state="DRAWING"] .campfire[data-collected="true"] .camp-flame { opacity:0; }
    .surface[data-state="DRAWING"] .campfire .flame-shape { animation-play-state:paused; }
    @keyframes flame-flicker { 0%,100% { transform:scale(.97,1) rotate(-1deg); } 45% { transform:scale(1.03,.95) rotate(1.5deg); } 75% { transform:scale(.95,1.04) rotate(-.5deg); } }
    .cave-rock { fill:#a69b86;stroke:#fff5df;stroke-width:1.2;stroke-linejoin:round; }
    .cave-facet { fill:#bdb29c; }
    .cave-mouth { fill:#373a36;stroke:#77735f;stroke-width:.65;stroke-linejoin:round;transition:fill .45s ease-out; }
    .cave-crack { fill:none;stroke:#807b68;stroke-width:.6;stroke-linecap:round; }
    .cave-arrival { opacity:0;transform-box:fill-box;transform-origin:center; }
    .exit-cave[data-collected="true"] .cave-frame { animation:cave-warm .7s ease-out; }
    .exit-cave[data-collected="true"] .cave-mouth { fill:#6b4933; }
    .exit-cave[data-collected="true"] .cave-arrival { opacity:.55;transform:scale(.65);animation:cave-arrive .7s ease-out both; }
    @keyframes cave-warm { 0%,100% { opacity:1; } 45% { opacity:.75; } }
    @keyframes cave-arrive { 0% { opacity:0;transform:translateY(4px) scale(1); } 40% { opacity:1;transform:translateY(0) scale(.9); } 100% { opacity:.55;transform:translateY(0) scale(.65); } }
    .collectible { pointer-events:none;opacity:0; }
    .collectible[data-collected="true"] { display:none; }
    .bubble-body { fill:#fff9e8;stroke:#b89758;stroke-width:1; }
    .bubble-wash { fill:#d9b974;opacity:.16; }
    .bubble-ink { fill:none;stroke:#9d783e;stroke-width:.65;stroke-linecap:round;opacity:.65; }
    .bubble-shine { fill:none;stroke:#fffef5;stroke-width:1;stroke-linecap:round; }
    .bubble-label { fill:#896532;font:600 8px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;text-anchor:middle;dominant-baseline:central;letter-spacing:-.35px; }
    .collectible[data-kind="multiplier"] .bubble-body { fill:#eef8f0;stroke:#76a394; }
    .collectible[data-kind="multiplier"] .bubble-wash { fill:#88b7a3; }
    .collectible[data-kind="multiplier"] .bubble-ink { stroke:#638c7b; }
    .collectible[data-kind="multiplier"] .bubble-label { fill:#4e8270;font-size:9px; }
    .bubble-glow { opacity:.32;transform-box:fill-box;transform-origin:center; }
    .collectible[data-kind="multiplier"] .bubble-glow { animation:bubble-breathe 2.8s ease-in-out infinite; }
    .collectible[data-rare="true"] .bubble-body { stroke:#ad995b;stroke-width:1.2; }
    .collectible[data-rare="true"] .bubble-label { fill:#7b763f; }
    .collectible-pickup { pointer-events:none; }
    .pickup-ring { fill:none;stroke:#b79a5f;stroke-width:.8;opacity:.6; }
    .pickup-label { fill:#91723d;stroke:#fffbed;stroke-width:2.5;paint-order:stroke;font:600 10px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;text-anchor:middle; }
    .collectible-pickup[data-kind="multiplier"] .pickup-label { fill:#548673; }
    @keyframes bubble-breathe { 0%,100% { opacity:.36;transform:scale(.92); } 50% { opacity:.85;transform:scale(1.12); } }
    .fire-cursor { position:absolute;left:0;top:0;width:24px;height:24px;z-index:1;overflow:visible;pointer-events:none;display:none; }
    .fire-cursor[data-visible="true"] { display:block; }
    .toolbar { position:absolute;top:12px;left:50%;transform:translateX(-50%);width:min(342px,calc(100% - 20px));height:76px;z-index:2;padding:7px 10px;overflow:hidden;pointer-events:auto;border:1px solid rgba(63,59,46,.17);border-radius:16px;background:rgba(249,246,236,.97);color:#4d4b40;box-shadow:0 3px 14px rgba(43,39,25,.09),inset 0 1px 0 rgba(255,255,250,.9);font:11px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased;user-select:none;touch-action:none;cursor:default; }
    .toolbar[data-dragging="true"],.toolbar[data-dragging="true"] * { cursor:move; }
    .toolbar-main { display:flex;align-items:center;gap:5px;height:30px; }
    .toolbar-meta { display:flex;align-items:center;gap:12px;height:28px;margin-top:2px;padding-left:3px; }
    .status { width:18px;height:28px;flex:none;display:grid;place-items:center;color:#777264;outline-offset:0; }
    .status-icon { width:15px;height:15px; }
    .toolbar[data-state="GENERATING"] .status-icon { color:#a47556;stroke-width:2.2;transform-origin:center;animation:map-loading .85s linear infinite; }
    @keyframes map-loading { to { transform:rotate(360deg); } }
    .toolbar[data-state="SUCCESS"] .status { color:#59764d; }
    .toolbar[data-state="FAILED"] .status,.toolbar[data-state="PAUSED"] .status { color:#ad654b; }
    .actions { display:flex;align-items:center;gap:3px;margin-left:auto;flex:none; }
    button { appearance:none;position:relative;display:grid;place-items:center;flex:none;margin:0;padding:0;width:29px;height:30px;border:0;border-radius:8px;background:transparent;color:#565345;font:inherit;cursor:default;touch-action:manipulation; }
    .control-icon { display:block;width:16px;height:16px;pointer-events:none; }
    button.drag-handle { width:15px;color:#aaa28f;cursor:default; }
    button.drag-handle:hover:not(:disabled) { cursor:move; }
    .drag-handle .control-icon { width:11px;height:16px; }
    button:hover { background:#eee8da;color:#302f28; }
    button:active { background:#e7dfce; }
    button:focus-visible,.status:focus-visible { outline:1.5px solid #a47556;outline-offset:-2px; }
    button:disabled { opacity:.3;cursor:default;background:transparent; }
    .main-info { display:flex;align-items:center;flex:1;min-width:90px;height:30px; }
    .difficulty-stars { display:flex;align-items:center;gap:3px;height:24px;color:#aa8950; }
    .difficulty-star { display:block;width:15px;height:15px;fill:none;stroke:#c8bca3;stroke-width:1.4;stroke-linejoin:round; }
    .difficulty-star[data-filled="true"] { fill:#b59962;stroke:#a48752; }
    .round-xp { color:#5e654e;font:600 20px/1 ui-monospace,Consolas,monospace;font-variant-numeric:tabular-nums;letter-spacing:-.8px;white-space:nowrap; }
    .round-xp-unit { color:#91836a;font:10px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;letter-spacing:0;margin-left:4px; }
    .new-slot { position:relative;flex:none;width:29px;height:30px; }
    .new-slot button { position:absolute;inset:0; }
    .exit { color:#8c8272; }
    .exit:hover { color:#ac5f46;background:#f0e2d7; }
    .profile { min-width:0;flex:1; }
    .profile-line { display:flex;align-items:center;gap:6px;white-space:nowrap; }
    .profile-level { flex:none;color:#705b40;font:600 10px/14px ui-monospace,Consolas,monospace; }
    .profile-level[data-leveled-up="true"]::after { content:" ↑";color:#6b7c4f; }
    .profile-title { min-width:0;overflow:hidden;text-overflow:ellipsis;color:#8a7c65;font-size:10px; }
    .xp-track { height:3px;margin-top:3px;overflow:hidden;border-radius:3px;background:#e3dbc8; }
    .xp-fill { height:100%;width:0;background:#a68c5a;border-radius:3px; }
    .collection-summary { display:flex;align-items:center;gap:7px;color:#867760;font:10px/1.2 ui-monospace,Consolas,monospace;font-variant-numeric:tabular-nums;white-space:nowrap; }
    .collection-xp { color:#8c7449; }
    .collection-multiplier { color:#648676; }
    .run-hud { display:none;position:absolute;left:50%;top:5px;transform:translateX(-50%);align-items:center;gap:12px;padding:5px 10px;border:1px solid rgba(91,76,50,.1);border-radius:12px;background:rgba(249,246,236,.92);color:#786d58;font:10px/1.2 ui-monospace,Consolas,monospace;font-variant-numeric:tabular-nums;white-space:nowrap;pointer-events:none; }
    /* Preserve the footprint used by map generation while the controls fold. */
    .toolbar[data-state="DRAWING"] { background:transparent;border-color:transparent;box-shadow:none;pointer-events:none;cursor:none; }
    .toolbar[data-state="DRAWING"] .toolbar-main,.toolbar[data-state="DRAWING"] .toolbar-meta { visibility:hidden; }
    .toolbar[data-state="DRAWING"] .run-hud { display:flex; }
    .sr-only,.message,.state-label { position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;clip-path:inset(50%)!important;white-space:nowrap!important;border:0!important; }
    .generation-error { position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(400px,calc(100% - 32px));padding:14px 16px;border:1px solid rgba(151,84,57,.25);border-radius:12px;background:rgba(255,250,240,.97);color:#87573f;box-shadow:0 3px 16px rgba(43,39,25,.1);font:12px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;overflow-wrap:anywhere;pointer-events:none; }
    [hidden] { display:none!important; }
    @media(max-width:360px) { .toolbar { padding-inline:7px; } .toolbar-main { gap:3px; } .actions { gap:1px; } button,.new-slot { width:26px; } button.drag-handle { width:12px; } .status { width:16px; } .toolbar-meta { gap:8px; } }
    @media(prefers-reduced-motion:reduce) { * { animation:none!important;transition:none!important; } }
  `;

  const element = (name, attributes = {}) => {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
  };
  const flameShape = () => {
    const group = element('g', { class: 'flame-shape' });
    group.append(
      element('path', { class: 'flame-body', d: 'M0 0C-4.7-.3-5.7-3.6-3.7-6.8C-3.9-4.5-2.4-4.2-2-4.7C-.8-6.5-1.4-8.4.4-11C.4-8.1 3-7.1 3.7-4.8C5.1-1.5 2.8 0 0 0Z' }),
      element('path', { class: 'flame-inner', d: 'M0-.2C-2.4-.4-2.8-2.4-1.1-4.7C-1.2-3.1-.1-3.1.6-5.4C2.6-3 2.2-.5 0-.2Z' }),
    );
    return group;
  };
  const pointString = points => points.map(point => `${Number(point.x).toFixed(1)},${Number(point.y).toFixed(1)}`).join(' ');
  const rectangle = rect => ({
    x: rect.x ?? rect.left ?? 0,
    y: rect.y ?? rect.top ?? 0,
    width: rect.width ?? ((rect.right ?? 0) - (rect.left ?? rect.x ?? 0)),
    height: rect.height ?? ((rect.bottom ?? 0) - (rect.top ?? rect.y ?? 0)),
  });
  const iconMarkup = content => `<svg class="control-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${content}</svg>`;

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
    constructor({ onRetry, onNewPuzzle, onExit, onRegenerate, onDebug, onToolbarMove } = {}) {
      this.generationFailed = false;
      this.host = document.createElement('div');
      this.host.id = '__pagepath_overlay__';
      this.host.setAttribute('data-pagepath-root', '');
      this.host.setAttribute('data-pagepath-overlay', 'true');
      this.host.lang = P.I18n?.locale || 'zh-CN';
      // Inline !important prevents a site's div/reset selectors from moving or
      // concealing the host. Descendants are isolated from site CSS by shadow DOM.
      this.host.style.cssText = 'all:initial !important;position:fixed !important;inset:0 !important;width:100vw !important;height:100vh !important;display:block !important;margin:0 !important;padding:0 !important;border:0 !important;z-index:2147483647 !important;pointer-events:none !important;overflow:hidden !important;isolation:isolate !important;contain:layout style size !important;';
      this.shadowRoot = this.host.attachShadow({ mode: 'open' });
      this.root = this.shadowRoot;
      const style = document.createElement('style');
      style.textContent = P.OVERLAY_CSS;
      this.shadowRoot.append(style);

      this.surface = element('svg', { class: 'surface', xmlns: SVG_NS, 'aria-label': t('迷页 迷宫地图'), role: 'img' });
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
      for (const [name, color] of [['gold', '#d4b572'], ['jade', '#96c6b0']]) {
        const glow = element('radialGradient', { id: 'pagepath-bubble-' + name });
        glow.append(element('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': .75 }),
          element('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0 }));
        warningDefs.append(glow);
      }
      const fireGlow = element('radialGradient', { id: 'pagepath-fire-glow' });
      fireGlow.append(element('stop', { offset: '0%', 'stop-color': '#ffd383', 'stop-opacity': .55 }),
        element('stop', { offset: '45%', 'stop-color': '#eeb166', 'stop-opacity': .18 }),
        element('stop', { offset: '100%', 'stop-color': '#eeb166', 'stop-opacity': 0 }));
      const flame = element('linearGradient', { id: 'pagepath-flame', x1: '0%', y1: '100%', x2: '0%', y2: '0%' });
      flame.append(element('stop', { offset: '0%', 'stop-color': '#e8a153' }),
        element('stop', { offset: '55%', 'stop-color': '#f4bf67' }),
        element('stop', { offset: '100%', 'stop-color': '#ffe2a0' }));
      warningDefs.append(fireGlow, flame);
      this.obstacleFlash = element('use', { class: 'obstacle-flash visual-layer', href: '#pagepath-obstacles',
        stroke: '#e33128', 'stroke-width': 2, opacity: 0, 'aria-hidden': 'true' });
      this.flashAnimation = null;
      this.obstacleWarning = element('path', { class: 'obstacle-warning visual-layer',
        fill: 'none', stroke: 'url(#pagepath-warning)', 'stroke-width': 1.8, 'aria-hidden': 'true' });
      this.pathLayer = element('g', { class: 'visual-layer', 'aria-hidden': 'true' });
      this.pathOutline = element('polyline', { class: 'path-outline' });
      this.path = element('polyline', { class: 'path' });
      this.inkStroke = element('g', { class: 'ember-trail' });
      this.pathLayer.append(this.pathOutline, this.path, this.inkStroke);
      this.collectibleLayer = element('g', { class: 'visual-layer collectibles', 'aria-hidden': 'true' });
      this.pickupLayer = element('g', { class: 'visual-layer pickups', 'aria-hidden': 'true' });
      this.collectibleElements = new Map();
      this.pickupAnimations = new Map();
      this.collectedIds = new Set();
      this.collection = { xp: 0, multiplier: 1 };
      this.nodeLayer = element('g', { class: 'visual-layer', 'aria-hidden': 'true' });
      this.surface.append(warningDefs, this.mazeFloorLayer, this.mazeWallLayer, this.debugLayer, this.obstacleFlash,
        this.obstacleWarning, this.collectibleLayer, this.pathLayer, this.nodeLayer, this.pickupLayer);
      this.shadowRoot.append(this.surface);
      this.brushCursor = element('svg', {
        class: 'fire-cursor', viewBox: '-12 -12 24 24', width: 24, height: 24,
        'aria-hidden': 'true', 'data-visible': 'false',
      });
      // The fixed ember at the flame's base is the pointer hotspot. Only the
      // decorative flame above it flickers; collision coordinates never move.
      this.brushCursor.append(
        element('circle', { class: 'fire-halo', cx: 0, cy: -3, r: 9, fill: 'url(#pagepath-fire-glow)' }),
        flameShape(),
        element('circle', { class: 'flame-core', cx: 0, cy: 0, r: P.Config.PLAYER_RADIUS }),
      );
      this.shadowRoot.append(this.brushCursor);

      this.toolbar = document.createElement('section');
      this.toolbar.className = 'toolbar';
      this.toolbar.setAttribute('aria-label', t('迷页 游戏控制'));
      // All markup is extension-owned constant text; page content is never HTML.
      this.toolbar.innerHTML = `
        <div class="toolbar-main">
          <button class="drag-handle" type="button" aria-label="${html('移动悬浮栏')}" title="${html('拖动悬浮栏 · 方向键微调')}">${iconMarkup('<path d="M8 5h.1M16 5h.1M8 12h.1M16 12h.1M8 19h.1M16 19h.1" stroke-width="3"/>')}</button>
          <span class="status" tabindex="0" role="img" aria-label="${html('正在准备')}">
            <svg class="status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path/></svg>
            <span class="state-label">${html('准备中')}</span>
          </span>
          <div class="main-info">
            <span class="star-rating difficulty-stars" role="img" aria-label="${html('正在生成星级')}" title="${html('本局难度')}"></span>
            <span class="round-xp" aria-label="${html('本局经验')}" hidden><span class="xp-value">+0</span><span class="round-xp-unit">${html('经验')}</span></span>
          </div>
          <div class="actions">
            <button class="retry" type="button" aria-label="${html('重试')}" title="${html('重试当前迷宫')}">${iconMarkup(icons.retry)}</button>
            <span class="new-slot">
              <button class="new-puzzle" type="button" aria-label="${html('新地图')}" title="${html('生成新迷宫')}">${iconMarkup(icons.newPuzzle)}</button>
              <button class="regenerate" type="button" aria-label="${html('重新生成')}" title="${html('重新截取页面并生成迷宫')}" hidden>${iconMarkup(icons.regenerate)}</button>
            </span>
            <button class="exit" type="button" aria-label="${html('退出游戏')}" title="${html('退出游戏 · 右键 / Esc')}">${iconMarkup(icons.exit)}</button>
          </div>
        </div>
        <div class="toolbar-meta">
          <div class="profile" title="${html('等级经验')}">
            <div class="profile-line"><span class="profile-level">Lv.1</span><span class="profile-title">${html('萌新')}</span></div>
            <div class="xp-track" role="progressbar" aria-label="${html('等级经验')}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="xp-fill"></div></div>
          </div>
          <div class="collection-summary" hidden><span class="collection-xp">+0 XP</span><span class="collection-multiplier">×1</span></div>
        </div>
        <div class="run-hud" aria-hidden="true"><span class="collection-xp">+0 XP</span><span class="collection-multiplier">×1</span></div>
        <span class="message" role="status" aria-live="polite" aria-atomic="true"></span>`;
      this.shadowRoot.append(this.toolbar);
      this.starRating = this.toolbar.querySelector('.difficulty-stars');
      this.starIcons = Array.from({ length: 5 }, () => {
        const star = element('svg', { class: 'difficulty-star', viewBox: '0 0 24 24', 'aria-hidden': 'true', 'data-filled': 'false' });
        star.append(element('path', { d: 'M12 2.5L14.9 8.5L21.5 9.4L16.8 14L17.9 20.6L12 17.5L6.1 20.6L7.2 14L2.5 9.4L9.1 8.5Z' }));
        this.starRating.append(star); return star;
      });
      this.roundXp = this.toolbar.querySelector('.round-xp');
      this.generationError = document.createElement('div');
      this.generationError.className = 'generation-error';
      this.generationError.setAttribute('aria-hidden', 'true');
      this.generationError.hidden = true;
      this.shadowRoot.append(this.generationError);
      this.toolbarMain = this.toolbar.querySelector('.toolbar-main');
      this.toolbarMeta = this.toolbar.querySelector('.toolbar-meta');
      this.retryButton = this.toolbar.querySelector('.retry');
      this.newPuzzleButton = this.toolbar.querySelector('.new-puzzle');
      this.regenerateButton = this.toolbar.querySelector('.regenerate');
      this.exitButton = this.toolbar.querySelector('.exit');
      this.message = this.toolbar.querySelector('.message');
      this.stateLabel = this.toolbar.querySelector('.state-label');
      this.status = this.toolbar.querySelector('.status');
      this.statusPath = this.toolbar.querySelector('.status-icon path');
      this.dragHandle = this.toolbar.querySelector('.drag-handle');
      this.onToolbarMove = onToolbarMove;
      this.toolbarPosition = null;
      this.toolbarDrag = null;
      this.listeners = [];
      this.bind(this.retryButton, 'click', () => {
        if (this.retryButton.disabled) return;
        if (this.generationFailed) (onRegenerate || onNewPuzzle)?.();
        else onRetry?.();
      });
      this.bind(this.newPuzzleButton, 'click', onNewPuzzle);
      this.bind(this.regenerateButton, 'click', onRegenerate || onNewPuzzle);
      this.bind(this.exitButton, 'click', onExit);
      if (onDebug) {
        this.debugButton = document.createElement('button');
        this.debugButton.className = 'debug-button';
        this.debugButton.type = 'button';
        this.debugButton.innerHTML = iconMarkup(icons.debug);
        this.debugButton.setAttribute('aria-label', t('地图分析视图'));
        this.debugButton.title = t('切换地图分析视图');
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
      this.update({ state: 'GENERATING', message: '正在生成迷宫…' });
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

    positionToolbar(x, y) {
      const bounds = this.toolbar.getBoundingClientRect();
      const margin = 6;
      const left = Math.max(margin, Math.min(window.innerWidth - bounds.width - margin, x));
      const top = Math.max(margin, Math.min(window.innerHeight - bounds.height - margin, y));
      this.toolbarPosition = { x: left, y: top };
      this.toolbar.style.left = `${left}px`;
      this.toolbar.style.top = `${top}px`;
      this.toolbar.style.transform = 'none';
    }

    clampToolbar() {
      if (this.toolbarPosition) this.positionToolbar(this.toolbarPosition.x, this.toolbarPosition.y);
    }

    keepEndpointsVisible(previousRect) {
      const nodes = this.level?.nodes;
      if (!nodes?.length) return;
      const endpoints = [nodes[0], nodes.at(-1)];
      const current = rectangle(this.toolbar.getBoundingClientRect());
      const radius = Math.max(14, (P.Config.HIT_RADIUS || 12) + 4), margin = 6;
      const safe = rect => endpoints.every(node =>
        node.x + radius < rect.x || node.x - radius > rect.x + current.width ||
        node.y + radius < rect.y || node.y - radius > rect.y + current.height);
      if (safe(current)) return;
      const clamp = rect => ({
        x: Math.max(margin, Math.min(window.innerWidth - current.width - margin, rect.x)),
        y: Math.max(margin, Math.min(window.innerHeight - current.height - margin, rect.y)),
      });
      // Restore the last usable spot when a drop would hide an endpoint. If a
      // resize made it unusable too, choose the nearest safe viewport corner.
      const previous = previousRect && clamp(previousRect);
      if (previous && safe(previous)) { this.positionToolbar(previous.x, previous.y); return; }
      const candidates = [
        { x: margin, y: margin }, { x: window.innerWidth - current.width - margin, y: margin },
        { x: margin, y: window.innerHeight - current.height - margin },
        { x: window.innerWidth - current.width - margin, y: window.innerHeight - current.height - margin },
      ].map(clamp).filter(safe).sort((a, b) =>
        Math.hypot(a.x - current.x, a.y - current.y) - Math.hypot(b.x - current.x, b.y - current.y));
      if (candidates.length) this.positionToolbar(candidates[0].x, candidates[0].y);
    }

    startToolbarDrag(event) {
      if (event.button !== 0 || event.isPrimary === false || this.toolbarDrag ||
          ['DRAWING', 'GENERATING', 'DESTROYED'].includes(this.state)) return;
      const control = event.target.closest?.('button,select,input,textarea');
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
      if (notify) {
        this.keepEndpointsVisible(drag.previousRect);
        this.onToolbarMove?.({ rect: rectangle(this.toolbar.getBoundingClientRect()), previousRect: drag.previousRect });
      }
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
      this.keepEndpointsVisible(previousRect);
      this.onToolbarMove?.({ rect: rectangle(this.toolbar.getBoundingClientRect()), previousRect });
    }

    hideBrush() {
      this.brushCursor.setAttribute('data-visible', 'false');
      this.lastBrushPoint = null;
      this.lastPointerPoint = null;
      this.renderCollectibleProximity(null);
      cancelAnimationFrame(this.warningFrame);
      this.warningFrame = 0;
      this.obstacleWarning.setAttribute('d', '');
    }

    setMap(map) {
      this.cancelObstacleFlash();
      this.pixelMap = map?.kind === 'pixel-mask' ? map : null;
      this.collectibleIndex = this.pixelMap ? P.Collision.createMaskIndex(this.pixelMap) : null;
      this.visibleContours = this.pixelMap
        ? P.Collision.reachableContours(this.pixelMap, this.level?.nodes?.[0]) : null;
      if (this.visibleContours && this.level?.maze) {
        const parts = splitMazeContours(this.visibleContours, this.pixelMap, this.level.mazeSourceAnalysis);
        this.sourceContours = parts.original;
        this.mazeContours = parts.added;
      } else {
        this.sourceContours = this.visibleContours;
        this.mazeContours = null;
      }
      this.obstacleWarning.setAttribute('d', '');
      // The one-shot new-map flash uses original page content only. Added maze
      // walls stay hidden until approached.
      const segments = this.sourceContours?.segments || [], lines = [];
      for (let i = 0; i < segments.length; i += 4) {
        lines.push(`M${segments[i]},${segments[i + 1]}L${segments[i + 2]},${segments[i + 3]}`);
      }
      this.obstacleShape.setAttribute('d', lines.join(''));
      this.renderCollectibleProximity(this.lastPointerPoint);
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
      const x = event.clientX, y = event.clientY;
      const drawing = this.state === 'DRAWING';
      const toolbar = this.toolbar.getBoundingClientRect();
      if (this.captureHidden || this.generationFailed || !['READY', 'DRAWING'].includes(this.state) ||
          event.pointerType === 'touch' || !Number.isFinite(x) || !Number.isFinite(y) ||
          x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight ||
          (!drawing && x >= toolbar.left && x <= toolbar.right && y >= toolbar.top && y <= toolbar.bottom)) {
        this.hideBrush(); return;
      }
      this.lastPointerPoint = { x, y };
      this.renderCollectibleProximity(this.lastPointerPoint);
      if (!drawing) {
        this.brushCursor.setAttribute('data-visible', 'false');
        this.lastBrushPoint = null;
        cancelAnimationFrame(this.warningFrame); this.warningFrame = 0;
        this.obstacleWarning.setAttribute('d', '');
        return;
      }
      this.lastBrushPoint = { x, y };
      this.brushCursor.style.transform = 'translate(' + (x - 12) + 'px, ' + (y - 12) + 'px)';
      this.brushCursor.setAttribute('data-visible', 'true');
      if (!this.warningFrame) this.warningFrame = requestAnimationFrame(() => {
        this.warningFrame = 0;
        this.renderProximity(this.lastBrushPoint);
      });
    }

    renderCollectibles(collectibles = []) {
      this.clearPickupFeedback();
      this.collectibleLayer.replaceChildren();
      this.collectibleElements.clear();
      this.collectedIds = new Set();
      const rules = P.Config.COLLECTIBLES;
      for (const item of collectibles) {
        if (!item || !Number.isFinite(item.x) || !Number.isFinite(item.y) ||
            !['xp', 'multiplier'].includes(item.kind) || !Number.isFinite(item.value) || item.value <= 0) continue;
        const id = String(item.id), radius = Math.max(1, Math.min(14, Number(item.radius) || rules.radius));
        const rare = item.kind === 'multiplier' && item.value === rules.maxMultiplier;
        const group = element('g', { class: 'collectible', transform: 'translate(' + item.x + ' ' + item.y + ')',
          'data-collectible-id': id, 'data-kind': item.kind, 'data-value': item.value,
          'data-rare': rare, 'data-collected': false, 'data-visible': false });
        const face = element('g', { transform: 'scale(' + radius / 10 + ')' });
        const label = item.kind === 'xp' ? '+' + item.value : '×' + item.value;
        face.append(
          element('circle', { class: 'bubble-glow', r: item.kind === 'multiplier' ? Math.max(rare ? 22 : 17, 80 / radius) : 17,
            fill: 'url(#pagepath-bubble-' + (rare || item.kind === 'xp' ? 'gold' : 'jade') + ')' }),
          element('path', { class: 'bubble-body', d: 'M-1-9.7Q6.6-10.2 9.2-3.3Q11 3.9 5.3 8.1Q-1.2 12-7.2 6.8Q-11.1 1.9-8-5Q-5.7-9.3-1-9.7Z' }),
          element('path', { class: 'bubble-wash', d: 'M-8 1Q-3 7 7.7 3Q5.8 10-1.7 9Q-7 8-8 1Z' }),
          element('path', { class: 'bubble-ink', d: 'M6.9-6.6Q10-3.2 9.1.1M-7 6.5Q-3.7 9.6.5 9.3' }),
          element('path', { class: 'bubble-shine', d: 'M-6.5-5Q-4.4-8-1.8-8.1' }),
        );
        const text = element('text', { class: 'bubble-label', x: 0, y: .2 });
        // A narrow passage may require a tiny collision body. Keep its reward
        // readable and its beacon visible without enlarging that body.
        if (item.kind === 'multiplier' && radius < 10) text.style.fontSize = 90 / radius + 'px';
        text.textContent = label; face.append(text); group.append(face);
        this.collectibleLayer.append(group);
        this.collectibleElements.set(id, { item, node: group, label });
      }
      this.updateCollectibles();
    }

    renderCollectibleProximity(point) {
      const rules = P.Config.COLLECTIBLES;
      const canPreview = !this.captureHidden && !this.generationFailed && ['READY', 'DRAWING'].includes(this.state);
      const showMultiplier = !this.captureHidden && !['GENERATING', 'DESTROYED'].includes(this.state);
      for (const [id, { item, node }] of this.collectibleElements) {
        let opacity = 0;
        if (!this.collectedIds.has(id)) {
          if (item.kind === 'multiplier' && showMultiplier) opacity = 1;
          else if (canPreview && point) {
            const distance = Math.hypot(point.x - item.x, point.y - item.y);
            // Read exactly the player's final collision map. Even a thin added
            // wall hides nearby ordinary bubbles on its other side.
            if (distance < rules.revealDistance && (!this.collectibleIndex ||
                !P.Collision.segmentHits(point, item, this.collectibleIndex))) {
              opacity = Math.pow(1 - distance / rules.revealDistance, .7);
            }
          }
        }
        node.style.opacity = String(opacity);
        node.dataset.visible = String(opacity > 0);
      }
    }

    updateCollectibles(collectedIds = [], collection = { xp: 0, multiplier: 1 }) {
      const next = new Set(Array.from(collectedIds, String));
      if ([...this.collectedIds].some(id => !next.has(id))) this.clearPickupFeedback();
      for (const [id, entry] of this.collectibleElements) {
        if (next.has(id) && !this.collectedIds.has(id) && this.state === 'DRAWING') this.showPickupFeedback(entry);
        entry.node.dataset.collected = String(next.has(id));
      }
      this.collectedIds = next;
      this.collection = { xp: Math.max(0, Math.round(Number(collection.xp) || 0)),
        multiplier: Math.max(1, Number(collection.multiplier) || 1) };
      for (const node of this.toolbar.querySelectorAll('.collection-xp')) node.textContent = t('+{xp} XP', { xp: number(this.collection.xp) });
      for (const node of this.toolbar.querySelectorAll('.collection-multiplier')) node.textContent = '×' + number(this.collection.multiplier);
      this.toolbar.querySelector('.run-hud').setAttribute('aria-label', t('已收集 {xp} 经验 · {multiplier} 倍', {
        xp: number(this.collection.xp), multiplier: number(this.collection.multiplier),
      }));
      this.updateCollectionSummary();
      this.renderCollectibleProximity(this.lastPointerPoint);
    }

    updateCollectionSummary() {
      const completed = this.result && ['SUCCESS', 'PAUSED'].includes(this.state);
      this.toolbar.querySelector('.collection-summary').hidden = Boolean(completed ||
        !this.collection.xp && this.collection.multiplier === 1);
    }

    showPickupFeedback({ item, label }) {
      const group = element('g', { class: 'collectible-pickup', 'data-kind': item.kind,
        transform: 'translate(' + item.x + ' ' + item.y + ')' });
      const contents = element('g');
      const text = element('text', { class: 'pickup-label', y: -3 }); text.textContent = label;
      contents.append(element('circle', { class: 'pickup-ring', r: 12 }), text); group.append(contents);
      this.pickupLayer.append(group);
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const frames = reduced ? [{ opacity: .8 }, { opacity: 0 }]
        : [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-15px)' }];
      const animation = contents.animate(frames, { duration: reduced ? 180 : 560, easing: 'ease-out' });
      this.pickupAnimations.set(animation, group);
      animation.onfinish = () => { group.remove(); this.pickupAnimations.delete(animation); };
    }

    clearPickupFeedback() {
      for (const [animation, node] of this.pickupAnimations) {
        animation.onfinish = null; animation.cancel(); node.remove();
      }
      this.pickupAnimations.clear();
    }

    setCaptureHidden(hidden) {
      this.captureHidden = Boolean(hidden);
      this.hideBrush();
      if (hidden) this.cancelObstacleFlash();
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
      // Openings and added walls only change the collision map. Keep both
      // material layers empty so even carved routes preserve the page pixels;
      // nearby boundaries are revealed by renderProximity instead.
      if (!level) this.setMap(null);
      this.update({ difficulty: level?.difficulty ?? 0, stars: level?.stars, result: null });
      this.renderCollectibles(level?.collectibles || []);
      this.resize();
      this.nodeLayer.replaceChildren();
      this.nodeElements.clear();
      this.renderPath([]);
      if (!level?.nodes?.length) return;
      level.nodes.forEach((node, index) => {
        const kind = index === 0 ? 'start' : 'finish';
        const group = element('g', {
          class: `node ${kind === 'start' ? 'campfire' : 'exit-cave'}`,
          transform: `translate(${node.x} ${node.y})`,
          'data-node-id': node.id ?? index, 'data-collected': Boolean(node.collected),
        });
        if (kind === 'start') {
          group.append(
            element('path', { class: 'camp-log-underlay', d: 'M-7.5 5L7.5 9M-7.5 9L7.5 5' }),
            element('path', { class: 'camp-log', d: 'M-7.5 5L7.5 9M-7.5 9L7.5 5' }),
            element('path', { class: 'camp-log-grain', d: 'M-5.5 5.2L-1 6.4M2.5 6.3L6.5 5.2' }),
          );
          const fire = element('g', { class: 'camp-flame', transform: 'translate(0 3)' });
          const body = element('g', { transform: 'scale(1.15)' });
          body.append(flameShape());
          fire.append(element('circle', { cy: -3, r: 11, fill: 'url(#pagepath-fire-glow)' }), body);
          group.append(fire);
        } else if (kind === 'finish' || kind === 'end') {
          const frame = element('g', { class: 'cave-frame' });
          frame.append(element('path', { class: 'cave-rock', d: 'M-10 8L-9-1L-5.5-8L.5-10L6-7L9-1L10 8Z' }),
            element('path', { class: 'cave-facet', d: 'M-9-1L-5.5-8L.5-10L-1-5L-5-2L-6 7L-10 8Z' }),
            element('path', { class: 'cave-mouth', d: 'M-5.8 7L-5.3 0Q-4.4-5 .4-5.3Q5-5 5.5 0L6 7Z' }),
            element('path', { class: 'cave-crack', d: 'M.5-10L2-7M6-6L7-2L9 0M-9 3L-7 4' }));
          const arrival = element('g', { class: 'cave-arrival' });
          arrival.append(element('ellipse', { cy: 1, rx: 5, ry: 6, fill: 'url(#pagepath-fire-glow)' }),
            element('path', { d: 'M0 4C-3 4-3.5 1-1.5-1C-1 0 0-1 .2-3C3.5 0 3 3.8 0 4Z', fill: '#ffd58b' }));
          group.append(frame, arrival);
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
      const tailLength = this.level?.trailLength ?? P.Config.TRAIL_LENGTH ?? 30;
      const tail = P.Trail.clip(points, tailLength);
      const coordinates = pointString(tail);
      this.path.setAttribute('points', coordinates);
      this.pathOutline.setAttribute('points', coordinates);
      if (!this.inkStroke) return;
      this.inkStroke.replaceChildren();
      if (tail.length < 2) return;
      // Sample the same short ember trail by distance for both slow and fast
      // movement. The fixed ember at the flame's base is the collision cue.
      const lengths = tail.slice(1).map((point, i) => Math.hypot(point.x - tail[i].x, point.y - tail[i].y));
      const length = lengths.reduce((sum, value) => sum + value, 0);
      if (!length) return;
      const count = Math.max(2, Math.ceil(length / 2));
      const samples = [];
      let segment = 0, before = 0;
      for (let i = 0; i <= count; i++) {
        const distance = length * i / count;
        while (segment < lengths.length - 1 && before + lengths[segment] < distance) before += lengths[segment++];
        const ratio = lengths[segment] ? (distance - before) / lengths[segment] : 0;
        samples.push({ x: tail[segment].x + (tail[segment + 1].x - tail[segment].x) * ratio,
          y: tail[segment].y + (tail[segment + 1].y - tail[segment].y) * ratio });
      }
      for (let i = 1; i <= count; i++) {
        const points = pointString([samples[i - 1], samples[i]]), strength = (i / count) ** 1.5;
        this.inkStroke.append(
          element('polyline', { class: 'ember-trail-glow', points, opacity: (.13 * strength).toFixed(3) }),
          element('polyline', { class: 'ember-trail-thread', points, opacity: (.48 * strength).toFixed(3) }));
      }
      if (length > 8) for (const fraction of [.28, .55, .78]) {
        const sample = samples[Math.round(count * fraction)];
        this.inkStroke.append(element('circle', { class: 'ember-trail-spark', cx: sample.x, cy: sample.y,
          r: .35 + fraction * .3, opacity: .25 + fraction * .4 }));
      }
    }

    update({ state, message, difficulty, stars, profile, result, generationFailed } = {}) {
      if (generationFailed !== undefined) this.generationFailed = Boolean(generationFailed);
      if (difficulty !== undefined) this.difficulty = Number.isFinite(difficulty) ? Math.max(0, Math.min(100, difficulty)) : 0;
      if (stars !== undefined || difficulty !== undefined || !this.stars) {
        const rating = Number.isFinite(stars) ? stars : P.Difficulty.stars(this.difficulty || 0);
        this.stars = Math.max(1, Math.min(5, Math.round(rating)));
      }
      if (profile) {
        this.profile = profile;
        const level = Math.max(1, Math.floor(profile.level || 1));
        const current = Math.max(0, Math.round(profile.currentXp ?? profile.xpIntoLevel ?? 0));
        const required = Math.max(1, Math.round(profile.nextLevelXp ?? profile.xpForNextLevel ?? 1));
        const maxLevel = Boolean(profile.maxLevel);
        const percent = maxLevel ? 100 : Math.max(0, Math.min(100, Number.isFinite(profile.progress) ? profile.progress * 100 : current / required * 100));
        const title = P.I18n?.title(level) || profile.title || t('萌新');
        const progressLabel = maxLevel ? t('已满级') : t('{current} / {required} XP', {
          current: number(current), required: number(required),
        });
        this.toolbar.querySelector('.profile-level').textContent = 'Lv.' + level;
        this.toolbar.querySelector('.profile-title').textContent = title;
        this.toolbar.querySelector('.profile-title').title = title;
        this.toolbar.querySelector('.profile').title = 'Lv.' + level + ' · ' + title + ' · ' + progressLabel;
        this.toolbar.querySelector('.xp-fill').style.width = percent + '%';
        this.toolbar.querySelector('.xp-track').setAttribute('aria-valuenow', String(Math.round(percent)));
        this.toolbar.querySelector('.xp-track').setAttribute('aria-valuetext', progressLabel);
      }
      if (result !== undefined) this.result = result;
      if (state) {
        this.state = state;
        if (['PAUSED', 'GENERATING', 'DESTROYED'].includes(state)) this.cancelObstacleFlash();
        this.toolbar.dataset.state = state;
        this.toolbarMain.inert = state === 'DRAWING';
        this.toolbarMeta.inert = state === 'DRAWING';
        this.surface.dataset.state = state;
        this.stateLabel.textContent = t({
          IDLE: '待开始', GENERATING: '生成中', READY: '待开始', DRAWING: '探索中',
          FAILED: this.generationFailed ? '正在恢复地图' : '再试一次', SUCCESS: '已完成', PAUSED: '已暂停', DESTROYED: '已退出',
        }[state] || state);
        this.statusPath.setAttribute('d', {
          IDLE: 'M8 5Q4 6 4 12Q4 19 12 19Q20 19 20 12Q20 4 12 4Q10 4 8 5ZM8 9Q12 6 16 9',
          READY: 'M8 5Q4 6 4 12Q4 19 12 19Q20 19 20 12Q20 4 12 4Q10 4 8 5ZM8 9Q12 6 16 9',
          GENERATING: 'M12 4A8 8 0 1 1 4 12',
          DRAWING: 'M12 3C13 8 18 9 18 14A6 6 0 0 1 6 14Q6 11 9 9Q8 12 10 12Q13 10 12 3ZM12 13Q8 18 12 19Q16 18 12 13Z',
          SUCCESS: 'M5 12L10 17L20 6', FAILED: 'M7 7L17 17M17 7L7 17',
          PAUSED: 'M9 6V18M15 6V18', DESTROYED: 'M7 7L17 17M17 7L7 17',
        }[state] || '');
        if (this.generationFailed || state !== 'DRAWING') this.hideBrush();
      }
      const busy = this.state === 'GENERATING';
      this.toolbar.setAttribute('aria-busy', String(busy));
      const drawing = this.state === 'DRAWING';
      const paused = this.state === 'PAUSED';
      const destroyed = this.state === 'DESTROYED';
      this.dragHandle.disabled = busy || drawing || destroyed;
      if (this.dragHandle.disabled) this.endToolbarDrag();
      this.retryButton.disabled = busy || drawing || paused || destroyed || (!this.level && !this.generationFailed);
      const retryLabel = t(this.generationFailed ? '刷新地图' : '重试');
      this.retryButton.setAttribute('aria-label', retryLabel);
      this.retryButton.title = t(this.generationFailed ? '重新截取页面并生成迷宫' : '重试当前迷宫');
      if (this.retryButton.dataset.refresh !== String(this.generationFailed)) {
        this.retryButton.innerHTML = iconMarkup(this.generationFailed ? icons.regenerate : icons.retry);
        this.retryButton.dataset.refresh = String(this.generationFailed);
      }
      this.newPuzzleButton.disabled = busy || drawing || destroyed;
      this.newPuzzleButton.hidden = paused;
      this.regenerateButton.hidden = !paused;
      this.regenerateButton.disabled = busy || drawing || destroyed;
      // Stars and earned experience share one fixed toolbar slot. A paused
      // completed map retains its award without exposing storage bookkeeping.
      const completed = Boolean(this.result && ['SUCCESS', 'PAUSED'].includes(this.state));
      const generating = this.state === 'GENERATING' && !this.level;
      this.starRating.hidden = completed;
      this.starRating.dataset.stars = String(generating ? 0 : this.stars);
      this.roundXp.hidden = !completed;
      this.starRating.setAttribute('aria-label', generating ? t('正在生成星级') : t('本局难度 {stars} 星', { stars: number(this.stars) }));
      this.starRating.title = generating ? t('正在生成星级') : t('{stars} 星', { stars: number(this.stars) });
      for (let index = 0; index < this.starIcons.length; index++) this.starIcons[index].dataset.filled = String(!generating && index < this.stars);
      this.toolbar.querySelector('.profile-level').dataset.leveledUp = String(completed && Boolean(this.result?.leveledUp));
      if (completed) {
        const result = this.result, xp = Math.max(0, Math.round(Number(result.xp) || 0));
        const amount = '+' + number(xp);
        this.roundXp.querySelector('.xp-value').textContent = amount;
        this.roundXp.setAttribute('aria-label', t('本局获得 {amount} 经验', { amount }));
        const details = [t('{stars} 星', { stars: number(this.stars) })];
        if (!xp) details.unshift(t('本图已结算'));
        if (result.leveledUp) {
          const title = P.I18n?.title(result.level) || this.profile?.title;
          details.push(t('升级 Lv.{previous} → Lv.{level}', { previous: result.previousLevel, level: result.level }) +
            (title ? ' · ' + title : ''));
        }
        this.roundXp.title = details.join(' · ');
      }
      if (message !== undefined || state) {
        const defaults = {
          GENERATING: '正在生成迷宫…',
          READY: '单击小火堆开始，引导火苗穿过迷宫，到达洞口。',
          DRAWING: '移动小火苗，避开墙壁，找到洞口。',
          FAILED: this.generationFailed ? '地图暂未准备好，请重新截取页面。' : '碰到障碍了，再次单击小火堆开始。',
          SUCCESS: '已走出迷宫。', PAUSED: '页面尺寸变化，请重新生成迷宫。',
        };
        const text = message ?? defaults[this.state] ?? '';
        this.message.textContent = P.I18n?.error(text) ?? t(text);
        this.message.title = this.message.textContent;
      }
      this.updateCollectionSummary();
      this.renderCollectibleProximity(this.lastPointerPoint);
      this.surface.dataset.generationFailed = String(this.generationFailed);
      this.generationError.hidden = !this.generationFailed || !['FAILED', 'PAUSED'].includes(this.state);
      this.generationError.textContent = this.generationError.hidden ? '' : this.message.textContent;
      this.status.title = this.stateLabel.textContent + ' · ' + this.message.textContent;
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
      const reference = level?.referencePath || level?.referenceRoute || [];
      if (reference.length) this.debugLayer.append(element('polyline', {
        points: pointString(reference), fill: 'none', stroke: '#7470cb',
        'stroke-width': 1.5, 'stroke-dasharray': '4 4', opacity: .75,
      }));
    }

    destroy() {
      this.endToolbarDrag(null, false);
      this.hideBrush();
      this.setMap(null);
      for (const remove of this.listeners.splice(0)) remove();
      this.clearSnapshot();
      this.host.remove();
      this.nodeElements.clear();
      this.clearPickupFeedback();
      this.collectibleElements.clear();
      this.collectibleLayer.replaceChildren();
      this.mazeWallLayer.replaceChildren();
      this.mazeFloorLayer.replaceChildren();
      this.level = null;
      this.pixelMap = null;
      this.state = 'DESTROYED';
    }
  };
})();
