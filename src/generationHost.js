(() => {
  'use strict';
  const P = globalThis.__PAGEPATH__ ||= {};
  const TARGET = 'pagepath-offscreen';
  const DOCUMENT = 'src/offscreen.html';
  const FAILED = '地图暂未准备好，请刷新后重试';
  const CANCELLED = '地图生成已取消';
  const MAX_MESSAGE = 60 * 1024 * 1024;
  const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(value);

  function create({ supportedPage }) {
    const jobs = new Map();
    let creating = null, closing = null, idleTimer = 0, sequence = 0;
    const origin = sender => sender?.id === chrome.runtime.id && sender.frameId === 0 &&
      Number.isInteger(sender.tab?.id) && sender.tab.id >= 0 && supportedPage(sender.url || sender.tab.url);
    const owner = sender => ({ tabId: sender.tab.id, documentId: sender.documentId || '', url: sender.url || sender.tab.url });
    const sameOwner = (a, b) => a.tabId === b.tabId && a.documentId === b.documentId && a.url === b.url;
    const post = message => chrome.runtime.sendMessage({ target: TARGET, ...message });
    const ignorePost = message => { try { post(message)?.catch?.(() => {}); } catch { /* Extension unloading. */ } };

    async function ensureDocument() {
      if (closing) await closing;
      if (creating) return creating;
      creating = (async () => {
        const url = chrome.runtime.getURL(DOCUMENT);
        const contexts = chrome.runtime.getContexts ? await chrome.runtime.getContexts({
          contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url]
        }) : await clients.matchAll();
        if (contexts.some(context => (context.documentUrl || context.url) === url)) return;
        await chrome.offscreen.createDocument({ url: DOCUMENT, reasons: ['WORKERS'],
          justification: 'Generate mazes in cancellable workers without blocking the webpage.' });
      })();
      try { await creating; } finally { creating = null; }
    }

    function closeWhenIdle() {
      if (jobs.size || idleTimer || !chrome.offscreen?.closeDocument) return;
      idleTimer = setTimeout(async () => {
        idleTimer = 0;
        if (creating) { try { await creating; } catch { return; } }
        if (jobs.size || closing) return;
        closing = chrome.offscreen.closeDocument().catch(() => {});
        try { await closing; } finally { closing = null; }
      }, 1000);
    }

    function finish(job, response) {
      if (job.finished) return;
      job.finished = true;
      clearTimeout(job.timer);
      jobs.delete(job.id);
      try { job.respond(response); } catch { /* The requesting document left. */ }
      closeWhenIdle();
    }

    function cancelJob(job) {
      if (job.finished) return;
      if (job.dispatched) ignorePost({ type: 'PAGEPATH_OFFSCREEN_CANCEL', jobId: job.id });
      finish(job, { ok: false, cancelled: true, error: CANCELLED });
    }

    function cancelTab(tabId) {
      for (const job of jobs.values()) if (job.owner.tabId === tabId) cancelJob(job);
      // This also releases an orphaned worker after a service-worker restart.
      ignorePost({ type: 'PAGEPATH_OFFSCREEN_CANCEL_TAB', tabId });
      closeWhenIdle();
    }

    function cancelForSender(sender) {
      if (!origin(sender)) return false;
      const requestOwner = owner(sender);
      for (const job of jobs.values()) if (sameOwner(job.owner, requestOwner)) cancelJob(job);
      ignorePost({ type: 'PAGEPATH_OFFSCREEN_CANCEL_OWNER', owner: requestOwner });
      closeWhenIdle();
      return true;
    }

    function validRequest(message) {
      const packet = message.packet;
      if (!validId(message.requestId) || !Number.isInteger(message.seed) || message.seed < 0 || message.seed > 0xffffffff ||
          !packet || packet.format !== 'pagepath-pixel-map' || packet.version !== 1 || packet.encoding !== 'gzip-base64' ||
          !Number.isInteger(packet.width) || !Number.isInteger(packet.height) || packet.width < 1 || packet.height < 1 ||
          packet.width * packet.height > 8500000 || typeof packet.payload !== 'string' || !packet.payload.length ||
          packet.payload.length > MAX_MESSAGE || !Array.isArray(message.reservedRects) || message.reservedRects.length > 16 ||
          !Array.isArray(message.history) || message.history.length > 8) return false;
      const coordinate = value => Number.isFinite(value) && Math.abs(value) <= Math.max(packet.width, packet.height) * 2;
      if (!message.reservedRects.every(rect => rect && ['x', 'y', 'width', 'height'].every(key => coordinate(rect[key])) &&
          rect.width >= 0 && rect.height >= 0) || !message.history.every(layout => Array.isArray(layout) && layout.length <= 16 &&
          layout.every(point => point && coordinate(point.x) && coordinate(point.y)))) return false;
      try {
        const { payload, ...metadata } = packet;
        const bytes = new TextEncoder().encode(JSON.stringify({ metadata,
          reservedRects: message.reservedRects, history: message.history })).byteLength;
        return bytes <= 3 * 1024 * 1024 && bytes + payload.length + 2048 <= MAX_MESSAGE;
      } catch { return false; }
    }

    function generate(message, sender, respond) {
      if (!origin(sender) || !validRequest(message)) { respond({ ok: false, error: FAILED }); return; }
      const requestOwner = owner(sender);
      cancelForSender(sender);
      clearTimeout(idleTimer); idleTimer = 0;
      const id = `${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2)}`;
      const job = { id, requestId: message.requestId, owner: requestOwner, respond, finished: false, dispatched: false, timer: 0 };
      jobs.set(id, job);
      job.timer = setTimeout(() => {
        if (job.dispatched) ignorePost({ type: 'PAGEPATH_OFFSCREEN_CANCEL', jobId: id });
        finish(job, { ok: false, error: FAILED });
      }, 120000);
      (async () => {
        await ensureDocument();
        if (job.finished) { closeWhenIdle(); return; }
        job.dispatched = true;
        const response = await post({ type: 'PAGEPATH_OFFSCREEN_GENERATE', jobId: id, requestId: message.requestId, owner: requestOwner,
          packet: message.packet, reservedRects: message.reservedRects, history: message.history, seed: message.seed });
        if (job.finished) return;
        if (response?.ok && response.level) finish(job, { ok: true, level: response.level });
        else finish(job, { ok: false, ...(response?.cancelled ? { cancelled: true } : {}),
          error: typeof response?.error === 'string' && response.error.length <= 160 ? response.error : FAILED });
      })().catch(() => finish(job, { ok: false, error: FAILED }));
    }

    function cancel(message, sender, respond) {
      if (!origin(sender) || !validId(message.requestId)) { respond({ ok: false }); return; }
      const requestOwner = owner(sender);
      for (const job of jobs.values()) if (job.requestId === message.requestId && sameOwner(job.owner, requestOwner)) cancelJob(job);
      ignorePost({ type: 'PAGEPATH_OFFSCREEN_CANCEL_REQUEST', requestId: message.requestId, owner: requestOwner });
      closeWhenIdle();
      respond({ ok: true });
    }

    return Object.freeze({ generate, cancel, cancelTab, cancelForSender });
  }
  P.GenerationHost = Object.freeze({ create });
})();
