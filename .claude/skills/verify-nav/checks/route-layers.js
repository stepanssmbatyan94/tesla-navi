// ROUTE LAYERS — no leaks, long routes rebuild, route survives a theme swap.
// PASS: firstLong.ok && secondLong.ok (no "already exists" error), layer counts stay
//       small (< 20) and equal before/after each theme swap, afterCancel === 0, errors [].
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 40 && !(window.mapEngine && mapEngine.map && mapEngine.map.isStyleLoaded()); i++) await sleep(250);
const me = mapEngine;
me.voiceEnabled = false;
const errors = [];
const origErr = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ').slice(0, 160)); origErr(...a); };
const count = () => { const s = me.map.getStyle(); return s ? s.layers.filter(l => l.id.startsWith('route')).length : -1; };
const waitStyle = async () => { for (let i = 0; i < 40 && !me.map.isStyleLoaded(); i++) await sleep(150); await sleep(300); };
const theme0 = me.getThemeMode();
me.updateCarPosition(40.1915, 44.5150, 0, 0, true);
const firstLong = { ok: !!(await me.buildRouteTo({ name: 'Aghveran', lat: 40.5050, lng: 44.5820 })), layers: count() };
const secondLong = { ok: !!(await me.buildRouteTo({ name: 'Aghveran', lat: 40.5050, lng: 44.5820 })), layers: count() };
me.startNavigation();
const beforeTheme = count();
me.setTheme(me.isNightActive() ? 'day' : 'night'); await sleep(500); await waitStyle();
const afterFirstSwap = count();
me.setTheme(theme0); await sleep(500); await waitStyle();
const afterSecondSwap = count();
cancelActiveNavigation();
console.error = origErr;
({ firstLong, secondLong, beforeTheme, afterFirstSwap, afterSecondSwap, afterCancel: count(), errors });
