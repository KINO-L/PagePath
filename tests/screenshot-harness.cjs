'use strict';
// Test-only transport. The production capture pipeline still decodes and analyzes
// the browser's actual composited viewport PNG, with stable small DOM hints.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({});
for (const file of ['config', 'scoring', 'progression']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/content', `${file}.js`), 'utf8'), context);
}
const P = context.__PAGEPATH__;
const profiles = new WeakMap();

module.exports = async function installScreenshotHarness(page) {
  // Each test browser context gets an extension-like in-memory profile shared
  // by its pages. Nothing is written to a website or to the filesystem.
  const browserContext = page.context();
  if (!profiles.has(browserContext)) profiles.set(browserContext, { profile: P.Progression.empty(), queue: Promise.resolve() });
  const state = profiles.get(browserContext);
  await page.exposeFunction('__pagepathProgress', message => {
    const operation = state.queue.then(() => {
      if (message?.type === 'PAGEPATH_PROFILE') return { ok: true, profile: P.Progression.view(state.profile), profileData: state.profile };
      if (message?.type !== 'PAGEPATH_COMPLETE') return { ok: false, error: '未知测试消息' };
      const { level, stats } = message;
      const bounded = (value, low, high) => typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;
      if (!level || !P.Scoring.collectionStats(stats) || !bounded(level.difficulty, 0, 100) ||
          (level.challenge?.complexity !== undefined && !bounded(level.challenge.complexity, 0, 1))) {
        return { ok: false, error: '本局成绩数据无效' };
      }
      const score = P.Scoring.calculate(level, stats);
      const award = P.Progression.award(state.profile, { ...score, runId: message.runId });
      if (!award.awarded && award.reason !== 'duplicate') return { ok: false, error: '本局成绩数据无效' };
      state.profile = award.profile;
      return { ok: true, profile: P.Progression.view(state.profile), profileData: state.profile, result: { ...score,
        xp: award.rewardXp, awarded: award.awarded, previousLevel: award.previousLevel, level: award.level,
        title: award.title, leveledUp: award.leveledUp, levelsGained: award.levelsGained } };
    });
    state.queue = operation.then(() => {}, () => {});
    return operation;
  });
  await page.exposeFunction('__pagepathCaptureViewport', async () =>
    'data:image/png;base64,' + (await page.screenshot({ type: 'png' })).toString('base64'));
  await page.addInitScript(() => {
    globalThis.chrome ||= {};
    globalThis.chrome.runtime = {
      id: 'pagepath-browser-test',
      async sendMessage(message) {
        if (message.type === 'PAGEPATH_PROFILE' || message.type === 'PAGEPATH_COMPLETE') {
          return globalThis.__pagepathProgress(message);
        }
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
