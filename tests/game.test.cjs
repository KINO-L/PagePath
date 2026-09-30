'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { setMaxListeners } = require('node:events');

function harness(rects = [], pixelAnalysis = null) {
  const frames = new Map(), timers = new Map(), targets = [], generatedModes = [], generatedHistories = [];
  let nextId = 1, generationCount = 0, watchStops = 0, watchCallback = null, restoredFocus = 0;
  class Target {
    constructor() { this.events = new Map(); this.captures = new Set(); targets.push(this); }
    addEventListener(name, callback, options = {}) {
      if (!this.events.has(name)) this.events.set(name, new Set());
      this.events.get(name).add(callback);
      options.signal?.addEventListener('abort', () => this.events.get(name)?.delete(callback), { once: true });
    }
    dispatch(name, event = {}) { for (const callback of this.events.get(name) || []) callback(event); }
    focus() { document.activeElement = this; }
    hasPointerCapture(id) { return this.captures.has(id); }
    setPointerCapture(id) { this.captures.add(id); }
    releasePointerCapture(id) { this.captures.delete(id); this.dispatch('lostpointercapture', { pointerId: id }); }
  }
  class QuietAbortController extends AbortController {
    constructor() { super(); setMaxListeners(0, this.signal); }
  }
  const document = new Target();
  document.activeElement = { isConnected: true, focus() { restoredFocus++; } };
  document.hidden = false;
  const window = new Target();
  class Overlay {
    constructor(callbacks) {
      this.callbacks = callbacks; this.host = new Target(); this.surface = new Target();
      this.marked = new Set(); this.lastUpdate = {}; this.destroyed = false;
    }
    update(value) { this.lastUpdate = value; }
    renderPath(points) { this.path = points.slice(); }
    renderLevel(level) { this.level = level; this.renderHint(false); }
    renderHint(visible) { this.hintVisible = visible; }
    getReservedRects() { return []; }
    showDebug() {}
    resetNodes() { this.marked.clear(); }
    markNode(id) { this.marked.add(id); }
    setSnapshot(image) { this.snapshotImage = image; }
    setMap(analysis) { this.pixelMap = analysis; }
    clearSnapshot() { this.snapshotImage = null; }
    destroy() { this.destroyed = true; }
  }
  const context = vm.createContext({ document, window, AbortController: QuietAbortController,
    setTimeout(callback) { const id = nextId++; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(callback) { const id = nextId++; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  for (const name of ['config', 'collision', 'scoring', 'game']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/content', `${name}.js`), 'utf8'), context);
  }
  const P = context.__PAGEPATH__;
  const analysis = pixelAnalysis || { width: 800, height: 600, rects };
  const level = { nodes: [
    { id: 0, kind: 'start', x: 80, y: 80 },
    { id: 1, kind: 'checkpoint', x: 240, y: 80 },
    { id: 2, kind: 'checkpoint', x: 240, y: 240 },
    { id: 3, kind: 'finish', x: 80, y: 240 },
  ], referenceLength: 480, maxInk: 1000, difficulty: 20,
    obstacleIndex: pixelAnalysis ? P.Collision.createMaskIndex(pixelAnalysis) : P.Collision.createIndex(rects) };
  P.Overlay = Overlay;
  P.PageAnalyzer = { analyze() { throw new Error('DOM analysis must never run'); } };
  P.PageSnapshot = {
    available: () => true,
    capture: async () => ({ image: {}, analysis, destroy() {} }),
    watch(_snapshot, options) {
      watchCallback = options.onChange;
      const stop = () => { watchStops++; };
      stop.check = () => {};
      return stop;
    },
  };
  P.LevelGenerator = { generate(_analysis, _reserved, _random, mode, history) {
    generationCount++; generatedModes.push(mode);
    generatedHistories.push(JSON.parse(JSON.stringify(history)));
    return level;
  } };
  const game = new P.Game();
  // State-machine tests use an already captured map. Capture lifecycle tests
  // explicitly clear this fixture and supply their own asynchronous transport.
  game.snapshot = { image: {}, analysis, destroy() {} };
  P.instance = game;
  function paint() {
    const pending = [...frames];
    frames.clear();
    for (const [, callback] of pending) callback();
  }
  function runTimers() {
    const pending = [...timers];
    timers.clear();
    for (const [, callback] of pending) callback();
  }
  function pointer(x, y, extras = {}) {
    return { clientX: x, clientY: y, button: 0, buttons: 1, isPrimary: true,
      pointerId: 1, pointerType: 'mouse', preventDefault() {}, stopPropagation() {}, ...extras };
  }
  function ready() { game.start(); paint(); paint(); assert.equal(game.state, P.States.READY); }
  function down(x = level.nodes[0].x, y = level.nodes[0].y, extras) { game.pointerDown(pointer(x, y, extras)); }
  function move(x, y, extras) { game.pointerMove(pointer(x, y, { buttons: 0, ...extras })); }
  return { P, context, game, level, analysis, frames, timers, document, window, targets, generatedModes, generatedHistories,
    paint, runTimers, pointer, ready, down, move, changeLayout: reason => watchCallback(reason),
    counts: () => ({ generationCount, watchStops, restoredFocus }) };
}

test('checkpoint collection allows an arbitrary order and success reports a score', () => {
  const h = harness(); h.ready(); h.down();
  assert.equal(h.game.overlay.lastUpdate.state, h.P.States.DRAWING, 'folding begins immediately, before the next animation frame');
  h.move(240, 240);
  assert.equal(h.game.collected.has(2), true);
  assert.equal(h.game.collected.has(1), false);
  h.move(240, 80); h.move(80, 240);
  assert.equal(h.game.state, h.P.States.SUCCESS);
  assert.equal(h.game.collected.size, 4);
  assert.equal(h.game.pointerId, null);
  assert.ok(h.game.overlay.lastUpdate.score > 0);
  assert.ok(h.game.overlay.lastUpdate.efficiency > 0 && h.game.overlay.lastUpdate.efficiency <= 100);
  h.game.destroy();
});

test('an early finish is ignored until all checkpoints have been visited', () => {
  const h = harness(); h.ready(); h.down();
  h.move(80, 240);
  assert.equal(h.game.state, h.P.States.DRAWING);
  assert.equal(h.game.collected.has(3), false);
  h.move(240, 240); h.move(240, 80);
  assert.equal(h.game.state, h.P.States.DRAWING);
  h.move(80, 240);
  assert.equal(h.game.state, h.P.States.SUCCESS);
  h.game.destroy();
});

test('maze availability gates mode changes and an unlimited maze keeps the source map intact', () => {
  const h = harness();
  let available = false;
  h.P.MazeGenerator = { assess: () => ({ available, reason: available ? '' : '页面障碍分布不足' }) };
  h.ready();
  h.game.setMode('maze');
  assert.equal(h.game.mode, 'normal');
  assert.equal(h.counts().generationCount, 1);
  assert.equal(h.game.overlay.lastUpdate.mazeAvailability.reason, '页面障碍分布不足');
  available = true;
  h.game.generate(); h.paint(); h.paint();
  const regularGenerate = h.P.LevelGenerator.generate;
  const mazeAnalysis = { ...h.analysis, rects: [{ x: 400, y: 200, width: 4, height: 100 }] };
  const mazeLevel = { ...h.level, analysis: mazeAnalysis, unlimitedInk: true, maxInk: Infinity,
    inkMultiplier: Infinity, mode: 'maze',
    nodes: [{ id: 0, kind: 'start', x: 80, y: 80 }, { id: 1, kind: 'finish', x: 320, y: 80 }],
    obstacleIndex: h.P.Collision.createIndex(mazeAnalysis.rects) };
  h.P.LevelGenerator.generate = (...args) => args[3] === 'maze' ? mazeLevel : regularGenerate(...args);
  h.game.toggleHint();
  assert.equal(h.game.hintVisible, true);
  h.game.setMode('maze'); h.paint(); h.paint();
  assert.equal(h.game.analysis, mazeAnalysis);
  assert.equal(h.game.snapshot.analysis, h.analysis);
  assert.equal(h.game.collisionIndex, mazeLevel.obstacleIndex);
  assert.equal(h.game.overlay.lastUpdate.unlimitedInk, true);
  assert.match(h.game.overlay.lastUpdate.message, /墨水无限/);
  h.game.toggleHint(); h.game.overlay.callbacks.onHint();
  assert.equal(h.game.hintVisible, false, 'maze mode rejects the hint callback and clears an ordinary answer');
  assert.equal(h.game.overlay.hintVisible, false);
  h.down();
  for (let i = 0; i < 50; i++) { h.move(80, 350); h.move(80, 80); }
  assert.equal(h.game.state, h.P.States.DRAWING);
  assert.ok(h.game.length > h.level.maxInk * 10);
  h.move(320, 80);
  assert.equal(h.game.state, h.P.States.SUCCESS);
  assert.equal(h.game.collected.size, 2);
  assert.ok(Number.isFinite(h.game.overlay.lastUpdate.score));
  h.game.toggleHint();
  assert.equal(h.game.hintVisible, false, 'completing the maze does not re-enable its answer');
  h.game.setMode('normal'); h.paint(); h.paint();
  assert.equal(h.game.analysis, h.analysis);
  assert.equal(h.game.collisionIndex, h.level.obstacleIndex);
  assert.equal(h.game.overlay.lastUpdate.unlimitedInk, false);
  h.game.toggleHint();
  assert.equal(h.game.hintVisible, true, 'ordinary modes regain their route hint after returning from the maze');
  h.game.destroy();
});

test('maze cannot start or collect the finish through a thin wall', () => {
  const h = harness([{ x: 86, y: 60, width: 2, height: 40 }, { x: 240, y: 60, width: 2, height: 40 }]);
  h.P.MazeGenerator = { assess: () => ({ available: true }) };
  h.game.mode = 'maze';
  h.level.unlimitedInk = true; h.level.maxInk = Infinity;
  h.level.nodes = [{ id: 0, kind: 'start', x: 80, y: 80 }, { id: 1, kind: 'finish', x: 247, y: 80 }];
  h.ready(); h.down(92, 80);
  assert.equal(h.game.state, h.P.States.READY, 'the nearby start is separated by a wall');
  h.down(); h.move(80, 140); h.move(220, 140); h.move(220, 80); h.move(236, 80);
  assert.equal(h.game.state, h.P.States.DRAWING, 'finish radius alone must not complete across a wall');
  assert.equal(h.game.collected.size, 1);
  h.move(220, 80); h.move(220, 140); h.move(270, 140); h.move(270, 80); h.move(247, 80);
  assert.equal(h.game.state, h.P.States.SUCCESS);
  h.game.retry(); h.down(); h.move(92, 80);
  assert.equal(h.game.state, h.P.States.FAILED, 'infinite ink must not disable wall collisions');
  h.game.destroy();
});

test('moving the toolbar preserves criterion-based maze availability and the active map', () => {
  const h = harness();
  h.P.MazeGenerator = { assess: (...args) => {
    assert.equal(args.length, 1, 'toolbar reservations must not participate in unlocking');
    assert.equal(args[0], h.analysis);
    return { available: true, obstacleRatio: .563, occupiedRegions: 48 };
  } };
  h.ready();
  const original = h.game.level, generationCount = h.counts().generationCount;
  assert.equal(h.game.mazeAvailability.available, true);
  h.game.overlay.getReservedRects = () => [{ x: 0, y: 0, width: 800, height: 600 }];
  h.game.overlay.callbacks.onToolbarMove();
  assert.equal(h.game.mazeAvailability.available, true);
  assert.equal(h.game.overlay.lastUpdate.mazeAvailability.available, true);
  assert.equal(h.game.level, original);
  assert.equal(h.counts().generationCount, generationCount);
  h.game.destroy();
});

test('an unlocked maze generation failure preserves its screenshot and retries without creating a playable level', () => {
  const h = harness();
  const availability = { available: true, obstacleRatio: .563, occupiedRegions: 48,
    requirements: h.P.Config.MAZE_REQUIREMENTS };
  h.P.MazeGenerator = { assess: () => availability };
  h.ready();
  const snapshot = h.game.snapshot;
  h.game.overlay.setSnapshot(snapshot.image);
  let destroyed = 0, attempts = 0;
  snapshot.destroy = () => { destroyed++; };
  h.P.PageSnapshot.capture = () => { throw new Error('cached retries must not capture'); };
  const mazeLevel = { ...h.level, mode: 'maze', unlimitedInk: true, maxInk: Infinity,
    nodes: [h.level.nodes[0], { ...h.level.nodes.at(-1), id: 1 }] };
  h.P.LevelGenerator.generate = () => {
    if (++attempts === 1) throw Object.assign(new Error('现有通道未找到可解路线'), { code: 'MAZE_GENERATION_FAILED' });
    return mazeLevel;
  };
  h.game.setMode('maze'); h.paint(); h.paint();
  assert.equal(h.game.state, 'FAILED');
  assert.equal(h.game.generationFailed, true);
  assert.equal(h.game.mode, 'maze');
  assert.equal(h.game.snapshot, snapshot);
  assert.equal(h.game.overlay.snapshotImage, snapshot.image);
  assert.equal(h.game.sourceAnalysis, h.analysis);
  assert.equal(h.game.analysis, h.analysis);
  assert.equal(h.game.overlay.pixelMap, h.analysis);
  assert.equal(h.game.mazeAvailability, availability);
  assert.equal(h.game.level, null);
  assert.equal(h.game.collisionIndex, null);
  assert.equal(h.game.overlay.level, null);
  assert.equal(h.game.overlay.lastUpdate.unlimitedInk, true);
  assert.equal(h.game.overlay.lastUpdate.generationFailed, true);
  assert.match(h.game.overlay.lastUpdate.message, /第二关生成失败.*现有通道未找到可解路线.*新地图.*刷新.*切换/);
  assert.equal(h.timers.size, 0, 'generation errors must not start the drawing-failure retry timer');
  assert.equal(destroyed, 0);
  h.down(); h.move(240, 80); h.game.pointerUp(h.pointer(240, 80));
  h.game.retry(); h.game.toggleHint(); h.game.queueRender(); h.paint(); h.runTimers();
  h.game.overlay.callbacks.onToolbarMove();
  h.window.dispatch('keydown', { key: ' ', target: h.game.overlay.host, preventDefault() {} });
  assert.equal(h.game.state, 'FAILED', 'drawing, retries, hints and pending frames cannot activate a missing level');
  assert.equal(h.game.pointerId, null);
  assert.equal(h.game.points.length, 0);
  assert.equal(h.game.hintVisible, false);
  assert.equal(attempts, 1);
  h.game.overlay.callbacks.onNewPuzzle(); h.paint(); h.paint();
  assert.equal(attempts, 2);
  assert.equal(h.game.state, 'READY');
  assert.equal(h.game.generationFailed, false);
  assert.equal(h.game.snapshot, snapshot);
  assert.equal(h.game.level, mazeLevel);
  assert.equal(h.game.overlay.lastUpdate.unlimitedInk, true);
  h.game.destroy();
  assert.equal(destroyed, 1);
});

test('maze generation failure allows switching to an ordinary mode with the original map', () => {
  const h = harness();
  h.P.MazeGenerator = { assess: () => ({ available: true }) };
  h.ready();
  const snapshot = h.game.snapshot, regularGenerate = h.P.LevelGenerator.generate;
  h.P.LevelGenerator.generate = (...args) => {
    if (args[3] === 'maze') throw new Error('找不到有效迷宫');
    return regularGenerate(...args);
  };
  h.game.setMode('maze'); h.paint(); h.paint();
  assert.equal(h.game.generationFailed, true);
  h.game.setMode('normal'); h.paint(); h.paint();
  assert.equal(h.game.state, 'READY');
  assert.equal(h.game.generationFailed, false);
  assert.equal(h.game.snapshot, snapshot);
  assert.equal(h.game.sourceAnalysis, h.analysis);
  assert.equal(h.game.analysis, h.analysis);
  assert.equal(h.game.collisionIndex, h.level.obstacleIndex);
  assert.equal(h.game.overlay.lastUpdate.unlimitedInk, false);
  h.game.destroy();
});

function blockedPixelMap() {
  const width = 320, height = 240, area = width * height;
  return { kind: 'pixel-mask', width, height, maskWidth: width, maskHeight: height,
    obstacleMask: new Uint8Array(area).fill(1), walkableMask: new Uint8Array(area),
    distanceMap: new Float32Array(area), componentLabels: new Int32Array(area), components: [],
    contours: { segments: new Float32Array() }, stats: { obstacleRatio: 1, clearance: 2, walkableThreshold: 2 + Math.SQRT1_2 } };
}

test('a qualified page with no original floor preserves its star and the real mode callback generates a carved maze', () => {
  const analysis = blockedPixelMap(), h = harness([], analysis);
  for (const name of ['grid', 'pathfinding', 'levelGenerator', 'mazeCleanup', 'mazeRoute', 'mazeConnectors', 'routeMazeGenerator', 'mazeGenerator']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/content', `${name}.js`), 'utf8'), h.context);
  }
  const snapshot = h.game.snapshot, obstacle = analysis.obstacleMask.slice(), walkable = analysis.walkableMask.slice(), distance = analysis.distanceMap.slice();
  let disposed = 0, captures = 0;
  snapshot.destroy = () => { disposed++; };
  h.game.overlay.setSnapshot(snapshot.image);
  h.P.PageSnapshot.capture = () => { captures++; throw new Error('mode selection must reuse the captured screenshot'); };
  h.game.start(); h.paint(); h.paint();
  assert.equal(h.game.state, 'FAILED');
  assert.equal(h.game.mode, 'normal', 'the player chooses the star; do not silently change difficulty');
  assert.equal(h.game.generationFailed, true);
  assert.equal(h.game.mazeAvailability.available, true);
  assert.equal(h.game.overlay.lastUpdate.mazeAvailability.available, true);
  assert.match(h.game.overlay.lastUpdate.message, /当前页面空隙不足，可点击五角星进入第二关/);
  assert.equal(h.game.snapshot, snapshot);
  assert.equal(h.game.overlay.snapshotImage, snapshot.image);
  assert.equal(h.game.sourceAnalysis, analysis);
  assert.equal(h.game.analysis, analysis);
  assert.equal(h.game.overlay.pixelMap, analysis);
  assert.equal(h.game.level, null);
  assert.equal(h.game.overlay.level, null);
  assert.equal(h.game.collisionIndex, null);
  assert.equal(typeof h.game.unwatch, 'function');
  assert.equal(h.counts().watchStops, 0);
  assert.equal(h.timers.size, 0);
  h.down(); h.move(240, 80); h.game.pointerUp(h.pointer(240, 80));
  h.game.retry(); h.game.toggleHint(); h.game.queueRender(); h.paint(); h.runTimers();
  assert.equal(h.game.state, 'FAILED'); assert.equal(h.game.points.length, 0); assert.equal(h.game.collected.size, 0);
  assert.equal(h.game.pointerId, null); assert.equal(h.game.hintVisible, false);
  h.game.overlay.callbacks.onModeChange('maze'); h.paint(); h.paint();
  assert.equal(h.game.state, 'READY');
  assert.equal(h.game.mode, 'maze'); assert.equal(h.game.generationFailed, false);
  assert.equal(h.game.level.maze.kind, 'route-first');
  assert.equal(h.game.level.mazeFloorRects.length, 0);
  assert.ok(h.game.level.mazeCarvedPaths.length <= 3);
  assert.equal(h.game.level.nodes.length, 2);
  assert.equal(h.game.snapshot, snapshot); assert.equal(h.game.sourceAnalysis, analysis);
  assert.equal(h.game.collisionIndex.walkableMask, h.game.analysis.walkableMask);
  assert.notEqual(h.game.analysis, analysis);
  assert.equal(captures, 0); assert.equal(disposed, 0);
  assert.deepEqual(analysis.obstacleMask, obstacle); assert.deepEqual(analysis.walkableMask, walkable); assert.deepEqual(analysis.distanceMap, distance);
  const route = h.game.level.referencePath;
  h.down(route[0].x, route[0].y);
  for (const point of route.slice(1)) h.move(point.x, point.y);
  assert.equal(h.game.state, 'SUCCESS', 'the selected fallback is actually playable through the game pointer pipeline');
  h.game.destroy(); assert.equal(disposed, 1);
});

test('ordinary generation failure with an unlocked star retains viewport invalidation and cannot bypass a resize', () => {
  const h = harness([], blockedPixelMap());
  h.P.MazeGenerator = { assess: () => ({ available: true }) };
  h.P.LevelGenerator.generate = () => { throw new Error('no original background route'); };
  h.game.start(); h.paint(); h.paint();
  assert.equal(h.game.state, 'FAILED'); assert.equal(h.game.generationFailed, true);
  assert.equal(typeof h.game.unwatch, 'function');
  const snapshot = h.game.snapshot;
  h.changeLayout('窗口尺寸已变化');
  assert.equal(h.game.state, 'PAUSED'); assert.equal(h.game.generationFailed, false);
  assert.equal(h.game.mazeAvailability.available, false);
  assert.equal(h.game.unwatch, null); assert.equal(h.counts().watchStops, 1);
  h.game.overlay.callbacks.onModeChange('maze');
  assert.equal(h.game.mode, 'normal', 'stale eligibility never starts a maze from the previous viewport');
  assert.equal(h.game.snapshot, snapshot); assert.equal(h.game.level, null); assert.equal(h.game.collisionIndex, null);
  h.game.destroy();
});

test('an ordinary generation failure on an unqualified page still clears the source and unlock status', () => {
  const h = harness();
  h.P.MazeGenerator = { assess: () => ({ available: false }) };
  h.P.LevelGenerator.generate = () => { throw new Error('普通空隙不足'); };
  const snapshot = h.game.snapshot; let disposed = 0;
  snapshot.destroy = () => { disposed++; };
  h.game.start(); h.paint(); h.paint();
  assert.equal(h.game.state, 'PAUSED'); assert.equal(h.game.generationFailed, false);
  assert.equal(h.game.snapshot, null); assert.equal(h.game.sourceAnalysis, null);
  assert.equal(h.game.analysis, null); assert.equal(h.game.level, null); assert.equal(h.game.collisionIndex, null);
  assert.equal(h.game.mazeAvailability.available, false); assert.equal(h.game.unwatch, null); assert.equal(disposed, 1);
  assert.match(h.game.overlay.lastUpdate.message, /普通空隙不足/);
  h.game.destroy();
});

for (const stage of ['capture', 'assessment', 'watch', 'render']) test(`ordinary ${stage} errors do not masquerade as missing background on a qualified page`, async () => {
  const h = harness();
  h.P.MazeGenerator = { assess: () => ({ available: true }) };
  let generates = 0;
  const generate = h.P.LevelGenerator.generate;
  h.P.LevelGenerator.generate = (...args) => { generates++; return generate(...args); };
  if (stage === 'capture') {
    h.game.snapshot = null;
    h.P.PageSnapshot.capture = async () => { throw new Error('截图分析失败'); };
  } else if (stage === 'assessment') h.P.MazeGenerator.assess = () => { throw new Error('资格分析失败'); };
  else if (stage === 'watch') h.P.PageSnapshot.watch = () => { throw new Error('视口监听失败'); };
  else {
    const render = h.game.overlay.renderLevel;
    h.game.overlay.renderLevel = function (level) { if (level) throw new Error('界面绘制失败'); return render.call(this, level); };
  }
  h.game.start(); h.paint(); h.paint(); await new Promise(setImmediate);
  assert.equal(h.game.state, 'PAUSED'); assert.equal(h.game.generationFailed, false);
  assert.equal(h.game.snapshot, null); assert.equal(h.game.sourceAnalysis, null); assert.equal(h.game.analysis, null);
  assert.equal(h.game.level, null); assert.equal(h.game.collisionIndex, null); assert.equal(h.game.unwatch, null);
  assert.equal(h.game.mazeAvailability.available, false);
  assert.equal(generates, stage === 'render' ? 1 : 0);
  assert.doesNotMatch(h.game.overlay.lastUpdate.message, /五角星/);
  h.game.destroy();
});

test('maze generation failures keep viewport checks and can explicitly refresh the captured map', async () => {
  const h = harness();
  h.P.MazeGenerator = { assess: () => ({ available: true }) };
  h.ready();
  const snapshot = h.game.snapshot;
  let disposed = 0, captures = 0;
  snapshot.destroy = () => { disposed++; };
  h.P.LevelGenerator.generate = () => { throw new Error('通道无法形成迷宫'); };
  h.game.setMode('maze'); h.paint(); h.paint();
  h.changeLayout('窗口尺寸已变化');
  assert.equal(h.game.state, 'PAUSED');
  assert.equal(h.game.generationFailed, false);
  assert.equal(h.game.mazeAvailability.available, false, 'a stale screenshot must still invalidate its unlock measurements');
  const newAnalysis = { ...h.analysis };
  h.P.PageSnapshot.capture = async () => {
    captures++;
    return { image: {}, analysis: newAnalysis, destroy() {} };
  };
  h.game.overlay.callbacks.onRegenerate(); h.paint(); h.paint(); await new Promise(setImmediate);
  assert.equal(captures, 1);
  assert.equal(disposed, 1);
  assert.notEqual(h.game.snapshot, snapshot);
  assert.equal(h.game.sourceAnalysis, newAnalysis);
  assert.equal(h.game.state, 'FAILED');
  assert.equal(h.game.generationFailed, true);
  assert.equal(h.game.mazeAvailability.available, true);
  h.game.overlay.callbacks.onRegenerate(); h.paint(); h.paint(); await new Promise(setImmediate);
  assert.equal(captures, 2, 'explicit refresh is available directly from generation failure as well');
  h.game.destroy();
});

for (const stage of ['capture', 'assessment']) test(`a maze ${stage} error clears invalid source data instead of retaining an unlocked failure`, async () => {
  const h = harness();
  h.P.MazeGenerator = { assess: () => ({ available: true }) };
  h.ready();
  h.P.LevelGenerator.generate = () => { throw new Error('找不到有效迷宫'); };
  h.game.setMode('maze'); h.paint(); h.paint();
  assert.equal(h.game.generationFailed, true);
  if (stage === 'capture') h.P.PageSnapshot.capture = async () => { throw new Error('截图图像分析失败'); };
  else h.P.MazeGenerator.assess = () => { throw new Error('截图分析数据无效'); };
  h.game.overlay.callbacks.onRegenerate(); h.paint(); h.paint(); await new Promise(setImmediate);
  assert.equal(h.game.state, 'PAUSED');
  assert.equal(h.game.generationFailed, false);
  assert.equal(h.game.snapshot, null);
  assert.equal(h.game.sourceAnalysis, null);
  assert.equal(h.game.analysis, null);
  assert.equal(h.game.collisionIndex, null);
  assert.equal(h.game.mazeAvailability.available, false);
  assert.equal(h.game.overlay.snapshotImage, null);
  assert.equal(h.game.unwatch, null);
  assert.match(h.game.overlay.lastUpdate.message, /截图/);
  h.game.destroy();
});

test('a refreshed page that no longer supports a maze returns to a playable regular mode', () => {
  const h = harness();
  h.game.mode = 'maze';
  h.P.MazeGenerator = { assess: () => ({ available: false, reason: '需要更多分散的障碍' }) };
  h.ready();
  assert.equal(h.game.mode, 'normal');
  assert.equal(h.game.state, h.P.States.READY);
  assert.match(h.game.overlay.lastUpdate.message, /第二关暂不可用.*需要更多分散的障碍/);
  h.game.destroy();
});

test('one fast movement cannot win by crossing finish before the last checkpoint', () => {
  const h = harness();
  h.level.nodes[0] = { id: 0, kind: 'start', x: 60, y: 100 };
  h.level.nodes[1] = { id: 1, kind: 'checkpoint', x: 160, y: 100 };
  h.level.nodes[2] = { id: 2, kind: 'checkpoint', x: 360, y: 100 };
  h.level.nodes[3] = { id: 3, kind: 'finish', x: 260, y: 100 };
  h.ready(); h.down(); h.move(410, 100);
  assert.equal(h.game.state, h.P.States.DRAWING);
  assert.equal(h.game.collected.size, 3);
  assert.equal(h.game.collected.has(3), false);
  h.move(260, 100);
  assert.equal(h.game.state, h.P.States.SUCCESS);
  h.game.destroy();
});

test('winning movement stops at finish before later obstacles or viewport exit', () => {
  const h = harness([{ x: 520, y: 60, width: 25, height: 80 }]);
  h.level.nodes.forEach((node, i) => { node.x = 80 + i * 100; node.y = 100; });
  h.ready(); h.down(); h.move(900, 100);
  assert.equal(h.game.state, h.P.States.SUCCESS);
  assert.equal(h.game.points.at(-1).x, 368);
  assert.equal(h.game.length, 288);
  h.game.destroy();
});

test('collision checks complete sampled segments, and failure retries the same level', () => {
  const h = harness([{ x: 150, y: 65, width: 10, height: 30 }]);
  h.ready(); h.down(); h.move(240, 80);
  assert.equal(h.game.state, h.P.States.FAILED);
  assert.match(h.game.overlay.lastUpdate.message, /碰到/);
  assert.equal(h.game.collected.size, 1);
  const original = h.game.level;
  assert.equal(h.timers.size, 1);
  h.runTimers();
  assert.equal(h.game.state, h.P.States.READY);
  assert.equal(h.game.level, original);
  assert.equal(h.counts().generationCount, 1);
  assert.equal(h.game.length, 0);
  assert.equal(h.game.collected.size, 0);
  h.game.destroy();
});

test('toolbar reservations never leave invisible walls or interrupt click-to-draw after moving', () => {
  const h = harness();
  const originalRect = { x: 145, y: 65, width: 35, height: 35 };
  let toolbarRect = originalRect;
  h.game.overlay.getReservedRects = () => [toolbarRect];
  h.ready(); h.game.overlay.callbacks.onHint(); h.down();
  const original = { level: h.game.level, analysis: h.game.analysis, points: h.game.points,
    collected: h.game.collected, index: h.game.collisionIndex, budget: h.game.level.maxInk };
  // The overlay owns dragging; its geometry can move without touching the game.
  toolbarRect = { x: 210, y: 145, width: 60, height: 55 };
  assert.equal(h.game.level, original.level);
  assert.equal(h.game.analysis, original.analysis);
  assert.equal(h.game.points, original.points);
  assert.equal(h.game.collected, original.collected);
  assert.equal(h.game.collisionIndex, original.index);
  assert.equal(h.game.level.maxInk, original.budget);
  assert.equal(h.counts().generationCount, 1);
  assert.equal(h.game.length, 0);
  assert.equal(h.game.hintVisible, true);
  assert.equal(h.game.pointerId, 1);
  assert.equal(h.P.Collision.segmentHits(h.level.nodes[0], h.level.nodes[1], h.level.obstacleIndex), false,
    'toolbar reservations must never become collision geometry');
  h.move(240, 80);
  assert.equal(h.game.state, h.P.States.DRAWING, 'the vacated toolbar space is playable');
  h.move(240, 240);
  assert.equal(h.game.state, h.P.States.DRAWING, 'click-to-draw can pass beneath the folded toolbar');
  assert.equal(h.game.length, 320, 'only actual drawing consumes ink');
  assert.equal(h.game.pointerId, 1);
  h.move(80, 240);
  assert.equal(h.game.state, h.P.States.SUCCESS);
  h.game.destroy();
  assert.equal(h.game.collisionIndex, null);
});

test('moving controls never removes actual webpage obstacles from drawing or start hit checks', () => {
  const obstacle = { x: 150, y: 65, width: 10, height: 30 };
  const h = harness([obstacle]);
  h.game.overlay.getReservedRects = () => [{ x: 500, y: 400, width: 100, height: 48 }];
  h.ready(); h.down(); h.move(240, 80);
  assert.equal(h.game.state, h.P.States.FAILED);
  assert.match(h.game.overlay.lastUpdate.message, /碰到/);
  h.game.retry();
  h.level.nodes[0] = { id: 0, kind: 'start', x: 154, y: 80 };
  h.down();
  assert.equal(h.game.state, h.P.States.READY, 'starting inside real page content remains blocked');
  h.game.destroy();
});

test('each new page rebuilds drawing collisions and discards the previous index', () => {
  const h = harness([{ x: 150, y: 65, width: 10, height: 30 }]);
  h.ready();
  const original = h.game.collisionIndex;
  h.game.snapshot = { image: {}, analysis: { ...h.analysis, rects: [] }, destroy() {} };
  h.level.obstacleIndex = h.P.Collision.createIndex([]);
  h.game.generate();
  assert.equal(h.game.collisionIndex, null, 'generation cannot retain old collision geometry');
  h.paint(); h.paint();
  assert.notEqual(h.game.collisionIndex, original);
  assert.equal(h.game.collisionIndex, h.game.level.obstacleIndex, 'the game must share the route validation index');
  h.down(); h.move(240, 80);
  assert.equal(h.game.state, h.P.States.DRAWING, 'new analysis governs actual collisions');
  h.game.destroy();
});

test('exhausted ink fails; an immediate retry clears the previous retry timer', () => {
  const h = harness(); h.level.maxInk = 100;
  h.ready(); h.down(); h.move(240, 80);
  assert.equal(h.game.state, h.P.States.FAILED);
  assert.match(h.game.overlay.lastUpdate.message, /墨水/);
  h.down();
  assert.equal(h.game.state, h.P.States.DRAWING);
  assert.equal(h.timers.size, 0);
  h.runTimers();
  assert.equal(h.game.state, h.P.States.DRAWING);
  h.game.destroy();
});

test('dynamic budgets leave every raw jitter segment chargeable, including coalesced samples', () => {
  const samples = Array.from({ length: 40 }, (_, index) => ({ x: 81 + index, y: 80 + (index % 2 ? -1 : 1) }));
  const expectedLength = samples.reduce((sum, point, index) => {
    const previous = index ? samples[index - 1] : { x: 80, y: 80 };
    return sum + Math.hypot(point.x - previous.x, point.y - previous.y);
  }, 0);
  for (const batchSize of [1, 7]) {
    const h = harness(); h.game.mode = 'hell'; h.ready(); h.down();
    for (let index = 0; index < samples.length; index += batchSize) {
      const group = samples.slice(index, index + batchSize), last = group.at(-1);
      h.move(last.x, last.y, batchSize === 1 ? {} : {
        getCoalescedEvents: () => group.map(point => h.pointer(point.x, point.y)),
      });
    }
    assert.equal(h.game.state, h.P.States.DRAWING);
    assert.ok(Math.abs(h.game.length - expectedLength) < 1e-10, 'micro bends still spend their full raw arc length');
    assert.ok(h.game.length > 80, '40px of forward progress must not silently erase its alternating 1px lateral motion');
    assert.equal(h.game.points.length, 41);
    h.game.destroy();
  }
});

test('a starting click can be released and only its mouse can continue drawing without held buttons', () => {
  const h = harness(); h.ready();
  h.down(240, 80); assert.equal(h.game.state, h.P.States.READY);
  h.down(); h.move(240, 80, { pointerId: 99 });
  assert.equal(h.game.length, 0);
  assert.equal(h.game.overlay.surface.hasPointerCapture(1), false, 'a mouse click must not depend on capture surviving its release');
  h.game.pointerUp(h.pointer(100, 80, { buttons: 0 }));
  assert.equal(h.game.state, h.P.States.DRAWING);
  assert.equal(h.game.length, 20, 'the release still checks any final movement');
  h.game.overlay.surface.dispatch('lostpointercapture', { pointerId: 1 });
  assert.equal(h.game.state, h.P.States.DRAWING, 'mouse release/capture loss is not a drawing failure');
  h.move(240, 80); h.move(240, 240); h.move(80, 240);
  assert.equal(h.game.state, h.P.States.SUCCESS);
  assert.equal(h.game.pointerId, null);
  h.game.destroy();
});

test('pointer cancellation and leaving the viewport end click-to-draw, then the same start can retry', () => {
  const h = harness(); h.ready(); h.down();
  h.game.overlay.surface.dispatch('pointercancel', { pointerId: 1 });
  assert.equal(h.game.state, h.P.States.FAILED);
  assert.match(h.game.overlay.lastUpdate.message, /取消/);
  h.down(); h.move(100, 80, { buttons: 0 });
  assert.equal(h.game.state, h.P.States.DRAWING);
  h.game.overlay.surface.dispatch('pointerleave', { pointerId: 99 });
  assert.equal(h.game.state, h.P.States.DRAWING);
  h.game.overlay.surface.dispatch('pointerleave', { pointerId: 1 });
  assert.equal(h.game.state, h.P.States.FAILED);
  assert.equal(h.game.pointerId, null);
  assert.match(h.game.overlay.lastUpdate.message, /离开/);
  h.down(); h.game.pointerUp(h.pointer(80, 80, { buttons: 0 }));
  assert.equal(h.game.state, h.P.States.DRAWING);
  assert.equal(h.timers.size, 0, 'a new starting click cancels the pending failure retry');
  h.game.destroy();
});

test('touch dragging still captures the active pointer and its release finishes the stroke', () => {
  const h = harness(); h.ready(); h.down(80, 80, { pointerType: 'touch' });
  assert.equal(h.game.overlay.surface.hasPointerCapture(1), true);
  h.game.pointerUp(h.pointer(100, 80, { pointerType: 'touch', buttons: 0 }));
  assert.equal(h.game.state, h.P.States.FAILED);
  assert.equal(h.game.overlay.surface.hasPointerCapture(1), false);
  h.game.destroy();
});

test('coalesced movement checks intermediate samples rather than a shortcut', () => {
  const h = harness([{ x: 150, y: 105, width: 30, height: 30 }]);
  h.ready(); h.down();
  h.move(240, 80, { getCoalescedEvents: () => [h.pointer(160, 120), h.pointer(240, 80)] });
  assert.equal(h.game.state, h.P.States.FAILED);
  assert.match(h.game.overlay.lastUpdate.message, /碰到/);
  h.game.destroy();
});

test('viewport changes pause safely and recapturing explicitly resumes play', async () => {
  const h = harness(); h.ready(); h.down();
  h.changeLayout('Page layout changed');
  assert.equal(h.game.state, h.P.States.PAUSED);
  assert.equal(h.game.pointerId, null);
  assert.equal(h.counts().watchStops, 1);
  h.game.retry(); h.down();
  assert.equal(h.game.state, h.P.States.PAUSED);
  h.game.overlay.callbacks.onRegenerate(); h.paint(); h.paint();
  await new Promise(setImmediate);
  assert.equal(h.game.state, h.P.States.READY);
  assert.equal(h.counts().generationCount, 2);
  h.game.destroy();
});

test('Escape destroys listeners, observers, pointer state, timers and pending rendering', () => {
  const h = harness(); h.ready(); h.down();
  h.game.overlay.surface.dispatch('pointercancel', { pointerId: 1 });
  assert.ok(h.timers.size > 0 && h.frames.size > 0);
  h.document.activeElement = h.game.overlay.host;
  h.window.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(h.game.state, h.P.States.DESTROYED);
  assert.equal(h.P.instance, undefined);
  assert.equal(h.frames.size, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.game.overlay.destroyed, true);
  assert.equal(h.game.pointerId, null);
  assert.equal(h.game.level, null);
  assert.equal(h.counts().watchStops, 1);
  assert.equal(h.counts().restoredFocus, 1);
  assert.ok(h.targets.every(target => [...target.events.values()].every(listeners => listeners.size === 0)));
  h.game.destroy();
  assert.equal(h.counts().watchStops, 1, 'destroy must be idempotent');
});

for (const state of ['READY', 'DRAWING', 'GENERATING']) {
  test(`right click exits ${state} and releases the complete game session`, () => {
    const h = harness();
    if (state === 'GENERATING') { h.game.start(); h.paint(); }
    else {
      h.ready();
      if (state === 'DRAWING') { h.down(); h.move(140, 80); }
    }
    assert.equal(h.game.state, state);
    if (state === 'DRAWING') assert.equal(h.game.pointerId, 1);
    if (state !== 'READY') assert.ok(h.frames.size > 0);
    let prevented = 0, stopped = 0;
    h.document.activeElement = h.game.overlay.host;
    h.game.overlay.host.dispatch('contextmenu', {
      button: 2, preventDefault() { prevented++; }, stopImmediatePropagation() { stopped++; },
    });
    assert.equal(prevented, 1, 'right click must not open the webpage context menu');
    assert.equal(stopped, 1, 'the exit gesture must not reach page handlers');
    assert.equal(h.game.state, h.P.States.DESTROYED);
    assert.equal(h.P.instance, undefined);
    assert.equal(h.game.events.signal.aborted, true);
    assert.equal(h.game.overlay.destroyed, true);
    assert.equal(h.game.overlay.surface.captures.size, 0);
    assert.equal(h.game.pointerId, null);
    assert.equal(h.game.level, null);
    assert.equal(h.game.analysis, null);
    assert.equal(h.game.points.length, 0);
    assert.equal(h.game.collected.size, 0);
    assert.equal(h.game.recentLayouts.length, 0);
    assert.equal(h.frames.size, 0);
    assert.equal(h.timers.size, 0);
    assert.equal(h.counts().watchStops, state === 'GENERATING' ? 0 : 1);
    assert.equal(h.counts().restoredFocus, 1);
    assert.ok(h.targets.every(target => [...target.events.values()].every(listeners => listeners.size === 0)));
    h.paint(); h.runTimers();
    assert.equal(h.game.state, h.P.States.DESTROYED);
    assert.equal(h.counts().generationCount, state === 'GENERATING' ? 0 : 1);
  });
}

test('closing during generation cancels the second frame before analysis starts', () => {
  const h = harness(); h.game.start(); h.paint();
  assert.equal(h.game.state, h.P.States.GENERATING);
  assert.equal(h.frames.size, 1);
  h.game.destroy(); h.paint();
  assert.equal(h.counts().generationCount, 0);
  assert.equal(h.frames.size, 0);
});

for (const mode of ['hell', 'immortal']) test(`${mode}: difficulty switches persist through retry and New Puzzle, with active attempts guarded`, () => {
  const h = harness(); h.ready();
  assert.equal(h.game.mode, 'normal');
  h.game.overlay.callbacks.onModeChange(mode);
  assert.equal(h.game.state, 'GENERATING');
  h.game.setMode('normal');
  assert.equal(h.game.mode, mode, 'a second change during generation is ignored');
  h.paint(); h.paint();
  assert.equal(h.game.state, 'READY');
  assert.equal(h.game.overlay.lastUpdate.mode, mode);
  assert.match(h.game.overlay.lastUpdate.message, mode === 'hell' ? /糕手.*6%/ : /神仙.*4%/);
  h.down(); h.game.setMode('normal');
  assert.equal(h.game.mode, mode, 'drawing cannot switch difficulty');
  h.game.fail('retry'); h.game.retry();
  assert.equal(h.game.mode, mode);
  h.game.overlay.callbacks.onNewPuzzle(); h.paint(); h.paint();
  assert.deepEqual(h.generatedModes, ['normal', mode, mode]);
  h.game.setMode('unknown'); h.game.setMode(mode);
  assert.equal(h.counts().generationCount, 3, 'invalid and unchanged modes do not regenerate');
  h.game.setMode('normal'); h.paint(); h.paint();
  assert.equal(h.game.mode, 'normal');
  assert.deepEqual(h.generatedModes, ['normal', mode, mode, 'normal']);
  h.game.destroy(); h.game.setMode(mode);
  assert.equal(h.game.state, 'DESTROYED');
});

test('New Puzzle uses only four recent coordinate layouts and Retry keeps the same map', () => {
  const h = harness(); h.ready();
  assert.deepEqual(h.generatedHistories, [[]]);
  assert.equal(h.game.recentLayouts.length, 1);
  const first = JSON.stringify(h.game.recentLayouts[0]);
  h.level.nodes[0].x += 1;
  assert.equal(JSON.stringify(h.game.recentLayouts[0]), first, 'history contains copies of positions, not live level objects');
  h.game.retry();
  assert.equal(h.counts().generationCount, 1);
  assert.equal(h.game.recentLayouts.length, 1);
  for (let i = 0; i < 5; i++) {
    h.game.overlay.callbacks.onNewPuzzle(); h.paint(); h.paint();
  }
  assert.deepEqual(h.generatedHistories.map(layouts => layouts.length), [0, 1, 2, 3, 4, 4]);
  assert.equal(h.game.recentLayouts.length, 4);
  for (const layout of h.game.recentLayouts) {
    assert.equal(layout.length, h.level.nodes.length);
    assert.deepEqual(Object.keys(layout[0]).sort(), ['x', 'y'], 'history retains no screenshots or grids');
  }
  h.game.setMode('hell'); h.paint(); h.paint();
  assert.equal(h.generatedHistories.at(-1).length, 4, 'same-page mode changes also avoid recently occupied positions');
  h.game.destroy();
  assert.equal(h.game.recentLayouts.length, 0);
});

test('layout history follows cached screenshot identity and resets on a new capture', async () => {
  const h = harness([{ x: 400, y: 400, width: 30, height: 30 }]); h.ready();
  h.game.generate(); h.paint(); h.paint();
  assert.equal(h.generatedHistories.at(-1).length, 1);
  h.game.snapshot = { image: {}, analysis: { ...h.analysis }, destroy() {} };
  h.game.generate(); h.paint(); h.paint();
  assert.deepEqual(h.generatedHistories.at(-1), [], 'equal dimensions do not make separate captures the same image');
  h.game.generate(); h.paint(); h.paint();
  assert.equal(h.generatedHistories.at(-1).length, 1);
  h.game.overlay.callbacks.onRegenerate(); h.paint(); h.paint();
  await new Promise(setImmediate);
  assert.deepEqual(h.generatedHistories.at(-1), [], 'recapturing starts a fresh page history');
  h.P.LevelGenerator.generate = () => { throw new Error('No available layout'); };
  h.game.generate(); h.paint(); h.paint();
  assert.equal(h.game.state, 'PAUSED');
  assert.equal(h.game.recentLayouts.length, 1, 'failed generation does not enter history');
  h.game.destroy();
});

test('game keyboard blocking permits native difficulty controls while still preventing page scroll', () => {
  const h = harness(); h.ready();
  let blocked = 0;
  const event = { key: 'Home', target: h.game.overlay.host, preventDefault() { blocked++; } };
  h.window.dispatch('keydown', { ...event, composedPath: () => [{ closest: () => ({ tagName: 'SELECT' }) }] });
  assert.equal(blocked, 0);
  h.window.dispatch('keydown', { ...event, key: 'ArrowRight', composedPath: () => [{ closest: selector => {
    assert.ok(selector.split(',').includes('button'));
    return { tagName: 'BUTTON', className: 'drag-handle' };
  } }] });
  assert.equal(blocked, 0, 'the focused toolbar drag handle can receive arrow keys');
  h.window.dispatch('keydown', event);
  assert.equal(blocked, 1);
  h.game.destroy();
});

test('the answer toggle preserves the attempt, stays for retries, and resets for new maps and pauses', () => {
  const h = harness(); h.ready();
  assert.equal(h.game.hintVisible, false);
  assert.equal(h.game.overlay.hintVisible, false);
  const original = { level: h.game.level, points: h.game.points, collected: h.game.collected,
    length: h.game.length, budget: h.game.level.maxInk, generations: h.counts().generationCount };
  h.game.overlay.callbacks.onHint();
  assert.equal(h.game.hintVisible, true);
  assert.equal(h.game.overlay.hintVisible, true);
  assert.equal(h.game.overlay.lastUpdate.hintVisible, true);
  assert.equal(h.game.level, original.level);
  assert.equal(h.game.points, original.points);
  assert.equal(h.game.collected, original.collected);
  assert.equal(h.game.length, original.length);
  assert.equal(h.game.level.maxInk, original.budget);
  assert.equal(h.counts().generationCount, original.generations);
  h.game.retry();
  assert.equal(h.game.hintVisible, true);
  h.down(); h.move(140, 80);
  const drawingLength = h.game.length, drawingPoints = h.game.points.length;
  h.game.overlay.callbacks.onHint();
  assert.equal(h.game.hintVisible, true, 'a drawing gesture cannot toggle the answer');
  assert.equal(h.game.length, drawingLength);
  assert.equal(h.game.points.length, drawingPoints);
  h.game.fail('test retry'); h.game.overlay.callbacks.onHint();
  assert.equal(h.game.hintVisible, false, 'a failed attempt can hide the answer');
  assert.equal(h.game.length, drawingLength);
  h.game.overlay.callbacks.onHint(); h.runTimers();
  assert.equal(h.game.state, h.P.States.READY);
  assert.equal(h.game.hintVisible, true, 'automatic retry keeps the answer visible');
  h.game.generate();
  assert.equal(h.game.hintVisible, false);
  assert.equal(h.game.overlay.hintVisible, false);
  h.game.overlay.callbacks.onHint();
  assert.equal(h.game.hintVisible, false, 'generation cannot toggle a missing answer');
  h.paint(); h.paint(); h.game.overlay.callbacks.onHint();
  h.game.setMode('hell'); h.paint(); h.paint();
  assert.equal(h.game.hintVisible, false, 'a mode switch clears the old map answer');
  assert.equal(h.game.overlay.hintVisible, false);
  h.game.overlay.callbacks.onHint();
  h.changeLayout('layout changed');
  assert.equal(h.game.hintVisible, false);
  assert.equal(h.game.overlay.hintVisible, false);
  h.game.overlay.callbacks.onHint();
  assert.equal(h.game.hintVisible, false, 'a paused map cannot display stale geometry');
  h.game.destroy(); h.game.overlay.callbacks.onHint();
  assert.equal(h.game.hintVisible, false);
});

test('showing the answer never bypasses ink consumption or changes a completed score', () => {
  const h = harness(); h.ready(); h.game.overlay.callbacks.onHint();
  h.level.maxInk = 100; h.down(); h.move(240, 80);
  assert.equal(h.game.state, h.P.States.FAILED);
  assert.match(h.game.overlay.lastUpdate.message, /墨水/);
  h.level.maxInk = 1000; h.game.retry(); h.down();
  h.move(240, 80); h.move(240, 240); h.move(80, 240);
  assert.equal(h.game.state, h.P.States.SUCCESS);
  const length = h.game.length, score = h.game.overlay.lastUpdate.score;
  h.game.overlay.callbacks.onHint();
  assert.equal(h.game.state, h.P.States.SUCCESS);
  assert.equal(h.game.length, length);
  assert.equal(h.game.overlay.lastUpdate.score, score);
  assert.equal(h.game.collected.size, h.game.level.nodes.length);
  h.game.destroy();
});

test('actual generated reference routes win through the full game state machine', () => {
  const h = harness([
    { x: 190, y: 110, width: 165, height: 180 },
    { x: 445, y: 110, width: 165, height: 180 },
    { x: 190, y: 365, width: 165, height: 120 },
    { x: 445, y: 365, width: 165, height: 120 },
  ]);
  for (const name of ['grid', 'pathfinding', 'levelGenerator']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/content', `${name}.js`), 'utf8'), h.context);
  }
  const generate = h.P.LevelGenerator.generate;
  for (let seed = 1; seed <= 8; seed++) {
    let state = seed;
    const rng = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
    h.P.LevelGenerator = { generate: (analysis, reserved, _random, mode, history) => generate(analysis, reserved, rng, mode, history) };
    h.game.generate(); h.paint(); h.paint();
    assert.equal(h.game.state, h.P.States.READY);
    const level = h.game.level, start = level.nodes[0];
    h.down(start.x, start.y);
    for (const point of level.referencePath.slice(1)) h.move(point.x, point.y);
    assert.equal(h.game.state, h.P.States.SUCCESS, `reference route must complete seed ${seed}`);
    assert.equal(h.game.collected.size, level.nodes.length);
    assert.ok(h.game.length <= level.maxInk);
  }
  h.game.destroy();
});

test('all three modes finish through the real game using one shared pixel map, including a narrow doorway', () => {
  const width = 960, height = 640;
  const walkableMask = new Uint8Array(width * height).fill(1);
  const obstacleMask = new Uint8Array(width * height);
  const distanceMap = new Float32Array(width * height).fill(30);
  const componentLabels = new Int32Array(width * height).fill(1);
  // This is an already-cleared player-center mask: two rooms are joined by a
  // three-pixel doorway deliberately misaligned with the old 16px grid.
  for (let y = 0; y < height; y++) for (let x = 476; x < 483; x++) {
    if (y >= 317 && y < 320) continue;
    const id = y * width + x;
    walkableMask[id] = 0; obstacleMask[id] = 1; distanceMap[id] = 0; componentLabels[id] = 0;
  }
  const analysis = { kind: 'pixel-mask', width, height, maskWidth: width, maskHeight: height,
    walkableMask, obstacleMask, distanceMap, componentLabels, components: [{ label: 1, area: walkableMask.reduce((a, b) => a + b, 0) }], stats: {} };
  for (const mode of ['normal', 'hell', 'immortal']) {
    const h = harness([], analysis);
    for (const name of ['grid', 'pathfinding', 'levelGenerator']) {
      vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/content', `${name}.js`), 'utf8'), h.context);
    }
    const generate = h.P.LevelGenerator.generate;
    h.game.mode = mode;
    for (let seed = 1; seed <= 4; seed++) {
      let state = seed;
      const rng = () => { state = Math.imul(state, 1664525) + 1013904223 | 0; return (state >>> 0) / 4294967296; };
      h.P.LevelGenerator = { generate: (page, reserved, _random, selectedMode, history) => generate(page, reserved, rng, selectedMode, history) };
      h.game.generate(); h.paint(); h.paint();
      assert.equal(h.game.state, h.P.States.READY, `${mode}, seed ${seed}: ${h.game.overlay.lastUpdate.message}`);
      const level = h.game.level;
      assert.equal(h.game.collisionIndex, level.obstacleIndex);
      assert.equal(h.game.collisionIndex.walkableMask, analysis.walkableMask);
      assert.ok(level.nodes.some(node => node.x < 476) && level.nodes.some(node => node.x > 483));
      for (const style of ['segments', 'coalesced']) {
        h.game.retry(); h.game.overlay.callbacks.onHint();
        h.down(level.nodes[0].x, level.nodes[0].y);
        const samples = style === 'segments' ? level.referencePath.slice(1) : sampleReference(level.referencePath, 5);
        for (let i = 0; i < samples.length; i += style === 'segments' ? 1 : 9) {
          const group = samples.slice(i, i + (style === 'segments' ? 1 : 9));
          const last = group.at(-1);
          h.move(last.x, last.y, style === 'segments' ? {} : {
            getCoalescedEvents: () => group.map(point => h.pointer(point.x, point.y)),
          });
        }
        assert.equal(h.game.state, h.P.States.SUCCESS, `${mode}, seed ${seed}, ${style}: ${h.game.overlay.lastUpdate.message}`);
        assert.equal(h.game.collected.size, level.nodes.length);
        assert.ok(h.game.length <= level.maxInk);
      }
    }
    h.game.destroy();
  }
});

const advancedLayouts = {
  blank: { width: 1200, height: 760, rects: [] },
  article: { width: 1200, height: 760, rects: [
    { x: 200, y: 90, width: 730, height: 72 },
    ...Array.from({ length: 18 }, (_, i) => ({ x: 260, y: 200 + i * 23, width: 610 + i % 3 * 14, height: 17 })),
  ] },
  github: { width: 1200, height: 760, rects: [
    { x: 0, y: 0, width: 1200, height: 62 },
    { x: 28, y: 100, width: 180, height: 470 },
    { x: 276, y: 146, width: 690, height: 360 },
    { x: 1000, y: 100, width: 178, height: 290 },
  ] },
  dashboard: { width: 1200, height: 760, rects: Array.from({ length: 6 }, (_, i) => ({
    x: 100 + i % 3 * 350, y: 110 + Math.floor(i / 3) * 285, width: 270, height: 210,
  })) },
  ecommerce: { width: 1200, height: 760, rects: Array.from({ length: 8 }, (_, i) => ({
    x: 75 + i % 4 * 280, y: 90 + Math.floor(i / 4) * 300, width: 215, height: 235,
  })) },
  spa: { width: 1200, height: 760, rects: [
    { x: 0, y: 0, width: 1200, height: 64 },
    { x: 0, y: 64, width: 192, height: 696 },
    { x: 272, y: 130, width: 590, height: 350 },
    { x: 920, y: 180, width: 180, height: 400 },
  ] },
  small: { width: 180, height: 180, rects: [] },
  corridor: { width: 800, height: 760, rects: [
    { x: 0, y: 0, width: 360, height: 760 },
    { x: 440, y: 0, width: 360, height: 760 },
  ] },
};

function sampleReference(route, step, rounded = false) {
  const samples = [];
  for (let i = 1; i < route.length; i++) {
    const from = route[i - 1], to = route[i];
    const count = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / step);
    for (let j = 1; j <= count; j++) {
      const x = from.x + (to.x - from.x) * j / count;
      const y = from.y + (to.y - from.y) * j / count;
      samples.push({ x: rounded ? Math.round(x) : x, y: rounded ? Math.round(y) : y });
    }
  }
  return samples;
}

for (const mode of ['hell', 'immortal']) for (const [name, analysis] of Object.entries(advancedLayouts)) {
  test(`${mode} answer wins with full segments, sampled movement and coalesced events: ${name}, 10 seeds`, () => {
    const h = harness(analysis.rects);
    Object.assign(h.analysis, analysis);
    for (const module of ['grid', 'pathfinding', 'levelGenerator']) {
      vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/content', `${module}.js`), 'utf8'), h.context);
    }
    const generate = h.P.LevelGenerator.generate;
    h.game.mode = mode;
    if (analysis.width === 1200) {
      h.game.overlay.getReservedRects = () => [{ x: 300, y: 12, width: 600, height: 52 }];
    }
    for (let seed = 1; seed <= 10; seed++) {
      let state = seed;
      const rng = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
      h.P.LevelGenerator = { generate: (page, reserved, _random, mode, history) => generate(page, reserved, rng, mode, history) };
      h.game.generate(); h.paint(); h.paint();
      assert.equal(h.game.state, h.P.States.READY, `${name}, seed ${seed}: map generation failed`);
      const level = h.game.level, start = level.nodes[0];
      const inkMultiplier = h.P.getInkMultiplier(mode, level.nodes.length);
      const originalBudget = level.maxInk;
      assert.equal(level.mode, mode);
      assert.equal(level.inkMultiplier, inkMultiplier);
      assert.equal(level.maxInk, level.referenceLength * inkMultiplier);
      const remeasured = level.referencePath.slice(1).reduce((sum, at, i) => sum +
        h.P.Collision.distance(level.referencePath[i], at), 0);
      assert.ok(Math.abs(remeasured - level.referenceLength) < 1e-8,
        'budget must use the full displayed answer, including every obstacle detour');
      for (const style of ['segments', 'sampled', 'coalesced']) {
        h.game.retry();
        assert.equal(h.game.level, level, 'retry must keep the generated map and its stored budget');
        assert.equal(level.maxInk, originalBudget, 'retry must not recalculate or stack the dynamic allowance');
        assert.equal(level.inkMultiplier, inkMultiplier);
        const displayedAllowance = h.game.overlay.lastUpdate.message.match(/墨水余量\s*([\d.]+)%/);
        assert.ok(displayedAllowance, 'the ready instruction should state the current map allowance');
        assert.equal(Number(displayedAllowance[1]), Math.round((inkMultiplier - 1) * 1000) / 10);
        if (!h.game.hintVisible) h.game.overlay.callbacks.onHint();
        assert.equal(h.game.overlay.lastUpdate.ink, 100, 'revealing the answer must not consume ink');
        h.down(start.x, start.y);
        const samples = style === 'segments' ? level.referencePath.slice(1)
          : sampleReference(level.referencePath, 7, style === 'sampled');
        if (style === 'coalesced') {
          for (let i = 0; i < samples.length; i += 11) {
            const group = samples.slice(i, i + 11), endpoint = group.at(-1);
            h.move(endpoint.x, endpoint.y, {
              getCoalescedEvents: () => group.map(point => h.pointer(point.x, point.y)),
            });
          }
        } else {
          for (const point of samples) h.move(point.x, point.y);
        }
        const label = `${name}, seed ${seed}, ${style}: ${h.game.overlay.lastUpdate.message}`;
        assert.equal(h.game.state, h.P.States.SUCCESS, label);
        assert.equal(h.game.collected.size, level.nodes.length, label);
        assert.ok(h.game.length <= level.maxInk, label);
        assert.ok(level.maxInk - h.game.length >= level.referenceLength * (inkMultiplier - 1 - 0.005),
          `${label}: following the answer should preserve essentially all spare ink`);
        assert.equal(h.game.overlay.lastUpdate.ink, Math.ceil(100 * (1 - h.game.length / level.maxInk)),
          'the ink indicator must report the selected difficulty budget while the answer is visible');
        assert.equal(h.game.hintVisible, true);
        h.paint();
      }
    }
    h.game.destroy();
  });
}

test('snapshot games reuse frozen analysis for mode switches and New Puzzle, and refresh a paused viewport', async () => {
  const h = harness();
  h.game.snapshot = null;
  let captures = 0, disposed = 0, viewportCallback;
  h.P.PageSnapshot = {
    available: () => true,
    capture: async () => ({ mode: 'screenshot', image: {}, analysis: h.analysis, destroy() { disposed++; } }),
    watch(_snapshot, { onChange }) { viewportCallback = onChange; const stop = () => {}; stop.check = () => {}; return stop; }
  };
  const capture = h.P.PageSnapshot.capture;
  h.P.PageSnapshot.capture = options => { captures++; return capture(options); };
  h.game.start(); h.paint(); h.paint(); await new Promise(setImmediate);
  assert.equal(h.game.state, 'READY');
  const initial = h.game.snapshot;
  assert.equal(h.counts().watchStops, 0, 'live DOM watcher is not installed in snapshot mode');
  h.P.PageAnalyzer.analyze = () => { throw new Error('Must reuse frozen map'); };
  h.game.overlay.callbacks.onNewPuzzle(); h.paint(); h.paint();
  assert.equal(h.game.state, 'READY');
  assert.equal(h.game.snapshot, initial);
  assert.equal(captures, 1);
  h.game.setMode('hell'); h.paint(); h.paint();
  assert.equal(h.game.snapshot, initial);
  assert.equal(captures, 1, 'mode changes use the same static page');
  viewportCallback('窗口尺寸已变化');
  assert.equal(h.game.state, 'PAUSED');
  h.game.setMode('normal'); h.paint(); h.paint(); await new Promise(setImmediate);
  assert.equal(h.game.state, 'READY');
  assert.notEqual(h.game.snapshot, initial);
  assert.equal(captures, 2);
  assert.equal(disposed, 1);
  h.game.overlay.callbacks.onRegenerate(); h.paint(); h.paint(); await new Promise(setImmediate);
  assert.equal(h.game.state, 'READY');
  assert.equal(captures, 3, 'explicit regeneration also refreshes the screenshot');
  h.game.destroy();
  assert.equal(disposed, 3);
});

test('closing while a capture is pending aborts it and a late result cannot resurrect the game', async () => {
  const h = harness();
  h.game.snapshot = null;
  let complete, captureSignal, disposed = 0;
  h.P.PageSnapshot = {
    available: () => true,
    capture: ({ signal }) => { captureSignal = signal; return new Promise(resolve => { complete = resolve; }); }
  };
  h.game.start(); h.paint(); h.paint();
  assert.equal(h.game.state, 'GENERATING');
  h.game.destroy();
  assert.equal(captureSignal.aborted, true);
  complete({ image: {}, analysis: h.analysis, destroy() { disposed++; } });
  await new Promise(setImmediate);
  assert.equal(h.game.state, 'DESTROYED');
  assert.equal(h.game.snapshot, null);
  assert.equal(h.game.overlay.snapshotImage, undefined);
  assert.equal(h.counts().generationCount, 0);
  assert.equal(disposed, 1);
});

test('capture failure shows a recoverable error instead of silently playing an unfrozen webpage', async () => {
  const h = harness();
  h.game.snapshot = null;
  h.P.PageSnapshot = { available: () => true, capture: async () => { throw new Error('请保持当前标签页在前台后重试'); } };
  h.game.start(); h.paint(); h.paint(); await new Promise(setImmediate);
  assert.equal(h.game.state, 'PAUSED');
  assert.match(h.game.overlay.lastUpdate.message, /前台/);
  assert.equal(h.game.snapshot, null);
  assert.equal(h.counts().generationCount, 0);
  h.game.destroy();
});
