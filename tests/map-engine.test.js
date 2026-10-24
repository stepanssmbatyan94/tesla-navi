const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserContext, loadScripts, get } = require('./helpers/browser-context');

// A straight 1 km route heading east along lat 40.18, one point every 100 m
const LAT = 40.18;
const LNG0 = 44.50;
const LNG_PER_100M = 100 / (111320 * Math.cos(LAT * Math.PI / 180));
const COORDS = Array.from({ length: 11 }, (_, i) => [LNG0 + i * LNG_PER_100M, LAT]);
const at = meters => ({ lat: LAT, lng: LNG0 + (meters / 100) * LNG_PER_100M });
const DEST = { name: 'Destination', lat: LAT, lng: LNG0 + 10 * LNG_PER_100M };

function routeData(extra = {}) {
  return {
    success: true,
    source: 'yandex',
    routes: [{
      coordinates: COORDS,
      distance: 1000,
      duration: 600,
      durationWithoutTraffic: 300,
      segments: [{ type: 'FREE', color: '#82ea0d', coords: COORDS }],
      steps: [
        { modifier: 'straight', name: 'Start St', distance: 300, speedLimit: 60 },
        { modifier: 'left', name: 'A St', distance: 400, speedLimit: 60 },
        { modifier: 'right', name: 'B St', distance: 300, speedLimit: 60 }
      ],
      laneIntersections: [],
      ...extra
    }]
  };
}

function newEngine() {
  const ctx = loadScripts(createBrowserContext(), ['js/config.js', 'js/maps/map-engine.js']);
  ctx.CURRENT_LANG = 'en';
  const TeslaMapEngine = get(ctx, 'TeslaMapEngine');
  const maneuvers = [];
  const spoken = [];
  const engine = new TeslaMapEngine('map', {
    provider: 'test',
    center: { lat: LAT, lng: LNG0 },
    onManeuverUpdate: m => maneuvers.push(m)
  });
  engine.speakVoice = text => spoken.push(text);
  engine.playNavChime = () => {};
  return { ctx, engine, maneuvers, spoken };
}

function driveTo(engine, meters) {
  const p = at(meters);
  engine.updateCarPosition(p.lat, p.lng, 90, 40, true);
}

test('formatNavDistance / formatNavDuration round and localise', () => {
  const { ctx, engine } = newEngine();
  ctx.CURRENT_LANG = 'ru';
  assert.equal(engine.formatNavDistance(12), '12 м');
  assert.equal(engine.formatNavDistance(287), '290 м');
  assert.equal(engine.formatNavDistance(1260), '1.3 км');
  assert.equal(engine.formatNavDistance(25400), '25 км');
  ctx.CURRENT_LANG = 'en';
  assert.equal(engine.formatNavDistance(640), '650 m');
  assert.equal(engine.formatNavDuration(171, true), '2 h 51 min');
  assert.equal(engine.formatNavDuration(90), '2 min');
});

test('formatStepInstruction builds the localised maneuver text', () => {
  const { ctx, engine } = newEngine();
  assert.equal(engine.formatStepInstruction('left', 'A St'), 'Turn left onto A St');
  assert.equal(engine.formatStepInstruction('slight right', ''), 'Keep right');
  assert.equal(engine.formatStepInstruction('u-turn', 'X'), 'Make a U-turn');
  ctx.CURRENT_LANG = 'ru';
  assert.equal(engine.formatStepInstruction('right', 'Абовяна'), 'Поверните направо на Абовяна');
});

test('HUD announces the NEXT step: the turn at the end of step k is steps[k+1]', () => {
  const { engine, maneuvers } = newEngine();
  engine.applyRouteData(routeData(), DEST, 0);
  // The last step ends at the polyline's measured length (~1000 m by haversine)
  const ends = engine.routeSteps.map(s => s.endRouteDist);
  [300, 700, 1000].forEach((expected, i) => assert.ok(Math.abs(ends[i] - expected) < 5, `step ${i} ends at ${ends[i]}`));
  engine.isNavigating = true;
  driveTo(engine, 150); // first real fix only snaps the camera
  driveTo(engine, 200);
  let m = maneuvers.at(-1);
  assert.equal(m.modifier, 'left', 'on Start St the upcoming turn is the left onto A St');
  assert.equal(m.street, 'A St');
  assert.ok(Math.abs(m.distanceMeters - 100) <= 5);

  // right at the junction (10 m before) the HUD must still show THIS turn
  driveTo(engine, 290);
  m = maneuvers.at(-1);
  assert.equal(m.modifier, 'left', '10 m before the junction the sign is still the left turn');
  assert.ok(m.distanceMeters <= 15);

  // just past the junction it switches to the next maneuver
  driveTo(engine, 320);
  assert.equal(maneuvers.at(-1).modifier, 'right');

  driveTo(engine, 500);
  m = maneuvers.at(-1);
  assert.equal(m.modifier, 'right');
  assert.equal(m.street, 'B St');

  driveTo(engine, 850);
  m = maneuvers.at(-1);
  assert.equal(m.type, 'arrive', 'last step ends at the destination, not at a turn');
  assert.equal(m.street, 'Destination');
});

