'use strict';

// The same synchronous generator now runs in an extension-owned worker.
// Cancellation terminates this worker, so no algorithm checkpoints or altered
// search limits can change the maze selected for a given random stream.
importScripts('content/config.js', 'content/collision.js', 'content/mazeCleanup.js',
  'content/mazeRoute.js', 'content/mazeConnectors.js', 'content/routeMazeGenerator.js',
  'content/mazeGenerator.js', 'content/levelGenerator.js', 'content/mapCodec.js', 'content/mazeTransport.js');

const P = globalThis.__PAGEPATH__;
const FALLBACK = '地图暂未准备好，请刷新后重试';
const SAFE_ERRORS = new Set([FALLBACK, '可用视口太小，请放大浏览器窗口后开始',
  '迷宫没有可放置倍率泡泡的通道', '迷宫起点不在可通行区域', '请先完成当前页面的截图分析']);
const safeError = error => SAFE_ERRORS.has(error?.message) ||
  typeof error?.message === 'string' && error.message.startsWith('地图传输失败：') && error.message.length <= 160 ? error.message : FALLBACK;

self.onmessage = async event => {
  try {
    const { packet, seed, reservedRects = [], history = [] } = event.data || {};
    const random = P.MazeTransport.random(seed);
    const finitePoint = value => value && Number.isFinite(value.x) && Number.isFinite(value.y);
    if (!Array.isArray(reservedRects) || reservedRects.length > 32 || !reservedRects.every(rect => finitePoint(rect) &&
        Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width >= 0 && rect.height >= 0) ||
        !Array.isArray(history) || history.length > 8 || !history.every(nodes => Array.isArray(nodes) && nodes.length <= 32 && nodes.every(finitePoint))) {
      throw new Error(FALLBACK);
    }
    const source = await P.MapCodec.decode(packet);
    const level = P.LevelGenerator.generate(source, reservedRects, random, history);
    self.postMessage({ ok: true, level: await P.MazeTransport.encode(level) });
  } catch (error) {
    self.postMessage({ ok: false, error: safeError(error) });
  }
};
