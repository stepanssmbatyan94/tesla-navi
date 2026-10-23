// MANEUVERS — does the HUD announce the turn the road actually makes?
// Drives each trip with explicit position updates and, 120 m before every real turn
// (geometry turns >= 25°), compares the HUD modifier with the polyline's turn direction.
// Roundabouts / U-turns are counted separately (no left/right to compare).
// Yandex re-routes with live traffic, so the same trip can produce different routes per run.
// PASS: correct / turns >= 0.8 on every trip and stepsWhereHudModifierFlipped === 0.
// A mismatch right after a very short step (< 120 m) is a measurement artifact: check
// stepLengthBefore in the mismatches list before calling it a bug.
const TRIPS = [
  [40.1800, 44.4700, 40.2050, 44.5300],
  [40.2040, 44.4880, 40.1550, 44.5100]
];
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 40 && !(window.mapEngine && mapEngine.map && mapEngine.map.isStyleLoaded()); i++) await sleep(250);
const me = mapEngine;
me.voiceEnabled = false;
const origCb = me.onManeuverUpdate;
const out = [];
for (const [a, b, c, d] of TRIPS) {
  me.cancelRoute();
  me.updateCarPosition(a, b, 0, 0, true);
  if (!(await me.buildRouteTo({ name: 'Check', lat: c, lng: d }))) { out.push({ trip: [a, b, c, d], error: 'route not built' }); continue; }
  me.startNavigation();
  const steps = me.routeSteps;
  const ptAt = m => { const p = me.getPositionAtDistance(m, 0); return [p.lng, p.lat]; };
  const brg = (p, q) => me.calculateBearing(p[1], p[0], q[1], q[0]);
  let last = null;
  const perStep = {};
  me.onManeuverUpdate = m => {
    last = m;
    (perStep[me.currentStepIndex] = perStep[me.currentStepIndex] || new Set()).add(m.modifier);
  };
  window.IS_SIMULATOR_RUNNING = true;
  let pos = 0, turns = 0, correct = 0, roundaboutsOrUturns = 0;
  const mismatches = [];
  for (let k = 0; k < steps.length - 1; k++) {
    const end = steps[k].endRouteDist;
    const turn = ((brg(ptAt(end), ptAt(end + 25)) - brg(ptAt(end - 25), ptAt(end))) + 540) % 360 - 180;
    for (const target = Math.max(pos, end - 120); pos <= target; pos += 30) {
      const p = me.getPositionAtDistance(pos);
      me.updateCarPosition(p.lat, p.lng, p.heading, 40, false);
    }
    if (Math.abs(turn) < 25) continue;
    // Roundabouts and U-turns have no left/right to compare against the local angle
    if (last && /roundabout|u-?turn/.test(last.modifier)) { roundaboutsOrUturns++; continue; }
    turns++;
    const geo = turn < 0 ? 'left' : 'right';
    if (last && last.modifier.includes(geo)) correct++;
    else mismatches.push({ step: k, geometry: geo, hud: last && last.modifier, stepLengthBefore: Math.round(steps[k].distance) });
  }
  for (; pos < me.totalRouteMeters - 40 && me.activeRoute; pos += 30) {
    const p = me.getPositionAtDistance(pos);
    me.updateCarPosition(p.lat, p.lng, p.heading, 40, false);
  }
  window.IS_SIMULATOR_RUNNING = false;
  me.onManeuverUpdate = origCb;
  out.push({ turns, correct, roundaboutsOrUturns, mismatches, stepsWhereHudModifierFlipped: Object.values(perStep).filter(s => s.size > 1).length });
  cancelActiveNavigation();
}
out;
