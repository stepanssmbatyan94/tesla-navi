// Tesla Phone Remote Controller

let pairingCode = '';
let realtimeClient = null;
let isSharingGps = false;
let watchId = null;
let wakeLock = null;
let gpsPermissionDenied = false;
let lastPhonePos = null;
let lastFixAt = 0;
let currentLang = 'ru';

// Language: ?lang= from the car's QR code, else the phone's own language, else Russian
function detectPhoneLanguage() {
  const fromUrl = new URLSearchParams(window.location.search).get('lang');
  if (fromUrl && I18N[fromUrl]) return fromUrl;
  const nav = (navigator.language || '').slice(0, 2).toLowerCase();
  return I18N[nav] ? nav : 'ru';
}

function tr(key) {
  return (I18N[currentLang] && I18N[currentLang][key]) || I18N.ru[key] || key;
}

function applyPhoneLanguage() {
  document.documentElement.lang = currentLang;
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = tr(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = tr(el.dataset.i18nPlaceholder); });
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = tr(el.dataset.i18nTitle); });
}

document.addEventListener('DOMContentLoaded', () => {
  currentLang = detectPhoneLanguage();
  applyPhoneLanguage();
  initParams();
  initRealtime();
  initGpsToggle();
  initDestinationHandlers();
  initVoiceSearch();

  // Auto-start GPS sharing immediately when phone remote loads
  startGpsSharing().catch(err => {
    console.log('[Phone Remote] Auto GPS start deferred for user gesture:', err);
  });

  // Re-acquire GPS, wake lock & the socket when phone tab becomes visible again
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (realtimeClient) {
        realtimeClient.ensureLocalWs();
        realtimeClient.sendPing();
      }
      if (!isSharingGps) {
        if (!gpsPermissionDenied) startGpsSharing();
      } else if (!wakeLock) {
        // The browser releases the screen wake lock whenever the tab is hidden
        requestWakeLock();
      }
    }
  });
});

function initParams() {
  const urlParams = new URLSearchParams(window.location.search);
  pairingCode = (urlParams.get('code') || 'DEMO12').toUpperCase();
  document.getElementById('pairing-code-display').textContent = pairingCode;
}

function initRealtime() {
  realtimeClient = new TeslaRealtime({
    code: pairingCode,
    role: 'phone',
    onStatusChange: (connected) => {
      updateTeslaConnectionPill(connected);
    }
  });

  realtimeClient.init();
}

function updateTeslaConnectionPill(connected) {
  const pill = document.getElementById('connection-pill');
  const label = document.getElementById('connection-label');

  if (connected) {
    pill.className = 'connection-pill connected';
    label.textContent = tr('connectedCar');
  } else {
    pill.className = 'connection-pill disconnected';
    label.textContent = tr('waitingCar');
  }
}

// GPS Watcher & WakeLock
function initGpsToggle() {
  const btn = document.getElementById('btn-share-gps');

  btn.addEventListener('click', async () => {
    if (!isSharingGps) {
      startGpsSharing();
    } else {
      stopGpsSharing();
    }
  });
}

// Request Screen Wake Lock so phone doesn't sleep while driving
async function requestWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock) return;
  try {
    const lock = await navigator.wakeLock.request('screen');
    wakeLock = lock;
    lock.addEventListener('release', () => {
      if (wakeLock === lock) wakeLock = null;
      document.getElementById('wake-status').textContent = '';
    });
    document.getElementById('wake-status').textContent = tr('screenAwake');
  } catch (err) {
    console.warn('Wake Lock error:', err);
  }
}

function calculatePhoneBearing(lat1, lon1, lat2, lon2) {
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const lat1Rad = (lat1 * Math.PI) / 180;
  const lat2Rad = (lat2 * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(lat2Rad);
  const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);
  let brng = (Math.atan2(y, x) * 180) / Math.PI;
  return (brng + 360) % 360;
}

async function startGpsSharing() {
  if (!navigator.geolocation) {
    alert(tr('geoUnsupported'));
    return;
  }
  // Auto-start, the button and visibilitychange can all fire: never stack watchers
  if (isSharingGps) return;
  isSharingGps = true;
  gpsPermissionDenied = false;

  const btn = document.getElementById('btn-share-gps');
  btn.classList.add('active');
  btn.innerHTML = `
    <svg class="satellite-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="2"></circle>
      <path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"></path>
    </svg>
    <span>${tr('stopGps')}</span>
  `;

  requestWakeLock();

  // Start continuous watchPosition
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(
    (position) => {
      const coords = position.coords;
      const speedKmh = coords.speed ? Math.round(coords.speed * 3.6) : 0;
      
      let heading = coords.heading || 0;
      if (!heading && lastPhonePos) {
        const d = Math.hypot(coords.latitude - lastPhonePos.lat, coords.longitude - lastPhonePos.lng);
        if (d > 0.000015) { // ~1.5m movement
          heading = calculatePhoneBearing(lastPhonePos.lat, lastPhonePos.lng, coords.latitude, coords.longitude);
        }
      }
      lastPhonePos = { lat: coords.latitude, lng: coords.longitude };
      lastFixAt = Date.now();
      updateFixAge();

      // Update phone UI
      document.getElementById('phone-speed-val').textContent = speedKmh;
      document.getElementById('phone-accuracy-val').textContent = `±${Math.round(coords.accuracy)} ${tr('m')}`;

      // Broadcast to Tesla display
      realtimeClient.sendGps({
        lat: coords.latitude,
        lng: coords.longitude,
        heading: Math.round(heading),
        speed: coords.speed || 0,
        accuracy: coords.accuracy || 5
      });
    },
    (error) => {
      console.error('GPS error:', error);
      if (error.code === error.PERMISSION_DENIED) {
        stopGpsSharing();
        // Don't re-prompt on every tab switch: retry only from the button
        gpsPermissionDenied = true;
        alert(tr('geoDenied'));
      }
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10000
    }
  );
}

