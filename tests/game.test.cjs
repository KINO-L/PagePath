'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { setMaxListeners } = require('node:events');

function harness(rects = [], pixelAnalysis = null) {
  const frames = new Map(), timers = new Map(), targets = [], generatedHistories = [];
  let storedProfile, saveFailures = 0;
  const messages = [];
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
    renderLevel(level) { this.level = level; }
    updateCollectibles(ids, collection) { this.collectedIds = ids.slice(); this.collection = { ...collection }; }
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
    chrome: { runtime: { async sendMessage(message) {
      messages.push(message);
      const P = context.__PAGEPATH__;
      storedProfile ||= P.Progression.empty();
      if (message.type === 'PAGEPATH_PROFILE') return { ok: true, profile: P.Progression.view(storedProfile), profileData: storedProfile };
      if (message.type === 'PAGEPATH_COMPLETE') {
        if (saveFailures > 0) { saveFailures--; throw new Error('temporary storage failure'); }
        const score = P.Scoring.calculate(message.level, message.stats);
        const award = P.Progression.award(storedProfile, { ...score, runId: message.runId });
        storedProfile = award.profile;
        return { ok: true, profile: P.Progression.view(storedProfile), profileData: storedProfile,
          result: { ...score, xp: award.rewardXp, awarded: award.awarded, previousLevel: award.previousLevel,
            level: award.level, leveledUp: award.leveledUp } };
      }
    } } },
    setTimeout(callback) { const id = nextId++; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(callback) { const id = nextId++; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  for (const name of ['config', 'collision', 'scoring', 'progression', 'game']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/content', `${name}.js`), 'utf8'), context);
  }
  const P = context.__PAGEPATH__;
  const analysis = pixelAnalysis || { width: 800, height: 600, rects };
  const level = { nodes: [
    { id: 0, kind: 'start', x: 80, y: 80 },
    { id: 1, kind: 'finish', x: 240, y: 240 },
  ], analysis, maze: {}, referenceLength: 320, difficulty: 30, challenge: { turns: 1, deadEnds: 2, complexity: 0.4 },
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
  P.LevelGenerator = { generate(_analysis, _reserved, _random, history) {
    generationCount++;
    generatedHistories.push(JSON.parse(JSON.stringify(history)));
    level.difficulty = (generationCount * 23) % 100;
    level.stars = P.Difficulty.stars(level.difficulty);
    level.challenge.complexity = level.difficulty / 100;
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
  return { P, context, game, level, analysis, frames, timers, document, window, targets, generatedHistories,
    paint, runTimers, pointer, ready, down, move, changeLayout: reason => watchCallback(reason),
    messages, saveFailures: count => { saveFailures = count; },
    stored: () => storedProfile, seedStored: profile => { storedProfile = P.Progression.normalize(profile); },
    counts: () => ({ generationCount, watchStops, restoredFocus }) };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
function complete(h) { h.down(); h.move(240, 80); h.move(240, 240); }

test('mouse starts with a click, moves after release, finishes and persists one score', async () => {
  const h = harness(); h.ready(); h.down();
  h.game.pointerUp(h.pointer(80, 80, { buttons: 0 }));
  assert.equal(h.game.state, 'DRAWING'); assert.equal(h.game.overlay.surface.captures.size, 0);
  h.move(240, 80); h.move(240, 240);
  assert.equal(h.game.state, 'SUCCESS');
  assert.equal(h.game.profile.wins, 1, 'XP and level update before the asynchronous response');
  assert.ok(h.game.result.xp > 0);
  assert.equal(h.game.overlay.callbacks.onSaveResult, undefined);
  assert.equal(h.game.saveBefore, undefined);
  await flush();
  assert.equal(h.game.result.confirmed, true); assert.ok(h.game.result.score > 0);
  assert.ok(h.game.result.xp > 0); assert.equal(h.game.profile.wins, 1);
  assert.equal(h.game.elapsed, undefined); assert.equal(h.game.pointerId, null);
  assert.equal(Object.hasOwn(h.game.run, 'elapsedMs'), false);
  assert.equal(Object.hasOwn(h.game.overlay.lastUpdate, 'elapsedMs'), false);
  assert.equal(h.game.overlay.lastUpdate.result, h.game.result);
  const completion = h.messages.find(message => message.type === 'PAGEPATH_COMPLETE');
  assert.equal(completion.level.challenge.complexity, h.level.challenge.complexity);
  assert.equal(Object.hasOwn(completion.level, 'mode'), false);
  assert.equal(h.game.result.scoringDifficulty, h.level.difficulty);
  h.game.destroy(); assert.equal(h.timers.size, 0);
});

test('swept movement collects bubbles once and completion multiplies difficulty XP plus bubble XP', async () => {
  const h = harness();
  h.level.collectibles = [
    { id: 'xp-0', kind: 'xp', x: 135, y: 80, value: 10, radius: 10 },
    { id: 'xp-1', kind: 'xp', x: 205, y: 80, value: 40, radius: 10 },
    { id: 'multiplier-0', kind: 'multiplier', x: 240, y: 150, value: 3, radius: 10 },
  ];
  h.ready(); h.down(); h.move(220, 80);
  assert.equal(h.game.run.collectedXp, 50); assert.equal(h.game.run.collectedCount, 2);
  assert.equal(h.game.profile.totalXp, 0, 'collection is awarded only after reaching the finish');
  h.move(100, 80); h.move(240, 80);
  assert.equal(h.game.run.collectedXp, 50, 'backtracking cannot collect a bubble twice');
  h.move(240, 240);
  assert.equal(h.game.state, 'SUCCESS'); assert.equal(h.game.run.multiplier, 3);
  assert.equal(h.game.result.score, 1060, 'only the generated difficulty determines the score');
  assert.equal(h.game.result.xp, (106 + 50) * 3);
  assert.equal(h.game.profile.totalXp, 468);
  assert.equal(h.game.overlay.collectedIds.length, 3);
  await flush();
  const receipt = h.messages.find(message => message.type === 'PAGEPATH_COMPLETE');
  assert.deepEqual(JSON.parse(JSON.stringify(receipt.stats)), { collectedXp: 50, collectedCount: 2, multiplier: 3 });
  assert.equal(Object.hasOwn(receipt.level, 'referenceLength'), false);
  h.game.destroy();
});

test('bubbles across a wall cannot be collected even within pickup radius', () => {
  const h = harness([{ x: 150, y: 82, width: 70, height: 2 }]);
  h.level.collectibles = [{ id: 'xp-0', kind: 'xp', x: 190, y: 88, value: 40, radius: 10 }];
  h.ready(); h.down(); h.move(240, 80);
  assert.equal(h.game.state, 'DRAWING'); assert.equal(h.game.run.collectedXp, 0);
  assert.equal(h.game.run.collectedIds.length, 0);
  h.game.destroy();
});

test('failure and same-map retry restore bubbles and reset the attempt bonus without changing difficulty', async () => {
  const h = harness();
  h.level.collectibles = [{ id: 'xp-0', kind: 'xp', x: 135, y: 80, value: 20, radius: 10 }];
  h.ready(); const difficulty = h.level.difficulty;
  h.down(); h.move(180, 80); assert.equal(h.game.run.collectedXp, 20);
  h.game.fail('collision'); assert.equal(h.game.profile.totalXp, 0);
  h.runTimers(); assert.equal(h.game.state, 'READY');
  assert.equal(h.game.run.collectedXp, 0); assert.equal(h.game.run.multiplier, 1);
  assert.equal(h.game.run.collectedIds.length, 0); assert.equal(h.game.overlay.collectedIds.length, 0);
  assert.equal(h.level.difficulty, difficulty);
  complete(h); assert.equal(h.game.result.xp, 126); await flush();
  const total = h.game.profile.totalXp;
  h.game.retry(); complete(h); assert.equal(h.game.result.xp, 0); await flush();
  assert.equal(h.game.profile.totalXp, total);
  h.game.destroy();
});

test('same map practice cannot award experience a second time', async () => {
  const h = harness(); h.ready(); complete(h); await flush();
  const xp = h.game.profile.totalXp, id = h.game.run.id;
  h.game.retry(); complete(h); await flush();
  assert.equal(h.game.run.id, id); assert.equal(h.game.result.xp, 0);
  assert.equal(h.game.profile.totalXp, xp);
  assert.equal(h.messages.filter(m => m.type === 'PAGEPATH_COMPLETE').length, 1);
  h.game.generate(); h.paint(); h.paint(); assert.notEqual(h.game.run.id, id);
  complete(h); await flush(); assert.equal(h.game.profile.wins, 2);
  h.game.destroy();
});

test('storage failure retries automatically without hiding earned XP or blocking same-map practice', async () => {
  const h = harness(); h.saveFailures(1); h.ready(); complete(h); await flush();
  const id = h.game.run.id, score = h.game.result.score, xp = h.game.result.xp;
  assert.equal(h.game.result.saveError, undefined); assert.equal(h.game.profile.wins, 1);
  assert.equal(h.game.profile.totalXp, xp);
  assert.equal(h.game.pendingSettlements.length, 1);
  h.game.retry();
  assert.equal(h.game.state, 'READY'); assert.equal(h.game.profile.wins, 1);
  complete(h); assert.equal(h.game.result.xp, 0);
  h.runTimers(); await flush();
  const sent = h.messages.filter(m => m.type === 'PAGEPATH_COMPLETE');
  assert.equal(sent.length, 2); assert.equal(sent[0].runId, id); assert.equal(sent[1].runId, id);
  assert.equal(h.game.profile.bestScore, score);
  assert.equal(h.game.pendingSettlements.length, 0); assert.equal(h.stored().totalXp, xp);
  h.game.destroy();
});

test('new maps remain immediately playable while earlier receipts retry and rewards accumulate', async () => {
  const h = harness(); h.saveFailures(1); h.ready(); complete(h); await flush();
  const id = h.game.run.id, firstXp = h.game.result.xp;
  h.game.generate(); h.paint(); h.paint();
  assert.equal(h.game.state, 'READY'); assert.notEqual(h.game.run.id, id);
  complete(h); const totalXp = firstXp + h.game.result.xp;
  assert.equal(h.game.profile.wins, 2); assert.equal(h.game.profile.totalXp, totalXp);
  assert.equal(h.game.pendingSettlements.length, 2);
  h.runTimers(); await flush();
  assert.equal(h.game.pendingSettlements.length, 0);
  assert.equal(h.game.profile.totalXp, totalXp); assert.equal(h.stored().totalXp, totalXp);
  h.game.destroy();
});

test('a hanging request times out for automatic retry and never blocks the next map', async () => {
  const h = harness(); h.ready(); await flush();
  const send = h.context.chrome.runtime.sendMessage;
  h.context.chrome.runtime.sendMessage = message => message.type === 'PAGEPATH_COMPLETE' ? new Promise(() => {}) : send(message);
  complete(h); const xp = h.game.result.xp;
  h.runTimers(); await flush();
  assert.equal(h.game.profile.totalXp, xp); assert.equal(h.game.result.saveError, undefined);
  h.game.generate(); h.paint(); h.paint(); assert.equal(h.game.state, 'READY');
  h.context.chrome.runtime.sendMessage = send;
  h.runTimers(); await flush();
  assert.equal(h.stored().totalXp, xp);
  h.game.destroy(); assert.equal(h.timers.size, 0);
});

test('a late stored profile is rebased with every optimistic reward and earlier confirmations do not rewind it', async () => {
  const h = harness(), send = h.context.chrome.runtime.sendMessage;
  const baseline = h.P.Progression.award(h.P.Progression.empty(), { runId: 'previous-session', score: 4000, xp: 400 }).profile;
  h.seedStored(baseline);
  let releaseProfile, releaseFirst;
  h.context.chrome.runtime.sendMessage = async message => {
    if (message.type === 'PAGEPATH_PROFILE') return new Promise(resolve => { releaseProfile = resolve; });
    const response = await send(message);
    if (message.type === 'PAGEPATH_COMPLETE' && !releaseFirst) return new Promise(resolve => { releaseFirst = () => resolve(response); });
    return response;
  };
  h.ready(); complete(h); const firstXp = h.game.result.xp;
  await flush();
  h.game.generate(); h.paint(); h.paint(); complete(h);
  const totalXp = 400 + firstXp + h.game.result.xp;
  releaseProfile({ ok: true, profile: h.P.Progression.view(baseline), profileData: baseline });
  await flush();
  assert.equal(h.game.profile.totalXp, totalXp);
  assert.equal(h.game.profile.wins, 3);
  releaseFirst(); await flush();
  assert.equal(h.game.pendingSettlements.length, 0);
  assert.equal(h.game.profile.totalXp, totalXp);
  assert.equal(h.stored().totalXp, totalXp);
  h.game.destroy();
});

test('a stale initial profile response cannot replace experience confirmed by subsequent wins', async () => {
  const h = harness(), send = h.context.chrome.runtime.sendMessage;
  let release;
  h.context.chrome.runtime.sendMessage = message => message.type === 'PAGEPATH_PROFILE'
    ? new Promise(resolve => { release = resolve; }) : send(message);
  h.ready(); complete(h); await flush();
  h.game.generate(); h.paint(); h.paint(); complete(h); await flush();
  const totalXp = h.game.profile.totalXp;
  release({ ok: true, profile: h.P.Progression.view(h.P.Progression.empty()), profileData: h.P.Progression.empty() });
  await flush();
  assert.equal(h.game.profile.totalXp, totalXp);
  assert.equal(h.game.profile.wins, 2);
  h.game.destroy();
});

test('a lost acknowledgement retries idempotently without changing first-win XP to zero', async () => {
  const h = harness(), send = h.context.chrome.runtime.sendMessage;
  let lost = false;
  h.context.chrome.runtime.sendMessage = async message => {
    const response = await send(message);
    if (message.type === 'PAGEPATH_COMPLETE' && !lost) { lost = true; throw new Error('response lost after persistence'); }
    return response;
  };
  h.ready(); complete(h); const xp = h.game.result.xp;
  await flush();
  assert.equal(h.stored().totalXp, xp);
  h.runTimers(); await flush();
  assert.equal(h.game.result.xp, xp);
  assert.equal(h.game.result.awarded, true);
  assert.equal(h.game.result.confirmed, true);
  assert.equal(h.game.profile.totalXp, xp);
  assert.equal(h.stored().totalRuns, 1);
  h.game.destroy();
});

test('closing transfers pending maps to the worker and clears timers while in-flight receipts can finish', async () => {
  const h = harness(), send = h.context.chrome.runtime.sendMessage;
  let release;
  h.context.chrome.runtime.sendMessage = async message => {
    if (message.type === 'PAGEPATH_COMPLETE' && !release) return new Promise(resolve => {
      release = async () => resolve(await send(message));
    });
    return send(message);
  };
  h.ready(); complete(h); const firstXp = h.game.result.xp;
  h.game.generate(); h.paint(); h.paint(); complete(h);
  const totalXp = firstXp + h.game.result.xp;
  assert.equal(h.game.pendingSettlements.length, 2);
  h.game.destroy();
  assert.equal(h.timers.size, 0);
  await release(); await flush();
  assert.equal(h.stored().totalXp, totalXp);
  assert.equal(h.stored().totalRuns, 2);
  assert.equal(h.game.state, 'DESTROYED');
  assert.equal(h.timers.size, 0);
});

test('collision blocks fast movement before reaching a finish, including through a wall', () => {
  const h = harness([{ x: 150, y: 0, width: 8, height: 600 }]);
  h.ready(); h.down(); h.move(240, 240);
  assert.equal(h.game.state, 'FAILED'); assert.equal(h.game.pointerId, null);
  assert.equal(h.messages.filter(m => m.type === 'PAGEPATH_COMPLETE').length, 0);
  h.runTimers(); assert.equal(h.game.state, 'READY'); h.game.destroy();
});

test('coalesced mouse samples cannot skip a collision in the middle of a movement', () => {
  const h = harness([{ x: 100, y: 100, width: 30, height: 30 }]);
  h.ready(); h.down();
  h.move(240, 80, { getCoalescedEvents: () => [{ clientX: 110, clientY: 110 }, { clientX: 240, clientY: 80 }] });
  assert.equal(h.game.state, 'FAILED'); h.game.destroy();
});

test('a new random map shares the screenshot and updates the displayed stars without a mode selector', () => {
  const h = harness(); h.ready(); const snapshot = h.game.snapshot;
  const stars = h.game.overlay.lastUpdate.stars;
  assert.equal(h.game.setMode, undefined);
  assert.equal(h.game.overlay.callbacks.onModeChange, undefined);
  h.game.generate(); h.paint(); h.paint();
  assert.notEqual(h.game.overlay.lastUpdate.stars, stars);
  assert.equal(h.game.overlay.lastUpdate.stars, h.game.level.stars);
  assert.equal(h.game.snapshot, snapshot); assert.equal(h.game.level.nodes.length, 2);
  const previous = h.game.level.stars;
  h.down(); h.game.fail('retry'); h.game.retry();
  assert.equal(h.game.overlay.lastUpdate.stars, previous, 'same-map retries retain their rating');
  h.game.destroy();
});

test('right click and Escape restore normal interaction and dispose listeners and retry timers', () => {
  for (const exit of ['right', 'escape']) {
    const h = harness(); h.ready(); h.down();
    const event = { preventDefault() {}, stopImmediatePropagation() {}, key: 'Escape' };
    if (exit === 'right') h.game.overlay.host.dispatch('contextmenu', event);
    else h.window.dispatch('keydown', event);
    assert.equal(h.game.state, 'DESTROYED'); assert.equal(h.timers.size, 0);
    assert.equal(h.frames.size, 0); assert.equal(h.counts().restoredFocus, 1);
    assert.ok(h.targets.every(target => [...target.events.values()].every(list => list.size === 0)));
  }
});

test('focus loss pauses the attempt without awarding experience', () => {
  const h = harness(); h.ready(); h.down();
  h.window.dispatch('blur'); assert.equal(h.game.state, 'PAUSED');
  assert.equal(h.game.profile.totalXp, 0);
  assert.equal(h.game.pointerId, null); h.move(240, 240); assert.equal(h.game.state, 'PAUSED');
  h.game.destroy();
});

test('a destroyed capture cannot resurrect a game or leave its screenshot alive', async () => {
  const h = harness(); h.game.snapshot = null;
  let resolveCapture, released = 0;
  h.P.PageSnapshot.capture = () => new Promise(resolve => { resolveCapture = resolve; });
  h.game.start(); h.paint(); h.paint(); h.game.destroy();
  resolveCapture({ image: {}, analysis: h.analysis, destroy() { released++; } }); await flush();
  assert.equal(h.game.state, 'DESTROYED'); assert.equal(released, 1); assert.equal(h.game.level, null);
});

test('capture errors release the page and expose a refreshable error state', async () => {
  const h = harness(); h.game.snapshot = null;
  h.P.PageSnapshot.capture = async () => { throw new Error('capture unavailable'); };
  h.game.start(); h.paint(); h.paint(); await flush();
  assert.equal(h.game.state, 'PAUSED'); assert.equal(h.game.generationFailed, true);
  assert.match(h.game.overlay.lastUpdate.message, /capture unavailable/); assert.equal(h.game.snapshot, null);
  h.game.destroy();
});
