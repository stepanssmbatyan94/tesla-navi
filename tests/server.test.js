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
  RATE_LIMIT_CAPACITY,
  parseYandexTrafficXml,
  laneViaPoints,
  extractLaneIntersections
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

function yandexRoute({ duration, durationWithoutTraffic, sections, coordinates }) {
  return {
    coordinates: coordinates || [[44.50, 40.18], [44.51, 40.18], [44.52, 40.18]],
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

test('parseYandexRoutes: roundabout exit number on ENTER and LEAVE, sharp ramps become turns', () => {
  // east 300 m, then a ramp turning ~110° left (north-west), then on
  const lngPerM = 1 / (111320 * Math.cos(40.18 * Math.PI / 180));
  const A = [44.50, 40.18];
  const B = [44.50 + 300 * lngPerM, 40.18];                                  // ramp start
  const C = [B[0] - 100 * Math.sin(Math.PI * 20 / 180) * lngPerM, 40.18 + 100 * Math.cos(Math.PI * 20 / 180) / 110540];
  const route = yandexRoute({
    duration: 600,
    durationWithoutTraffic: 500,
    coordinates: [A, B, C, [C[0], C[1] + 0.002]],
    sections: [
      { action: { value: 'straight' }, street: 'Isakov Avenue', distance: { value: 300 }, edgePoints: [A, B] },
      { action: { value: 'EXIT_LEFT', text: 'exit (left)' }, street: 'Aghasi Khanjyan Street', distance: { value: 100 }, edgePoints: [B, C] },
      { action: { value: 'ENTER_ROUNDABOUT', text: 'roundabout' }, street: 'Garegin Nzhdeh Square', distance: { value: 30 }, edgePoints: [C, C] },
      { action: { value: 'LEAVE_ROUNDABOUT', text: 'take the 3rd exit from roundabout ' }, street: 'Tigran Mets Avenue', distance: { value: 400 }, edgePoints: [C, C] },
      { action: { value: 'FORK_RIGHT', text: 'bear right' }, street: 'Paronyan Street', distance: { value: 200 }, edgePoints: [[C[0], C[1] + 0.001], [C[0], C[1] + 0.002]] }
    ]
  });
  const steps = parseYandexRoutes([route], [])[0].steps;
  assert.equal(steps[1].modifier, 'left', 'EXIT_LEFT measured at ~-110° is a turn, not "keep left"');
  assert.equal(steps[4].modifier, 'slight right', 'a ramp that keeps straight stays "keep right"');
  assert.deepEqual([steps[2].modifier, steps[2].exit, steps[2].exitStreet], ['roundabout', 3, 'Tigran Mets Avenue'], 'known already when approaching');
  assert.deepEqual([steps[3].modifier, steps[3].exit], ['roundabout', 3]);
  assert.equal(steps[2].instruction, 'На круговом движении 3-й съезд');
});

test('getArmenianAudio maps keys and Armenian phrases, never falls back to the greeting', () => {
  const file = (voice, name) => fs.readFileSync(path.join(ROOT, 'sounds/hy', voice, name));
  assert.ok(getArmenianAudio('dist_250_keep_left', 'suzie').equals(file('suzie', 'dist_250_keep_left.mp3')));
  assert.ok(getArmenianAudio('Կատարեք հետադարձ', 'gor').equals(file('gor', 'uturn.mp3')));
  assert.ok(getArmenianAudio('Երկու հարյուր հիսուն մետրից պահեք աջ', 'gor').equals(file('gor', 'dist_250_keep_right.mp3')));
  assert.ok(getArmenianAudio('Թեքվեք ձախ', 'suzie').equals(file('suzie', 'turn_left.mp3')));
  assert.equal(getArmenianAudio('completely unknown phrase', 'gor'), null);
  // roundabouts: the ordinal առաջին ("first") contains աջ and must not become "turn right"
  assert.ok(getArmenianAudio('Շրջանաձև երթևեկությունում դուրս եկեք առաջին ելքով', 'gor').equals(file('gor', 'roundabout_exit_1.mp3')));
  assert.ok(getArmenianAudio('Շրջանաձև երթևեկությունում դուրս եկեք երրորդ ելքով', 'suzie').equals(file('suzie', 'roundabout_exit_3.mp3')));
  assert.ok(getArmenianAudio('dist_250_roundabout', 'gor').equals(file('gor', 'dist_250_roundabout.mp3')));
  assert.ok(getArmenianAudio('Շրջանաձև երթևեկություն', 'suzie').equals(file('suzie', 'roundabout.mp3')));
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

test('clientIp uses the address Cloud Run appends, not client-supplied X-Forwarded-For entries', () => {
  const { clientIp } = require('../server.js');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '1.2.3.4' }, socket: {} }), '1.2.3.4');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': 'forged-1, forged-2, 203.0.113.7' }, socket: {} }), '203.0.113.7');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '::1' } }), '::1');
});

