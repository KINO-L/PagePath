(() => {
  'use strict';
  const jobs = new Map(), cancelled = new Set();
  const FAILED = '地图暂未准备好，请刷新后重试';
  const sameOwner = (a, b) => a?.tabId === b?.tabId && a?.documentId === b?.documentId && a?.url === b?.url;
  const rememberCancel = id => {
    cancelled.add(id);
    if (cancelled.size > 128) cancelled.delete(cancelled.values().next().value);
  };
  function finish(job, response) {
    if (jobs.get(job.id) !== job) return;
    jobs.delete(job.id);
    job.worker.terminate();
    job.worker.onmessage = job.worker.onerror = job.worker.onmessageerror = null;
    try { job.respond(response); } catch { /* The service worker or requesting tab closed. */ }
  }
  function cancel(id) {
    rememberCancel(id);
    const job = jobs.get(id);
    if (job) finish(job, { ok: false, cancelled: true, error: '地图生成已取消' });
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    // Content messages are broadcast too. Only the extension background may
    // dispatch work; the page never receives a direct worker endpoint.
    if (message?.target !== 'pagepath-offscreen' || sender.id !== chrome.runtime.id || sender.tab ||
        (sender.url && sender.url !== chrome.runtime.getURL('src/background.js'))) return;
    if (message.type === 'PAGEPATH_OFFSCREEN_CANCEL') { cancel(message.jobId); respond({ ok: true }); return; }
    if (['PAGEPATH_OFFSCREEN_CANCEL_TAB', 'PAGEPATH_OFFSCREEN_CANCEL_OWNER', 'PAGEPATH_OFFSCREEN_CANCEL_REQUEST'].includes(message.type)) {
      for (const job of jobs.values()) if (message.type === 'PAGEPATH_OFFSCREEN_CANCEL_TAB' ?
          job.owner.tabId === message.tabId : sameOwner(job.owner, message.owner) &&
          (message.type !== 'PAGEPATH_OFFSCREEN_CANCEL_REQUEST' || job.requestId === message.requestId)) cancel(job.id);
      respond({ ok: true }); return;
    }
    if (message.type !== 'PAGEPATH_OFFSCREEN_GENERATE') return;
    if (cancelled.has(message.jobId)) { respond({ ok: false, cancelled: true, error: '地图生成已取消' }); return; }
    if (jobs.has(message.jobId)) { respond({ ok: false, error: FAILED }); return; }
    let worker;
    try { worker = new Worker('mazeWorker.js'); }
    catch { respond({ ok: false, error: FAILED }); return; }
    const job = { id: message.jobId, requestId: message.requestId, owner: message.owner, worker, respond };
    jobs.set(job.id, job);
    worker.onmessage = event => finish(job, event.data?.ok && event.data.level ?
      { ok: true, level: event.data.level } : { ok: false,
        error: typeof event.data?.error === 'string' && event.data.error.length <= 160 ? event.data.error : FAILED });
    worker.onerror = event => { event.preventDefault(); finish(job, { ok: false, error: FAILED }); };
    worker.onmessageerror = () => finish(job, { ok: false, error: FAILED });
    try { worker.postMessage({ packet: message.packet, reservedRects: message.reservedRects, history: message.history, seed: message.seed }); }
    catch { finish(job, { ok: false, error: FAILED }); }
    return true;
  });
})();
