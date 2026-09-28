(() => {
  "use strict";

  const P = globalThis.__PAGEPATH__ ||= {};
  const ATOMIC = new Set(["BUTTON", "INPUT", "TEXTAREA", "SELECT", "IMG", "VIDEO", "IFRAME", "CANVAS", "SVG", "OBJECT", "EMBED", "METER", "PROGRESS"]);
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK", "HEAD"]);
  const LIMITS = Object.freeze({ elements: 18000, rectangles: 12000, duration: 700, opacity: 0.025 });
  const clock = () => performance.now();
  const rounded = value => Math.round(value * 2) / 2;
  const boxKey = box => [box.x, box.y, box.width, box.height].map(rounded).join(",");
  const colorVisible = value => value && value !== "transparent" && !/rgba?\([^)]*[,/]\s*0(?:\.0+)?\s*\)$/.test(value);

  function intersection(rect, clip) {
    const left = Math.max(rect.x ?? rect.left, clip.x);
    const top = Math.max(rect.y ?? rect.top, clip.y);
    const right = Math.min((rect.x ?? rect.left) + rect.width, clip.x + clip.width);
    const bottom = Math.min((rect.y ?? rect.top) + rect.height, clip.y + clip.height);
    return right - left > 0.5 && bottom - top > 0.5
      ? { x: left, y: top, width: right - left, height: bottom - top } : null;
  }

  function hasPaint(style) {
    return colorVisible(style.backgroundColor) || style.backgroundImage !== "none" ||
      style.boxShadow !== "none" || ["Top", "Right", "Bottom", "Left"].some(side =>
        parseFloat(style[`border${side}Width`]) > 0 && style[`border${side}Style`] !== "none" && colorVisible(style[`border${side}Color`]));
  }

  function styleKey(style) {
    return [style.display, style.visibility, style.opacity, style.contentVisibility,
      style.position, style.overflowX, style.overflowY, style.transform,
      style.backgroundColor, style.backgroundImage, style.boxShadow,
      style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth,
      style.clipPath, style.fontSize, style.lineHeight, style.fontFamily, style.letterSpacing].join("|");
  }

  function directTextRects(element, viewport, range, output = []) {
    for (const node of element.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.nodeValue.trim()) continue;
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        const clipped = intersection(rect, viewport);
        if (clipped) output.push(clipped);
      }
    }
    return output;
  }

  // Used only during generation, the low-frequency watchdog, and dirty-subtree checks.
  // Text snapshots track line geometry, not text content: an equal-width clock tick is harmless.
  function snapshot(element, viewport, range) {
    if (!element.isConnected) return null;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    let opacity = Number(style.opacity);
    for (let parent = element.parentElement || element.getRootNode()?.host; parent && opacity >= LIMITS.opacity;
      parent = parent.parentElement || parent.getRootNode()?.host) opacity *= Number(getComputedStyle(parent).opacity);
    const visible = style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" &&
      style.contentVisibility !== "hidden" && opacity >= LIMITS.opacity && Boolean(intersection(box, viewport));
    const textRects = visible ? directTextRects(element, viewport, range) : [];
    if (visible && element.shadowRoot) directTextRects(element.shadowRoot, viewport, range, textRects);
    const text = textRects.map(boxKey).join(";");
    return { box: boxKey(box), paint: styleKey(style), text, visible };
  }

  function equivalent(previous, next) {
    if (!previous || !next) return previous === next;
    if (!previous.visible && !next.visible) return true;
    return previous.visible === next.visible && previous.box === next.box && previous.paint === next.paint && previous.text === next.text;
  }

  function simplify(rectangles) {
    // Merge only collinear boxes. An arbitrary union bounding box would incorrectly erase corridors.
    const rows = new Map();
    for (const rect of rectangles) {
      const key = `${rounded(rect.y)}:${rounded(rect.y + rect.height)}`;
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(rect);
    }
    const merged = [];
    for (const row of rows.values()) {
      row.sort((a, b) => a.x - b.x);
      let current = null;
      for (const rect of row) {
        if (current && rect.x <= current.x + current.width + 0.25) {
          const right = Math.max(current.x + current.width, rect.x + rect.width);
          const bottom = Math.max(current.y + current.height, rect.y + rect.height);
          current.y = Math.min(current.y, rect.y);
          current.height = bottom - current.y;
          current.width = right - current.x;
        } else {
          current = { ...rect };
          merged.push(current);
        }
      }
    }
    // Large boxes are indexed first, allowing contained text/card boxes to be removed cheaply.
    merged.sort((a, b) => b.width * b.height - a.width * a.height);
    const cells = new Map();
    const result = [];
    for (const rect of merged) {
      const cx = Math.floor((rect.x + rect.width / 2) / 64);
      const cy = Math.floor((rect.y + rect.height / 2) / 64);
      const possible = cells.get(`${cx},${cy}`) || [];
      if (possible.some(other => other.x <= rect.x && other.y <= rect.y &&
          other.x + other.width >= rect.x + rect.width && other.y + other.height >= rect.y + rect.height)) continue;
      result.push(rect);
      for (let x = Math.floor(rect.x / 64); x <= Math.floor((rect.x + rect.width) / 64); x++) {
        for (let y = Math.floor(rect.y / 64); y <= Math.floor((rect.y + rect.height) / 64); y++) {
          const key = `${x},${y}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(rect);
        }
      }
    }
    return result;
  }

  function approximateArea(rects, width, height) {
    const size = 16, cols = Math.ceil(width / size), rows = Math.ceil(height / size);
    const occupied = new Uint8Array(cols * rows);
    for (const rect of rects) {
      for (let y = Math.max(0, Math.floor(rect.y / size)); y < Math.min(rows, Math.ceil((rect.y + rect.height) / size)); y++) {
        for (let x = Math.max(0, Math.floor(rect.x / size)); x < Math.min(cols, Math.ceil((rect.x + rect.width) / size)); x++) occupied[y * cols + x] = 1;
      }
    }
    let area = 0;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      if (occupied[y * cols + x]) area += Math.min(size, width - x * size) * Math.min(size, height - y * size);
    }
    return area / (width * height);
  }

  function detect({ width = innerWidth, height = innerHeight, excludeElement = null, padding = 8 } = {}) {
    const started = clock();
    const viewport = { x: 0, y: 0, width, height };
    const rectangles = [], candidates = [], priority = [], shadowRoots = [];
    const snapshots = new WeakMap();
    const atomicRoots = new WeakSet();
    const range = document.createRange();
    const stack = document.documentElement ? [{ element: document.documentElement, clip: viewport, opacity: 1 }] : [];
    let elementCount = 0, textCount = 0, mediaCount = 0;
    const add = (box, clip) => {
      const rect = intersection(box, clip);
      if (!rect) return;
      const expanded = intersection({ x: rect.x - padding, y: rect.y - padding, width: rect.width + padding * 2, height: rect.height + padding * 2 }, viewport);
      if (expanded) rectangles.push(expanded);
      if (rectangles.length > LIMITS.rectangles) throw new Error("页面内容过于密集，无法安全生成地图。请缩小页面范围或换一个页面。");
    };

    while (stack.length) {
      const { element, clip, opacity: inheritedOpacity } = stack.pop();
      if (element === excludeElement || SKIP.has(element.tagName)) continue;
      if (++elementCount > LIMITS.elements || (elementCount % 64 === 0 && clock() - started > LIMITS.duration)) {
        throw new Error("页面过于复杂，分析已安全停止。请换一个内容较少的页面再试。");
      }
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      const opacity = inheritedOpacity * (Number(style.opacity) || 0);
      const isDisplayed = style.display !== "none" && style.contentVisibility !== "hidden" && opacity >= LIMITS.opacity;
      const visible = isDisplayed && style.visibility !== "hidden" && style.visibility !== "collapse";
      // Viewport-fixed descendants can escape an ordinary ancestor's overflow clipping.
      // Transformed containing blocks are conservatively overblocked by this MVP approximation.
      const effectiveClip = style.position === "fixed" ? viewport : clip;
      const onScreen = visible && Boolean(intersection(box, effectiveClip));
      const rawText = visible ? directTextRects(element, viewport, range) : [];
      if (visible && element.shadowRoot) directTextRects(element.shadowRoot, viewport, range, rawText);
      snapshots.set(element, { box: boxKey(box), paint: styleKey(style), text: rawText.map(boxKey).join(";"),
        visible: style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" &&
          style.contentVisibility !== "hidden" && opacity >= LIMITS.opacity && Boolean(intersection(box, viewport)) });
      if (!isDisplayed) continue;

      const tag = element.tagName.toUpperCase();
      const atomic = ATOMIC.has(tag) || (tag === "AUDIO" && element.hasAttribute("controls"));
      const fixed = style.position === "fixed" || style.position === "sticky";
      const painted = hasPaint(style);
      const documentRoot = element === document.documentElement || element === document.body;
      const bounded = box.width * box.height < width * height * 0.36 || box.height < 120 || box.width < 180;
      const navigation = tag === "NAV" || element.getAttribute("role") === "navigation";
      const customHost = tag.includes("-") && !element.shadowRoot;
      let generatedContent = false;
      if (onScreen && !atomic && !rawText.length && !element.children.length) {
        generatedContent = ["::before", "::after"].some(pseudo => {
          const generatedStyle = getComputedStyle(element, pseudo);
          return generatedStyle.display !== "none" && generatedStyle.content !== "none" && generatedStyle.content !== "normal" &&
            generatedStyle.content !== '""' && generatedStyle.content !== "''";
        });
      }
      // Ignore page-sized backgrounds: their content, not their layout wrappers, forms the maze.
      const surface = !documentRoot && bounded && (painted || navigation || customHost || generatedContent || (fixed && (rawText.length || element.children.length)));

      let childClip = effectiveClip;
      const clipsX = ["hidden", "clip", "auto", "scroll"].includes(style.overflowX);
      const clipsY = ["hidden", "clip", "auto", "scroll"].includes(style.overflowY);
      if (!documentRoot && (clipsX || clipsY)) {
        const paddingBox = {
          x: clipsX ? box.left + element.clientLeft : effectiveClip.x,
          y: clipsY ? box.top + element.clientTop : effectiveClip.y,
          width: clipsX ? element.clientWidth : effectiveClip.width,
          height: clipsY ? element.clientHeight : effectiveClip.height
        };
        childClip = intersection(paddingBox, effectiveClip);
      }

      if (onScreen) {
        candidates.push(element);
        if (fixed || atomic || navigation) priority.push(element);
        if (atomic || surface) add(box, effectiveClip);
        if (atomic) {
          mediaCount += ["IMG", "VIDEO", "IFRAME", "CANVAS", "SVG", "OBJECT", "EMBED"].includes(tag) ? 1 : 0;
          // Internal pixels in embedded/media content cannot be inspected safely. Its box is atomic.
          atomicRoots.add(element);
        }
        if (tag === "A" && !atomic && !surface) {
          for (const rect of element.getClientRects()) add(rect, effectiveClip);
        }
      }
      if (!atomic && childClip) {
        for (const textBox of rawText) { add(textBox, childClip); textCount++; }
      }
      if (atomic) continue;
      // Still visit descendants outside a clip: viewport-fixed children may escape it.
      childClip ||= { x: 0, y: 0, width: 0, height: 0 };
      // Open shadow roots are inspected; closed roots can only be approximated by their host.
      if (element.shadowRoot) {
        shadowRoots.push(element.shadowRoot);
        for (const child of element.shadowRoot.children) stack.push({ element: child, clip: childClip, opacity });
      }
      for (let i = element.children.length - 1; i >= 0; i--) stack.push({ element: element.children[i], clip: childClip, opacity });
    }

    const rects = simplify(rectangles);
    const watchTargets = [...new Set(priority)].slice(0, 32);
    const remaining = 80 - watchTargets.length;
    for (let i = 0; i < remaining && candidates.length; i++) {
      const candidate = candidates[Math.min(candidates.length - 1, Math.floor(i * candidates.length / remaining))];
      if (!watchTargets.includes(candidate)) watchTargets.push(candidate);
    }
    const areaRatio = approximateArea(rects, width, height);
    return {
      width, height, rects, watchTargets,
      stats: { obstacleCount: rects.length, areaRatio, obstacleAreaRatio: areaRatio, walkableAreaRatio: 1 - areaRatio,
        elementCount, textCount, mediaCount, analysisMs: Math.round(clock() - started) },
      _watch: { viewport, snapshots, atomicRoots, shadowRoots, scrollX, scrollY, devicePixelRatio,
        visualViewport: window.visualViewport ? [visualViewport.width, visualViewport.height, visualViewport.offsetLeft, visualViewport.offsetTop, visualViewport.scale].join(",") : null }
    };
  }

  P.ObstacleDetector = Object.freeze({ detect, snapshot, equivalent, intersection });
})();
