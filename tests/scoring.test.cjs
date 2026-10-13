'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const context = vm.createContext({});
for (const file of ['config', 'scoring', 'progression']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/content', `${file}.js`), 'utf8'), context);
}
const { Scoring: S, Progression: P } = context.__PAGEPATH__;
const level = { difficulty: 40 };
const metrics = { collectedXp: 0, collectedCount: 0, multiplier: 1 };
const plain = value => JSON.parse(JSON.stringify(value));
const reward = (runId, score = 1000, xp = 100) => ({ runId, score, xp, difficulty: 40 });

test('levels without measured complexity retain difficulty-based reward compatibility', () => {
  let prior = 0;
  for (const difficulty of [0, 20, 40, 60, 80, 100]) {
    const result = S.calculate({ ...level, difficulty }, metrics);
    assert.ok(result.score > prior);
    assert.equal(result.score, 600 + 20 * difficulty);
    assert.equal(result.baseXp, 60 + 2 * difficulty);
    assert.equal(result.xp, Math.round(result.score / 10));
    prior = result.score;
  }
});

test('measured geometry determines rewards independently of an outdated display value', () => {
  for (const complexity of [0, 0.4, 1]) {
    const challenge = { ...level.challenge, complexity };
    const actual = S.calculate({ ...level, difficulty: complexity * 100, challenge }, metrics);
    const stale = S.calculate({ ...level, difficulty: complexity * 25 + 20, challenge }, metrics);
    assert.equal(actual.score, stale.score);
    assert.equal(actual.xp, stale.xp);
    assert.equal(actual.scoringDifficulty, complexity * 100);
  }
});

test('actual complexity raises rewards throughout the full range', () => {
  let previousScore = 0;
  for (const complexity of [0, 0.2, 0.4, 0.7, 1]) {
    const result = S.calculate({ ...level, challenge: { ...level.challenge, complexity } }, metrics);
    assert.ok(result.score > previousScore);
    previousScore = result.score;
  }
  const simple = S.calculate({ ...level, difficulty: 90,
    challenge: { ...level.challenge, complexity: 0.2 } }, metrics);
  const complex = S.calculate({ ...level, difficulty: 20,
    challenge: { ...level.challenge, complexity: 0.8 } }, metrics);
  assert.ok(complex.score > simple.score && complex.xp > simple.xp);
});

test('XP adds collected bubbles to the base reward before applying the one multiplier', () => {
  for (const multiplier of [1, 2, 3, 5, 8]) {
    const result = S.calculate(level, { collectedXp: 70, collectedCount: 3, multiplier });
    assert.equal(result.score, 1400);
    assert.equal(result.baseXp, 140);
    assert.equal(result.collectedXp, 70);
    assert.equal(result.collectedCount, 3);
    assert.equal(result.xp, (140 + 70) * multiplier);
  }
  assert.equal(S.calculate(level, { ...metrics, multiplier: 8 }).xp, 140 * 8, 'a multiplier can be found without an XP bubble');
  const maximum = S.calculate({ difficulty: 100 }, { collectedXp: 400, collectedCount: 10, multiplier: 8 });
  assert.equal(maximum.score, 2600);
  assert.equal(maximum.xp, 5280);
});

test('obsolete time, distance, failures and route measurements cannot change rewards', () => {
  const baseline = S.calculate(level, metrics);
  for (const legacy of [{ elapsedMs: 1, distance: 10, failures: 0 },
    { elapsedMs: 86400000, distance: 10000000, failures: 10000 },
    { elapsedMs: NaN, distance: Infinity, failures: -1 }]) {
    const result = S.calculate({ ...level, referenceLength: 9000, challenge: { turns: 150, deadEnds: 200 } }, { ...metrics, ...legacy });
    assert.deepEqual(plain(result), plain(baseline));
    assert.equal(S.calculate(level, legacy).xp, baseline.xp, 'legacy receipt migrates to the base reward');
  }
  for (const key of ['elapsedMs', 'distance', 'failures', 'targetTimeMs', 'grade', 'efficiency']) assert.equal(baseline[key], undefined);
});

test('collection validation checks exact attainable sums and rejects unsupported multipliers', () => {
  assert.deepEqual(plain(S.collectionStats({ collectedXp: 30, collectedCount: 2, multiplier: 3 })),
    { collectedXp: 30, collectedCount: 2, multiplier: 3 });
  for (const invalid of [null, [], { collectedXp: 20 },
    { ...metrics, collectedCount: 11 }, { ...metrics, collectedCount: 1.5 },
    { ...metrics, collectedXp: -10 }, { ...metrics, collectedXp: 401, collectedCount: 10 },
    { ...metrics, collectedXp: 30, collectedCount: 1 }, { ...metrics, collectedXp: 35, collectedCount: 2 },
    ...[0, 4, 6, 10, Infinity, '2'].map(multiplier => ({ ...metrics, multiplier }))]) {
    assert.equal(S.collectionStats(invalid), null, JSON.stringify(invalid));
    assert.equal(S.calculate(level, invalid).xp, 140, 'invalid collections cannot award a bonus');
  }
});

test('invalid numeric input stays finite and output rewards are rounded to integers', () => {
  for (const value of [NaN, Infinity, -Infinity, -1, 0, null, undefined, 'bad']) {
    const result = S.calculate({ difficulty: value }, { collectedXp: value, collectedCount: value, multiplier: value });
    for (const key of ['score', 'xp', 'baseXp', 'collectedXp', 'collectedCount', 'multiplier']) {
      assert.ok(Number.isInteger(result[key]), key);
    }
    assert.ok(result.score >= 600 && result.score <= 2600);
  }
  assert.doesNotThrow(() => S.calculate(null, null));
  const fraction = S.calculate({ difficulty: 12, challenge: { complexity: 0.12345 } }, metrics);
  assert.ok(Number.isInteger(fraction.score) && Number.isInteger(fraction.xp));
});

