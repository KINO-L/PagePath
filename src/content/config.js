(() => {
  'use strict';
  const P = globalThis.__PAGEPATH__ ||= {};
  const modes = Object.freeze({
    normal: Object.freeze({ id: 'normal', label: '萌新', targetNodes: 12, maxNodes: 14,
      inkMultiplier: 1.15, trailLength: 45 }),
    hell: Object.freeze({ id: 'hell', label: '糕手', targetNodes: 16, maxNodes: 18,
      inkMultiplier: 1.06, inkBaselineNodes: 8, inkPerNode: 0.005, trailLength: 45 }),
    immortal: Object.freeze({ id: 'immortal', label: '神仙', targetNodes: 18, maxNodes: 20,
      inkMultiplier: 1.04, trailLength: 45 }),
    maze: Object.freeze({ id: 'maze', label: '第二关', targetNodes: 2, maxNodes: 2,
      inkMultiplier: Infinity, unlimitedInk: true, trailLength: 45 }),
  });
  P.Config = Object.freeze({
    DEBUG: false,
    OBSTACLE_PADDING: 1,
    PLAYER_RADIUS: 1,
    PIXEL_MAP: Object.freeze({ MAX_PIXELS: 8500000, FOREGROUND_DELTA: 9,
      BACKGROUND_FLAT_DELTA: 3, DECORATIVE_LINE_MAX_DELTA: 22,
      SAFETY_MARGIN: 1, CONTOUR_BUCKET_SIZE: 64, WARNING_DISTANCE: 56 }),
    HYBRID_DOM: Object.freeze({ MAX_WIDTH: 240, MAX_HEIGHT: 96, MAX_AREA: 14000,
      MAX_VIEWPORT_RATIO: 0.018, MIN_SIZE: 4, MAX_HINTS: 512, MAX_SCAN: 4000 }),
    MAZE_REQUIREMENTS: Object.freeze({ minObstacleRatio: 0.2, minOccupiedRegions: 30 }),
    GRID_SIZE: 16,
    MAX_GRID_CELLS: 24000,
    NODE_RADIUS: 5,
    HIT_RADIUS: 12,
    NODE_CLEARANCE: 14,
    NODE_MIN_DISTANCE: 64,
    EDGE_MARGIN: 20,
    MAX_INK_MULTIPLIER: modes.normal.inkMultiplier,
    MIN_NODES: 4,
    MAX_NODES: Math.max(...Object.values(modes).map(mode => mode.maxNodes)),
    NORMAL_NODES: modes.normal.targetNodes,
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
    if (mode.unlimitedInk) return Infinity;
    const count = Number.isFinite(nodeCount) ? Math.max(0, Math.min(mode.maxNodes, Math.floor(nodeCount))) : 0;
    const extraNodes = Math.max(0, count - (mode.inkBaselineNodes ?? 0));
    return Number((mode.inkMultiplier + extraNodes * (mode.inkPerNode ?? 0)).toFixed(4));
  };
})();
