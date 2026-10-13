/* MV3: activeTab grants access only after an explicit toolbar click.
 * Pixel analysis stays in this extension worker so a webpage's CSP cannot block
 * WebAssembly. Only the cached map and screenshot are returned to its top frame. */
importScripts('content/config.js', 'content/scoring.js', 'content/progression.js', '../vendor/opencv/opencv.js',
  'content/opencvRuntime.js', 'content/compactMask.js', 'content/imageMapAnalyzer.js', 'content/mapCodec.js');
const CONTENT_FILES = [
  "src/content/config.js", "src/content/collision.js", "src/content/scoring.js",
  "src/content/progression.js", "src/content/mazeCleanup.js", "src/content/mazeRoute.js",
  "src/content/mazeConnectors.js", "src/content/routeMazeGenerator.js",
  "src/content/mazeGenerator.js", "src/content/levelGenerator.js",
  "src/content/mapCodec.js", "src/content/compactDom.js",
  "src/content/overlay.js", "src/content/pageSnapshot.js", "src/content/game.js", "src/content/index.js"
];
const busyTabs = new Set();
const captureTabs = new Set();
const navigationVersions = new Map();
const activationVersions = new Map();
let captureQueue = Promise.resolve();
let nextCaptureTime = 0;
const PROFILE_KEY = 'pagepath.progress.v3';
const PENDING_KEY = 'pagepath.pending.v3';
const pendingSettlements = new Map();
let profileQueue = Promise.resolve();
let pendingLoaded = false, pendingRetryTimer = 0, pendingRetryCount = 0;
const DEFAULT_TITLE = "PagePath · 点击开始 / 关闭";
const CAPTURE_CHANGED = "页面已切换，请回到原页面后重新开始。";
const CAPTURE_FAILED = "暂时无法固定页面，请稍后重新开始。";
const ANALYSIS_FAILED = "截图分析未完成，请重新生成地图或更换页面位置。";
const MAP_TOO_LARGE = "截图地图数据过大，请缩小浏览器窗口后重新生成。";
const SAFE_ANALYSIS_ERRORS = new Set([
  "截图尺寸无效，无法生成地图",
  "当前视口过大，请缩小浏览器窗口后重新生成地图",
  "截图中未找到足够清晰的背景空隙，请更换页面位置后重试",
  ANALYSIS_FAILED, MAP_TOO_LARGE,
]);

function safeAnalysisError(error) {
  const message = error?.message;
  if (SAFE_ANALYSIS_ERRORS.has(message) || (typeof message === 'string' &&
      message.startsWith('地图传输失败：') && message.length <= 160)) return message;
  return ANALYSIS_FAILED;
}

async function verifyCapturePage(request) {
  const active = await chrome.tabs.query({ active: true, windowId: request.windowId });
  const tab = active[0];
  if (active.length !== 1 || tab?.id !== request.tabId || tab.windowId !== request.windowId ||
      tab.url !== request.url || (tab.pendingUrl && tab.pendingUrl !== request.url) ||
      (navigationVersions.get(request.tabId) || 0) !== request.navigationVersion ||
      (activationVersions.get(request.windowId) || 0) !== request.activationVersion) {
    throw new Error(CAPTURE_CHANGED);
  }
  // A document-targeted injection also rejects a reload to the exact same URL.
  // It uses the existing activeTab grant and returns only the document's URL.
  if (request.documentId) {
    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: request.tabId, documentIds: [request.documentId] },
        world: "ISOLATED", func: () => location.href
      });
    } catch { throw new Error(CAPTURE_CHANGED); }
    if (results.length !== 1 || results[0].frameId !== 0 ||
        results[0].documentId !== request.documentId || results[0].result !== request.url ||
        (navigationVersions.get(request.tabId) || 0) !== request.navigationVersion ||
        (activationVersions.get(request.windowId) || 0) !== request.activationVersion) {
      throw new Error(CAPTURE_CHANGED);
    }
  }
}

