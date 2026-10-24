// FALLBACK — the runner opens this page with MapLibre unavailable (CDN blocked, or WebGL
// disabled). The engine must switch to the Leaflet/OSM map and keep navigating.
// PASS (the returned `pass` field): provider === 'osm', badge shows OSM, the first fix moves
//       the marker and centers the map, route built,
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
  // the first real fix must move the marker and center the map on the car
  const markerAt = me.carMarker && me.carMarker.getLatLng ? me.carMarker.getLatLng() : null;
  const centerAt = me.map.getCenter ? me.map.getCenter() : null;
  const firstFixApplied = !!(markerAt && centerAt && Math.abs(markerAt.lat - 40.1915) < 1e-4 && Math.abs(centerAt.lat - 40.1915) < 1e-3 && Math.abs(centerAt.lng - 44.5150) < 1e-3);
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
    pass: me.provider === 'osm' && badge === 'OSM' && firstFixApplied && routeBuilt && arrived && !controlsError && errs.length === 0,
    provider: me.provider, badge, firstFixApplied, leafletLoaded: !!window.L, maplibreLoaded: !!window.maplibregl, routeBuilt, arrived, controlsError, pageErrors: errs
  };
})();
