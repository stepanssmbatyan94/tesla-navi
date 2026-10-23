// SMOKE — car screen end-to-end without rAF.
// PASS: drawerOpen, hud.visible with a non-empty street, routeLayersAfterCancel === 0,
//       failedRequests [], pageErrors [], wsOpen === true.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const errs = [];
window.addEventListener('error', e => errs.push(e.message));
window.addEventListener('unhandledrejection', e => errs.push(String(e.reason)));
for (let i = 0; i < 40 && !(window.mapEngine && mapEngine.map && mapEngine.map.isStyleLoaded()); i++) await sleep(250);
mapEngine.voiceEnabled = false;
handleIncomingGps({ lat: 40.1915, lng: 44.5150, heading: 0, speed: 0, accuracy: 5, timestamp: Date.now() });
await startNavigationTo({ name: 'Площадь Республики', lat: 40.1776, lng: 44.5125 });
const drawerOpen = !document.getElementById('route-alternatives-drawer').classList.contains('hidden');
document.getElementById('btn-start-route-nav').click();
await sleep(1200);
const hud = {
  visible: !document.getElementById('hud-maneuver-card').classList.contains('hidden'),
  dist: document.getElementById('maneuver-dist').textContent,
  street: document.getElementById('maneuver-street').textContent
};
cancelActiveNavigation();
await sleep(300);
const failed = performance.getEntriesByType('resource')
  .filter(e => e.name.startsWith(location.origin) && e.responseStatus >= 400)
  .map(e => `${e.name} ${e.responseStatus}`);
localStorage.removeItem('tesla_search_history');
({
  drawerOpen,
  hud,
  routeLayersAfterCancel: mapEngine.map.getStyle().layers.filter(l => l.id.startsWith('route')).length,
  failedRequests: failed,
  pageErrors: errs,
  wsOpen: realtimeClient.localWs.readyState === 1
});