test('/api/route rejects missing or non-numeric coordinates before calling upstreams', async () => {
  const { server } = require('../server.js');
  await new Promise(resolve => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/route`;
  try {
    for (const query of ['', '?startLat=40.19&startLng=44.51&destLat=40.17', '?startLat=1/../x&startLng=44.51&destLat=40.17&destLng=44.51', '?startLat=95&startLng=44.51&destLat=40.17&destLng=44.51']) {
      const res = await fetch(base + query);
      assert.equal(res.status, 400, query);
      assert.match((await res.json()).error, /coordinates/);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('speedLimitsForRoute matches OSM ways running along the route, not crossing or opposite one-way roads', () => {
  const os = require('node:os');
  const { speedLimitsForRoute, loadSpeedLimitIndex } = require('../server.js');
  const E = 1e5;
  const lat = 40.20;
  // route: 1 km east along lat 40.20
  const lngPerKm = 1 / (111.32 * Math.cos(lat * Math.PI / 180));
  const route = [[44.50, lat], [44.50 + lngPerKm, lat]];
  const way = (limit, oneway, pts) => [limit, oneway, ...pts.flatMap(([x, y]) => [Math.round(x * E), Math.round(y * E)])];
  const file = path.join(os.tmpdir(), `speed-limits-test-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ ways: [
    way(60, 0, [[44.50, lat], [44.50 + lngPerKm / 2, lat]]),                              // first half, two-way: 60
    way(90, 1, [[44.50 + lngPerKm / 2, lat + 0.00005], [44.50 + lngPerKm, lat + 0.00005]]), // second half, one-way eastbound ~5 m off: 90
    way(40, 1, [[44.50 + lngPerKm, lat - 0.00008], [44.50 + lngPerKm / 2, lat - 0.00008]]), // parallel one-way WESTbound: must not match
    way(20, 0, [[44.50 + lngPerKm / 4, lat - 0.01], [44.50 + lngPerKm / 4, lat + 0.01]])    // perpendicular crossing street: must not match
  ] }));
  const runs = speedLimitsForRoute(route, loadSpeedLimitIndex(file));
  fs.unlinkSync(file);
  assert.deepEqual(runs.map(r => r.limit), [60, 90]);
  assert.ok(runs[0].from <= 10 && Math.abs(runs[0].to - 500) <= 30, JSON.stringify(runs));
  assert.ok(Math.abs(runs[1].from - 500) <= 30 && runs[1].to >= 990, JSON.stringify(runs));
});

test('speedLimitsForRoute fills untagged stretches with the legal default: 60 built-up, 90 outside', () => {
  const os = require('node:os');
  const { speedLimitsForRoute, loadSpeedLimitIndex } = require('../server.js');
  const E = 1e5;
  const lat = 40.2005; // centre of grid row 200 below
  const lngPerKm = 1 / (111.32 * Math.cos(lat * Math.PI / 180));
  // route: 2 km east from 44.5; a tagged 70 road covers its first 500 m
  const route = [[44.50, lat], [44.50 + 2 * lngPerKm, lat]];
  const file = path.join(os.tmpdir(), `speed-limits-default-${process.pid}.json`);
  const firstUrbanCol = Math.floor((44.50 + lngPerKm - 44.0) / 0.001); // built-up from 1 km on
  fs.writeFileSync(file, JSON.stringify({
    legalDefaults: { urban: 60, rural: 90 },
    ways: [[70, 0, 4450000, Math.round(lat * E), Math.round((44.50 + lngPerKm / 2) * E), Math.round(lat * E)]],
    urban: { south: 40.0, west: 44.0, cellDeg: 0.001, rows: [[200, firstUrbanCol, firstUrbanCol + 5000]] }
  }));
  const runs = speedLimitsForRoute(route, loadSpeedLimitIndex(file));
  fs.unlinkSync(file);
  assert.deepEqual(runs.map(r => [r.limit, r.source]), [[70, 'osm'], [90, 'default'], [60, 'default']], JSON.stringify(runs));
  assert.ok(Math.abs(runs[1].from - 500) <= 30 && Math.abs(runs[2].from - 1000) <= 100, JSON.stringify(runs));
  assert.ok(runs[2].to >= 1990, JSON.stringify(runs));
});

