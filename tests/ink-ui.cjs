/* Run with: node tests/ink-ui.cjs. This check keeps browser artifacts in memory. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.resolve(path.dirname(process.execPath), '../node_modules/playwright')); }
const candidate = process.env.PAGEPATH_BROWSER || process.env.CHROME_PATH ||
  (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined);
const executablePath = candidate && fs.existsSync(candidate) ? candidate : undefined;
const edgeOnly = process.argv.includes('--edge-cases');
const states = ['READY', 'DRAWING', 'FAILED', 'SUCCESS', 'PAUSED', 'GENERATING'];

(async () => {
  const browser = await playwright.chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let cases = 0;
  try {
    await page.setContent('<!doctype html><html><head><style>body{margin:0;background:#fbfaf7}</style></head><body></body></html>');
    for (const file of ['config.js', 'collision.js', 'overlay.js']) {
      await page.addScriptTag({ path: path.join(__dirname, '..', 'src', 'content', file) });
    }
    await page.evaluate(() => {
      window.sampleLevel = (difficulty = 55, stars) => ({ maze: true, trailLength: 45, difficulty,
        ...(stars === undefined ? {} : { stars }),
        nodes: [{ id: 0, kind: 'start', x: 60, y: 200 }, { id: 1, kind: 'finish', x: 270, y: 600 }] });
      window.profile = { level: 4, title: '初入迷途', currentXp: 90, nextLevelXp: 180, progress: .5 };
      window.result = { score: 2345, xp: 235, grade: 'A', elapsedMs: 83400, previousLevel: 3, level: 4, leveledUp: true };
    });
    for (const width of edgeOnly ? [] : [280, 320, 375, 1280]) {
      await page.setViewportSize({ width, height: 720 });
      for (const debug of [false, true]) {
        await page.evaluate(debug => {
          window.calls = [];
          const callbacks = Object.fromEntries(['onRetry', 'onNewPuzzle', 'onExit', 'onRegenerate', 'onToolbarMove']
            .map(name => [name, value => calls.push([name, value?.type || value])]));
          if (debug) callbacks.onDebug = () => calls.push(['onDebug']);
          window.overlay = new __PAGEPATH__.Overlay(callbacks);
        }, debug);
        let reserved, infoBox;
        for (const difficulty of [5, 35, 55, 75, 95]) for (const state of states) {
          const view = await page.evaluate(({ difficulty, state }) => {
            overlay.renderLevel(sampleLevel(difficulty));
            overlay.update({ state: 'DRAWING' });
            overlay.moveBrush({ clientX: 90, clientY: 300, pointerType: 'mouse' });
            if (state === 'GENERATING') overlay.renderLevel(null);
            overlay.update({ state, difficulty, elapsedMs: 83400, profile,
              result: state === 'SUCCESS' ? result : null });
            overlay.renderPath([{ x: 20, y: 400 }, { x: 240, y: 400 }]);
            const box = node => {
              const { x, y, width, height, right, bottom } = node.getBoundingClientRect();
              return { x, y, width, height, right, bottom };
            };
            const visible = node => {
              for (let current = node; current instanceof Element; current = current.parentElement) {
                const css = getComputedStyle(current);
                if (current.hidden || css.display === 'none' || css.visibility === 'hidden') return false;
              }
              return true;
            };
            return { box: box(overlay.toolbar), reserved: overlay.getReservedRects(), infoBox: box(overlay.toolbar.querySelector('.main-info')),
              scrollWidth: overlay.toolbar.scrollWidth, clientWidth: overlay.toolbar.clientWidth,
              scrollHeight: overlay.toolbar.scrollHeight, clientHeight: overlay.toolbar.clientHeight,
              controls: [...overlay.toolbar.querySelectorAll('button,[tabindex="0"]')].map(node => ({
                box: box(node), visible: visible(node), name: node.getAttribute('aria-label'), title: node.title })),
              removed: overlay.shadowRoot.querySelectorAll('.mode-button,.mode-control,.result-panel,.result-grade,.round-score,.score-value,.result-meta,.settlement-note,.save-result,.hint,.hint-layer,.maze-mode-slot,.maze-tooltip,.cursor-ink,.metric-nodes,.ink-dot,.difficulty-value,.timer-value,.hud-timer,.run-stats').length,
              cursor: getComputedStyle(overlay.surface).cursor, brush: visible(overlay.brushCursor),
              collapsed: overlay.toolbarMain.inert && overlay.toolbarMeta.inert && !visible(overlay.toolbarMain),
              pointerEvents: getComputedStyle(overlay.toolbar).pointerEvents,
              runHud: visible(overlay.toolbar.querySelector('.run-hud')), collectionHud: overlay.toolbar.querySelector('.run-hud').textContent,
              noTimeText: !/用时|\d{2}:\d{2}/.test(overlay.toolbar.textContent + overlay.roundXp.title),
              starCount: overlay.starIcons.length, filled: overlay.starIcons.filter(star => star.dataset.filled === 'true').length,
              starLabel: overlay.starRating.getAttribute('aria-label'), starVisible: visible(overlay.starRating), starsData: overlay.starRating.dataset.stars,
              level: overlay.toolbar.querySelector('.profile-level').textContent,
              progress: overlay.toolbar.querySelector('.xp-track').getAttribute('aria-valuenow'),
              xpVisible: visible(overlay.roundXp), xpInside: overlay.toolbar.contains(overlay.roundXp.querySelector('.xp-value')),
              xp: overlay.roundXp.querySelector('.xp-value').textContent, xpLabel: overlay.roundXp.getAttribute('aria-label'),
              upgrade: overlay.roundXp.title, upgradeMark: overlay.toolbar.querySelector('.profile-level').dataset.leveledUp,
              toolbarCursor: getComputedStyle(overlay.toolbar).cursor, buttonCursor: getComputedStyle(overlay.retryButton).cursor,
              tail: overlay.path.getTotalLength(), paintedTail: overlay.inkStroke.getBBox().width,
              nodeCount: overlay.nodeLayer.querySelectorAll('.node').length, nodeWords: overlay.nodeLayer.querySelectorAll('text').length,
              debugCount: overlay.toolbar.querySelectorAll('.debug-button').length };
          }, { difficulty, state });
          const label = width + 'px / debug=' + debug + ' / D=' + difficulty + ' / ' + state;
          const stars = Math.ceil(difficulty / 20);
          assert.equal(view.removed, 0, label + ': obsolete modes and separate settlement UI are absent');
          assert.equal(view.box.height, 76, label);
          assert.ok(view.box.x >= 0 && view.box.right <= width, label + ': toolbar fits the viewport');
          assert.ok(view.scrollWidth <= view.clientWidth && view.scrollHeight <= view.clientHeight, label + ': no clipped contents');
          for (const control of view.controls) {
            assert.ok(control.name && control.title, label + ': accessible button name and tooltip');
            if (!control.visible) continue;
            assert.ok(control.box.x >= view.box.x && control.box.right <= view.box.right &&
              control.box.y >= view.box.y && control.box.bottom <= view.box.bottom, label + ': controls fit inside toolbar');
          }
          const active = view.controls.filter(control => control.visible);
          for (let a = 0; a < active.length; a++) for (let b = a + 1; b < active.length; b++) {
            const one = active[a].box, two = active[b].box;
            assert.ok(Math.min(one.right, two.right) - Math.max(one.x, two.x) < .5 ||
              Math.min(one.bottom, two.bottom) - Math.max(one.y, two.y) < .5, label + ': control hit areas do not overlap');
          }
          assert.equal(view.cursor, state === 'DRAWING' ? 'none' : 'default', label);
          assert.equal(view.brush, state === 'DRAWING', label);
          assert.equal(view.collapsed, state === 'DRAWING', label);
          assert.equal(view.runHud, state === 'DRAWING', label);
          assert.equal(view.pointerEvents, state === 'DRAWING' ? 'none' : 'auto', label);
          assert.equal(view.collectionHud, '+0 XP×1', label);
          assert.equal(view.noTimeText, true, label + ': no timer or elapsed-time tooltip');
          assert.equal(view.starCount, 5, label);
          assert.equal(view.filled, state === 'GENERATING' ? 0 : stars, label);
          assert.equal(view.starsData, String(state === 'GENERATING' ? 0 : stars), label);
          assert.equal(view.starLabel, state === 'GENERATING' ? '正在生成星级' : '本局难度 ' + stars + ' 星', label);
          assert.equal(view.starVisible, !['DRAWING', 'SUCCESS'].includes(state), label);
          assert.equal(view.level, 'Lv.4', label);
          assert.equal(view.progress, '50', label);
          assert.equal(view.xpVisible, state === 'SUCCESS', label);
          assert.equal(view.xpInside, true, label + ': experience stays inside the toolbar');
          assert.equal(view.toolbarCursor, state === 'DRAWING' ? 'none' : 'default', label + ': toolbar uses system arrow');
          assert.equal(view.buttonCursor, 'default', label + ': buttons do not use jagged hand cursors');
          assert.equal(view.upgradeMark, String(state === 'SUCCESS'), label);
          if (state === 'SUCCESS') {
            assert.equal(view.xp, '+235', label);
            assert.equal(view.xpLabel, '本局获得 +235 经验', label);
            assert.match(view.upgrade, /Lv\.3 → Lv\.4 · 初入迷途/, label);
          }
          assert.equal(view.nodeCount, state === 'GENERATING' ? 0 : 2, label);
          assert.equal(view.nodeWords, 0, label);
          assert.equal(view.debugCount, Number(debug), label);
          assert.equal(view.tail, 45, label);
          assert.ok(Math.abs(view.paintedTail - 45) < .1, label + ': short brush texture remains');
          if (reserved) assert.deepEqual(view.reserved, reserved, label + ': state changes preserve the reserved footprint');
          else reserved = view.reserved;
          if (infoBox) assert.deepEqual(view.infoBox, infoBox, label + ': stars and experience occupy the same fixed slot');
          else infoBox = view.infoBox;
          cases++;
        }
        await page.evaluate(() => overlay.destroy());
      }
    }
    await page.setViewportSize({ width: 280, height: 720 });
    const interactions = await page.evaluate(() => {
      calls = [];
      const ui = new __PAGEPATH__.Overlay({ onRetry: () => calls.push(['retry']),
        onToolbarMove: value => calls.push(['move', value]), onNewPuzzle: () => calls.push(['new']), onDebug() {} });
      ui.renderLevel(sampleLevel(5, 5));
      ui.update({ state: 'READY', profile });
      const explicitStars = ui.starRating.dataset.stars;
      ui.renderLevel(sampleLevel(35));
      const derivedStars = ui.starRating.dataset.stars;
      ui.update({ state: 'SUCCESS', result: { ...result, saving: true } });
      const savingDoesNotBlock = !ui.newPuzzleButton.disabled && !ui.retryButton.disabled;
      const awardDuringSave = !ui.roundXp.hidden && ui.roundXp.querySelector('.xp-value').textContent === '+235';
      ui.newPuzzleButton.click(); ui.retryButton.click();
      ui.update({ result: { ...result, saving: false, saveError: 'offline' } });
      const noStorageUi = !ui.shadowRoot.querySelector('.save-result,.settlement-note,.result-meta') && !/保存/.test(ui.toolbar.textContent);
      const xpBox = ui.roundXp.getBoundingClientRect(), bar = ui.toolbar.getBoundingClientRect();
      const awardFits = xpBox.x >= bar.x && xpBox.right <= bar.right && xpBox.bottom <= bar.bottom;
      ui.update({ state: 'PAUSED', result: { ...result, saving: true } });
      const pausedAwardVisible = !ui.roundXp.hidden && ui.starRating.hidden;
      const pausedRefreshAvailable = !ui.regenerateButton.disabled;
      ui.update({ result: { ...result, saving: false, saveError: '' } });
      const pausedAwardRetained = !ui.roundXp.hidden && ui.starRating.hidden && !ui.regenerateButton.disabled;
      ui.update({ state: 'SUCCESS', result: { ...result, xp: 0, leveledUp: false } });
      const duplicate = ui.roundXp.querySelector('.xp-value').textContent;
      const duplicateTitle = ui.roundXp.title;
      const upgradeCleared = ui.toolbar.querySelector('.profile-level').dataset.leveledUp === 'false';
      ui.update({ state: 'FAILED', result: null });
      const failedStars = !ui.starRating.hidden && ui.starRating.dataset.stars === '2' && ui.roundXp.hidden;
      ui.update({ state: 'READY' });
      const retryStars = !ui.starRating.hidden && ui.starRating.dataset.stars === '2' && ui.roundXp.hidden;
      ui.renderLevel(sampleLevel(95));
      const newStars = ui.starRating.dataset.stars;
      ui.positionToolbar(1200, 700);
      const before = ui.toolbar.getBoundingClientRect();
      ui.moveToolbarWithKeys({ key: 'ArrowLeft', preventDefault() {}, stopPropagation() {} });
      const after = ui.toolbar.getBoundingClientRect();
      ui.setCaptureHidden(true);
      const hiddenForCapture = ui.host.style.opacity === '0';
      ui.setCaptureHidden(false);
      const snapshot = new Image(); ui.setSnapshot(snapshot);
      const snapshotIsolated = !ui.shadowRoot.querySelector('img') && ui.snapshotImage === snapshot;
      const host = ui.host; ui.destroy();
      return { calls, explicitStars, derivedStars, newStars, failedStars, retryStars, savingDoesNotBlock, awardDuringSave, noStorageUi,
        awardFits, pausedAwardVisible, pausedRefreshAvailable, pausedAwardRetained, duplicate, duplicateTitle, upgradeCleared,
        moved: before.x - after.x === 8, hiddenForCapture, snapshotIsolated, destroyed: !host.isConnected };
    });
    assert.equal(interactions.explicitStars, '5');
    assert.equal(interactions.derivedStars, '2');
    assert.equal(interactions.newStars, '5');
    assert.equal(interactions.failedStars && interactions.retryStars, true);
    assert.equal(interactions.savingDoesNotBlock && interactions.awardDuringSave && interactions.noStorageUi && interactions.awardFits, true);
    assert.equal(interactions.pausedAwardVisible && interactions.pausedRefreshAvailable && interactions.pausedAwardRetained, true,
      'background saving never hides earned experience or blocks playing');
    assert.deepEqual(interactions.calls.filter(call => call[0] !== 'move'), [['new'], ['retry']]);
    assert.equal(interactions.duplicate, '+0');
    assert.match(interactions.duplicateTitle, /本图已结算/);
    assert.equal(interactions.upgradeCleared && interactions.moved && interactions.hiddenForCapture && interactions.snapshotIsolated && interactions.destroyed, true);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => {
      window.edgeOverlay = new __PAGEPATH__.Overlay();
      edgeOverlay.renderLevel(sampleLevel(55));
      edgeOverlay.update({ state: 'READY' });
    });
    const oldToolbar = await page.evaluate(() => {
      const bar = edgeOverlay.toolbar.getBoundingClientRect(), grip = edgeOverlay.dragHandle.getBoundingClientRect();
      return { x: bar.x, y: bar.y, gripX: grip.x + grip.width / 2, gripY: grip.y + grip.height / 2 };
    });
    await page.mouse.move(oldToolbar.gripX, oldToolbar.gripY);
    assert.equal(await page.evaluate(() => getComputedStyle(edgeOverlay.dragHandle).cursor), 'move', 'hovering the grip uses a system move cursor');
    await page.mouse.down();
    await page.mouse.move(oldToolbar.gripX + 40 - oldToolbar.x, oldToolbar.gripY + 180 - oldToolbar.y);
    assert.equal(await page.evaluate(() => getComputedStyle(edgeOverlay.toolbar).cursor), 'move', 'active dragging uses a system move cursor');
    await page.mouse.up();
    assert.equal(await page.evaluate(() => getComputedStyle(edgeOverlay.toolbar).cursor), 'default', 'dropping restores the system arrow');
    const edges = await page.evaluate(() => {
      const restored = edgeOverlay.toolbar.getBoundingClientRect();
      edgeOverlay.positionToolbar(77, 190);
      edgeOverlay.moveToolbarWithKeys({ key: 'ArrowLeft', preventDefault() {}, stopPropagation() {} });
      const keyboardX = edgeOverlay.toolbar.getBoundingClientRect().x;
      edgeOverlay.update({ state: 'PAUSED', generationFailed: true, message: '页面截图失败，请重试' });
      const errorVisible = !edgeOverlay.generationError.hidden && edgeOverlay.generationError.textContent.includes('页面截图失败');
      const refreshVisible = !edgeOverlay.regenerateButton.hidden && !edgeOverlay.regenerateButton.disabled;
      edgeOverlay.update({ state: 'READY', generationFailed: false });
      const errorCleared = edgeOverlay.generationError.hidden;
      edgeOverlay.destroy();
      return { restoredX: restored.x, restoredY: restored.y, keyboardX, errorVisible, refreshVisible, errorCleared };
    });
    assert.equal(edges.restoredX, oldToolbar.x, 'dropping the toolbar over the start restores its safe position');
    assert.equal(edges.restoredY, oldToolbar.y);
    assert.equal(edges.keyboardX, 77, 'keyboard movement cannot hide the start hit area');
    assert.equal(edges.errorVisible && edges.refreshVisible && edges.errorCleared, true, 'paused capture errors remain visible and recoverable');
    const contours = await page.evaluate(() => {
      const P = __PAGEPATH__, width = innerWidth, height = innerHeight;
      const sourceMask = new Uint8Array(width * height).fill(1), finalMask = sourceMask.slice();
      const sourceLabels = new Int32Array(sourceMask.length), finalLabels = new Int32Array(sourceMask.length);
      const distanceMap = new Float32Array(sourceMask.length);
      const rect = (x1, y1, x2, y2) => [x1,y1,x2,y1, x2,y1,x2,y2, x1,y2,x2,y2, x1,y1,x1,y2];
      const sourceSegments = [...rect(178,180,185,280), ...rect(178,320,185,420)];
      const finalSegments = rect(178,180,185,420);
      const contour = segments => ({ segments: new Float32Array(segments), bucketSize: 64, buckets: {} });
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const at = y * width + x, strip = x >= 178 && x < 185;
        sourceMask[at] = !(strip && (y >= 180 && y < 280 || y >= 320 && y < 420));
        finalMask[at] = !(strip && y >= 180 && y < 420);
        sourceLabels[at] = sourceMask[at]; finalLabels[at] = finalMask[at];
        distanceMap[at] = Math.hypot(Math.max(180 - x, x - 183, 0), Math.max(182 - y, y - 418, 0));
      }
      const source = { kind: 'pixel-mask', width, height, maskWidth: width, maskHeight: height, walkableMask: sourceMask, componentLabels: sourceLabels, contours: contour(sourceSegments) };
      const map = { ...source, walkableMask: finalMask, componentLabels: finalLabels, contours: contour(finalSegments), distanceMap, stats: { clearance: 2 } };
      const ui = new P.Overlay({});
      ui.renderLevel({ ...sampleLevel(55), mazeSourceAnalysis: source }); ui.setMap(map); ui.update({ state: 'READY' });
      const original = Array.from(ui.sourceContours.segments), added = Array.from(ui.mazeContours.segments);
      ui.renderProximity({ x: 100, y: 300 }); const far = ui.obstacleWarning.getAttribute('d');
      ui.renderProximity({ x: 176, y: 300 }); const near = ui.obstacleWarning.getAttribute('d');
      ui.flashObstacles(); const flashes = Boolean(ui.flashAnimation);
      const wallsInvisible = ui.mazeWallLayer.childElementCount === 0;
      const index = P.Collision.createMaskIndex(map);
      const blocked = P.Collision.pointHits({ x: 178, y: 300 }, index);
      const safe = !P.Collision.pointHits({ x: 177.5, y: 300 }, index);
      ui.destroy();
      return { original, added, far, near, flashes, wallsInvisible, blocked, safe,
        released: ui.visibleContours === null && ui.mazeContours === null };
    });
    assert.deepEqual(contours.added, [185,280,185,320, 178,280,178,320]);
    assert.equal(contours.far, '');
    assert.ok(contours.near);
    assert.equal(contours.flashes && contours.wallsInvisible && contours.blocked && contours.safe && contours.released, true);
    const bubbles = await page.evaluate(() => {
      const P = __PAGEPATH__, width = innerWidth, height = innerHeight;
      const walkableMask = new Uint8Array(width * height).fill(1);
      for (let y = 130; y < 300; y++) for (let x = 160; x < 164; x++) walkableMask[y * width + x] = 0;
      const map = { kind: 'pixel-mask', width, height, maskWidth: width, maskHeight: height, walkableMask,
        componentLabels: new Int32Array(width * height).fill(1), distanceMap: new Float32Array(width * height).fill(1000),
        contours: { segments: new Float32Array(), bucketSize: 64, buckets: {} } };
      const collectibles = [
        { id: 'xp10', kind: 'xp', x: 100.5, y: 200.5, value: 10, radius: 10 },
        { id: 'xp20', kind: 'xp', x: 180.5, y: 200.5, value: 20, radius: 10 },
        { id: 'xp40', kind: 'xp', x: 400.5, y: 200.5, value: 40, radius: 10 },
        { id: 'rare', kind: 'multiplier', x: 800.5, y: 400.5, value: 8, radius: 10 },
      ];
      const ui = new P.Overlay();
      ui.renderLevel({ ...sampleLevel(55), collectibles }); ui.setMap(map); ui.update({ state: 'READY' });
      const bubble = id => ui.collectibleElements.get(id).node;
      const opacity = id => Number(bubble(id).style.opacity);
      const move = (x, y = 200.5) => ui.moveBrush({ clientX: x, clientY: y, pointerType: 'mouse' });
      const labels = [...ui.collectibleLayer.querySelectorAll('.bubble-label')].map(node => node.textContent);
      const initiallyHidden = ['xp10', 'xp20', 'xp40'].every(id => opacity(id) === 0);
      const rareInitiallyVisible = opacity('rare') === 1;
      const breathing = getComputedStyle(bubble('rare').querySelector('.bubble-glow')).animationName;
      move(156.5); const outsideRadius = opacity('xp10');
      move(154.5); const faint = opacity('xp10');
      move(110.5); const near = opacity('xp10');
      const previewDoesNotCollect = bubble('xp10').dataset.collected === 'false' && ui.collectedIds.size === 0;
      const nativeBeforeStart = ui.brushCursor.dataset.visible === 'false';
      move(145.5); const throughWall = opacity('xp20'), sameSide = opacity('xp10');
      ui.hideBrush(); const afterLeave = [opacity('xp10'), opacity('rare')];
      ui.update({ state: 'DRAWING' }); move(100.5);
      const brushDuringDraw = ui.brushCursor.dataset.visible === 'true';
      ui.updateCollectibles(['xp10'], { xp: 10, multiplier: 1 });
      const picked = bubble('xp10').dataset.collected === 'true' && getComputedStyle(bubble('xp10')).display === 'none';
      const feedback = ui.pickupLayer.childElementCount;
      const collectionHud = ui.toolbar.querySelector('.run-hud').textContent;
      ui.updateCollectibles(['xp10'], { xp: 10, multiplier: 1 });
      const noDuplicateFeedback = ui.pickupLayer.childElementCount === feedback;
      ui.updateCollectibles(['xp10', 'rare'], { xp: 10, multiplier: 8 });
      const rarePicked = opacity('rare') === 0 && getComputedStyle(bubble('rare')).display === 'none';
      const multiplierHud = ui.toolbar.querySelector('.run-hud').textContent;
      ui.updateCollectibles([], { xp: 0, multiplier: 1 });
      const reset = opacity('xp10') === 1 && opacity('rare') === 1 && ui.pickupLayer.childElementCount === 0 && ui.pickupAnimations.size === 0;
      ui.setCaptureHidden(true); const hiddenForCapture = opacity('rare') === 0;
      ui.setCaptureHidden(false); const rareRestored = opacity('rare') === 1;
      ui.update({ state: 'SUCCESS', result: { xp: 240 }, profile });
      const terminal = opacity('xp10') === 0 && opacity('rare') === 1 && ui.roundXp.querySelector('.xp-value').textContent === '+240';
      const singleReward = ui.toolbar.querySelector('.collection-summary').hidden;
      const multipliers = [2, 3, 5, 8].map((value, index) => {
        const radius = [10, 6, 4, 1][index];
        ui.renderLevel({ ...sampleLevel(55), collectibles: [{ id: 'mult', kind: 'multiplier', x: 100.5, y: 200.5, value, radius }] });
        ui.update({ state: 'READY' });
        const visible = opacity('mult') === 1;
        const animation = getComputedStyle(bubble('mult').querySelector('.bubble-glow')).animationName;
        const scaledRadius = bubble('mult').firstElementChild.getAttribute('transform');
        const label = bubble('mult').querySelector('.bubble-label').textContent;
        const effectiveFontSize = parseFloat(getComputedStyle(bubble('mult').querySelector('.bubble-label')).fontSize) * radius / 10;
        const effectiveGlowRadius = Number(bubble('mult').querySelector('.bubble-glow').getAttribute('r')) * radius / 10;
        move(600.5); ui.hideBrush(); const visibleFromFar = opacity('mult') === 1;
        ui.update({ state: 'DRAWING' }); ui.updateCollectibles(['mult'], { xp: 0, multiplier: value });
        const picked = opacity('mult') === 0 && getComputedStyle(bubble('mult')).display === 'none';
        ui.updateCollectibles([], { xp: 0, multiplier: 1 }); const restored = opacity('mult') === 1;
        ui.update({ state: 'FAILED' }); const failedVisible = opacity('mult') === 1;
        ui.setCaptureHidden(true); const captureHidden = opacity('mult') === 0;
        ui.setCaptureHidden(false); const captureRestored = opacity('mult') === 1;
        ui.update({ state: 'GENERATING' }); const generationHidden = opacity('mult') === 0;
        ui.update({ state: 'READY' }); const readyRestored = opacity('mult') === 1;
        ui.update({ state: 'DESTROYED' }); const destroyedHidden = opacity('mult') === 0;
        return { value, radius, scaledRadius, label, animation, effectiveFontSize, effectiveGlowRadius, visible, visibleFromFar, picked, restored,
          failedVisible, captureHidden, captureRestored, generationHidden, readyRestored, destroyedHidden };
      });
      ui.renderLevel(null);
      const cleared = ui.collectibleElements.size === 0 && ui.collectibleLayer.childElementCount === 0;
      ui.destroy();
      return { labels, initiallyHidden, rareInitiallyVisible, breathing, outsideRadius, faint, near, previewDoesNotCollect,
        nativeBeforeStart, throughWall, sameSide, afterLeave, brushDuringDraw, picked, feedback, collectionHud,
        noDuplicateFeedback, rarePicked, multiplierHud, reset, hiddenForCapture, rareRestored, terminal, singleReward,
        multipliers, cleared, destroyed: !ui.host.isConnected && ui.collectibleIndex === null };
    });
    assert.deepEqual(bubbles.labels, ['+10', '+20', '+40', '×8']);
    assert.equal(bubbles.initiallyHidden && bubbles.rareInitiallyVisible, true);
    assert.equal(bubbles.breathing, 'bubble-breathe', 'multipliers have a soft persistent breathing glow');
    assert.equal(bubbles.outsideRadius, 0, 'ordinary bubbles stay hidden at the 56px boundary');
    assert.ok(bubbles.faint > 0 && bubbles.near > bubbles.faint && bubbles.near <= 1, 'proximity smoothly strengthens reveal');
    assert.equal(bubbles.previewDoesNotCollect && bubbles.nativeBeforeStart && bubbles.brushDuringDraw, true);
    assert.equal(bubbles.throughWall, 0, 'ordinary bubbles cannot reveal across a wall in the final collision map');
    assert.ok(bubbles.sameSide > 0);
    assert.deepEqual(bubbles.afterLeave, [0, 1], 'hiding the brush keeps the uncollected ×8 visible');
    assert.equal(bubbles.picked && bubbles.noDuplicateFeedback && bubbles.rarePicked, true);
    assert.equal(bubbles.feedback, 1, 'a new pickup receives one temporary feedback animation');
    assert.equal(bubbles.collectionHud, '+10 XP×1');
    assert.equal(bubbles.multiplierHud, '+10 XP×8');
    assert.equal(bubbles.reset && bubbles.hiddenForCapture && bubbles.rareRestored && bubbles.terminal && bubbles.singleReward, true);
    for (const multiplier of bubbles.multipliers) {
      assert.equal(multiplier.label, '×' + multiplier.value);
      assert.equal(multiplier.animation, 'bubble-breathe', 'every multiplier continuously breathes');
      assert.equal(multiplier.scaledRadius, 'scale(' + multiplier.radius / 10 + ')', 'narrow-path bubble radii stay unchanged');
      assert.ok(multiplier.effectiveFontSize >= 9, 'even a one-pixel multiplier retains a readable label');
      assert.ok(multiplier.effectiveGlowRadius >= 8, 'even a one-pixel multiplier retains a soft visible beacon');
      assert.ok(['visible', 'visibleFromFar', 'picked', 'restored', 'failedVisible', 'captureHidden', 'captureRestored',
        'generationHidden', 'readyRestored', 'destroyedHidden'].every(key => multiplier[key]), 'multiplier visibility follows collection and game lifecycle');
    }
    assert.equal(bubbles.cleared && bubbles.destroyed, true);
    await page.setViewportSize({ width: 280, height: 720 });
    const compactCollection = await page.evaluate(() => {
      const ui = new __PAGEPATH__.Overlay({ onDebug() {} }); ui.renderLevel(sampleLevel(95));
      ui.update({ state: 'FAILED', profile }); ui.updateCollectibles([], { xp: 9990, multiplier: 8 });
      const summary = ui.toolbar.querySelector('.collection-summary').getBoundingClientRect();
      const bar = ui.toolbar.getBoundingClientRect();
      const summaryFits = summary.x >= bar.x && summary.right <= bar.right;
      const noOverflow = ui.toolbar.scrollWidth <= ui.toolbar.clientWidth;
      ui.update({ state: 'DRAWING' });
      const hud = ui.toolbar.querySelector('.run-hud').getBoundingClientRect();
      const hudFits = hud.x >= bar.x && hud.right <= bar.right;
      const text = ui.toolbar.querySelector('.run-hud').textContent;
      ui.destroy(); return { summaryFits, noOverflow, hudFits, text };
    });
    assert.equal(compactCollection.summaryFits && compactCollection.noOverflow && compactCollection.hudFits, true);
    assert.equal(compactCollection.text, '+9,990 XP×8');
    const configuredRules = await page.evaluate(() => {
      const P = __PAGEPATH__, config = P.Config;
      P.Config = { ...config, COLLECTIBLES: { ...config.COLLECTIBLES, revealDistance: 24, maxMultiplier: 5, radius: 12 } };
      const ui = new P.Overlay();
      ui.renderLevel({ ...sampleLevel(), collectibles: [
        { id: 'xp', kind: 'xp', x: 80, y: 220, value: 10 },
        { id: 'rare', kind: 'multiplier', x: 220, y: 220, value: 5 },
      ] }); ui.update({ state: 'READY' });
      ui.moveBrush({ clientX: 110, clientY: 220, pointerType: 'mouse' });
      const far = ui.collectibleElements.get('xp').node.dataset.visible;
      ui.moveBrush({ clientX: 90, clientY: 220, pointerType: 'mouse' });
      const near = ui.collectibleElements.get('xp').node.dataset.visible;
      const rare = ui.collectibleElements.get('rare').node.dataset;
      const radius = ui.collectibleElements.get('xp').node.firstElementChild.getAttribute('transform');
      const result = { far, near, rare: rare.rare, visible: rare.visible, radius };
      ui.destroy(); P.Config = config; return result;
    });
    assert.deepEqual(configuredRules, { far: 'false', near: 'true', rare: 'true', visible: 'true', radius: 'scale(1.2)' },
      'reveal radius, default bubble radius and highest multiplier styling come from the shared rules');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reducedAnimation = await page.evaluate(() => {
      const ui = new __PAGEPATH__.Overlay();
      ui.renderLevel({ ...sampleLevel(), collectibles: [2, 3, 5, 8].map((value, index) =>
        ({ id: 'mult' + value, kind: 'multiplier', x: 40 + index * 60, y: 200, value })) });
      ui.update({ state: 'READY' });
      const items = [...ui.collectibleElements.values()].map(({ node }) => ({
        animation: getComputedStyle(node.querySelector('.bubble-glow')).animationName,
        visible: node.dataset.visible }));
      ui.destroy(); return items;
    });
    assert.deepEqual(reducedAnimation, Array.from({ length: 4 }, () => ({ animation: 'none', visible: 'true' })),
      'reduced motion keeps every multiplier visible without breathing');
    assert.deepEqual(errors, []);
    console.log('Maze UI passed: ' + cases + ' layout/state combinations; five-star difficulty, same-toolbar experience, collectible reveal and pickup, no timer, transparent background storage, dragging, cursor, and exact hidden-wall warnings.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
