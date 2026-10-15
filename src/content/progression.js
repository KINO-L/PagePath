(() => {
  'use strict';
  const P = globalThis.__PAGEPATH__ ||= {};
  const RULES = Object.freeze({ maxLevel: 5,
    recentRunLimit: 128, maxTotal: 1000000000,
    titles: Object.freeze([
      Object.freeze({ level: 1, name: '萌新', minXp: 0 }),
      Object.freeze({ level: 2, name: '糕手', minXp: 1500 }),
      Object.freeze({ level: 3, name: '吴迪', minXp: 15000 }),
      Object.freeze({ level: 4, name: '？？？', minXp: 60000 }),
      Object.freeze({ level: 5, name: '神仙', minXp: 150000 }),
    ]) });
  const integer = (value, maximum = RULES.maxTotal) => typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(maximum, Math.floor(value))) : 0;
  const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(value);

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
    const profile = normalize(input);
    // Stored experience is unchanged. Re-derive the rank from cumulative
    // thresholds, including profiles earned under the former 100-level curve.
    let index = 0;
    while (index + 1 < RULES.titles.length && profile.totalXp >= RULES.titles[index + 1].minXp) index++;
    const stage = RULES.titles[index], next = RULES.titles[index + 1];
    const level = stage.level, title = P.I18n?.title(stage.level) || stage.name, maxLevel = !next;
    const xpIntoLevel = maxLevel ? 0 : profile.totalXp - stage.minXp;
    const xpForNextLevel = maxLevel ? 0 : next.minXp - stage.minXp;
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
