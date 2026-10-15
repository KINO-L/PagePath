(() => {
  'use strict';
  const P = globalThis.__PAGEPATH__ ||= {};
  const aborted = () => Object.assign(new Error('地图生成已取消'), { name: 'AbortError' });
  const assertActive = signal => { if (signal?.aborted) throw aborted(); };

  async function generate(snapshot, reservedRects = [], history = [], { signal } = {}) {
    assertActive(signal);
    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.id || !runtime.sendMessage) throw new Error('请点击浏览器中的 迷页 扩展图标开始');
    // Reuse the compressed screenshot map. New mazes never recapture the page
    // or turn the full pixel arrays into enormous JSON objects on the UI thread.
    const packet = snapshot.packet || await P.MapCodec.encode(snapshot.analysis);
    assertActive(signal);
    const requestId = globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    const seed = Math.floor(Math.random() * 4294967296) >>> 0;
    const cancel = () => {
      try { runtime.sendMessage({ type: 'PAGEPATH_CANCEL_GENERATION', requestId })?.catch?.(() => {}); }
      catch { /* The extension may have been reloaded. */ }
    };
    const response = await new Promise((resolve, reject) => {
      let settled = false, sent = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
        callback(value);
      };
      const onAbort = () => { if (sent) cancel(); finish(reject, aborted()); };
      const timer = setTimeout(() => {
        if (sent) cancel();
        finish(reject, new Error('地图暂未准备好，请刷新后重试'));
      }, 120000);
      signal?.addEventListener('abort', onAbort, { once: true });
      Promise.resolve().then(() => {
        assertActive(signal);
        sent = true;
        return runtime.sendMessage({ type: 'PAGEPATH_GENERATE', requestId, packet, reservedRects, history, seed });
      }).then(value => finish(resolve, value), error => finish(reject, error));
    });
    assertActive(signal);
    if (response?.cancelled) throw aborted();
    if (!response?.ok || !response.level) throw new Error(response?.error || '地图暂未准备好，请刷新后重试');
    const level = await P.MazeTransport.decode(response.level, snapshot.analysis, { signal });
    assertActive(signal);
    return level;
  }

  P.MazeClient = Object.freeze({ generate });
})();
