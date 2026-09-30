(() => {
  'use strict';
  const P = globalThis.__PAGEPATH__ ||= {};
  const DEFAULTS = Object.freeze({ MAX_SCAN: 4000, MAX_HINTS: 512,
    MAX_WIDTH: 240, MAX_HEIGHT: 96, MAX_AREA: 14000, MAX_VIEWPORT_RATIO: 0.018,
    MIN_SIZE: 4, MIN_OPACITY: 0.85 });
  const IGNORED = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'LINK', 'META']);
  const TEXT = new Set(['SPAN', 'LABEL', 'A', 'P', 'DIV', 'LI', 'STRONG', 'B', 'I', 'EM',
    'SMALL', 'TIME', 'CODE', 'MARK', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  const MEDIA = new Set(['IMG', 'SVG', 'CANVAS', 'VIDEO']);
  const CONTROLS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A']);
  const isOverlay = element => element.hasAttribute('data-pagepath-root') ||
    element.hasAttribute('data-pagepath-overlay');
  const alpha = color => {
    if (!color || color === 'transparent') return 0;
    const values = color.match(/[\d.]+/g);
    if (!values) return 0;
    return color.startsWith('rgba(') || color.includes('/') ? Number(values.at(-1)) : 1;
  };
  const cleanNumber = value => Number(value.toFixed(3));

  function circularRadius(element, style, rect) {
    const baseWidth = element.offsetWidth || rect.width;
    const baseHeight = element.offsetHeight || rect.height;
    const scaleX = rect.width / baseWidth, scaleY = rect.height / baseHeight;
    const resolve = (value, edge) => {
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:px|%)$/.test(value)) return NaN;
      return parseFloat(value) * (value.endsWith('%') ? edge / 100 : 1);
    };
    const radii = [];
    for (const corner of ['TopLeft', 'TopRight', 'BottomLeft', 'BottomRight']) {
      const values = style['border' + corner + 'Radius'].trim().split(/\s+/);
      if (values.length > 2) return null;
      const rx = resolve(values[0], baseWidth) * scaleX;
      const ry = resolve(values[1] || values[0], baseHeight) * scaleY;
      // The compact hint describes one circular radius, not an ellipse or four
      // different corners. Unsupported silhouettes retain screenshot geometry.
      if (!Number.isFinite(rx + ry) || Math.abs(rx - ry) > 0.15) return null;
      radii.push((rx + ry) / 2);
    }
    if (Math.max(...radii) - Math.min(...radii) > 0.15) return null;
    return Math.min(rect.width / 2, rect.height / 2, radii[0]);
  }

  function collect({ width = innerWidth, height = innerHeight } = {}) {
    if (!(width > 0 && height > 0) || !document.body) return [];
    const config = { ...DEFAULTS, ...P.Config?.HYBRID_DOM };
    const maxArea = Math.min(config.MAX_AREA, width * height * config.MAX_VIEWPORT_RATIO);
    const hints = [], styles = new WeakMap();
    const css = element => {
      if (!styles.has(element)) styles.set(element, getComputedStyle(element));
      return styles.get(element);
    };
    const fits = rect => rect.width >= config.MIN_SIZE && rect.height >= config.MIN_SIZE &&
      rect.width <= config.MAX_WIDTH && rect.height <= config.MAX_HEIGHT &&
      rect.width * rect.height <= maxArea && rect.left >= 0 && rect.top >= 0 &&
      rect.right <= width && rect.bottom <= height;

    // Rectangular hints are deliberately conservative: distorted, partially
    // clipped or translucent content keeps its original screenshot contour.
    function visible(element, rect, contentBounds) {
      let opacity = 1, depth = 0;
      for (let current = element; current; current = current.parentElement) {
        if (++depth > 80 || isOverlay(current)) return false;
        const style = css(current);
        opacity *= Number(style.opacity);
        if (style.display === 'none' || style.visibility !== 'visible' ||
            style.contentVisibility === 'hidden' || opacity < config.MIN_OPACITY ||
            style.clipPath !== 'none' || style.clip !== 'auto' ||
            (style.maskImage && style.maskImage !== 'none') ||
            style.filter !== 'none' || style.perspective !== 'none' ||
            (style.rotate && !['none', '0deg'].includes(style.rotate))) return false;
        if (style.transform !== 'none') {
          try {
            const matrix = new DOMMatrixReadOnly(style.transform);
            if (!matrix.is2D || Math.abs(matrix.b) > 0.0001 || Math.abs(matrix.c) > 0.0001 ||
                matrix.a <= 0 || matrix.d <= 0) return false;
          } catch { return false; }
        }
        if ((current !== element || contentBounds) && (/(hidden|clip|auto|scroll)/.test(style.overflowX) ||
            /(hidden|clip|auto|scroll)/.test(style.overflowY))) {
          const clip = current.getBoundingClientRect();
          const scaleX = current.offsetWidth ? clip.width / current.offsetWidth : 1;
          const scaleY = current.offsetHeight ? clip.height / current.offsetHeight : 1;
          const left = clip.left + current.clientLeft * scaleX;
          const top = clip.top + current.clientTop * scaleY;
          if ((/(hidden|clip|auto|scroll)/.test(style.overflowX) &&
              (rect.left < left || rect.right > left + current.clientWidth * scaleX)) ||
              (/(hidden|clip|auto|scroll)/.test(style.overflowY) &&
              (rect.top < top || rect.bottom > top + current.clientHeight * scaleY))) return false;
        }
      }
      // Any covered sample rejects the entire hint; image analysis still sees
      // the visible pieces. Never turn a covered control into an invisible wall.
      for (const [fx, fy] of [[0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8],
        [0.5, 0.08], [0.5, 0.92], [0.08, 0.5], [0.92, 0.5], [0.5, 0.5]]) {
        const x = rect.left + rect.width * fx, y = rect.top + rect.height * fy;
        const hit = document.elementsFromPoint(x, y).find(node =>
          !node.closest('[data-pagepath-root],[data-pagepath-overlay]'));
        const transparentToPointer = css(element).pointerEvents === 'none';
        if (!hit || (hit !== element && !element.contains(hit) &&
            !(transparentToPointer && hit.contains(element)))) return false;
      }
      return true;
    }

    function next(element, skipChildren) {
      if (!skipChildren && element.firstElementChild) return element.firstElementChild;
      for (let current = element; current && current !== document.body; current = current.parentElement) {
        if (current.nextElementSibling) return current.nextElementSibling;
      }
      return null;
    }
    let element = document.body, visited = 0;
    while (element && ++visited <= config.MAX_SCAN && hints.length < config.MAX_HINTS) {
      const tag = element.tagName.toUpperCase();
      if (isOverlay(element) || IGNORED.has(tag)) { element = next(element, true); continue; }
      const style = css(element);
      if (style.display === 'none' || style.contentVisibility === 'hidden' || Number(style.opacity) === 0) {
        element = next(element, true); continue;
      }
      const control = CONTROLS.has(tag) || ['button', 'checkbox', 'radio', 'switch', 'tab']
        .includes(element.getAttribute('role'));
      const media = MEDIA.has(tag);
      const leafText = TEXT.has(tag) && !element.childElementCount &&
        element.textContent.trim().length > 0 && element.textContent.trim().length <= 120;
      if (!control && !media && !leafText) { element = next(element, false); continue; }
      let rect = element.getBoundingClientRect();
      const paintedBox = control && (alpha(style.backgroundColor) >= 0.85 ||
        ['Top', 'Right', 'Bottom', 'Left'].some(side =>
          parseFloat(style['border' + side + 'Width']) >= 1 &&
          !['none', 'hidden'].includes(style['border' + side + 'Style']) &&
          alpha(style['border' + side + 'Color']) >= 0.5));
      if (leafText && !paintedBox && !media) {
        const range = document.createRange();
        range.selectNodeContents(element);
        const lines = [...range.getClientRects()].filter(line => line.width > 0 && line.height > 0);
        range.detach();
        if (lines.length !== 1) { element = next(element, false); continue; }
        rect = lines[0];
      }
      if (!fits(rect) || !visible(element, rect, leafText && !paintedBox && !media)) {
        element = next(element, false); continue;
      }
      let radius = 0;
      if (paintedBox) {
        radius = circularRadius(element, style, rect);
        if (radius === null) { element = next(element, false); continue; }
      }
      hints.push({ x: cleanNumber(rect.left), y: cleanNumber(rect.top),
        width: cleanNumber(rect.width), height: cleanNumber(rect.height),
        kind: paintedBox ? 'box' : 'content', radius: cleanNumber(radius) });
      // Keep the outer compact control intact rather than packaging each icon
      // and letter a second time. Large containers still descend normally.
      element = next(element, true);
    }
    return hints;
  }
  P.CompactDOM = Object.freeze({ collect });
})();
