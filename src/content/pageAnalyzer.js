(() => {
  "use strict";

  const P = globalThis.__PAGEPATH__ ||= {};

  function analyze({ excludeElement = null } = {}) {
    const config = P.Config || P.CONFIG || {};
    return P.ObstacleDetector.detect({ width: innerWidth, height: innerHeight,
      excludeElement, padding: config.OBSTACLE_PADDING ?? 8 });
  }

  function watch(analysis, { excludeElement = null, onChange = () => {} } = {}) {
    const initial = analysis._watch;
    const detector = P.ObstacleDetector;
    const range = document.createRange();
    const dirty = new Map();
    const observers = [];
    const listeners = [];
    let stopped = false, changed = false, debounce = 0, interval = 0, lastSample = 0;

    function excluded(node) {
      if (!node) return true;
      const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      if (!element) return true;
      if (element === excludeElement || excludeElement?.contains(element)) return true;
      return element.getRootNode()?.host === excludeElement;
    }

    function insideAtomic(element) {
      // Changes inside a video, SVG or iframe do not alter its already-blocked outer rectangle.
      for (let parent = element?.parentElement; parent; parent = parent.parentElement) {
        if (initial.atomicRoots.has(parent)) return true;
      }
      return false;
    }

    function cleanup() {
      if (stopped) return;
      stopped = true;
      clearTimeout(debounce);
      clearInterval(interval);
      for (const observer of observers) observer.disconnect();
      for (const [target, type, handler, options] of listeners) target.removeEventListener(type, handler, options);
      dirty.clear();
    }

    function pause(reason) {
      if (stopped) return;
      changed = true;
      cleanup();
      onChange(reason);
    }

    function listen(target, type, handler, options) {
      target.addEventListener(type, handler, options);
      listeners.push([target, type, handler, options]);
    }

    function compare(element) {
      const previous = initial.snapshots.get(element);
      const current = detector.snapshot(element, initial.viewport, range);
      // An initially hidden subtree is intentionally not traversed during generation.
      if (!previous) return Boolean(current?.visible);
      return !detector.equivalent(previous, current);
    }

    function queue(element, subtree = false) {
      if (!element || excluded(element) || insideAtomic(element)) return;
      dirty.set(element, Boolean(dirty.get(element) || subtree));
    }

    function recordsChanged(records) {
      for (const record of records) {
        if (excluded(record.target)) continue;
        const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
        if (insideAtomic(target)) continue;
        if (record.type === "characterData") queue(target);
        else if (record.type === "attributes") queue(target, true);
        else {
          // Text replacements by UI frameworks are compared by line geometry, so equal-width
          // countdown updates do not stop a game. Added/removed visible elements do invalidate it.
          queue(target);
          for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) queue(node, true);
          for (const node of record.removedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE && initial.snapshots.get(node)?.visible) {
              pause("Page layout changed");
              return;
            }
          }
        }
      }
      if (dirty.size && !stopped && !debounce) {
        debounce = setTimeout(() => { debounce = 0; check(true); }, 100);
      }
    }

    function check(force = false) {
      if (stopped) return changed;
      for (const observer of observers) recordsChanged(observer.takeRecords());
      if (stopped) return changed;
      if (innerWidth !== analysis.width || innerHeight !== analysis.height || scrollX !== initial.scrollX ||
          scrollY !== initial.scrollY || devicePixelRatio !== initial.devicePixelRatio ||
          (window.visualViewport && initial.visualViewport !== [visualViewport.width, visualViewport.height, visualViewport.offsetLeft, visualViewport.offsetTop, visualViewport.scale].join(","))) {
        pause("Page layout changed");
        return true;
      }
      let visited = 0;
      for (const [element, subtree] of dirty) {
        if (excluded(element)) continue;
        const stack = [element];
        while (stack.length) {
          const current = stack.pop();
          if (++visited > 240) {
            // Conservatively pause on a large structural update; never rebuild the whole map
            // during pointermove or keep playing against an incomplete obstacle snapshot.
            pause("Page layout changed");
            return true;
          }
          if (compare(current)) { pause("Page layout changed"); return true; }
          if (subtree && !initial.atomicRoots.has(current)) {
            for (const child of current.children) if (!excluded(child)) stack.push(child);
            if (current.shadowRoot) for (const child of current.shadowRoot.children) stack.push(child);
          }
        }
      }
      dirty.clear();
      const now = performance.now();
      if (force || now - lastSample >= 120) {
        lastSample = now;
        for (const element of analysis.watchTargets) {
          if (compare(element)) { pause("Page layout changed"); return true; }
        }
      }
      return false;
    }

    for (const root of [document.documentElement, ...initial.shadowRoots]) {
      if (!root) continue;
      const observer = new MutationObserver(recordsChanged);
      observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ["style", "class", "id", "hidden", "open", "width", "height", "src", "srcset", "sizes", "dir",
          "aria-hidden", "aria-expanded", "data-state", "data-open"] });
      observers.push(observer);
    }
    listen(window, "resize", () => check(true), { passive: true });
    listen(window, "scroll", event => {
      if (event.target === document || event.target === window) check(true);
      else if (!excluded(event.target)) pause("Page layout changed");
    }, { passive: true, capture: true });
    listen(document, "load", event => { if (!excluded(event.target)) { queue(event.target, true); check(true); } }, true);
    listen(document, "transitionrun", event => { if (!excluded(event.target)) { queue(event.target, true); } }, true);
    if (window.visualViewport) {
      listen(window.visualViewport, "resize", () => check(true), { passive: true });
      listen(window.visualViewport, "scroll", () => check(true), { passive: true });
    }
    interval = setInterval(() => check(true), 350);
    cleanup.check = check;
    return cleanup;
  }

  P.PageAnalyzer = Object.freeze({ analyze, watch });
})();
