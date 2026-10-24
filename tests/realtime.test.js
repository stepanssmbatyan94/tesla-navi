const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserContext, loadScripts, get } = require('./helpers/browser-context');

function load() {
  return loadScripts(createBrowserContext(), ['js/config.js', 'js/realtime.js']);
}

test('generatePairingCode: 6 unambiguous symbols from the CSPRNG', () => {
  const ctx = load();
  const generatePairingCode = get(ctx, 'generatePairingCode');
  const codes = Array.from({ length: 500 }, () => generatePairingCode());
  for (const code of codes) assert.match(code, /^[2-9A-HJ-NP-Z]{6}$/);
  assert.ok(new Set(codes).size > 495);
});

test('isDuplicate drops only the exact second copy of a packet', () => {
  const ctx = load();
  const TeslaRealtime = get(ctx, 'TeslaRealtime');
  const rt = new TeslaRealtime({ code: 'TEST01', role: 'display' });
  const packet = { lat: 40.1, lng: 44.5, timestamp: 1000 };
  assert.equal(rt.isDuplicate(packet, 'gps'), false);
  assert.equal(rt.isDuplicate({ ...packet }, 'gps'), true, 'same packet over the second transport');
  // a second phone whose clock is behind must not be silenced
  assert.equal(rt.isDuplicate({ lat: 40.2, lng: 44.6, timestamp: 900 }, 'gps'), false);
  // same timestamp, different kind is a different packet
  assert.equal(rt.isDuplicate(packet, 'destination'), false);
});

test('handleGpsPacket delivers each packet once although it arrives twice', () => {
  const ctx = load();
  const TeslaRealtime = get(ctx, 'TeslaRealtime');
  const delivered = [];
  const rt = new TeslaRealtime({ code: 'TEST01', role: 'display', onGpsUpdate: g => delivered.push(g) });
  const packet = { lat: 40.1, lng: 44.5, timestamp: Date.now() };
  rt.handleGpsPacket(packet);
  rt.handleGpsPacket({ ...packet });
  assert.equal(delivered.length, 1);
});
