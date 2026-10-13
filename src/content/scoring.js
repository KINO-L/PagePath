(() => {
  'use strict';
  const P = globalThis.__PAGEPATH__ ||= {};
  const RULES = Object.freeze({ baseScore: 600, pointsPerDifficulty: 20, pointsPerXp: 10 });
  const C = P.Config.COLLECTIBLES;
  const multipliers = new Set([1, ...C.multiplierWeights.map(item => item.value)]);
  const sums = [new Set([0])];
  for (let count = 1; count <= C.maxXpCount; count++) {
    sums.push(new Set([...sums[count - 1]].flatMap(sum => C.xpWeights.map(item => sum + item.value))));
  }
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const finite = (value, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;

  function collectionStats(stats) {
    if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return null;
    const keys = ['collectedXp', 'collectedCount', 'multiplier'];
    // Old pending receipts have no collectible fields. Migrate them to the
    // current base reward; their obsolete measurements never affect scoring.
    if (!keys.some(key => Object.hasOwn(stats, key))) return { collectedXp: 0, collectedCount: 0, multiplier: 1 };
    const { collectedXp, collectedCount, multiplier } = stats;
    if (!keys.every(key => Object.hasOwn(stats, key)) ||
        !Number.isInteger(collectedCount) || collectedCount < 0 || collectedCount > C.maxXpCount ||
        !Number.isInteger(collectedXp) || !sums[collectedCount].has(collectedXp) ||
        !Number.isInteger(multiplier) || !multipliers.has(multiplier) || multiplier > C.maxMultiplier) return null;
    return { collectedXp, collectedCount, multiplier };
  }

  function calculate(level, stats = {}) {
    level = level && typeof level === 'object' ? level : {};
    const difficulty = clamp(finite(level.difficulty), 0, 100);
    const scoringDifficulty = level.challenge?.complexity === undefined ? difficulty :
      clamp(finite(level.challenge.complexity), 0, 1) * 100;
    const { collectedXp, collectedCount, multiplier } = collectionStats(stats) ||
      { collectedXp: 0, collectedCount: 0, multiplier: 1 };
    const score = Math.round(RULES.baseScore + RULES.pointsPerDifficulty * scoringDifficulty);
    const baseXp = Math.round(score / RULES.pointsPerXp);
    const xp = Math.round((baseXp + collectedXp) * multiplier);
    return { score, xp, baseXp, collectedXp, multiplier, collectedCount,
      difficulty, scoringDifficulty, complexity: scoringDifficulty / 100,
      breakdown: { baseScore: RULES.baseScore, difficultyPoints: score - RULES.baseScore,
        baseXp, collectedXp, unmultipliedXp: baseXp + collectedXp, multiplier } };
  }

  P.Scoring = Object.freeze({ RULES, collectionStats, calculate });
})();
