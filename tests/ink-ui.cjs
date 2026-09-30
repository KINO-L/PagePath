/* Run with: node tests/ink-ui.cjs (requires the optional Playwright dev dependency). */
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
const states = ['READY', 'DRAWING', 'FAILED', 'SUCCESS', 'PAUSED', 'GENERATING'];
const pendingMazeDescription = '复杂度：待检测；分散度：待检测';

(async () => {
  const browser = await playwright.chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.exposeFunction('__obstacleScreenshot', async name =>
    'data:image/png;base64,' + (await page.screenshot({ type: 'png',
      ...(name ? { path: path.join(__dirname, '..', 'test-results', name) } : {}) })).toString('base64'));
  let cases = 0;
  try {
    await page.setContent('<!doctype html><html><head><style>body { margin: 0; }</style></head><body></body></html>');
    for (const file of ['config.js', 'collision.js', 'overlay.js']) {
      await page.addScriptTag({ path: path.join(__dirname, '..', 'src', 'content', file) });
    }
    for (const width of [320, 375, 768, 1280]) {
      await page.setViewportSize({ width, height: 720 });
      for (const debug of [false, true]) {
        await page.evaluate(debug => {
          window.calls = [];
          const callbacks = Object.fromEntries(['onRetry', 'onNewPuzzle', 'onExit', 'onRegenerate', 'onModeChange', 'onHint', 'onToolbarMove']
            .map(name => [name, value => calls.push([name, value?.type || value])]));
          if (debug) callbacks.onDebug = () => calls.push(['onDebug']);
          window.overlay = new __PAGEPATH__.Overlay(callbacks);
          window.mazeCriteriaSnapshot = () => [...overlay.mazeTooltip.querySelectorAll('.maze-criterion')].map(row => ({
            criterion: row.dataset.criterion, label: row.querySelector('span').textContent,
            passed: row.dataset.passed, description: row.getAttribute('aria-label'),
            color: getComputedStyle(row.querySelector('.criterion-mark')).color,
            mark: row.querySelector('path').getAttribute('d'),
          }));
          window.sampleLevel = (mode, nodeCount = 4) => {
            const profile = __PAGEPATH__.getMode(mode);
            const corners = [
              { id: 0, kind: 'start', x: 80, y: 200 },
              { id: 1, kind: 'checkpoint', x: 240, y: 200 },
              { id: 2, kind: 'checkpoint', x: 240, y: 360 },
              { id: 3, kind: 'finish', x: 80, y: 360 },
            ];
            const nodes = mode === 'maze' ? [corners[0], { ...corners[3], id: 1 }] : nodeCount === 4 ? corners : Array.from({ length: nodeCount }, (_, i) => ({
              id: i, kind: i === 0 ? 'start' : i === nodeCount - 1 ? 'finish' : 'checkpoint',
              x: 35 + i % 4 * 65, y: 200 + Math.floor(i / 4) * 85,
            }));
            const inkMultiplier = __PAGEPATH__.getInkMultiplier(mode, nodes.length);
            const referenceLength = nodes.slice(1).reduce((sum, node, i) =>
              sum + Math.hypot(node.x - nodes[i].x, node.y - nodes[i].y), 0);
            return { nodes, mode, trailLength: profile.trailLength, referencePath: nodes,
              referenceLength, inkMultiplier, maxInk: mode === 'maze' ? Infinity : referenceLength * inkMultiplier,
              unlimitedInk: mode === 'maze', mazeWalls: mode === 'maze'
                ? [{ x: 155, y: 230, width: 3, height: 86 }, { x: 155, y: 310, width: 75, height: 3 }] : [] };
          };
        }, debug);
        let expectedReserved;
        for (const mode of ['normal', 'hell', 'immortal']) for (const state of states) {
          const result = await page.evaluate(({ mode, state }) => {
            const box = element => {
              const rect = element.getBoundingClientRect();
              return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
            };
            const visuallyHidden = element => {
              for (let current = element; current instanceof Element; current = current.parentElement) {
                const css = getComputedStyle(current);
                if (current.hidden || css.display === 'none' || css.visibility === 'hidden' || Number(css.opacity) === 0 ||
                    css.clipPath !== 'none' || css.clip !== 'auto') return true;
              }
              return false;
            };
            overlay.renderLevel(sampleLevel(mode));
            overlay.update({ state: 'DRAWING' });
            overlay.moveBrush({ clientX: 110, clientY: 510, pointerType: 'mouse' });
            overlay.update({ state, mode, nodes: state === 'SUCCESS' ? 16 : 7, total: 16,
              ink: state === 'FAILED' ? 0 : 100,
              message: '测试状态说明应只供辅助技术读取，不应挤占画面或改变工具栏布局。',
              score: 99999, difficulty: 100, efficiency: 100 });
            overlay.renderPath([{ x: 20, y: 400 }, { x: 240, y: 400 }]);
            const walker = document.createTreeWalker(overlay.shadowRoot, NodeFilter.SHOW_TEXT);
            const visibleText = [];
            while (walker.nextNode()) {
              const text = walker.currentNode;
              if (!['STYLE', 'SCRIPT', 'OPTION'].includes(text.parentElement?.tagName) &&
                  text.textContent.trim() && !visuallyHidden(text.parentElement)) visibleText.push(text.textContent.trim());
            }
            const controls = [...overlay.toolbar.querySelectorAll('button,select,[tabindex="0"]:not(.maze-mode-slot)')].map(control => ({
              className: control.className, tagName: control.tagName,
              label: control.getAttribute('aria-label'), title: control.getAttribute('title'),
              hidden: visuallyHidden(control), rect: box(control),
              icons: control.querySelectorAll('svg').length,
            }));
            const nodeKinds = [...overlay.nodeLayer.querySelectorAll('.node')].map(node => ({
              kind: node.dataset.kind, iconPaths: node.querySelectorAll('path').length,
              labels: [...node.querySelectorAll('text')].filter(text => !visuallyHidden(text)).map(text => text.textContent),
            }));
            const paintedTail = overlay.inkStroke.getBBox();
            const toolbarStyle = getComputedStyle(overlay.toolbar);
            const compactStyle = getComputedStyle(overlay.toolbar, '::after');
            if (state === 'DRAWING') overlay.status.focus();
            return { toolbar: box(overlay.toolbar), reserved: overlay.getReservedRects(), controls, nodeKinds,
              collapsed: { inert: overlay.toolbarMain.inert, visibility: getComputedStyle(overlay.toolbarMain).visibility,
                pointerEvents: toolbarStyle.pointerEvents, background: toolbarStyle.backgroundColor,
                shadow: toolbarStyle.boxShadow, indicatorDisplay: compactStyle.display,
                indicatorWidth: parseFloat(compactStyle.width), indicatorHeight: parseFloat(compactStyle.height),
                focusedControl: overlay.toolbarMain.contains(overlay.shadowRoot.activeElement) },
              liveMessage: overlay.message.getAttribute('aria-live') === 'polite' &&
                !overlay.message.closest('[inert],[aria-hidden="true"]'),
              scrollWidth: overlay.toolbar.scrollWidth, clientWidth: overlay.toolbar.clientWidth,
              scrollHeight: overlay.toolbar.scrollHeight, clientHeight: overlay.toolbar.clientHeight,
              text: visibleText.join(' '), messageHidden: visuallyHidden(overlay.message),
              messageText: overlay.message.textContent,
              systemCursor: getComputedStyle(overlay.surface).cursor,
              brushVisible: !visuallyHidden(overlay.brushCursor),
              inkVisible: !visuallyHidden(overlay.cursorInk),
              toolbarInk: overlay.toolbar.querySelectorAll('.metric-ink,.ink-count,.ink-track,.cursor-ink').length,
              cursorInk: overlay.cursorInk?.textContent,
              tailLength: overlay.path.getTotalLength(), outlineLength: overlay.pathOutline.getTotalLength(),
              paintedTail: { x: paintedTail.x, width: paintedTail.width, height: paintedTail.height,
                pieces: overlay.inkStroke.querySelectorAll('path').length },
              dragDisabled: overlay.toolbar.querySelector('.drag-handle')?.disabled,
              modeIcons: overlay.toolbar.querySelectorAll('.mode-control svg').length,
              selects: overlay.toolbar.querySelectorAll('select').length,
              modeButtons: overlay.modeButtons.map(button => ({ id: button.dataset.mode, disabled: button.disabled,
                label: button.getAttribute('aria-label'), pressed: button.getAttribute('aria-pressed'),
                title: button.title,
                opacity: Number(getComputedStyle(button).opacity), color: getComputedStyle(button).color,
                background: getComputedStyle(button).backgroundColor })),
              debugCount: overlay.toolbar.querySelectorAll('.debug-button').length,
            };
          }, { mode, state });
          const label = `${width}px, debug=${debug}, ${mode}, ${state}`;
          assert.equal(result.systemCursor, state === 'DRAWING' ? 'none' : 'default', `${label}: only active drawing replaces the system cursor`);
          assert.equal(result.brushVisible, state === 'DRAWING', `${label}: state transitions must immediately hide the brush outside drawing`);
          assert.equal(result.inkVisible, state === 'DRAWING', `${label}: state transitions must immediately hide nearby ink outside drawing`);
          assert.ok(result.toolbar.x >= 0 && result.toolbar.right <= width, `${label}: toolbar leaves the viewport`);
          assert.equal(result.toolbar.height, 48, `${label}: icon toolbar must keep its single-row height`);
          assert.ok(result.scrollWidth <= result.clientWidth, `${label}: toolbar content overflows horizontally`);
          assert.ok(result.scrollHeight <= result.clientHeight, `${label}: toolbar content overflows vertically`);
          for (const control of result.controls) {
            assert.ok(control.label?.trim(), `${label}: ${control.className} needs an accessible name`);
            if (control.label === '第二关') assert.equal(control.title, '', `${label}: the lock uses its own tooltip without a duplicate native title`);
            else assert.ok(control.title?.trim(), `${label}: ${control.className} needs an explanatory tooltip`);
            if (control.tagName === 'BUTTON') assert.ok(control.icons > 0, `${label}: ${control.className} needs its visual icon`);
            if (control.hidden) continue;
            assert.ok(control.rect.width > 0 && control.rect.height > 0, `${label}: ${control.className} has no hit area`);
            assert.ok(control.rect.x >= result.toolbar.x && control.rect.right <= result.toolbar.right &&
              control.rect.y >= result.toolbar.y && control.rect.bottom <= result.toolbar.bottom,
            `${label}: ${control.className} is clipped or outside the toolbar`);
          }
          const visibleControls = result.controls.filter(control => !control.hidden);
          assert.equal(result.collapsed.inert, state === 'DRAWING', `${label}: collapsed controls must be removed from keyboard interaction`);
          assert.equal(result.collapsed.visibility, state === 'DRAWING' ? 'hidden' : 'visible',
            `${label}: controls should collapse only during drawing`);
          assert.equal(result.collapsed.pointerEvents, state === 'DRAWING' ? 'none' : 'auto',
            `${label}: the collapsed toolbar must pass input through to the map`);
          assert.ok(result.liveMessage, `${label}: collapse must preserve accessible game announcements`);
          if (state === 'DRAWING') {
            assert.equal(visibleControls.length, 0, `${label}: no controls should remain visible while drawing`);
            assert.equal(result.collapsed.focusedControl, false, `${label}: a hidden status control must not receive focus`);
            assert.equal(result.collapsed.background, 'rgba(0, 0, 0, 0)', `${label}: the large toolbar background must disappear`);
            assert.equal(result.collapsed.shadow, 'none', `${label}: the large toolbar shadow must disappear`);
            assert.notEqual(result.collapsed.indicatorDisplay, 'none', `${label}: a compact indicator should remain visible`);
            assert.equal(result.collapsed.indicatorWidth, 28, `${label}: collapse should leave only the compact indicator`);
            assert.equal(result.collapsed.indicatorHeight, 6, `${label}: collapse should leave only the compact indicator`);
          } else {
            assert.ok(visibleControls.length > 0, `${label}: controls must restore after drawing`);
          }
          for (let i = 0; i < visibleControls.length; i++) for (let j = i + 1; j < visibleControls.length; j++) {
            const a = visibleControls[i], b = visibleControls[j];
            const overlapWidth = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.x, b.rect.x);
            const overlapHeight = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.y, b.rect.y);
            assert.ok(overlapWidth <= 0.5 || overlapHeight <= 0.5,
              `${label}: ${a.className} and ${b.className} have overlapping hit areas`);
          }
          assert.equal(result.debugCount, debug ? 1 : 0, label);
          assert.deepEqual(result.modeButtons.map(button => button.id), ['normal', 'hell', 'immortal', 'maze'], label);
          assert.deepEqual(result.modeButtons.map(button => button.label), ['萌新', '糕手', '神仙', '第二关'], label);
          assert.equal(result.selects, 0, `${label}: the difficulty dropdown must be completely removed`);
          assert.equal(result.modeIcons, 4, `${label}: all four difficulties must show their own icon`);
          for (const button of result.modeButtons) {
            assert.equal(button.title, button.id === 'maze' ? '' : button.label,
              `${label}: the locked maze should use the custom two-row tooltip`);
            if (button.id === 'maze') {
              assert.equal(button.opacity, 1, `${label}: the locked maze should remain clear instead of fading away`);
              assert.equal(button.color, 'rgb(102, 91, 75)', `${label}: the lock needs legible ink contrast`);
            }
            assert.equal(button.pressed, String(button.id === mode), `${label}: the current difficulty must be visibly selected`);
            assert.equal(button.disabled, button.id === 'maze' || ['DRAWING', 'GENERATING'].includes(state),
              `${label}: difficulty availability must follow game and map state`);
          }
          assert.notEqual(result.modeButtons.find(button => button.id === mode).background,
            result.modeButtons.find(button => button.id !== mode).background,
            `${label}: the active difficulty needs a distinct painted background`);
          assert.ok(result.messageHidden, `${label}: long status messages must remain visually hidden`);
          assert.ok(result.messageText.length > 0, `${label}: accessible status text must be preserved`);
          assert.equal(result.toolbarInk, 0, `${label}: the ink percentage belongs beside the brush, outside the toolbar`);
          assert.equal(result.cursorInk, state === 'FAILED' ? '0%' : '100%', `${label}: cursor ink must update immediately`);
          assert.equal(result.tailLength, 45, `${label}: every difficulty must use the same 45px tail`);
          assert.equal(result.outlineLength, 45, `${label}: the outline must match the short tail`);
          assert.ok(result.paintedTail.pieces > 0 && result.paintedTail.height > 0,
            `${label}: the brush tail must contain visible ink geometry`);
          assert.ok(Math.abs(result.paintedTail.x - 195) < 0.1 && Math.abs(result.paintedTail.width - 45) < 0.1,
            `${label}: the actual painted ink must be clipped to 45px, not only the hidden centerline`);
          assert.equal(result.dragDisabled, ['DRAWING', 'GENERATING'].includes(state), `${label}: drag availability must follow game state`);
          assert.doesNotMatch(result.text, /PagePath|START|FINISH|测试状态说明|从起点|墨水余量|网页就是关卡/i,
            `${label}: prose or branding is still visible`);
          assert.equal(result.nodeKinds.length, 4, `${label}: every node should still render`);
          assert.ok(result.nodeKinds[0].iconPaths > 0 && result.nodeKinds.at(-1).iconPaths > 0,
            `${label}: start and finish must use their new graphical icons`);
          assert.ok(result.nodeKinds.every(node => node.labels.length === 0), `${label}: nodes must use symbols without word labels`);
          if (!expectedReserved) expectedReserved = result.reserved;
          else assert.deepEqual(result.reserved, expectedReserved, `${label}: changing mode or state moved the reserved control area`);
          cases++;
        }

        // Updating a map's resolved budget must not reintroduce node counts or
        // ink calculations into the concise difficulty hover labels.
        for (const nodeCount of [16, 18, 17]) {
          const budget = await page.evaluate(nodeCount => {
            const level = sampleLevel('hell', nodeCount);
            overlay.renderLevel(level);
            const selectedButton = overlay.modeButtons.find(button => button.dataset.mode === 'hell');
            const fromLevel = selectedButton.title;
            overlay.update({ state: 'READY', mode: 'hell', nodes: 0, total: nodeCount, ink: 100,
              inkMultiplier: level.inkMultiplier });
            const explicit = selectedButton.title;
            overlay.update({ ink: 67 });
            return { fromLevel, explicit, afterInk: selectedButton.title,
              iconTitle: overlay.modeControl.title,
              inactiveTitles: overlay.modeButtons.filter(button => button !== selectedButton && button.dataset.mode !== 'maze').map(button => button.title),
            };
          }, nodeCount);
          for (const title of [budget.fromLevel, budget.explicit, budget.afterInk, budget.iconTitle]) {
            assert.equal(title, '糕手', `${nodeCount}-node map must still show only the difficulty name`);
          }
          assert.deepEqual(budget.inactiveTitles, ['萌新', '神仙']);
        }

        // Check real pointer hit testing: the brush is decoration, and its tip
        // must stay on the same viewport coordinate used by collision checks.
        await page.evaluate(() => {
          overlay.renderLevel(sampleLevel('immortal'));
          overlay.update({ state: 'READY', mode: 'immortal', nodes: 0, total: 4, ink: 100 });
          overlay.modeButtons[0].focus();
        });
        for (const [index, mode, key] of [[0, 'normal', 'Space'], [1, 'hell', 'Enter'], [2, 'immortal', 'Space']]) {
          assert.equal(await page.evaluate(index => overlay.shadowRoot.activeElement === overlay.modeButtons[index], index), true,
            `${width}px: each direct difficulty button must be reachable with Tab`);
          await page.keyboard.press(key);
          assert.equal(await page.evaluate(() => calls.filter(([name]) => name === 'onModeChange').at(-1)?.[1]), mode,
            `${width}px: ${key} should activate ${mode}`);
          await page.evaluate(mode => overlay.update({ mode }), mode);
          if (index < 2) await page.keyboard.press('Tab');
        }
        const selectedCalls = await page.evaluate(() => calls.filter(([name]) => name === 'onModeChange').length);
        await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(() => calls.filter(([name]) => name === 'onModeChange').length), selectedCalls,
          'activating the selected mode should preserve the current map');
        for (const state of ['READY', 'FAILED', 'SUCCESS', 'PAUSED', 'GENERATING']) {
          await page.evaluate(state => overlay.update({ state }), state);
          await page.mouse.move(110, 410);
          const idleCursor = await page.evaluate(() => ({ system: getComputedStyle(overlay.surface).cursor,
            brush: overlay.brushCursor.dataset.visible, ink: overlay.cursorInk.dataset.visible,
            warning: overlay.obstacleWarning.getAttribute('d') }));
          assert.deepEqual(idleCursor, { system: 'default', brush: 'false', ink: 'false', warning: '' },
            `${state}: moving the idle pointer must retain the system cursor without brush, ink or local warning`);
        }
        for (const [state, x, y] of [['DRAWING', 210, 510]]) {
          await page.evaluate(state => overlay.update({ state }), state);
          await page.mouse.move(x, y);
          const brush = await page.evaluate(() => {
            const cursor = overlay.brushCursor;
            if (!cursor) return null;
            const css = getComputedStyle(cursor), tip = new DOMPoint(7, 32).matrixTransform(cursor.getScreenCTM());
            const shaft = cursor.querySelector('.brush-body > path:first-child');
            const nib = cursor.querySelector('.brush-body .brush-tip');
            let axis = null;
            if (shaft && nib) {
              const shaftBox = shaft.getBBox(), nibBox = nib.getBBox();
              const top = new DOMPoint(shaftBox.x + shaftBox.width / 2, shaftBox.y).matrixTransform(shaft.getScreenCTM());
              const bottom = new DOMPoint(shaftBox.x + shaftBox.width / 2, shaftBox.y + shaftBox.height).matrixTransform(shaft.getScreenCTM());
              const apex = new DOMPoint(nibBox.x + nibBox.width / 2, nibBox.y + nibBox.height).matrixTransform(nib.getScreenCTM());
              const dx = bottom.x - top.x, dy = bottom.y - top.y;
              axis = { angle: Math.atan2(Math.abs(dx), Math.abs(dy)) * 180 / Math.PI,
                tipX: apex.x, tipY: apex.y,
                offset: Math.abs(dx * (apex.y - top.y) - dy * (apex.x - top.x)) / Math.hypot(dx, dy) };
            }
            return { pointerEvents: css.pointerEvents, hidden: css.display === 'none' || css.visibility === 'hidden' || Number(css.opacity) === 0,
              x: tip.x, y: tip.y, width: parseFloat(css.width), height: parseFloat(css.height), axis };
          });
          assert.ok(brush, `${width}px: the brush cursor is missing`);
          assert.equal(brush.pointerEvents, 'none', 'the brush graphic must never intercept drawing input');
          assert.equal(brush.hidden, false, `${state}: the brush should follow a pointer over the map`);
          assert.equal(brush.width, 24, `${state}: the new brush must use its smaller width`);
          assert.equal(brush.height, 36, `${state}: the new brush must use its smaller height`);
          assert.ok(Math.abs(brush.x - x) < 0.1 && Math.abs(brush.y - y) < 0.1,
            `${state}: brush tip (${brush.x},${brush.y}) differs from logical input (${x},${y})`);
          assert.ok(brush.axis, `${state}: shaft and nib must share the tilted brush-body group`);
          assert.ok(Math.abs(brush.axis.angle - 28) < 0.1, `${state}: the complete brush should visibly lean by 28 degrees`);
          assert.ok(brush.axis.offset < 0.1, `${state}: the nib apex must stay on the shaft's extended centerline`);
          assert.ok(Math.abs(brush.axis.tipX - x) < 0.1 && Math.abs(brush.axis.tipY - y) < 0.1,
            `${state}: the visible rotated nib must still end at the logical drawing coordinate`);
          for (const percentage of [73, 18, 0, 100]) {
            const ink = await page.evaluate(percentage => {
              overlay.update({ ink: percentage });
              const indicator = overlay.cursorInk, css = getComputedStyle(indicator), rect = indicator.getBoundingClientRect();
              return { text: indicator.textContent, pointerEvents: css.pointerEvents, fontSize: parseFloat(css.fontSize),
                visible: css.display !== 'none' && css.visibility !== 'hidden' && Number(css.opacity) > 0,
                x: rect.x, y: rect.y, width: rect.width, height: rect.height,
                inToolbar: overlay.toolbar.contains(indicator) };
            }, percentage);
            assert.equal(ink.text, `${percentage}%`, `${state}: remaining ink must update without another pointer event`);
            assert.equal(ink.pointerEvents, 'none', `${state}: the ink label must not block drawing input`);
            assert.equal(ink.visible, true, `${state}: ink must be visible beside the active brush`);
            assert.equal(ink.inToolbar, false);
            assert.ok(ink.fontSize <= 10, `${state}: the cursor percentage should remain small`);
            assert.ok(Math.abs(ink.x - x) < 50 && Math.abs(ink.y - y) < 50,
              `${state}: percentage must follow the brush instead of staying in a corner`);
          }
          const toolbarCenter = await page.evaluate(() => {
            const rect = overlay.toolbar.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          });
          await page.mouse.move(toolbarCenter.x, toolbarCenter.y);
          assert.equal(await page.evaluate(() => {
            const css = getComputedStyle(overlay.brushCursor);
            return css.display === 'none' || css.visibility === 'hidden' || Number(css.opacity) === 0;
          }), state !== 'DRAWING', 'only expanded controls should hide the map brush');
          assert.equal(await page.evaluate(() => {
            const css = getComputedStyle(overlay.cursorInk);
            return css.display === 'none' || css.visibility === 'hidden' || Number(css.opacity) === 0;
          }), state !== 'DRAWING', 'the collapsed toolbar must leave the accompanying ink label visible');
          if (state === 'DRAWING') {
            assert.equal(await page.evaluate(({ x, y }) => overlay.shadowRoot.elementFromPoint(x, y) === overlay.surface,
              toolbarCenter), true, 'the compact indicator must not intercept drawing input');
          }
        }

        await page.evaluate(() => overlay.update({ state: 'DRAWING', ink: 100 }));
        await page.mouse.move(width - 2, 718);
        const edgeInk = await page.evaluate(() => {
          const rect = overlay.cursorInk.getBoundingClientRect();
          return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom };
        });
        assert.ok(edgeInk.x >= 0 && edgeInk.y >= 0 && edgeInk.right <= width && edgeInk.bottom <= 720,
          `${width}px: the brush percentage must stay inside the viewport near its edges`);

        const toolbarBox = () => page.evaluate(() => {
          const rect = overlay.toolbar.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
        });
        const checkCollapseCycle = async positionLabel => {
          await page.evaluate(() => overlay.update({ state: 'READY' }));
          const original = await toolbarBox();
          const stored = await page.evaluate(() => ({ position: overlay.toolbarPosition,
            reserved: overlay.getReservedRects(), dragCalls: calls.filter(([name]) => name === 'onToolbarMove').length }));
          for (const restoredState of ['SUCCESS', 'FAILED', 'PAUSED', 'READY']) {
            await page.evaluate(() => {
              overlay.update({ state: 'DRAWING' });
              window.foldPointerEvents = [];
              window.foldListener = event => foldPointerEvents.push(event.type);
              for (const type of ['pointerdown', 'pointerup']) overlay.surface.addEventListener(type, foldListener);
            });
            assert.deepEqual(await toolbarBox(), original,
              `${width}px ${positionLabel}: collapsing must preserve the expanded toolbar layout bounds`);
            const points = [original.x + 4, original.x + original.width / 2, original.right - 4]
              .map(x => ({ x, y: original.y + original.height / 2 }));
            await page.mouse.move(points[0].x, points[0].y);
            await page.mouse.down();
            for (const point of points) {
              await page.mouse.move(point.x, point.y);
              const input = await page.evaluate(({ x, y }) => ({
                hitsSurface: overlay.shadowRoot.elementFromPoint(x, y) === overlay.surface,
                brushVisible: overlay.brushCursor.getAttribute('data-visible') === 'true',
                inkVisible: overlay.cursorInk.getAttribute('data-visible') === 'true',
                brushPoint: overlay.lastBrushPoint,
              }), point);
              assert.deepEqual(input, { hitsSurface: true, brushVisible: true, inkVisible: true, brushPoint: point },
                `${width}px ${positionLabel}: drawing across the original toolbar must retain input, brush and ink`);
            }
            await page.mouse.up();
            assert.deepEqual(await page.evaluate(() => {
              for (const type of ['pointerdown', 'pointerup']) overlay.surface.removeEventListener(type, foldListener);
              return foldPointerEvents;
            }), ['pointerdown', 'pointerup'], `${positionLabel}: a stroke must reach the surface through the collapsed toolbar`);
            await page.keyboard.press('Tab');
            assert.equal(await page.evaluate(() => overlay.toolbarMain.contains(overlay.shadowRoot.activeElement)), false,
              `${positionLabel}: Tab must not enter collapsed controls`);
            if (width === 375 && !debug && positionLabel === 'centered' && restoredState === 'SUCCESS') {
              const folder = path.join(__dirname, '..', 'test-results');
              fs.mkdirSync(folder, { recursive: true });
              await page.mouse.move(width - 2, 718);
              await page.screenshot({ path: path.join(folder, 'toolbar-collapsed.png'), clip: { x: 0, y: 0, width, height: 110 } });
            }
            await page.evaluate(state => overlay.update({ state }), restoredState);
            assert.deepEqual(await page.evaluate(() => ({ cursor: getComputedStyle(overlay.surface).cursor,
              brush: overlay.brushCursor.dataset.visible, ink: overlay.cursorInk.dataset.visible,
              warning: overlay.obstacleWarning.getAttribute('d') })),
            { cursor: 'default', brush: 'false', ink: 'false', warning: '' },
            `${positionLabel}: ${restoredState} must immediately restore the cursor and clear local warnings`);
            const restored = await page.evaluate(() => ({ position: overlay.toolbarPosition,
              reserved: overlay.getReservedRects(), inert: overlay.toolbarMain.inert,
              visibility: getComputedStyle(overlay.toolbarMain).visibility,
              dragCalls: calls.filter(([name]) => name === 'onToolbarMove').length }));
            assert.deepEqual(await toolbarBox(), original,
              `${positionLabel}: ${restoredState} must restore controls at their prior position`);
            assert.deepEqual(restored, { ...stored, inert: false, visibility: 'visible' },
              `${positionLabel}: ${restoredState} must preserve placement and reservations without reporting a drag`);
            if (width === 375 && !debug && positionLabel === 'centered' && restoredState === 'SUCCESS') {
              await page.screenshot({ path: path.join(__dirname, '..', 'test-results', 'toolbar-restored.png'),
                clip: { x: 0, y: 0, width, height: 110 } });
            }
          }
        };
        await checkCollapseCycle('centered');
        const handlePoint = () => page.evaluate(() => {
          const rect = overlay.toolbar.querySelector('.drag-handle').getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        });
        const moveToolbar = async (toX, toY) => {
          const from = await handlePoint();
          await page.mouse.move(from.x, from.y);
          await page.mouse.down();
          await page.mouse.move(toX, toY, { steps: 5 });
          await page.mouse.up();
          return toolbarBox();
        };
        const originalToolbar = await toolbarBox(), origin = await handlePoint();
        const movedToolbar = await moveToolbar(origin.x + 25, origin.y + 130);
        assert.ok(movedToolbar.y > originalToolbar.y + 100, `${width}px: dragging the handle must move the toolbar`);
        const moveCallback = await page.evaluate(() => calls.filter(([name]) => name === 'onToolbarMove').at(-1)?.[1]);
        assert.ok(moveCallback?.rect && moveCallback?.previousRect, 'drag completion must report both reserved positions');
        assert.ok(moveCallback.rect.y > moveCallback.previousRect.y, 'the drag callback must describe the completed movement');
        const movedReserved = await page.evaluate(() => overlay.getReservedRects()[0]);
        assert.ok(movedReserved.y <= movedToolbar.y && movedReserved.bottom >= movedToolbar.bottom,
          'reserved geometry must follow the moved controls');
        await checkCollapseCycle('dragged');

        // Native controls keep their click behavior and must not begin a drag.
        const beforeButtons = await toolbarBox();
        for (const [selector, callback] of [['.hint', 'onHint'], ['.retry', 'onRetry'], ['.new-puzzle', 'onNewPuzzle'], ['.exit', 'onExit']]) {
          const beforeCount = await page.evaluate(name => calls.filter(([called]) => called === name).length, callback);
          await page.locator(`[data-pagepath-root] ${selector}`).click();
          assert.equal(await page.evaluate(name => calls.filter(([called]) => called === name).length, callback), beforeCount + 1);
          assert.deepEqual(await toolbarBox(), beforeButtons, `${selector}: clicking a control must not move the toolbar`);
        }
        await page.locator('[data-pagepath-root] .mode-button[data-mode="hell"]').click();
        assert.equal(await page.evaluate(() => calls.filter(([name]) => name === 'onModeChange').at(-1)?.[1]), 'hell');
        assert.deepEqual(await toolbarBox(), beforeButtons, 'changing difficulty must not begin a toolbar drag');

        // The toolbar background is also a drag surface, without stealing the
        // action buttons or the three difficulty icons above it.
        await page.mouse.move(beforeButtons.x + beforeButtons.width / 2, beforeButtons.bottom - 3);
        await page.mouse.down();
        await page.mouse.move(beforeButtons.x + beforeButtons.width / 2, beforeButtons.bottom + 47, { steps: 3 });
        await page.mouse.up();
        assert.ok((await toolbarBox()).y >= beforeButtons.y + 45, 'dragging toolbar blank space should work too');

        const lowerRight = await moveToolbar(width + 200, 920);
        assert.ok(lowerRight.x >= 0 && lowerRight.y >= 0 && lowerRight.right <= width && lowerRight.bottom <= 720,
          `${width}px: dragging past the lower right corner must clamp the controls inside the viewport`);
        await page.setViewportSize({ width, height: 480 });
        await page.waitForFunction(() => overlay.toolbar.getBoundingClientRect().bottom <= innerHeight, null, { timeout: 2000 });
        assert.ok((await toolbarBox()).bottom <= 480, 'shrinking the viewport must clamp an already moved toolbar');
        await page.setViewportSize({ width, height: 720 });
        const upperLeft = await moveToolbar(-200, -200);
        assert.ok(upperLeft.x >= 0 && upperLeft.y >= 0 && upperLeft.right <= width && upperLeft.bottom <= 720,
          `${width}px: dragging past the upper left corner must clamp the controls inside the viewport`);
        await page.locator('[data-pagepath-root] .drag-handle').focus();
        await page.keyboard.press('ArrowDown');
        assert.ok((await toolbarBox()).y > upperLeft.y, 'the drag handle must support keyboard movement');

        // The locked fourth mode shows only two colored criterion marks in a
        // tooltip outside the clipped toolbar, with an accessible equivalent.
        const unavailable = await page.evaluate(() => {
          overlay.update({ state: 'READY', mazeAvailability: { available: false, reason: '页面内容太少，无法生成迷宫',
            obstacleRatio: .423, occupiedRegions: 27,
            requirements: __PAGEPATH__.Config.MAZE_REQUIREMENTS, details: { measured: true } } });
          const button = overlay.modeButtons.find(button => button.dataset.mode === 'maze');
          return { disabled: button.disabled, title: button.title, wrapperTitle: overlay.mazeModeSlot.title,
            reason: overlay.mazeReason.textContent, describedBy: button.getAttribute('aria-describedby'),
            opacity: Number(getComputedStyle(button).opacity),
            lock: getComputedStyle(button.querySelector('.maze-locked-mark')).display,
            star: getComputedStyle(button.querySelector('.maze-unlocked-mark')).display,
            lockHeight: button.querySelector('.maze-locked-mark').getBBox().height,
            criteria: mazeCriteriaSnapshot(), outside: overlay.mazeTooltip.parentNode === overlay.shadowRoot,
            retained: { obstacleRatio: overlay.mazeAvailability.obstacleRatio,
              occupiedRegions: overlay.mazeAvailability.occupiedRegions,
              requirements: overlay.mazeAvailability.requirements, details: overlay.mazeAvailability.details },
            calls: calls.filter(([name]) => name === 'onModeChange').length };
        });
        assert.equal(unavailable.disabled, true);
        assert.equal(unavailable.opacity, 1, 'a locked maze must keep full icon opacity');
        assert.equal(unavailable.lock, 'inline', 'a locked maze should show a lock');
        assert.equal(unavailable.star, 'none', 'the locked icon must not overlap the unlocked star');
        assert.ok(unavailable.lockHeight >= 16, 'the lock must occupy a legible share of the icon');
        assert.equal(unavailable.title, '');
        assert.equal(unavailable.wrapperTitle, '', 'an explicit empty title must suppress native ancestor tooltips');
        assert.equal(unavailable.reason, '复杂度：已达标；分散度：未达标');
        assert.equal(unavailable.describedBy, 'pagepath-maze-reason');
        assert.equal(unavailable.outside, true, 'the tooltip must be outside the toolbar overflow clip');
        assert.deepEqual(unavailable.criteria, [
          { criterion: 'complexity', label: '复杂度', passed: 'true', description: '复杂度：已达标', color: 'rgb(57, 115, 63)', mark: 'M3 8L6.5 11.5L13 4.5' },
          { criterion: 'distribution', label: '分散度', passed: 'false', description: '分散度：未达标', color: 'rgb(179, 69, 63)', mark: 'M4 4L12 12M12 4L4 12' },
        ]);
        assert.deepEqual(unavailable.retained, { obstacleRatio: .423, occupiedRegions: 27,
          requirements: { minObstacleRatio: .2, minOccupiedRegions: 30 }, details: { measured: true } },
        'the overlay must retain source measurements and returned requirements');
        const disabledPosition = await toolbarBox();
        await page.locator('[data-pagepath-root] .maze-mode-slot').hover();
        assert.equal(await page.evaluate(() => overlay.mazeTooltip.hidden), false, 'hover should reveal the two criteria');
        assert.deepEqual(await page.locator('[data-pagepath-root] .maze-criterion span').allTextContents(), ['复杂度', '分散度']);
        assert.equal(await page.locator('[data-pagepath-root] .maze-tooltip-guide').textContent(), '寻找复杂的页面来解锁第二关。');
        assert.doesNotMatch(await page.locator('[data-pagepath-root] .maze-tooltip').textContent(), /\d|%|原因/);
        await page.locator('[data-pagepath-root] .maze-mode-slot').click();
        assert.equal(await page.evaluate(() => calls.filter(([name]) => name === 'onModeChange').length), unavailable.calls,
          'the disabled maze must not dispatch a mode change');
        assert.deepEqual(await toolbarBox(), disabledPosition, 'clicking a disabled maze must not start a toolbar drag');
        assert.equal(await page.evaluate(() => {
          const button = overlay.modeButtons.find(button => button.dataset.mode === 'maze');
          button.click();
          button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return calls.filter(([name]) => name === 'onModeChange').length;
        }), unavailable.calls, 'programmatic clicks must not bypass a locked maze button');
        await page.mouse.move(width - 2, 718);
        await page.evaluate(() => overlay.mazeModeSlot.blur());
        assert.equal(await page.evaluate(() => overlay.mazeTooltip.hidden), true, 'leaving hover and focus must hide the tooltip');
        await page.locator('[data-pagepath-root] .mode-button[data-mode="immortal"]').focus();
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => overlay.shadowRoot.activeElement === overlay.mazeModeSlot && !overlay.mazeTooltip.hidden), true,
          'keyboard Tab should reach the locked wrapper and expose the same two criteria');
        await page.keyboard.press('Enter');
        await page.keyboard.press('Space');
        assert.equal(await page.evaluate(() => calls.filter(([name]) => name === 'onModeChange').length), unavailable.calls,
          'keyboard inspection must never unlock or activate the disabled second stage');
        const anchored = await page.evaluate(() => {
          overlay.positionToolbar(innerWidth, innerHeight);
          const anchor = overlay.mazeModeSlot.getBoundingClientRect(), tip = overlay.mazeTooltip.getBoundingClientRect();
          return { x: tip.x, y: tip.y, right: tip.right, bottom: tip.bottom, anchorTop: anchor.top, hidden: overlay.mazeTooltip.hidden };
        });
        assert.equal(anchored.hidden, false);
        assert.ok(anchored.x >= 0 && anchored.y >= 0 && anchored.right <= width && anchored.bottom <= 720);
        assert.ok(anchored.bottom < anchored.anchorTop, 'near the bottom edge the tooltip should flip above its icon');
        await page.setViewportSize({ width, height: 360 });
        await page.waitForFunction(() => overlay.mazeTooltip.getBoundingClientRect().bottom <= innerHeight);
        const resizedTooltip = await page.evaluate(() => {
          const rect = overlay.mazeTooltip.getBoundingClientRect();
          return { x: rect.x, right: rect.right, y: rect.y, bottom: rect.bottom };
        });
        assert.ok(resizedTooltip.x >= 0 && resizedTooltip.right <= width && resizedTooltip.y >= 0 && resizedTooltip.bottom <= 360,
          'a visible tooltip should follow viewport resizing');
        await page.setViewportSize({ width, height: 720 });
        await page.evaluate(position => overlay.positionToolbar(position.x, position.y), disabledPosition);
        for (const state of ['DRAWING', 'GENERATING']) {
          await page.evaluate(() => { overlay.update({ state: 'READY' }); overlay.mazeModeSlot.blur(); overlay.mazeModeSlot.focus(); });
          assert.equal(await page.evaluate(() => overlay.mazeTooltip.hidden), false);
          await page.evaluate(state => overlay.update({ state }), state);
          assert.equal(await page.evaluate(() => overlay.mazeTooltip.hidden), true, `${state}: the unlock tooltip must hide immediately`);
        }
        await page.evaluate(() => { overlay.update({ state: 'READY' }); overlay.mazeModeSlot.blur(); overlay.mazeModeSlot.focus(); overlay.setCaptureHidden(true); });
        assert.equal(await page.evaluate(() => overlay.mazeTooltip.hidden), true, 'capture must hide the tooltip before taking the screenshot');
        await page.evaluate(() => { overlay.setCaptureHidden(false); overlay.mazeModeSlot.blur(); });
        if ([320, 1280].includes(width) && !debug) {
          await page.evaluate(() => overlay.positionToolbar((innerWidth - overlay.toolbar.getBoundingClientRect().width) / 2, 12));
          await page.locator('[data-pagepath-root] .maze-mode-slot').hover();
          await page.screenshot({ path: path.join(__dirname, '..', `test-results/maze-lock-${width}.png`),
            clip: { x: 0, y: 0, width, height: 150 } });
          await page.mouse.move(width - 2, 718);
        }
        const revised = await page.evaluate(() => {
          overlay.update({ mazeAvailability: { available: false, reason: '指标尚未达标', obstacleRatio: .52,
            occupiedRegions: 33,
            requirements: { minObstacleRatio: .55, minOccupiedRegions: 34 } } });
          const measured = mazeCriteriaSnapshot();
          overlay.update({ mazeAvailability: { available: false, reason: '正在检查页面是否适合生成迷宫' } });
          return { measured, pending: mazeCriteriaSnapshot(), description: overlay.mazeReason.textContent,
            oldMeasurements: ['obstacleRatio', 'occupiedRegions', 'details']
              .some(key => Object.hasOwn(overlay.mazeAvailability, key)) };
        });
        assert.deepEqual(revised.measured.map(row => row.passed), ['false', 'false'], 'returned custom targets must replace the defaults');
        assert.deepEqual(revised.pending.map(row => row.passed), ['false', 'false'], 'pending data must not imply that either criterion passes');
        assert.equal(revised.description, pendingMazeDescription);
        assert.equal(revised.oldMeasurements, false, 'pending capture must discard the previous page measurements');
        const partial = await page.evaluate(() => {
          overlay.update({ mazeAvailability: { available: false, reason: '待完成检测',
            obstacleRatio: 0, occupiedRegions: null } });
          return mazeCriteriaSnapshot();
        });
        assert.deepEqual(partial.map(row => row.description), ['复杂度：未达标', '分散度：待检测']);
        assert.deepEqual(partial.map(row => row.passed), ['false', 'false']);
        const invalid = await page.evaluate(() => {
          overlay.update({ mazeAvailability: { available: false, obstacleRatio: 1.5, occupiedRegions: 49 } });
          return { rows: mazeCriteriaSnapshot(), description: overlay.mazeReason.textContent };
        });
        assert.equal(invalid.description, pendingMazeDescription);
        assert.deepEqual(invalid.rows.map(row => row.passed), ['false', 'false']);
        const nearThreshold = await page.evaluate(() => {
          overlay.update({ mazeAvailability: { available: false, reason: '指标尚未达标',
            obstacleRatio: __PAGEPATH__.Config.MAZE_REQUIREMENTS.minObstacleRatio - .00001, occupiedRegions: 32 } });
          return mazeCriteriaSnapshot();
        });
        assert.deepEqual(nearThreshold.map(row => row.passed), ['false', 'true'],
          'criterion checks must use the full precision of the source measurements');
        await page.locator('[data-pagepath-root] .maze-mode-slot').focus();
        assert.equal(await page.evaluate(() => overlay.mazeTooltip.hidden), false);
        const enabled = await page.evaluate(() => {
          overlay.update({ mazeAvailability: { available: true, reason: '' } });
          const button = overlay.modeButtons.find(button => button.dataset.mode === 'maze');
          return { disabled: button.disabled, title: button.title, wrapperTitle: overlay.mazeModeSlot.title,
            description: button.getAttribute('aria-describedby'),
            tooltipHidden: overlay.mazeTooltip.hidden,
            lock: getComputedStyle(button.querySelector('.maze-locked-mark')).display,
            star: getComputedStyle(button.querySelector('.maze-unlocked-mark')).display,
            starPath: button.querySelector('.maze-unlocked-mark').innerHTML };
        });
        assert.deepEqual(enabled, { disabled: false, title: '第二关', wrapperTitle: '第二关', description: null,
          tooltipHidden: true, lock: 'none', star: 'inline',
          starPath: '<path d="M12 2.5L14.9 8.5L21.5 9.4L16.8 14L17.9 20.6L12 17.5L6.1 20.6L7.2 14L2.5 9.4L9.1 8.5Z"></path>' });
        if ([320, 1280].includes(width) && !debug) {
          await page.evaluate(() => overlay.mazeModeSlot.blur());
          await page.locator('[data-pagepath-root] .mode-button[data-mode="maze"]').hover();
          await page.screenshot({ path: path.join(__dirname, '..', `test-results/maze-star-${width}.png`),
            clip: { x: 0, y: 0, width, height: 100 } });
        }
        await page.locator('[data-pagepath-root] .mode-button[data-mode="maze"]').click();
        assert.equal(await page.evaluate(() => calls.filter(([name]) => name === 'onModeChange').at(-1)?.[1]), 'maze');
        const failedGeneration = await page.evaluate(() => {
          overlay.renderLevel(null);
          overlay.update({ state: 'FAILED', generationFailed: true, mode: 'maze', unlimitedInk: true,
            nodes: 0, total: 0, message: '第二关生成失败：现有通道尚未找到可解路线 · 可重试新地图、刷新页面截图或切换难度' });
          overlay.moveBrush({ clientX: 100, clientY: 300, pointerType: 'mouse' });
          overlay.renderHint(true);
          overlay.renderPath([]);
          const errorStyle = getComputedStyle(overlay.generationError), errorRect = overlay.generationError.getBoundingClientRect();
          return { state: overlay.state, failed: overlay.generationFailed, stateLabel: overlay.stateLabel.textContent,
            message: overlay.message.textContent, error: overlay.generationError.textContent,
            errorVisible: !overlay.generationError.hidden && errorStyle.display !== 'none' && errorStyle.clipPath === 'none',
            errorRect: { left: errorRect.left, right: errorRect.right, top: errorRect.top, bottom: errorRect.bottom },
            errorOverflow: overlay.generationError.scrollWidth > overlay.generationError.clientWidth,
            errorPointerEvents: errorStyle.pointerEvents, cursor: getComputedStyle(overlay.surface).cursor,
            brushVisible: overlay.brushCursor.dataset.visible, inkVisible: overlay.cursorInk.dataset.visible,
            ink: overlay.cursorInk.textContent, hintDisabled: overlay.hintButton.disabled,
            refresh: { disabled: overlay.retryButton.disabled, label: overlay.retryButton.getAttribute('aria-label'),
              title: overlay.retryButton.title, icon: overlay.retryButton.dataset.refresh },
            newMap: { disabled: overlay.newPuzzleButton.disabled, hidden: overlay.newPuzzleButton.hidden },
            modesEnabled: overlay.modeButtons.every(button => !button.disabled),
            mazeSelected: overlay.modeButtons.find(button => button.dataset.mode === 'maze').getAttribute('aria-pressed'),
            nodes: overlay.nodeElements.size, walls: overlay.mazeWallLayer.childElementCount,
            hints: overlay.hintLayer.childElementCount, inert: overlay.toolbarMain.inert };
        });
        assert.equal(failedGeneration.state, 'FAILED');
        assert.equal(failedGeneration.failed, true);
        assert.equal(failedGeneration.stateLabel, '生成失败');
        assert.match(failedGeneration.message, /第二关生成失败.*新地图.*刷新.*切换/);
        assert.equal(failedGeneration.error, failedGeneration.message);
        assert.equal(failedGeneration.errorVisible, true, 'generation failures must be visible without hovering or assistive technology');
        assert.ok(failedGeneration.errorRect.left >= 0 && failedGeneration.errorRect.right <= width &&
          failedGeneration.errorRect.top >= 0 && failedGeneration.errorRect.bottom <= 720, 'the error card must fit every viewport');
        assert.equal(failedGeneration.errorOverflow, false);
        assert.equal(failedGeneration.errorPointerEvents, 'none');
        assert.equal(failedGeneration.cursor, 'default', 'a missing level should restore the system cursor');
        assert.equal(failedGeneration.brushVisible, 'false');
        assert.equal(failedGeneration.inkVisible, 'false');
        assert.equal(failedGeneration.ink, '∞');
        assert.equal(failedGeneration.hintDisabled, true);
        assert.deepEqual(failedGeneration.refresh, { disabled: false, label: '刷新地图', title: '重新截取页面并生成关卡', icon: 'true' });
        assert.deepEqual(failedGeneration.newMap, { disabled: false, hidden: false });
        assert.equal(failedGeneration.modesEnabled, true, 'generation failure must not relock the already eligible second stage');
        assert.equal(failedGeneration.mazeSelected, 'true');
        assert.equal(failedGeneration.nodes + failedGeneration.walls + failedGeneration.hints, 0, 'there must be no fake playable level');
        assert.equal(failedGeneration.inert, false);
        for (const [selector, callback] of [['.new-puzzle', 'onNewPuzzle'], ['.retry', 'onRegenerate']]) {
          const before = await page.evaluate(name => calls.filter(([called]) => called === name).length, callback);
          await page.locator(`[data-pagepath-root] ${selector}`).click();
          assert.equal(await page.evaluate(name => calls.filter(([called]) => called === name).length, callback), before + 1);
        }
        await page.locator('[data-pagepath-root] .mode-button[data-mode="normal"]').focus();
        await page.keyboard.press('Space');
        assert.equal(await page.evaluate(() => calls.filter(([name]) => name === 'onModeChange').at(-1)?.[1]), 'normal');
        const failedToolbar = await toolbarBox();
        await page.locator('[data-pagepath-root] .drag-handle').focus();
        await page.keyboard.press('ArrowDown');
        assert.ok((await toolbarBox()).y > failedToolbar.y, 'controls remain movable when no maze was generated');
        cases++;
        await page.evaluate(() => {
          overlay.renderLevel(sampleLevel('maze'));
          overlay.update({ state: 'READY', generationFailed: false, mode: 'maze', nodes: 0, total: 2, unlimitedInk: true, ink: 100 });
        });
        assert.deepEqual(await page.evaluate(() => ({ errorHidden: overlay.generationError.hidden,
          error: overlay.generationError.textContent, label: overlay.retryButton.getAttribute('aria-label'),
          title: overlay.retryButton.title, refreshIcon: overlay.retryButton.dataset.refresh })),
        { errorHidden: true, error: '', label: '重试', title: '重试当前关卡', refreshIcon: 'false' },
        'successful generation must remove the error card and restore normal retry controls');
        const mazePosition = await toolbarBox();
        for (const state of states) {
          const maze = await page.evaluate(state => {
            overlay.update({ state, ink: 0, nodes: state === 'SUCCESS' ? 2 : 0, hintVisible: true });
            overlay.renderHint(true);
            const wall = overlay.mazeWallLayer.querySelector('.maze-wall');
            const rect = wall?.getBBox(), css = wall && getComputedStyle(wall);
            return { ink: overlay.cursorInk.textContent, inkLabel: overlay.cursorInk.getAttribute('aria-label'),
              lowInk: overlay.cursorInk.dataset.low, nodeMetricHidden: overlay.nodeMetric.hidden,
              mazeMetricVisible: !overlay.mazeMetric.hidden, metricLabel: overlay.mazeMetric.getAttribute('aria-label'),
              message: overlay.message.textContent, nodes: overlay.nodeElements.size,
              inert: overlay.toolbarMain.inert, visibility: getComputedStyle(overlay.toolbarMain).visibility,
              selected: overlay.modeButtons.find(button => button.dataset.mode === 'maze').getAttribute('aria-pressed'),
              hint: { hidden: overlay.hintButton.hidden, display: getComputedStyle(overlay.hintButton).display,
                disabled: overlay.hintButton.disabled, pressed: overlay.hintButton.getAttribute('aria-pressed'),
                children: overlay.hintLayer.childElementCount, obstacles: getComputedStyle(overlay.allObstacles).visibility },
              walls: wall ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
                fill: css.fill, fillOpacity: Number(css.fillOpacity), stroke: css.stroke,
                display: css.display, visibility: css.visibility,
                pointerEvents: getComputedStyle(overlay.mazeWallLayer).pointerEvents } : null };
          }, state);
          assert.equal(maze.ink, '∞', `${state}: unlimited ink should never show a percentage`);
          assert.equal(maze.inkLabel, '无限墨水');
          assert.equal(maze.lowInk, 'false', 'unlimited ink should never appear exhausted');
          assert.equal(maze.nodeMetricHidden, true, 'a maze must not show checkpoint collection counts');
          assert.equal(maze.mazeMetricVisible, true, 'a maze should show the inkstone-to-paper goal symbol');
          assert.match(maze.metricLabel, /迷宫/);
          assert.doesNotMatch(maze.message, /收集.*墨点|墨水.*(?:耗尽|不足)/);
          assert.equal(maze.nodes, 2, 'only start and finish should be displayed for a maze');
          assert.equal(maze.inert, state === 'DRAWING');
          assert.equal(maze.visibility, state === 'DRAWING' ? 'hidden' : 'visible');
          assert.equal(maze.selected, 'true');
          assert.deepEqual(maze.hint, { hidden: true, display: 'none', disabled: true, pressed: 'false',
            children: 0, obstacles: 'hidden' }, `${state}: the maze must hide and reject all answer hints`);
          assert.equal(maze.walls, null, `${state}: added connections must not have any globally painted wall geometry`);
          assert.deepEqual(await toolbarBox(), mazePosition, `${state}: a maze should retain toolbar placement`);
          cases++;
        }
        await checkCollapseCycle('maze');
        const cleared = await page.evaluate(() => {
          overlay.update({ ink: NaN });
          const unlimitedAfterPartial = overlay.cursorInk.textContent;
          overlay.renderLevel(sampleLevel('normal'));
          overlay.update({ state: 'READY', ink: 73 });
          return { unlimitedAfterPartial, ink: overlay.cursorInk.textContent,
            inkLabel: overlay.cursorInk.getAttribute('aria-label'), walls: overlay.mazeWallLayer.childElementCount,
            nodesMetric: !overlay.nodeMetric.hidden, mazeMetricHidden: overlay.mazeMetric.hidden,
            hintHidden: overlay.hintButton.hidden, hintDisabled: overlay.hintButton.disabled,
            hintDisplay: getComputedStyle(overlay.hintButton).display };
        });
        assert.deepEqual(cleared, { unlimitedAfterPartial: '∞', ink: '73%', inkLabel: '剩余墨水 73%',
          walls: 0, nodesMetric: true, mazeMetricHidden: true, hintHidden: false, hintDisabled: false,
          hintDisplay: 'grid' }, 'leaving the maze should restore ordinary UI, including route hints, and remove its walls');

        // Destroy during an active drag exercises native capture release as
        // well as removing the otherwise detached pointer listeners.
        await page.evaluate(() => {
          overlay.toolbar.addEventListener('gotpointercapture', event => {
            window.dragPointerId = event.pointerId;
          }, { once: true });
        });
        const finalHandle = await handlePoint();
        await page.mouse.move(finalHandle.x, finalHandle.y);
        await page.mouse.down();
        await page.mouse.move(finalHandle.x + 3, finalHandle.y + 20);
        assert.equal(await page.evaluate(() => overlay.toolbar.hasPointerCapture(dragPointerId)), true,
          'a real toolbar drag must retain pointer capture');
        const cleanup = await page.evaluate(() => {
          const host = overlay.host, cursor = overlay.brushCursor, ink = overlay.cursorInk, surface = overlay.surface;
          const capturedToolbar = overlay.toolbar;
          overlay.destroy();
          surface.dispatchEvent(new PointerEvent('pointermove', { clientX: 80, clientY: 400 }));
          return { hostConnected: host.isConnected, cursorConnected: cursor.isConnected, inkConnected: ink.isConnected,
            captured: capturedToolbar.hasPointerCapture(dragPointerId),
            overlays: document.querySelectorAll('[data-pagepath-root]').length,
            listeners: overlay.listeners.length, nodes: overlay.nodeElements.size, state: overlay.state };
        });
        await page.mouse.up();
        assert.deepEqual(cleanup, { hostConnected: false, cursorConnected: false, inkConnected: false, captured: false, overlays: 0,
          listeners: 0, nodes: 0, state: 'DESTROYED' }, 'destroy must remove cursor, controls, nodes and listeners');
      }
    }
    const proximity = await page.evaluate(async () => {
      const P = __PAGEPATH__, width = innerWidth, height = innerHeight;
      const mask = new Uint8Array(width * height), distanceMap = new Float32Array(mask.length);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        mask[y * width + x] = (x < 178 || x >= 218) && (x < 798 || x >= 838) ? 1 : 0;
        distanceMap[y * width + x] = Math.max(0, x < 180 ? 180 - x : x < 216 ? 0 :
          x < 800 ? Math.min(x - 216, 800 - x) : x < 836 ? 0 : x - 836);
      }
      const buckets = Object.create(null);
      const segments = new Float32Array([178, 0, 178, height, 218, 0, 218, height,
        798, 0, 798, height, 838, 0, 838, height]);
      for (let index = 0; index < segments.length; index += 4) {
        for (let by = 0; by <= Math.floor(height / 64); by++) {
          (buckets[`${Math.floor(segments[index] / 64)},${by}`] ||= []).push(index / 4);
        }
      }
      const map = { kind: 'pixel-mask', width, height, maskWidth: width, maskHeight: height,
        walkableMask: mask, distanceMap, contours: { segments, bucketSize: 64, buckets } };
      const index = P.Collision.createMaskIndex(map), ui = new P.Overlay({});
      ui.renderLevel(sampleLevel('normal')); ui.setMap(map); ui.update({ state: 'READY' });
      const read = x => {
        ui.renderProximity({ x, y: 300 });
        const box = ui.obstacleWarning.getBBox();
        return { d: ui.obstacleWarning.getAttribute('d'), opacity: Number(ui.obstacleWarning.getAttribute('opacity')),
          strokeWidth: parseFloat(getComputedStyle(ui.obstacleWarning).strokeWidth),
          radius: Number(ui.warningGradient.getAttribute('r')), x: box.x, y: box.y, height: box.height };
      };
      const far = read(100), expandedRange = read(124), approaching = read(160), near = read(176);
      const onBoundary = P.Collision.pointHits({ x: 178, y: 300 }, index);
      const inside = P.Collision.pointHits({ x: 177.5, y: 300 }, index);
      ui.hideBrush(); const hidden = ui.obstacleWarning.getAttribute('d');

      const fullPath = ui.obstacleShape.getAttribute('d');
      const coordinates = (fullPath.match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi) || []).map(Number);
      const globalInitiallyHidden = getComputedStyle(ui.allObstacles).visibility;
      ui.renderHint(true);
      const globalHint = { visible: getComputedStyle(ui.allObstacles).visibility,
        pointerEvents: getComputedStyle(ui.allObstacles).pointerEvents,
        length: ui.obstacleShape.getTotalLength(),
        complete: coordinates.length === segments.length && coordinates.every((value, i) => value === segments[i]),
        sharedGeometry: ui.allObstacles.getAttribute('href') === ui.obstacleFlash.getAttribute('href'),
        routeVisible: ui.hintLayer.querySelectorAll('.hint-path').length, title: ui.hintButton.title };
      const localWithHint = read(176);
      ui.hideBrush();
      const hintAfterPointerLeave = getComputedStyle(ui.allObstacles).visibility;
      // Inspect actual composited pixels: SVG <use> resolution inside a shadow
      // root must leave distant obstacle pixels unpainted when showing a route.
      const screenshot = await createImageBitmap(await (await fetch(await __obstacleScreenshot())).blob());
      const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d');
      context.drawImage(screenshot, 0, 0);
      const distantWallPixel = Array.from(context.getImageData(838, 600, 1, 1).data);
      screenshot.close();

      ui.flashObstacles();
      const animation = ui.flashAnimation;
      animation.pause(); animation.currentTime = Number(animation.effect.getTiming().duration) / 2;
      await new Promise(resolve => requestAnimationFrame(resolve));
      const duringFlash = { opacity: Number(getComputedStyle(ui.obstacleFlash).opacity),
        duration: animation.effect.getTiming().duration,
        pointerEvents: getComputedStyle(ui.obstacleFlash).pointerEvents };
      const flashScreenshot = await createImageBitmap(await (await fetch(await __obstacleScreenshot())).blob());
      context.clearRect(0, 0, width, height); context.drawImage(flashScreenshot, 0, 0);
      const flashedWallPixel = Array.from(context.getImageData(838, 600, 1, 1).data);
      flashScreenshot.close();
      animation.play();
      await animation.finished;
      await new Promise(resolve => requestAnimationFrame(resolve));
      const afterFlash = { animationCleared: ui.flashAnimation === null,
        opacity: Number(getComputedStyle(ui.obstacleFlash).opacity),
        hintVisibility: getComputedStyle(ui.allObstacles).visibility };
      ui.renderHint(false);
      const globalAfterHint = getComputedStyle(ui.allObstacles).visibility;
      const localAfterHint = read(160);

      ui.flashObstacles(); const cancelledByMap = ui.flashAnimation;
      ui.setMap(null);
      const clearedMap = { animationCleared: ui.flashAnimation === null,
        playState: cancelledByMap.playState, path: ui.obstacleShape.getAttribute('d'),
        visibility: getComputedStyle(ui.allObstacles).visibility };
      ui.setMap(map);
      ui.flashObstacles(); const replacedAnimation = ui.flashAnimation;
      ui.flashObstacles(); const destroyedAnimation = ui.flashAnimation;
      ui.moveBrush({ clientX: 176, clientY: 300, pointerType: 'mouse' });
      ui.destroy();
      await new Promise(resolve => requestAnimationFrame(resolve));
      return { far, expandedRange, approaching, near, onBoundary, inside, hidden,
        globalInitiallyHidden, globalHint, localWithHint, hintAfterPointerLeave, distantWallPixel, flashedWallPixel, duringFlash, afterFlash, globalAfterHint, localAfterHint,
        clearedMap, replacedAnimationState: replacedAnimation.playState, destroyedAnimationState: destroyedAnimation.playState,
        flashReleased: ui.flashAnimation === null,
        cachedMapReleased: ui.pixelMap === null, pendingFrame: ui.warningFrame,
        pathAfterDestroy: ui.obstacleWarning.getAttribute('d') };
    });
    assert.equal(proximity.far.d, '');
    assert.ok(proximity.expandedRange.d, 'the wall must warn at 54px, beyond the previous 24px range');
    assert.ok(proximity.approaching.d && proximity.near.d);
    assert.ok(proximity.near.opacity > proximity.approaching.opacity);
    assert.equal(proximity.near.radius, 56, 'the expanded preview uses a 56px radius');
    assert.equal(proximity.near.strokeWidth, 1.8, 'local red boundaries must use the stronger 1.8px stroke');
    assert.equal(proximity.near.x, 178, 'red line is the actual collision edge, not the source obstacle edge at x=180');
    assert.ok(proximity.near.y >= 244 && proximity.near.height <= 112, 'only nearby parts inside the expanded radius are drawn');
    assert.equal(proximity.onBoundary, true);
    assert.equal(proximity.inside, false);
    assert.equal(proximity.hidden, '');
    assert.equal(proximity.pathAfterDestroy, '');
    assert.equal(proximity.pendingFrame, 0);
    assert.equal(proximity.cachedMapReleased, true);
    assert.equal(proximity.globalInitiallyHidden, 'hidden');
    assert.equal(proximity.globalHint.visible, 'hidden', 'showing a route must keep all obstacle contours globally hidden');
    assert.equal(proximity.globalHint.routeVisible, 1);
    assert.equal(proximity.globalHint.title, '显示参考路线');
    assert.deepEqual(proximity.localWithHint, proximity.near, 'route hints preserve the same exact local collision warning');
    assert.equal(proximity.globalHint.pointerEvents, 'none');
    assert.equal(proximity.globalHint.complete, true, 'the cached contour geometry is preserved for proximity and new-map flashes');
    assert.equal(proximity.globalHint.length, 4 * 720);
    assert.equal(proximity.globalHint.sharedGeometry, true);
    assert.equal(proximity.hintAfterPointerLeave, 'hidden');
    assert.deepEqual(proximity.distantWallPixel, [255,255,255,255], 'the route hint must not paint a distant obstacle');
    assert.ok(proximity.flashedWallPixel[0] > proximity.flashedWallPixel[1] + 50 &&
      proximity.flashedWallPixel[0] > proximity.flashedWallPixel[2] + 40, 'the independent new-map flash still paints original obstacles');
    assert.ok(proximity.duringFlash.opacity > 0, 'the full-map flash must actually paint during its animation');
    assert.ok(proximity.duringFlash.duration > 0 && proximity.duringFlash.duration <= 1000, 'new-map highlighting is a brief, single flash');
    assert.equal(proximity.duringFlash.pointerEvents, 'none');
    assert.deepEqual(proximity.afterFlash, { animationCleared: true, opacity: 0, hintVisibility: 'hidden' },
      'finishing a flash must not leave persistent obstacle outlines');
    assert.equal(proximity.globalAfterHint, 'hidden');
    assert.ok(proximity.localAfterHint.d, 'closing the full-map hint restores normal local warnings');
    assert.deepEqual(proximity.clearedMap, { animationCleared: true, playState: 'idle', path: '', visibility: 'hidden' });
    assert.equal(proximity.replacedAnimationState, 'idle', 'a fresh flash cancels the previous animation');
    assert.equal(proximity.destroyedAnimationState, 'idle', 'destroy cancels an in-progress flash');
    assert.equal(proximity.flashReleased, true);
    const enclosed = await page.evaluate(() => {
      const P = __PAGEPATH__, width = innerWidth, height = innerHeight;
      const labels = new Int32Array(width * height), mask = new Uint8Array(labels.length);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const outer = x >= 178 && x < 338 && y >= 220 && y < 380;
        const inner = x >= 186 && x < 330 && y >= 228 && y < 372;
        const island = x >= 236 && x < 256 && y >= 280 && y < 300;
        const at = y * width + x;
        labels[at] = !outer ? 1 : inner && !island ? 2 : 0;
        mask[at] = labels[at] ? 1 : 0;
      }
      const rectangle = (x1, y1, x2, y2) => [x1,y1,x2,y1, x2,y1,x2,y2, x1,y2,x2,y2, x1,y1,x1,y2];
      const outer = rectangle(178, 220, 338, 380);
      const inner = [...rectangle(186, 228, 330, 372), ...rectangle(236, 280, 256, 300)];
      const map = { kind: 'pixel-mask', width, height, maskWidth: width, maskHeight: height,
        walkableMask: mask, componentLabels: labels, distanceMap: new Float32Array(labels.length).fill(8),
        contours: { segments: new Float32Array([...outer, ...inner]), bucketSize: 64, buckets: {} } };
      const ui = new P.Overlay({});
      ui.renderLevel(sampleLevel('normal')); ui.setMap(map); ui.update({ state: 'READY' });
      ui.renderHint(true);
      const outside = Array.from(ui.visibleContours.segments);
      const outsidePath = ui.obstacleShape.getAttribute('d');
      ui.flashObstacles();
      const flashUsesFilteredPath = ui.obstacleFlash.getAttribute('href') === '#' + ui.obstacleShape.id;
      ui.renderHint(false); ui.renderProximity({ x: 246, y: 290 });
      const hiddenInnerWarning = ui.obstacleWarning.getAttribute('d');
      ui.level.nodes[0] = { id: 0, kind: 'start', x: 200.5, y: 260.5 };
      ui.setMap(map); ui.renderHint(true);
      const inside = Array.from(ui.visibleContours.segments);
      ui.renderHint(false); ui.renderProximity({ x: 246, y: 290 });
      const reachableInnerWarning = ui.obstacleWarning.getAttribute('d');
      ui.destroy();
      return { outside, inside, outer, inner, outsidePath, flashUsesFilteredPath,
        hiddenInnerWarning, reachableInnerWarning, released: ui.visibleContours === null };
    });
    assert.deepEqual(enclosed.outside, enclosed.outer, 'an outside start must hide the sealed cavity and its small obstacle');
    assert.ok(enclosed.outsidePath && enclosed.flashUsesFilteredPath, 'full hint and flash share the filtered outline');
    assert.equal(enclosed.hiddenInnerWarning, '', 'local warnings must not reintroduce unreachable inner red circles');
    assert.deepEqual(enclosed.inside, enclosed.inner, 'a new map starting inside must preserve its reachable inner obstacles');
    assert.ok(enclosed.reachableInnerWarning);
    assert.equal(enclosed.released, true);
    const hiddenMazeWalls = await page.evaluate(async () => {
      const P = __PAGEPATH__, width = innerWidth, height = innerHeight;
      const sourceMask = new Uint8Array(width * height).fill(1), finalMask = sourceMask.slice();
      const sourceLabels = new Int32Array(sourceMask.length), finalLabels = new Int32Array(sourceMask.length);
      const distanceMap = new Float32Array(sourceMask.length);
      const rectangle = (x1, y1, x2, y2) => [x1,y1,x2,y1, x2,y1,x2,y2, x1,y2,x2,y2, x1,y1,x1,y2];
      const distant = rectangle(798, 200, 838, 500);
      const sourceSegments = [...rectangle(178, 180, 185, 280), ...rectangle(178, 320, 185, 420), ...distant];
      const finalSegments = [...rectangle(178, 180, 185, 420), ...distant];
      const contours = segments => ({ segments: new Float32Array(segments), bucketSize: 64, buckets: {} });
      const distanceToRect = (x, y, x1, y1, x2, y2) => Math.hypot(Math.max(x1 - x, x - x2, 0), Math.max(y1 - y, y - y2, 0));
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const at = y * width + x, strip = x >= 178 && x < 185;
        const farContent = x >= 798 && x < 838 && y >= 200 && y < 500;
        sourceMask[at] = !(farContent || strip && (y >= 180 && y < 280 || y >= 320 && y < 420));
        finalMask[at] = !(farContent || strip && y >= 180 && y < 420);
        sourceLabels[at] = sourceMask[at]; finalLabels[at] = finalMask[at];
        distanceMap[at] = Math.min(distanceToRect(x, y, 180, 182, 183, 418), distanceToRect(x, y, 800, 202, 836, 498));
      }
      const source = { kind: 'pixel-mask', width, height, maskWidth: width, maskHeight: height,
        walkableMask: sourceMask, componentLabels: sourceLabels, contours: contours(sourceSegments) };
      const map = { ...source, walkableMask: finalMask, componentLabels: finalLabels,
        contours: contours(finalSegments), distanceMap, stats: { clearance: 2 } };
      const sourceCopy = sourceMask.slice(), finalCopy = finalMask.slice();
      const level = { ...sampleLevel('maze'), analysis: map, mazeSourceAnalysis: source,
        mazeWalls: [{ x: 180, y: 278, width: 3, height: 44 }] };
      const ui = new P.Overlay({}), index = P.Collision.createMaskIndex(map);
      ui.renderLevel(level); ui.setMap(map); ui.update({ state: 'READY', mazeAvailability: { available: true } });
      const sourceEdges = Array.from(ui.sourceContours.segments), mazeEdges = Array.from(ui.mazeContours.segments);
      const fullEdges = Array.from(ui.visibleContours.segments);
      const sourceCache = ui.sourceContours, mazeCache = ui.mazeContours;
      const globalPath = ui.obstacleShape.getAttribute('d');
      const parse = text => (text.match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi) || []).map(Number);
      const read = (x, y = 300) => {
        ui.lastBrushPoint = { x, y }; ui.renderProximity(ui.lastBrushPoint);
        return { d: ui.obstacleWarning.getAttribute('d'), values: parse(ui.obstacleWarning.getAttribute('d')),
          opacity: Number(ui.obstacleWarning.getAttribute('opacity')) };
      };
      const far = read(100), near = read(176);
      const blocked = P.Collision.pointHits({ x: 178, y: 300 }, index);
      const safe = !P.Collision.pointHits({ x: 177.5, y: 300 }, index);
      const crossingBlocked = P.Collision.segmentHits({ x: 177, y: 300 }, { x: 190, y: 300 }, index);
      ui.hideBrush(); ui.renderHint(true);
      const beforeFlash = { fillCount: ui.mazeWallLayer.childElementCount,
        global: parse(ui.obstacleShape.getAttribute('d')), warning: ui.obstacleWarning.getAttribute('d'),
        hint: getComputedStyle(ui.allObstacles).visibility, hintTitle: ui.hintButton.title,
        hintHidden: ui.hintButton.hidden, hintDisabled: ui.hintButton.disabled,
        hintDisplay: getComputedStyle(ui.hintButton).display, hintChildren: ui.hintLayer.childElementCount };
      ui.flashObstacles();
      const animation = ui.flashAnimation;
      animation.pause(); animation.currentTime = animation.effect.getTiming().duration / 2;
      await new Promise(resolve => requestAnimationFrame(resolve));
      const readPixels = async name => {
        const screenshot = await createImageBitmap(await (await fetch(await __obstacleScreenshot(name))).blob());
        const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d');
        context.drawImage(screenshot, 0, 0); screenshot.close();
        return { addedBoundary: Array.from(context.getImageData(178, 310, 1, 1).data),
          addedCenter: Array.from(context.getImageData(181, 310, 1, 1).data),
          original: Array.from(context.getImageData(838, 400, 1, 1).data) };
      };
      const farPixels = await readPixels('maze-walls-far-hint.png');
      const flashOpacity = Number(getComputedStyle(ui.obstacleFlash).opacity);
      ui.cancelObstacleFlash();
      const hintFar = read(100), hintNear = read(176);
      ui.update({ state: 'DRAWING' });
      ui.moveBrush({ clientX: 176, clientY: 300, pointerType: 'mouse' });
      await new Promise(resolve => requestAnimationFrame(resolve));
      const nearPixels = await readPixels('maze-walls-near-hint.png');
      ui.showDebug(map, level, true);
      const debugEdges = parse(ui.debugLayer.querySelector('path').getAttribute('d'));
      ui.renderHint(false);
      const afterHint = read(176), cachesReused = sourceCache === ui.sourceContours && mazeCache === ui.mazeContours;
      ui.level = { ...level, mazeSourceAnalysis: undefined }; ui.setMap(map);
      const missingSourceGlobal = ui.obstacleShape.getAttribute('d');
      ui.destroy();
      return { sourceEdges, mazeEdges, fullEdges, finalSegments, distant, globalPath, far, near, blocked, safe, crossingBlocked,
        beforeFlash, farPixels, nearPixels, flashOpacity, hintFar, hintNear, debugEdges, afterHint, cachesReused,
        masksUnchanged: sourceMask.every((value, i) => value === sourceCopy[i]) && finalMask.every((value, i) => value === finalCopy[i]),
        missingSourceGlobal, released: ui.sourceContours === null && ui.mazeContours === null };
    });
    assert.deepEqual(hiddenMazeWalls.fullEdges, hiddenMazeWalls.finalSegments, 'local warnings retain the final reachable collision boundary');
    assert.deepEqual(hiddenMazeWalls.mazeEdges, [185,280,185,320, 178,280,178,320],
      'a merged edge spanning old and new blocked cells must split at the exact source-mask transition');
    assert.deepEqual(hiddenMazeWalls.sourceEdges, [178,180,185,180, 185,180,185,280, 185,320,185,420,
      178,420,185,420, 178,180,178,280, 178,320,178,420, ...hiddenMazeWalls.distant],
    'global preview must not reintroduce old segment ends buried inside the added wall');
    assert.equal(hiddenMazeWalls.far.d, '');
    assert.ok(hiddenMazeWalls.near.d);
    assert.equal(hiddenMazeWalls.blocked && hiddenMazeWalls.safe && hiddenMazeWalls.crossingBlocked, true,
      'invisible added walls retain the exact center-point collision boundary');
    assert.equal(hiddenMazeWalls.beforeFlash.fillCount, 0);
    assert.deepEqual(hiddenMazeWalls.beforeFlash.global, hiddenMazeWalls.sourceEdges);
    assert.equal(hiddenMazeWalls.beforeFlash.warning, '');
    assert.equal(hiddenMazeWalls.beforeFlash.hint, 'hidden');
    assert.equal(hiddenMazeWalls.beforeFlash.hintTitle, '显示参考路线');
    assert.equal(hiddenMazeWalls.beforeFlash.hintHidden, true);
    assert.equal(hiddenMazeWalls.beforeFlash.hintDisabled, true);
    assert.equal(hiddenMazeWalls.beforeFlash.hintDisplay, 'none');
    assert.equal(hiddenMazeWalls.beforeFlash.hintChildren, 0, 'even a direct maze renderHint(true) call must draw no answer');
    assert.ok(hiddenMazeWalls.flashOpacity > 0, 'original page obstacles should still flash');
    const red = pixel => pixel[0] > pixel[1] + 50 && pixel[0] > pixel[2] + 40;
    assert.equal(red(hiddenMazeWalls.farPixels.addedBoundary), false, 'hint and generation flash must not paint a distant added wall boundary');
    assert.deepEqual(hiddenMazeWalls.farPixels.addedCenter, [255,255,255,255], 'added wall centers must remain transparent');
    assert.equal(red(hiddenMazeWalls.farPixels.original), true, 'original obstacles must remain globally visible with the answer');
    assert.equal(hiddenMazeWalls.hintFar.d, '');
    assert.equal(hiddenMazeWalls.hintNear.d, hiddenMazeWalls.near.d,
      'rejecting the answer must preserve local warnings for the complete final collision boundary');
    assert.equal(red(hiddenMazeWalls.nearPixels.addedBoundary), true, 'approaching the invisible wall must visibly paint its collision edge');
    assert.deepEqual(hiddenMazeWalls.debugEdges, hiddenMazeWalls.sourceEdges, 'debug outlines must not leak added walls globally either');
    assert.ok(hiddenMazeWalls.afterHint.d);
    assert.equal(hiddenMazeWalls.cachesReused && hiddenMazeWalls.masksUnchanged, true,
      'pointer movement and answer toggles must read cached contours without mutating collision masks');
    assert.equal(hiddenMazeWalls.missingSourceGlobal, '', 'missing source metadata must never reveal every new maze wall');
    assert.equal(hiddenMazeWalls.released, true);
    console.log(`Ink UI browser checks passed: ${cases} mode/state/viewport/debug combinations, concise difficulty tips, toolbar collapse/input pass-through/restoration, brush controls, route-only hints, hidden and rejected maze hints, one-shot flashes, expanded exact local contours and cleanup.`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