async function collectCompactHints(request, bounds) {
  // Optional, bounded geometry only. Unsupported pages / unstable layouts simply
  // retain pixel analysis. The collector never sends text, URLs or DOM handles.
  try {
    const target = request.documentId ? { tabId: request.tabId, documentIds: [request.documentId] } :
      { tabId: request.tabId, frameIds: [0] };
    const results = await chrome.scripting.executeScript({ target, world: "ISOLATED",
      func: bounds => {
        if (innerWidth !== bounds.width || innerHeight !== bounds.height) return [];
        return globalThis.__PAGEPATH__?.CompactDOM?.collect(bounds) || [];
      }, args: [{ width: bounds.width, height: bounds.height }] });
    const entry = results[0];
    if (results.length !== 1 || entry?.frameId !== 0 ||
        (request.documentId && entry.documentId !== request.documentId)) return [];
    return Array.isArray(entry.result) ? entry.result : [];
  } catch { return []; }
}

async function analyzeScreenshot(dataUrl, bounds, domHints) {
  const encoded = dataUrl.slice('data:image/png;base64,'.length);
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  try {
    // Work at one cell per CSS pixel. Screenshot resolution may use device pixels.
    // captureVisibleTab can return CSS or device pixels depending on browser /
    // display scaling. DPR alone does not describe its actual output dimensions.
    const scale = image.width / bounds.width;
    if (image.width < bounds.width - 2 || image.height < bounds.height - 2 ||
        Math.abs(image.height - bounds.height * scale) > 2) throw new Error(CAPTURE_CHANGED);
    const canvas = new OffscreenCanvas(bounds.width, bounds.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error(CAPTURE_FAILED);
    context.drawImage(image, 0, 0, bounds.width, bounds.height);
    const pixels = context.getImageData(0, 0, bounds.width, bounds.height);
    try {
      const analysis = await globalThis.__PAGEPATH__.ImageMapAnalyzer.analyze(pixels, { ...bounds, domHints });
      return await globalThis.__PAGEPATH__.MapCodec.encode(analysis);
    } catch (error) { throw new Error(safeAnalysisError(error)); }
  } finally { image.close(); }
}

function capturePage(message, sender, sendResponse) {
  const tab = sender.tab;
  const url = sender.url || tab?.url;
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
      !Number.isInteger(tab?.id) || tab.id < 0 ||
      !Number.isInteger(tab.windowId) || tab.windowId < 0 || !supportedPage(url)) {
    sendResponse({ ok: false, error: CAPTURE_CHANGED });
    return;
  }
  const bounds = message.bounds;
  if (!Number.isInteger(bounds?.width) || !Number.isInteger(bounds?.height) ||
      bounds.width < 8 || bounds.height < 8 ||
      !Number.isFinite(bounds.dpr) || bounds.dpr <= 0 || bounds.dpr > 16) {
    sendResponse({ ok: false, error: CAPTURE_FAILED });
    return;
  }
  if (bounds.width * bounds.height > globalThis.__PAGEPATH__.Config.PIXEL_MAP.MAX_PIXELS) {
    sendResponse({ ok: false, error: MAP_TOO_LARGE });
    return;
  }
  if (captureTabs.has(tab.id)) {
    sendResponse({ ok: false, error: "正在固定页面，请稍候再试。" });
    return;
  }
  const request = { tabId: tab.id, windowId: tab.windowId, url,
    documentId: sender.documentId,
    navigationVersion: navigationVersions.get(tab.id) || 0,
    activationVersion: activationVersions.get(tab.windowId) || 0 };
  captureTabs.add(tab.id);
  const operation = captureQueue.then(async () => {
    // captureVisibleTab allows at most two calls per second, across all tabs.
    const wait = nextCaptureTime - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    await verifyCapturePage(request);
    const beforeHints = await collectCompactHints(request, bounds);
    nextCaptureTime = Date.now() + 550;
    let dataUrl;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(request.windowId, { format: "png" });
    } catch { throw new Error(CAPTURE_FAILED); }
    await verifyCapturePage(request);
    const afterHints = await collectCompactHints(request, bounds);
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) {
      throw new Error(CAPTURE_FAILED);
    }
    const domHints = globalThis.__PAGEPATH__.CompactMask.stable(beforeHints, afterHints, bounds);
    const map = await analyzeScreenshot(dataUrl, bounds, domHints);
    const { payload, ...metadata } = map;
    const responseBytes = dataUrl.length + (payload?.length || 0) +
      new TextEncoder().encode(JSON.stringify(metadata)).byteLength + 128;
    if (responseBytes > 60 * 1024 * 1024) throw new Error(MAP_TOO_LARGE);
    await verifyCapturePage(request);
    return { dataUrl, map };
  });
  // Keep the queue alive after failures; screenshot bytes are never stored here.
  captureQueue = operation.then(() => {}, () => {});
  operation.then(({ dataUrl, map }) => {
    captureTabs.delete(tab.id);
    sendResponse({ ok: true, dataUrl, map });
  }, error => {
    captureTabs.delete(tab.id);
    const message = error.message === CAPTURE_CHANGED ? CAPTURE_CHANGED :
      error.message === CAPTURE_FAILED ? CAPTURE_FAILED : safeAnalysisError(error);
    sendResponse({ ok: false, error: message });
  });
}

