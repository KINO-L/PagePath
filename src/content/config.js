(() => {
  'use strict';
  const P = globalThis.__PAGEPATH__ ||= {};
  const modes = Object.freeze({
    normal: Object.freeze({ id: 'normal', label: '普通', targetNodes: 10, maxNodes: 12,
      inkMultiplier: 1.22, trailLength: 45 }),
    hell: Object.freeze({ id: 'hell', label: '地狱', targetNodes: 14, maxNodes: 16,
      inkMultiplier: 1.10, inkBaselineNodes: 5, inkPerNode: 0.015, trailLength: 45 }),
    immortal: Object.freeze({ id: 'immortal', label: '神仙', targetNodes: 14, maxNodes: 16,
      inkMultiplier: 1.10, trailLength: 45 }),
  });
  P.Config = Object.freeze({
    DEBUG: false,
    OBSTACLE_PADDING: 1,
    PLAYER_RADIUS: 1,
    GRID_SIZE: 16,
    MAX_GRID_CELLS: 24000,
    NODE_RADIUS: 5,
    HIT_RADIUS: 12,
    NODE_CLEARANCE: 14,
    NODE_MIN_DISTANCE: 64,
    EDGE_MARGIN: 20,
    MAX_INK_MULTIPLIER: 1.22,
    MIN_NODES: 4,
    MAX_NODES: 12,
    NORMAL_NODES: 10,
    GENERATION_ATTEMPTS: 4,
    HASH_CELL_SIZE: 64,
    FAILURE_DELAY: 850,
    SCORE_PER_NODE: 100,
    DEFAULT_MODE: 'normal',
    MODES: modes,
  });
  P.getMode = modeId => Object.prototype.hasOwnProperty.call(modes, modeId) ? modes[modeId] : modes.normal;
  // Use the actual number of placed nodes, including start and finish. Small
  // fallback maps keep the base allowance; only Hell adds a node-based reserve.
  P.getInkMultiplier = (modeId, nodeCount) => {
    const mode = P.getMode(modeId);
    const count = Number.isFinite(nodeCount) ? Math.max(0, Math.min(mode.maxNodes, Math.floor(nodeCount))) : 0;
    const extraNodes = Math.max(0, count - (mode.inkBaselineNodes ?? 0));
    return Number((mode.inkMultiplier + extraNodes * (mode.inkPerNode ?? 0)).toFixed(4));
  };
})();