// How long ago the phone got its last GPS fix (replaces the old fixed '18 satellites / 12 ms')
function updateFixAge() {
  const el = document.getElementById('phone-fix-age');
  if (!el) return;
  if (!lastFixAt) { el.textContent = '—'; return; }
  const sec = Math.round((Date.now() - lastFixAt) / 1000);
  el.textContent = sec <= 1 ? tr('fixNow') : `${sec} ${tr('secondsAgo')}`;
  el.style.color = sec > 10 ? 'var(--accent-red, #ef4444)' : '';
}
setInterval(updateFixAge, 1000);

function stopGpsSharing() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }

  isSharingGps = false;
  const btn = document.getElementById('btn-share-gps');
  btn.classList.remove('active');
  btn.innerHTML = `
    <svg class="satellite-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="2"></circle>
      <path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"></path>
    </svg>
    <span>${tr('startGps')}</span>
  `;
  document.getElementById('wake-status').textContent = '';
}

// Destination Search & Google Maps links
function initDestinationHandlers() {
  const btnSend = document.getElementById('btn-send-tesla');
  const btnPaste = document.getElementById('btn-paste-clip');
  const inputAddress = document.getElementById('input-address');
  const inputMapsLink = document.getElementById('input-maps-link');

  // Paste from clipboard
  btnPaste.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      inputMapsLink.value = text;
      parseAndSendDestination(text);
    } catch (e) {
      inputMapsLink.focus();
    }
  });

  // Send to Tesla button
  btnSend.addEventListener('click', () => {
    const query = inputAddress.value.trim() || inputMapsLink.value.trim();
    if (!query) {
      inputAddress.focus();
      return;
    }
    parseAndSendDestination(query);
  });

  // Enter key support
  [inputAddress, inputMapsLink].forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const query = input.value.trim();
        if (query) parseAndSendDestination(query);
      }
    });
  });
}

async function parseAndSendDestination(query) {
  const btnSend = document.getElementById('btn-send-tesla');
  const originalText = btnSend.textContent;
  btnSend.textContent = tr('sendingToTesla');
  btnSend.disabled = true;

  try {
    // 1. First check if direct coordinates (e.g. 40.189551, 44.468663)
    const coordRegex = /(-?\d+\.\d+)[,\s]+(-?\d+\.\d+)/;
    const match = query.match(coordRegex);

    if (match && !query.includes('http')) {
      const lat = parseFloat(match[1]);
      const lng = parseFloat(match[2]);
      sendToTeslaAndNotify({ name: tr('coordsPoint'), lat, lng }, btnSend, originalText);
      return;
    }

    // 2. Query our backend location resolver (handles maps.app.goo.gl, google.com/maps, and addresses)
    const resolveUrl = `/api/resolve-location?q=${encodeURIComponent(query)}`;
    const res = await fetch(resolveUrl);
    const data = await res.json();

    if (data && data.success) {
      sendToTeslaAndNotify({
        name: data.name || query,
        lat: data.lat,
        lng: data.lng
      }, btnSend, originalText);
    } else {
      alert(tr('resolveFailed'));
      btnSend.disabled = false;
      btnSend.textContent = originalText;
    }
  } catch (err) {
    console.error('Resolve error:', err);
    // Direct fallback
    alert(`${tr('networkError')}: ${err.message}`);
    btnSend.disabled = false;
    btnSend.textContent = originalText;
  }
}

function sendToTeslaAndNotify(dest, btn, originalText) {
  console.log('⚡ Sending destination to Tesla:', dest);
  realtimeClient.sendDestination(dest);

  btn.disabled = false;
  btn.style.background = '#10b981';
  btn.textContent = tr('sentToTesla');

  // Vibrate if mobile device supports it
  if (navigator.vibrate) {
    navigator.vibrate([80, 50, 80]);
  }

  setTimeout(() => {
    btn.style.background = '';
    btn.textContent = originalText;
  }, 3000);
}

// Voice search dictation
function initVoiceSearch() {
  const btnMic = document.getElementById('btn-mic');
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    btnMic.style.display = 'none';
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = currentLang === 'hy' ? 'hy-AM' : (currentLang === 'en' ? 'en-US' : 'ru-RU');

  btnMic.addEventListener('click', () => {
    btnMic.style.color = '#ef4444';
    recognition.start();
  });

  recognition.onresult = (event) => {
    btnMic.style.color = '';
    const transcript = event.results[0][0].transcript;
    document.getElementById('input-address').value = transcript;
    parseAndSendDestination(transcript);
  };

  recognition.onerror = () => {
    btnMic.style.color = '';
  };
}
