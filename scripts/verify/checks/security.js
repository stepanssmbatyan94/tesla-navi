// SECURITY — untrusted text must render as text, malformed phone packets are dropped.
// Sends an <img onerror> payload through the real pairing channel and injects it into
// favorites, quick chips and YouTube history.
// PASS (the returned `pass` field): xssExecutions === 0, renderedAsText > 0, malformedIgnored === true.
// Usage: paste into a browser-tool JS console (returns a promise) or run `npm run verify`.
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 40 && !(window.mapEngine && mapEngine.map && mapEngine.map.isStyleLoaded()); i++) await sleep(250);
  mapEngine.voiceEnabled = false;
  const backup = {};
  ['tesla_search_history', 'tesla_saved_places', 'tesla_yt_history'].forEach(k => { backup[k] = localStorage.getItem(k); });
  window.__xss = 0;
  const payload = '<img src=x onerror="window.__xss=(window.__xss||0)+1">Evil';
  const phone = new TeslaRealtime({ code: currentCode, role: 'phone' });
  phone.init();
  await sleep(2500);
  phone.sendDestination({ name: payload, lat: 40.1776, lng: 44.5125 });
  await sleep(3000);
  let routedToBad = false;
  const origStart = window.startNavigationTo;
  window.startNavigationTo = d => { if (d && d.name === 'bad') routedToBad = true; return origStart(d); };
  phone.sendDestination({ name: 'bad', lat: 'abc', lng: 44.5 });
  await sleep(1000);
  window.startNavigationTo = origStart;
  renderSearchHistory();
  toggleFavoritePlace({ name: payload, address: payload, lat: 40.18, lng: 44.51 });
  renderFavoritesList();
  renderQuickDestChips();
  localStorage.setItem('tesla_yt_history', JSON.stringify([{ id: 'abc', title: payload, channel: payload, duration: '1:00' }]));
  document.querySelector('.yt-filter-tab[data-tab="history"]')?.click();
  await sleep(800);
  const renderedAsText = [...document.querySelectorAll('.item-title, .my-place-name, .chip-title, .yt-item-title')]
    .filter(e => e.textContent.includes('<img')).length;
  cancelActiveNavigation();
  Object.entries(backup).forEach(([k, v]) => (v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v)));
  userSavedPlaces = loadSavedPlaces();
  renderAllSavedPlacesUI();
  if (phone.localWs) phone.localWs.onclose = null, phone.localWs.close();
  return {
    pass: window.__xss === 0 && renderedAsText > 0 && !routedToBad,
    xssExecutions: window.__xss, renderedAsText, malformedIgnored: !routedToBad
  };
})();