function supportedPage(url) {
  try {
    const u = new URL(url);
    return ["http:", "https:", "file:"].includes(u.protocol) &&
      u.hostname !== "chromewebstore.google.com" &&
      !(u.hostname === "chrome.google.com" && u.pathname.startsWith("/webstore")) &&
      u.hostname !== "microsoftedge.microsoft.com";
  } catch { return false; }
}

function validSettlement(message) {
  const { level, stats, runId } = message || {};
  const bounded = (value, low, high) => typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;
  return message?.type === 'PAGEPATH_COMPLETE' && typeof runId === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(runId) &&
    Boolean(level) && bounded(level.difficulty, 0, 100) &&
    (level.challenge?.complexity === undefined || bounded(level.challenge.complexity, 0, 1)) &&
    Boolean(globalThis.__PAGEPATH__.Scoring.collectionStats(stats));
}

function settlementReceipt(message) {
  const { runId, level, stats } = message;
  return { type: 'PAGEPATH_COMPLETE', runId,
    level: { difficulty: level.difficulty,
      challenge: level.challenge?.complexity === undefined ? {} : { complexity: level.challenge.complexity } },
    stats: globalThis.__PAGEPATH__.Scoring.collectionStats(stats) };
}

async function loadPendingSettlements() {
  if (pendingLoaded) return;
  if (!chrome.storage.session) { pendingLoaded = true; return; }
  try {
    const saved = await chrome.storage.session.get(PENDING_KEY);
    for (const receipt of Array.isArray(saved[PENDING_KEY]) ? saved[PENDING_KEY] : []) {
      if (validSettlement(receipt) && !pendingSettlements.has(receipt.runId)) {
        pendingSettlements.set(receipt.runId, settlementReceipt(receipt));
      }
    }
    pendingLoaded = true;
  } catch { /* The in-memory queue still retries; session access may recover. */ }
}

async function mirrorPendingSettlements() {
  // An unread session snapshot may contain receipts from an older worker.
  // Do not replace it until those receipts have been merged into this queue.
  if (!pendingLoaded || !chrome.storage.session) return;
  try { await chrome.storage.session.set({ [PENDING_KEY]: [...pendingSettlements.values()] }); }
  catch { /* A session mirror failure must not prevent the durable local write. */ }
}

async function settlePending() {
  const P = globalThis.__PAGEPATH__, retryDelays = pendingSettlements.size ? [250, 750, 1500, 3000] : [];
  for (let attempt = 0; ; attempt++) {
    try {
      const saved = await chrome.storage.local.get(PROFILE_KEY);
      let profile = P.Progression.normalize(saved[PROFILE_KEY]), changed = false;
      const results = new Map(), receipts = [...pendingSettlements.values()];
      for (const receipt of receipts) {
        const score = P.Scoring.calculate(receipt.level, receipt.stats);
        const award = P.Progression.award(profile, { ...score, runId: receipt.runId });
        profile = award.profile; changed ||= award.awarded;
        results.set(receipt.runId, { ...score, xp: award.rewardXp, awarded: award.awarded,
          previousLevel: award.previousLevel, level: award.level, title: award.title,
          leveledUp: award.leveledUp, levelsGained: award.levelsGained });
      }
      if (changed) await chrome.storage.local.set({ [PROFILE_KEY]: profile });
      for (const receipt of receipts) pendingSettlements.delete(receipt.runId);
      if (receipts.length) await mirrorPendingSettlements();
      clearTimeout(pendingRetryTimer); pendingRetryTimer = 0; pendingRetryCount = 0;
      return { profile, results };
    } catch (error) {
      if (attempt >= retryDelays.length) throw error;
      await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
    }
  }
}

function schedulePendingRetry() {
  if (!pendingSettlements.size || pendingRetryTimer) return;
  const delay = Math.min(30000, 10000 * 2 ** Math.min(pendingRetryCount++, 2));
  pendingRetryTimer = setTimeout(() => {
    pendingRetryTimer = 0;
    const operation = profileQueue.then(async () => { await loadPendingSettlements(); await settlePending(); });
    profileQueue = operation.then(() => {}, () => {});
    operation.then(schedulePendingRetry, schedulePendingRetry);
  }, delay);
}

