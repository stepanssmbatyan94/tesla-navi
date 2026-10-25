const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'js', 'client-log.js'), 'utf8');

function loadClientLog() {
  const listeners = {};
  const beacons = [];
  const ctx = {
    console,
    JSON,
    String,
    Set,
    Blob: class { constructor(parts) { this.text = parts.join(''); } },
    location: { pathname: '/' },
    navigator: { userAgent: 'Tesla/test', sendBeacon: (url, blob) => { beacons.push({ url, body: JSON.parse(blob.text) }); return true; } },
    fetch: () => Promise.resolve()
  };
  ctx.window = ctx;
  ctx.addEventListener = (type, fn) => { listeners[type] = fn; };
  vm.runInNewContext(SOURCE, ctx);
  return { listeners, beacons, ctx };
}

test('client-log reports an uncaught error once, skips opaque CDN errors, caps a page load', () => {
  const { listeners, beacons, ctx } = loadClientLog();
  ctx.mapEngine = { provider: 'maplibre' };
  const error = { message: 'x is undefined', filename: 'https://host/js/maps/map-engine.js?v=86', lineno: 10, colno: 4, error: { stack: 'stack here' } };
  listeners.error(error);
  listeners.error(error);
  assert.equal(beacons.length, 1, 'the same error is reported once');
  assert.equal(beacons[0].url, '/api/client-log');
  assert.equal(beacons[0].body.message, 'x is undefined');
  assert.equal(beacons[0].body.provider, 'maplibre');
  assert.equal(beacons[0].body.page, 'car');

  listeners.error({ message: 'Script error.', filename: '', lineno: 0, colno: 0 });
  assert.equal(beacons.length, 1, 'a cross-origin "Script error." has nothing to act on');

  listeners.unhandledrejection({ reason: { message: 'fetch failed', stack: 's' } });
  assert.equal(beacons[1].body.kind, 'rejection');

  for (let i = 0; i < 40; i++) listeners.error({ ...error, lineno: 100 + i });
  assert.equal(beacons.length, 20, 'at most 20 reports per page load');
});
