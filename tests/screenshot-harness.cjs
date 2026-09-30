'use strict';
// Test-only transport. The production capture pipeline still decodes and analyzes
// the browser's actual composited viewport PNG, with stable small DOM hints.
module.exports = async function installScreenshotHarness(page) {
  await page.exposeFunction('__pagepathCaptureViewport', async () =>
    'data:image/png;base64,' + (await page.screenshot({ type: 'png' })).toString('base64'));
  await page.addInitScript(() => {
    globalThis.chrome ||= {};
    globalThis.chrome.runtime = {
      id: 'pagepath-browser-test',
      async sendMessage(message) {
        if (message.type === 'PAGEPATH_CAPTURE') {
          const before = globalThis.__PAGEPATH__.CompactDOM?.collect(message.bounds) || [];
          const dataUrl = await globalThis.__pagepathCaptureViewport();
          const after = globalThis.__PAGEPATH__.CompactDOM?.collect(message.bounds) || [];
          const image = await createImageBitmap(await (await fetch(dataUrl)).blob());
          try {
            const { width, height } = message.bounds;
            const canvas = new OffscreenCanvas(width, height);
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(image, 0, 0, width, height);
            const domHints = globalThis.__PAGEPATH__.CompactMask?.stable(before, after, { width, height }) || [];
            const analysis = await __PAGEPATH__.ImageMapAnalyzer.analyze(ctx.getImageData(0, 0, width, height), { domHints });
            return { ok: true, dataUrl, map: await __PAGEPATH__.MapCodec.encode(analysis) };
          } finally { image.close(); }
        }
      }
    };
  });
};
