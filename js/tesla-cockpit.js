// Tesla Cockpit Controller

let currentLang = 'ru';
let realtimeClient = null;
let mapEngine = null;
let currentCode = '';
let selectedDestination = null;
let debounceTimer = null;

document.addEventListener('DOMContentLoaded', async () => {
  initPairingCode();
  initLanguage();
  await initMap();
  initRealtime();
  initSearchBar();
  initControls();
});

// 1. Setup Pairing Code and QR Generator
function initPairingCode() {
  const urlParams = new URLSearchParams(window.location.search);
  currentCode = (urlParams.get('code') || generateCode()).toUpperCase();

  document.getElementById('pairing-code-display').textContent = currentCode;

  // Generate QR Code pointing to Phone Remote
  const phoneUrl = `${window.location.origin}/phone?code=${currentCode}`;
  const qrImg = document.getElementById('qr-image');
  qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=0&color=0b0f17&bgcolor=ffffff&data=${encodeURIComponent(phoneUrl)}`;

  console.log('⚡ Tesla Display initialized with code:', currentCode);
}

function generateCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let res = '';
  for (let i = 0; i < 6; i++) {
    res += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return res;
}

// 2. Initialize Unified Map Engine
async function initMap() {
  mapEngine = new TeslaMapEngine('map-container', {
    provider: CONFIG.defaultProvider,
    center: CONFIG.defaultCenter,
    onRouteCalculated: (routeInfo) => {
      selectedDestination = routeInfo.destination;
      showHudBanner(routeInfo);
    }
  });

  await mapEngine.init();
}

// 3. Initialize Realtime WebSocket / Supabase Broadcast
function initRealtime() {
  realtimeClient = new TeslaRealtime({
    code: currentCode,
    role: 'display',
    onGpsUpdate: (gps) => {
      handleIncomingGps(gps);
    },
    onDestinationSet: (destination) => {
      handleIncomingDestination(destination);
    },
    onStatusChange: (connected) => {
      updateConnectionStatus(connected);
    }
  });

  realtimeClient.init();
}

// Handle GPS packet from Phone
function handleIncomingGps(gps) {
  document.getElementById('tel-lat').textContent = Number(gps.lat).toFixed(6);
  document.getElementById('tel-lng').textContent = Number(gps.lng).toFixed(6);
  document.getElementById('tel-accuracy').textContent = `±${Math.round(gps.accuracy || 8)} м`;
  document.getElementById('tel-age').textContent = `12 мс`;

  const speedKmh = Math.round((gps.speed || 0) * 3.6);
  document.getElementById('speedometer-val').textContent = speedKmh;

  if (mapEngine) {
    mapEngine.updateCarPosition(gps.lat, gps.lng, gps.heading || 0, speedKmh);
  }
}

// Handle Destination packet from Phone
function handleIncomingDestination(destination) {
  console.log('📍 New destination received from phone:', destination);
  selectedDestination = destination;

  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.value = destination.name || 'Точка назначения';
  }

  if (mapEngine) {
    mapEngine.buildRouteTo(destination);
    // Start navigation automatically
    startActiveNavigation();
  }
}

function startActiveNavigation() {
  document.getElementById('search-route-container').classList.add('hidden');
  document.getElementById('hud-banner').classList.remove('hidden');
  if (mapEngine) {
    mapEngine.startNavigation();
  }
}

// Update connection badge (Waiting -> Connected -> Connection Lost)
function updateConnectionStatus(connected) {
  const chip = document.getElementById('pairing-status-chip');
  const text = document.getElementById('pairing-status-text');
  const t = I18N[currentLang];

  if (connected) {
    chip.className = 'pairing-status-chip connected';
    text.textContent = t.connectedPhone;
  } else {
    chip.className = 'pairing-status-chip disconnected';
    text.textContent = t.disconnectedPhone;
  }
}

// Top Search Bar & Suggestions
function initSearchBar() {
  const searchInput = document.getElementById('search-input');
  const suggestionsBox = document.getElementById('search-suggestions');
  const btnStartRoute = document.getElementById('btn-start-route');

  // Input debounced autocomplete
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const query = searchInput.value.trim();

    if (query.length < 2) {
      suggestionsBox.style.display = 'none';
      const catRow = document.querySelector('.search-categories-row');
      if (catRow) catRow.style.display = 'flex';
      return;
    }

    debounceTimer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
        const items = await res.json();

        const catRow = document.querySelector('.search-categories-row');

        if (items && items.length > 0) {
          suggestionsBox.innerHTML = '';
          items.forEach(item => {
            const div = document.createElement('div');
            div.className = 'suggestion-item';
            div.innerHTML = `
              <div class="suggestion-title">${item.title}</div>
              <div class="suggestion-sub">${item.subtitle || ''}</div>
            `;
            div.addEventListener('click', () => {
              searchInput.value = item.title;
              suggestionsBox.style.display = 'none';
              if (catRow) catRow.style.display = 'flex';
              selectedDestination = { name: item.title, lat: item.lat, lng: item.lng };
              mapEngine.buildRouteTo(selectedDestination);
              startActiveNavigation();
            });
            suggestionsBox.appendChild(div);
          });
          suggestionsBox.style.display = 'flex';
          if (catRow) catRow.style.display = 'none'; // Hide category row so it doesn't get in the way
        } else {
          suggestionsBox.style.display = 'none';
          if (catRow) catRow.style.display = 'flex';
        }
      } catch (e) {
        console.warn('Autocomplete error:', e);
      }
    }, 250);
  });

  // Enter key press
  searchInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const q = searchInput.value.trim();
      if (!q) return;
      suggestionsBox.style.display = 'none';
      const catRow = document.querySelector('.search-categories-row');
      if (catRow) catRow.style.display = 'flex';
      await resolveAndNavigate(q);
    }
  });

  // "В путь" button click
  btnStartRoute.addEventListener('click', async () => {
    const q = searchInput.value.trim();
    suggestionsBox.style.display = 'none';
    const catRow = document.querySelector('.search-categories-row');
    if (catRow) catRow.style.display = 'flex';

    if (selectedDestination) {
      startActiveNavigation();
    } else if (q) {
      await resolveAndNavigate(q);
    } else {
      searchInput.focus();
    }
  });

  // Close suggestions when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-input-card')) {
      suggestionsBox.style.display = 'none';
      const catRow = document.querySelector('.search-categories-row');
      if (catRow) catRow.style.display = 'flex';
    }
  });

  // Category pills
  document.querySelectorAll('.category-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const type = pill.dataset.type;
      let target = null;
      if (type === 'charging') {
        target = { name: 'Tesla Supercharger 250 kW', lat: 40.192000, lng: 44.475000 };
      } else if (type === 'fuel') {
        target = { name: 'CPS / Flash Fuel Station', lat: 40.187000, lng: 44.471000 };
      } else if (type === 'food') {
        target = { name: 'Ресторан / Food & Dining', lat: 40.184000, lng: 44.480000 };
      } else if (type === 'coffee') {
        target = { name: 'Coffee House', lat: 40.185500, lng: 44.485000 };
      } else if (type === 'parking') {
        target = { name: 'Парковка / Parking', lat: 40.186500, lng: 44.473000 };
      }

      if (target) {
        searchInput.value = target.name;
        selectedDestination = target;
        mapEngine.buildRouteTo(target);
        startActiveNavigation();
      }
    });
  });
}

async function resolveAndNavigate(query) {
  try {
    const res = await fetch(`/api/resolve-location?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (data && data.success) {
      selectedDestination = { name: data.name, lat: data.lat, lng: data.lng };
      mapEngine.buildRouteTo(selectedDestination);
      startActiveNavigation();
    } else {
      alert('Местоположение не найдено, попробуйте уточнить запрос');
    }
  } catch (e) {
    alert('Ошибка при поиске: ' + e.message);
  }
}

