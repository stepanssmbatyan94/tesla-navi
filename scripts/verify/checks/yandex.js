// YANDEX — run on /?provider=yandex. The Yandex Maps JS provider loads on demand, builds and
// draws a route, drives to arrival and cleans up.
// PASS (the returned `pass` field): provider === 'yandex', route built, maneuvers seen,
//       heading-up like MapLibre (a route point 80 m ahead is drawn at its bearing minus the
//       car's heading, within 12° — straight up on a straight road; car at ~64 % of the height;
//       a user pan turns the map back north-up; camera markers stay upright), arrived,
//       geo objects back to the car marker only, no page errors.
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
  // a marker 80 m ahead on the route: where does the screen show it relative to the car?
  const probe = new ymaps.Placemark([0, 0], {}, { iconLayout: ymaps.templateLayoutFactory.createClass('<div id="verify-probe" style="width:4px;height:4px"></div>') });
  me.map.geoObjects.add(probe);
  const centerOf = el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const headingUp = [];
  // speed-camera markers on the turned map stand upright: their own turn cancels the map's
  const angleOf = el => { const m = getComputedStyle(el).transform; if (!m || m === 'none') return 0; const [a, b] = m.slice(7, -1).split(',').map(Number); return Math.atan2(b, a) * 180 / Math.PI; };
  const camerasUpright = [];
  window.IS_SIMULATOR_RUNNING = true;
  for (let d = 0; d <= me.totalRouteMeters + 30 && me.activeRoute; d += 40) {
    const p = me.getPositionAtDistance(d);
    me.updateCarPosition(p.lat, p.lng, p.heading, 40, true);
    if (d >= 200 && d % 400 === 0 && d + 120 < me.totalRouteMeters && headingUp.length < 4) {
      const ahead = me.getPositionAtDistance(d + 80);
      probe.geometry.setCoordinates([ahead.lat, ahead.lng]);
      // Yandex redraws placemarks asynchronously and the rotor turns with a 0.3 s transition:
      // measure until the screen positions stop moving (slow CI machines need longer). The dev
      // simulator's extrapolator would keep moving the car meanwhile: pause it while measuring
      window.IS_SIMULATOR_RUNNING = false;
      let car, pr, angle, prev = null;
      for (let i = 0; i < 25; i++) {
        await sleep(i ? 150 : 400);
        car = centerOf(document.querySelector('#yandex-car-marker .tesla-car-arrow'));
        pr = centerOf(document.getElementById('verify-probe'));
        angle = Math.atan2(pr.x - car.x, car.y - pr.y) * 180 / Math.PI;
        if (prev && Math.abs(angle - prev.angle) < 0.5 && Math.abs(car.y - prev.y) < 1) break;
        prev = { angle, y: car.y };
      }
      window.IS_SIMULATOR_RUNNING = true;
      const cp = me.currentPosition;
      const expected = me.calculateBearing(cp.lat, cp.lng, ahead.lat, ahead.lng) - me.currentHeading;
      const off = Math.abs(((angle - expected) % 360 + 540) % 360 - 180);
      const rotorEl = document.getElementById('yandex-map-rotor');
      for (const el of rotorEl.querySelectorAll('.camera-map-badge')) camerasUpright.push(Math.round(Math.abs(((angleOf(el) + angleOf(rotorEl)) % 360 + 540) % 360 - 180)));
      headingUp.push({ d, angle: Math.round(angle), expected: Math.round((expected + 540) % 360 - 180), off: Math.round(off), carY: +(car.y / innerHeight).toFixed(2) });
    }
  }
  me.map.geoObjects.remove(probe);

  if (me.activeRoute) { // land exactly on the route end, wherever the step left us
    const end = me.getPositionAtDistance(me.totalRouteMeters);
    me.updateCarPosition(end.lat, end.lng, end.heading, 10, true);
  }
  window.IS_SIMULATOR_RUNNING = false;
  me.onManeuverUpdate = origCb;
  me.onArrival = origArr;
  document.getElementById('arrival-modal')?.classList.add('hidden');
  const afterArrival = geoCount();
  const rotor = document.getElementById('yandex-map-rotor');
  me.followCar = false; me.syncYandexRotation(); // what a user pan does
  const afterPan = rotor.style.transform;
  me.recenter();
  const afterRecenter = rotor.style.transform;
  const headingUpOk = headingUp.length >= 2 && headingUp.every(h => h.off <= 12 && Math.abs(h.carY - 0.64) <= 0.03);
  return {
    pass: me.provider === 'yandex' && routeBuilt && withRoute > atStart && maneuvers.length > 1 && arrived && afterArrival === atStart && errs.length === 0 &&
      headingUpOk && afterPan === 'none' && afterRecenter.startsWith('rotate(') && camerasUpright.every(d => d <= 3),
    provider: me.provider, routeBuilt, geoObjects: { atStart, withRoute, afterArrival }, maneuvers, arrived, headingUp, camerasUpright, afterPan, afterRecenter, pageErrors: errs
  };
})();
