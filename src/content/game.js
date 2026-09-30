(() => {
  "use strict";
  const P = globalThis.__PAGEPATH__ ||= {};
  const STATES = Object.freeze({ IDLE: "IDLE", GENERATING: "GENERATING", READY: "READY", DRAWING: "DRAWING", FAILED: "FAILED", SUCCESS: "SUCCESS", PAUSED: "PAUSED", DESTROYED: "DESTROYED" });

  function sameMapGeometry(a, b) {
    return a === b;
  }

  class Game {
    constructor() {
      this.state = STATES.IDLE;
      this.mode = P.Config.DEFAULT_MODE || "normal";
      this.hintVisible = false;
      this.recentLayouts = [];
      this.events = new AbortController();
      this.level = null;
      this.analysis = null;
      this.sourceAnalysis = null;
      this.mazeAvailability = { available: false, reason: "正在检查页面是否适合生成迷宫" };
      this.collisionIndex = null;
      this.points = [];
      this.collected = new Set();
      this.pointerId = null;
      this.pointerType = null;
      this.length = 0;
      this.frame = 0;
      this.generationFrame = 0;
      this.retryTimer = 0;
      this.unwatch = null;
      this.snapshot = null;
      this.captureAbort = null;
      this.generation = 0;
      this.generationFailed = false;
      this.previousFocus = document.activeElement;
      this.overlay = new P.Overlay({
        onRetry: () => this.retry(), onNewPuzzle: () => this.generate(),
        onExit: () => this.destroy(), onRegenerate: () => this.generate({ refresh: true }),
        onModeChange: mode => this.setMode(mode), onHint: () => this.toggleHint(),
        onToolbarMove: () => this.updateMazeAvailability()
      });
      this.overlay.host.tabIndex = -1;
      this.overlay.host.focus({ preventScroll: true });
      const on = (target, name, callback, options = {}) => target.addEventListener(name, callback, { ...options, signal: this.events.signal });
      on(this.overlay.surface, "pointerdown", e => this.pointerDown(e));
      on(this.overlay.surface, "pointermove", e => this.pointerMove(e));
      on(this.overlay.surface, "pointerup", e => this.pointerUp(e));
      on(this.overlay.surface, "pointercancel", e => { if (e.pointerId === this.pointerId) this.fail("输入已取消，请从起点重试"); });
      on(this.overlay.surface, "lostpointercapture", e => {
        if (this.state === STATES.DRAWING && e.pointerId === this.pointerId && this.pointerType !== "mouse") this.fail("输入已离开游戏，请重试");
      });
      on(this.overlay.surface, "pointerleave", e => {
        if (this.state === STATES.DRAWING && e.pointerId === this.pointerId && this.pointerType === "mouse") this.fail("鼠标已离开游戏，请重试");
      });
      on(this.overlay.host, "contextmenu", e => {
        e.preventDefault(); e.stopImmediatePropagation(); this.destroy();
      }, { capture: true });
      on(this.overlay.host, "dragstart", e => e.preventDefault());
      // Prevent accidental wheel navigation while a viewport puzzle is active.
      // A fixed snapshot stays aligned even if the underlying site scrolls itself.
      on(this.overlay.host, "wheel", e => { if (this.state !== STATES.PAUSED) e.preventDefault(); }, { passive: false });
      on(window, "keydown", e => {
        if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); this.destroy(); return; }
        const origin = e.composedPath?.()[0] || e.target;
        const inControl = origin?.closest?.("button,select,input,textarea,[contenteditable='true']");
        if ([" ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"].includes(e.key) && e.target === this.overlay.host && !inControl) e.preventDefault();
      }, { capture: true });
      on(window, "blur", () => { if (this.state === STATES.DRAWING) this.pause("窗口已失去焦点，请重新生成关卡"); });
      on(document, "visibilitychange", () => { if (document.hidden && this.state === STATES.DRAWING) this.pause("页面已切到后台，请重新生成关卡"); });
      on(window, "pagehide", () => this.destroy());
    }

    start() { this.generate(); }

    updateMazeAvailability() {
      if (!this.snapshot || !P.MazeGenerator || ![STATES.READY, STATES.FAILED, STATES.SUCCESS].includes(this.state)) return;
      this.mazeAvailability = P.MazeGenerator.assess(this.snapshot.analysis);
      this.overlay.update({ mazeAvailability: this.mazeAvailability });
    }

    update(message = "", result = {}) {
      if (this.state === STATES.DESTROYED) return;
      this.overlay.update({
        state: this.state, mode: this.mode, hintVisible: this.hintVisible,
        nodes: this.collected.size, total: this.level?.nodes.length || 0,
        ink: this.level ? Math.max(0, Math.ceil(100 * (1 - this.length / this.level.maxInk))) : 100,
        inkMultiplier: this.level?.inkMultiplier,
        unlimitedInk: this.mode === "maze", mazeAvailability: this.mazeAvailability,
        generationFailed: this.generationFailed,
        message, difficulty: this.level?.difficulty ?? 0, ...result
      });
    }

    stopAttempt() {
      clearTimeout(this.retryTimer);
      this.retryTimer = 0;
      const pointer = this.pointerId;
      this.pointerId = null;
      this.pointerType = null;
      if (pointer !== null && this.overlay.surface.hasPointerCapture?.(pointer)) {
        try { this.overlay.surface.releasePointerCapture(pointer); } catch { /* Already released by browser. */ }
      }
    }

    setMode(mode) {
      if (P.getMode(mode).id !== mode || mode === this.mode ||
          [STATES.DESTROYED, STATES.GENERATING, STATES.DRAWING].includes(this.state)) return;
      if (mode === "maze" && !this.mazeAvailability.available) return;
      this.unwatch?.check?.();
      const refresh = this.state === STATES.PAUSED;
      this.mode = mode;
      // All modes use the same collision footprint, so a frozen page can be
      // reused. A paused viewport needs a fresh capture before changing rules.
      this.generate({ refresh });
    }

    toggleHint() {
      if (this.mode === "maze" || !this.level || ![STATES.READY, STATES.FAILED, STATES.SUCCESS].includes(this.state)) return;
      this.unwatch?.check?.();
      if (this.state === STATES.PAUSED) return;
      this.hintVisible = !this.hintVisible;
      this.overlay.renderHint(this.hintVisible);
      this.update(this.hintVisible
        ? "答案已显示 · 从砚台沿虚线到纸张，墨水仍正常消耗"
        : "答案已收起 · 单击砚台，经过所有墨点后到达纸张",
      this.state === STATES.SUCCESS ? P.Scoring.calculate(this.level, this.length) : {});
    }

    generate({ refresh = false } = {}) {
      if (this.state === STATES.DESTROYED) return;
      const generation = ++this.generation;
      this.captureAbort?.abort();
      this.captureAbort = null;
      this.state = STATES.GENERATING;
      this.generationFailed = false;
      this.stopAttempt();
      this.unwatch?.(); this.unwatch = null;
      if (refresh) this.recentLayouts = [];
      if (refresh && this.snapshot) {
        this.overlay.clearSnapshot();
        this.snapshot.destroy?.();
        this.snapshot = null;
      }
      if (!this.snapshot) this.mazeAvailability = { available: false, reason: "正在检查页面是否适合生成迷宫" };
      cancelAnimationFrame(this.generationFrame);
      cancelAnimationFrame(this.frame); this.frame = 0;
      this.level = null;
      this.analysis = null;
      this.collisionIndex = null;
      this.hintVisible = false;
      this.points = [];
      this.collected.clear();
      this.length = 0;
      this.overlay.renderPath([]);
      this.overlay.renderLevel(null);
      this.update(!this.snapshot ? "正在截取并分析页面图像…" : "正在像素地图中生成路线…");
      // Yield one paint before synchronous, bounded analysis.
      this.generationFrame = requestAnimationFrame(() => {
        this.generationFrame = requestAnimationFrame(async () => {
          this.generationFrame = 0;
          if (this.state === STATES.DESTROYED) return;
          let mazeGenerationFailed = false, regularGenerationFailed = false;
          try {
            if (!this.snapshot) {
              if (!P.PageSnapshot?.available()) throw new Error("请通过浏览器扩展启动，地图需要当前视口的真实截图");
              const controller = new AbortController();
              this.captureAbort = controller;
              const snapshot = await P.PageSnapshot.capture({ overlay: this.overlay, signal: controller.signal });
              if (this.state === STATES.DESTROYED || generation !== this.generation) {
                snapshot.destroy?.(); return;
              }
              this.captureAbort = null;
              this.snapshot = snapshot;
              this.overlay.setSnapshot(snapshot.image);
            }
            // Image analysis runs once per capture. A maze adds walls to a copy;
            // switching back must recover the unchanged screenshot geometry.
            const analysis = this.snapshot.analysis;
            if (!sameMapGeometry(this.sourceAnalysis, analysis)) this.recentLayouts = [];
            this.sourceAnalysis = analysis;
            const reservedRects = this.overlay.getReservedRects();
            this.mazeAvailability = P.MazeGenerator?.assess(analysis) ||
              { available: false, reason: "当前页面无法生成迷宫，请换一个内容更丰富的页面" };
            const mazeUnavailable = this.mode === "maze" && !this.mazeAvailability.available;
            if (mazeUnavailable) this.mode = P.Config.DEFAULT_MODE;
            const onChange = reason => this.pause(reason || "窗口尺寸已变化，请重新生成");
            this.unwatch = P.PageSnapshot.watch(this.snapshot, { onChange });
            try {
              this.level = P.LevelGenerator.generate(analysis, reservedRects, Math.random, this.mode, this.recentLayouts);
            } catch (error) {
              mazeGenerationFailed = this.mode === "maze";
              regularGenerationFailed = this.mode !== "maze";
              throw error;
            }
            this.analysis = this.level.analysis || analysis;
            if (this.level.toolbarRect) this.overlay.positionToolbar(this.level.toolbarRect.x, this.level.toolbarRect.y);
            // Toolbar space is reserved only when placing a new puzzle. The
            // movable controls are UI, so their old position must never become
            // an invisible wall, nor may moving them change an active attempt.
            this.collisionIndex = this.level.obstacleIndex;
            this.overlay.renderLevel(this.level);
            this.overlay.setMap?.(this.analysis);
            this.overlay.showDebug(this.analysis, this.level, P.Config.DEBUG);
            this.retry();
            if (mazeUnavailable) this.update(`第二关暂不可用：${this.mazeAvailability.reason} · 已切回${P.getMode(this.mode).label}`);
            this.overlay.flashObstacles?.();
            // Keep positions only, not screenshots or grids. Recent layouts
            // guide variety on the same page without affecting Retry.
            if (this.mode !== "maze") {
              this.recentLayouts.push(this.level.nodes.map(({ x, y }) => ({ x, y })));
              if (this.recentLayouts.length > 4) this.recentLayouts.shift();
            }
          } catch (error) {
            if (this.state === STATES.DESTROYED || generation !== this.generation) return;
            this.captureAbort = null;
            if (mazeGenerationFailed) {
              // Unlock criteria describe the screenshot, not whether this
              // generation attempt found a valid maze. Preserve the source so
              // New Map can try again or another mode can reuse it unchanged.
              this.level = null; this.collisionIndex = null;
              this.analysis = this.sourceAnalysis;
              this.overlay.renderLevel(null);
              this.overlay.setMap?.(this.analysis);
              this.state = STATES.FAILED;
              this.generationFailed = true;
              this.update(`第二关生成失败：${error?.message || "尚未找到可解的迷宫路线"} · 可重试新地图、刷新页面截图或切换难度`);
              return;
            }
            if (regularGenerationFailed && this.mazeAvailability.available && this.snapshot?.analysis &&
                this.snapshot.analysis === this.sourceAnalysis) {
              // A valid dense screenshot can have no ordinary background route
              // while still qualifying for a maze that opens foreground. Keep
              // that screenshot and its viewport watch until the player chooses
              // the unlocked star; capture/analysis/UI errors never enter here.
              this.level = null; this.collisionIndex = null;
              this.analysis = this.sourceAnalysis;
              this.overlay.renderLevel(null);
              this.overlay.setMap?.(this.analysis);
              this.state = STATES.FAILED;
              this.generationFailed = true;
              this.update("当前页面空隙不足，可点击五角星进入第二关");
              return;
            }
            // A page with no playable space should remain scrollable and visible
            // so the player can choose a different viewport before regenerating.
            this.overlay.clearSnapshot?.();
            this.unwatch?.(); this.unwatch = null;
            this.snapshot?.destroy?.(); this.snapshot = null;
            this.level = null; this.analysis = null; this.collisionIndex = null;
            this.sourceAnalysis = null;
            this.mazeAvailability = { available: false, reason: "请重新生成地图后检查迷宫是否可用" };
            this.overlay.setMap?.(null);
            this.overlay.renderLevel(null);
            this.state = STATES.PAUSED;
            this.update(error?.message || "这片空白不足以生成关卡，请换个位置后重新生成");
          }
        });
      });
    }

    retry() {
      if (!this.level || [STATES.DESTROYED, STATES.PAUSED].includes(this.state)) return;
      this.state = STATES.READY;
      this.generationFailed = false;
      this.stopAttempt();
      this.points = [];
      this.length = 0;
      this.collected.clear();
      this.overlay.resetNodes();
      this.overlay.renderPath([]);
      const mode = P.getMode(this.mode);
      const inkMultiplier = this.level.inkMultiplier ?? P.getInkMultiplier(this.mode, this.level.nodes.length);
      const inkReserve = Number(((inkMultiplier - 1) * 100).toFixed(1));
      const instruction = this.mode === "maze"
        ? "第二关 · 墨水无限，单击砚台，穿过迷宫到达纸张"
        : this.mode === "normal"
        ? `${mode.label} · 单击砚台，经过所有墨点后到达纸张`
        : `${mode.label} · 墨水余量 ${inkReserve}%，单击砚台，经过墨点后到达纸张`;
      this.update(this.snapshot ? `页面已定格 · ${instruction}` : instruction);
    }

    pointerDown(event) {
      if (event.button !== 0 || event.isPrimary === false || ![STATES.READY, STATES.FAILED].includes(this.state) || !this.level) return;
      this.unwatch?.check?.();
      if (this.state === STATES.PAUSED) return;
      const point = { x: event.clientX, y: event.clientY };
      const start = this.level.nodes[0];
      if (P.Collision.distance(point, start) > P.Config.HIT_RADIUS) return;
      if (P.Collision.pointHits(point, this.collisionIndex, P.Config.PLAYER_RADIUS)) return;
      if (this.mode === "maze" && P.Collision.segmentHits(point, start, this.collisionIndex)) return;
      event.preventDefault(); event.stopPropagation();
      this.retry();
      this.state = STATES.DRAWING;
      this.pointerId = event.pointerId;
      this.pointerType = event.pointerType || "mouse";
      this.points = [point];
      this.collected.add(start.id);
      this.overlay.markNode(start.id);
      // Mouse drawing continues after the starting click is released. Capture
      // would be implicitly lost on that release; touch/pen still use dragging.
      if (this.pointerType !== "mouse") this.overlay.surface.setPointerCapture?.(event.pointerId);
      this.update();
      this.overlay.moveBrush?.(event);
      this.queueRender();
    }

    pointerMove(event) {
      if (this.state !== STATES.DRAWING || event.pointerId !== this.pointerId) return;
      event.preventDefault();
      this.unwatch?.check?.();
      if (this.state !== STATES.DRAWING) return;
      const samples = event.getCoalescedEvents?.();
      for (const sample of samples?.length ? samples : [event]) {
        if (this.state !== STATES.DRAWING) break;
        this.moveTo({ x: sample.clientX, y: sample.clientY });
      }
    }

    moveTo(point) {
      const previous = this.points[this.points.length - 1];
      const C = P.Config;
      const segmentLength = P.Collision.distance(previous, point);
      if (segmentLength < 0.01) return;
      // Process nodes chronologically along the segment, so a fast movement can
      // collect several nodes, but a finish crossed before the last node cannot win.
      const hits = this.level.nodes.filter(node => !this.collected.has(node.id))
        .map(node => ({ node, t: P.Collision.segmentCircleEntry(previous, point, node, C.HIT_RADIUS) }))
        .filter(hit => hit.t !== null && (this.mode !== "maze" || !P.Collision.segmentHits({
          x: previous.x + (point.x - previous.x) * hit.t,
          y: previous.y + (point.y - previous.y) * hit.t,
        }, hit.node, this.collisionIndex))).sort((a, b) => a.t - b.t);
      const pending = new Set(this.collected);
      let finishT = null;
      for (const hit of hits) {
        if (hit.node.kind === "finish" && pending.size < this.level.nodes.length - 1) continue;
        pending.add(hit.node.id);
        if (hit.node.kind === "finish") { finishT = hit.t; break; }
      }
      const end = finishT === null ? point : { x: previous.x + (point.x - previous.x) * finishT, y: previous.y + (point.y - previous.y) * finishT };
      const travel = segmentLength * (finishT ?? 1);
      if (end.x < C.PLAYER_RADIUS || end.y < C.PLAYER_RADIUS || end.x > this.analysis.width - C.PLAYER_RADIUS || end.y > this.analysis.height - C.PLAYER_RADIUS) {
        this.fail("离开了当前视口，请重新开始"); return;
      }
      if (P.Collision.segmentHits(previous, end, this.collisionIndex, C.PLAYER_RADIUS)) {
        this.fail(this.mode === "maze" ? "碰到了障碍或迷宫墙，请重新开始" : "碰到了网页内容，请重新开始"); return;
      }
      if (!this.level.unlimitedInk && this.length + travel > this.level.maxInk) { this.fail("墨水用尽，请尝试更短的路线"); return; }
      this.points.push(end);
      this.length += travel;
      for (const hit of hits) {
        if (finishT !== null && hit.t > finishT) break;
        if (hit.node.kind === "finish" && this.collected.size < this.level.nodes.length - 1) continue;
        this.collected.add(hit.node.id); this.overlay.markNode(hit.node.id);
      }
      if (finishT !== null) this.succeed();
      else this.queueRender();
    }

    pointerUp(event) {
      if (this.state !== STATES.DRAWING || event.pointerId !== this.pointerId) return;
      this.unwatch?.check?.();
      if (this.state !== STATES.DRAWING) return;
      // The release point may contain the final movement omitted by the browser.
      this.moveTo({ x: event.clientX, y: event.clientY });
      if (this.state === STATES.DRAWING && this.pointerType !== "mouse") this.fail("输入已抬起，请重新开始");
    }

    queueRender() {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        if (this.state === STATES.DESTROYED) return;
        this.overlay.renderPath(this.points);
        if (this.state === STATES.DRAWING) this.update(this.mode === "maze"
          ? "移动鼠标 · 墨水无限 · 穿过迷宫到达纸张"
          : this.mode === "normal"
          ? "移动鼠标 · 墨点可以任意顺序经过"
          : `${P.getMode(this.mode).label} · 移动鼠标 · 自选节点顺序，谨慎使用墨水`);
      });
    }

    fail(message) {
      if (this.state !== STATES.DRAWING) return;
      this.state = STATES.FAILED;
      this.stopAttempt();
      this.update(message);
      this.queueRender();
      // Keep the same map. A fresh pointerdown on Start can retry immediately.
      this.retryTimer = setTimeout(() => { if (this.state === STATES.FAILED) this.retry(); }, P.Config.FAILURE_DELAY);
    }

    succeed() {
      this.state = STATES.SUCCESS;
      this.stopAttempt();
      this.overlay.renderPath(this.points);
      this.update("完成 · 网页就是关卡", P.Scoring.calculate(this.level, this.length));
    }

    pause(message) {
      if ([STATES.DESTROYED, STATES.GENERATING, STATES.PAUSED].includes(this.state)) return;
      this.state = STATES.PAUSED;
      this.generationFailed = false;
      this.mazeAvailability = { available: false, reason: "窗口已变化，请刷新地图后检查迷宫是否可用" };
      this.hintVisible = false;
      this.overlay.renderHint(false);
      this.stopAttempt();
      this.unwatch?.(); this.unwatch = null;
      this.update(message || "Page layout changed · 页面布局已变化");
    }

    destroy() {
      if (this.state === STATES.DESTROYED) return;
      this.state = STATES.DESTROYED;
      this.generationFailed = false;
      ++this.generation;
      this.captureAbort?.abort(); this.captureAbort = null;
      this.stopAttempt();
      this.events.abort();
      this.unwatch?.(); this.unwatch = null;
      cancelAnimationFrame(this.frame);
      cancelAnimationFrame(this.generationFrame);
      const shouldRestoreFocus = document.activeElement === this.overlay.host;
      this.overlay.destroy();
      this.snapshot?.destroy?.(); this.snapshot = null;
      if (shouldRestoreFocus && this.previousFocus?.isConnected) this.previousFocus.focus?.({ preventScroll: true });
      this.points = []; this.collected.clear(); this.level = null; this.analysis = null; this.collisionIndex = null;
      this.sourceAnalysis = null;
      this.recentLayouts = [];
      if (P.instance === this) delete P.instance;
      try { globalThis.chrome?.runtime?.sendMessage({ type: "PAGEPATH_CLOSED" })?.catch?.(() => {}); } catch { /* Extension may have reloaded. */ }
    }
  }
  P.Game = Game;
  P.States = STATES;
})();
