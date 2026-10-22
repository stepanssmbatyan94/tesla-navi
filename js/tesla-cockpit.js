// Tesla Navi Cockpit Controller (Mapsev & Yandex Navigator Architecture)

let mapEngine = null;
let realtimeClient = null;
let currentCode = '';
let selectedDestination = null;
let currentLang = 'ru';
let activeChargersMarkers = [];
let chargersVisible = false;
let pendingGpsFix = null;
let hasReceivedRealGps = false;

// YouTube Queue & Player State (Dynamic, no hardcoded tracks)
let youtubeQueue = [];
let currentTrackIndex = -1;
let isMusicPlaying = false;
let currentTrackInfo = null;
let currentYtQuery = '';
let currentYtContinuationToken = null;
let isYtLoadingMore = false;

// Yerevan EV Supercharging Stations Hubs (CPS, Flash, PlugShare, Dalma)
const EV_CHARGERS = [
  { name: 'Dalma Garden Mall Supercharger', lat: 40.180200, lng: 44.482000, power: '150 kW', stalls: '4/6 свободно', address: 'Tsitsernakaberd Hwy, Yerevan' },
  { name: 'Tesla Supercharger Yerevan (Flash)', lat: 40.192000, lng: 44.475000, power: '150 kW', stalls: '3/4 свободно', address: 'Halabyan St, Yerevan' },
  { name: 'EV Motors Fast Hub (Kievyan St)', lat: 40.198500, lng: 44.493000, power: '120 kW', stalls: '2/2 свободно', address: 'Kievyan St 8, Yerevan' },
  { name: 'CPS Electric Charging Hub (Halabyan)', lat: 40.187000, lng: 44.471000, power: '60 kW', stalls: '1/2 свободно', address: 'Halabyan St 38, Yerevan' },
  { name: 'MegaMall Fast Charger Hub', lat: 40.196300, lng: 44.561000, power: '120 kW', stalls: '4/4 свободно', address: 'Gai Ave 16, Nor Nork' },
  { name: 'Rio Mall EV Hub (Vahram Papazyan)', lat: 40.201200, lng: 44.508500, power: '60 kW', stalls: '2/2 свободно', address: 'Vahram Papazyan St 8, Yerevan' },
  { name: 'Yerevan Mall Supercharger Hub', lat: 40.155800, lng: 44.501500, power: '120 kW', stalls: '3/4 свободно', address: 'Arshakunyats Ave 34/3, Yerevan' },
  { name: 'SAS Foodland Fast Charger (Baghramyan)', lat: 40.191200, lng: 44.501500, power: '50 kW', stalls: '1/2 свободно', address: 'Baghramyan Ave 85, Yerevan' },
  { name: 'Zvartnots Airport EV Supercharger', lat: 40.147500, lng: 44.398000, power: '120 kW', stalls: '4/6 свободно', address: 'Zvartnots International Airport' },
  { name: 'Northern Avenue Hub (Center)', lat: 40.182200, lng: 44.514000, power: '50 kW', stalls: '2/2 свободно', address: 'Northern Ave, Yerevan' },
  { name: 'Cascade Plaza EV Hub', lat: 40.191500, lng: 44.515200, power: '60 kW', stalls: '1/2 свободно', address: 'Antarayin St 160, Yerevan' }
];

// Global hooks
window.updateManeuverHud = updateManeuverHud;
window.renderLaneGuidance = renderLaneGuidance;

async function initTeslaCockpit() {
  console.log('🚗 Initializing Tesla Navi Automotive Cockpit...');
  window.updateManeuverHud = updateManeuverHud;
  window.renderLaneGuidance = renderLaneGuidance;

  // Universal Audio Pipeline Unlock for Tesla Browser Autoplay Policy
  const unlockAudioPipeline = () => {
    try {
      const silentAudio = new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA');
      silentAudio.play().catch(() => {});
      if (window.AudioContext || window.webkitAudioContext) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const dummy = new AudioCtx();
        dummy.resume().then(() => dummy.close()).catch(() => {});
      }
    } catch (e) {}
    window.removeEventListener('pointerdown', unlockAudioPipeline);
    window.removeEventListener('touchstart', unlockAudioPipeline);
    window.removeEventListener('click', unlockAudioPipeline);
  };
  window.addEventListener('pointerdown', unlockAudioPipeline, { once: true, passive: true });
  window.addEventListener('touchstart', unlockAudioPipeline, { once: true, passive: true });
  window.addEventListener('click', unlockAudioPipeline, { once: true, passive: true });

  // 1. Language Setup & Voice Selector
  initLanguage();
  initVoiceSelector();

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
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initTeslaCockpit);
} else {
  initTeslaCockpit();
}

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

    if (mapEngine) {
      if (currentLang === 'hy') {
        const savedVoice = localStorage.getItem('tesla_navi_voice') || 'female';
        const isMale = (savedVoice === 'male' || savedVoice === 'dmitry' || savedVoice === 'gor' || savedVoice === 'andrew');
        mapEngine.speakVoice('welcome', isMale ? 'gor' : 'suzie');
      } else if (currentLang === 'en') {
        mapEngine.speakVoice('Voice navigation switched to Ava.', 'ava');
      } else {
        const v = window.CURRENT_VOICE || 'svetlana';
        const msg = (v === 'male' || v === 'dmitry') ? 'Голос изменён на Дмитрий.' : 'Голос изменён на Светлана.';
        mapEngine.speakVoice(msg, (v === 'male' || v === 'dmitry') ? 'dmitry' : 'svetlana');
      }
    }
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

  updateVoiceIndicator(window.CURRENT_VOICE || 'female');
}

// 1.5 Voice Management (Female 👩 / Male 👨 across RU, HY, EN)
function initVoiceSelector() {
  let currentVoice = localStorage.getItem('tesla_navi_voice') || 'female';
  window.CURRENT_VOICE = currentVoice;
  updateVoiceIndicator(currentVoice);

  const voiceBtn = document.getElementById('btn-voice-toggle');
  if (voiceBtn) {
    voiceBtn.addEventListener('click', () => {
      const isCurrentlyFemale = (currentVoice === 'female' || currentVoice === 'svetlana' || currentVoice === 'suzie' || currentVoice === 'ava');
      currentVoice = isCurrentlyFemale ? 'male' : 'female';
      localStorage.setItem('tesla_navi_voice', currentVoice);
      window.CURRENT_VOICE = currentVoice;
      updateVoiceIndicator(currentVoice);

      if (mapEngine) {
        const lang = window.CURRENT_LANG || 'ru';
        if (lang === 'hy') {
          const hyVoice = (currentVoice === 'male') ? 'gor' : 'suzie';
          mapEngine.speakVoice('voice_switched', hyVoice);
        } else if (lang === 'en') {
          const phrase = currentVoice === 'male'
            ? 'Voice switched to Andrew'
            : 'Voice switched to Ava';
          mapEngine.speakVoice(phrase, currentVoice === 'male' ? 'andrew' : 'ava');
        } else {
          const phrase = currentVoice === 'male'
            ? 'Голос изменён на Дмитрий. Приятной дороги!'
            : 'Голос изменён на Светлана. Приятной дороги!';
          mapEngine.speakVoice(phrase, currentVoice === 'male' ? 'dmitry' : 'svetlana');
        }
      }
    });
  }
}

function updateVoiceIndicator(voice) {
  const ind = document.getElementById('voice-indicator');
  if (ind) {
    const isMale = (voice === 'male' || voice === 'dmitry' || voice === 'gor' || voice === 'andrew');
    const lang = window.CURRENT_LANG || 'ru';
    ind.style.whiteSpace = 'nowrap';
    if (lang === 'hy') {
      ind.textContent = isMale ? '👨 Գոռ' : '👩 Սյուզի';
      ind.style.fontSize = isMale ? '11px' : '10px';
      ind.title = isMale ? 'Ձայն: Գոռ (Արական, նեյրոնային)' : 'Ձայն: Սյուզի (Իգական, նեյրոնային)';
    } else if (lang === 'en') {
      ind.textContent = isMale ? '👨 EN' : '👩 EN';
      ind.style.fontSize = '12px';
      ind.title = isMale ? 'Voice: Andrew (Male)' : 'Voice: Ava (Female)';
    } else {
      ind.textContent = isMale ? '👨' : '👩';
      ind.style.fontSize = '16px';
      ind.title = isMale ? 'Голос: Дмитрий (Мужской)' : 'Голос: Светлана (Женский)';
    }
  }
}

// Speedometer & Overspeed Alert Manager
let lastOverspeedChimeTime = 0;

function updateSpeedometerDisplay(speedKmh) {
  const currentSpeed = Math.max(0, Math.round(speedKmh || 0));
  const speedEl = document.getElementById('speed-current');
  if (speedEl) speedEl.textContent = currentSpeed;

  const circleEl = document.querySelector('.speed-current-circle');
  const limitEl = document.getElementById('speed-limit-val');
  const speedLimit = limitEl ? (parseInt(limitEl.textContent, 10) || 60) : 60;

  // Visual warning: red pulse starts as soon as exceeding limit (e.g. 61+ at limit 60)
  const isOverLimit = currentSpeed > speedLimit;

  // Audio chime warning: strictly when speed exceeds limit + 10 km/h (e.g. 71+ at limit 60)
  const isAudioWarning = currentSpeed >= (speedLimit + 11);

  if (circleEl) {
    if (isOverLimit) {
      circleEl.classList.add('overspeed');
    } else {
      circleEl.classList.remove('overspeed');
    }
  }

  // Overspeed Warning Sound: throttled to once every 12s, strictly at limit + 11 km/h (e.g. 71 at 60)
  if (isAudioWarning && mapEngine && mapEngine.voiceEnabled) {
    const now = Date.now();
    if (now - lastOverspeedChimeTime > 12000) {
      lastOverspeedChimeTime = now;
      mapEngine.playNavChime();
    }
  }
}

function updateGpsStatusUI() {
  const banner = document.getElementById('gps-status-banner');
  if (!banner) return;
  if (hasReceivedRealGps) {
    banner.classList.add('hidden');
  } else {
    banner.classList.remove('hidden');
  }
}

// 2. Direct In-Car Tesla Browser Geolocation
function initTeslaCarGps() {
  if (!('geolocation' in navigator)) {
    console.warn('Geolocation not supported in this browser');
    updateGpsStatusUI();
    return;
  }

  navigator.geolocation.watchPosition(
    (pos) => {
      const coords = pos.coords;
      const speedKmh = coords.speed ? Math.round(coords.speed * 3.6) : 0;
      const heading = coords.heading || 0;

      hasReceivedRealGps = true;
      pendingGpsFix = { lat: coords.latitude, lng: coords.longitude, heading, speed: speedKmh };
      updateGpsStatusUI();

      try {
        localStorage.setItem('tesla_last_coords', JSON.stringify({ lat: Number(coords.latitude), lng: Number(coords.longitude) }));
      } catch (e) {}

      // Update cluster speedometer with overspeed check
      updateSpeedometerDisplay(speedKmh);

      // Update telemetry
      const telLat = document.getElementById('tel-lat');
      const telLng = document.getElementById('tel-lng');
      const telAcc = document.getElementById('tel-accuracy');
      const telAge = document.getElementById('tel-age');
      if (telLat) telLat.textContent = Number(coords.latitude).toFixed(4);
      if (telLng) telLng.textContent = Number(coords.longitude).toFixed(4);
      if (telAcc) telAcc.textContent = `±${Math.round(coords.accuracy || 3)} м`;
      if (telAge) telAge.textContent = `4 мс`;

      // Pass directly to Map Engine
      if (mapEngine) {
        mapEngine.updateCarPosition(coords.latitude, coords.longitude, heading, speedKmh, true);
      }
    },
    (err) => {
      console.log('[In-Car GPS] Geolocation status:', err.message);
      if (!hasReceivedRealGps) {
        const telAcc = document.getElementById('tel-accuracy');
        if (telAcc) telAcc.textContent = 'Ожидание...';
        updateGpsStatusUI();
      }
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
  if (!gps || isNaN(gps.lat) || isNaN(gps.lng)) return;
  const speedKmh = Math.round((gps.speed || 0) * 3.6);
  updateSpeedometerDisplay(speedKmh);

  hasReceivedRealGps = true;
  pendingGpsFix = { lat: gps.lat, lng: gps.lng, heading: gps.heading || 0, speed: speedKmh };
  updateGpsStatusUI();

  try {
    localStorage.setItem('tesla_last_coords', JSON.stringify({ lat: Number(gps.lat), lng: Number(gps.lng) }));
  } catch (e) {}

  const telLat = document.getElementById('tel-lat');
  const telLng = document.getElementById('tel-lng');
  const telAcc = document.getElementById('tel-accuracy');
  const telAge = document.getElementById('tel-age');
  if (telLat) telLat.textContent = Number(gps.lat).toFixed(4);
  if (telLng) telLng.textContent = Number(gps.lng).toFixed(4);
  if (telAcc) telAcc.textContent = `±${Math.round(gps.accuracy || 3)} м`;
  if (telAge) telAge.textContent = `12 мс`;

  if (mapEngine) {
    mapEngine.updateCarPosition(gps.lat, gps.lng, gps.heading || 0, speedKmh, true);
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
    // Auto-minimize pairing modal ONLY if real GPS has been received
    if (hasReceivedRealGps) {
      setTimeout(() => {
        document.getElementById('pairing-modal').classList.add('hidden');
      }, 1200);
    }
  } else {
    dot.classList.remove('connected');
    statusText.textContent = dict.waitingPhone;
    statusText.style.color = 'var(--accent-amber)';
  }
  updateGpsStatusUI();
}

// ==========================================================================
// Saved Places Manager: Home, Work & Favorites (Mapsev & Yandex Architecture)
// ==========================================================================
const DEFAULT_SAVED_PLACES = {
  home: { name: 'Дом', address: 'Hakob Hakobyan Street, 1', lat: 40.1970, lng: 44.4930 },
  work: { name: 'Работа', address: 'Valem hamatirutyun', lat: 40.1982, lng: 44.4925 },
  favorites: [
    { id: 'fav_resort', name: 'Aghveran Ararat Resort', address: 'Aghveran Resort Zone', icon: '🎓', lat: 40.5050, lng: 44.5820 },
    { id: 'fav_valem', name: 'Valem hamatirutyun', address: 'Hakob Hakobyan St', icon: '🏢', lat: 40.1982, lng: 44.4925 },
    { id: 'fav_dalma', name: 'Dalma Garden Mall', address: 'Цицернакабердское шоссе, 3', icon: '🛍️', lat: 40.1802, lng: 44.4842 },
    { id: 'fav_ymall', name: 'Yerevan Mall', address: 'проспект Аршакуняц, 34', icon: '🛍️', lat: 40.1534, lng: 44.5026 }
  ]
};

let userSavedPlaces = loadSavedPlaces();

function loadSavedPlaces() {
  try {
    const raw = localStorage.getItem('tesla_saved_places');
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        home: (parsed.home && parsed.home.address && parsed.home.lat != null) ? parsed.home : DEFAULT_SAVED_PLACES.home,
        work: (parsed.work && parsed.work.address && parsed.work.lat != null) ? parsed.work : DEFAULT_SAVED_PLACES.work,
        favorites: (Array.isArray(parsed.favorites) && parsed.favorites.length > 0) ? parsed.favorites : DEFAULT_SAVED_PLACES.favorites
      };
    }
  } catch (e) {
    console.warn('Error loading saved places from localStorage:', e);
  }
  return JSON.parse(JSON.stringify(DEFAULT_SAVED_PLACES));
}

