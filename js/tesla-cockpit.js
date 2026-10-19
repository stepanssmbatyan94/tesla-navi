// Tesla Navi Cockpit Controller (Mapsev & Yandex Navigator Architecture)

let mapEngine = null;
let realtimeClient = null;
let currentCode = '';
let selectedDestination = null;
let currentLang = 'ru';
let activeChargersMarkers = [];
let chargersVisible = false;

// YouTube Music Playlist (Verified working YouTube IDs)
const PLAYLIST = [
  { title: 'BRUNETTE - ANHETANAM', id: '-o07wiIMd3g' },
  { title: 'K/ES - yellowheart. feat Misho', id: 'xNW2-ruUlVI' },
  { title: 'Arkadi Dumikyan - Hreshtakneri qaxaq', id: 'Za4JpfNyHkY' },
  { title: 'Artur Arakelyan - Kyanqis Imast', id: 'RWoOXqWeBvw' }
];
let currentTrackIndex = 0;
let isMusicPlaying = false;

// Yerevan EV Supercharging Stations (CPS, Flash, PlugShare)
const EV_CHARGERS = [
  { name: 'Tesla Supercharger Yerevan (Flash)', lat: 40.192000, lng: 44.475000, power: '150 kW' },
  { name: 'EV Motors Fast Charger (Kievyan St)', lat: 40.198500, lng: 44.493000, power: '120 kW' },
  { name: 'CPS Electric Charging Hub (Halabyan)', lat: 40.187000, lng: 44.471000, power: '60 kW' },
  { name: 'SAS Foodland EV Charger (Baghramyan)', lat: 40.191200, lng: 44.501500, power: '50 kW' },
  { name: 'Dalma Garden Mall Supercharger', lat: 40.180200, lng: 44.482000, power: '120 kW' }
];

document.addEventListener('DOMContentLoaded', async () => {
  console.log('🚗 Initializing Tesla Navi Automotive Cockpit...');

  // 1. Language Setup
  initLanguage();

  // 2. Direct In-Car Tesla Geolocation
  initTeslaCarGps();

  // 3. Realtime Phone Pairing (Supabase Broadcast)
  initPairing();

  // 4. Map Engine Initialization (MapLibre GL 3D Primary)
  await initMap();

  // 5. Toolbar & Drawer UI Handlers
  initToolbarHandlers();

  // 6. Search & Autocomplete Handlers
  initSearchHandlers();

  // 7. Weather & Music Handlers
  initWeatherAndMusic();

  // 8. Developer Mode & In-Car Simulator (?mode=dev)
  initDevMode();
});

// 1. Language Management (RU, HY, EN)
function initLanguage() {
  currentLang = localStorage.getItem('tesla_navi_lang') || 'ru';
  window.CURRENT_LANG = currentLang;
  applyLanguage(currentLang);

  const langBtn = document.getElementById('btn-lang-toggle');
  langBtn.addEventListener('click', () => {
    if (currentLang === 'ru') currentLang = 'hy';
    else if (currentLang === 'hy') currentLang = 'en';
    else currentLang = 'ru';

    localStorage.setItem('tesla_navi_lang', currentLang);
    window.CURRENT_LANG = currentLang;
    applyLanguage(currentLang);
  });
}

function applyLanguage(lang) {
  const dict = I18N[lang] || I18N.ru;
  document.getElementById('lang-indicator').textContent = lang.toUpperCase();

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    if (dict[key]) el.textContent = dict[key];
  });

  const searchInput = document.getElementById('drawer-search-input');
  if (searchInput && dict.searchPlaceholder) {
    searchInput.placeholder = dict.searchPlaceholder;
  }
}

// 2. Direct In-Car Tesla Browser Geolocation
function initTeslaCarGps() {
  if (!('geolocation' in navigator)) {
    console.warn('Geolocation not supported in this browser');
    return;
  }

  navigator.geolocation.watchPosition(
    (pos) => {
      const coords = pos.coords;
      const speedKmh = coords.speed ? Math.round(coords.speed * 3.6) : 0;
      const heading = coords.heading || 0;

      // Update cluster speedometer
      document.getElementById('speed-current').textContent = speedKmh;

      // Update telemetry
      document.getElementById('tel-lat').textContent = Number(coords.latitude).toFixed(4);
      document.getElementById('tel-lng').textContent = Number(coords.longitude).toFixed(4);
      document.getElementById('tel-accuracy').textContent = `±${Math.round(coords.accuracy || 3)} м`;
      document.getElementById('tel-age').textContent = `4 мс`;

      // Pass directly to Map Engine
      if (mapEngine) {
        mapEngine.updateCarPosition(coords.latitude, coords.longitude, heading, speedKmh);
      }
    },
    (err) => {
      console.log('[In-Car GPS] Geolocation status:', err.message);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10000
    }
  );
}

