// FALLBACK — the runner opens this page with MapLibre unavailable (CDN blocked, or WebGL
// disabled). The engine must switch to the Leaflet/OSM map and keep navigating.
// PASS (the returned `pass` field): provider === 'osm', badge shows OSM, route built,
//       navigation reaches arrival, recenter/zoom/cancel work, no page errors.
// Usage: run via `npm run verify -- fallback-cdn fallback-webgl` (needs the runner's setup).
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const errs = [];
  window.addEventListener('error', e => errs.push(e.message));
  window.addEventListener('unhandledrejection', e => errs.push(String(e.reason)));
  for (let i = 0; i < 80 && !(window.mapEngine && mapEngine.map); i++) await sleep(250);
  const me = window.mapEngine;
  if (!me || !me.map) return { pass: false, error: 'no map at all', provider: me && me.provider };
  me.voiceEnabled = false;
  me.updateCarPosition(40.1915, 44.5150, 0, 0, true);
  const routeBuilt = !!(await me.buildRouteTo({ name: 'Check', lat: 40.1776, lng: 44.5125 }));
  me.startNavigation();
  for (let d = 0; d <= me.totalRouteMeters + 30 && me.activeRoute; d += 60) {
    const p = me.getPositionAtDistance(d);
    me.updateCarPosition(p.lat, p.lng, p.heading, 40, true);
  }
  if (me.activeRoute) { // land exactly on the route end, wherever the step left us
    const end = me.getPositionAtDistance(me.totalRouteMeters);
    me.updateCarPosition(end.lat, end.lng, end.heading, 10, true);
  }
  const arrived = !me.activeRoute;
  document.getElementById('arrival-modal')?.classList.add('hidden');
  let controlsError = null;
  try { me.recenter(); me.zoomIn(); me.zoomOut(); me.toggleHeadingUp(); me.cancelRoute(); } catch (e) { controlsError = e.message; }
  const badge = document.getElementById('provider-indicator')?.textContent;
  return {
    pass: me.provider === 'osm' && badge === 'OSM' && routeBuilt && arrived && !controlsError && errs.length === 0,
    provider: me.provider, badge, leafletLoaded: !!window.L, maplibreLoaded: !!window.maplibregl, routeBuilt, arrived, controlsError, pageErrors: errs
  };
})();