function savePlacesToStorage() {
  try {
    localStorage.setItem('tesla_saved_places', JSON.stringify(userSavedPlaces));
  } catch (e) {
    console.warn('Error saving places to localStorage:', e);
  }
  renderAllSavedPlacesUI();
}

function isLocationInFavorites(lat, lng, name) {
  if (!userSavedPlaces.favorites) return false;
  return userSavedPlaces.favorites.some(f => {
    if (f.lat && f.lng && lat && lng && Math.abs(f.lat - lat) < 0.0003 && Math.abs(f.lng - lng) < 0.0003) return true;
    if (f.name && name && f.name.toLowerCase() === name.toLowerCase()) return true;
    return false;
  });
}

function toggleFavoritePlace(place) {
  if (!userSavedPlaces.favorites) userSavedPlaces.favorites = [];
  const idx = userSavedPlaces.favorites.findIndex(f => {
    if (f.lat && f.lng && place.lat && place.lng && Math.abs(f.lat - place.lat) < 0.0003 && Math.abs(f.lng - place.lng) < 0.0003) return true;
    if (f.name && place.name && f.name.toLowerCase() === place.name.toLowerCase()) return true;
    return false;
  });

  if (idx >= 0) {
    userSavedPlaces.favorites.splice(idx, 1);
  } else {
    userSavedPlaces.favorites.push({
      id: 'fav_' + Date.now(),
      name: place.name || place.title || 'Избранное',
      address: place.address || place.subtitle || 'Ереван',
      lat: place.lat,
      lng: place.lng
    });
  }
  savePlacesToStorage();
}

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
  let activeProvider = urlParams.get('provider') || localStorage.getItem('tesla_map_provider_v2') || (CONFIG && CONFIG.defaultProvider) || 'maplibre';
  if (activeProvider === 'osm') {
    activeProvider = 'maplibre';
  }
  try {
    localStorage.setItem('tesla_map_provider_v2', activeProvider);
  } catch (e) {}

  let startCenter = CONFIG.defaultCenter;
  try {
    const savedLastCoords = localStorage.getItem('tesla_last_coords');
    if (savedLastCoords) {
      const parsed = JSON.parse(savedLastCoords);
      if (parsed && !isNaN(parsed.lat) && !isNaN(parsed.lng)) {
        startCenter = { lat: parsed.lat, lng: parsed.lng, zoom: CONFIG.navigationZoom || 16.5 };
      }
    }
  } catch (e) {}

  if (pendingGpsFix) {
    startCenter = { lat: pendingGpsFix.lat, lng: pendingGpsFix.lng, zoom: CONFIG.navigationZoom || 16.5 };
  }

  mapEngine = new TeslaMapEngine('map-container', {
    provider: activeProvider,
    center: startCenter,
    onRouteCalculated: (route) => {
      showRouteAlternativesDrawer(route);
    },
    onManeuverUpdate: (maneuver) => {
      updateManeuverHud(maneuver);
    },
    onArrival: (destination) => {
      showArrivalModal(destination);
    },
    onPositionUpdate: (pos) => {
      updateCommuteEtas();
    },
    onUserPan: () => {
      const recenterBtn = document.getElementById('floating-recenter-btn');
      if (recenterBtn) recenterBtn.classList.remove('hidden');
    },
    onProgressUpdate: (progress) => {
      const knob = document.getElementById('nav-progress-car-knob');
      const cursor = document.getElementById('prog-car-cursor');
      const traveledFill = document.getElementById('prog-traveled-fill');
      if (typeof progress === 'object') {
        const pct = Math.min(100, Math.max(0, progress.percent !== undefined ? progress.percent : 0));
        if (knob) knob.style.left = `${pct}%`;
        if (cursor) cursor.style.left = `${Math.min(96, pct)}%`;
        if (traveledFill) traveledFill.style.width = `${pct}%`;
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
      } else {
        const pct = Math.min(100, Math.max(0, progress || 0));
        if (knob) knob.style.left = `${pct}%`;
        if (cursor) cursor.style.left = `${Math.min(96, pct)}%`;
        if (traveledFill) traveledFill.style.width = `${pct}%`;
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
  window.mapEngine = mapEngine;

  if (pendingGpsFix) {
    mapEngine.updateCarPosition(pendingGpsFix.lat, pendingGpsFix.lng, pendingGpsFix.heading, pendingGpsFix.speed, true);
  }
  updateGpsStatusUI();

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

  // Sound / Voice Mute Toggle (Mapsev Style: Black Speaker ON / Electric Blue Slash OFF)
  function updateSoundButtonState(voiceOn) {
    const btn = document.getElementById('btn-sound-toggle');
    if (!btn) return;
    btn.classList.toggle('muted', !voiceOn);
    if (voiceOn) {
      btn.innerHTML = `
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#1e293b" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="#1e293b"></polygon>
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
        </svg>
      `;
      btn.title = 'Звук включен';
    } else {
      btn.innerHTML = `
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#0066ff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="#0066ff"></polygon>
          <line x1="22" y1="2" x2="2" y2="22" stroke="#0066ff" stroke-width="2.6"></line>
        </svg>
      `;
      btn.title = 'Звук выключен';
    }
  }

  const btnSoundToggle = document.getElementById('btn-sound-toggle');
  if (btnSoundToggle) {
    btnSoundToggle.addEventListener('click', () => {
      if (mapEngine) {
        const voiceOn = mapEngine.toggleVoice();
        updateSoundButtonState(voiceOn);
      }
    });
  }

  // Quick EV Chargers button in top-right cluster
  const btnQuickChargers = document.getElementById('btn-quick-chargers');
  if (btnQuickChargers) {
    btnQuickChargers.addEventListener('click', () => {
      const btnChargers = document.getElementById('btn-toggle-chargers');
      if (btnChargers) btnChargers.click();
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
  const card2 = document.getElementById('route-card-2');
  if (card0) {
    card0.addEventListener('click', () => {
      card0.classList.add('active');
      if (card1) card1.classList.remove('active');
      if (card2) card2.classList.remove('active');
      if (mapEngine) mapEngine.selectRouteIndex(0);
    });
  }
  if (card1) {
    card1.addEventListener('click', () => {
      card1.classList.add('active');
      if (card0) card0.classList.remove('active');
      if (card2) card2.classList.remove('active');
      if (mapEngine) mapEngine.selectRouteIndex(1);
    });
  }
  if (card2) {
    card2.addEventListener('click', () => {
      card2.classList.add('active');
      if (card0) card0.classList.remove('active');
      if (card1) card1.classList.remove('active');
      if (mapEngine) mapEngine.selectRouteIndex(2);
    });
  }

  const btnCloseAltDrawer = document.getElementById('btn-close-alt-drawer');
  if (btnCloseAltDrawer) {
    btnCloseAltDrawer.addEventListener('click', () => {
      document.body.classList.remove('route-options-open');
      if (!mapEngine || !mapEngine.isNavigating) {
        document.getElementById('quick-dest-bar')?.classList.remove('hidden');
      }
      document.getElementById('route-alternatives-drawer').classList.add('hidden');
    });
  }

  // "Go / Поехали" Action Button (Starts active turn-by-turn navigation)
  const btnStartRouteNav = document.getElementById('btn-start-route-nav');
  if (btnStartRouteNav) {
    const handleStartNav = (e) => {
      if (e) e.preventDefault();
      document.body.classList.remove('route-options-open');
      document.body.classList.add('navigating');
      document.getElementById('quick-dest-bar')?.classList.add('hidden');
      document.getElementById('route-alternatives-drawer')?.classList.add('hidden');
      if (currentRouteInfo) {
        showNavigationHud(currentRouteInfo);
      } else if (mapEngine && mapEngine.activeRoute) {
        const fallbackRoute = {
          duration: '15 мин',
          distance: `${((mapEngine.totalDistance || 1000) / 1000).toFixed(1)} км`,
          eta: '18:45',
          name: mapEngine.activeRoute.destination?.name || 'Маршрут',
          steps: mapEngine.routeSteps || [],
          trafficSegments: mapEngine.trafficSegments || []
        };
        showNavigationHud(fallbackRoute);
      }
      if (mapEngine) {
        mapEngine.startNavigation(); // Activates movement tracking, audio cue & off-route rerouting
        mapEngine.recenter();
      }
    };
    btnStartRouteNav.addEventListener('click', handleStartNav);
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

  // Commute Bookmarks: Home / Work (Click to Navigate, ✏️ to Edit/Delete)
  const homeBtn = document.getElementById('commute-home');
  const workBtn = document.getElementById('commute-work');
  const btnEditHome = document.getElementById('btn-edit-home');
  const btnEditWork = document.getElementById('btn-edit-work');
  const favBar = document.getElementById('commute-favorites-bar');

  if (homeBtn) {
    homeBtn.addEventListener('click', (e) => {
      if (e.target.closest('#btn-edit-home')) return;
      if (userSavedPlaces.home) {
        searchDrawer.classList.add('hidden');
        startNavigationTo(userSavedPlaces.home);
      } else {
        openEditPlaceModal('home');
      }
    });
  }

  if (workBtn) {
    workBtn.addEventListener('click', (e) => {
      if (e.target.closest('#btn-edit-work')) return;
      if (userSavedPlaces.work) {
        searchDrawer.classList.add('hidden');
        startNavigationTo(userSavedPlaces.work);
      } else {
        openEditPlaceModal('work');
      }
    });
  }

  if (btnEditHome) {
    btnEditHome.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditPlaceModal('home');
    });
  }

  if (btnEditWork) {
    btnEditWork.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditPlaceModal('work');
    });
  }

  if (favBar) {
    favBar.addEventListener('click', () => {
      searchDrawer.classList.add('hidden');
      openMyPlacesDrawer(true);
    });
  }

  // My Places Drawer (Mapsev Screenshot 1)
  const btnOpenMyPlaces = document.getElementById('btn-open-my-places');
  const myPlacesDrawer = document.getElementById('my-places-drawer');
  const btnCloseMyPlaces = document.getElementById('btn-close-my-places');
  const btnCloseFavView = document.getElementById('btn-close-fav-view');
  const btnBackToPlaces = document.getElementById('btn-back-to-places');
  const myPlaceFavRow = document.getElementById('my-place-favorites-row');
  const btnAddNewFav = document.getElementById('btn-add-new-favorite');

  if (btnOpenMyPlaces) {
    btnOpenMyPlaces.addEventListener('click', () => {
      const isHidden = myPlacesDrawer.classList.contains('hidden');
      if (isHidden) {
        openMyPlacesDrawer(false);
      } else {
        closeMyPlacesDrawer();
      }
    });
  }

  if (btnCloseMyPlaces) btnCloseMyPlaces.addEventListener('click', closeMyPlacesDrawer);
  if (btnCloseFavView) btnCloseFavView.addEventListener('click', closeMyPlacesDrawer);

  if (myPlaceFavRow) {
    myPlaceFavRow.addEventListener('click', () => {
      showMyPlacesView('favorites');
    });
  }

  if (btnBackToPlaces) {
    btnBackToPlaces.addEventListener('click', () => {
      showMyPlacesView('main');
    });
  }

  if (btnAddNewFav) {
    btnAddNewFav.addEventListener('click', () => {
      openEditPlaceModal('favorite');
    });
  }

  // Initialize modal handlers and render UI
  initEditPlaceModalHandlers();
  renderAllSavedPlacesUI();

  // Phone Pairing Modal
  const btnOpenPairing = document.getElementById('btn-open-pairing');
  const pairingModal = document.getElementById('pairing-modal');
  const btnClosePairingX = document.getElementById('btn-close-pairing-x');
  const btnPairingDone = document.getElementById('btn-pairing-done');

  btnOpenPairing.addEventListener('click', () => {
    pairingModal.classList.remove('hidden');
  });
  const gpsStatusBanner = document.getElementById('gps-status-banner');
  if (gpsStatusBanner) {
    gpsStatusBanner.addEventListener('click', () => {
      pairingModal.classList.remove('hidden');
    });
  }
  [btnClosePairingX, btnPairingDone].forEach(btn => {
    btn.addEventListener('click', () => pairingModal.classList.add('hidden'));
  });

  // More Tools Flyout Popover ("•••" Button)
  const btnMoreTools = document.getElementById('btn-more-tools');
  const moreToolsPopover = document.getElementById('more-tools-popover');
  const btnCloseMoreTools = document.getElementById('btn-close-more-tools');

  if (btnMoreTools && moreToolsPopover) {
    btnMoreTools.addEventListener('click', (e) => {
      e.stopPropagation();
      moreToolsPopover.classList.toggle('hidden');
      btnMoreTools.classList.toggle('active', !moreToolsPopover.classList.contains('hidden'));
    });

    if (btnCloseMoreTools) {
      btnCloseMoreTools.addEventListener('click', (e) => {
        e.stopPropagation();
        moreToolsPopover.classList.add('hidden');
        btnMoreTools.classList.remove('active');
      });
    }

    document.addEventListener('click', (e) => {
      if (!moreToolsPopover.classList.contains('hidden') && !e.target.closest('#more-tools-popover') && !e.target.closest('#btn-more-tools')) {
        moreToolsPopover.classList.add('hidden');
        btnMoreTools.classList.remove('active');
      }
    });

    // Auto-close popover when opening modals or actions
    ['btn-toggle-chargers', 'btn-open-weather', 'btn-open-pairing', 'btn-lang-toggle', 'btn-voice-toggle', 'btn-toggle-provider'].forEach(id => {
      document.getElementById(id)?.addEventListener('click', () => {
        if (id === 'btn-open-weather' || id === 'btn-open-pairing') {
          moreToolsPopover.classList.add('hidden');
          btnMoreTools.classList.remove('active');
        }
      });
    });
  }

  // Map Engine Switcher: MapsEV MapLibre 3D Vector vs Yandex Live Traffic (Яндекс)
  const btnToggleProvider = document.getElementById('btn-toggle-provider');
  const providerIndicator = document.getElementById('provider-indicator');
  const activeProv = new URLSearchParams(window.location.search).get('provider') || localStorage.getItem('tesla_map_provider_v2') || (CONFIG && CONFIG.defaultProvider) || 'maplibre';
  if (providerIndicator) {
    providerIndicator.textContent = activeProv === 'yandex' ? 'ЯН' : 'ML';
    providerIndicator.style.color = activeProv === 'yandex' ? '#ef4444' : '#38bdf8';
  }
  if (btnToggleProvider) {
    btnToggleProvider.title = activeProv === 'yandex'
      ? 'Карта: Яндекс (пробки). Нажмите для переключения на MapsEV MapLibre 3D'
      : 'Карта: MapsEV MapLibre 3D. Нажмите для переключения на Яндекс';

    btnToggleProvider.addEventListener('click', () => {
      const currentUrlProv = new URLSearchParams(window.location.search).get('provider');
      const cur = currentUrlProv || localStorage.getItem('tesla_map_provider_v2') || (CONFIG && CONFIG.defaultProvider) || 'maplibre';
      const nextProv = (cur === 'yandex') ? 'maplibre' : 'yandex';
      try {
        localStorage.setItem('tesla_map_provider_v2', nextProv);
      } catch (e) {}
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

  // 2D / 3D Mode Toggle (MapsEV Isometric Cube Switcher)
  const btnToggle2D3D = document.getElementById('btn-toggle-2d3d');
  const btn3DModeLabel = document.getElementById('btn-3d-mode-label');
  const saved3D = localStorage.getItem('tesla_map_3d_mode');
  const isInitial3D = saved3D !== null ? saved3D === '3d' : true;
  if (btnToggle2D3D) {
    btnToggle2D3D.classList.toggle('is-3d', isInitial3D);
    if (btn3DModeLabel) btn3DModeLabel.textContent = isInitial3D ? '3D' : '2D';
    btnToggle2D3D.title = isInitial3D ? 'Переключить в 2D плоский вид' : 'Переключить в 3D перспективный вид';
    btnToggle2D3D.addEventListener('click', () => {
      if (mapEngine && typeof mapEngine.toggle2D3D === 'function') {
        const is3D = mapEngine.toggle2D3D();
        btnToggle2D3D.classList.toggle('is-3d', is3D);
        if (btn3DModeLabel) btn3DModeLabel.textContent = is3D ? '3D' : '2D';
        btnToggle2D3D.title = is3D ? 'Переключить в 2D плоский вид' : 'Переключить в 3D перспективный вид';
      }
    });
  }

  // Day / Night / Auto Theme Toggle Handlers (MapsEV Architecture)
  const btnToggleTheme = document.getElementById('btn-toggle-theme');
  const btnMenuThemeToggle = document.getElementById('btn-menu-theme-toggle');

  function handleThemeCycle() {
    if (mapEngine && typeof mapEngine.cycleTheme === 'function') {
      mapEngine.cycleTheme();
    }
  }

  if (btnToggleTheme) {
    btnToggleTheme.addEventListener('click', handleThemeCycle);
  }
  if (btnMenuThemeToggle) {
    btnMenuThemeToggle.addEventListener('click', handleThemeCycle);
  }

  // EV Charging Stations Drawer & Battery Pill Handlers (Mapsev Reference)
  initChargingStationsDrawer();

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
  if (!current) return;
  ['home', 'work'].forEach(key => {
    const loc = userSavedPlaces[key];
    const badge = document.getElementById(`${key}-eta-badge`);
    if (!loc) {
      if (badge) {
        badge.textContent = '+ Задать';
        badge.className = 'commute-add-badge';
      }
      return;
    }
    const distMeters = mapEngine.calculateDistance(current.lat, current.lng, loc.lat, loc.lng);
    const speedMps = 8.5; // ~30 km/h city average
    const durationMin = Math.max(3, Math.round(distMeters / (speedMps * 60)));
    const distStr = distMeters >= 1000 ? `${(distMeters / 1000).toFixed(1)} км` : `${Math.round(distMeters)} м`;
    if (badge) {
      badge.textContent = `${durationMin} мин • ${distStr}`;
      badge.className = 'commute-eta-badge';
    }
  });

  renderQuickDestChips();
}

// Authentic MapsEV Destination Chips: Home, Work & Favorites with Live GPS Distances & 1-Tap Route
function renderQuickDestChips() {
  const container = document.getElementById('quick-dest-chips');
  if (!container) return;

  const cur = (mapEngine && mapEngine.currentPosition) ? mapEngine.currentPosition : null;
  const chipsList = [];

  // 1. Home
  const homePlace = userSavedPlaces.home || DEFAULT_SAVED_PLACES.home;
  if (homePlace) {
    chipsList.push({
      type: 'home',
      icon: '🏠',
      title: homePlace.name || 'Дом',
      place: homePlace
    });
  }

  // 2. Work
  const workPlace = userSavedPlaces.work || DEFAULT_SAVED_PLACES.work;
  if (workPlace) {
    chipsList.push({
      type: 'work',
      icon: '💼',
      title: workPlace.name || 'Работа',
      place: workPlace
    });
  }

  // 3. Favorites / Recent Places
  const favs = (userSavedPlaces.favorites && userSavedPlaces.favorites.length > 0)
    ? userSavedPlaces.favorites
    : DEFAULT_SAVED_PLACES.favorites;

  favs.forEach(f => {
    chipsList.push({
      type: 'favorite',
      icon: f.icon || '📍',
      title: f.name || f.address,
      place: f
    });
  });

  container.innerHTML = '';
  chipsList.forEach(item => {
    let distStr = '';
    if (cur && item.place && item.place.lat != null && item.place.lng != null) {
      const d = mapEngine.calculateDistance(cur.lat, cur.lng, item.place.lat, item.place.lng);
      if (d < 50) {
        distStr = '0 м';
      } else if (d < 1000) {
        distStr = `${Math.round(d / 10) * 10} м`;
      } else {
        distStr = `${(d / 1000).toFixed(1)} км`;
      }
    }

    const btn = document.createElement('button');
    btn.className = 'quick-dest-chip';
    btn.setAttribute('type', 'button');
    btn.dataset.dest = item.type;
    btn.title = `Построить маршрут: ${item.title}`;
    btn.innerHTML = `
      <span class="chip-ico">${item.icon}</span>
      <span class="chip-title">${item.title}</span>
      ${distStr ? `<span class="chip-dist">${distStr}</span>` : ''}
    `;

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log('📍 Quick destination tapped:', item.title, item.place);
      if (item.place && item.place.lat && item.place.lng) {
        startNavigationTo(item.place);
      } else if (item.type === 'home' || item.type === 'work') {
        openEditPlaceModal(item.type);
      }
    });

    container.appendChild(btn);
  });
}

function renderAllSavedPlacesUI() {
  // 1. Update Search Drawer Commute Tiles (Strict 2-Column Grid: Home & Work always visible)
  const homeTileEl = document.getElementById('commute-home');
  const workTileEl = document.getElementById('commute-work');
  if (homeTileEl) homeTileEl.style.display = 'flex';
  if (workTileEl) workTileEl.style.display = 'flex';

  const homeTitle = document.getElementById('home-title-text');
  const homeSub = document.getElementById('home-address-sub');
  const homeBadge = document.getElementById('home-eta-badge');
  const btnEditHome = document.getElementById('btn-edit-home');

  if (userSavedPlaces.home) {
    if (homeTitle) homeTitle.textContent = userSavedPlaces.home.name || 'Дом';
    if (homeSub) {
      homeSub.textContent = userSavedPlaces.home.address;
      homeSub.style.color = '#64748b';
    }
    if (btnEditHome) btnEditHome.classList.remove('hidden');
  } else {
    if (homeTitle) homeTitle.textContent = 'Дом';
    if (homeSub) {
      homeSub.textContent = '+ Задать адрес';
      homeSub.style.color = '#94a3b8';
    }
    if (homeBadge) {
      homeBadge.textContent = '+ Задать';
      homeBadge.className = 'commute-add-badge';
    }
    if (btnEditHome) btnEditHome.classList.remove('hidden');
  }

  const workTitle = document.getElementById('work-title-text');
  const workSub = document.getElementById('work-address-sub');
  const workBadge = document.getElementById('work-eta-badge');
  const btnEditWork = document.getElementById('btn-edit-work');

  if (userSavedPlaces.work) {
    if (workTitle) workTitle.textContent = userSavedPlaces.work.name || 'Работа';
    if (workSub) {
      workSub.textContent = userSavedPlaces.work.address;
      workSub.style.color = '#64748b';
    }
    if (btnEditWork) btnEditWork.classList.remove('hidden');
  } else {
    if (workTitle) workTitle.textContent = 'Работа';
    if (workSub) {
      workSub.textContent = '+ Задать адрес';
      workSub.style.color = '#94a3b8';
    }
    if (workBadge) {
      workBadge.textContent = '+ Задать';
      workBadge.className = 'commute-add-badge';
    }
    if (btnEditWork) btnEditWork.classList.remove('hidden');
  }

  const favCount = (userSavedPlaces.favorites || []).length;
  const favBadge = document.getElementById('fav-count-badge');
  if (favBadge) favBadge.textContent = favCount;

  // 2. Update "My places" Drawer (Screenshot 1)
  const myHomeSub = document.getElementById('my-places-home-sub');
  const myHomeActions = document.getElementById('my-places-home-actions');
  if (myHomeSub && myHomeActions) {
    if (userSavedPlaces.home) {
      myHomeSub.textContent = userSavedPlaces.home.address;
      myHomeActions.innerHTML = `
        <button class="my-place-action-btn route-btn" id="btn-my-home-route" title="Маршрут">🚗</button>
        <button class="my-place-action-btn" id="btn-my-home-edit" title="Изменить">✏️</button>
        <button class="my-place-action-btn delete-btn" id="btn-my-home-del" title="Удалить">🗑️</button>
      `;
      document.getElementById('btn-my-home-route')?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMyPlacesDrawer();
        startNavigationTo(userSavedPlaces.home);
      });
      document.getElementById('btn-my-home-edit')?.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditPlaceModal('home');
      });
      document.getElementById('btn-my-home-del')?.addEventListener('click', (e) => {
        e.stopPropagation();
        userSavedPlaces.home = null;
        savePlacesToStorage();
      });
    } else {
      myHomeSub.textContent = 'Не задан';
      myHomeActions.innerHTML = `<button class="my-place-add-link" id="btn-my-home-add">Add</button>`;
      document.getElementById('btn-my-home-add')?.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditPlaceModal('home');
      });
    }
  }

  const myWorkSub = document.getElementById('my-places-work-sub');
  const myWorkActions = document.getElementById('my-places-work-actions');
  if (myWorkSub && myWorkActions) {
    if (userSavedPlaces.work) {
      myWorkSub.textContent = userSavedPlaces.work.address;
      myWorkActions.innerHTML = `
        <button class="my-place-action-btn route-btn" id="btn-my-work-route" title="Маршрут">🚗</button>
        <button class="my-place-action-btn" id="btn-my-work-edit" title="Изменить">✏️</button>
        <button class="my-place-action-btn delete-btn" id="btn-my-work-del" title="Удалить">🗑️</button>
      `;
      document.getElementById('btn-my-work-route')?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMyPlacesDrawer();
        startNavigationTo(userSavedPlaces.work);
      });
      document.getElementById('btn-my-work-edit')?.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditPlaceModal('work');
      });
      document.getElementById('btn-my-work-del')?.addEventListener('click', (e) => {
        e.stopPropagation();
        userSavedPlaces.work = null;
        savePlacesToStorage();
      });
    } else {
      myWorkSub.textContent = 'Не задан';
      myWorkActions.innerHTML = `<button class="my-place-add-link" id="btn-my-work-add">Add</button>`;
      document.getElementById('btn-my-work-add')?.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditPlaceModal('work');
      });
    }
  }

  const myFavSub = document.getElementById('my-places-fav-subtitle');
  if (myFavSub) {
    myFavSub.textContent = `${favCount} places`;
  }

  // 3. Render Favorites Subview List
  renderFavoritesList();

  // 4. Update live ETAs
  updateCommuteEtas();
}

