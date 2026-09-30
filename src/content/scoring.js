(() => {
  'use strict';
  const P = globalThis.__PAGEPATH__ ||= {};
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

  function difficulty(analysis, grid, nodeCount = P.Config.NORMAL_NODES, challenge = {}) {
    const stats = analysis.stats || {};
    const blockedRatio = analysis.kind === 'pixel-mask'
      ? 1 - grid.walkablePixelCount / Math.max(1, analysis.width * analysis.height)
      : 1 - grid.walkableCount / Math.max(1, grid.walkable.length);
    const reportedRatio = stats.obstacleAreaRatio ?? stats.obstacleRatio ?? blockedRatio;
    const obstacleRatio = clamp(Number(reportedRatio) || 0, 0, 1);
    const foregroundCount = analysis.kind === 'pixel-mask'
      ? stats.foregroundComponents ?? stats.obstacleComponents ?? stats.obstacleComponentCount ?? 0
      : analysis.rects.length;
    const density = clamp(Math.log1p(foregroundCount) / Math.log(301), 0, 1);
    // Keep a stable 2.5 rating points per additional node. Raising a mode's
    // node cap must not make the very same layout appear easier.
    const nodeComplexity = clamp((nodeCount - P.Config.MIN_NODES) / 8, 0, 2);
    const turnComplexity = clamp((challenge.turns || 0) / Math.max(1, nodeCount - 2), 0, 1);
    const detourComplexity = clamp(challenge.blockedSightlineRatio || 0, 0, 1);
    return Math.round(clamp(100 * (0.25 * obstacleRatio + 0.2 * grid.narrowRatio + 0.1 * density +
      0.2 * nodeComplexity + 0.15 * turnComplexity + 0.1 * detourComplexity), 0, 100));
  }

  function calculate(level, playerLength) {
    const efficiency = clamp(level.referenceLength / Math.max(1, Number(playerLength) || 1), 0, 1);
    const rating = clamp(level.difficulty || 0, 0, 100);
    const base = level.nodes.length * P.Config.SCORE_PER_NODE;
    return { score: Math.round(base * (1 + rating / 100) * efficiency),
      difficulty: rating, efficiency: Math.round(efficiency * 100) };
  }

  P.Scoring = Object.freeze({ difficulty, calculate });
})();
