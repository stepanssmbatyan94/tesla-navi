// DUAL GPS — phone fixes and the car browser's own fixes arrive together; the phone must win
// (no arrow jumping between receivers) and the car GPS must take over when the phone is silent.
// PASS (the returned `pass` field): 0 backward jumps > 5 m over 40 interleaved fixes and the
//       car fix is used after the phone has been silent > 5 s.
// Usage: paste into a browser-tool JS console (returns a promise) or run `npm run verify`.
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 60 && !(window.mapEngine && mapEngine.map && mapEngine.map.isStyleLoaded()); i++) await sleep(250);
  const me = mapEngine;
  me.voiceEnabled = false;
  // capture the car-GPS callback by re-running initTeslaCarGps with a stubbed geolocation
  let carCallback = null;
  navigator.geolocation.watchPosition = ok => { carCallback = ok; return 1; };
  initTeslaCarGps();
  const carFix = p => carCallback({ coords: { latitude: p.lat, longitude: p.lng, speed: 11, heading: null, accuracy: 15 }, timestamp: Date.now() });
  const phoneFix = p => handleIncomingGps({ lat: p.lat, lng: p.lng, speed: 11, heading: 0, accuracy: 5, timestamp: Date.now() });
  me.updateCarPosition(40.1800, 44.4700, 0, 0, true);
  if (!(await me.buildRouteTo({ name: 'Check', lat: 40.2050, lng: 44.5300 }))) return { pass: false, error: 'route not built' };
  me.startNavigation();
  const along = () => me.getVehicleDistanceAlongRoute(me.currentPosition.lat, me.currentPosition.lng);
  const positions = [];
  for (let t = 0; t < 20; t++) {
    const d = 200 + t * 11;
    phoneFix(me.getPositionAtDistance(d)); positions.push(along());
    carFix(me.getPositionAtDistance(d - 30)); positions.push(along());  // car receiver 30 m behind
  }
  let backwardJumps = 0;
  for (let i = 1; i < positions.length; i++) if (positions[i] < positions[i - 1] - 5) backwardJumps++;
  lastPhoneGpsAt = Date.now() - 6000; // phone silent for 6 s
  const before = along();
  carFix(me.getPositionAtDistance(600));
  const after = along();
  cancelActiveNavigation();
  localStorage.removeItem('tesla_search_history');
  return {
    pass: backwardJumps === 0 && after > before + 50,
    backwardJumps, interleavedFixes: positions.length, failover: { before: Math.round(before), afterCarFix: Math.round(after) }
  };
})();