function renderFavoritesList() {
  const container = document.getElementById('favorites-list-container');
  if (!container) return;
  container.innerHTML = '';

  const favs = userSavedPlaces.favorites || [];
  if (favs.length === 0) {
    container.innerHTML = `
      <div style="padding: 30px 16px; text-align: center; color: #94a3b8;">
        <div style="font-size: 36px; margin-bottom: 8px;">⭐</div>
        <div style="font-size: 15px; font-weight: 700; color: #111827;">Нет избранных мест</div>
        <div style="font-size: 13px; margin-top: 4px;">Нажмите кнопку выше или звездочку в поиске, чтобы добавить место</div>
      </div>
    `;
    return;
  }

  const cur = mapEngine ? mapEngine.currentPosition : { lat: 40.1776, lng: 44.5125 };

  favs.forEach((fav) => {
    const distMeters = (mapEngine && fav.lat && fav.lng)
      ? mapEngine.calculateDistance(cur.lat, cur.lng, fav.lat, fav.lng)
      : null;
    const distStr = distMeters != null
      ? (distMeters >= 1000 ? `${(distMeters / 1000).toFixed(1)} км` : `${Math.round(distMeters)} м`)
      : '';

    const card = document.createElement('div');
    card.className = 'my-place-card';
    card.innerHTML = `
      <div class="my-place-left">
        <div class="my-place-icon-box star-box">⭐</div>
        <div class="my-place-info">
          <div class="my-place-name">${fav.name}</div>
          <div class="my-place-sub">${fav.address || ''}${distStr ? ' • ' + distStr : ''}</div>
        </div>
      </div>
      <div class="my-place-actions">
        <button class="my-place-action-btn route-btn" title="Поехать">🚗</button>
        <button class="my-place-action-btn delete-btn" title="Удалить">✕</button>
      </div>
    `;

    card.addEventListener('click', () => {
      closeMyPlacesDrawer();
      startNavigationTo({ name: fav.name, lat: fav.lat, lng: fav.lng });
    });

    card.querySelector('.route-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMyPlacesDrawer();
      startNavigationTo({ name: fav.name, lat: fav.lat, lng: fav.lng });
    });

    card.querySelector('.delete-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = userSavedPlaces.favorites.findIndex(f => f.id === fav.id);
      if (idx >= 0) {
        userSavedPlaces.favorites.splice(idx, 1);
        savePlacesToStorage();
      }
    });

    container.appendChild(card);
  });
}

function openMyPlacesDrawer(showFavorites = false) {
  const drawer = document.getElementById('my-places-drawer');
  const btn = document.getElementById('btn-open-my-places');
  if (!drawer) return;

  document.getElementById('search-drawer')?.classList.add('hidden');
  document.getElementById('route-alternatives-drawer')?.classList.add('hidden');

  renderAllSavedPlacesUI();
  showMyPlacesView(showFavorites ? 'favorites' : 'main');

  drawer.classList.remove('hidden');
  if (btn) btn.classList.add('active');
}

function closeMyPlacesDrawer() {
  const drawer = document.getElementById('my-places-drawer');
  const btn = document.getElementById('btn-open-my-places');
  if (drawer) drawer.classList.add('hidden');
  if (btn) btn.classList.remove('active');
}

function showMyPlacesView(viewName) {
  const mainView = document.getElementById('my-places-main-view');
  const favView = document.getElementById('my-places-fav-view');
  if (!mainView || !favView) return;

  if (viewName === 'favorites') {
    mainView.classList.add('hidden');
    favView.classList.remove('hidden');
  } else {
    mainView.classList.remove('hidden');
    favView.classList.add('hidden');
  }
}

let currentEditTarget = null; // { type: 'home' | 'work' | 'favorite', place: {...}, selectedLocation: { lat, lng, address } }

