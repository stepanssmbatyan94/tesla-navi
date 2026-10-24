// I18N — switch the car UI to Armenian and English, open the main screens and look for
// Russian text that bypassed the dictionaries (user/map data and the dev panel excluded).
// PASS (the returned `pass` field): no Cyrillic UI text in hy or en (speed-camera markers
//       included: one route passes known cameras); QR carries &lang=.
// Usage: paste into a browser-tool JS console (returns a promise) or run `npm run verify`.
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 60 && !(window.mapEngine && mapEngine.map && mapEngine.map.isStyleLoaded()); i++) await sleep(250);
  mapEngine.voiceEnabled = false;
  mapEngine.speakVoice = () => {};
  const backup = { lang: localStorage.getItem('tesla_navi_lang'), history: localStorage.getItem('tesla_search_history') };
  // data that legitimately stays in its own language: places, routes, map/YouTube content
  const DATA = '#dev-mode-panel, #dev-mode-pill, script, style, .yt-item-title, .yt-item-meta, #yt-now-title, #mini-player-title, .item-title, .item-subtitle, .my-place-name, .my-place-sub, .chip-title, .ev-charger-name, #home-address-sub, #work-address-sub, .card-badge.via, #maneuver-street, .turn-step-street, #arrival-dest-name, #weather-desc';
  const cyrillicUi = () => {
    const out = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const el = walker.currentNode.parentElement;
      if (!el || el.closest(DATA) || el.closest('.hidden') || getComputedStyle(el).display === 'none') continue;
      const t = walker.currentNode.textContent.trim();
      if (/[А-Яа-яЁё]/.test(t)) out.add(t.slice(0, 50));
    }
    document.querySelectorAll('[title]').forEach(e => { if (!e.closest(DATA) && !e.closest('.hidden') && /[А-Яа-яЁё]/.test(e.title)) out.add('@title ' + e.title.slice(0, 40)); });
    document.querySelectorAll('input[placeholder]').forEach(e => { if (/[А-Яа-яЁё]/.test(e.placeholder)) out.add('@placeholder ' + e.placeholder.slice(0, 40)); });
    return [...out];
  };
  handleIncomingGps({ lat: 40.1915, lng: 44.5150, heading: 0, speed: 0, accuracy: 5, timestamp: Date.now() });
  const results = {};
  const cameraMarkers = {};
  for (const lang of ['hy', 'en']) {
    for (let i = 0; i < 3 && window.CURRENT_LANG !== lang; i++) document.getElementById('btn-lang-toggle').click();
    handleIncomingGps({ lat: 40.1915, lng: 44.5150, heading: 0, speed: 0, accuracy: 5, timestamp: Date.now() });
    await sleep(200);
    const seen = new Set();
    const collect = () => cyrillicUi().forEach(x => seen.add(x));
    collect();
    document.getElementById('btn-open-search').click(); await sleep(200); collect();
    document.getElementById('search-drawer').classList.add('hidden');
    openEditPlaceModal('home'); await sleep(150); collect(); document.getElementById('edit-place-modal').classList.add('hidden');
    await startNavigationTo({ name: 'Check', lat: 40.1776, lng: 44.5125 }); await sleep(400); collect();
    document.getElementById('btn-start-route-nav').click(); await sleep(600); collect(); cancelActiveNavigation();
    // a route past known speed cameras (Yerevan west exit), so their marker tooltips are seen
    mapEngine.updateCarPosition(40.1700, 44.4500, 0, 0, true);
    await startNavigationTo({ name: 'Check', lat: 40.1600, lng: 44.3900 }); await sleep(400); collect();
    cameraMarkers[lang] = document.querySelectorAll('.camera-map-badge').length;
    cancelActiveNavigation();
    handleIncomingGps({ lat: 40.1915, lng: 44.5150, heading: 0, speed: 0, accuracy: 5, timestamp: Date.now() });
    document.getElementById('dock-battery-badge').click(); await sleep(800); collect(); closeChargingStationsDrawer();
    document.getElementById('btn-open-music').click(); await sleep(200);
    document.querySelector('.yt-filter-tab[data-tab="history"]').click(); await sleep(150); collect();
    document.getElementById('youtube-player-modal').classList.add('hidden');
    document.getElementById('btn-open-pairing').click(); await sleep(150); collect();
    document.getElementById('pairing-modal').classList.add('hidden');
    results[lang] = { cyrillicLeft: [...seen], cameraMarkers: cameraMarkers[lang], qrHasLang: (document.getElementById('qr-image').dataset.phoneUrl || '').includes(`lang=${lang}`) };
  }
  for (let i = 0; i < 3 && window.CURRENT_LANG !== 'ru'; i++) document.getElementById('btn-lang-toggle').click();
  if (backup.lang === null) localStorage.removeItem('tesla_navi_lang'); else localStorage.setItem('tesla_navi_lang', backup.lang);
  if (backup.history === null) localStorage.removeItem('tesla_search_history'); else localStorage.setItem('tesla_search_history', backup.history);
  return {
    pass: ['hy', 'en'].every(l => results[l].cyrillicLeft.length === 0 && results[l].qrHasLang && results[l].cameraMarkers > 0),
    ...results
  };
})();
