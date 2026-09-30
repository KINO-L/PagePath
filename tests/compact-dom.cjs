/* Run with: node tests/compact-dom.cjs (requires optional Playwright). */
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

(async () => {
  const browser = await playwright.chromium.launch({ headless: true, executablePath });
  let passed = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const load = async html => {
      await page.setContent('<!doctype html><style>body{margin:0;font:16px/20px Arial}' +
        '*{box-sizing:border-box}button{font:inherit} .small{position:absolute;left:50px;top:50px;width:100px;height:40px}' +
        '</style>' + html);
      await page.addScriptTag({ path: path.join(__dirname, '../src/content/compactDom.js') });
      await page.evaluate(() => document.fonts.ready);
      return page.evaluate(() => __PAGEPATH__.CompactDOM.collect());
    };
    const test = async (name, html, check) => {
      const hints = await load(html);
      check(hints);
      passed++;
      console.log('PASS ' + name);
    };
    await test('compact painted control deduplicates children',
      '<button class="small" style="border-radius:8px"><span>Hello</span><svg width="12" height="12"><circle cx="6" cy="6" r="5"/></svg></button>',
      hints => { assert.equal(hints.length, 1); assert.deepEqual(hints[0],
        { x: 50, y: 50, width: 100, height: 40, kind: 'box', radius: 8 }); });
    await test('large card and large button remain image-only; small descendants survive',
      '<div style="position:absolute;left:30px;top:30px;width:600px;height:350px;background:#ccc">' +
      '<button class="small">Small</button></div>' +
      '<button style="position:absolute;left:30px;top:440px;width:500px;height:150px">Large</button>',
      hints => { assert.equal(hints.length, 1); assert.equal(hints[0].width, 100); assert.equal(hints[0].x, 80); });
    await test('single line text uses its content bounds instead of a wide layout box',
      '<div class="small" style="width:800px;height:24px">Compact text</div>',
      hints => { assert.equal(hints.length, 1); assert.equal(hints[0].kind, 'content');
        assert(hints[0].width < 150); assert(hints[0].height <= 24); });
    await test('multiline content stays image-only',
      '<p class="small" style="width:90px;height:75px;margin:0">First line and another line and more words</p>',
      hints => assert.equal(hints.length, 0));
    await test('compact SVG is one content hint',
      '<svg class="small" width="100" height="40"><circle cx="20" cy="20" r="12"/><circle cx="75" cy="20" r="12"/></svg>',
      hints => { assert.equal(hints.length, 1); assert.equal(hints[0].kind, 'content'); });
    await test('visible SVG with pointer-events none uses its visible ancestor hit',
      '<div><svg class="small" style="pointer-events:none" width="100" height="40">' +
      '<circle cx="20" cy="20" r="12"/></svg></div>',
      hints => { assert.equal(hints.length, 1); assert.equal(hints[0].kind, 'content'); });
    await test('pointer-events none does not bypass an unrelated occluder',
      '<svg class="small" style="pointer-events:none"><circle cx="20" cy="20" r="12"/></svg>' +
      '<div class="small" style="background:#fff;z-index:2"></div>',
      hints => assert.equal(hints.length, 0));
    await test('large media remains pixel contours',
      '<canvas class="small" style="width:500px;height:350px"></canvas>',
      hints => assert.equal(hints.length, 0));
    for (const rule of ['display:none', 'visibility:hidden', 'opacity:0', 'opacity:.4',
      'transform:rotate(8deg)', 'transform:skewX(4deg)', 'clip-path:circle(50%)', 'filter:blur(2px)']) {
      await test('skip transformed or hidden ancestor: ' + rule,
        '<div style="' + rule + '"><button class="small">Hidden</button></div>',
        hints => assert.equal(hints.length, 0));
    }
    await test('fully visible translated control is still usable',
      '<div style="transform:translate(20px,10px)"><button class="small">Visible</button></div>',
      hints => { assert.equal(hints.length, 1); assert.equal(hints[0].x, 70); assert.equal(hints[0].y, 60); });
    await test('partially clipped child stays image-only',
      '<div style="position:absolute;left:20px;top:20px;width:110px;height:90px;overflow:hidden">' +
      '<button class="small">Clipped</button></div>', hints => assert.equal(hints.length, 0));
    await test('a leaf text range clipped by its own box stays image-only',
      '<span class="small" style="width:45px;overflow:hidden;white-space:nowrap">Clipped content</span>',
      hints => assert.equal(hints.length, 0));
    await test('fully visible child within a scroller can be compacted',
      '<div style="position:absolute;left:20px;top:20px;width:300px;height:160px;overflow:auto">' +
      '<button class="small">Visible</button></div>', hints => assert.equal(hints.length, 1));
    await test('viewport clipped control stays image-only',
      '<button class="small" style="left:-5px">Clipped</button>', hints => assert.equal(hints.length, 0));
    await test('covered control is not an invisible rectangle',
      '<button class="small">Covered</button><div class="small" style="background:#fff;z-index:2"></div>',
      hints => assert.equal(hints.length, 0));
    await test('a partial cover also rejects the control',
      '<button class="small">Covered</button><div class="small" style="width:25px;background:#fff;z-index:2"></div>',
      hints => assert.equal(hints.length, 0));
    await test('the extension surface is ignored, including its descendants',
      '<button class="small">Original</button><div data-pagepath-root style="position:fixed;inset:0;z-index:999">' +
      '<button class="small" style="left:300px">Extension</button></div>', hints => {
        assert.equal(hints.length, 1); assert.equal(hints[0].x, 50);
      });
    await test('transparent link merges its content without claiming a painted box',
      '<a class="small" href="#"><span>Link</span><svg width="12" height="12"><circle cx="6" cy="6" r="5"/></svg></a>',
      hints => { assert.equal(hints.length, 1); assert.equal(hints[0].kind, 'content'); });
    await test('axis scaled corners preserve their visual radius',
      '<button class="small" style="transform:scale(1.5);transform-origin:top left;border-radius:8px">Scale</button>',
      hints => { assert.equal(hints.length, 1); assert.equal(hints[0].radius, 12); });
    await test('a rounded button with overflow hidden remains one rounded box',
      '<button class="small" style="border-radius:999px;overflow:hidden">Rounded</button>',
      hints => { assert.equal(hints.length, 1); assert.equal(hints[0].radius, 20); });
    await test('a circular percentage radius is supported',
      '<button class="small" style="width:40px;border-radius:50%">O</button>',
      hints => { assert.equal(hints.length, 1); assert.equal(hints[0].radius, 20); });
    for (const rule of ['border-radius:30px 0 0 0', 'border-radius:50%',
      'border-radius:30px / 10px', 'border-radius:8px;transform:scale(1.4,1)']) {
      await test('unsupported corners preserve the image outline: ' + rule,
        '<button class="small" style="' + rule + '">Shape</button>',
        hints => assert.equal(hints.length, 0));
    }
    await test('unsupported outer corners still allow a compact child label',
      '<button class="small" style="border-radius:25px 0 0 0"><span>Label</span></button>',
      hints => { assert.equal(hints.length, 1); assert.equal(hints[0].kind, 'content');
        assert(hints[0].width < 100); });
    await test('returned hints contain only finite geometry and kind',
      '<button class="small" title="secret" data-private="password">Private body text</button>',
      hints => { const hint = hints[0]; assert.deepEqual(Object.keys(hint).sort(),
        ['height', 'kind', 'radius', 'width', 'x', 'y']);
        assert(Object.entries(hint).every(([key, value]) => key === 'kind' || Number.isFinite(value)));
        assert(!JSON.stringify(hints).includes('Private')); });
    await load('<button class="small">First</button><button class="small" style="left:200px">Second</button>');
    const cap = await page.evaluate(() => {
      __PAGEPATH__.Config = { HYBRID_DOM: { MAX_HINTS: 1 } };
      return __PAGEPATH__.CompactDOM.collect();
    });
    assert.equal(cap.length, 1); passed++; console.log('PASS configured hint limit');
    await load('<div></div>'.repeat(4010) + '<button class="small">After traversal cap</button>');
    assert.equal((await page.evaluate(() => __PAGEPATH__.CompactDOM.collect())).length, 0);
    passed++; console.log('PASS bounded traversal');
    console.log('Compact DOM: ' + passed + ' browser checks passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