function openEditPlaceModal(targetType, existingPlace = null) {
  currentEditTarget = {
    type: targetType,
    place: existingPlace || (targetType === 'home' ? userSavedPlaces.home : (targetType === 'work' ? userSavedPlaces.work : null)),
    selectedLocation: null
  };

  const modal = document.getElementById('edit-place-modal');
  const titleEl = document.getElementById('edit-place-modal-title');
  const nameWrap = document.getElementById('edit-place-name-wrap');
  const nameInput = document.getElementById('edit-place-name-input');
  const addrInput = document.getElementById('edit-place-address-input');
  const delBtn = document.getElementById('btn-delete-place');
  const suggsContainer = document.getElementById('edit-place-suggestions');

  if (!modal) return;
  if (suggsContainer) suggsContainer.innerHTML = '';

  const isFav = targetType === 'favorite';
  const hasExisting = !!currentEditTarget.place;

  if (nameWrap) nameWrap.classList.toggle('hidden', !isFav);

  if (targetType === 'home') {
    titleEl.textContent = hasExisting ? 'Настройка адреса: Дом 🏠' : 'Добавить адрес: Дом 🏠';
    addrInput.value = currentEditTarget.place?.address || '';
  } else if (targetType === 'work') {
    titleEl.textContent = hasExisting ? 'Настройка адреса: Работа 💼' : 'Добавить адрес: Работа 💼';
    addrInput.value = currentEditTarget.place?.address || '';
  } else {
    titleEl.textContent = hasExisting ? 'Изменить избранное ⭐' : 'Добавить в избранное ⭐';
    nameInput.value = currentEditTarget.place?.name || '';
    addrInput.value = currentEditTarget.place?.address || '';
  }

  if (currentEditTarget.place) {
    currentEditTarget.selectedLocation = {
      lat: currentEditTarget.place.lat,
      lng: currentEditTarget.place.lng,
      address: currentEditTarget.place.address
    };
  }

  if (delBtn) delBtn.classList.toggle('hidden', !hasExisting);

  modal.classList.remove('hidden');
  setTimeout(() => addrInput.focus(), 150);
}

function initEditPlaceModalHandlers() {
  const modal = document.getElementById('edit-place-modal');
  const closeBtn = document.getElementById('btn-close-edit-place-x');
  const addrInput = document.getElementById('edit-place-address-input');
  const nameInput = document.getElementById('edit-place-name-input');
  const suggsContainer = document.getElementById('edit-place-suggestions');
  const btnCurrentGps = document.getElementById('btn-use-current-gps-location');
  const btnSave = document.getElementById('btn-save-place');
  const btnDelete = document.getElementById('btn-delete-place');

  if (!modal) return;

  if (closeBtn) closeBtn.addEventListener('click', () => modal.classList.add('hidden'));

  // Live geocoder search for edit modal
  let editDebounce = null;
  if (addrInput) {
    addrInput.addEventListener('input', () => {
      clearTimeout(editDebounce);
      const query = addrInput.value.trim();
      if (query.length < 2) {
        if (suggsContainer) suggsContainer.innerHTML = '';
        return;
      }

      editDebounce = setTimeout(async () => {
        try {
          const cur = mapEngine ? mapEngine.currentPosition : { lat: 40.1776, lng: 44.5125 };
          const res = await fetch(`/api/geocode?q=${encodeURIComponent(query)}&lat=${cur.lat}&lng=${cur.lng}`);
          const items = await res.json();
          if (suggsContainer) {
            suggsContainer.innerHTML = '';
            if (items && items.length > 0) {
              items.forEach(it => {
                const title = it.title || query;
                const subtitle = it.subtitle || 'Ереван, Армения';
                const el = document.createElement('div');
                el.className = 'drawer-list-item';
                el.innerHTML = `
                  <div class="item-left">
                    <div class="item-icon">📍</div>
                    <div>
                      <div class="item-title">${title}</div>
                      <div class="item-subtitle">${subtitle}</div>
                    </div>
                  </div>
                `;
                el.addEventListener('click', () => {
                  currentEditTarget.selectedLocation = {
                    lat: it.lat,
                    lng: it.lng,
                    address: title + (subtitle ? `, ${subtitle}` : '')
                  };
                  addrInput.value = currentEditTarget.selectedLocation.address;
                  suggsContainer.innerHTML = '';
                });
                suggsContainer.appendChild(el);
              });
            }
          }
        } catch (err) {
          console.warn('Edit place geocode error:', err);
        }
      }, 200);
    });
  }

  // Use current car GPS location
  if (btnCurrentGps) {
    btnCurrentGps.addEventListener('click', () => {
      const cur = mapEngine ? mapEngine.currentPosition : { lat: 40.1776, lng: 44.5125 };
      const currentAddr = `Ереван (${Number(cur.lat).toFixed(4)}, ${Number(cur.lng).toFixed(4)})`;
      currentEditTarget.selectedLocation = {
        lat: cur.lat,
        lng: cur.lng,
        address: currentAddr
      };
      if (addrInput) addrInput.value = currentAddr;
      if (suggsContainer) suggsContainer.innerHTML = '';
    });
  }

  // Save place
  if (btnSave) {
    btnSave.addEventListener('click', () => {
      if (!currentEditTarget) return;

      const addrVal = addrInput.value.trim();
      if (!addrVal) {
        alert('Пожалуйста, введите адрес');
        return;
      }

      const loc = currentEditTarget.selectedLocation || {
        lat: mapEngine?.currentPosition?.lat || 40.1776,
        lng: mapEngine?.currentPosition?.lng || 44.5125,
        address: addrVal
      };

      if (currentEditTarget.type === 'home') {
        userSavedPlaces.home = {
          name: 'Дом',
          address: addrVal,
          lat: loc.lat,
          lng: loc.lng
        };
        if (!userSavedPlaces.work) {
          userSavedPlaces.work = DEFAULT_SAVED_PLACES.work;
        }
      } else if (currentEditTarget.type === 'work') {
        userSavedPlaces.work = {
          name: 'Работа',
          address: addrVal,
          lat: loc.lat,
          lng: loc.lng
        };
        if (!userSavedPlaces.home) {
          userSavedPlaces.home = DEFAULT_SAVED_PLACES.home;
        }
      } else if (currentEditTarget.type === 'favorite') {
        const customName = nameInput.value.trim() || addrVal.split(',')[0] || 'Избранное';
        if (currentEditTarget.place) {
          currentEditTarget.place.name = customName;
          currentEditTarget.place.address = addrVal;
          currentEditTarget.place.lat = loc.lat;
          currentEditTarget.place.lng = loc.lng;
        } else {
          if (!userSavedPlaces.favorites) userSavedPlaces.favorites = [];
          userSavedPlaces.favorites.push({
            id: 'fav_' + Date.now(),
            name: customName,
            address: addrVal,
            lat: loc.lat,
            lng: loc.lng
          });
        }
      }

      savePlacesToStorage();
      modal.classList.add('hidden');
    });
  }

  // Delete place
  if (btnDelete) {
    btnDelete.addEventListener('click', () => {
      if (!currentEditTarget) return;

      if (currentEditTarget.type === 'home') {
        userSavedPlaces.home = null;
      } else if (currentEditTarget.type === 'work') {
        userSavedPlaces.work = null;
      } else if (currentEditTarget.type === 'favorite' && currentEditTarget.place) {
        const idx = userSavedPlaces.favorites.findIndex(f => f.id === currentEditTarget.place.id);
        if (idx >= 0) userSavedPlaces.favorites.splice(idx, 1);
      }

      savePlacesToStorage();
      modal.classList.add('hidden');
    });
  }
}

// 6. Search & Autocomplete Handlers with Persistent Search History
const SEARCH_HISTORY_KEY = 'tesla_search_history';

function getSearchHistory() {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {
    console.warn('Failed to parse search history:', e);
  }
  return []; // Empty by default: zero hardcoded history
}

function saveSearchHistory(history) {
  try {
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history));
  } catch (e) {
    console.warn('Failed to save search history:', e);
  }
}

function addToSearchHistory(item) {
  if (!item || !item.name || !item.lat || !item.lng) return;
  let history = getSearchHistory();
  // Filter out duplicates by coordinates or name
  history = history.filter(h => {
    const isSameCoords = Math.abs(h.lat - item.lat) < 0.0001 && Math.abs(h.lng - item.lng) < 0.0001;
    const isSameName = h.name.trim().toLowerCase() === item.name.trim().toLowerCase();
    return !isSameCoords && !isSameName;
  });
  history.unshift({
    name: item.name,
    address: item.address || 'Yerevan, Armenia',
    lat: item.lat,
    lng: item.lng,
    timestamp: Date.now()
  });
  if (history.length > 25) history = history.slice(0, 25);
  saveSearchHistory(history);
  renderSearchHistory();
}

function removeFromSearchHistory(index) {
  let history = getSearchHistory();
  history.splice(index, 1);
  saveSearchHistory(history);
  renderSearchHistory();
}

function clearAllSearchHistory() {
  saveSearchHistory([]);
  renderSearchHistory();
}

function renderSearchHistory() {
  const resultsList = document.getElementById('search-results-list');
  const sectionTitle = document.getElementById('drawer-section-title');
  const searchDrawer = document.getElementById('search-drawer');
  if (!resultsList) return;

  if (sectionTitle) {
    sectionTitle.textContent = I18N[window.CURRENT_LANG || 'ru']?.history || 'История';
  }

  resultsList.innerHTML = '';
  const history = getSearchHistory();

  if (history.length === 0) {
    resultsList.innerHTML = `
      <div style="text-align: center; color: #94a3b8; padding: 28px 14px; font-size: 13px;">
        История поиска пуста
      </div>
    `;
    return;
  }

  const cur = mapEngine ? mapEngine.currentPosition : { lat: 40.1776, lng: 44.5125 };

  history.forEach((h, idx) => {
    const distMeters = mapEngine ? mapEngine.calculateDistance(cur.lat, cur.lng, h.lat, h.lng) : 1000;
    const distStr = distMeters >= 1000 ? `${(distMeters / 1000).toFixed(1)} км` : `${Math.round(distMeters)} м`;
    const isStarred = isLocationInFavorites(h.lat, h.lng, h.name);

    const item = document.createElement('div');
    item.className = 'drawer-list-item';
    item.innerHTML = `
      <div class="item-left">
        <div class="item-icon">📍</div>
        <div>
          <div class="item-title">${h.name}</div>
          <div class="item-subtitle">${h.address || 'Yerevan, Armenia'}</div>
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 6px;">
        <div class="item-dist">${distStr}</div>
        <button class="item-star-btn ${isStarred ? 'starred' : ''}" title="${isStarred ? 'Удалить из избранного' : 'Добавить в избранное'}">
          ${isStarred ? '⭐' : '☆'}
        </button>
        <button class="btn-hist-action" title="Удалить из истории" style="font-size: 12px; padding: 2px 6px;">✕</button>
      </div>
    `;

    const starBtn = item.querySelector('.item-star-btn');
    starBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavoritePlace({ name: h.name, address: h.address, lat: h.lat, lng: h.lng });
      const starredNow = isLocationInFavorites(h.lat, h.lng, h.name);
      starBtn.classList.toggle('starred', starredNow);
      starBtn.textContent = starredNow ? '⭐' : '☆';
    });

    const deleteBtn = item.querySelector('.btn-hist-action');
    deleteBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromSearchHistory(idx);
    });

    item.addEventListener('click', (e) => {
      if (e.target.closest('.item-star-btn') || e.target.closest('.btn-hist-action')) return;
      searchDrawer?.classList.add('hidden');
      startNavigationTo(h);
    });

    resultsList.appendChild(item);
  });
}