test('XP is cumulative, level thresholds rise, and a reward can cross multiple levels and titles', () => {
  const initial = P.empty();
  assert.equal(P.view(initial).level, 1);
  assert.equal(P.view(initial).nextLevelXp, 120);
  const first = P.award(initial, reward('first', 1000, 119));
  assert.equal(first.level, 1);
  const second = P.award(first.profile, reward('second', 1000, 1));
  assert.equal(second.level, 2);
  assert.equal(second.currentXp, 0);
  assert.equal(second.nextLevelXp, 180);
  assert.equal(second.leveledUp, true);
  const third = P.award(second.profile, reward('third', 3000, 1000));
  assert.ok(third.levelsGained > 1 && third.level >= 5);
  assert.equal(third.title, '识途新秀');
  assert.equal(third.totalXp, 1120);
  assert.equal(third.wins, 3);
  assert.equal(initial.totalXp, 0, 'pure award must not mutate input');
});

test('level boundary math is exact at each stage and enormous XP is bounded', () => {
  let cumulative = 0;
  for (let reached = 2; reached <= 100; reached++) {
    cumulative += 120 + (reached - 2) * 60;
    assert.equal(P.view({ totalXp: cumulative - 1 }).level, reached - 1);
    assert.equal(P.view({ totalXp: cumulative }).level, reached);
  }
  const capped = P.view({ totalXp: Number.MAX_VALUE });
  assert.equal(capped.level, 100);
  assert.equal(capped.title, '迷宫之神');
  assert.equal(capped.progress, 1);
  assert.equal(capped.nextLevelXp, 0);
});

test('duplicate completions remain deduplicated after storage round-trip', () => {
  const first = P.award(P.empty(), reward('a')); // Same runId survives reload and repeat wins.
  const stored = plain(first.profile);
  const repeated = P.award(stored, reward('a', 5000, 500));
  assert.equal(repeated.awarded, false);
  assert.equal(repeated.reason, 'duplicate');
  assert.equal(repeated.rewardXp, 0);
  assert.deepEqual(plain(repeated.profile), stored);
  const next = P.award(stored, reward('b', 2000, 200));
  assert.equal(next.totalScore, 3000);
  assert.equal(next.bestScore, 2000);
  assert.equal(next.profile.version, 3);
  assert.equal(next.profile.modeBests, undefined);
  assert.ok(next.profile.recentRuns.every(run => !Object.hasOwn(run, 'mode')));
});

test('legacy mode profiles migrate without losing levels, totals or settlement IDs', () => {
  const legacy = { version: 1, totalXp: 1120, totalScore: 8000, totalRuns: 6, bestScore: 1700,
    modeBests: { normal: 1800, hell: 2300 },
    recentRuns: [{ id: 'old-win', score: 2300, xp: 230, mode: 'hell', difficulty: 75, elapsedMs: 50000 }] };
  const migrated = P.normalize(legacy);
  assert.equal(migrated.version, 3);
  assert.equal(migrated.totalXp, 1120);
  assert.equal(migrated.totalScore, 8000);
  assert.equal(migrated.totalRuns, 6);
  assert.equal(migrated.bestScore, 2300);
  assert.equal(P.view(migrated).level, P.view({ totalXp: legacy.totalXp }).level);
  assert.equal(migrated.modeBests, undefined);
  assert.equal(migrated.recentRuns[0].id, 'old-win');
  assert.equal(migrated.recentRuns[0].mode, undefined);
  assert.equal(migrated.recentRuns[0].elapsedMs, undefined);
  assert.equal(P.award(migrated, reward('old-win')).awarded, false);
  assert.equal(legacy.recentRuns[0].mode, 'hell', 'migration must not mutate a loaded snapshot');
});

test('history is bounded and normalizing corrupt profiles cannot inject fields', () => {
  let profile = P.empty();
  for (let i = 0; i < 160; i++) profile = P.award(profile, reward(`run-${i}`)).profile;
  assert.equal(profile.recentRuns.length, 128);
  assert.equal(profile.totalRuns, 160);
  assert.equal(profile.recentRuns[0].id, 'run-32');
  assert.equal(P.award(profile, reward('run-159')).awarded, false);
  const malicious = JSON.parse('{"totalXp":-5,"totalScore":"100","modeBests":{"__proto__":{"polluted":true},"hell":3},"unwanted":true}');
  malicious.recentRuns = [null, {}, { id: 'ok', mode: '__proto__', score: Infinity }, { id: 'ok' }];
  const result = P.normalize(malicious);
  assert.equal(result.totalXp, 0);
  assert.equal(result.totalScore, 0);
  assert.equal(result.recentRuns.length, 1);
  assert.equal(result.recentRuns[0].mode, undefined);
  assert.equal(result.unwanted, undefined);
  assert.equal({}.polluted, undefined);
});

test('invalid rewards cannot consume a run ID or grant experience', () => {
  for (const bad of [null, {}, reward(''), reward('a'.repeat(97)), reward('path/invalid'), reward('ok', NaN, 3), reward('ok', 3, Infinity)]) {
    const result = P.award(P.empty(), bad);
    assert.equal(result.awarded, false);
    assert.equal(result.xp, 0);
    assert.equal(result.profile.recentRuns.length, 0);
  }
});
