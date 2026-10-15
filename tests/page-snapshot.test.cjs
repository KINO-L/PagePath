const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('capture retry hides the toolbar again after resizing during screenshot analysis', async () => {
  const listeners = new Set(), captures = [], painted = [], images = [];
  let hidden = false;
  const overlay = { host: { isConnected: true }, setCaptureHidden(value) { hidden = value; } };
  const P = { Config: { PIXEL_MAP: { MAX_PIXELS: 8500000 } },
    MapCodec: { decode: async packet => packet } };
  const runtime = { id: 'pagepath-test', onMessage: {
    addListener: callback => listeners.add(callback), removeListener: callback => listeners.delete(callback)
  }, sendMessage: async message => {
    captures.push({ width: message.bounds.width, hidden });
    assert.equal(hidden, true, 'the actual screenshot must never contain extension controls');
    for (const listener of listeners) listener({ type: 'PAGEPATH_CAPTURE_READY', captureId: message.captureId },
      { id: runtime.id });
    assert.equal(hidden, false, 'controls must return while pixel analysis continues');
    // The first screenshot has completed, but its analysis response is still
    // pending when the viewport changes. capture() must retry at the new size.
    if (captures.length === 1) context.innerWidth = 1440;
    return { ok: true, dataUrl: 'data:image/png;base64,c25hcHNob3Q=',
      map: { width: message.bounds.width, height: message.bounds.height, kind: 'pixel-mask' } };
  } };
  class CapturedImage {
    constructor() { this.naturalWidth = 1280; this.naturalHeight = 720; images.push(this); }
    decode() { return Promise.resolve(); }
    remove() { this.removed = true; }
    removeAttribute(name) { delete this[name]; }
  }
  const context = vm.createContext({ __PAGEPATH__: P, chrome: { runtime },
    window: { visualViewport: null }, document: { getAnimations: () => [] },
    innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
    Image: CapturedImage, DOMException, setTimeout, clearTimeout,
    requestAnimationFrame: callback => setImmediate(() => { painted.push(hidden); callback(); }),
    cancelAnimationFrame: clearImmediate,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/content/pageSnapshot.js'), 'utf8'), context);

  const snapshot = await P.PageSnapshot.capture({ overlay });

  assert.deepEqual(captures, [{ width: 1280, hidden: true }, { width: 1440, hidden: true }]);
  assert.deepEqual(painted, [true, true, true, true], 'both attempts paint twice with the overlay hidden');
  assert.equal(snapshot.viewport.width, 1440);
  assert.equal(snapshot.analysis.width, 1440);
  assert.equal(hidden, false);
  assert.equal(listeners.size, 0);
  assert.equal(images[0].removed, true, 'the stale screenshot must be released');
  snapshot.destroy();
  assert.equal(images[1].removed, true);
});
