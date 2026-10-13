(() => {
  'use strict';
  const P = globalThis.__PAGEPATH__ ||= {};
  P.Config = Object.freeze({
    DEBUG: false,
    OBSTACLE_PADDING: 1,
    PLAYER_RADIUS: 1,
    PIXEL_MAP: Object.freeze({ MAX_PIXELS: 8500000, FOREGROUND_DELTA: 9,
      BACKGROUND_FLAT_DELTA: 3, DECORATIVE_LINE_MAX_DELTA: 22,
      SAFETY_MARGIN: 1, CONTOUR_BUCKET_SIZE: 64, WARNING_DISTANCE: 56 }),
    HYBRID_DOM: Object.freeze({ MAX_WIDTH: 240, MAX_HEIGHT: 96, MAX_AREA: 14000,
      MAX_VIEWPORT_RATIO: 0.018, MIN_SIZE: 4, MAX_HINTS: 512, MAX_SCAN: 4000 }),
    HIT_RADIUS: 12,
    HASH_CELL_SIZE: 64,
    FAILURE_DELAY: 850,
    COLLECTIBLES: Object.freeze({ radius: 10, revealDistance: 56, minSpacing: 42, endpointMargin: 48,
      maxXpCount: 10, maxMultiplier: 8,
      xpWeights: Object.freeze([
        Object.freeze({ value: 10, weight: 60 }), Object.freeze({ value: 20, weight: 30 }),
        Object.freeze({ value: 40, weight: 10 }),
      ]),
      multiplierWeights: Object.freeze([
        Object.freeze({ value: 2, weight: 25 }),
        Object.freeze({ value: 3, weight: 10 }), Object.freeze({ value: 5, weight: 4 }),
        Object.freeze({ value: 8, weight: 1 }),
      ]),
    }),
    DIFFICULTY: Object.freeze({ min: 0, max: 100 }),
  });
  const difficultyProfiles = new WeakMap();
  const simpleProbabilities = Object.freeze([.36, .29, .20, .10, .05]);
  const complexProbabilities = Object.freeze([.05, .10, .20, .29, .36]);
  const clampUnit = value => Math.max(0, Math.min(1, value));

  function difficultyProfile(source) {
    if (source && difficultyProfiles.has(source)) return difficultyProfiles.get(source);
    const { width, height, obstacleMask } = source || {};
    let pageComplexity = 0;
    if (Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0 &&
        obstacleMask?.length === width * height) {
      // Read the screenshot mask before maze walls/carving. Coverage alone misses
      // scattered text, while edge density alone calls a solid foreground empty.
      const columns = Math.min(8, width), rows = Math.min(6, height);
      const columnAt = new Uint8Array(width), occupied = new Uint32Array(columns * rows);
      for (let x = 0; x < width; x++) columnAt[x] = Math.floor(x * columns / width);
      let foreground = 0, transitions = 0;
      for (let y = 0; y < height; y++) {
        const offset = y * width, tileRow = Math.floor(y * rows / height) * columns;
        for (let x = 0; x < width; x++) {
          const index = offset + x, filled = Boolean(obstacleMask[index]);
          if (filled) { foreground++; occupied[tileRow + columnAt[x]]++; }
          if (x && filled !== Boolean(obstacleMask[index - 1])) transitions++;
          if (y && filled !== Boolean(obstacleMask[index - width])) transitions++;
        }
      }
      let occupiedTiles = 0;
      for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
        const tileWidth = Math.ceil((column + 1) * width / columns) - Math.ceil(column * width / columns);
        const tileHeight = Math.ceil((row + 1) * height / rows) - Math.ceil(row * height / rows);
        if (occupied[row * columns + column] / (tileWidth * tileHeight) >= .025) occupiedTiles++;
      }
      const coverage = clampUnit(foreground / (width * height) / .65);
      const distribution = occupiedTiles / occupied.length;
      const pairs = (width - 1) * height + (height - 1) * width;
      const fragmentation = pairs ? clampUnit(transitions / pairs / .06) : 0;
      pageComplexity = clampUnit(.55 * coverage + .20 * distribution + .25 * fragmentation);
    }
    // A nonzero floor leaves every star tier available on every page. Geometry
    // generation still has to meet the chosen target before awarding its stars.
    const probabilities = Object.freeze(simpleProbabilities.map((chance, index) =>
      chance + (complexProbabilities[index] - chance) * pageComplexity));
    const profile = Object.freeze({ pageComplexity, probabilities });
    if (source && typeof source === 'object') difficultyProfiles.set(source, profile);
    return profile;
  }

  P.Difficulty = Object.freeze({
    stars(value) {
      const difficulty = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
      return Math.max(1, Math.ceil(difficulty / 20));
    },
    profile: difficultyProfile,
    draw(source, random = Math.random) {
      const profile = difficultyProfile(source);
      const sample = () => Math.min(.999999999999, Math.max(0, Number(random()) || 0));
      const roll = sample();
      let cumulative = 0, targetStars = 5;
      for (let i = 0; i < profile.probabilities.length; i++) {
        cumulative += profile.probabilities[i];
        if (roll < cumulative) { targetStars = i + 1; break; }
      }
      const targetDifficulty = (targetStars - 1) * 20 + 6 + Math.floor(sample() * 9);
      return { ...profile, targetStars, targetDifficulty, intensity: targetDifficulty / 100 };
    }
  });
})();
