// YANDEX — run on /?provider=yandex. The Yandex Maps JS provider loads on demand, builds and
// draws a route, drives to arrival and cleans up.
// PASS (the returned `pass` field): provider === 'yandex', route built, maneuvers seen,
//       arrived, geo objects back to the car marker only, no page errors.
// Usage: paste into a browser-tool JS console (returns a promise) or run `npm run verify`.
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const errs = [];
  window.addEventListener('error', e => errs.push(e.message));
  window.addEventListener('unhandledrejection', e => errs.push(String(e.reason)));
  for (let i = 0; i < 80 && !(window.mapEngine && mapEngine.map && mapEngine.map.geoObjects); i++) await sleep(250);
  const me = window.mapEngine;
  if (!me || !me.map || !me.map.geoObjects) return { pass: false, error: 'Yandex map not initialised', provider: me && me.provider };
  me.voiceEnabled = false;
  const geoCount = () => { let n = 0; me.map.geoObjects.each(() => n++); return n; };
  const atStart = geoCount();
  me.updateCarPosition(40.1915, 44.5150, 0, 0, true);
  const routeBuilt = !!(await me.buildRouteTo({ name: 'Check', lat: 40.1776, lng: 44.5125 }));
  const withRoute = geoCount();
  me.startNavigation();
  const maneuvers = [];
  const origCb = me.onManeuverUpdate;
  me.onManeuverUpdate = m => { if (maneuvers[maneuvers.length - 1] !== m.modifier) maneuvers.push(m.modifier); origCb(m); };
  let arrived = false;
  const origArr = me.onArrival;
  me.onArrival = d => { arrived = true; origArr(d); };
  window.IS_SIMULATOR_RUNNING = true;
  for (let d = 0; d <= me.totalRouteMeters + 30 && me.activeRoute; d += 40) {
    const p = me.getPositionAtDistance(d);
    me.updateCarPosition(p.lat, p.lng, p.heading, 40, true);
  }
  if (me.activeRoute) { // land exactly on the route end, wherever the step left us
    const end = me.getPositionAtDistance(me.totalRouteMeters);
    me.updateCarPosition(end.lat, end.lng, end.heading, 10, true);
  }
  window.IS_SIMULATOR_RUNNING = false;
  me.onManeuverUpdate = origCb;
  me.onArrival = origArr;
  document.getElementById('arrival-modal')?.classList.add('hidden');
  const afterArrival = geoCount();
  return {
    pass: me.provider === 'yandex' && routeBuilt && withRoute > atStart && maneuvers.length > 1 && arrived && afterArrival === atStart && errs.length === 0,
    provider: me.provider, routeBuilt, geoObjects: { atStart, withRoute, afterArrival }, maneuvers, arrived, pageErrors: errs
  };
})();
