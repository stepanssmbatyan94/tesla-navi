// REROUTE — leaving the route while navigating: the app reroutes from where the car is and keeps
// navigating on the route Yandex ranks first, without opening the route-options drawer.
// Drives 600 m of Yerevan -> Abovyan, then ~350 m off to the side with phone-like GPS fixes.
// PASS (the returned `pass` field): the route changed, still navigating, navigation HUD shown,
//       no route-options drawer, the fastest route (index 0) taken, no page errors.
// Usage: paste into a browser-tool JS console (returns a promise) or run `npm run verify`.
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const errs = [];
  window.addEventListener('error', e => errs.push(e.message));
  for (let i = 0; i < 60 && !(window.mapEngine && mapEngine.map && mapEngine.map.isStyleLoaded && mapEngine.map.isStyleLoaded()); i++) await sleep(250);
  const me = mapEngine;
  me.voiceEnabled = false;
  const fix = (lat, lng, heading) => handleIncomingGps({ lat, lng, heading, speed: 40, accuracy: 5, timestamp: Date.now() + Math.random() });
  fix(40.1776, 44.5126, 0);
  await startNavigationTo({ name: 'Abovyan', lat: 40.2741, lng: 44.6264 });
  if (!me.routeSteps.length) return { pass: false, error: 'route not built' };
  document.getElementById('btn-start-route-nav').click();
  await sleep(300);
  const routeBefore = me.routeCoordinates;
  for (let d = 0; d <= 600; d += 30) { const p = me.getPositionAtDistance(d); fix(p.lat, p.lng, p.heading); await sleep(20); }
  const p = me.getPositionAtDistance(600);
  for (let i = 0; i < 8; i++) { fix(p.lat + 0.0032 + i * 0.0002, p.lng + 0.001, 0); await sleep(400); }
  for (let i = 0; i < 40 && (me.isRerouting || me.routeCoordinates === routeBefore); i++) await sleep(250);
  await sleep(500);
  const body = document.body.classList;
  const result = {
    rerouted: me.routeCoordinates !== routeBefore,
    navigating: me.isNavigating && body.contains('navigating'),
    hudShown: !document.getElementById('hud-maneuver-card').classList.contains('hidden'),
    routeOptionsOpen: body.contains('route-options-open') || !document.getElementById('route-alternatives-drawer').classList.contains('hidden'),
    activeRouteIndex: me.activeRouteIndex,
    pageErrors: errs
  };
  cancelActiveNavigation();
  localStorage.removeItem('tesla_search_history');
  return { pass: result.rerouted && result.navigating && result.hudShown && !result.routeOptionsOpen && result.activeRouteIndex === 0 && errs.length === 0, ...result };
})();
