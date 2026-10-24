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

test('lane guidance shows only real lane data, never invented lanes', () => {
  const pill = { innerHTML: '', classList: { hidden: true, add() { this.hidden = true; }, remove() { this.hidden = false; }, toggle() {}, contains() { return this.hidden; } } };
  const ctx = createBrowserContext();
  ctx.document.readyState = 'loading';
  ctx.document.getElementById = id => (id === 'lane-guidance-pill' ? pill : null);
  loadScripts(ctx, ['js/config.js', 'js/tesla-cockpit.js']);
  const render = get(ctx, 'renderLaneGuidance');
  render({ modifier: 'left', distanceMeters: 80, lanes: [] }); // a turn without OSM lanes
  assert.equal(pill.classList.hidden, true, 'no "one left, one right" made up');
  render({ modifier: 'left', laneDistanceMeters: 90, lanes: [{ valid: true, indications: ['left'] }, { valid: true, indications: ['left'] }, { valid: false, indications: ['right'] }, { valid: false, indications: ['right'] }] });
  assert.equal(pill.classList.hidden, false);
  assert.equal((pill.innerHTML.match(/lane-col-item/g) || []).length, 4);
  assert.equal((pill.innerHTML.match(/is-active/g) || []).length, 2);
  render({ modifier: 'left', laneDistanceMeters: 400, lanes: [{ valid: true, indications: ['left'] }] });
  assert.equal(pill.classList.hidden, true, 'too far from the junction');
});

test('the car page reloads after a deploy only while idle, never mid-route', async () => {
  let reloads = 0;
  let version = 'rev-1';
  const ctx = createBrowserContext({
    fetch: async () => ({ ok: true, json: async () => ({ version }) }),
    location: { protocol: 'http:', host: 'localhost', search: '', origin: 'http://localhost', pathname: '/', reload: () => { reloads++; } }
  });
  ctx.document.readyState = 'loading';
  loadScripts(ctx, ['js/config.js', 'js/tesla-cockpit.js']);
  const check = get(ctx, 'checkForAppUpdate');
  assert.equal(await check(), false, 'first answer is the loaded version');
  assert.equal(await check(), false, 'same version: nothing to do');
  version = 'rev-2';
  get(ctx, 'mapEngine = { isNavigating: true, activeRoute: {} }');
  assert.equal(await check(), false, 'new version while navigating: wait');
  assert.equal(reloads, 0);
  get(ctx, 'mapEngine = { isNavigating: false, activeRoute: null }');
  assert.equal(await check(), true, 'route over: reload');
  assert.equal(reloads, 1);
});