function initSearchHandlers() {
  const searchInput = document.getElementById('drawer-search-input');
  const resultsList = document.getElementById('search-results-list');
  const searchDrawer = document.getElementById('search-drawer');
  const btnClearHistory = document.getElementById('btn-clear-search-history');
  let debounceTimer = null;

  if (btnClearHistory) {
    btnClearHistory.addEventListener('click', (e) => {
      e.stopPropagation();
      clearAllSearchHistory();
    });
  }

  // Initial render of persistent search history
  renderSearchHistory();

  // Autocomplete typing with Yandex-powered geocoder
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const query = searchInput.value.trim();
    const sectionTitle = document.getElementById('drawer-section-title');

    if (!query) {
      if (sectionTitle) sectionTitle.textContent = I18N[window.CURRENT_LANG || 'ru']?.history || 'История';
      renderSearchHistory();
      return;
    }

    if (sectionTitle) {
      sectionTitle.textContent = 'Результаты поиска';
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

            const isStarred = isLocationInFavorites(lat, lng, title);
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
              <div style="display: flex; align-items: center; gap: 8px;">
                <div class="item-dist">${distStr}</div>
                <button class="item-star-btn ${isStarred ? 'starred' : ''}" title="${isStarred ? 'Удалить из избранного' : 'Добавить в избранное'}">
                  ${isStarred ? '⭐' : '☆'}
                </button>
              </div>
            `;

            const starBtn = item.querySelector('.item-star-btn');
            starBtn?.addEventListener('click', (e) => {
              e.stopPropagation();
              toggleFavoritePlace({ name: title, address: subtitle, lat, lng });
              const starredNow = isLocationInFavorites(lat, lng, title);
              starBtn.classList.toggle('starred', starredNow);
              starBtn.textContent = starredNow ? '⭐' : '☆';
            });

            item.addEventListener('click', (e) => {
              if (e.target.closest('.item-star-btn')) return;
              searchDrawer.classList.add('hidden');
              addToSearchHistory({ name: title, address: subtitle, lat, lng });
              startNavigationTo({ name: title, lat, lng, address: subtitle });
            });

            resultsList.appendChild(item);
          });
        }
      } catch (e) {
        console.warn('Search geocode error:', e);
      }
    }, 200);
  });

  // Category chips
  document.querySelectorAll('.drawer-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const type = chip.dataset.type;
      if (type === 'charging') {
        searchDrawer.classList.add('hidden');
        openChargingStationsDrawer();
        return;
      }
      let target = null;
      if (type === 'parking') target = { name: 'Парковка / Parking Center', lat: 40.186500, lng: 44.473000 };
      else if (type === 'carwash') target = { name: 'Premium Car Wash Yerevan', lat: 40.184500, lng: 44.478000 };
      else if (type === 'food') target = { name: 'Ресторан / Dining Yerevan', lat: 40.184000, lng: 44.480000 };
      else if (type === 'coffee') target = { name: 'Coffee House Yerevan', lat: 40.185500, lng: 44.485000 };

      if (target) {
        searchDrawer.classList.add('hidden');
        addToSearchHistory(target);
        startNavigationTo(target);
      }
    });
  });
}

// Start Navigation to Target
async function startNavigationTo(destination) {
  selectedDestination = destination;
  if (destination && destination.name && destination.lat && destination.lng) {
    addToSearchHistory(destination);
  }
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
  document.body.classList.add('route-options-open');
  document.getElementById('quick-dest-bar')?.classList.add('hidden');
  currentRouteInfo = route;
  const drawer = document.getElementById('route-alternatives-drawer');
  if (!drawer) return;

  const allRoutes = route.allRoutes || [];
  const activeIdx = route.activeRouteIndex || 0;
  const r0 = allRoutes[0] || route;
  const r1 = allRoutes[1];
  const r2 = allRoutes[2];

  // Card 0: Primary / Fastest
  const card0 = document.getElementById('route-card-0');
  if (card0) {
    document.getElementById('route-0-time').textContent = r0.duration;
    document.getElementById('route-0-dist').textContent = r0.distance;
    card0.classList.toggle('active', activeIdx === 0);
  }

  // Card 1: Alternative Route 1
  const card1 = document.getElementById('route-card-1');
  if (card1) {
    if (r1) {
      card1.classList.remove('hidden');
      card1.classList.toggle('active', activeIdx === 1);
      const badge1 = document.getElementById('route-1-badge');
      if (badge1) badge1.textContent = r1.summary;
      const time1 = document.getElementById('route-1-time');
      if (time1) time1.textContent = r1.duration;
      const dist1 = document.getElementById('route-1-dist');
      if (dist1) dist1.textContent = `${r1.distance} · ${r1.diffMins}`;
    } else {
      card1.classList.add('hidden');
    }
  }

  // Card 2: Alternative Route 2
  const card2 = document.getElementById('route-card-2');
  if (card2) {
    if (r2) {
      card2.classList.remove('hidden');
      card2.classList.toggle('active', activeIdx === 2);
      const badge2 = document.getElementById('route-2-badge');
      if (badge2) badge2.textContent = r2.summary;
      const time2 = document.getElementById('route-2-time');
      if (time2) time2.textContent = r2.duration;
      const dist2 = document.getElementById('route-2-dist');
      if (dist2) dist2.textContent = `${r2.distance} · ${r2.diffMins}`;
    } else {
      card2.classList.add('hidden');
    }
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

// 7. Navigation HUD Displays (Mapsev Capsule Style & Traffic Progress Bar)
function renderTrafficProgressBar(segments) {
  const barContainer = document.getElementById('nav-traffic-segments-bar') || document.querySelector('.route-progress-bar');
  if (!barContainer) return;
  barContainer.innerHTML = '';

  const segs = (segments && segments.length > 0) ? segments : [
    { coords: new Array(40), color: '#10b981' },
    { coords: new Array(25), color: '#f59e0b' },
    { coords: new Array(15), color: '#ef4444' },
    { coords: new Array(20), color: '#10b981' }
  ];

  const totalPoints = segs.reduce((sum, s) => sum + (s.coords ? s.coords.length : 1), 0);

  segs.forEach(seg => {
    const pts = seg.coords ? seg.coords.length : 1;
    const segDiv = document.createElement('div');
    segDiv.className = 'nav-traffic-seg';
    segDiv.style.flex = `${pts}`;
    segDiv.style.height = '100%';
    segDiv.style.background = seg.color || '#10b981';
    barContainer.appendChild(segDiv);
  });
}

function showNavigationHud(route) {
  document.body.classList.remove('route-options-open');
  document.body.classList.add('navigating');
  document.getElementById('quick-dest-bar')?.classList.add('hidden');
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

  // Reset progress car knob and cursor to 0% at route start
  const knob = document.getElementById('nav-progress-car-knob');
  if (knob) knob.style.left = '0%';
  const cursor = document.getElementById('prog-car-cursor');
  if (cursor) cursor.style.left = '0%';
  const traveledFill = document.getElementById('prog-traveled-fill');
  if (traveledFill) traveledFill.style.width = '0%';

  // Render authentic live traffic segments on the bottom progress bar (Mapsev Screenshot 3)
  renderTrafficProgressBar(route.trafficSegments);
}

function updateManeuverHud(m) {
  document.getElementById('maneuver-dist').textContent = m.distance;
  document.getElementById('maneuver-street').textContent = m.street || m.instruction || 'Двигайтесь прямо';

  // Crisp SVG vector arrow based on modifier / type (immune to missing system fonts on Tesla)
  const arrowBox = document.getElementById('maneuver-arrow-box');
  const mod = (m.modifier || '').toLowerCase();
  const type = (m.type || '').toLowerCase();

  let svgIcon = '';
  if (type === 'roundabout' || mod.includes('roundabout')) {
    svgIcon = `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="7"/><polyline points="15 5 12 2 9 5"/></svg>`;
  } else if (mod.includes('uturn') || mod.includes('u-turn')) {
    svgIcon = `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 19v-9a6 6 0 0 0-12 0v9"/><polyline points="9 16 6 19 3 16"/></svg>`;
  } else if (mod.includes('slight left') || mod.includes('fork left') || mod.includes('keep left') || mod.includes('bear left') || mod.includes('левее')) {
    svgIcon = `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 19l-4-9-5-5"/><polyline points="13 5 7 5 7 11"/></svg>`;
  } else if (mod.includes('slight right') || mod.includes('fork right') || mod.includes('keep right') || mod.includes('bear right') || mod.includes('правее')) {
    svgIcon = `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 19l4-9 5-5"/><polyline points="11 5 17 5 17 11"/></svg>`;
  } else if (mod.includes('left') || mod.includes('налево')) {
    svgIcon = `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 19V11a4 4 0 0 0-4-4H5"/><polyline points="9 3 5 7 9 11"/></svg>`;
  } else if (mod.includes('right') || mod.includes('направо')) {
    svgIcon = `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 19V11a4 4 0 0 1 4-4h9"/><polyline points="15 3 19 7 15 11"/></svg>`;
  } else {
    svgIcon = `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="20" x2="12" y2="4"/><polyline points="6 10 12 4 18 10"/></svg>`;
  }
  if (arrowBox) arrowBox.innerHTML = svgIcon;

  // Update dynamic speed limit circle (60 in city, 90 on highway/outside Yerevan)
  if (m.speedLimit) {
    const limitEl = document.getElementById('speed-limit-val');
    if (limitEl) limitEl.textContent = m.speedLimit;
  }

  // Real Lane Guidance matching Yandex Navigator (Screenshots 4 & 5)
  renderLaneGuidance(m);
}
window.updateManeuverHud = updateManeuverHud;