function progressMessage(message, sender, sendResponse) {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) ||
      sender.tab.id < 0 || !supportedPage(sender.url || sender.tab.url)) {
    sendResponse({ ok: false, error: '无法读取当前游戏进度' }); return;
  }
  const P = globalThis.__PAGEPATH__;
  if (message.type === 'PAGEPATH_COMPLETE' && !validSettlement(message)) {
    sendResponse({ ok: false, error: '本局成绩数据无效' }); return;
  }
  // All tabs share one extension profile. Serialize read-modify-write so
  // simultaneous completions cannot overwrite each other's experience.
  const operation = profileQueue.then(async () => {
    await loadPendingSettlements();
    if (message.type === 'PAGEPATH_COMPLETE' && !pendingSettlements.has(message.runId)) {
      pendingSettlements.set(message.runId, settlementReceipt(message));
      // Session storage survives worker restarts without recording page data.
      // A local storage failure cannot discard an already received receipt.
      await mirrorPendingSettlements();
    }
    const settled = await settlePending();
    return { ok: true, profile: P.Progression.view(settled.profile), profileData: settled.profile,
      ...(message.type === 'PAGEPATH_COMPLETE' ? { result: settled.results.get(message.runId) } : {}) };
  });
  profileQueue = operation.then(() => {}, () => {});
  operation.then(sendResponse, () => {
    schedulePendingRetry(); sendResponse({ ok: false, error: '进度正在自动重试' });
  });
}

// Recover receipts after an MV3 worker suspension even if the game was closed.
profileQueue = profileQueue.then(loadPendingSettlements).then(schedulePendingRetry, () => {});

async function unavailable(tabId) {
  // A small explanatory extension popup is used only on restricted pages;
  // the actual game always lives on the webpage. openPopup may require a gesture.
  await Promise.allSettled([
    chrome.action.setBadgeText({ tabId, text: "!" }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#9b5935" }),
    chrome.action.setTitle({ tabId, title: "此页面不允许扩展运行。请打开普通网页；本地文件需开启文件网址权限。" })
  ]);
  try {
    await chrome.action.setPopup({ tabId, popup: "src/unavailable.html" });
    if (chrome.action.openPopup) await chrome.action.openPopup();
  } catch { /* Badge and tooltip remain available if popup opening is disallowed. */ }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || busyTabs.has(tab.id)) return;
  busyTabs.add(tab.id);
  try {
    if (!supportedPage(tab.url)) { await unavailable(tab.id); return; }
    await chrome.action.setPopup({ tabId: tab.id, popup: "" });
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] }, world: "ISOLATED", files: CONTENT_FILES
    });
    const active = result[0]?.result?.active === true;
    await Promise.allSettled([
      chrome.action.setBadgeText({ tabId: tab.id, text: active ? "ON" : "" }),
      chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#187567" }),
      chrome.action.setTitle({ tabId: tab.id, title: DEFAULT_TITLE })
    ]);
  } catch { await unavailable(tab.id); }
  finally { busyTabs.delete(tab.id); }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'PAGEPATH_PROFILE' || message?.type === 'PAGEPATH_COMPLETE') {
    progressMessage(message, sender, sendResponse);
    return true;
  }
  if (message?.type === "PAGEPATH_CAPTURE") {
    capturePage(message, sender, sendResponse);
    return true;
  }
  if (message?.type !== "PAGEPATH_CLOSED" || !sender.tab?.id) return;
  chrome.action.setBadgeText({ tabId: sender.tab.id, text: "" }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading" || change.url) {
    navigationVersions.set(tabId, (navigationVersions.get(tabId) || 0) + 1);
  }
  if (change.status !== "loading") return;
  Promise.allSettled([
    chrome.action.setBadgeText({ tabId, text: "" }),
    chrome.action.setPopup({ tabId, popup: "" }),
    chrome.action.setTitle({ tabId, title: DEFAULT_TITLE })
  ]);
});

chrome.tabs.onActivated.addListener(({ windowId }) => {
  // Switching away and back during the async capture also invalidates it.
  activationVersions.set(windowId, (activationVersions.get(windowId) || 0) + 1);
});
