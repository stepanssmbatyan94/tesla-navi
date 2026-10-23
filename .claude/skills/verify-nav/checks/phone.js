// PHONE — run on /phone?code=VERIFY. Stubs geolocation and wake lock, no real GPS needed.
// PASS: doubleStart.watchPositionCalls === 1, wakeLock.requestsAfterReturn === requestsBefore + 1
//       and held, wsReconnect.newSocket && open, permissionDenied.alerts === 1 and no new
//       watch calls after the denial, failedRequests [].
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(2500);
stopGpsSharing();
const geo = navigator.geolocation;
let watches = 0, failNext = false;
geo.watchPosition = (ok, err) => { watches++; if (failNext) setTimeout(() => err({ code: 1, PERMISSION_DENIED: 1, message: 'denied' }), 10); return watches; };
geo.clearWatch = () => {};
let lockRequests = 0;
const locks = [];
Object.defineProperty(navigator, 'wakeLock', {
  configurable: true,
  value: { request: async () => { lockRequests++; const l = new EventTarget(); l.release = async () => l.dispatchEvent(new Event('release')); locks.push(l); return l; } }
});
let alerts = 0;
window.alert = () => { alerts++; };
const res = {};
startGpsSharing(); startGpsSharing();
await sleep(200);
res.doubleStart = { watchPositionCalls: watches };
const reqBefore = lockRequests;
locks[locks.length - 1].dispatchEvent(new Event('release'));
document.dispatchEvent(new Event('visibilitychange'));
await sleep(200);
res.wakeLock = { requestsBefore: reqBefore, requestsAfterReturn: lockRequests, held: !!wakeLock };
const oldWs = realtimeClient.localWs;
oldWs.close();
await sleep(2000);
res.wsReconnect = { newSocket: realtimeClient.localWs !== oldWs, open: realtimeClient.localWs.readyState === 1 };
stopGpsSharing();
failNext = true;
startGpsSharing();
await sleep(200);
const watchesAtDenial = watches;
document.dispatchEvent(new Event('visibilitychange'));
document.dispatchEvent(new Event('visibilitychange'));
await sleep(200);
res.permissionDenied = { alerts, newWatchesAfterDenial: watches - watchesAtDenial };
res.failedRequests = performance.getEntriesByType('resource')
  .filter(e => e.name.startsWith(location.origin) && e.responseStatus >= 400).map(e => e.name);
res;
