const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const {
  extractCoords,
  parseYandexGeoUri,
  parseYandexRoutes,
  getArmenianAudio,
  isAllowedMapLink,
  fetchUpstream,
  takeRateToken,
  RATE_LIMIT_CAPACITY
} = require('../server.js');

const ROOT = path.resolve(__dirname, '..');

test('extractCoords understands Google @, q=, Yandex ll= and plain coordinates', () => {
  assert.deepEqual(extractCoords('https://www.google.com/maps/place/x/@40.1772,44.5126,17z'), { lat: 40.1772, lng: 44.5126 });
  assert.deepEqual(extractCoords('https://maps.google.com/?q=40.18,44.51'), { lat: 40.18, lng: 44.51 });
  // Yandex puts longitude first in ll=
  assert.deepEqual(extractCoords('https://yandex.ru/maps/?ll=44.51%2C40.18&z=12'), { lat: 40.18, lng: 44.51 });
  assert.deepEqual(extractCoords('40.189551, 44.468663'), { lat: 40.189551, lng: 44.468663 });
  assert.equal(extractCoords('Kentron, Yerevan'), null);
});

test('parseYandexGeoUri decodes the float pair from a Yandex protobuf URI', () => {
  const buf = Buffer.alloc(10);
  buf[0] = 0x0d; buf.writeFloatLE(44.5126, 1);
  buf[5] = 0x15; buf.writeFloatLE(40.1772, 6);
  const geo = parseYandexGeoUri(`ymapsbm1://geo?data=${encodeURIComponent(buf.toString('base64'))}`);
  assert.ok(Math.abs(geo.lat - 40.1772) < 1e-4);
  assert.ok(Math.abs(geo.lng - 44.5126) < 1e-4);
  assert.equal(parseYandexGeoUri('ymapsbm1://org?oid=123'), null);
});

function yandexRoute({ duration, durationWithoutTraffic, sections }) {
  return {
    coordinates: [[44.50, 40.18], [44.51, 40.18], [44.52, 40.18]],
    colorizeInfo: [{ type: 'FREE', count: 1 }, { type: 'HARD', count: 1 }],
    distance: { value: 1800 },
    duration,
    durationInTraffic: duration,
    durationWithoutTraffic,
    paths: [{ segments: sections }]
  };
}

test('parseYandexRoutes: steps carry the maneuver of the section START, routes sorted fastest first', () => {
  const slow = yandexRoute({
    duration: 900,
    durationWithoutTraffic: 600,
    sections: [
      { action: { value: 'straight' }, street: 'Sarmen Street', distance: { value: 500 }, edgePoints: [[44.50, 40.18], [44.505, 40.18]] },
      { action: { value: 'LEFT' }, street: 'Galoyan Brothers Street', distance: { value: 300 }, edgePoints: [[44.505, 40.18], [44.505, 40.185]] }
    ]
  });
  const fast = yandexRoute({
    duration: 700,
    durationWithoutTraffic: 500,
    sections: [
      { action: { value: 'straight' }, street: 'Baghramyan Avenue', distance: { value: 400 }, edgePoints: [[44.50, 40.18], [44.504, 40.18]] },
      { action: { value: 'SLIGHT_RIGHT' }, street: 'M-4 highway', distance: { value: 900 }, edgePoints: [[44.504, 40.18], [44.52, 40.18]] }
    ]
  });
  const routes = parseYandexRoutes([slow, fast], []);
  assert.equal(routes.length, 2);
  assert.equal(routes[0].duration, 700, 'fastest first');
  assert.deepEqual(routes.map(r => r.index), [0, 1]);

  const left = routes[1].steps[1];
  assert.equal(left.modifier, 'left');
  assert.equal(left.name, 'Galoyan Brothers Street');
  assert.deepEqual(left.location, [44.505, 40.18], 'maneuver location is where the section starts');
  assert.equal(left.speedLimitSource, 'estimated');

  assert.equal(routes[0].steps[1].modifier, 'slight right');
  assert.equal(routes[0].steps[1].speedLimit, 90, 'highway heuristic');
  assert.match(routes[0].summary, /^через /);
  assert.ok(routes[0].segments.some(s => s.type === 'HARD'));
});

test('getArmenianAudio maps keys and Armenian phrases, never falls back to the greeting', () => {
  const file = (voice, name) => fs.readFileSync(path.join(ROOT, 'sounds/hy', voice, name));
  assert.ok(getArmenianAudio('dist_250_keep_left', 'suzie').equals(file('suzie', 'dist_250_keep_left.mp3')));
  assert.ok(getArmenianAudio('Կատարեք հետադարձ', 'gor').equals(file('gor', 'uturn.mp3')));
  assert.ok(getArmenianAudio('Երկու հարյուր հիսուն մետրից պահեք աջ', 'gor').equals(file('gor', 'dist_250_keep_right.mp3')));
  assert.ok(getArmenianAudio('Թեքվեք ձախ', 'suzie').equals(file('suzie', 'turn_left.mp3')));
  assert.equal(getArmenianAudio('completely unknown phrase', 'gor'), null);
});

test('isAllowedMapLink only accepts map share-link hosts', () => {
  assert.equal(isAllowedMapLink('https://maps.app.goo.gl/abc'), true);
  assert.equal(isAllowedMapLink('https://www.google.com/maps/place/x'), true);
  assert.equal(isAllowedMapLink('https://yandex.ru/maps/-/CCU'), true);
  assert.equal(isAllowedMapLink('http://169.254.169.254/computeMetadata/v1/'), false);
  assert.equal(isAllowedMapLink('http://localhost:8085/server.js'), false);
  assert.equal(isAllowedMapLink('https://google.com.evil.example/x'), false);
  assert.equal(isAllowedMapLink('file:///etc/passwd'), false);
});

test('takeRateToken allows a burst and then refuses', () => {
  const ip = `test-${Math.random()}`;
  let allowed = 0;
  for (let i = 0; i < RATE_LIMIT_CAPACITY + 10; i++) if (takeRateToken(ip)) allowed++;
  assert.ok(allowed >= RATE_LIMIT_CAPACITY && allowed <= RATE_LIMIT_CAPACITY + 1);
  assert.equal(takeRateToken(ip), false);
});

test('fetchUpstream aborts a hung upstream at its deadline', async () => {
  const hung = http.createServer(() => { /* never answers */ });
  await new Promise(resolve => hung.listen(0, resolve));
  const started = Date.now();
  await assert.rejects(fetchUpstream(`http://127.0.0.1:${hung.address().port}/`, {}, 300), err => /abort|timeout/i.test(`${err.name} ${err.message}`));
  assert.ok(Date.now() - started < 3000);
  hung.closeAllConnections();
  hung.close();
});
