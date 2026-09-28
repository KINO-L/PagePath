/* MV3: activeTab grants access only after an explicit toolbar click.
 * Ordered classic scripts share this extension's ISOLATED world; no remote code,
 * eval, module URL exposure, persistent content scripts, or host permissions. */
const CONTENT_FILES = [
  "src/content/config.js", "src/content/collision.js", "src/content/grid.js",
  "src/content/pathfinding.js", "src/content/scoring.js", "src/content/levelGenerator.js",
  "src/content/obstacleDetector.js", "src/content/pageAnalyzer.js",
  "src/content/overlay.js", "src/content/pageSnapshot.js", "src/content/game.js", "src/content/index.js"
];
const busyTabs = new Set();
const captureTabs = new Set();
const navigationVersions = new Map();
const activationVersions = new Map();
let captureQueue = Promise.resolve();
let nextCaptureTime = 0;
const DEFAULT_TITLE = "PagePath · 点击开始 / 关闭";
const CAPTURE_CHANGED = "页面已切换，请回到原页面后重新开始。";
const CAPTURE_FAILED = "暂时无法固定页面，请稍后重新开始。";

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

function capturePage(sender, sendResponse) {
  const tab = sender.tab;
  const url = sender.url || tab?.url;
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
      !Number.isInteger(tab?.id) || tab.id < 0 ||
      !Number.isInteger(tab.windowId) || tab.windowId < 0 || !supportedPage(url)) {
    sendResponse({ ok: false, error: CAPTURE_CHANGED });
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
    nextCaptureTime = Date.now() + 550;
    let dataUrl;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(request.windowId, { format: "png" });
    } catch { throw new Error(CAPTURE_FAILED); }
    await verifyCapturePage(request);
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) {
      throw new Error(CAPTURE_FAILED);
    }
    return dataUrl;
  });
  // Keep the queue alive after failures; screenshot bytes are never stored here.
  captureQueue = operation.then(() => {}, () => {});
  operation.then(dataUrl => {
    captureTabs.delete(tab.id);
    sendResponse({ ok: true, dataUrl });
  }, error => {
    captureTabs.delete(tab.id);
    sendResponse({ ok: false, error: error.message === CAPTURE_CHANGED ? CAPTURE_CHANGED : CAPTURE_FAILED });
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
  if (message?.type === "PAGEPATH_CAPTURE") {
    capturePage(sender, sendResponse);
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
