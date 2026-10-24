const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserContext, loadScripts, get } = require('./helpers/browser-context');

// Only the pure helpers are exercised: with readyState 'loading' the cockpit waits for
// DOMContentLoaded (a no-op stub here), so none of its UI init runs.
function load() {
  const ctx = createBrowserContext();
  ctx.document.readyState = 'loading';
  return loadScripts(ctx, ['js/config.js', 'js/tesla-cockpit.js']);
}

test('traffic hint follows the UI language: Yandex ru/en, our Armenian, never Russian in hy', () => {
  const ctx = load();
  const hintFor = (data, lang) => get(ctx, 'trafficHintText')(data, lang);
  const data = { score: 4, hint: 'Местами затруднения', hints: { ru: 'Местами затруднения', en: 'Congested in places' } };
  assert.equal(hintFor(data, 'ru'), 'Местами затруднения');
  assert.equal(hintFor(data, 'en'), 'Congested in places');
  assert.equal(hintFor(data, 'hy'), 'Տեղ-տեղ դժվարություններ');
  // ё/е and case don't matter for the Armenian lookup
  assert.equal(hintFor({ hints: { ru: 'Серьёзные пробки' } }, 'hy'), 'Լուրջ խցանումներ');
  // unknown phrase / no English hint -> no hint at all instead of the Russian one
  assert.equal(hintFor({ hints: { ru: 'Новая фраза Яндекса', en: null } }, 'hy'), null);
  assert.equal(hintFor({ hints: { ru: 'Новая фраза Яндекса', en: null } }, 'en'), null);
  // a cached payload from before `hints` existed still works in ru
  assert.equal(hintFor({ hint: 'Движение плотное' }, 'ru'), 'Движение плотное');

  const title = get(ctx, 'trafficBadgeTitle');
  assert.equal(title(data, 'hy'), 'Խցանումներ: 4/10 (Տեղ-տեղ դժվարություններ) · Yandex');
  assert.equal(title({ score: 7, hints: { ru: 'Новая фраза' } }, 'hy'), 'Խցանումներ: 7/10 · Yandex');
});
