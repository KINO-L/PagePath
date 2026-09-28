(() => {
  "use strict";

  const P = globalThis.__PAGEPATH__ ||= {};

  function available() {
    return Boolean(globalThis.chrome?.runtime?.id && globalThis.chrome.runtime.sendMessage);
  }

  function abortError() {
    return new DOMException("页面截图已取消", "AbortError");
  }

  function assertActive(signal) {
    if (signal?.aborted) throw abortError();
  }

  function viewport() {
    const visual = window.visualViewport;
    return {
      width: innerWidth,
      height: innerHeight,
      dpr: devicePixelRatio,
      visualViewport: visual ? [visual.width, visual.height, visual.offsetLeft, visual.offsetTop, visual.scale].join(",") : ""
    };
  }

  function sameViewport(previous) {
    const current = viewport();
    return current.width === previous.width && current.height === previous.height &&
      current.dpr === previous.dpr && current.visualViewport === previous.visualViewport;
  }

  // The browser request itself cannot be cancelled. Only its result is accepted
  // while this capture is alive; Escape must restore the page immediately.
  function abortable(operation, signal, timeout = 8000) {
    assertActive(signal);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        callback(value);
      };
      const onAbort = () => finish(reject, abortError());
      const timer = setTimeout(() => finish(reject, new Error("固定页面超时，请保持当前标签页在前台后重试")), timeout);
      signal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve().then(() => {
        assertActive(signal);
        return operation();
      }).then(value => finish(resolve, value), error => finish(reject, error));
    });
  }

  function nextPaint(signal) {
    assertActive(signal);
    return new Promise((resolve, reject) => {
      let frame = 0;
      let timer = 0;
      const cleanup = () => {
        cancelAnimationFrame(frame);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => { cleanup(); reject(abortError()); };
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("请保持当前标签页在前台后重新固定页面"));
      }, 3000);
      frame = requestAnimationFrame(() => { cleanup(); resolve(); });
    });
  }

  function pauseAnimations() {
    const paused = [];
    // This affects only existing animations for the short capture window. Page
    // timers, media playback and application state continue normally.
    for (const animation of document.getAnimations?.() || []) {
      if (animation.playState !== "running") continue;
      try {
        animation.pause();
        paused.push(animation);
      } catch { /* An animation can finish or become unpausable during capture. */ }
    }
    return () => {
      for (const animation of paused) {
        try {
          if (animation.playState === "paused") animation.play();
        } catch { /* The page may have removed or cancelled the animation. */ }
      }
      paused.length = 0;
    };
  }

  function releaseImage(image) {
    if (!image) return;
    image.remove();
    image.removeAttribute("src");
  }

  async function capture({ overlay, signal } = {}) {
    assertActive(signal);
    if (!available()) throw new Error("当前环境不支持固定页面，请通过浏览器扩展启动");
    if (!overlay?.host?.isConnected) throw abortError();

    let resumeAnimations = () => {};
    overlay.setCaptureHidden(true);
    try {
      resumeAnimations = pauseAnimations();
      for (let attempt = 0; attempt < 2; attempt++) {
        assertActive(signal);
        // Two frames let the compositor paint without the extension overlay.
        await nextPaint(signal);
        await nextPaint(signal);
        assertActive(signal);
        const bounds = viewport();
        const analysis = P.PageAnalyzer.analyze({ excludeElement: overlay.host });
        let invalidated = false;
        let image = null;
        let retained = false;
        const unwatch = P.PageAnalyzer.watch(analysis, {
          excludeElement: overlay.host,
          onChange: () => { invalidated = true; }
        });
        try {
          const response = await abortable(() => globalThis.chrome.runtime.sendMessage({ type: "PAGEPATH_CAPTURE" }), signal);
          assertActive(signal);
          if (!response?.ok || !/^data:image\/(?:png|jpeg|webp);base64,/.test(response.dataUrl || "")) {
            throw new Error(response?.error || "无法固定当前页面，请重新点击扩展后重试");
          }
          image = new Image();
          image.decoding = "async";
          image.src = response.dataUrl;
          await abortable(() => image.decode(), signal);
          assertActive(signal);
          if (!overlay.host.isConnected) throw abortError();
          if (!image.naturalWidth || !image.naturalHeight) throw new Error("页面截图为空，请重试");
          if (unwatch.check(true) || invalidated || !sameViewport(bounds)) {
            if (attempt === 0) continue;
            throw new Error("截图时页面仍在变化，请稍候再试");
          }
          retained = true;
          const snapshotImage = image;
          return {
            mode: "screenshot",
            analysis,
            image: snapshotImage,
            viewport: bounds,
            destroy() { releaseImage(snapshotImage); }
          };
        } finally {
          unwatch();
          if (!retained) releaseImage(image);
        }
      }
      throw new Error("无法固定当前页面，请重试");
    } finally {
      resumeAnimations();
      if (overlay.host?.isConnected) overlay.setCaptureHidden(false);
    }
  }

  function watch(snapshot, { onChange = () => {} } = {}) {
    let stopped = false;
    let changed = false;
    let interval = 0;
    const listeners = [];
    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      for (const [target, type, handler] of listeners) target.removeEventListener(type, handler);
      listeners.length = 0;
    };
    const check = () => {
      if (stopped) return changed;
      if (sameViewport(snapshot.viewport)) return false;
      changed = true;
      cleanup();
      onChange("窗口大小或缩放已变化，请重新生成关卡");
      return true;
    };
    const listen = (target, type) => {
      target.addEventListener(type, check, { passive: true });
      listeners.push([target, type, check]);
    };
    // The opaque image owns the puzzle's coordinates now. Changes to the live
    // document, including its scroll position, cannot invalidate this map.
    listen(window, "resize");
    if (window.visualViewport) {
      listen(window.visualViewport, "resize");
      listen(window.visualViewport, "scroll");
    }
    interval = setInterval(check, 350);
    cleanup.check = check;
    return cleanup;
  }

  P.PageSnapshot = Object.freeze({ available, capture, watch });
})();