test('route preview stays silent: no HUD updates, prompts or arrival before "Go"', () => {
  const { engine, maneuvers, spoken } = newEngine();
  let arrived = false;
  engine.onArrival = () => { arrived = true; };
  engine.applyRouteData(routeData(), DEST, 0);
  engine.isNavigating = false;
  for (let d = 100; d <= 1000; d += 50) driveTo(engine, d);
  assert.equal(maneuvers.length, 0);
  assert.equal(spoken.length, 0);
  assert.equal(arrived, false);
});

test('voice prompts name the upcoming maneuver', () => {
  const { engine, spoken } = newEngine();
  engine.voiceEnabled = true;
  engine.applyRouteData(routeData(), DEST, 0);
  engine.isNavigating = true;
  driveTo(engine, 10);
  driveTo(engine, 20);   // 280 m before the left turn -> "in 300 m" prompt
  driveTo(engine, 250);  // 50 m before -> immediate prompt
  assert.equal(spoken[0], 'In 300 meters turn left onto A St');
  assert.equal(spoken[1], 'Turn left');
});

test('OSRM lane junctions are kept only on the route and in the same direction', () => {
  const { engine } = newEngine();
  const p300 = at(300);
  const lanes = [{ valid: true, indications: ['left'] }];
  engine.applyRouteData(routeData({
    laneIntersections: [
      { location: [p300.lng, p300.lat], outBearing: 90, lanes, modifier: 'left' },          // on route, same direction
      { location: [p300.lng, p300.lat], outBearing: 0, lanes, modifier: 'left' },           // on route, OSRM turns north
      { location: [p300.lng, p300.lat + 0.001], outBearing: 90, lanes, modifier: 'left' }   // ~110 m off the route
    ]
  }), DEST, 0);
  assert.equal(engine.laneIntersections.length, 1);
  assert.equal(engine.laneIntersections[0].outBearing, 90);
  assert.ok(Math.abs(engine.laneIntersections[0].routeDist - 300) < 5);
});

test('speed limit: a route camera ahead is verified, otherwise the step limit is an estimate', () => {
  const { engine, maneuvers } = newEngine();
  engine.applyRouteData(routeData(), DEST, 0);
  engine.routeCameras = [{ type: 'camera', limit: 40, routeDist: 550 }];
  engine.isNavigating = true;
  driveTo(engine, 100);
  driveTo(engine, 150);
  assert.equal(maneuvers.at(-1).speedLimitSource, 'estimated');
  assert.equal(maneuvers.at(-1).speedLimit, 60);
  driveTo(engine, 400);
  assert.equal(maneuvers.at(-1).speedLimitSource, 'camera');
  assert.equal(maneuvers.at(-1).speedLimit, 40);
});

test('speed limit priority: camera ahead > OpenStreetMap road limit > street-name estimate', () => {
  const { engine, maneuvers } = newEngine();
  engine.applyRouteData(routeData({ speedLimits: [{ from: 0, to: 400, limit: 40 }, { from: 400, to: 1000, limit: 90 }] }), DEST, 0);
  engine.isNavigating = true;
  driveTo(engine, 100);
  driveTo(engine, 150);
  assert.deepEqual([maneuvers.at(-1).speedLimit, maneuvers.at(-1).speedLimitSource], [40, 'osm']);
  driveTo(engine, 600);
  assert.deepEqual([maneuvers.at(-1).speedLimit, maneuvers.at(-1).speedLimitSource], [90, 'osm']);
  engine.routeCameras = [{ type: 'camera', limit: 60, routeDist: 750 }];
  driveTo(engine, 650);
  assert.deepEqual([maneuvers.at(-1).speedLimit, maneuvers.at(-1).speedLimitSource], [60, 'camera']);
  engine.routeCameras = [];
  engine.routeSpeedLimits = [{ from: 0, to: 1000, limit: 60, source: 'default' }];
  driveTo(engine, 680);
  assert.deepEqual([maneuvers.at(-1).speedLimit, maneuvers.at(-1).speedLimitSource], [60, 'default']);
  engine.routeSpeedLimits = [];
  driveTo(engine, 700);
  assert.equal(maneuvers.at(-1).speedLimitSource, 'estimated');
});