// Show Top Turn-by-Turn HUD Banner
function showHudBanner(route) {
  const banner = document.getElementById('hud-banner');
  banner.classList.remove('hidden');

  document.getElementById('hud-distance').textContent = route.distance;
  document.getElementById('hud-street').textContent = route.name || 'Маршрут';
  document.getElementById('hud-eta').textContent = `${route.duration} · ETA ${route.eta}`;
}

function hideHudBanner() {
  document.getElementById('hud-banner').classList.add('hidden');
  document.getElementById('search-route-container').classList.remove('hidden');
  selectedDestination = null;
  if (mapEngine) {
    mapEngine.cancelRoute();
  }
}

// 4. UI Controls & Event Listeners
function initControls() {
  // End route button
  document.getElementById('btn-end-route').addEventListener('click', () => {
    hideHudBanner();
  });

  // Language buttons
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.lang-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      setLanguage(e.target.dataset.lang);
    });
  });

  // Traffic Toggle Button
  const btnTraffic = document.getElementById('btn-traffic');
  btnTraffic.addEventListener('click', () => {
    const isTraffic = mapEngine.toggleTraffic();
    btnTraffic.classList.toggle('active', isTraffic);
  });

  // Provider Switch Button (Yandex <-> OSM)
  const btnProvider = document.getElementById('btn-provider');
  btnProvider.addEventListener('click', async () => {
    const nextProvider = mapEngine.provider === 'yandex' ? 'osm' : 'yandex';
    await mapEngine.switchProvider(nextProvider);
    btnProvider.classList.toggle('active', nextProvider === 'yandex');
  });

  // Recenter FAB
  document.getElementById('btn-recenter').addEventListener('click', () => {
    if (mapEngine) mapEngine.recenter();
  });

  // Commute tiles (Home / Work demo routes)
  document.getElementById('tile-home').addEventListener('click', () => {
    const home = {
      name: currentLang === 'hy' ? 'Տուն (Կիևյան փողոց)' : 'Дом (ул. Киевян)',
      lat: 40.195262,
      lng: 44.486342
    };
    document.getElementById('search-input').value = home.name;
    selectedDestination = home;
    mapEngine.buildRouteTo(home);
    startActiveNavigation();
  });

  document.getElementById('tile-work').addEventListener('click', () => {
    const work = {
      name: currentLang === 'hy' ? 'Աշխատանք (Հանրապետության հրապարակ)' : 'Работа (Площадь Республики)',
      lat: 40.177700,
      lng: 44.512600
    };
    document.getElementById('search-input').value = work.name;
    selectedDestination = work;
    mapEngine.buildRouteTo(work);
    startActiveNavigation();
  });
}

// Apply localization
function initLanguage() {
  setLanguage('ru');
}

function setLanguage(lang) {
  currentLang = lang;
  const t = I18N[lang];

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (t[key]) {
      el.textContent = t[key];
    }
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (t[key]) {
      el.setAttribute('placeholder', t[key]);
    }
  });

  updateConnectionStatus(realtimeClient ? realtimeClient.isConnected : false);
}
