// SPEED LIMITS — the sign must show the limit of the stretch the car is on (route attached by
// /api/route): the OpenStreetMap maxspeed (solid), or where OSM has no tag the legal default
// of the zone (60 built-up / 90 outside, dashed); without a route, the same for the nearest road.
// Drives Yerevan -> Etchmiadzin (town streets at 60 where the old street-name heuristic said 90)
// with camera zones removed, sampling the sign every 400 m.
// PASS (the returned `pass` field): the route's limits cover >= 95 % of samples and the sign
//       shows that limit and source at >= 95 % of them; free driving on a tagged road shows its
//       OSM limit, and on an untagged Yerevan service road the urban default 60 (no dash).
// Usage: paste into a browser-tool JS console (returns a promise) or run `npm run verify`.
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 60 && !(window.mapEngine && mapEngine.map && mapEngine.map.isStyleLoaded()); i++) await sleep(250);
  const me = mapEngine;
  me.voiceEnabled = false;
  const el = document.getElementById('speed-limit-val');
  const sign = () => ({ text: el.textContent, source: currentSpeedLimitSource, dashed: el.classList.contains('speed-limit-estimated') });

  me.updateCarPosition(40.1776, 44.5126, 0, 0, true);
  await startNavigationTo({ name: 'Etchmiadzin', lat: 40.1656, lng: 44.2936 });
  if (!me.routeSteps.length) return { pass: false, error: 'route not built' };
  document.getElementById('btn-start-route-nav').click();
  await sleep(200);
  me.routeCameras = []; // compare road limits only
  const runs = me.routeSpeedLimits;
  window.IS_SIMULATOR_RUNNING = true;
  let pos = 0, samples = 0, covered = 0, matched = 0, defaults = 0;
  const mismatches = [];
  for (let target = 400; target < me.totalRouteMeters - 100; target += 400) {
    for (; pos <= target; pos += 20) { const p = me.getPositionAtDistance(pos); me.updateCarPosition(p.lat, p.lng, p.heading, 40, true); }
    samples++;
    const run = runs.find(r => target >= r.from + 20 && target <= r.to - 20); // away from run edges
    if (!run) continue;
    covered++;
    if (run.source === 'default') defaults++;
    const s = sign();
    const source = run.source === 'default' ? 'default' : 'osm';
    if (Number(s.text) === run.limit && s.source === source && s.dashed === (source === 'default')) matched++;
    else mismatches.push({ km: (target / 1000).toFixed(1), osm: run.limit, shown: s });
  }
  window.IS_SIMULATOR_RUNNING = false;
  // a real road point for the free-driving check, taken before the route is dropped
  const longRun = runs.filter(r => r.source !== 'default').sort((a, b) => (b.to - b.from) - (a.to - a.from))[0];
  const freePoint = longRun ? me.getPositionAtDistance((longRun.from + longRun.to) / 2) : null;
  cancelActiveNavigation();
  const afterCancel = sign();

  let freeDriving = null;
  if (freePoint) {
    me._freeLimitQuery = null;
    me.updateCarPosition(freePoint.lat, freePoint.lng, 0, 50, true);
    for (let i = 0; i < 20 && currentSpeedLimitSource !== 'osm'; i++) await sleep(150);
    freeDriving = { expected: longRun.limit, ...sign() };
  }
  // the spot from the owner's screenshot: a service road by Yerevan City (no maxspeed in OSM)
  me._freeLimitQuery = null;
  me.updateCarPosition(40.1898, 44.4693, 0, 0, true);
  for (let i = 0; i < 20 && currentSpeedLimitSource !== 'default'; i++) await sleep(150);
  const yerevanYard = sign();
  localStorage.removeItem('tesla_search_history');
  return {
    pass: samples > 0 && covered / samples >= 0.95 && matched / covered >= 0.95 &&
      afterCancel.text === '—' && !!freeDriving && Number(freeDriving.text) === freeDriving.expected && freeDriving.source === 'osm' &&
      yerevanYard.text === '60' && yerevanYard.source === 'default',
    samples, covered, legalDefaultSamples: defaults, signMatches: matched, mismatches: mismatches.slice(0, 4), afterCancel, freeDriving, yerevanYard
  };
})();