// 3. Realtime Phone Remote Pairing (Supabase Broadcast)
function initPairing() {
  const urlParams = new URLSearchParams(window.location.search);
  currentCode = (urlParams.get('code') || generateCode()).toUpperCase();

  document.getElementById('pairing-code-display').textContent = currentCode;

  // Build QR code URL pointing to phone remote
  const basePath = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
  const phoneUrl = `${window.location.origin}${basePath}/phone.html?code=${currentCode}`;

  const qrImg = document.getElementById('qr-image');
  qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=0&color=0b0f17&bgcolor=ffffff&data=${encodeURIComponent(phoneUrl)}`;

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
      updatePairingStatus(connected);
    }
  });

  realtimeClient.init();
}

function generateCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let res = '';
  for (let i = 0; i < 6; i++) {
    res += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return res;
}

function handleIncomingGps(gps) {
  const speedKmh = Math.round((gps.speed || 0) * 3.6);
  document.getElementById('speed-current').textContent = speedKmh;

  document.getElementById('tel-lat').textContent = Number(gps.lat).toFixed(4);
  document.getElementById('tel-lng').textContent = Number(gps.lng).toFixed(4);
  document.getElementById('tel-accuracy').textContent = `±${Math.round(gps.accuracy || 3)} м`;
  document.getElementById('tel-age').textContent = `12 мс`;

  if (mapEngine) {
    mapEngine.updateCarPosition(gps.lat, gps.lng, gps.heading || 0, speedKmh);
  }
}

function updatePairingStatus(connected) {
  const dot = document.getElementById('tool-phone-dot');
  const statusText = document.getElementById('pairing-status-text');
  const dict = I18N[currentLang] || I18N.ru;

  if (connected) {
    dot.classList.add('connected');
    statusText.textContent = dict.connectedPhone;
    statusText.style.color = 'var(--accent-green)';
    // Auto-minimize pairing modal if connected
    setTimeout(() => {
      document.getElementById('pairing-modal').classList.add('hidden');
    }, 1200);
  } else {
    dot.classList.remove('connected');
    statusText.textContent = dict.waitingPhone;
    statusText.style.color = 'var(--accent-amber)';
  }
}

// Commute Bookmarks Data (Home & Work)
const COMMUTE_LOCATIONS = {
  home: { name: 'Дом', address: 'ул. Амиряна, 18', lat: 40.1772, lng: 44.5105 },
  work: { name: 'Работа', address: 'ул. Акоп Акопян, 3', lat: 40.1982, lng: 44.4928 }
};

let currentRouteInfo = null;

// Dynamic Yerevan Traffic Score Calculation (UTC+4)
function getLiveTrafficScore() {
  const now = new Date();
  const utcHours = now.getUTCHours();
  const utcMinutes = now.getUTCMinutes();
  const yerevanHour = (utcHours + 4 + (utcMinutes / 60)) % 24;

  let score = 2;
  let color = '#22c55e'; // Vibrant Green
  let label = 'Дороги свободны';

  if (yerevanHour >= 8.5 && yerevanHour < 10.5) {
    score = 7;
    color = '#ef4444'; // Red
    label = 'Утренний час пик';
  } else if (yerevanHour >= 17.0 && yerevanHour < 19.75) {
    score = 8;
    color = '#ef4444'; // Red
    label = 'Вечерний час пик';
  } else if (yerevanHour >= 13.0 && yerevanHour < 15.0) {
    score = 5;
    color = '#f59e0b'; // Amber
    label = 'Умеренное движение';
  } else if (yerevanHour >= 10.5 && yerevanHour < 17.0) {
    score = 4;
    color = '#eab308'; // Yellow
    label = 'Обычный трафик';
  } else if (yerevanHour >= 19.75 && yerevanHour < 21.0) {
    score = 4;
    color = '#eab308';
    label = 'Трафик спадает';
  } else {
    // 21:00 - 08:30 (Matches 21:28 user drive photo!)
    score = 2;
    color = '#22c55e';
    label = 'Свободно';
  }

  return { score, color, label };
}

let liveTrafficData = null;

async function updateLiveTrafficBadge() {
  const badge = document.getElementById('traffic-score-badge');
  if (!badge) return;

  const curLat = mapEngine?.currentPosition?.lat;
  const curLng = mapEngine?.currentPosition?.lng;
  const query = (curLat && curLng) ? `?lat=${curLat}&lng=${curLng}` : '';

  try {
    const res = await fetch(`/api/traffic-yerevan${query}`);
    const data = await res.json();
    if (data && data.success) {
      liveTrafficData = data;
      badge.textContent = data.outsideCity ? '🛣️' : data.score;
      badge.style.background = data.color;
      badge.style.boxShadow = `0 4px 14px ${data.color}90`;
      if (data.outsideCity) {
        badge.title = `Трасса / За городом: ${data.hint}`;
      } else if (data.city && data.city !== 'Ереван') {
        badge.title = `${data.city}: ${data.hint}`;
      } else {
        badge.title = `Пробки в Ереване: ${data.score} из 10 (${data.hint}) · Яндекс`;
      }
      return;
    }
  } catch (e) {}

  const traffic = getLiveTrafficScore();
  badge.textContent = traffic.score;
  badge.style.background = traffic.color;
  badge.style.boxShadow = `0 4px 14px ${traffic.color}90`;
  badge.title = `Пробки в Ереване: ${traffic.score} из 10 баллов (${traffic.label})`;
}

// 4. Map Engine Initialization
async function initMap() {
  const urlParams = new URLSearchParams(window.location.search);
  const activeProvider = urlParams.get('provider') || localStorage.getItem('tesla_map_provider') || 'maplibre';

  mapEngine = new TeslaMapEngine('map-container', {
    provider: activeProvider,
    center: CONFIG.defaultCenter,
    onRouteCalculated: (route) => {
      showRouteAlternativesDrawer(route);
    },
    onManeuverUpdate: (maneuver) => {
      updateManeuverHud(maneuver);
    },
    onArrival: (destination) => {
      showArrivalModal(destination);
    },
    onUserPan: () => {
      const recenterBtn = document.getElementById('floating-recenter-btn');
      if (recenterBtn) recenterBtn.classList.remove('hidden');
    },
    onProgressUpdate: (progress) => {
      const cursor = document.getElementById('prog-car-cursor');
      if (typeof progress === 'object') {
        if (cursor && progress.percent !== undefined) {
          cursor.style.left = `${Math.min(96, Math.max(0, progress.percent))}%`;
        }
        if (progress.remainingDistance) {
          const el = document.getElementById('nav-distance');
          if (el) el.textContent = progress.remainingDistance;
        }
        if (progress.remainingDuration) {
          const el = document.getElementById('nav-duration');
          if (el) el.textContent = progress.remainingDuration;
        }
        if (progress.eta) {
          const el = document.getElementById('nav-eta');
          if (el) el.textContent = progress.eta;
        }
      } else if (cursor) {
        cursor.style.left = `${Math.min(96, Math.max(0, progress))}%`;
      }
    },
    onCameraAlert: (alert) => {
      const badge = document.getElementById('camera-alert-badge');
      const distEl = document.getElementById('camera-alert-dist');
      if (!badge) return;
      if (alert && alert.visible) {
        if (distEl) distEl.textContent = alert.distance;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }
  });

  await mapEngine.init();
  updateCommuteEtas();
  updateLiveTrafficBadge();
  setInterval(updateLiveTrafficBadge, 45000); // Live poll Yandex Traffic every 45s
}

// 5. Toolbar & Drawer UI Handlers
function initToolbarHandlers() {
  const searchDrawer = document.getElementById('search-drawer');
  const btnOpenSearch = document.getElementById('btn-open-search');
  const btnCloseSearch = document.getElementById('btn-close-search');

  // Search Drawer Toggle
  btnOpenSearch.addEventListener('click', () => {
    searchDrawer.classList.toggle('hidden');
    if (!searchDrawer.classList.contains('hidden')) {
      document.getElementById('drawer-search-input').focus();
      updateCommuteEtas();
    }
  });

  btnCloseSearch.addEventListener('click', () => {
    searchDrawer.classList.add('hidden');
  });

  // Floating Recenter Button (Yandex Style)
  const recenterBtn = document.getElementById('floating-recenter-btn');
  if (recenterBtn) {
    recenterBtn.addEventListener('click', () => {
      if (mapEngine) mapEngine.recenter();
      recenterBtn.classList.add('hidden');
    });
  }

  // Floating Zoom Buttons (+ / -)
  const btnZoomIn = document.getElementById('btn-zoom-in');
  const btnZoomOut = document.getElementById('btn-zoom-out');
  if (btnZoomIn) {
    btnZoomIn.addEventListener('click', () => {
      if (mapEngine) mapEngine.zoomIn();
    });
  }
  if (btnZoomOut) {
    btnZoomOut.addEventListener('click', () => {
      if (mapEngine) mapEngine.zoomOut();
    });
  }

  // Sound / Voice Mute Toggle
  const btnSoundToggle = document.getElementById('btn-sound-toggle');
  if (btnSoundToggle) {
    btnSoundToggle.addEventListener('click', () => {
      if (mapEngine) {
        const voiceOn = mapEngine.toggleVoice();
        btnSoundToggle.classList.toggle('muted', !voiceOn);
        btnSoundToggle.textContent = voiceOn ? '🔊' : '🔇';
      }
    });
  }

  // Traffic Score Badge Alert (Official Yandex Traffic Data)
  const trafficBadge = document.getElementById('traffic-score-badge');
  if (trafficBadge) {
    trafficBadge.addEventListener('click', () => {
      if (liveTrafficData && liveTrafficData.success) {
        alert(`🚦 Яндекс.Пробки Ереван\nБалл: ${liveTrafficData.score} из 10\nСитуация: ${liveTrafficData.hint}\nВремя обновления: ${liveTrafficData.time || 'сейчас'}\nИсточник: Официальный информер Яндекс`);
      } else {
        const traffic = getLiveTrafficScore();
        alert(`🚦 Пробки в Ереване: ${traffic.score} из 10 баллов\n${traffic.label}\nВремя: UTC+4 (Ереван)`);
      }
    });
  }

  // Route Alternatives Drawer Handlers (IMG_3693)
  const card0 = document.getElementById('route-card-0');
  const card1 = document.getElementById('route-card-1');
  if (card0) {
    card0.addEventListener('click', () => {
      card0.classList.add('active');
      if (card1) card1.classList.remove('active');
      if (mapEngine) mapEngine.selectRouteIndex(0);
    });
  }
  if (card1) {
    card1.addEventListener('click', () => {
      card1.classList.add('active');
      if (card0) card0.classList.remove('active');
      if (mapEngine) mapEngine.selectRouteIndex(1);
    });
  }

  const btnCloseAltDrawer = document.getElementById('btn-close-alt-drawer');
  if (btnCloseAltDrawer) {
    btnCloseAltDrawer.addEventListener('click', () => {
      document.getElementById('route-alternatives-drawer').classList.add('hidden');
    });
  }

  // "Go / Поехали" Action Button (Starts active turn-by-turn navigation)
  const btnStartRouteNav = document.getElementById('btn-start-route-nav');
  if (btnStartRouteNav) {
    btnStartRouteNav.addEventListener('click', () => {
      document.getElementById('route-alternatives-drawer').classList.add('hidden');
      if (currentRouteInfo) {
        showNavigationHud(currentRouteInfo);
        if (mapEngine) {
          mapEngine.startNavigation(); // Activates movement tracking, audio cue & off-route rerouting
          mapEngine.recenter();
        }
      }
    });
  }

  // Tap on bottom nav bar to view full turn-by-turn steps
  const bottomBar = document.getElementById('bottom-nav-bar');
  if (bottomBar) {
    bottomBar.addEventListener('click', (e) => {
      if (e.target.id === 'btn-cancel-nav') return;
      const drawer = document.getElementById('route-alternatives-drawer');
      if (drawer && currentRouteInfo) {
        drawer.classList.toggle('hidden');
      }
    });
  }

  // Commute Bookmarks: Home / Work
  const homeBtn = document.getElementById('commute-home');
  const workBtn = document.getElementById('commute-work');
  if (homeBtn) {
    homeBtn.addEventListener('click', () => {
      searchDrawer.classList.add('hidden');
      startNavigationTo(COMMUTE_LOCATIONS.home);
    });
  }
  if (workBtn) {
    workBtn.addEventListener('click', () => {
      searchDrawer.classList.add('hidden');
      startNavigationTo(COMMUTE_LOCATIONS.work);
    });
  }

  // Phone Pairing Modal
  const btnOpenPairing = document.getElementById('btn-open-pairing');
  const pairingModal = document.getElementById('pairing-modal');
  const btnClosePairingX = document.getElementById('btn-close-pairing-x');
  const btnPairingDone = document.getElementById('btn-pairing-done');

  btnOpenPairing.addEventListener('click', () => {
    pairingModal.classList.remove('hidden');
  });
  [btnClosePairingX, btnPairingDone].forEach(btn => {
    btn.addEventListener('click', () => pairingModal.classList.add('hidden'));
  });

  // Map Engine Switcher: 3D Vector (MapLibre) vs Yandex Live Traffic (Яндекс)
  const btnToggleProvider = document.getElementById('btn-toggle-provider');
  const providerIndicator = document.getElementById('provider-indicator');
  const activeProv = new URLSearchParams(window.location.search).get('provider') || localStorage.getItem('tesla_map_provider') || 'maplibre';
  if (providerIndicator) {
    providerIndicator.textContent = activeProv === 'yandex' ? 'ЯН' : '3D';
    providerIndicator.style.color = activeProv === 'yandex' ? '#ef4444' : '#38bdf8';
  }
  if (btnToggleProvider) {
    btnToggleProvider.title = activeProv === 'yandex'
      ? 'Карта: Яндекс (живой слой пробок). Нажмите для 3D Vector'
      : 'Карта: 3D Vector. Нажмите для Яндекс.Пробок';

    btnToggleProvider.addEventListener('click', () => {
      const nextProv = (localStorage.getItem('tesla_map_provider') || 'maplibre') === 'yandex' ? 'maplibre' : 'yandex';
      localStorage.setItem('tesla_map_provider', nextProv);
      const url = new URL(window.location.href);
      url.searchParams.set('provider', nextProv);
      window.location.href = url.toString();
    });
  }

  // Compass Toggle (Heading-Up vs North-Up)
  const btnCompass = document.getElementById('btn-compass');
  btnCompass.addEventListener('click', () => {
    if (mapEngine) {
      const isHeadingUp = mapEngine.toggleHeadingUp();
      btnCompass.classList.toggle('active', isHeadingUp);
    }
  });

  // EV Chargers Toggle
  const btnChargers = document.getElementById('btn-toggle-chargers');
  btnChargers.addEventListener('click', () => {
    chargersVisible = !chargersVisible;
    btnChargers.classList.toggle('active', chargersVisible);
    toggleEvChargers(chargersVisible);
  });

  // Bottom Nav Cancel button
  document.getElementById('btn-cancel-nav').addEventListener('click', () => {
    cancelActiveNavigation();
  });

  // Arrival Done button
  document.getElementById('btn-arrival-done').addEventListener('click', () => {
    document.getElementById('arrival-modal').classList.add('hidden');
  });
}

function updateCommuteEtas() {
  if (!mapEngine) return;
  const current = mapEngine.currentPosition;
  ['home', 'work'].forEach(key => {
    const loc = COMMUTE_LOCATIONS[key];
    const distMeters = mapEngine.calculateDistance(current.lat, current.lng, loc.lat, loc.lng);
    const speedMps = 8.5; // ~30 km/h city average
    const durationMin = Math.max(3, Math.round(distMeters / (speedMps * 60)));
    const distStr = distMeters >= 1000 ? `${(distMeters / 1000).toFixed(1)} км` : `${Math.round(distMeters)} м`;
    const badge = document.getElementById(`${key}-eta-badge`);
    if (badge) {
      badge.textContent = `${durationMin} мин · ${distStr}`;
    }
  });
}

// 6. Search & Autocomplete Handlers
function initSearchHandlers() {
  const searchInput = document.getElementById('drawer-search-input');
  const resultsList = document.getElementById('search-results-list');
  const searchDrawer = document.getElementById('search-drawer');
  let debounceTimer = null;

  // Autocomplete typing with Yandex-powered geocoder
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const query = searchInput.value.trim();
    const sectionTitle = document.getElementById('drawer-section-title');
    if (sectionTitle) {
      sectionTitle.textContent = query ? 'Результаты поиска' : (I18N[window.CURRENT_LANG || 'ru']?.history || 'История');
    }

    if (query.length < 2) return;

    debounceTimer = setTimeout(async () => {
      try {
        const cur = mapEngine ? mapEngine.currentPosition : { lat: 40.1776, lng: 44.5125 };
        const url = `/api/geocode?q=${encodeURIComponent(query)}&lat=${cur.lat}&lng=${cur.lng}`;
        const res = await fetch(url);
        const items = await res.json();

        resultsList.innerHTML = '';

        if (items && items.length > 0) {
          items.forEach(it => {
            const title = it.title || query;
            const subtitle = it.subtitle || 'Армения';
            const lat = it.lat;
            const lng = it.lng;

            // Calculate distance from current vehicle location
            const distMeters = mapEngine ? mapEngine.calculateDistance(cur.lat, cur.lng, lat, lng) : 1000;
            const distStr = distMeters >= 1000 ? `${(distMeters / 1000).toFixed(1)} км` : `${Math.round(distMeters)} м`;

            const item = document.createElement('div');
            item.className = 'drawer-list-item';
            item.innerHTML = `
              <div class="item-left">
                <div class="item-icon">📍</div>
                <div>
                  <div class="item-title">${title}</div>
                  <div class="item-subtitle">${subtitle}</div>
                </div>
              </div>
              <div class="item-dist">${distStr}</div>
            `;

            item.addEventListener('click', () => {
              searchDrawer.classList.add('hidden');
              startNavigationTo({ name: title, lat, lng });
            });

            resultsList.appendChild(item);
          });
        }
      } catch (e) {
        console.warn('Search geocode error:', e);
      }
    }, 200);
  });

  // Click on default history items
  document.querySelectorAll('.drawer-list-item').forEach(item => {
    item.addEventListener('click', () => {
      const lat = parseFloat(item.dataset.lat);
      const lng = parseFloat(item.dataset.lng);
      const name = item.dataset.name;
      if (lat && lng) {
        searchDrawer.classList.add('hidden');
        startNavigationTo({ name, lat, lng });
      }
    });
  });

  // Category chips
  document.querySelectorAll('.drawer-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const type = chip.dataset.type;
      let target = null;
      if (type === 'charging') target = { name: 'Tesla Supercharger Yerevan (Flash)', lat: 40.192000, lng: 44.475000 };
      else if (type === 'parking') target = { name: 'Парковка / Parking Center', lat: 40.186500, lng: 44.473000 };
      else if (type === 'carwash') target = { name: 'Premium Car Wash Yerevan', lat: 40.184500, lng: 44.478000 };
      else if (type === 'food') target = { name: 'Ресторан / Dining Yerevan', lat: 40.184000, lng: 44.480000 };
      else if (type === 'coffee') target = { name: 'Coffee House Yerevan', lat: 40.185500, lng: 44.485000 };

      if (target) {
        searchDrawer.classList.add('hidden');
        startNavigationTo(target);
      }
    });
  });
}

// Start Navigation to Target
async function startNavigationTo(destination) {
  selectedDestination = destination;
  if (mapEngine) {
    const route = await mapEngine.buildRouteTo(destination);
    if (route) {
      showRouteAlternativesDrawer(route);
    }
  }
}

function handleIncomingDestination(destination) {
  console.log('📍 Destination received from Phone:', destination);
  startNavigationTo(destination);
}

// Route Alternatives & Turn Details Drawer (Mapsev IMG_3693)
function showRouteAlternativesDrawer(route) {
  currentRouteInfo = route;
  const drawer = document.getElementById('route-alternatives-drawer');
  if (!drawer) return;

  // Card 0: Primary / Fastest
  document.getElementById('route-0-time').textContent = route.duration;
  document.getElementById('route-0-dist').textContent = route.distance;
  const card0 = document.getElementById('route-card-0');
  card0.classList.add('active');

  // Card 1: Alternative Route
  const card1 = document.getElementById('route-card-1');
  if (route.alternative) {
    card1.classList.remove('hidden');
    card1.classList.remove('active');
    document.getElementById('route-1-badge').textContent = route.alternative.name;
    document.getElementById('route-1-time').textContent = route.alternative.duration;
    document.getElementById('route-1-dist').textContent = `${route.alternative.distance} · ${route.alternative.diffMins} мин`;
  } else {
    card1.classList.add('hidden');
  }

  // Populate Turn-by-Turn list matching IMG_3693
  const listEl = document.getElementById('turn-steps-list');
  listEl.innerHTML = '';

  // Step 0: My Location
  const locItem = document.createElement('div');
  locItem.className = 'turn-step-item';
  locItem.innerHTML = `
    <div class="turn-step-icon" style="color: #ef4444;">●</div>
    <div class="turn-step-info">
      <div class="turn-step-street">${I18N[currentLang]?.myLocation || 'Мое местоположение'}</div>
    </div>
    <div class="turn-step-dist">0 м</div>
  `;
  listEl.appendChild(locItem);

  if (route.steps && route.steps.length > 0) {
    route.steps.forEach(step => {
      let icon = '↑';
      if (step.modifier && step.modifier.includes('left')) icon = '↰';
      else if (step.modifier && step.modifier.includes('right')) icon = '↱';
      else if (step.modifier && step.modifier.includes('uturn')) icon = '↺';

      const distStr = step.distance >= 1000 ? `${(step.distance / 1000).toFixed(1)} км` : `${Math.round(step.distance)} м`;
      const item = document.createElement('div');
      item.className = 'turn-step-item';
      item.innerHTML = `
        <div class="turn-step-icon">${icon}</div>
        <div class="turn-step-info">
          <div class="turn-step-street">${step.instruction || step.name}</div>
        </div>
        <div class="turn-step-dist">${distStr}</div>
      `;
      listEl.appendChild(item);
    });
  }

  // Arrival Step
  const arrivalItem = document.createElement('div');
  arrivalItem.className = 'turn-step-item';
  arrivalItem.innerHTML = `
    <div class="turn-step-icon" style="color: #10b981;">🏁</div>
    <div class="turn-step-info">
      <div class="turn-step-street">${route.name}</div>
    </div>
    <div class="turn-step-dist">${route.eta}</div>
  `;
  listEl.appendChild(arrivalItem);

  drawer.classList.remove('hidden');
}

// 7. Navigation HUD Displays
function renderTrafficProgressBar(segments) {
  const barContainer = document.querySelector('.route-progress-bar');
  if (!barContainer) return;
  barContainer.innerHTML = '';

  if (!segments || segments.length === 0) {
    barContainer.innerHTML = '<div class="prog-seg green" style="width: 100%; background: #82ea0d;"></div>';
    return;
  }

  // Count total coordinates across all segments
  const totalPoints = segments.reduce((sum, s) => sum + (s.coords ? s.coords.length : 1), 0);
  if (totalPoints <= 0) {
    barContainer.innerHTML = '<div class="prog-seg green" style="width: 100%; background: #82ea0d;"></div>';
    return;
  }

  segments.forEach(seg => {
    const pts = seg.coords ? seg.coords.length : 1;
    const widthPct = (pts / totalPoints) * 100;
    const segDiv = document.createElement('div');
    segDiv.className = 'prog-seg';
    segDiv.style.width = `${widthPct.toFixed(2)}%`;
    segDiv.style.background = seg.color || '#82ea0d';
    barContainer.appendChild(segDiv);
  });
}

function showNavigationHud(route) {
  document.getElementById('hud-maneuver-card').classList.remove('hidden');
  document.getElementById('bottom-nav-bar').classList.remove('hidden');
  // Keep lane guidance hidden by default unless real lane info is provided
  document.getElementById('lane-guidance-pill').classList.add('hidden');

  // Initial step details from route steps
  const firstStep = (route.steps && route.steps[0]) ? route.steps[0] : null;
  document.getElementById('maneuver-dist').textContent = firstStep ? (mapEngine ? mapEngine.formatNavDistance(firstStep.distance) : `${Math.round(firstStep.distance)} м`) : route.distance;
  document.getElementById('maneuver-street').textContent = firstStep ? (firstStep.name || firstStep.instruction) : route.name;

  document.getElementById('nav-duration').textContent = route.duration;
  document.getElementById('nav-distance').textContent = route.distance;
  document.getElementById('nav-eta').textContent = route.eta;

  // Reset progress car cursor to 0% at route start
  const cursor = document.getElementById('prog-car-cursor');
  if (cursor) cursor.style.left = '0%';

  // Render authentic live traffic segments on the bottom progress bar
  renderTrafficProgressBar(route.trafficSegments);
}

function updateManeuverHud(m) {
  document.getElementById('maneuver-dist').textContent = m.distance;
  document.getElementById('maneuver-street').textContent = m.street || m.instruction || 'Двигайтесь прямо';

  // Arrow symbol based on modifier / type
  const arrowBox = document.getElementById('maneuver-arrow-box');
  const mod = (m.modifier || '').toLowerCase();
  const type = (m.type || '').toLowerCase();
  if (type === 'roundabout' || mod.includes('roundabout')) arrowBox.textContent = '🔄';
  else if (mod.includes('uturn') || mod.includes('u-turn')) arrowBox.textContent = '↺';
  else if (mod.includes('slight left') || mod.includes('fork left')) arrowBox.textContent = '↖';
  else if (mod.includes('slight right') || mod.includes('fork right')) arrowBox.textContent = '↗';
  else if (mod.includes('left')) arrowBox.textContent = '↰';
  else if (mod.includes('right')) arrowBox.textContent = '↱';
  else arrowBox.textContent = '↑';

  // Update dynamic speed limit circle (60 in city, 90 on highway/outside Yerevan)
  if (m.speedLimit) {
    const limitEl = document.getElementById('speed-limit-val');
    if (limitEl) limitEl.textContent = m.speedLimit;
  }

  // Real Lane Guidance if present, otherwise remain hidden (no fake lanes)
  const lanePill = document.getElementById('lane-guidance-pill');
  if (lanePill) {
    if (m.lanes && m.lanes.length > 0) {
      lanePill.innerHTML = m.lanes.map(l => `<span class="lane-arrow ${l.valid ? 'active' : ''}">${l.symbol || '↑'}</span>`).join('');
      lanePill.classList.remove('hidden');
    } else {
      lanePill.classList.add('hidden');
    }
  }
}

function cancelActiveNavigation() {
  document.getElementById('hud-maneuver-card').classList.add('hidden');
  document.getElementById('bottom-nav-bar').classList.add('hidden');
  document.getElementById('lane-guidance-pill').classList.add('hidden');
  const camBadge = document.getElementById('camera-alert-badge');
  if (camBadge) camBadge.classList.add('hidden');
  const altDrawer = document.getElementById('route-alternatives-drawer');
  if (altDrawer) altDrawer.classList.add('hidden');
  selectedDestination = null;
  currentRouteInfo = null;
  if (mapEngine) {
    mapEngine.cancelRoute();
  }
}

function showArrivalModal(dest) {
  document.getElementById('hud-maneuver-card').classList.add('hidden');
  document.getElementById('bottom-nav-bar').classList.add('hidden');
  document.getElementById('lane-guidance-pill').classList.add('hidden');
  document.getElementById('arrival-dest-name').textContent = dest.name || 'Пункт назначения';
  document.getElementById('arrival-modal').classList.remove('hidden');
}

// 8. EV Supercharger Pins on Map
function toggleEvChargers(show) {
  if (!mapEngine || !mapEngine.map) return;

  if (!show) {
    activeChargersMarkers.forEach(m => m.remove());
    activeChargersMarkers = [];
    return;
  }

  EV_CHARGERS.forEach(charger => {
    const el = document.createElement('div');
    el.className = 'tesla-dest-pin';
    el.innerHTML = `
      <div style="width: 32px; height: 32px; border-radius: 50%; background: #10b981; border: 2.5px solid #fff; display: grid; place-items: center; color: #fff; font-size: 14px; font-weight: 800; box-shadow: 0 4px 12px rgba(16,185,129,0.5);">
        ⚡
      </div>
    `;

    el.addEventListener('click', () => {
      startNavigationTo({ name: charger.name, lat: charger.lat, lng: charger.lng });
    });

    const marker = new window.maplibregl.Marker({ element: el })
      .setLngLat([charger.lng, charger.lat])
      .addTo(mapEngine.map);

    activeChargersMarkers.push(marker);
  });
}

// 9. Weather (Open-Meteo Real Forecast for Yerevan) & YouTube Music
function initWeatherAndMusic() {
  // Weather
  const btnWeather = document.getElementById('btn-open-weather');
  const weatherModal = document.getElementById('weather-modal');
  const btnWeatherX = document.getElementById('btn-close-weather-x');
  const btnWeatherDone = document.getElementById('btn-weather-done');

  btnWeather.addEventListener('click', async () => {
    weatherModal.classList.remove('hidden');
    loadLiveYerevanWeather();
  });
  [btnWeatherX, btnWeatherDone].forEach(btn => {
    btn.addEventListener('click', () => weatherModal.classList.add('hidden'));
  });

  // YouTube Music & Video Player
  const btnMusic = document.getElementById('btn-open-music');
  const ytModal = document.getElementById('youtube-player-modal');
  const btnCloseMusic = document.getElementById('btn-close-music');
  const btnMusicPlay = document.getElementById('btn-music-play');
  const btnMusicPrev = document.getElementById('btn-music-prev');
  const btnMusicNext = document.getElementById('btn-music-next');
  const ytIframe = document.getElementById('yt-player-iframe');
  const ytSearchInput = document.getElementById('yt-search-input');
  const btnYtSearchGo = document.getElementById('btn-yt-search-go');
  const suggestionsList = document.getElementById('yt-suggestions-list');

  btnMusic.addEventListener('click', () => {
    ytModal.classList.toggle('hidden');
    btnMusic.classList.toggle('active', !ytModal.classList.contains('hidden'));
  });

  btnCloseMusic.addEventListener('click', () => {
    ytModal.classList.add('hidden');
    btnMusic.classList.remove('active');
  });

  function playTrackById(videoId, title) {
    if (ytIframe) {
      const origin = window.location.origin || '';
      ytIframe.src = `https://www.youtube.com/embed/${videoId}?autoplay=1&enablejsapi=1&origin=${encodeURIComponent(origin)}`;
    }
    isMusicPlaying = true;
    if (btnMusicPlay) btnMusicPlay.textContent = '⏸';
  }

  async function handleYtSearch() {
    const q = ytSearchInput.value.trim();
    if (!q) return;

    // Check if query is direct YouTube video ID or URL
    const urlMatch = q.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
    if (urlMatch && urlMatch[1]) {
      const videoId = urlMatch[1];
      playTrackById(videoId, q);
      return;
    }

    if (btnYtSearchGo) btnYtSearchGo.textContent = '⏳';
    try {
      const res = await fetch(`/api/yt-search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (data.results && data.results.length > 0) {
        suggestionsList.innerHTML = '';
        data.results.forEach((track, idx) => {
          const div = document.createElement('div');
          div.className = `yt-song-item ${idx === 0 ? 'active' : ''}`;
          div.dataset.id = track.id;
          div.dataset.title = track.title;

          const titleSpan = document.createElement('span');
          titleSpan.textContent = `🎵 ${track.title}`;
          titleSpan.style.cssText = 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 250px;';

          const durSpan = document.createElement('span');
          durSpan.textContent = track.duration || '';

          div.appendChild(titleSpan);
          div.appendChild(durSpan);

          div.addEventListener('click', () => {
            suggestionsList.querySelectorAll('.yt-song-item').forEach(el => el.classList.remove('active'));
            div.classList.add('active');
            playTrackById(track.id, track.title);
          });
          suggestionsList.appendChild(div);
        });

        // Update playlist for next/prev navigation
        PLAYLIST.length = 0;
        data.results.forEach(t => PLAYLIST.push({ title: t.title, id: t.id }));
        currentTrackIndex = 0;

        playTrackById(data.results[0].id, data.results[0].title);
      }
    } catch (err) {
      console.warn('YouTube search failed:', err);
    } finally {
      if (btnYtSearchGo) btnYtSearchGo.textContent = '🔍';
    }
  }

  if (btnYtSearchGo) btnYtSearchGo.addEventListener('click', handleYtSearch);
  if (ytSearchInput) {
    ytSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleYtSearch();
    });
  }

  // Suggestions row clicks
  if (suggestionsList) {
    suggestionsList.querySelectorAll('.yt-song-item').forEach(item => {
      item.addEventListener('click', () => {
        suggestionsList.querySelectorAll('.yt-song-item').forEach(el => el.classList.remove('active'));
        item.classList.add('active');
        const id = item.dataset.id;
        const title = item.dataset.title;
        playTrackById(id, title);
      });
    });
  }

  function updateTrack() {
    const track = PLAYLIST[currentTrackIndex];
    if (isMusicPlaying) {
      playTrackById(track.id, track.title);
    }
  }

  btnMusicPlay.addEventListener('click', () => {
    isMusicPlaying = !isMusicPlaying;
    btnMusicPlay.textContent = isMusicPlaying ? '⏸' : '▶';
    if (isMusicPlaying) {
      updateTrack();
    } else if (ytIframe) {
      ytIframe.contentWindow.postMessage('{"event":"command","func":"pauseVideo","args":""}', '*');
    }
  });

  btnMusicNext.addEventListener('click', () => {
    currentTrackIndex = (currentTrackIndex + 1) % PLAYLIST.length;
    isMusicPlaying = true;
    updateTrack();
  });

  btnMusicPrev.addEventListener('click', () => {
    currentTrackIndex = (currentTrackIndex - 1 + PLAYLIST.length) % PLAYLIST.length;
    isMusicPlaying = true;
    updateTrack();
  });
}

async function loadLiveYerevanWeather() {
  try {
    const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=40.18&longitude=44.51&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&hourly=temperature_2m,weather_code&timezone=auto');
    const data = await res.json();

    if (data.current) {
      const temp = Math.round(data.current.temperature_2m);
      document.getElementById('weather-desc').textContent = `Облачно · ${temp}°C`;
      document.getElementById('weather-humidity').textContent = `${data.current.relative_humidity_2m}%`;
      document.getElementById('weather-wind').textContent = `${Math.round(data.current.wind_speed_10m)} км/ч`;
    }

    if (data.hourly && data.hourly.time) {
      const row = document.getElementById('weather-hourly-row');
      row.innerHTML = '';
      const times = [9, 12, 15, 18, 21];
      times.forEach(hour => {
        const temp = Math.round(data.hourly.temperature_2m[hour] || 15);
        const col = document.createElement('div');
        col.className = 'weather-hour-col';
        col.innerHTML = `
          <span>${String(hour).padStart(2, '0')}:00</span>
          <span>${hour < 18 ? '☀️' : '🌙'}</span>
          <span class="weather-hour-temp">${temp}°</span>
        `;
        row.appendChild(col);
      });
    }
  } catch (e) {
    console.warn('Weather fetch error:', e);
  }
}

// 10. Developer Mode & In-Car Road Simulator (?mode=dev)
function initDevMode() {
  const urlParams = new URLSearchParams(window.location.search);
  const isDev = urlParams.get('mode') === 'dev';

  const devPill = document.getElementById('dev-mode-pill');
  const devPanel = document.getElementById('dev-mode-panel');
  const btnTogglePanel = document.getElementById('btn-dev-toggle-panel');
  const btnExit = document.getElementById('btn-dev-exit');
  const btnClosePanel = document.getElementById('btn-close-dev-panel');

  const tabBtnSim = document.getElementById('tab-btn-sim');
  const tabBtnDiag = document.getElementById('tab-btn-diag');
  const tabSim = document.getElementById('dev-tab-sim');
  const tabDiag = document.getElementById('dev-tab-diag');
  const logBox = document.getElementById('dev-log-box');

  // Console Log Interceptor for In-Car Tesla Screen
  function appendDevLog(level, ...args) {
    if (!logBox) return;
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    const text = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');

    const line = document.createElement('div');
    line.className = `dev-log-line ${level}`;
    line.innerHTML = `<span>[${timeStr}]</span> <strong>[${level.toUpperCase()}]</strong> ${text}`;
    logBox.appendChild(line);
    logBox.scrollTop = logBox.scrollHeight;
  }

  // Hook into browser console
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  console.log = function(...args) {
    origLog.apply(console, args);
    appendDevLog('log', ...args);
  };
  console.warn = function(...args) {
    origWarn.apply(console, args);
    appendDevLog('warn', ...args);
  };
  console.error = function(...args) {
    origError.apply(console, args);
    appendDevLog('error', ...args);
  };

  // Voice Search Button in Search Drawer (#btn-voice-search)
  const btnVoiceSearch = document.getElementById('btn-voice-search');
  if (btnVoiceSearch) {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    btnVoiceSearch.addEventListener('click', () => {
      if (!SpeechRec) {
        alert('Голосовой ввод не поддерживается браузером Tesla. Используйте клавиатуру.');
        console.warn('SpeechRecognition API not supported in this browser.');
        return;
      }

      try {
        const recognition = new SpeechRec();
        recognition.lang = window.CURRENT_LANG === 'hy' ? 'hy-AM' : (window.CURRENT_LANG === 'en' ? 'en-US' : 'ru-RU');
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;

        btnVoiceSearch.textContent = '🔴';
        btnVoiceSearch.style.animation = 'pulse 1s infinite';

        recognition.onstart = () => {
          console.log('[Voice Search] Слушаю голосовую команду...');
        };

        recognition.onresult = (evt) => {
          const transcript = evt.results[0][0].transcript;
          console.log('[Voice Search] Распознано:', transcript);
          const searchInput = document.getElementById('drawer-search-input');
          if (searchInput) {
            searchInput.value = transcript;
            searchInput.dispatchEvent(new Event('input'));
          }
        };

        recognition.onerror = (err) => {
          console.warn('[Voice Search] Ошибка распознавания:', err.error);
        };

        recognition.onend = () => {
          btnVoiceSearch.textContent = '🎤';
          btnVoiceSearch.style.animation = '';
        };

        recognition.start();
      } catch (err) {
        console.error('[Voice Search] Init error:', err);
        btnVoiceSearch.textContent = '🎤';
        btnVoiceSearch.style.animation = '';
      }
    });
  }

  if (!isDev) {
    if (devPill) devPill.classList.add('hidden');
    if (devPanel) devPanel.classList.add('hidden');
    return;
  }

  // Show Dev Mode UI
  if (devPill) devPill.classList.remove('hidden');
  console.log('🛠️ Dev Mode Active: simulator & diagnostics ready.');

  // Exit Dev Mode
  if (btnExit) {
    btnExit.addEventListener('click', () => {
      // 1. Terminate simulation ticker
      isSimRunning = false;
      window.IS_SIMULATOR_RUNNING = false;
      if (window.simAnimId) {
        cancelAnimationFrame(window.simAnimId);
        window.simAnimId = null;
      }
      if (simTimer) {
        clearInterval(simTimer);
        simTimer = null;
      }
      // 2. Stop and clear any active simulated navigation
      cancelActiveNavigation();
      // 3. Immediately hide dev UI elements
      if (devPill) devPill.classList.add('hidden');
      if (devPanel) devPanel.classList.add('hidden');
      // 4. Hard-navigate to clean URL without ?mode=dev
      const url = new URL(window.location.href);
      url.searchParams.delete('mode');
      window.location.href = url.pathname + (url.search ? url.search : '');
    });
  }

  // Toggle Dev Panel
  if (btnTogglePanel && devPanel) {
    btnTogglePanel.addEventListener('click', () => {
      devPanel.classList.toggle('hidden');
    });
  }
  if (btnClosePanel && devPanel) {
    btnClosePanel.addEventListener('click', () => {
      devPanel.classList.add('hidden');
    });
  }

  // Tab switching
  if (tabBtnSim && tabBtnDiag) {
    tabBtnSim.addEventListener('click', () => {
      tabBtnSim.classList.add('active');
      tabBtnDiag.classList.remove('active');
      tabSim.classList.remove('hidden');
      tabDiag.classList.add('hidden');
    });
    tabBtnDiag.addEventListener('click', () => {
      tabBtnDiag.classList.add('active');
      tabBtnSim.classList.remove('active');
      tabDiag.classList.remove('hidden');
      tabSim.classList.add('hidden');
    });
  }

  // Diagnostics Buttons
  const btnDiagMic = document.getElementById('btn-diag-mic');
  if (btnDiagMic) {
    btnDiagMic.addEventListener('click', async () => {
      console.log('🔍 [Диагностика] Проверка микрофона и прав...');
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        console.error('❌ navigator.mediaDevices.getUserMedia отсутствует в браузере');
      } else {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          console.log('✅ Доступ к микрофону ПОЛУЧЕН успешно!');
          stream.getTracks().forEach(t => t.stop());
        } catch (err) {
          console.error(`❌ Ошибка микрофона: ${err.name} — ${err.message}`);
          if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            console.warn('⚠️ Браузер Tesla заблокировал доступ к микрофону. Разрешите доступ в настройках браузера автомобиля.');
          }
        }
      }

      const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SpeechRec) {
        console.log('✅ SpeechRecognition API (голосовой ввод) поддерживается');
      } else {
        console.warn('⚠️ Web SpeechRecognition API не поддерживается в движке этого браузера');
      }
    });
  }

  const btnDiagTts = document.getElementById('btn-diag-tts');
  if (btnDiagTts) {
    btnDiagTts.addEventListener('click', () => {
      console.log('🔊 [Диагностика] Проверка синтеза речи и звука...');
      if (!('speechSynthesis' in window)) {
        console.error('❌ window.speechSynthesis не поддерживается');
        return;
      }
      const voices = window.speechSynthesis.getVoices() || [];
      console.log(`📋 Установлено системных голосов: ${voices.length}`);
      const ruVoices = voices.filter(v => v.lang && v.lang.startsWith('ru'));
      console.log(`🇷🇺 Русских голосов: ${ruVoices.length}`, ruVoices.map(v => v.name));

      if (mapEngine) {
        mapEngine.playNavChime();
        mapEngine.speakVoice('Тест голосового оповещения Tesla Navi. Маршрут свободен.');
        console.log('🗣️ Запущено воспроизведение тестовой фразы');
      }
    });
  }

  const btnDiagYt = document.getElementById('btn-diag-yt');
  if (btnDiagYt) {
    btnDiagYt.addEventListener('click', () => {
      console.log('🎵 [Диагностика] Тестирование YouTube плеера...');
      const ytIframe = document.getElementById('yt-player-iframe');
      if (ytIframe) {
        const testId = PLAYLIST[0].id;
        const origin = window.location.origin || '';
        ytIframe.src = `https://www.youtube.com/embed/${testId}?autoplay=1&enablejsapi=1&origin=${encodeURIComponent(origin)}`;
        console.log(`▶️ Загружен тестовый ролик ${testId} с origin: ${origin}`);
      } else {
        console.error('❌ Iframe YouTube не найден');
      }
    });
  }

  const btnDiagClear = document.getElementById('btn-diag-clear');
  if (btnDiagClear && logBox) {
    btnDiagClear.addEventListener('click', () => {
      logBox.innerHTML = '';
      console.log('🧹 Логи очищены');
    });
  }

  // --- Drive Simulator Engine ---
  let simDistance = 0;
  let simTotalDist = 1000;
  let simSpeed = 60;
  let isSimRunning = false;
  let simTimer = null;
  let cumulativeDistances = [];

  const btnSimPlay = document.getElementById('btn-sim-play');
  const btnSimPause = document.getElementById('btn-sim-pause');
  const btnSimReset = document.getElementById('btn-sim-reset');
  const btnSimStepBack = document.getElementById('btn-sim-step-back');
  const btnSimStepFwd = document.getElementById('btn-sim-step-fwd');
  const scrubSlider = document.getElementById('sim-scrub-slider');
  const scrubVal = document.getElementById('sim-scrub-val');

  // Pre-calculate cumulative segment lengths
  function initSimPolyline(coords) {
    if (!coords || coords.length < 2) return;
    cumulativeDistances = [0];
    let total = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      const p1 = coords[i];
      const p2 = coords[i + 1];
      const d = mapEngine.calculateDistance(p1[1], p1[0], p2[1], p2[0]);
      total += d;
      cumulativeDistances.push(total);
    }
    simTotalDist = Math.max(10, total);
  }

  // Interpolate position and heading at exact distance along polyline
  function getPositionAtDistance(dist) {
    const coords = mapEngine.routeCoordinates;
    if (!coords || coords.length < 2) return null;
    if (!cumulativeDistances || cumulativeDistances.length !== coords.length) {
      initSimPolyline(coords);
    }
    const clampedDist = Math.max(0, Math.min(simTotalDist, dist));

    // Find segment
    let segIdx = 0;
    for (let i = 0; i < cumulativeDistances.length - 1; i++) {
      if (clampedDist >= cumulativeDistances[i] && clampedDist <= cumulativeDistances[i + 1]) {
        segIdx = i;
        break;
      }
    }

    const segStartDist = cumulativeDistances[segIdx] || 0;
    const segEndDist = cumulativeDistances[segIdx + 1] || (segStartDist + 1);
    const segLen = Math.max(0.001, segEndDist - segStartDist);
    const t = Math.max(0, Math.min(1, (clampedDist - segStartDist) / segLen));

    const p1 = coords[segIdx];
    const p2 = coords[Math.min(coords.length - 1, segIdx + 1)];

    // coords is [lng, lat]
    const lng = p1[0] + (p2[0] - p1[0]) * t;
    const lat = p1[1] + (p2[1] - p1[1]) * t;
    const heading = mapEngine.calculateBearing(p1[1], p1[0], p2[1], p2[0]);

    return { lat, lng, heading };
  }

  function updateSimCar(targetDist) {
    simDistance = Math.max(0, Math.min(simTotalDist, targetDist));
    const pt = getPositionAtDistance(simDistance);
    if (pt && mapEngine) {
      mapEngine.updateCarPosition(pt.lat, pt.lng, pt.heading, isSimRunning ? simSpeed : 0);
    }

    const pct = Math.min(100, Math.round((simDistance / simTotalDist) * 100));
    if (scrubSlider) scrubSlider.value = pct;
    if (scrubVal) scrubVal.textContent = `${pct}%`;
  }

  let simAnimId = null;
  let lastSimTime = performance.now();

  function startSimTicker() {
    window.IS_SIMULATOR_RUNNING = true;
    if (simAnimId) {
      cancelAnimationFrame(simAnimId);
      simAnimId = null;
    }
    if (simTimer) {
      clearInterval(simTimer);
      simTimer = null;
    }
    lastSimTime = performance.now();

    function simFrame(now) {
      if (!isSimRunning) {
        window.IS_SIMULATOR_RUNNING = false;
        return;
      }
      const dt = Math.min(0.08, (now - lastSimTime) / 1000);
      lastSimTime = now;

      if (mapEngine && mapEngine.routeCoordinates && mapEngine.routeCoordinates.length >= 2) {
        const stepMeters = (simSpeed / 3.6) * dt;
        simDistance += stepMeters;

        if (simDistance >= simTotalDist) {
          simDistance = simTotalDist;
          isSimRunning = false;
          window.IS_SIMULATOR_RUNNING = false;
          btnSimPlay.classList.remove('active');
          btnSimPause.classList.add('active');
          updateSimCar(simDistance);
          console.log('🏁 Симулятор: Маршрут завершен. Прибытие!');
          return;
        }

        updateSimCar(simDistance);
      }

      simAnimId = requestAnimationFrame(simFrame);
      window.simAnimId = simAnimId;
    }

    simAnimId = requestAnimationFrame(simFrame);
    window.simAnimId = simAnimId;
  }

  // Load Preset Routes
  async function loadPresetRoute(start, dest, autoPlay = true) {
    console.log(`🚗 Загрузка симулятора: ${start.name} → ${dest.name}...`);
    if (!mapEngine) return;

    // Reposition car to start
    mapEngine.updateCarPosition(start.lat, start.lng, 0, 0);

    // Build route
    const routeInfo = await mapEngine.buildRouteTo(dest);
    if (routeInfo && mapEngine.routeCoordinates && mapEngine.routeCoordinates.length > 1) {
      document.getElementById('route-alternatives-drawer')?.classList.add('hidden');
      showNavigationHud(routeInfo);
      mapEngine.startNavigation();
      initSimPolyline(mapEngine.routeCoordinates);
      simDistance = 0;
      updateSimCar(0);
      if (autoPlay) {
        isSimRunning = true;
        window.IS_SIMULATOR_RUNNING = true;
        btnSimPlay.classList.add('active');
        btnSimPause.classList.remove('active');
        startSimTicker();
      }
      console.log(`✅ Маршрут построен: ${routeInfo.distance}, ${routeInfo.duration}, шагов: ${mapEngine.routeSteps.length}`);
    } else {
      console.error('❌ Не удалось построить маршрут для симулятора');
    }
  }

  // Preset 1: Yerevan -> Aghveran (User's real road test)
  const btnAghveran = document.getElementById('btn-sim-route-aghveran');
  if (btnAghveran) {
    btnAghveran.addEventListener('click', () => {
      btnAghveran.classList.add('active');
      document.getElementById('btn-sim-route-center')?.classList.remove('active');
      loadPresetRoute(
        { lat: 40.1915, lng: 44.5150, name: 'Ереван (Каскад)' },
        { lat: 40.5050, lng: 44.5820, name: 'Park Resort Aghveran' },
        true
      );
    });
  }

  // Preset 2: Cascade -> Republic Square
  const btnCenter = document.getElementById('btn-sim-route-center');
  if (btnCenter) {
    btnCenter.addEventListener('click', () => {
      btnCenter.classList.add('active');
      btnAghveran?.classList.remove('active');
      loadPresetRoute(
        { lat: 40.1915, lng: 44.5150, name: 'Каскад' },
        { lat: 40.1776, lng: 44.5125, name: 'Площадь Республики' },
        true
      );
    });
  }

  // Play / Pause / Reset
  if (btnSimPlay) {
    btnSimPlay.addEventListener('click', async () => {
      if (!mapEngine.routeCoordinates || mapEngine.routeCoordinates.length < 2) {
        console.log('🚗 Запуск маршрута по умолчанию: Ереван → Aghveran...');
        await loadPresetRoute(
          { lat: 40.1915, lng: 44.5150, name: 'Ереван (Каскад)' },
          { lat: 40.5050, lng: 44.5820, name: 'Park Resort Aghveran' },
          true
        );
        return;
      }
      if (!mapEngine.isNavigating) {
        mapEngine.startNavigation();
      }
      isSimRunning = true;
      window.IS_SIMULATOR_RUNNING = true;
      btnSimPlay.classList.add('active');
      btnSimPause.classList.remove('active');
      startSimTicker();
      console.log(`▶️ Симулятор запущен со скоростью ${simSpeed} км/ч`);
    });
  }

  if (btnSimPause) {
    btnSimPause.addEventListener('click', () => {
      isSimRunning = false;
      window.IS_SIMULATOR_RUNNING = false;
      if (simAnimId) {
        cancelAnimationFrame(simAnimId);
        simAnimId = null;
      }
      btnSimPause.classList.add('active');
      btnSimPlay.classList.remove('active');
      console.log('⏸️ Симулятор на паузе');
    });
  }

  if (btnSimReset) {
    btnSimReset.addEventListener('click', () => {
      isSimRunning = false;
      window.IS_SIMULATOR_RUNNING = false;
      if (simAnimId) {
        cancelAnimationFrame(simAnimId);
        simAnimId = null;
      }
      btnSimPlay.classList.remove('active');
      btnSimPause.classList.remove('active');
      updateSimCar(0);
      console.log('⏹️ Симулятор сброшен в начало маршрута');
    });
  }

  if (btnSimStepBack) {
    btnSimStepBack.addEventListener('click', () => {
      updateSimCar(simDistance - 100);
    });
  }

  if (btnSimStepFwd) {
    btnSimStepFwd.addEventListener('click', () => {
      updateSimCar(simDistance + 100);
    });
  }

  // Speed Presets
  const speeds = [
    { id: 'btn-speed-60', speed: 60 },
    { id: 'btn-speed-90', speed: 90 },
    { id: 'btn-speed-120', speed: 120 },
    { id: 'btn-speed-250', speed: 250 }
  ];

  speeds.forEach(s => {
    const el = document.getElementById(s.id);
    if (el) {
      el.addEventListener('click', () => {
        speeds.forEach(other => document.getElementById(other.id)?.classList.remove('active'));
        el.classList.add('active');
        simSpeed = s.speed;
        console.log(`⚡ Скорость симулятора установлена: ${simSpeed} км/ч`);
      });
    }
  });

  // Scrub Slider
  if (scrubSlider) {
    scrubSlider.addEventListener('input', () => {
      const pct = parseFloat(scrubSlider.value);
      const targetDist = (pct / 100) * simTotalDist;
      updateSimCar(targetDist);
    });
  }

  // Auto-init preset route ready on Dev Mode startup
  setTimeout(() => {
    if (isDev && (!mapEngine?.routeCoordinates || mapEngine.routeCoordinates.length < 2)) {
      loadPresetRoute(
        { lat: 40.1915, lng: 44.5150, name: 'Ереван (Каскад)' },
        { lat: 40.5050, lng: 44.5820, name: 'Park Resort Aghveran' },
        false
      );
    }
  }, 1000);
}