// Single Lane Arrow SVG Generator matching authentic road traffic signs
function getSingleLaneSvg(indications, isActive) {
  const color = isActive ? '#ffffff' : 'rgba(255,255,255,0.35)';
  const strokeWidth = isActive ? '3.5' : '3';
  const inds = (Array.isArray(indications) ? indications : [indications || 'straight']).map(s => String(s).toLowerCase());

  const hasStraight = inds.some(i => i.includes('straight'));
  const hasRight = inds.some(i => i === 'right');
  const hasSlightRight = inds.some(i => i.includes('slight right') || i.includes('fork right') || i.includes('keep right') || i.includes('bear right') || i.includes('правее'));
  const hasLeft = inds.some(i => i === 'left');
  const hasSlightLeft = inds.some(i => i.includes('slight left') || i.includes('fork left') || i.includes('keep left') || i.includes('bear left') || i.includes('левее'));
  const hasUTurn = inds.some(i => i.includes('uturn') || i.includes('u-turn') || i.includes('разворот'));

  // 1. Combined Straight + Right
  if (hasStraight && (hasRight || hasSlightRight)) {
    return `
      <svg viewBox="0 0 32 36" width="22" height="28" fill="none">
        <line x1="10" y1="32" x2="10" y2="8" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>
        <polyline points="5 13 10 7 15 13" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M10 20a6 6 0 0 1 6-6h9" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>
        <polyline points="20 9 26 14 20 19" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
  }

  // 2. Combined Straight + Left
  if (hasStraight && (hasLeft || hasSlightLeft)) {
    return `
      <svg viewBox="0 0 32 36" width="22" height="28" fill="none">
        <line x1="22" y1="32" x2="22" y2="8" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>
        <polyline points="17 13 22 7 27 13" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M22 20a6 6 0 0 0-6-6H7" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>
        <polyline points="12 9 6 14 12 19" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
  }

  // 3. Right 90 deg
  if (hasRight) {
    return `
      <svg viewBox="0 0 28 36" width="20" height="28" fill="none">
        <line x1="9" y1="32" x2="9" y2="18" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>
        <path d="M9 18a6 6 0 0 1 6-6h8" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>
        <polyline points="18 7 24 12 18 17" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
  }

  // 4. Slight Right / Fork Right
  if (hasSlightRight) {
    return `
      <svg viewBox="0 0 28 36" width="20" height="28" fill="none">
        <line x1="9" y1="32" x2="9" y2="18" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>
        <path d="M9 18l8-9 4-3" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>
        <polyline points="16 6 22 6 22 12" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
  }

  // 5. Left 90 deg
  if (hasLeft) {
    return `
      <svg viewBox="0 0 28 36" width="20" height="28" fill="none">
        <line x1="19" y1="32" x2="19" y2="18" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>
        <path d="M19 18a6 6 0 0 0-6-6H5" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>
        <polyline points="10 7 4 12 10 17" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
  }

  // 6. Slight Left / Fork Left
  if (hasSlightLeft) {
    return `
      <svg viewBox="0 0 28 36" width="20" height="28" fill="none">
        <line x1="19" y1="32" x2="19" y2="18" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>
        <path d="M19 18l-8-9-4-3" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>
        <polyline points="12 6 6 6 6 12" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
  }

  // 7. U-turn
  if (hasUTurn) {
    return `
      <svg viewBox="0 0 28 36" width="20" height="28" fill="none">
        <path d="M20 32V16a6 6 0 0 0-12 0v10" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>
        <polyline points="13 21 8 26 3 21" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
  }

  // Default: Straight
  return `
    <svg viewBox="0 0 24 36" width="18" height="28" fill="none">
      <line x1="12" y1="32" x2="12" y2="8" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>
      <polyline points="7 13 12 7 17 13" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;
}

// Lane Guidance SVG Generator (Supporting real OSM lane configurations + fallback modifier synthesis)
function getLaneColumnsHtml(lanesOrModifier) {
  // If array of real OSM lanes is provided:
  if (Array.isArray(lanesOrModifier) && lanesOrModifier.length > 0) {
    return lanesOrModifier.map((lane, idx) => {
      const isActive = !!lane.valid;
      const stateClass = isActive ? 'is-active' : 'is-faded';
      const svg = getSingleLaneSvg(lane.indications, isActive);
      const dot = isActive ? '<span class="lane-active-dot"></span>' : '';
      return `<div class="lane-col-item ${stateClass}" title="Полоса ${idx + 1}">${svg}${dot}</div>`;
    }).join('');
  }

  // Fallback to modifier-based synthesis if no lane array available
  const mod = (typeof lanesOrModifier === 'string' ? lanesOrModifier : '').toLowerCase();
  const isSlightLeft = mod.includes('slight left') || mod.includes('fork left') || mod.includes('keep left') || mod.includes('bear left') || mod.includes('левее');
  const isSlightRight = mod.includes('slight right') || mod.includes('fork right') || mod.includes('keep right') || mod.includes('bear right') || mod.includes('правее');
  const isUTurn = mod.includes('uturn') || mod.includes('u-turn') || mod.includes('разворот');
  const isLeft = !isSlightLeft && (mod.includes('left') || mod.includes('налево'));
  const isRight = !isSlightRight && (mod.includes('right') || mod.includes('направо'));

  if (isSlightLeft) {
    return `
      <div class="lane-col-item is-active" title="Ваша полоса: Держитесь левее">
        ${getSingleLaneSvg(['slight left'], true)}
        <span class="lane-active-dot"></span>
      </div>
      <div class="lane-col-item is-faded" title="Другая полоса: Прямо">
        ${getSingleLaneSvg(['straight'], false)}
      </div>
    `;
  } else if (isSlightRight) {
    return `
      <div class="lane-col-item is-faded" title="Другая полоса: Прямо">
        ${getSingleLaneSvg(['straight'], false)}
      </div>
      <div class="lane-col-item is-active" title="Ваша полоса: Держитесь правее">
        ${getSingleLaneSvg(['slight right'], true)}
        <span class="lane-active-dot"></span>
      </div>
    `;
  } else if (isLeft) {
    return `
      <div class="lane-col-item is-active" title="Ваша полоса: Поворот налево">
        ${getSingleLaneSvg(['left'], true)}
        <span class="lane-active-dot"></span>
      </div>
      <div class="lane-col-item is-faded" title="Другая полоса: Прямо">
        ${getSingleLaneSvg(['straight'], false)}
      </div>
    `;
  } else if (isRight) {
    return `
      <div class="lane-col-item is-faded" title="Другая полоса: Прямо">
        ${getSingleLaneSvg(['straight'], false)}
      </div>
      <div class="lane-col-item is-active" title="Ваша полоса: Поворот направо">
        ${getSingleLaneSvg(['right'], true)}
        <span class="lane-active-dot"></span>
      </div>
    `;
  } else if (isUTurn) {
    return `
      <div class="lane-col-item is-active" title="Ваша полоса: Разворот">
        ${getSingleLaneSvg(['uturn'], true)}
        <span class="lane-active-dot"></span>
      </div>
      <div class="lane-col-item is-faded" title="Другая полоса: Прямо">
        ${getSingleLaneSvg(['straight'], false)}
      </div>
    `;
  } else {
    return `
      <div class="lane-col-item is-active" title="Полоса 1: Прямо">
        ${getSingleLaneSvg(['straight'], true)}
      </div>
      <div class="lane-col-item is-active" title="Полоса 2: Прямо">
        ${getSingleLaneSvg(['straight'], true)}
      </div>
    `;
  }
}

function renderLaneGuidance(m) {
  const lanePill = document.getElementById('lane-guidance-pill');
  if (!lanePill) return;

  const rawDist = (typeof m.laneDistanceMeters === 'number')
    ? m.laneDistanceMeters
    : ((typeof m.distanceMeters === 'number') ? m.distanceMeters : ((typeof m.rawDistance === 'number') ? m.rawDistance : 100));
  const mod = (m.modifier || '').toLowerCase();
  const isTurn = mod.includes('left') || mod.includes('right') || mod.includes('uturn') || mod.includes('fork') || mod.includes('roundabout') || mod.includes('левее') || mod.includes('правее');
  const hasLanes = Array.isArray(m.lanes) && m.lanes.length > 0;

  // Strict proximity threshold: only activate within 220m of intersection or upcoming turn (never 700m!)
  const withinThreshold = rawDist <= 220;

  if (withinThreshold && (hasLanes || isTurn || rawDist <= 120)) {
    const lanesData = hasLanes ? m.lanes : m.modifier;
    lanePill.innerHTML = `
      <div class="lane-guidance-arrows">
        ${getLaneColumnsHtml(lanesData)}
      </div>
    `;
    lanePill.classList.remove('hidden');
  } else {
    lanePill.classList.add('hidden');
  }
}

function cancelActiveNavigation() {
  document.body.classList.remove('navigating');
  document.body.classList.remove('route-options-open');
  document.getElementById('quick-dest-bar')?.classList.remove('hidden');
  renderQuickDestChips();
  document.getElementById('hud-maneuver-card').classList.add('hidden');
  document.getElementById('bottom-nav-bar').classList.add('hidden');
  document.getElementById('lane-guidance-pill').classList.add('hidden');
  if (mapEngine) mapEngine.clearRoadLaneMarker();
  const camBadge = document.getElementById('camera-alert-badge');
  if (camBadge) camBadge.classList.add('hidden');
  const altDrawer = document.getElementById('route-alternatives-drawer');
  if (altDrawer) altDrawer.classList.add('hidden');
  const knob = document.getElementById('nav-progress-car-knob');
  if (knob) knob.style.left = '0%';
  const cursor = document.getElementById('prog-car-cursor');
  if (cursor) cursor.style.left = '0%';
  const traveledFill = document.getElementById('prog-traveled-fill');
  if (traveledFill) traveledFill.style.width = '0%';
  selectedDestination = null;
  currentRouteInfo = null;
  if (mapEngine) {
    mapEngine.cancelRoute();
  }
}

function showArrivalModal(dest) {
  document.body.classList.remove('navigating');
  document.body.classList.remove('route-options-open');
  document.getElementById('quick-dest-bar')?.classList.remove('hidden');
  renderQuickDestChips();
  document.getElementById('hud-maneuver-card').classList.add('hidden');
  document.getElementById('bottom-nav-bar').classList.add('hidden');
  document.getElementById('lane-guidance-pill').classList.add('hidden');
  if (mapEngine) mapEngine.clearRoadLaneMarker();
  document.getElementById('arrival-dest-name').textContent = dest.name || 'Пункт назначения';
  document.getElementById('arrival-modal').classList.remove('hidden');
}

// 8. EV Supercharger Pins on Map
function toggleEvChargers(show) {
  const btnQuick = document.getElementById('btn-quick-chargers');
  if (btnQuick) btnQuick.classList.toggle('active', !!show);
  if (!mapEngine || !mapEngine.map) return;
  chargersVisible = !!show;
  document.getElementById('btn-toggle-chargers')?.classList.toggle('active', chargersVisible);

  if (!chargersVisible) {
    activeChargersMarkers.forEach(m => m.remove());
    activeChargersMarkers = [];
    return;
  }

  // Clear any existing before re-rendering
  activeChargersMarkers.forEach(m => m.remove());
  activeChargersMarkers = [];

  EV_CHARGERS.forEach(charger => {
    const el = document.createElement('div');
    el.className = 'tesla-dest-pin';
    el.innerHTML = `
      <div style="width: 32px; height: 32px; border-radius: 50%; background: #10b981; border: 2.5px solid #fff; display: grid; place-items: center; color: #fff; font-size: 14px; font-weight: 800; box-shadow: 0 4px 12px rgba(16,185,129,0.5); cursor: pointer;">
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

// 8.5. EV Charging Stations Full List Drawer (Mapsev & Tesla Supercharger Architecture)
function initChargingStationsDrawer() {
  const drawer = document.getElementById('charging-stations-drawer');
  const btnClose = document.getElementById('btn-close-chargers');
  const btnToolbar = document.getElementById('btn-toggle-chargers');
  const dockBatteryBadge = document.getElementById('dock-battery-badge');
  const btnQuick = document.getElementById('btn-quick-chargers');

  // Bottom dock battery badge opens the full list drawer
  if (dockBatteryBadge) {
    dockBatteryBadge.addEventListener('click', () => {
      openChargingStationsDrawer();
    });
  }

  // Left sidebar lightning button: opens/closes the charging stations list drawer
  if (btnToolbar) {
    btnToolbar.addEventListener('click', () => {
      if (drawer && !drawer.classList.contains('hidden')) {
        closeChargingStationsDrawer();
      } else {
        openChargingStationsDrawer();
      }
    });
  }

  // Right sidebar lightning button: toggles drawing pins/markers on the map
  if (btnQuick) {
    btnQuick.addEventListener('click', () => {
      toggleEvChargers(!chargersVisible);
      btnQuick.classList.toggle('active', chargersVisible);
    });
  }

  if (btnClose) {
    btnClose.addEventListener('click', () => {
      closeChargingStationsDrawer();
    });
  }
}

function openChargingStationsDrawer() {
  const drawer = document.getElementById('charging-stations-drawer');
  if (!drawer) return;

  // Close other overlapping drawers
  document.getElementById('search-drawer')?.classList.add('hidden');
  document.getElementById('my-places-drawer')?.classList.add('hidden');
  document.getElementById('weather-modal')?.classList.add('hidden');
  document.getElementById('pairing-modal')?.classList.add('hidden');

  drawer.classList.remove('hidden');
  document.getElementById('btn-toggle-chargers')?.classList.add('active');

  // Render stations with live distances
  renderChargingStationsList();
}

function closeChargingStationsDrawer() {
  const drawer = document.getElementById('charging-stations-drawer');
  if (drawer) drawer.classList.add('hidden');
  document.getElementById('btn-toggle-chargers')?.classList.remove('active');
}

function renderChargingStationsList() {
  const listEl = document.getElementById('charging-stations-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const cur = mapEngine ? mapEngine.currentPosition : { lat: 40.1872, lng: 44.5152 };

  // Calculate distances and sort
  const chargersWithDist = EV_CHARGERS.map(c => {
    const distMeters = mapEngine ? mapEngine.calculateDistance(cur.lat, cur.lng, c.lat, c.lng) : 1200;
    return { ...c, distMeters };
  });

  chargersWithDist.sort((a, b) => a.distMeters - b.distMeters);

  chargersWithDist.forEach(charger => {
    const distStr = charger.distMeters >= 1000
      ? `${(charger.distMeters / 1000).toFixed(1)} км`
      : `${Math.round(charger.distMeters)} м`;

    const card = document.createElement('div');
    card.className = 'ev-charger-card';
    card.innerHTML = `
      <div class="ev-charger-top">
        <div class="ev-charger-name">⚡ ${charger.name}</div>
        <span class="ev-charger-power">${charger.power}</span>
      </div>
      <div style="font-size: 12px; color: #64748b; line-height: 1.3;">${charger.address}</div>
      <div class="ev-charger-meta">
        <span class="ev-stalls-free">● ${charger.stalls}</span>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-weight: 600; color: #1e293b;">${distStr}</span>
          <button class="btn-ev-route-go" type="button">Маршрут</button>
        </div>
      </div>
    `;

    card.addEventListener('click', () => {
      closeChargingStationsDrawer();
      startNavigationTo({ name: charger.name, lat: charger.lat, lng: charger.lng, address: charger.address });
    });

    listEl.appendChild(card);
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

  // Reusable touch & mouse dragging utility for floating automotive cards
  function makeElementDraggable(element, handleElement) {
    if (!element) return;
    const handle = handleElement || element;
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;

    handle.addEventListener('pointerdown', (e) => {
      // Don't drag when touching buttons, inputs, links, or iframe
      if (e.target.closest('button, input, a, iframe, .card-close-btn, .mini-ctrl-btn, .music-ctrl-btn')) return;

      isDragging = true;
      try {
        handle.setPointerCapture(e.pointerId);
      } catch (err) {}
      startX = e.clientX;
      startY = e.clientY;

      const rect = element.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;

      element.style.transition = 'none';
      e.preventDefault();
    });

    handle.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      let newLeft = initialLeft + dx;
      let newTop = initialTop + dy;

      const maxLeft = Math.max(10, window.innerWidth - element.offsetWidth - 10);
      const maxTop = Math.max(10, window.innerHeight - element.offsetHeight - 10);

      newLeft = Math.max(10, Math.min(maxLeft, newLeft));
      newTop = Math.max(10, Math.min(maxTop, newTop));

      element.style.left = `${newLeft}px`;
      element.style.top = `${newTop}px`;
      element.style.bottom = 'auto';
      element.style.right = 'auto';
    });

    const stopDrag = (e) => {
      if (!isDragging) return;
      isDragging = false;
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch (err) {}
      element.style.transition = '';
      if (element.id === 'music-mini-player') {
        try {
          localStorage.setItem('tesla_mini_player_pos', JSON.stringify({
            left: element.style.left,
            top: element.style.top
          }));
        } catch (err) {}
      }
    };

    handle.addEventListener('pointerup', stopDrag);
    handle.addEventListener('pointercancel', stopDrag);
  }

  // YouTube Music & Video Player (Mapsev Architecture - Draggable / Floating)
  const btnMusic = document.getElementById('btn-open-music');
  const ytModal = document.getElementById('youtube-player-modal');
  const ytHeader = document.getElementById('yt-modal-header');
  const btnCloseMusic = document.getElementById('btn-close-music');

  const miniPlayer = document.getElementById('music-mini-player');
  const miniTitle = document.getElementById('mini-player-title');
  const btnMiniInfoExpand = document.getElementById('btn-mini-info-expand');
  const btnMiniExpand = document.getElementById('btn-mini-expand');
  const btnMiniClose = document.getElementById('btn-mini-close');
  const btnMiniPlay = document.getElementById('btn-mini-play');
  const btnMiniPrev = document.getElementById('btn-mini-prev');
  const btnMiniNext = document.getElementById('btn-mini-next');

  // Restore saved mini-player position if user dragged it before
  try {
    const savedMiniPos = localStorage.getItem('tesla_mini_player_pos');
    if (savedMiniPos && miniPlayer) {
      const parsedPos = JSON.parse(savedMiniPos);
      if (parsedPos.left && parsedPos.top) {
        miniPlayer.style.left = parsedPos.left;
        miniPlayer.style.top = parsedPos.top;
        miniPlayer.style.bottom = 'auto';
        miniPlayer.style.right = 'auto';
      }
    }
  } catch (err) {}

  const ytIdleScreen = document.getElementById('yt-idle-screen');
  const ytNowTitle = document.getElementById('yt-now-title');
  const ytNowArtist = document.getElementById('yt-now-artist');
  const ytIframe = document.getElementById('yt-player-iframe');

  const ytTimelineTrack = document.getElementById('yt-timeline-track');
  const ytTimelineFill = document.getElementById('yt-timeline-fill');
  const ytTimeCur = document.getElementById('yt-time-cur');
  const ytTimeDur = document.getElementById('yt-time-dur');

  const btnMusicPlay = document.getElementById('btn-music-play');
  const btnMusicPrev = document.getElementById('btn-music-prev');
  const btnMusicNext = document.getElementById('btn-music-next');

  const ytAccountBadge = document.getElementById('yt-account-badge');
  const ytUserNameText = document.getElementById('yt-user-name-text');
  const btnYtShuffle = document.getElementById('btn-yt-shuffle');
  const btnYtFullscreen = document.getElementById('btn-yt-fullscreen');

  const ytSearchInput = document.getElementById('yt-search-input');
  const btnYtSearchClear = document.getElementById('btn-yt-search-clear');
  const btnYtSearchGo = document.getElementById('btn-yt-search-go');
  const ytResultsList = document.getElementById('yt-results-list');
  const btnYtAccountToggle = document.getElementById('btn-yt-account-toggle');

  // Dragging support
  makeElementDraggable(ytModal, ytHeader);
  makeElementDraggable(miniPlayer, miniPlayer);

  // Playback timer & time parser
  let ytProgressTimer = null;
  let ytElapsedSec = 0;
  let ytTotalDurationSec = 0;

  function parseDuration(str) {
    if (!str) return 210;
    const parts = str.split(':').map(p => parseInt(p, 10));
    if (parts.length === 2) return (parts[0] * 60) + parts[1];
    if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
    return 210;
  }

  function formatTime(sec) {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${rem < 10 ? '0' : ''}${rem}`;
  }

  function resetTimeline() {
    clearInterval(ytProgressTimer);
    ytElapsedSec = 0;
    if (ytTimelineFill) ytTimelineFill.style.width = '0%';
    if (ytTimeCur) ytTimeCur.textContent = '0:00';
  }

  function startTimelineProgress() {
    clearInterval(ytProgressTimer);
    ytProgressTimer = setInterval(() => {
      if (!isMusicPlaying) return;
      ytElapsedSec++;
      if (ytTotalDurationSec > 0) {
        const pct = Math.min(100, (ytElapsedSec / ytTotalDurationSec) * 100);
        if (ytTimelineFill) ytTimelineFill.style.width = `${pct}%`;
        if (ytElapsedSec >= ytTotalDurationSec) {
          playNextTrack();
        }
      }
      if (ytTimeCur) ytTimeCur.textContent = formatTime(ytElapsedSec);
    }, 1000);
  }

  // Account Identity (Stepan Smbatyan - Screenshot 5)
  let ytUser = localStorage.getItem('tesla_yt_user') || 'Stepan Smbatyan';

  function updateAccountUI() {
    if (ytUserNameText) ytUserNameText.textContent = ytUser || 'Войти в YouTube';
    if (btnYtAccountToggle) {
      btnYtAccountToggle.textContent = ytUser
        ? `Disconnect YouTube · ${ytUser}`
        : 'Connect YouTube Account';
    }
  }
  updateAccountUI();

  if (btnYtAccountToggle) {
    btnYtAccountToggle.addEventListener('click', () => {
      if (ytUser) {
        if (confirm(`Отключить аккаунт YouTube (${ytUser})?`)) {
          ytUser = '';
          localStorage.removeItem('tesla_yt_user');
          updateAccountUI();
        }
      } else {
        const name = prompt('Введите имя вашего аккаунта YouTube:', 'Stepan Smbatyan');
        if (name && name.trim()) {
          ytUser = name.trim();
          localStorage.setItem('tesla_yt_user', ytUser);
          updateAccountUI();
        }
      }
    });
  }

  // Sync music play/pause icons & states
  function syncMusicState(playing, trackTitle) {
    isMusicPlaying = playing;
    const playSvg = `<svg viewBox="0 0 24 24" width="24" height="24" fill="#ffffff"><polygon points="6 4 20 12 6 20 6 4"/></svg>`;
    const pauseSvg = `<svg viewBox="0 0 24 24" width="24" height="24" fill="#ffffff"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
    const miniPlaySvg = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>`;
    const miniPauseSvg = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;

    if (btnMusicPlay) btnMusicPlay.innerHTML = playing ? pauseSvg : playSvg;
    if (btnMiniPlay) btnMiniPlay.innerHTML = playing ? miniPauseSvg : miniPlaySvg;

    if (miniPlayer) {
      miniPlayer.classList.toggle('playing', playing);
    }
    if (trackTitle && miniTitle) {
      miniTitle.textContent = trackTitle;
    }
    if (trackTitle && ytNowTitle) {
      ytNowTitle.textContent = trackTitle;
    }

    if (playing) {
      startTimelineProgress();
    } else {
      clearInterval(ytProgressTimer);
    }
  }

  function playTrackById(videoId, title, channel, duration) {
    resetTimeline();
    ytTotalDurationSec = parseDuration(duration);
    if (ytTimeDur) ytTimeDur.textContent = duration || formatTime(ytTotalDurationSec);

    if (ytIdleScreen) ytIdleScreen.classList.add('hidden');
    if (ytIframe) {
      ytIframe.classList.remove('hidden');
      const origin = window.location.origin || '';
      ytIframe.src = `https://www.youtube.com/embed/${videoId}?autoplay=1&enablejsapi=1&origin=${encodeURIComponent(origin)}`;
    }

    if (ytNowTitle) ytNowTitle.textContent = title || 'YouTube Track';
    if (ytNowArtist) ytNowArtist.textContent = channel || '';

    // Record into persistent history
    addToYouTubeHistory({ id: videoId, title, channel, duration });

    syncMusicState(true, title || 'YouTube Music');
    if (btnMusic) btnMusic.classList.add('active');

    // Update active highlight in recommendations list
    if (ytResultsList) {
      ytResultsList.querySelectorAll('.yt-result-item').forEach(el => {
        el.classList.toggle('playing', el.dataset.id === videoId);
      });
    }
  }

  function minimizeToMiniPlayer() {
    ytModal.classList.add('hidden');
    if (miniPlayer) {
      miniPlayer.classList.remove('hidden');
    }
  }

  function expandToFullPlayer() {
    if (miniPlayer) miniPlayer.classList.add('hidden');
    ytModal.classList.remove('hidden');
    if (btnMusic) btnMusic.classList.add('active');
  }

  function stopAndCloseAllMusic() {
    ytModal.classList.add('hidden');
    if (miniPlayer) miniPlayer.classList.add('hidden');
    if (ytIframe) {
      ytIframe.contentWindow.postMessage('{"event":"command","func":"pauseVideo","args":""}', '*');
    }
    syncMusicState(false);
    if (btnMusic) btnMusic.classList.remove('active');
  }

  // Toggle from sidebar toolbar
  btnMusic.addEventListener('click', () => {
    const isModalOpen = !ytModal.classList.contains('hidden');
    const isMiniOpen = miniPlayer && !miniPlayer.classList.contains('hidden');

    if (!isModalOpen && !isMiniOpen) {
      expandToFullPlayer();
    } else if (isModalOpen) {
      if (isMusicPlaying) {
        minimizeToMiniPlayer();
      } else {
        stopAndCloseAllMusic();
      }
    } else {
      expandToFullPlayer();
    }
  });

  if (btnCloseMusic) {
    btnCloseMusic.addEventListener('click', () => {
      if (isMusicPlaying) {
        minimizeToMiniPlayer();
      } else {
        stopAndCloseAllMusic();
      }
    });
  }

  // Mini-player buttons
  if (btnMiniExpand) btnMiniExpand.addEventListener('click', expandToFullPlayer);
  if (btnMiniInfoExpand) btnMiniInfoExpand.addEventListener('click', expandToFullPlayer);
  if (btnMiniClose) btnMiniClose.addEventListener('click', stopAndCloseAllMusic);

  // Authentic Curated Recommendations from User Real YouTube Home Feed (Screenshots 2 & 3)
  const HOME_RECOMMENDATIONS = [
    {
      id: '6CZLCZZNc90',
      title: 'Джем – Garik - indz el tar (official lyrics video)',
      channel: 'Garik Papoyan',
      duration: '3:10',
      meta: 'Джем • 185 тыс. просмотров'
    },
    {
      id: 'OLqjgBoPV9E',
      title: 'ArmComedy 1439 - COP 17, Էփշթեյն և Ամուլսար',
      channel: 'ArmComedy',
      duration: '30:13',
      meta: '10 тыс. просмотров • 2 ч назад'
    },
    {
      id: '04HS6MkhOr4',
      title: 'Պարոդիա - Լիլի Հովեր',
      channel: 'HD Production',
      duration: '3:52',
      meta: '14 тыс. просмотров • 2 ч назад'
    },
    {
      id: 'vPNsZM2y7bw',
      title: '🚨Նոր ավտոյիս վրա ԱՎՏՈԲՈՒՍԻ մատոռ⚡The Long Drive #104',
      channel: 'Saint-Hov 🇦🇲',
      duration: '13:51',
      meta: '114 тыс. просмотров • 4 мес. назад'
    },
    {
      id: '5bFiccd8lCI',
      title: 'When Young Lionel Messi Substituted & SHOCKED Pep Guardiola',
      channel: 'VALENTINO PRODUCTIONS',
      duration: '12:44',
      meta: '1.2 млн просмотров • 1 мес. назад'
    },
    {
      id: 'mFRh6wVyMaE',
      title: 'Brunette - Bac kapuyt achqerd',
      channel: 'Brunette',
      duration: '3:36',
      meta: '2.4 млн просмотров'
    },
    {
      id: 'TPjN6N8TgNI',
      title: 'Super Sako - Mi Gna ft. Hayko (Official Audio)',
      channel: 'Super Sako',
      duration: '3:22',
      meta: '320 млн просмотров'
    },
    {
      id: 'z3wqyffIosw',
      title: 'Сделал 1 кг филамента для 3D-принтера из мусорных бутылок ♻️',
      channel: 'Modelmen Life',
      duration: '9:12',
      meta: '145 тыс. просмотров • 10 дн. назад'
    },
    {
      id: 'ayMA_IeEp2Q',
      title: '#Corner Mundial #1. Աշխարհի առաջնությունը՝ Օգնյեն Չանչարևիչի հետ',
      channel: 'Corner Football Armenia',
      duration: '53:43',
      meta: '38 тыс. просмотров'
    },
    {
      id: 'rOgehCKt-VA',
      title: 'Ռոմանոս Պետրոսյանի հանձնարարականով Երևանի Քրիստափորի փողոցի փտած ...',
      channel: 'Shamshyan.com',
      duration: '8:36',
      meta: '1.1 тыс. просмотров • 6 ч назад'
    }
  ];

  const CATEGORY_FEEDS = {
    all: HOME_RECOMMENDATIONS,
    music: [
      { id: '6CZLCZZNc90', title: 'Джем – Garik - indz el tar', channel: 'Garik Papoyan', duration: '3:10', meta: 'Джем • 185 тыс.' },
      { id: 'mFRh6wVyMaE', title: 'Brunette - Bac kapuyt achqerd', channel: 'Brunette', duration: '3:36', meta: '2.4 млн просмотров' },
      { id: 'TPjN6N8TgNI', title: 'Super Sako - Mi Gna ft. Hayko', channel: 'Super Sako', duration: '3:22', meta: '320 млн просмотров' },
      { id: 'Z1bS3aT_r24', title: 'Garik & Sona - Lusi', channel: 'Garik & Sona', duration: '4:12', meta: '5.1 млн просмотров' },
      { id: 'kLp_Hh684HQ', title: 'Aram MP3 - Not Alone', channel: 'Aram MP3', duration: '3:02', meta: '12 млн просмотров' }
    ],
    jams: [
      { id: '6CZLCZZNc90', title: 'Джем – Garik - indz el tar (official lyrics video)', channel: 'Garik Papoyan', duration: '3:10', meta: 'Джем • 185 тыс.' },
      { id: '1QnCj2g8g_g', title: 'Garik Papoyan - Jam Session Live Acoustic', channel: 'Garik Papoyan', duration: '24:15', meta: 'Акустический джем' },
      { id: '8JkL99qX1rU', title: 'Armenian Street Music & Jam Acoustic', channel: 'Yerevan Jam', duration: '18:40', meta: 'Live Session' }
    ],
    armcomedy: [
      { id: 'OLqjgBoPV9E', title: 'ArmComedy 1439 - COP 17, Էփշթեյն և Ամուլսար', channel: 'ArmComedy', duration: '30:13', meta: '10 тыс. • 2 ч назад' },
      { id: '04HS6MkhOr4', title: 'Պարոդիա - Լիլի Հովեր', channel: 'HD Production', duration: '3:52', meta: '14 тыс. • 2 ч назад' },
      { id: 'Kq06w4ZkEeo', title: 'ArmComedy 1438', channel: 'ArmComedy', duration: '28:40', meta: '52 тыс. просмотров' },
      { id: 'a4Xp_BfX9aI', title: 'Ruben Yesayan - Stand Up Yerevan', channel: 'Ruben Yesayan', duration: '16:22', meta: '85 тыс. просмотров' }
    ],
    auto: [
      { id: 'vPNsZM2y7bw', title: '🚨Նոր ավտոյիս վրա ԱՎՏՈԲՈՒՍԻ մատոռ⚡The Long Drive #104', channel: 'Saint-Hov 🇦🇲', duration: '13:51', meta: '114 тыс. • 4 мес. назад' },
      { id: 'z3wqyffIosw', title: 'Сделал 1 кг филамента для 3D-принтера из мусорных бутылок ♻️', channel: 'Modelmen Life', duration: '9:12', meta: '145 тыс. • 10 дн. назад' },
      { id: 'K7nFz2u5RkQ', title: 'Tesla Model 3 / Model Y Hidden Tricks & Tips', channel: 'Tesla Drivers', duration: '14:20', meta: '220 тыс. просмотров' }
    ],
    football: [
      { id: '5bFiccd8lCI', title: 'When Young Lionel Messi Substituted & SHOCKED Pep Guardiola', channel: 'VALENTINO PRODUCTIONS', duration: '12:44', meta: '1.2 млн • 1 мес. назад' },
      { id: 'ayMA_IeEp2Q', title: '#Corner Mundial #1. Աշխարհի առաջնությունը՝ Օգնյեն Չանչարևիչի հետ', channel: 'Corner Football Armenia', duration: '53:43', meta: '38 тыс. просмотров' }
    ],
    news: [
      { id: 'rOgehCKt-VA', title: 'Երևանի Քրիստափորի փողոցի փտած ...', channel: 'Shamshyan.com', duration: '8:36', meta: '1.1 тыс. • 6 ч назад' },
      { id: '9QvH0rWwL8M', title: 'PanArmenian News Today Highlights', channel: 'PanArmenian TV', duration: '15:10', meta: 'Новости дня' }
    ]
  };

  function getYouTubeHistory() {
    try {
      return JSON.parse(localStorage.getItem('tesla_yt_history') || '[]');
    } catch (e) {
      return [];
    }
  }

  function addToYouTubeHistory(track) {
    if (!track || !track.id) return;
    try {
      let history = getYouTubeHistory();
      history = history.filter(t => t.id !== track.id);
      history.unshift({
        id: track.id,
        title: track.title,
        channel: track.channel || 'YouTube',
        duration: track.duration || '3:30',
        meta: 'Ранее прослушано',
        playedAt: Date.now()
      });
      if (history.length > 40) history = history.slice(0, 40);
      localStorage.setItem('tesla_yt_history', JSON.stringify(history));
    } catch (e) {}
  }

  function clearYouTubeHistory() {
    try {
      localStorage.removeItem('tesla_yt_history');
      loadYouTubeCategory('history');
    } catch (e) {}
  }

  function createResultItemElement(track, idx) {
    const item = document.createElement('div');
    const isPlaying = (currentTrackInfo && currentTrackInfo.id === track.id) || (currentTrackIndex === idx);
    item.className = `yt-result-item ${isPlaying ? 'playing' : ''}`;
    item.dataset.id = track.id;
    item.dataset.index = idx;

    const thumbUrl = track.thumbnail || `https://i.ytimg.com/vi/${track.id}/hqdefault.jpg`;
    const metaText = [track.channel, track.meta || track.duration].filter(Boolean).join(' · ');

    item.innerHTML = `
      <div class="yt-thumb-wrap">
        <img class="yt-thumb-img" src="${thumbUrl}" alt="" loading="lazy" />
        <span class="yt-duration-badge">${track.duration || '3:30'}</span>
      </div>
      <div class="yt-info-wrap">
        <div class="yt-item-title">${track.title}</div>
        <div class="yt-item-meta">${metaText}</div>
      </div>
    `;

    item.addEventListener('click', () => {
      currentTrackIndex = idx;
      currentTrackInfo = track;
      playTrackById(track.id, track.title, track.channel, track.duration);
    });

    return item;
  }

  // Render recommendations with Infinite Scroll support
  function renderRecommendations(tracks) {
    if (!ytResultsList) return;
    ytResultsList.innerHTML = '';
    if (!tracks || tracks.length === 0) {
      ytResultsList.innerHTML = '<div style="text-align: center; color: #94a3b8; padding: 24px 10px; font-size: 13px;">Ничего не найдено</div>';
      return;
    }
    appendRecommendations(tracks, 0);
  }

  function renderHomeWithHistory(history, recommendations) {
    if (!ytResultsList) return;
    ytResultsList.innerHTML = '';

    // If user has recently played history, render "Недавно прослушано" at the top!
    if (history && history.length > 0) {
      const histSec = document.createElement('div');
      histSec.className = 'yt-section-header';
      histSec.innerHTML = `
        <span>Недавно прослушано</span>
        <button class="yt-clear-history-btn" id="btn-clear-yt-hist">Очистить</button>
      `;
      ytResultsList.appendChild(histSec);

      history.slice(0, 4).forEach((track, idx) => {
        const item = createResultItemElement(track, idx);
        ytResultsList.appendChild(item);
      });

      const recSec = document.createElement('div');
      recSec.className = 'yt-section-header';
      recSec.style.marginTop = '8px';
      recSec.innerHTML = `<span>Рекомендовано для вас</span>`;
      ytResultsList.appendChild(recSec);
    }

    recommendations.forEach((track, idx) => {
      const offset = history && history.length > 0 ? Math.min(4, history.length) : 0;
      const item = createResultItemElement(track, offset + idx);
      ytResultsList.appendChild(item);
    });

    document.getElementById('btn-clear-yt-hist')?.addEventListener('click', (e) => {
      e.stopPropagation();
      clearYouTubeHistory();
    });
  }

  function renderHistoryView(history) {
    if (!ytResultsList) return;
    ytResultsList.innerHTML = '';
    if (!history || history.length === 0) {
      ytResultsList.innerHTML = `
        <div style="text-align: center; color: #94a3b8; padding: 36px 16px; font-size: 13px; line-height: 1.5;">
          <div style="font-size: 28px; margin-bottom: 6px;">🎧</div>
          История пуста.<br>Включайте музыку и видео в поиске или рекомендациях, и они сохранятся здесь.
        </div>
      `;
      return;
    }

    const histSec = document.createElement('div');
    histSec.className = 'yt-section-header';
    histSec.innerHTML = `
      <span>История воспроизведения (${history.length})</span>
      <button class="yt-clear-history-btn" id="btn-clear-all-hist">Очистить всё</button>
    `;
    ytResultsList.appendChild(histSec);

    history.forEach((track, idx) => {
      const item = createResultItemElement(track, idx);
      ytResultsList.appendChild(item);
    });

    document.getElementById('btn-clear-all-hist')?.addEventListener('click', (e) => {
      e.stopPropagation();
      clearYouTubeHistory();
    });
  }

  function loadYouTubeCategory(cat) {
    currentActiveTab = cat;
    document.querySelectorAll('.yt-filter-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === cat);
    });

    if (cat === 'history') {
      const history = getYouTubeHistory();
      youtubeQueue = history;
      currentYtContinuationToken = null;
      renderHistoryView(history);
      return;
    }

    if (cat === 'all') {
      const history = getYouTubeHistory();
      youtubeQueue = [...HOME_RECOMMENDATIONS];
      currentYtContinuationToken = null;
      renderHomeWithHistory(history, HOME_RECOMMENDATIONS);
      return;
    }

    const feed = CATEGORY_FEEDS[cat];
    if (feed && feed.length > 0) {
      youtubeQueue = [...feed];
      currentYtContinuationToken = null;
      renderRecommendations(feed);
    } else {
      handleYtSearch(cat);
    }
  }

  function appendRecommendations(tracks, startIndex) {
    if (!ytResultsList) return;
    tracks.forEach((track, offset) => {
      const idx = startIndex + offset;
      const item = createResultItemElement(track, idx);
      ytResultsList.appendChild(item);
    });
  }

  // Infinite Scroll fetcher for YouTube
  async function loadMoreYtResults() {
    if (isYtLoadingMore || !currentYtContinuationToken || !ytResultsList) return;
    isYtLoadingMore = true;

    let loaderEl = document.getElementById('yt-infinite-loader');
    if (!loaderEl) {
      loaderEl = document.createElement('div');
      loaderEl.id = 'yt-infinite-loader';
      loaderEl.style.cssText = 'text-align: center; padding: 12px; color: #94a3b8; font-size: 12px; font-weight: 500;';
      loaderEl.innerHTML = '<span style="display:inline-block; animation: spin 1s infinite linear;">↻</span> Загрузка...';
      ytResultsList.appendChild(loaderEl);
    }

    try {
      const res = await fetch(`/api/yt-search?continuation=${encodeURIComponent(currentYtContinuationToken)}`);
      const data = await res.json();
      if (data.results && data.results.length > 0) {
        currentYtContinuationToken = data.continuationToken || null;
        const startIndex = youtubeQueue.length;
        youtubeQueue.push(...data.results);
        appendRecommendations(data.results, startIndex);
      } else {
        currentYtContinuationToken = null;
      }
    } catch (err) {
      console.warn('Infinite scroll YouTube fetch error:', err);
    } finally {
      isYtLoadingMore = false;
      document.getElementById('yt-infinite-loader')?.remove();
    }
  }

  // Infinite scroll listener on YouTube results list
  if (ytResultsList) {
    ytResultsList.addEventListener('scroll', () => {
      if (ytResultsList.scrollTop + ytResultsList.clientHeight >= ytResultsList.scrollHeight - 140) {
        loadMoreYtResults();
      }
    });
  }

  // Live YouTube Search & Immediate Auto-Play of First Result (User Explicit Requirement)
  async function handleYtSearch(customQuery) {
    const q = (customQuery !== undefined ? customQuery : (ytSearchInput ? ytSearchInput.value : '')).trim();
    if (!q) return;

    if (btnYtSearchClear) {
      btnYtSearchClear.classList.toggle('hidden', !q);
    }

    // Direct YouTube link or ID
    const urlMatch = q.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
    if (urlMatch && urlMatch[1]) {
      const videoId = urlMatch[1];
      playTrackById(videoId, q, 'YouTube', '3:30');
      return;
    }

    if (btnYtSearchGo) btnYtSearchGo.textContent = '...';
    currentYtQuery = q;
    currentYtContinuationToken = null;
    isYtLoadingMore = false;
    document.getElementById('yt-suggestions-box')?.classList.add('hidden');

    try {
      const res = await fetch(`/api/yt-search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (data.results && data.results.length > 0) {
        youtubeQueue = data.results;
        currentYtContinuationToken = data.continuationToken || null;
        currentTrackIndex = 0;
        currentTrackInfo = youtubeQueue[0];

        // 1. Render all 20 results with infinite scroll capability
        renderRecommendations(youtubeQueue);

        // 2. Immediately auto-play the 1st song (User requirement)
        playTrackById(currentTrackInfo.id, currentTrackInfo.title, currentTrackInfo.channel, currentTrackInfo.duration);
      } else {
        renderRecommendations([]);
      }
    } catch (err) {
      console.warn('YouTube search error:', err);
    } finally {
      if (btnYtSearchGo) btnYtSearchGo.textContent = 'Search';
    }
  }

  // YouTube Autocomplete Suggestions System
  const ytSuggestionsBox = document.getElementById('yt-suggestions-box');
  let ytSuggestDebounceTimer = null;

  async function fetchYtSuggestions(query) {
    if (!query || query.length < 2 || !ytSuggestionsBox) {
      if (ytSuggestionsBox) ytSuggestionsBox.classList.add('hidden');
      return;
    }

    try {
      const res = await fetch(`/api/yt-suggestions?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (data.suggestions && data.suggestions.length > 0) {
        renderYtSuggestions(data.suggestions);
      } else {
        ytSuggestionsBox.classList.add('hidden');
      }
    } catch (err) {
      console.warn('Suggestions fetch error:', err);
      ytSuggestionsBox.classList.add('hidden');
    }
  }

  function renderYtSuggestions(suggestions) {
    if (!ytSuggestionsBox) return;
    ytSuggestionsBox.innerHTML = '';
    suggestions.slice(0, 8).forEach(s => {
      const item = document.createElement('div');
      item.className = 'yt-suggestion-item';
      item.innerHTML = `
        <svg class="yt-suggest-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <span>${s}</span>
      `;
      item.addEventListener('click', () => {
        if (ytSearchInput) ytSearchInput.value = s;
        ytSuggestionsBox.classList.add('hidden');
        handleYtSearch(s);
      });
      ytSuggestionsBox.appendChild(item);
    });
    ytSuggestionsBox.classList.remove('hidden');
  }

  document.addEventListener('click', (e) => {
    if (ytSuggestionsBox && !e.target.closest('.yt-search-pill-container')) {
      ytSuggestionsBox.classList.add('hidden');
    }
  });

  if (btnYtSearchGo) btnYtSearchGo.addEventListener('click', () => handleYtSearch());
  if (ytSearchInput) {
    ytSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        ytSuggestionsBox?.classList.add('hidden');
        handleYtSearch();
      } else if (e.key === 'Escape') {
        ytSuggestionsBox?.classList.add('hidden');
      }
    });
    ytSearchInput.addEventListener('input', () => {
      const val = ytSearchInput.value.trim();
      if (btnYtSearchClear) {
        btnYtSearchClear.classList.toggle('hidden', !val);
      }
      clearTimeout(ytSuggestDebounceTimer);
      ytSuggestDebounceTimer = setTimeout(() => {
        fetchYtSuggestions(val);
      }, 200);
    });
  }
  if (btnYtSearchClear) {
    btnYtSearchClear.addEventListener('click', () => {
      if (ytSearchInput) {
        ytSearchInput.value = '';
        btnYtSearchClear.classList.add('hidden');
        ytSuggestionsBox?.classList.add('hidden');
        ytSearchInput.focus();
      }
    });
  }

  // Category filter tabs: Все, Музыка, Джемы, ArmComedy, Авто & Игры, Футбол, Новости, История
  document.querySelectorAll('.yt-filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab || 'all';
      loadYouTubeCategory(tabName);
    });
  });

  // Pre-load default YouTube recommendations so feed is ready instantly
  loadYouTubeCategory('all');

  // Timeline scrubber click to seek
  if (ytTimelineTrack) {
    ytTimelineTrack.addEventListener('click', (e) => {
      if (!isMusicPlaying || ytTotalDurationSec <= 0) return;
      const rect = ytTimelineTrack.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, clickX / rect.width));
      ytElapsedSec = Math.floor(ratio * ytTotalDurationSec);
      if (ytTimelineFill) ytTimelineFill.style.width = `${ratio * 100}%`;
      if (ytTimeCur) ytTimeCur.textContent = formatTime(ytElapsedSec);
      if (ytIframe) {
        ytIframe.contentWindow.postMessage(JSON.stringify({
          event: 'command',
          func: 'seekTo',
          args: [ytElapsedSec, true]
        }), '*');
      }
    });
  }

  // Shuffle button
  if (btnYtShuffle) {
    btnYtShuffle.addEventListener('click', () => {
      if (youtubeQueue.length <= 1) return;
      for (let i = youtubeQueue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [youtubeQueue[i], youtubeQueue[j]] = [youtubeQueue[j], youtubeQueue[i]];
      }
      renderRecommendations(youtubeQueue);
    });
  }

  // Fullscreen button
  if (btnYtFullscreen) {
    btnYtFullscreen.addEventListener('click', () => {
      if (ytIframe && ytIframe.requestFullscreen) {
        ytIframe.requestFullscreen().catch(() => {});
      }
    });
  }

  // Play / Pause unified toggle
  function togglePlayPause() {
    if (!isMusicPlaying) {
      if (currentTrackIndex >= 0 && youtubeQueue[currentTrackIndex]) {
        const track = youtubeQueue[currentTrackIndex];
        playTrackById(track.id, track.title, track.channel, track.duration);
      } else if (youtubeQueue.length > 0) {
        currentTrackIndex = 0;
        const track = youtubeQueue[0];
        playTrackById(track.id, track.title, track.channel, track.duration);
      } else {
        handleYtSearch('top music hits');
      }
    } else {
      syncMusicState(false);
      if (ytIframe) {
        ytIframe.contentWindow.postMessage('{"event":"command","func":"pauseVideo","args":""}', '*');
      }
    }
  }

  btnMusicPlay.addEventListener('click', togglePlayPause);
  if (btnMiniPlay) btnMiniPlay.addEventListener('click', togglePlayPause);

  // Next / Prev unified handlers
  function playNextTrack() {
    if (youtubeQueue.length === 0) return;
    currentTrackIndex = (currentTrackIndex + 1) % youtubeQueue.length;
    const track = youtubeQueue[currentTrackIndex];
    currentTrackInfo = track;
    playTrackById(track.id, track.title, track.channel, track.duration);
  }

  function playPrevTrack() {
    if (youtubeQueue.length === 0) return;
    currentTrackIndex = (currentTrackIndex - 1 + youtubeQueue.length) % youtubeQueue.length;
    const track = youtubeQueue[currentTrackIndex];
    currentTrackInfo = track;
    playTrackById(track.id, track.title, track.channel, track.duration);
  }

  btnMusicNext.addEventListener('click', playNextTrack);
  if (btnMiniNext) btnMiniNext.addEventListener('click', playNextTrack);

  btnMusicPrev.addEventListener('click', playPrevTrack);
  if (btnMiniPrev) btnMiniPrev.addEventListener('click', playPrevTrack);
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

  const btnDiagTtsSvetlana = document.getElementById('btn-diag-tts-svetlana');
  if (btnDiagTtsSvetlana) {
    btnDiagTtsSvetlana.addEventListener('click', () => {
      console.log('👩 [Диагностика] Воспроизведение голоса: Светлана (ru-RU-SvetlanaNeural)...');
      if (mapEngine) {
        mapEngine.playNavChime();
        mapEngine.speakVoice('Здравствуйте! Я Светлана, ваш голосовой навигатор в Tesla Navi. Маршрут свободен, приятной дороги!', 'svetlana');
        console.log('🗣️ Запущена фраза самопрезентации Светланы');
      }
    });
  }

  const btnDiagTtsDmitry = document.getElementById('btn-diag-tts-dmitry');
  if (btnDiagTtsDmitry) {
    btnDiagTtsDmitry.addEventListener('click', () => {
      console.log('👨 [Диагностика] Воспроизведение голоса: Дмитрий (ru-RU-DmitryNeural)...');
      if (mapEngine) {
        mapEngine.playNavChime();
        mapEngine.speakVoice('Здравствуйте! Я Дмитрий, ваш голосовой навигатор в Tesla Navi. Маршрут свободен, приятной дороги!', 'dmitry');
        console.log('🗣️ Запущена фраза самопрезентации Дмитрия');
      }
    });
  }


  const btnDiagTtsGor = document.getElementById('btn-diag-tts-gor');
  if (btnDiagTtsGor) {
    btnDiagTtsGor.addEventListener('click', () => {
      console.log('👨 [Диагностика] Воспроизведение армянского голоса: Գոռ (Gor)...');
      if (mapEngine) {
        mapEngine.playNavChime();
        mapEngine.speakVoice('welcome', 'gor');
        console.log('🗣️ Запущена фраза самопрезентации Գոռ (Հայերեն)');
      }
    });
  }

  const btnDiagTtsSuzie = document.getElementById('btn-diag-tts-suzie');
  if (btnDiagTtsSuzie) {
    btnDiagTtsSuzie.addEventListener('click', () => {
      console.log('👩 [Диагностика] Воспроизведение армянского голоса: Սյուզի (Suzie)...');
      if (mapEngine) {
        mapEngine.playNavChime();
        mapEngine.speakVoice('welcome', 'suzie');
        console.log('🗣️ Запущена фраза самопрезентации Սյուզի (Հայերեն)');
      }
    });
  }

  const btnDiagTtsEn = document.getElementById('btn-diag-tts-en');
  if (btnDiagTtsEn) {
    btnDiagTtsEn.addEventListener('click', () => {
      console.log('🇺🇸 [Диагностика] Воспроизведение голоса: Ava (en-US-AvaNeural)...');
      if (mapEngine) {
        mapEngine.playNavChime();
        mapEngine.speakVoice('Hello! I am Ava, your Tesla Navi voice assistant. The route is clear, have a safe trip!', 'ava');
        console.log('🗣️ Запущена фраза самопрезентации Ava (EN)');
      }
    });
  }

  const btnDiagYt = document.getElementById('btn-diag-yt');
  if (btnDiagYt) {
    btnDiagYt.addEventListener('click', () => {
      console.log('🎵 [Диагностика] Тестирование YouTube плеера...');
      const ytIframe = document.getElementById('yt-player-iframe');
      if (ytIframe) {
        const testId = (youtubeQueue && youtubeQueue[0]) ? youtubeQueue[0].id : 'dQw4w9WgXcQ';
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

  // Interpolate position and heading at exact distance along polyline with lookahead curve anticipation
  function getPositionAtDistance(dist) {
    if (mapEngine && typeof mapEngine.getPositionAtDistance === 'function') {
      const pt = mapEngine.getPositionAtDistance(dist, 24);
      if (pt) return pt;
    }

    const coords = mapEngine?.routeCoordinates;
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

    // Lookahead for curve anticipation
    const aheadDist = Math.min(simTotalDist, clampedDist + 24);
    let aheadSegIdx = segIdx;
    for (let i = segIdx; i < cumulativeDistances.length - 1; i++) {
      if (aheadDist >= cumulativeDistances[i] && aheadDist <= cumulativeDistances[i + 1]) {
        aheadSegIdx = i;
        break;
      }
    }
    const aheadStart = cumulativeDistances[aheadSegIdx] || 0;
    const aheadEnd = cumulativeDistances[aheadSegIdx + 1] || (aheadStart + 1);
    const aheadT = Math.max(0, Math.min(1, (aheadDist - aheadStart) / Math.max(0.001, aheadEnd - aheadStart)));
    const ap1 = coords[aheadSegIdx];
    const ap2 = coords[Math.min(coords.length - 1, aheadSegIdx + 1)];
    const aheadLng = ap1[0] + (ap2[0] - ap1[0]) * aheadT;
    const aheadLat = ap1[1] + (ap2[1] - ap1[1]) * aheadT;

    let heading = mapEngine.calculateBearing(p1[1], p1[0], p2[1], p2[0]);
    if (aheadDist > clampedDist + 0.5) {
      heading = mapEngine.calculateBearing(lat, lng, aheadLat, aheadLng);
    }

    return { lat, lng, heading };
  }

  function updateSimCar(targetDist) {
    simDistance = Math.max(0, Math.min(simTotalDist, targetDist));
    const pt = getPositionAtDistance(simDistance);
    const curSpeed = isSimRunning ? Math.round(simSpeed) : 0;
    if (pt && mapEngine) {
      mapEngine.updateCarPosition(pt.lat, pt.lng, pt.heading, curSpeed);
    }
    updateSpeedometerDisplay(curSpeed);

    const pct = Math.min(100, Math.round((simDistance / simTotalDist) * 100));
    if (scrubSlider) scrubSlider.value = pct;
    if (scrubVal) scrubVal.textContent = `${pct}%`;
    const traveledFill = document.getElementById('prog-traveled-fill');
    if (traveledFill) traveledFill.style.width = `${pct}%`;
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
    btnSimPlay.addEventListener('click', async (e) => {
      if (e) e.preventDefault();
      try {
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
      } catch (err) {
        console.error('Ошибка в кнопке Поехать:', err);
      }
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