test('routes without traffic data get one neutral segment, never an invented jam', () => {
  const { engine } = newEngine();
  const segs = engine.generateTrafficSegments(COORDS);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].color, '#3b82f6');
});

test('speed-camera marker tooltip follows the UI language and never invents a limit', () => {
  const ctx = loadScripts(createBrowserContext(), ['js/config.js', 'js/maps/map-engine.js']);
  const title = get(ctx, 'speedCameraTitle');
  ctx.CURRENT_LANG = 'hy';
  assert.equal(title(60), 'Արագության վերահսկման տեսախցիկ 60 կմ/ժ');
  ctx.CURRENT_LANG = 'en';
  assert.equal(title(90), 'Speed camera 90 km/h');
  assert.equal(title(''), 'Speed camera');
  ctx.CURRENT_LANG = 'ru';
  assert.equal(title(60), 'Камера контроля скорости 60 км/ч');
});

test('the very first GPS fix already looks up the free-driving speed limit', async () => {
  const { ctx, engine } = newEngine();
  const requests = [];
  const limits = [];
  ctx.fetch = async url => { requests.push(url); return { ok: true, json: async () => ({ limit: 60, source: 'default', zone: 'urban' }) }; };
  engine.onSpeedLimit = l => limits.push(l);
  engine.updateCarPosition(40.1898, 44.4693, 90, 0, true); // first real fix
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.match(requests[0], /^\/api\/speed-limit\?lat=40\.189800&lng=44\.469300$/);
  assert.deepEqual(JSON.parse(JSON.stringify(limits)), [{ limit: 60, source: 'default' }]); // vm-realm objects
});

test('cancelling the route looks the free-driving limit up again without moving', async () => {
  const { ctx, engine } = newEngine();
  const requests = [];
  ctx.fetch = async url => { requests.push(url); return { ok: true, json: async () => ({ limit: 60, source: 'osm' }) }; };
  engine.updateCarPosition(LAT, LNG0, 90, 0, true); // first fix: one lookup
  await new Promise(resolve => setImmediate(resolve));
  engine.applyRouteData(routeData(), DEST, 0);
  engine.isNavigating = true;
  engine.cancelRoute(); // same spot, well within 80 m of the last lookup
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
});

test('a fix that arrives during a lookup is looked up right after it, not dropped', async () => {
  const { ctx, engine } = newEngine();
  const requests = [];
  let release;
  ctx.fetch = url => { requests.push(url); return new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ limit: 60, source: 'osm' }) }); }); };
  engine.updateCarPosition(LAT, LNG0, 90, 0, true); // first fix: lookup #1 in flight
  engine._freeLimitQuery = { ...engine._freeLimitQuery, at: 0 }; // pretend the interval has passed
  const far = at(500);
  engine.updateCarPosition(far.lat, far.lng, 90, 0, true); // the car parks 500 m on, no more fixes
  assert.equal(requests.length, 1);
  release();
  await new Promise(resolve => setTimeout(resolve, 700)); // busy retry after 500 ms
  assert.equal(requests.length, 2);
  assert.match(requests[1], new RegExp(`lat=${far.lat.toFixed(6)}`));
  release();
});

