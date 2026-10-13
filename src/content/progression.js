(() => {
  'use strict';
  const P = globalThis.__PAGEPATH__ ||= {};
  const RULES = Object.freeze({ maxLevel: 100, firstLevelXp: 120, levelXpStep: 60,
    recentRunLimit: 128, maxTotal: 1000000000,
    titles: Object.freeze([
      Object.freeze({ level: 1, name: '初入迷途' }),
      Object.freeze({ level: 5, name: '识途新秀' }),
      Object.freeze({ level: 10, name: '寻径好手' }),
      Object.freeze({ level: 20, name: '迷宫行者' }),
      Object.freeze({ level: 35, name: '破阵高手' }),
      Object.freeze({ level: 50, name: '千径宗师' }),
      Object.freeze({ level: 75, name: '万象领路人' }),
      Object.freeze({ level: 100, name: '迷宫之神' }),
    ]) });
  const integer = (value, maximum = RULES.maxTotal) => typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(maximum, Math.floor(value))) : 0;
  const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(value);
  // Total XP needed to reach level n; each next level costs 60 XP more.
  const threshold = level => {
    const steps = Math.max(0, level - 1);
    return steps * RULES.firstLevelXp + steps * (steps - 1) * RULES.levelXpStep / 2;
  };

  function empty() {
    return { version: 3, totalXp: 0, totalScore: 0, totalRuns: 0, bestScore: 0, recentRuns: [] };
  }

  function normalize(input) {
    const source = input && typeof input === 'object' ? input : {};
    const recentRuns = [], seen = new Set();
    // Bound work before iterating an untrusted or outdated stored profile.
    const candidates = Array.isArray(source.recentRuns) ? source.recentRuns.slice(-RULES.recentRunLimit) : [];
    for (const run of candidates) {
      if (!run || !validId(run.id) || seen.has(run.id)) continue;
      seen.add(run.id);
      recentRuns.push({ id: run.id, score: integer(run.score, 1000000), xp: integer(run.xp, 100000),
        difficulty: integer(run.difficulty, 100) });
    }
    // Migrate earlier profiles without resetting XP or recent settlement IDs.
    const legacyBest = Math.max(integer(source.modeBests?.normal, 1000000), integer(source.modeBests?.hell, 1000000));
    return { version: 3, totalXp: integer(source.totalXp), totalScore: integer(source.totalScore),
      totalRuns: integer(source.totalRuns), bestScore: Math.max(integer(source.bestScore, 1000000), legacyBest),
      recentRuns };
  }

  function view(input) {
    const profile = normalize(input), a = RULES.levelXpStep / 2, b = RULES.firstLevelXp - a;
    const steps = Math.floor((Math.sqrt(b * b + 4 * a * profile.totalXp) - b) / (2 * a));
    const level = Math.min(RULES.maxLevel, steps + 1), maxLevel = level === RULES.maxLevel;
    const xpIntoLevel = maxLevel ? 0 : profile.totalXp - threshold(level);
    const xpForNextLevel = maxLevel ? 0 : RULES.firstLevelXp + (level - 1) * RULES.levelXpStep;
    let title = RULES.titles[0].name;
    for (const stage of RULES.titles) if (level >= stage.level) title = stage.name;
    return { level, title, totalXp: profile.totalXp, xpIntoLevel, xpForNextLevel,
      currentXp: xpIntoLevel, nextLevelXp: xpForNextLevel, progress: maxLevel ? 1 : xpIntoLevel / xpForNextLevel,
      maxLevel, totalRuns: profile.totalRuns, wins: profile.totalRuns, totalScore: profile.totalScore,
      bestScore: profile.bestScore };
  }

  function award(input, reward = {}) {
    const profile = normalize(input), previous = view(profile);
    reward = reward && typeof reward === 'object' ? reward : {};
    const rewardScore = integer(reward.score, 1000000), rewardXp = integer(reward.xp, 100000);
    const duplicate = validId(reward.runId) && profile.recentRuns.some(run => run.id === reward.runId);
    if (!validId(reward.runId) || !rewardScore || !rewardXp || duplicate) {
      return { profile, ...previous, awarded: false, reason: duplicate ? 'duplicate' : 'invalid-run',
        previousLevel: previous.level, leveledUp: false, levelsGained: 0, rewardXp: 0, rewardScore: 0, xp: 0 };
    }
    profile.totalXp = integer(profile.totalXp + rewardXp);
    profile.totalScore = integer(profile.totalScore + rewardScore);
    profile.totalRuns = integer(profile.totalRuns + 1);
    profile.bestScore = Math.max(profile.bestScore, rewardScore);
    profile.recentRuns.push({ id: reward.runId, score: rewardScore, xp: rewardXp,
      difficulty: integer(reward.difficulty, 100) });
    profile.recentRuns = profile.recentRuns.slice(-RULES.recentRunLimit);
    const current = view(profile);
    return { profile, ...current, awarded: true, previousLevel: previous.level,
      leveledUp: current.level > previous.level, levelsGained: current.level - previous.level,
      rewardXp, rewardScore, xp: rewardXp };
  }

  P.Progression = Object.freeze({ RULES, empty, normalize, view, award });
})();
