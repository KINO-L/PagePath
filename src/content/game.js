(() => {
  "use strict";
  const P = globalThis.__PAGEPATH__ ||= {};
  const STATES = Object.freeze({ IDLE: "IDLE", GENERATING: "GENERATING", READY: "READY", DRAWING: "DRAWING", FAILED: "FAILED", SUCCESS: "SUCCESS", PAUSED: "PAUSED", DESTROYED: "DESTROYED" });

  const runId = () => globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);

  class Game {
    constructor() {
      this.state = STATES.IDLE;
      this.recentLayouts = [];
      this.events = new AbortController();
      this.level = null;
      this.analysis = null;
      this.sourceAnalysis = null;
      this.collisionIndex = null;
      this.points = [];
      this.pointerId = null;
      this.pointerType = null;
      this.length = 0;
      this.frame = 0;
      this.generationFrame = 0;
      this.retryTimer = 0;
      this.run = this.result = null;
      this.confirmedProfile = P.Progression.empty();
      this.optimisticProfile = this.confirmedProfile;
      this.pendingSettlements = [];
      this.activeSettlement = null;
      this.settlementRetryTimer = 0;
      this.settlementRequestTimers = new Set();
      this.settlementFailures = 0;
      this.profile = P.Progression.view(this.confirmedProfile);
      this.unwatch = null;
      this.snapshot = null;
      this.captureAbort = null;
      this.generationAbort = null;
      this.generation = 0;
      this.generationFailed = false;
      this.previousFocus = document.activeElement;
      this.overlay = new P.Overlay({
        onRetry: () => this.retry(), onNewPuzzle: () => this.generate(),
        onExit: () => this.destroy(), onRegenerate: () => this.generate({ refresh: true })
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

    start() { this.loadProfile(); this.generate(); }

    async loadProfile() {
      try {
        const response = await globalThis.chrome?.runtime?.sendMessage({ type: 'PAGEPATH_PROFILE' });
        if (response?.ok && this.state !== STATES.DESTROYED) {
          this.acceptConfirmedProfile(response.profileData); this.rebuildProfile(); this.update();
        }
      } catch { /* A later automatic settlement refreshes the confirmed profile. */ }
    }

    acceptConfirmedProfile(data) {
      if (!data) return;
      const next = P.Progression.normalize(data), previous = this.confirmedProfile;
      // Late reads and responses must not rewind a newer confirmed snapshot.
      if (next.totalRuns < previous.totalRuns || next.totalXp < previous.totalXp || next.totalScore < previous.totalScore) return;
      this.confirmedProfile = next;
    }

    rebuildProfile() {
      let profile = this.confirmedProfile;
      for (const pending of this.pendingSettlements) {
        const award = P.Progression.award(profile, pending.reward);
        profile = award.profile;
        if (award.awarded) Object.assign(pending.result, {
          previousLevel: award.previousLevel, level: award.level, title: award.title,
          leveledUp: award.leveledUp, levelsGained: award.levelsGained
        });
      }
      this.optimisticProfile = profile;
      this.profile = P.Progression.view(profile);
    }

    update(message) {
      if (this.state === STATES.DESTROYED) return;
      if (message !== undefined) this.message = message;
      this.overlay.update({ state: this.state, message: this.message || '',
        difficulty: this.level?.difficulty || 0,
        stars: this.level ? (this.level.stars ?? P.Difficulty.stars(this.level.difficulty)) : 0,
        profile: this.profile,
        result: this.result, generationFailed: this.generationFailed });
    }

    syncCollectibles() {
      this.overlay.updateCollectibles?.(this.run?.collectedIds || [], {
        xp: this.run?.collectedXp || 0, multiplier: this.run?.multiplier || 1,
      });
    }

    stopAttempt() {
      clearTimeout(this.retryTimer); this.retryTimer = 0;
      const pointer = this.pointerId;
      this.pointerId = this.pointerType = null;
      if (pointer !== null && this.overlay.surface.hasPointerCapture?.(pointer)) {
        try { this.overlay.surface.releasePointerCapture(pointer); } catch { /* Already released. */ }
      }
    }

    generate({ refresh = false } = {}) {
      if (this.state === STATES.DESTROYED) return;
      const generation = ++this.generation;
      this.captureAbort?.abort(); this.captureAbort = null;
      this.generationAbort?.abort();
      const controller = new AbortController(); this.generationAbort = controller;
      this.stopAttempt(); this.state = STATES.GENERATING; this.generationFailed = false;
      this.unwatch?.(); this.unwatch = null;
      if (refresh) {
        this.recentLayouts = [];
        this.overlay.clearSnapshot(); this.snapshot?.destroy?.(); this.snapshot = null;
      }
      cancelAnimationFrame(this.generationFrame);
      cancelAnimationFrame(this.frame); this.frame = 0;
      this.level = this.analysis = this.collisionIndex = this.run = this.result = null;
      this.points = []; this.length = 0;
      this.overlay.renderPath([]); this.overlay.renderLevel(null);
      this.update(this.snapshot ? '正在生成迷宫…' : '正在截取并分析页面…');
      this.generationFrame = requestAnimationFrame(() => {
        this.generationFrame = requestAnimationFrame(async () => {
          this.generationFrame = 0;
          if (this.state === STATES.DESTROYED || generation !== this.generation) return;
          try {
            if (!this.snapshot) {
              if (!P.PageSnapshot?.available()) throw new Error('请点击浏览器中的 迷页 扩展图标开始');
              this.captureAbort = controller;
              const snapshot = await P.PageSnapshot.capture({ overlay: this.overlay, signal: controller.signal });
              if (this.state === STATES.DESTROYED || generation !== this.generation) { snapshot.destroy?.(); return; }
              this.captureAbort = null; this.snapshot = snapshot; this.overlay.setSnapshot(snapshot.image);
            }
            const source = this.snapshot.analysis;
            if (this.sourceAnalysis !== source) this.recentLayouts = [];
            this.sourceAnalysis = source;
            this.unwatch = P.PageSnapshot.watch(this.snapshot, { onChange: reason => this.pause(reason || '窗口尺寸已变化，请刷新地图') });
            const level = await P.MazeClient.generate(this.snapshot, this.overlay.getReservedRects(), this.recentLayouts,
              { signal: controller.signal });
            // A closed, resized, or superseded game can never accept a late map.
            if (controller.signal.aborted || this.state !== STATES.GENERATING || generation !== this.generation) return;
            this.unwatch?.check?.();
            if (controller.signal.aborted || this.state !== STATES.GENERATING) return;
            this.generationAbort = null; this.level = level;
            this.analysis = this.level.analysis; this.collisionIndex = this.level.obstacleIndex;
            this.run = { id: runId(), settled: false, collectedIds: [], collectedXp: 0, collectedCount: 0, multiplier: 1 };
            if (this.level.toolbarRect) this.overlay.positionToolbar(this.level.toolbarRect.x, this.level.toolbarRect.y);
            this.overlay.renderLevel(this.level); this.overlay.setMap?.(this.analysis);
            this.overlay.showDebug(this.analysis, this.level, P.Config.DEBUG);
            this.retry(); this.overlay.flashObstacles?.();
            this.recentLayouts.push(this.level.nodes.map(({ x, y }) => ({ x, y })));
            if (this.recentLayouts.length > 4) this.recentLayouts.shift();
          } catch (error) {
            if (controller.signal.aborted || this.state === STATES.DESTROYED || generation !== this.generation) return;
            this.generationAbort = null;
            this.captureAbort = null; this.unwatch?.(); this.unwatch = null;
            this.level = this.analysis = this.collisionIndex = null;
            this.overlay.renderLevel(null); this.overlay.setMap?.(null);
            this.state = STATES.PAUSED; this.generationFailed = true;
            this.overlay.clearSnapshot(); this.snapshot?.destroy?.(); this.snapshot = null;
            this.sourceAnalysis = null;
            this.update(error?.message || '地图暂未准备好，请刷新后重试');
          }
        });
      });
    }

    retry() {
      if (!this.level || [STATES.DESTROYED, STATES.PAUSED].includes(this.state)) return;
      this.stopAttempt(); this.state = STATES.READY; this.generationFailed = false;
      this.points = []; this.length = 0; this.result = null;
      Object.assign(this.run, { collectedIds: [], collectedXp: 0, collectedCount: 0, multiplier: 1 });
      this.syncCollectibles();
      this.overlay.resetNodes(); this.overlay.renderPath([]);
      this.update(this.run.settled ? '本图已结算 · 可练习，或换一张新地图' : '单击小火堆，带着火苗寻找出口洞口');
    }

    pointerDown(event) {
      if (event.button !== 0 || event.isPrimary === false || ![STATES.READY, STATES.FAILED].includes(this.state) || !this.level) return;
      this.unwatch?.check?.(); if (this.state === STATES.PAUSED) return;
      const point = { x: event.clientX, y: event.clientY }, start = this.level.nodes[0];
      if (P.Collision.distance(point, start) > P.Config.HIT_RADIUS ||
          P.Collision.pointHits(point, this.collisionIndex) || P.Collision.segmentHits(point, start, this.collisionIndex)) return;
      event.preventDefault(); event.stopPropagation();
      this.retry(); this.state = STATES.DRAWING;
      this.pointerId = event.pointerId; this.pointerType = event.pointerType || 'mouse';
      this.points = [point]; this.overlay.markNode(start.id);
      if (this.pointerType !== 'mouse') this.overlay.surface.setPointerCapture?.(event.pointerId);
      this.update('探索出口'); this.overlay.moveBrush?.(event); this.queueRender();
    }

    pointerMove(event) {
      if (this.state !== STATES.DRAWING || event.pointerId !== this.pointerId) return;
      event.preventDefault(); this.unwatch?.check?.(); if (this.state !== STATES.DRAWING) return;
      const samples = event.getCoalescedEvents?.();
      for (const sample of samples?.length ? samples : [event]) {
        if (this.state !== STATES.DRAWING) break;
        this.moveTo({ x: sample.clientX, y: sample.clientY });
      }
    }

    moveTo(point) {
      if (this.state !== STATES.DRAWING || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      const previous = this.points.at(-1), C = P.Config, finish = this.level.nodes.at(-1);
      const segmentLength = P.Collision.distance(previous, point);
      if (segmentLength < 0.01) return;
      let finishT = P.Collision.segmentCircleEntry(previous, point, finish, C.HIT_RADIUS), end = point;
      if (finishT !== null) {
        const entry = { x: previous.x + (point.x - previous.x) * finishT, y: previous.y + (point.y - previous.y) * finishT };
        if (P.Collision.segmentHits(entry, finish, this.collisionIndex)) finishT = null;
        else end = entry;
      }
      if (end.x < C.PLAYER_RADIUS || end.y < C.PLAYER_RADIUS || end.x > this.analysis.width - C.PLAYER_RADIUS || end.y > this.analysis.height - C.PLAYER_RADIUS) {
        this.fail('离开了当前视口，点击小火堆重试'); return;
      }
      if (P.Collision.segmentHits(previous, end, this.collisionIndex)) { this.fail('碰到了迷宫边界，点击小火堆重试'); return; }
      const travel = segmentLength * (finishT ?? 1);
      this.collectBetween(previous, end);
      this.points.push(end); this.length += travel;
      if (this.points.length > 512) this.points.splice(0, this.points.length - 256);
      if (finishT !== null) { this.overlay.markNode(finish.id); this.succeed(); }
      else this.queueRender();
    }

    collectBetween(start, end) {
      const run = this.run, rules = P.Config.COLLECTIBLES;
      const dx = end.x - start.x, dy = end.y - start.y, squared = dx * dx + dy * dy;
      let changed = false;
      for (const bubble of this.level.collectibles || []) {
        if (run.collectedIds.includes(bubble.id)) continue;
        if (bubble.kind === 'xp' ? !rules.xpWeights.some(item => item.value === bubble.value) :
            bubble.kind !== 'multiplier' || !rules.multiplierWeights.some(item => item.value === bubble.value && item.value > 1)) continue;
        const t = squared ? Math.max(0, Math.min(1, ((bubble.x - start.x) * dx + (bubble.y - start.y) * dy) / squared)) : 0;
        const point = { x: start.x + dx * t, y: start.y + dy * t };
        if (P.Collision.distance(point, bubble) > rules.radius ||
            P.Collision.pointHits(bubble, this.collisionIndex) || P.Collision.segmentHits(point, bubble, this.collisionIndex)) continue;
        run.collectedIds.push(bubble.id);
        if (bubble.kind === 'xp') { run.collectedXp += bubble.value; run.collectedCount++; }
        else run.multiplier = Math.max(run.multiplier, bubble.value);
        changed = true;
      }
      if (changed) { this.syncCollectibles(); this.update(); }
    }

    pointerUp(event) {
      if (this.state !== STATES.DRAWING || event.pointerId !== this.pointerId) return;
      this.unwatch?.check?.(); if (this.state !== STATES.DRAWING) return;
      this.moveTo({ x: event.clientX, y: event.clientY });
      if (this.state === STATES.DRAWING && this.pointerType !== 'mouse') this.fail('输入已抬起，点击小火堆重试');
    }

    queueRender() {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        if (this.state !== STATES.DESTROYED) this.overlay.renderPath(this.points);
      });
    }

    fail(message) {
      if (this.state !== STATES.DRAWING) return;
      this.stopAttempt();
      this.state = STATES.FAILED; this.update(message); this.queueRender();
      this.retryTimer = setTimeout(() => { if (this.state === STATES.FAILED) this.retry(); }, P.Config.FAILURE_DELAY);
    }

    succeed() {
      if (this.state !== STATES.DRAWING) return;
      this.stopAttempt(); this.state = STATES.SUCCESS;
      this.overlay.renderPath(this.points);
      const stats = { collectedXp: this.run.collectedXp, collectedCount: this.run.collectedCount, multiplier: this.run.multiplier };
      const scored = P.Scoring.calculate(this.level, stats);
      if (this.run.settled) {
        this.result = { ...scored, xp: 0, awarded: false, level: this.profile.level, previousLevel: this.profile.level };
        this.update('练习完成 · 本图经验已结算'); return;
      }
      this.run.settled = true;
      const reward = { ...scored, runId: this.run.id };
      const award = P.Progression.award(this.optimisticProfile, reward);
      this.result = { ...scored, xp: award.rewardXp, awarded: award.awarded, confirmed: false,
        previousLevel: award.previousLevel, level: award.level, title: award.title,
        leveledUp: award.leveledUp, levelsGained: award.levelsGained };
      const message = { type: 'PAGEPATH_COMPLETE', runId: this.run.id,
        level: { difficulty: this.level.difficulty,
          ...(this.level.challenge?.complexity === undefined ? {} : { challenge: { complexity: this.level.challenge.complexity } }) }, stats };
      this.pendingSettlements.push({ message, reward, result: this.result });
      this.rebuildProfile(); this.update('迷宫完成'); this.flushSettlements();
    }

    async flushSettlements() {
      if (this.state === STATES.DESTROYED || this.activeSettlement || this.settlementRetryTimer || !this.pendingSettlements.length) return;
      const pending = this.pendingSettlements[0];
      this.activeSettlement = pending;
      let timeout;
      try {
        const response = await Promise.race([
          Promise.resolve(globalThis.chrome?.runtime?.sendMessage(pending.message)),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('settlement timeout')), 10000);
            this.settlementRequestTimers.add(timeout);
          })
        ]);
        if (!response?.ok || !response.profileData) throw new Error('settlement unavailable');
        this.acceptConfirmedProfile(response.profileData);
        this.pendingSettlements = this.pendingSettlements.filter(entry => entry.message.runId !== pending.message.runId);
        this.settlementFailures = 0;
        pending.result.confirmed = true;
        // A retried request may return xp=0 because its first response was lost.
        // Keep the original first-win credit; only explicit practice shows +0.
        if (response.result?.awarded) Object.assign(pending.result, {
          previousLevel: response.result.previousLevel, level: response.result.level,
          title: response.result.title, leveledUp: response.result.leveledUp, levelsGained: response.result.levelsGained
        });
        this.rebuildProfile();
      } catch {
        if (this.state !== STATES.DESTROYED) {
          const wait = Math.min(30000, 500 * 2 ** Math.min(this.settlementFailures++, 6));
          this.settlementRetryTimer = setTimeout(() => {
            this.settlementRetryTimer = 0; this.flushSettlements();
          }, wait);
        }
      } finally {
        clearTimeout(timeout);
        this.settlementRequestTimers.delete(timeout);
        this.activeSettlement = null;
        if (this.state !== STATES.DESTROYED) { this.update(); this.flushSettlements(); }
      }
    }

    pause(message) {
      if ([STATES.DESTROYED, STATES.PAUSED].includes(this.state)) return;
      if (this.state === STATES.GENERATING) {
        this.generationAbort?.abort(); this.generationAbort = null;
        this.captureAbort?.abort(); this.captureAbort = null;
        ++this.generation;
        cancelAnimationFrame(this.generationFrame); this.generationFrame = 0;
      }
      this.stopAttempt(); this.state = STATES.PAUSED;
      this.unwatch?.(); this.unwatch = null;
      this.update(message || '窗口已变化，请刷新地图');
    }

    destroy() {
      if (this.state === STATES.DESTROYED) return;
      this.stopAttempt(); this.state = STATES.DESTROYED; ++this.generation;
      clearTimeout(this.settlementRetryTimer); this.settlementRetryTimer = 0;
      for (const timer of this.settlementRequestTimers) clearTimeout(timer);
      this.settlementRequestTimers.clear();
      // Transfer queued receipts before leaving. The worker serializes and
      // retries storage independently of the lifetime of this overlay.
      for (const pending of this.pendingSettlements) if (pending !== this.activeSettlement) {
        try { globalThis.chrome?.runtime?.sendMessage(pending.message)?.catch?.(() => {}); } catch { /* Extension reloaded. */ }
      }
      this.captureAbort?.abort(); this.captureAbort = null;
      this.generationAbort?.abort(); this.generationAbort = null;
      this.events.abort(); this.unwatch?.(); this.unwatch = null;
      cancelAnimationFrame(this.frame); cancelAnimationFrame(this.generationFrame);
      const restoreFocus = document.activeElement === this.overlay.host;
      this.overlay.destroy(); this.snapshot?.destroy?.(); this.snapshot = null;
      if (restoreFocus && this.previousFocus?.isConnected) this.previousFocus.focus?.({ preventScroll: true });
      this.points = []; this.level = this.analysis = this.sourceAnalysis = this.collisionIndex = null; this.recentLayouts = [];
      if (P.instance === this) delete P.instance;
      try { globalThis.chrome?.runtime?.sendMessage({ type: 'PAGEPATH_CLOSED' })?.catch?.(() => {}); } catch { /* Extension reloaded. */ }
    }
  }
  P.Game = Game; P.States = STATES;
})();