test('roundabouts: exit number in text and voice (never "continue straight"), one prompt per roundabout', () => {
  const { ctx, engine, maneuvers, spoken } = newEngine();
  ctx.CURRENT_LANG = 'ru';
  assert.equal(engine.getTurnSpeech('roundabout', 2), 'На круговом движении 2-й съезд');
  assert.equal(engine.getTurnSpeech('roundabout', null), 'Круговое движение');
  ctx.CURRENT_LANG = 'hy';
  assert.equal(engine.getTurnSpeech('roundabout', 1), 'Շրջանաձև երթևեկությունում դուրս եկեք առաջին ելքով');
  ctx.CURRENT_LANG = 'en';
  assert.equal(engine.formatStepInstruction('roundabout', 'Tigran Mets Avenue', 3), 'At the roundabout, take exit 3 onto Tigran Mets Avenue');

  // straight 400 m, roundabout (ENTER 30 m on the ring + LEAVE 3rd exit), then on
  engine.applyRouteData(routeData({ steps: [
    { name: 'Start Street', modifier: 'straight', action: 'STRAIGHT', distance: 400, location: [COORDS[0][0], LAT] },
    { name: 'Ring', modifier: 'roundabout', type: 'roundabout', action: 'ENTER_ROUNDABOUT', exit: 3, exitStreet: 'Exit Avenue', distance: 30, location: [at(400).lng, LAT] },
    { name: 'Exit Avenue', modifier: 'roundabout', type: 'roundabout', action: 'LEAVE_ROUNDABOUT', exit: 3, distance: 570, location: [at(430).lng, LAT] }
  ] }), DEST, 0);
  engine.isNavigating = true;
  engine.voiceEnabled = true;
  for (let m = 0; m <= 440; m += 10) driveTo(engine, m);
  const approaching = maneuvers.find(x => x.distanceMeters > 100 && x.distanceMeters < 300);
  assert.deepEqual([approaching.modifier, approaching.exit, approaching.street], ['roundabout', 3, 'Exit Avenue']);
  const roundaboutPrompts = spoken.filter(t => /roundabout|exit 3/i.test(t));
  assert.ok(roundaboutPrompts.length >= 1 && roundaboutPrompts.every(t => /exit 3/.test(t)), JSON.stringify(spoken));
  assert.ok(!spoken.some(t => /straight/i.test(t)), JSON.stringify(spoken));
  assert.equal(spoken.filter(t => /^At the roundabout, take exit 3$/.test(t)).length, 1, 'no second prompt on the ring');
});

test('the 300 m prompt names only a real street, never the destination for an unnamed one', () => {
  const { ctx, engine, spoken } = newEngine();
  ctx.CURRENT_LANG = 'ru';
  engine.applyRouteData(routeData({ steps: [
    { name: 'Start Street', modifier: 'straight', action: 'STRAIGHT', distance: 400, location: [COORDS[0][0], LAT] },
    { name: '', modifier: 'left', action: 'LEFT', distance: 300, location: [at(400).lng, LAT] },
    { name: 'Named Avenue', modifier: 'right', action: 'RIGHT', distance: 300, location: [at(700).lng, LAT] }
  ] }), DEST, 0);
  engine.isNavigating = true;
  engine.voiceEnabled = true;
  for (let m = 0; m <= 650; m += 10) driveTo(engine, m);
  const far = spoken.filter(t => /^Через 300 метров/.test(t));
  assert.deepEqual(far, ['Через 300 метров поверните налево', 'Через 300 метров поверните направо на Named Avenue'], JSON.stringify(spoken));
});

test('lanes: every lane the movement fits is highlighted, the maneuver junction wins from 300 m', () => {
  const { ctx, engine, maneuvers } = newEngine();
  const highlight = get(ctx, 'highlightLanesForTurn');
  const lanes = inds => inds.map(i => ({ indications: i.split(';'), valid: true }));
  const active = ls => JSON.parse(JSON.stringify(ls)).map(l => (l.valid ? 1 : 0)).join('');
  // owner's photo 1: OSRM marked all four lanes; going left only the left lane fits
  const four = lanes(['left', 'straight', 'straight', 'straight;right']);
  assert.equal(active(highlight(four, 'left')), '1000');
  assert.equal(active(highlight(four, 'straight')), '0111');
  // owner's photo 2: OSRM marked only the middle lane; the left one goes straight too
  assert.equal(active(highlight([{ indications: ['straight'], valid: false }, { indications: ['straight'], valid: true }, { indications: ['right'], valid: false }], 'straight')), '110');
  // no exact arrow: near ones; roundabouts keep OSRM's choice
  assert.equal(active(highlight(lanes(['slight left', 'straight']), 'left')), '10');
  assert.equal(active(highlight([{ indications: ['straight'], valid: false }, { indications: ['right'], valid: true }], 'roundabout')), '01');

  // pass-through junction at 100 m, the left turn's junction at 400 m (maneuver point)
  engine.applyRouteData(routeData({ steps: [
    { name: 'Start Street', modifier: 'straight', action: 'STRAIGHT', distance: 400, location: [COORDS[0][0], LAT] },
    { name: 'Griboyedov Street', modifier: 'left', action: 'LEFT', distance: 600, location: [at(400).lng, LAT] }
  ], laneIntersections: [
    { location: [at(100).lng, LAT], outBearing: 90, lanes: lanes(['left', 'straight', 'straight', 'straight;right']) },
    { location: [at(390).lng, LAT], outBearing: 90, lanes: lanes(['left', 'left', 'straight', 'right']) }
  ] }), DEST, 0);
  engine.isNavigating = true;
  driveTo(engine, 0); driveTo(engine, 20);
  let m = maneuvers.at(-1);
  assert.equal(active(m.lanes), '0111', 'at 80 m before the pass-through junction: its straight lanes');
  for (let x = 30; x <= 160; x += 10) driveTo(engine, x);
  m = maneuvers.at(-1);
  assert.equal(active(m.lanes), '1100', 'within 300 m of the left turn: its left lanes');
  assert.ok(Math.abs(m.laneDistanceMeters - 230) <= 15, String(m.laneDistanceMeters));
});