test('/api/speed-limit returns the nearest road\'s OSM limit, else the legal default of the zone', async () => {
  const { server } = require('../server.js');
  await new Promise(resolve => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/speed-limit`;
  try {
    // a point on the Yerevan-Sevan highway (M-4) tagged maxspeed=90 in OSM
    const highway = await (await fetch(`${base}?lat=40.271554&lng=44.598854`)).json();
    assert.deepEqual(highway, { limit: 90, source: 'osm' });
    // no tagged road near: the legal default of the zone (the dash from the old snapshot is gone)
    const yard = await (await fetch(`${base}?lat=40.1898&lng=44.4693`)).json(); // Yerevan service road
    assert.deepEqual(yard, { limit: 60, source: 'default', zone: 'urban' });
    const fields = await (await fetch(`${base}?lat=40.0600&lng=44.6500`)).json(); // between villages
    assert.deepEqual(fields, { limit: 90, source: 'default', zone: 'rural' });
    assert.equal((await fetch(`${base}?lat=abc&lng=1`)).status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('parseYandexTrafficXml keeps the ru and en hints and never invents a score', () => {
  const xml = `<traffic region="10262"><region id="10262"><level>4</level><icon>yellow</icon><time>12:21</time>
    <hint lang="ru">Местами затруднения</hint><hint lang="en">Congested in places</hint><hint lang="tr">Yoğun</hint></region></traffic>`;
  const data = parseYandexTrafficXml(xml);
  assert.equal(data.score, 4);
  assert.equal(data.color, '#eab308');
  assert.deepEqual(data.hints, { ru: 'Местами затруднения', en: 'Congested in places' });
  assert.equal(data.hint, 'Местами затруднения');
  assert.equal(data.time, '12:21');
  // no level -> no data (it used to report level 2 "roads are free")
  assert.equal(parseYandexTrafficXml('<traffic><hint lang="ru">x</hint></traffic>'), null);
  assert.equal(parseYandexTrafficXml(''), null);
  // no hints -> nulls, not a made-up phrase
  assert.deepEqual(parseYandexTrafficXml('<level>1</level>').hints, { ru: null, en: null });
});

test('laneViaPoints keeps OSRM on the Yandex path: mid-stretch via points with the route bearing', () => {
  // 1 km east, then 1 km north; the turn (a step location) is at the corner
  const lngPerM = 1 / (111320 * Math.cos(40.18 * Math.PI / 180));
  const corner = [44.50 + 1000 * lngPerM, 40.18];
  const coords = [[44.50, 40.18], corner, [corner[0], 40.18 + 1000 / 110540]];
  const vias = laneViaPoints(coords, [{ location: coords[0] }, { location: corner }]);
  assert.deepEqual(vias[0].point, coords[0]);
  assert.deepEqual(vias[vias.length - 1].point, coords[2]);
  const middle = vias.slice(1, -1);
  assert.ok(middle.length >= 2, JSON.stringify(vias));
  const metresFromCorner = p => Math.hypot((p[0] - corner[0]) / lngPerM, (p[1] - corner[1]) * 110540);
  assert.ok(middle.every(v => metresFromCorner(v.point) > 150), 'never on the junction');
  const east = middle.filter(v => v.point[1] === 40.18);
  const north = middle.filter(v => v.point[1] > 40.18);
  assert.ok(east.length && east.every(v => Math.abs(v.bearing - 90) <= 2), JSON.stringify(east));
  assert.ok(north.length && north.every(v => v.bearing <= 2 || v.bearing >= 358), JSON.stringify(north));
});

test('extractLaneIntersections reads lanes from every leg and keeps the exit bearing', () => {
  const leg = lanes => ({ steps: [{ name: 'X', maneuver: { modifier: 'left', type: 'turn' }, intersections: [{ location: [44.5, 40.18], bearings: [0, 90, 270], out: 2, lanes }] }] });
  const lanes = [{ valid: true, indications: ['left'] }, { valid: false, indications: ['right'] }];
  const out = extractLaneIntersections({ routes: [{ legs: [leg(lanes), leg(lanes), leg(null)] }] });
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].outBearing, out[0].lanes.length, out[0].modifier], [270, 2, 'left']);
});

test('ru/en voices come from Google Cloud TTS with the right voice, cached per voice and text', async () => {
  const { synthesizeNeuralSpeech } = require('../server.js');
  const realFetch = globalThis.fetch;
  const calls = [];
  process.env.GOOGLE_TTS_ACCESS_TOKEN = 'test-token';
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers && opts.headers.Authorization });
    return { ok: true, status: 200, json: async () => ({ audioContent: Buffer.from('MP3DATA').toString('base64') }) };
  };
  try {
    const text = `Поверните налево ${Date.now()}`; // unique: no cache from other tests
    const male = await synthesizeNeuralSpeech(text, 'dmitry', 'ru');
    assert.equal(male.toString(), 'MP3DATA');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /texttospeech\.googleapis\.com\/v1\/text:synthesize/);
    assert.equal(calls[0].auth, 'Bearer test-token');
    assert.deepEqual(calls[0].body.voice, { languageCode: 'ru-RU', name: 'ru-RU-Chirp3-HD-Charon' });
    await synthesizeNeuralSpeech(text, 'dmitry', 'ru');
    assert.equal(calls.length, 1, 'second request served from the cache');
    await synthesizeNeuralSpeech(`Turn left ${Date.now()}`, 'ava', 'en');
    assert.equal(calls[1].body.voice.name, 'en-US-Chirp3-HD-Aoede');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.GOOGLE_TTS_ACCESS_TOKEN;
  }
});

test('/api/version names the running revision and is never cached', async () => {
  const { server } = require('../server.js');
  await new Promise(resolve => server.listen(0, resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/version`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const { version } = await res.json();
    assert.ok(typeof version === 'string' && version.length > 3);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('static files: compressed when accepted, ?v= immutable, others revalidated by ETag', async () => {
  const { server } = require('../server.js');
  const zlib = require('node:zlib');
  const http = require('node:http');
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  // fetch() always decompresses; read the raw bytes to see what went over the wire
  const raw = (p, headers = {}) => new Promise((resolve, reject) => {
    http.get({ port, path: p, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ res, body: Buffer.concat(chunks) })); }).on('error', reject);
  });
  try {
    const original = fs.readFileSync(path.join(ROOT, 'js/config.js'));
    const br = await raw('/js/config.js?v=1', { 'Accept-Encoding': 'gzip, br' });
    assert.equal(br.res.headers['content-encoding'], 'br');
    assert.equal(br.res.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.ok(br.body.length < original.length / 3, `${br.body.length} vs ${original.length}`);
    assert.ok(zlib.brotliDecompressSync(br.body).equals(original));
    const gz = await raw('/js/config.js?v=1', { 'Accept-Encoding': 'gzip' });
    assert.ok(zlib.gunzipSync(gz.body).equals(original));
    const plain = await raw('/js/config.js?v=1');
    assert.equal(plain.res.headers['content-encoding'], undefined);
    assert.ok(plain.body.equals(original));

    const style = await raw('/styles/mapsev-day.json', { 'Accept-Encoding': 'br' });
    assert.equal(style.res.headers['cache-control'], 'no-cache');
    const again = await raw('/styles/mapsev-day.json', { 'If-None-Match': style.res.headers.etag });
    assert.equal(again.res.statusCode, 304);
    assert.equal(again.body.length, 0);
    const png = await raw('/styles/sprites/mapsev-day.png', { 'Accept-Encoding': 'br' });
    assert.equal(png.res.headers['content-encoding'], undefined, 'images are already compressed');
    assert.equal((await raw('/server.js')).res.statusCode, 404);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
