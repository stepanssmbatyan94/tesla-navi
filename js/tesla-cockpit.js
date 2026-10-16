// Tesla Navi Cockpit Controller (Mapsev & Yandex Navigator Architecture)

let mapEngine = null;
let realtimeClient = null;
let currentCode = '';
let selectedDestination = null;
let currentLang = 'ru';
let activeChargersMarkers = [];
let chargersVisible = false;

// YouTube Music Playlist
const PLAYLIST = [
  { title: 'BRUNETTE - ANHETANAM', id: 'm-V84sU0Y3I' },
  { title: 'K/ES - yellowheart. feat Misho', id: 'aM5Wv12xPqQ' },
  { title: 'Arkadi Dumikyan - Im Hreshtak', id: 'kJQP7kiw5Fk' },
  { title: 'Artur Arakelyan - Kyanqis Hamar', id: '2Vv-BfVoq4g' }
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

// 4. Map Engine Initialization
async function initMap() {
  mapEngine = new TeslaMapEngine('map-container', {
    provider: 'maplibre',
    center: CONFIG.defaultCenter,
    onRouteCalculated: (route) => {
      showNavigationHud(route);
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
    onProgressUpdate: (percent) => {
      const cursor = document.getElementById('prog-car-cursor');
      if (cursor) {
        cursor.style.left = `${Math.min(96, Math.max(0, percent))}%`;
      }
    }
  });

  await mapEngine.init();
  updateCommuteEtas();
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

  // Floating Recenter Button
  const recenterBtn = document.getElementById('floating-recenter-btn');
  if (recenterBtn) {
    recenterBtn.addEventListener('click', () => {
      if (mapEngine) mapEngine.recenter();
      recenterBtn.classList.add('hidden');
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

  // Traffic Score Badge
  const trafficBadge = document.getElementById('traffic-score-badge');
  if (trafficBadge) {
    trafficBadge.addEventListener('click', () => {
      alert('Пробки в Ереване: 8 баллов (Сложная дорожная ситуация)\nСредняя задержка на ключевых проспектах 10-15 минут.');
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

  // Autocomplete typing with Photon geocoder
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const query = searchInput.value.trim();

    if (query.length < 2) return;

    debounceTimer = setTimeout(async () => {
      try {
        const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&lat=40.18&lon=44.49&limit=6`;
        const res = await fetch(photonUrl);
        const data = await res.json();

        resultsList.innerHTML = '';

        if (data.features && data.features.length > 0) {
          data.features.forEach(f => {
            const p = f.properties;
            const title = [p.housenumber, p.name || p.street].filter(Boolean).join(' ') || query;
            const subtitle = [p.district || p.city, p.country || 'Armenia'].filter(Boolean).join(', ');
            const lat = f.geometry.coordinates[1];
            const lng = f.geometry.coordinates[0];

            // Calculate distance
            const distMeters = mapEngine ? mapEngine.calculateDistance(mapEngine.currentPosition.lat, mapEngine.currentPosition.lng, lat, lng) : 1000;
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
      showNavigationHud(route);
    }
  }
}

function handleIncomingDestination(destination) {
  console.log('📍 Destination received from Phone:', destination);
  startNavigationTo(destination);
}

// 7. Navigation HUD Displays
function showNavigationHud(route) {
  document.getElementById('hud-maneuver-card').classList.remove('hidden');
  document.getElementById('bottom-nav-bar').classList.remove('hidden');
  document.getElementById('lane-guidance-pill').classList.remove('hidden');

  document.getElementById('maneuver-dist').textContent = route.distance;
  document.getElementById('maneuver-street').textContent = route.name;

  document.getElementById('nav-duration').textContent = route.duration;
  document.getElementById('nav-distance').textContent = route.distance;
  document.getElementById('nav-eta').textContent = route.eta;
}

function updateManeuverHud(m) {
  document.getElementById('maneuver-dist').textContent = m.distance;
  if (m.instruction) {
    document.getElementById('maneuver-street').textContent = m.instruction;
  }

  // Arrow symbol
  const arrowBox = document.getElementById('maneuver-arrow-box');
  if (m.modifier && m.modifier.includes('left')) arrowBox.textContent = '↰';
  else if (m.modifier && m.modifier.includes('right')) arrowBox.textContent = '↱';
  else if (m.modifier && m.modifier.includes('uturn')) arrowBox.textContent = '↺';
  else arrowBox.textContent = '↑';

  // Distance countdown for camera alert badge
  const camDist = Math.max(80, (m.distanceMeters || 370) - 40);
  document.getElementById('camera-alert-dist').textContent = `${camDist} м`;
}

function cancelActiveNavigation() {
  document.getElementById('hud-maneuver-card').classList.add('hidden');
  document.getElementById('bottom-nav-bar').classList.add('hidden');
  document.getElementById('lane-guidance-pill').classList.add('hidden');
  selectedDestination = null;
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
      ytIframe.src = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&enablejsapi=1`;
    }
    isMusicPlaying = true;
    if (btnMusicPlay) btnMusicPlay.textContent = '⏸';
  }

  function handleYtSearch() {
    const q = ytSearchInput.value.trim();
    if (!q) return;

    // Check if query is direct YouTube video ID or URL
    let videoId = q;
    const urlMatch = q.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
    if (urlMatch && urlMatch[1]) {
      videoId = urlMatch[1];
      playTrackById(videoId, q);
    } else {
      // Use YouTube embed search playlist
      if (ytIframe) {
        ytIframe.src = `https://www.youtube-nocookie.com/embed?listType=search&list=${encodeURIComponent(q)}&autoplay=1&enablejsapi=1`;
      }
      isMusicPlaying = true;
      if (btnMusicPlay) btnMusicPlay.textContent = '⏸';
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
