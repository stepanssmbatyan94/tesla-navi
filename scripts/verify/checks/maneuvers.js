// MANEUVERS — does the driver see the right sign while approaching every real turn?
// Drives each trip and, at 250 / 120 / 50 / 15 / 5 m before every real turn (geometry
// turn >= 25°), reads the HUD arrow icon and street from the DOM; 25 m past the junction
// the HUD must already show the following maneuver.
// Roundabouts / U-turns are counted separately (no left/right to compare); a roundabout must
// show its exit number inside the ring icon and the street after the exit. The lane pill is
// shown only with real OSM lane data for the junction ahead, with exactly those lanes.
// Yandex re-routes with live traffic, so the same trip can produce different routes per run.
// PASS (the returned `pass` field): on every trip >= 80 % of turns show the right icon and
//       street at ALL sampled distances, and >= 90 % of after-junction checks show the next step.
// Usage: paste into a browser-tool JS console (returns a promise) or run `npm run verify`.
(async () => {
  const TRIPS = [
    [40.1800, 44.4700, 40.2050, 44.5300],
    [40.2040, 44.4880, 40.1550, 44.5100]
  ];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 40 && !(window.mapEngine && mapEngine.map && mapEngine.map.isStyleLoaded()); i++) await sleep(250);
  const me = mapEngine;
  me.voiceEnabled = false;
  // Which arrow the HUD draws (SVG paths from updateManeuverHud)
  const icon = () => {
    const h = document.getElementById('maneuver-arrow-box').innerHTML;
    if (h.includes('circle cx="12" cy="12" r="7"')) return 'roundabout';
    if (h.includes('M18 19v-9a6 6')) return 'uturn';
    if (h.includes('M16 19l-4-9-5-5')) return 'slight-left';
    if (h.includes('M8 19l4-9 5-5')) return 'slight-right';
    if (h.includes('M18 19V11a4 4 0 0 0-4-4H5')) return 'left';
    if (h.includes('M6 19V11a4 4 0 0 1 4-4h9')) return 'right';
    if (h.includes('x1="12" y1="20"')) return 'straight';
    return '?';
  };
  const hud = () => {
    const exitText = document.querySelector('#maneuver-arrow-box svg text');
    const pill = document.getElementById('lane-guidance-pill');
    const lanesShown = pill.classList.contains('hidden') ? 0 : pill.querySelectorAll('.lane-col-item').length;
    const data = lastManeuver && Array.isArray(lastManeuver.lanes) && lastManeuver.laneDistanceMeters <= 300 ? lastManeuver.lanes.length : 0;
    if (lanesShown !== data) laneMismatches.push({ lanesShown, data });
    if (lanesShown) laneSamples++;
    return { icon: icon(), exit: exitText ? Number(exitText.textContent) : null, dist: document.getElementById('maneuver-dist').textContent, street: document.getElementById('maneuver-street').textContent };
  };
  let lastManeuver = null, laneSamples = 0;
  const laneMismatches = [];
  const origManeuverCb = me.onManeuverUpdate;
  me.onManeuverUpdate = m => { lastManeuver = m; origManeuverCb(m); };
  const out = [];
  for (const [a, b, c, d] of TRIPS) {
    cancelActiveNavigation();
    me.updateCarPosition(a, b, 0, 0, true);
    await startNavigationTo({ name: 'Check', lat: c, lng: d });
    if (!me.routeSteps.length) { out.push({ trip: [a, b, c, d], error: 'route not built' }); continue; }
    document.getElementById('btn-start-route-nav').click();
    await sleep(300);
    const steps = me.routeSteps;
    const ptAt = m => { const p = me.getPositionAtDistance(m, 0); return [p.lng, p.lat]; };
    const brg = (p, q) => me.calculateBearing(p[1], p[0], q[1], q[0]);
    window.IS_SIMULATOR_RUNNING = true;
    let pos = 0;
    const driveTo = target => { for (; pos <= target; pos += 5) { const p = me.getPositionAtDistance(pos); me.updateCarPosition(p.lat, p.lng, p.heading, 40, true); } };
    let turns = 0, correct = 0, roundaboutsOrUturns = 0, roundaboutChecks = 0, roundaboutOk = 0, afterChecks = 0, afterOk = 0;
    const mismatches = [];
    for (let k = 0; k < steps.length - 1; k++) {
      const end = steps[k].endRouteDist;
      const turn = ((brg(ptAt(end), ptAt(end + 25)) - brg(ptAt(end - 25), ptAt(end))) + 540) % 360 - 180;
      const prevEnd = k > 0 ? steps[k - 1].endRouteDist : 0;
      const samples = [];
      for (const before of [250, 120, 50, 15, 5]) {
        if (end - before <= prevEnd + 10 || end - before < pos) continue; // still at the previous junction
        driveTo(end - before);
        samples.push({ before, ...hud() });
      }
      if (Math.abs(turn) >= 25 && samples.length) {
        if (/roundabout|u-?turn/.test(steps[k + 1].modifier)) {
          roundaboutsOrUturns++;
        } else {
          turns++;
          const geo = turn < 0 ? 'left' : 'right';
          const expectStreet = steps[k + 1].name || 'Check';
          const wrong = samples.filter(s => !s.icon.includes(geo) || s.street !== expectStreet);
          if (!wrong.length) correct++;
          else mismatches.push({ step: k, geometry: geo, expectStreet, wrong });
        }
      }
      const next = steps[k + 1];
      if (/roundabout/.test(next.modifier) && next.exit && samples.length) {
        roundaboutChecks++;
        const want = next.exitStreet || next.name || 'Check';
        const wrong = samples.filter(s => s.icon !== 'roundabout' || s.exit !== next.exit || s.street !== want);
        if (!wrong.length) roundaboutOk++;
        else mismatches.push({ step: k, roundabout: true, exit: next.exit, expectStreet: want, wrong });
      }
      if (k + 2 < steps.length && steps[k + 1].distance > 60) {
        driveTo(end + 25);
        afterChecks++;
        const h = hud();
        const expectAfter = steps[k + 2].exitStreet || steps[k + 2].name || 'Check'; // a roundabout shows the street after its exit
        if (h.street === expectAfter) afterOk++;
        else mismatches.push({ step: k, afterJunction: true, shown: h, expectStreet: expectAfter });
      }
    }
    window.IS_SIMULATOR_RUNNING = false;
    out.push({ turns, correct, roundaboutsOrUturns, roundaboutExits: `${roundaboutOk}/${roundaboutChecks}`, roundaboutOk, roundaboutChecks, afterJunction: `${afterOk}/${afterChecks}`, afterOk, afterChecks, mismatches: mismatches.slice(0, 4) });
    cancelActiveNavigation();
  }
  me.onManeuverUpdate = origManeuverCb;
  localStorage.removeItem('tesla_search_history');
  return {
    pass: out.every(t => !t.error && (t.turns === 0 || t.correct / t.turns >= 0.8) && (t.afterChecks === 0 || t.afterOk / t.afterChecks >= 0.9) && t.roundaboutOk === t.roundaboutChecks) &&
      out.some(t => t.roundaboutChecks > 0) && laneMismatches.length === 0 && laneSamples > 0,
    lanes: { samplesWithLanes: laneSamples, mismatches: laneMismatches.slice(0, 4) },
    trips: out
  };
})();