test('lanes: a fork without its own arrows and a junction node past the maneuver point', () => {
  const { ctx, engine, maneuvers } = newEngine();
  const highlight = get(ctx, 'highlightLanesForTurn');
  const lanes = inds => inds.map(i => ({ indications: i.split(';'), valid: true }));
  const active = ls => JSON.parse(JSON.stringify(ls)).map(l => (l.valid ? 1 : 0)).join('');
  // Myasnikyan fork: keep left, lanes only say straight; the lane that also bears right is not it
  assert.equal(active(highlight(lanes(['straight', 'straight', 'straight;slight right']), 'slight left')), '110');
  assert.equal(active(highlight(lanes(['straight;slight left', 'straight', 'straight']), 'slight right')), '011');

  // right turn whose OSM junction node is 18 m past Yandex's maneuver point
  engine.applyRouteData(routeData({ steps: [
    { name: 'Start Street', modifier: 'straight', action: 'STRAIGHT', distance: 400, location: [COORDS[0][0], LAT] },
    { name: 'Right Street', modifier: 'right', action: 'RIGHT', distance: 600, location: [at(400).lng, LAT] }
  ], laneIntersections: [{ location: [at(418).lng, LAT], outBearing: 90, lanes: lanes(['straight', 'right', 'right']) }] }), DEST, 0);
  engine.isNavigating = true;
  for (let x = 0; x <= 300; x += 10) driveTo(engine, x);
  assert.equal(active(maneuvers.at(-1).lanes), '011', 'the turn\'s own lanes, not straight');
});

test('lanes: unmarked lanes are the straight ones when no lane says straight', () => {
  const { ctx } = newEngine();
  const highlight = get(ctx, 'highlightLanesForTurn');
  const lanes = inds => inds.map(i => ({ indications: i.split(';'), valid: true }));
  const active = ls => JSON.parse(JSON.stringify(ls)).map(l => (l.valid ? 1 : 0)).join('');
  assert.equal(active(highlight(lanes(['none', 'none', 'none', 'slight right']), 'straight')), '1110');
  assert.equal(active(highlight(lanes(['slight left', 'slight right']), 'straight')), '11');
});

test('live traffic: a fresh Yandex route along the same way recolors the rest and updates the time', async () => {
  const { ctx, engine } = newEngine();
  const progress = [];
  const updates = [];
  engine.onProgressUpdate = p => progress.push(p);
  engine.onTrafficUpdate = s => updates.push(s);
  engine.applyRouteData(routeData(), DEST, 0);
  engine.isNavigating = true;
  for (let m = 0; m <= 300; m += 20) driveTo(engine, m);

  // Yandex from the car (300 m): same street, now a jam on it, 15 min left
  const RED = '#ff4533';
  ctx.fetch = async () => ({ json: async () => ({ success: true, source: 'yandex', routes: [
    { coordinates: [[at(300).lng, LAT], ...COORDS.slice(4)], duration: 900, segments: [{ color: RED, coords: [[at(300).lng, LAT], ...COORDS.slice(4)] }] }
  ] }) });
  assert.equal(await engine.refreshRouteTraffic(), true);
  const colors = JSON.parse(JSON.stringify(engine.trafficSegments)).map(s => [s.color, s.coords.length]);
  assert.equal(colors[0][0], '#82ea0d', 'the driven part keeps its colour');
  assert.equal(colors[colors.length - 1][0], RED, 'the rest shows the fresh jam');
  assert.equal(updates.length, 1);
  driveTo(engine, 400); driveTo(engine, 420);
  const left = progress.filter(p => typeof p === 'object').at(-1);
  // 15 min for the 700 m left at refresh time, scaled to ~580 m: ~12-13 min (was 600 s * 0.58 = 6 min)
  assert.match(left.remainingDuration, /1[23]/, left.remainingDuration);

  // Yandex now prefers another way: nothing changes
  ctx.fetch = async () => ({ json: async () => ({ success: true, source: 'yandex', routes: [
    { coordinates: [[44.60, 40.25], [44.61, 40.26]], duration: 300, segments: [{ color: '#82ea0d', coords: [[44.60, 40.25], [44.61, 40.26]] }] }
  ] }) });
  const before = JSON.stringify(engine.trafficSegments);
  assert.equal(await engine.refreshRouteTraffic(), false);
  assert.equal(JSON.stringify(engine.trafficSegments), before);
});

