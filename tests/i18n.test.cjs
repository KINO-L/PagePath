'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/content/i18n.js'), 'utf8');
const keys = [...source.matchAll(/^    '([^']+)': \[/gm)].map(match => match[1]);

function load(uiLanguage, navigator = {}, failChrome = false) {
  const context = vm.createContext({ navigator, chrome: { i18n: { getUILanguage() {
    if (failChrome) throw new Error('Extension API unavailable');
    return uiLanguage;
  } } } });
  vm.runInContext(source, context);
  for (const file of ['config', 'scoring', 'progression']) {
    vm.runInContext(fs.readFileSync(path.join(root, `src/content/${file}.js`), 'utf8'), context);
  }
  return context.__PAGEPATH__;
}

test('UI language takes precedence over page preferences, with regional and demo fallbacks', () => {
  for (const [ui, navigator, fail, expected] of [
    ['zh-CN', { language: 'ja' }, false, 'zh-CN'],
    ['zh-TW', {}, false, 'zh-CN'], ['zh_HK', {}, false, 'zh-CN'],
    ['ja-JP', { language: 'en' }, false, 'ja'], ['en-GB', {}, false, 'en'],
    ['fr-FR', { language: 'zh-CN' }, false, 'en'],
    [undefined, { language: 'ja-JP' }, false, 'ja'],
    [undefined, { languages: ['zh-CN', 'en-US'] }, false, 'zh-CN'],
    ['en', { language: 'ja' }, true, 'ja'], [undefined, {}, false, 'en'],
  ]) assert.equal(load(ui, navigator, fail).I18n.locale, expected);
});

test('every UI and player-facing error key has complete translations and matching placeholders', () => {
  const supported = new Set(keys);
  const files = ['src/background.js', ...fs.readdirSync(path.join(root, 'src/content'))
    .filter(file => file.endsWith('.js') && file !== 'i18n.js').map(file => `src/content/${file}`)];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const [, key] of text.matchAll(/["']([^"'\r\n]*[\p{Script=Han}][^"'\r\n]*)["']/gu)) {
      // Internal prefix checks are deliberately not display strings.
      if (key === '地图传输失败' || key === '地图传输失败：') continue;
      assert.ok(supported.has(key), `${file}: missing translation for ${key}`);
    }
  }
  const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const language of ['en', 'ja', 'zh-CN']) {
    const { I18n } = load(language);
    for (const key of keys) {
      const value = I18n.t(key);
      assert.ok(value.length > 0, `${language}: ${key}`);
      assert.deepEqual(placeholders(value), placeholders(key), `${language}: ${key}`);
      if (language === 'en') assert.doesNotMatch(value.replaceAll('迷页', ''), /\p{Script=Han}/u, key);
      if (language === 'zh-CN') assert.equal(value, key);
    }
  }
});

test('dynamic XP and structured map errors are rendered in the selected language', () => {
  const english = load('en-US').I18n, japanese = load('ja').I18n, chinese = load('zh-CN').I18n;
  assert.equal(english.t('本局获得 {amount} 经验', { amount: '+1,234' }), 'Earned +1,234 XP');
  assert.equal(japanese.t('已收集 {xp} 经验 · {multiplier} 倍', { xp: 40, multiplier: 3 }), '獲得 40 経験値 · 3 倍');
  for (const language of [english, japanese, chinese]) {
    assert.equal(language.number(150000), '150,000');
    const reason = '地图数据长度与尺寸不符';
    assert.equal(language.error('地图传输失败：' + reason), language.t('地图传输失败：{reason}', { reason: language.t(reason) }));
    assert.equal(language.error(''), '');
    assert.equal(language.error('unknown engine failure'), language.t('地图暂未准备好，请刷新后重试'));
    assert.equal(language.error('碰到了迷宫边界，点击小火堆重试'), language.t('碰到了迷宫边界，点击小火堆重试'));
  }
});

test('switching languages preserves progress and deduplication while translating rank titles', () => {
  const profile = { version: 3, totalXp: 149500, totalScore: 70000, totalRuns: 300, bestScore: 2000,
    recentRuns: [{ id: 'previous-map', xp: 500, score: 1200, difficulty: 30 }] };
  const reward = { runId: 'current-map', score: 1800, xp: 500, difficulty: 60 };
  let saved;
  for (const locale of ['zh-CN', 'en', 'ja']) {
    const { I18n, Progression } = load(locale);
    const result = Progression.award(profile, reward);
    assert.equal(result.level, 5);
    assert.equal(result.title, I18n.title(5));
    assert.equal(result.totalXp, 150000);
    assert.equal(result.maxLevel, true);
    const serialized = JSON.stringify(result.profile);
    if (saved) assert.equal(serialized, saved);
    saved = serialized;
    assert.equal(Progression.award(JSON.parse(saved), reward).awarded, false);
    for (let level = 1; level <= 5; level++) {
      const stage = Progression.RULES.titles[level - 1];
      assert.equal(Progression.view({ totalXp: stage.minXp }).title, I18n.title(level));
    }
  }
});
