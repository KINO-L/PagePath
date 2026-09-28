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

(async () => {
  const browser = await playwright.chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  let cases = 0;
  try {
    await page.setContent('<!doctype html><html><head><style>body { margin: 0; }</style></head><body></body></html>');
    for (const file of ['config.js', 'overlay.js']) {
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
          window.sampleLevel = (mode, nodeCount = 4) => {
            const profile = __PAGEPATH__.getMode(mode);
            const corners = [
              { id: 0, kind: 'start', x: 80, y: 200 },
              { id: 1, kind: 'checkpoint', x: 240, y: 200 },
              { id: 2, kind: 'checkpoint', x: 240, y: 360 },
              { id: 3, kind: 'finish', x: 80, y: 360 },
            ];
            const nodes = nodeCount === 4 ? corners : Array.from({ length: nodeCount }, (_, i) => ({
              id: i, kind: i === 0 ? 'start' : i === nodeCount - 1 ? 'finish' : 'checkpoint',
              x: 35 + i % 4 * 65, y: 200 + Math.floor(i / 4) * 85,
            }));
            const inkMultiplier = __PAGEPATH__.getInkMultiplier(mode, nodes.length);
            const referenceLength = nodes.slice(1).reduce((sum, node, i) =>
              sum + Math.hypot(node.x - nodes[i].x, node.y - nodes[i].y), 0);
            return { nodes, mode, trailLength: profile.trailLength, referencePath: nodes,
              referenceLength, inkMultiplier, maxInk: referenceLength * inkMultiplier };
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
            const controls = [...overlay.toolbar.querySelectorAll('button,select,[tabindex="0"]')].map(control => ({
              className: control.className, tagName: control.tagName,
              label: control.getAttribute('aria-label'), title: control.getAttribute('title'),
              hidden: getComputedStyle(control).display === 'none', rect: box(control),
              icons: control.querySelectorAll('svg').length,
            }));
            const nodeKinds = [...overlay.nodeLayer.querySelectorAll('.node')].map(node => ({
              kind: node.dataset.kind, iconPaths: node.querySelectorAll('path').length,
              labels: [...node.querySelectorAll('text')].filter(text => !visuallyHidden(text)).map(text => text.textContent),
            }));
            const paintedTail = overlay.inkStroke.getBBox();
            return { toolbar: box(overlay.toolbar), reserved: overlay.getReservedRects(), controls, nodeKinds,
              scrollWidth: overlay.toolbar.scrollWidth, clientWidth: overlay.toolbar.clientWidth,
              scrollHeight: overlay.toolbar.scrollHeight, clientHeight: overlay.toolbar.clientHeight,
              text: visibleText.join(' '), messageHidden: visuallyHidden(overlay.message),
              messageText: overlay.message.textContent,
              toolbarInk: overlay.toolbar.querySelectorAll('.metric-ink,.ink-count,.ink-track,.cursor-ink').length,
              cursorInk: overlay.cursorInk?.textContent,
              tailLength: overlay.path.getTotalLength(), outlineLength: overlay.pathOutline.getTotalLength(),
              paintedTail: { x: paintedTail.x, width: paintedTail.width, height: paintedTail.height,
                pieces: overlay.inkStroke.querySelectorAll('path').length },
              dragDisabled: overlay.toolbar.querySelector('.drag-handle')?.disabled,
              modeIcons: overlay.toolbar.querySelectorAll('.mode-control svg').length,
              debugCount: overlay.toolbar.querySelectorAll('.debug-button').length,
              modeOptions: [...overlay.modeSelect.options].map(option => option.value) };
          }, { mode, state });
          const label = `${width}px, debug=${debug}, ${mode}, ${state}`;
          assert.ok(result.toolbar.x >= 0 && result.toolbar.right <= width, `${label}: toolbar leaves the viewport`);
          assert.equal(result.toolbar.height, 48, `${label}: icon toolbar must keep its single-row height`);
          assert.ok(result.scrollWidth <= result.clientWidth, `${label}: toolbar content overflows horizontally`);
          assert.ok(result.scrollHeight <= result.clientHeight, `${label}: toolbar content overflows vertically`);
          for (const control of result.controls) {
            assert.ok(control.label?.trim(), `${label}: ${control.className} needs an accessible name`);
            assert.ok(control.title?.trim(), `${label}: ${control.className} needs an explanatory tooltip`);
            if (control.tagName === 'BUTTON') assert.ok(control.icons > 0, `${label}: ${control.className} needs its visual icon`);
            if (control.hidden) continue;
            assert.ok(control.rect.width > 0 && control.rect.height > 0, `${label}: ${control.className} has no hit area`);
            assert.ok(control.rect.x >= result.toolbar.x && control.rect.right <= result.toolbar.right &&
              control.rect.y >= result.toolbar.y && control.rect.bottom <= result.toolbar.bottom,
            `${label}: ${control.className} is clipped or outside the toolbar`);
          }
          const visibleControls = result.controls.filter(control => !control.hidden);
          for (let i = 0; i < visibleControls.length; i++) for (let j = i + 1; j < visibleControls.length; j++) {
            const a = visibleControls[i], b = visibleControls[j];
            const overlapWidth = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.x, b.rect.x);
            const overlapHeight = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.y, b.rect.y);
            assert.ok(overlapWidth <= 0.5 || overlapHeight <= 0.5,
              `${label}: ${a.className} and ${b.className} have overlapping hit areas`);
          }
          assert.equal(result.debugCount, debug ? 1 : 0, label);
          assert.deepEqual(result.modeOptions, ['normal', 'hell', 'immortal'], label);
          assert.ok(result.modeIcons > 0, `${label}: difficulty must have a visible icon beside the native select`);
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

        // The difficulty tooltip must use the current map's resolved budget,
        // including half-percent allowances above the five-node 10% baseline.
        for (const [nodeCount, sparePercent, expectedMultiplier] of [[14, 23.5, 1.235], [16, 26.5, 1.265], [15, 25, 1.25]]) {
          const budget = await page.evaluate(nodeCount => {
            const level = sampleLevel('hell', nodeCount);
            overlay.renderLevel(level);
            const fromLevel = overlay.modeSelect.title;
            overlay.update({ state: 'READY', mode: 'hell', nodes: 0, total: nodeCount, ink: 100,
              inkMultiplier: level.inkMultiplier });
            const explicit = overlay.modeSelect.title;
            overlay.update({ ink: 67 });
            return { fromLevel, explicit, afterInk: overlay.modeSelect.title,
              iconTitle: overlay.modeControl.title, multiplier: level.inkMultiplier,
              budgetRatio: level.maxInk / level.referenceLength };
          }, nodeCount);
          const percentage = new RegExp(`(?:^|[^\\d.])${String(sparePercent).replace('.', '\\.')}%`);
          assert.ok(Math.abs(budget.multiplier - expectedMultiplier) < 1e-12);
          assert.ok(Math.abs(budget.budgetRatio - expectedMultiplier) < 1e-12);
          for (const title of [budget.fromLevel, budget.explicit, budget.afterInk, budget.iconTitle]) {
            assert.match(title, percentage, `${nodeCount}-node Hell map must report ${sparePercent}% spare ink`);
            assert.doesNotMatch(title, /(?:^|[^\d.])10%/);
          }
        }

        // Check real pointer hit testing: the brush is decoration, and its tip
        // must stay on the same viewport coordinate used by collision checks.
        await page.evaluate(() => {
          overlay.renderLevel(sampleLevel('immortal'));
          overlay.update({ state: 'READY', mode: 'immortal', nodes: 0, total: 4, ink: 100 });
          overlay.modeSelect.focus();
        });
        assert.equal(await page.evaluate(() => overlay.shadowRoot.activeElement === overlay.modeSelect), true,
          `${width}px: the transparent native difficulty select must remain keyboard-focusable`);
        for (const [state, x, y] of [['READY', 110, 410], ['DRAWING', 210, 510]]) {
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
          }), true, 'entering the controls must hide the map brush');
          assert.equal(await page.evaluate(() => {
            const css = getComputedStyle(overlay.cursorInk);
            return css.display === 'none' || css.visibility === 'hidden' || Number(css.opacity) === 0;
          }), true, 'entering the controls must hide the accompanying ink label');
        }

        await page.evaluate(() => overlay.update({ state: 'READY', ink: 100 }));
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

        // Native controls keep their click behavior and must not begin a drag.
        const beforeButtons = await toolbarBox();
        for (const [selector, callback] of [['.hint', 'onHint'], ['.retry', 'onRetry'], ['.new-puzzle', 'onNewPuzzle'], ['.exit', 'onExit']]) {
          const beforeCount = await page.evaluate(name => calls.filter(([called]) => called === name).length, callback);
          await page.locator(`[data-pagepath-root] ${selector}`).click();
          assert.equal(await page.evaluate(name => calls.filter(([called]) => called === name).length, callback), beforeCount + 1);
          assert.deepEqual(await toolbarBox(), beforeButtons, `${selector}: clicking a control must not move the toolbar`);
        }
        await page.locator('[data-pagepath-root] .mode-select').selectOption('hell');
        assert.equal(await page.evaluate(() => calls.filter(([name]) => name === 'onModeChange').at(-1)?.[1]), 'hell');
        assert.deepEqual(await toolbarBox(), beforeButtons, 'changing difficulty must not begin a toolbar drag');

        // The toolbar background is also a drag surface, without stealing the
        // action buttons or transparent native select above it.
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
    console.log(`Ink UI browser checks passed: ${cases} mode/state/viewport/debug combinations, 45px tails, tilted aligned brush, drag controls, keyboard movement and cleanup.`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