test('traffic segments of one color are joined: fewer bar divs, features and polylines', () => {
  const { ctx } = newEngine();
  const merge = get(ctx, 'mergeTrafficSegments');
  const G = '#82ea0d', Y = '#fbd42e';
  const segs = [
    { type: 'FREE', color: G, coords: [[0, 0], [1, 0]] },
    { type: 'FREE', color: G, coords: [[1, 0], [2, 0]] },
    { type: 'LIGHT', color: Y, coords: [[2, 0], [3, 0]] },
    { type: 'FREE', color: G, coords: [[3, 0], [4, 0], [5, 0]] }
  ];
  const out = JSON.parse(JSON.stringify(merge(segs)));
  assert.deepEqual(out.map(s => [s.color, s.coords.length]), [[G, 3], [Y, 2], [G, 3]]);
  assert.deepEqual(out[0].coords, [[0, 0], [1, 0], [2, 0]], 'the shared vertex is kept once');
  assert.equal(segs[0].coords.length, 2, 'input untouched');
});

test('network polls skip ticks while the page is hidden and catch up once visible', async () => {
  const listeners = {};
  let hidden = false;
  const doc = {
    readyState: 'complete', head: {}, body: {},
    get hidden() { return hidden; },
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter(f => f !== fn); },
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} })
  };
  const ctx = loadScripts(createBrowserContext({ document: doc }), ['js/config.js', 'js/maps/map-engine.js']);
  const setVisibleInterval = get(ctx, 'setVisibleInterval');
  const clearVisibleInterval = get(ctx, 'clearVisibleInterval');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let calls = 0;
  const id = setVisibleInterval(() => calls++, 20);
  await sleep(70);
  const visibleCalls = calls;
  assert.ok(visibleCalls >= 2, String(visibleCalls));
  hidden = true;
  await sleep(80);
  assert.equal(calls, visibleCalls, 'no polls while hidden');
  hidden = false;
  listeners.visibilitychange.forEach(fn => fn());
  assert.equal(calls, visibleCalls + 1, 'one catch-up poll on becoming visible');
  clearVisibleInterval(id);
  assert.equal(listeners.visibilitychange.length, 0, 'the listener goes with the interval');
  const after = calls;
  await sleep(60);
  assert.equal(calls, after);
});

test('a reroute while driving takes the fastest route at once, never offers a choice', async () => {
  const { ctx, engine } = newEngine();
  const offered = [];
  const rerouted = [];
  engine.onRouteCalculated = r => offered.push(r);
  engine.onRerouted = r => rerouted.push(r);
  engine.playNavChime = () => {};
  engine.applyRouteData(routeData(), DEST, 1 - 1);
  engine.isNavigating = true;
  // Yandex answers with two routes, fastest first (the server sorts by duration with traffic)
  const fast = routeData().routes[0];
  const slow = { ...routeData().routes[0], duration: 1500 };
  ctx.fetch = async () => ({ json: async () => ({ success: true, source: 'yandex', routes: [{ ...fast, duration: 500 }, slow] }) });
  await engine.recalculateRoute(LAT + 0.002, LNG0);
  assert.equal(offered.length, 0, 'no route options mid-drive');
  assert.equal(rerouted.length, 1);
  assert.equal(engine.activeRouteIndex, 0, 'the fastest route');
  assert.equal(engine.isNavigating, true);
  assert.equal(engine.activeRoute.durationSec, 500);
});
