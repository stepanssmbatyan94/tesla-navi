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
