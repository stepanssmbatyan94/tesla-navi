// Tesla Phone Remote Controller

let pairingCode = '';
let realtimeClient = null;
let isSharingGps = false;
let watchId = null;
let wakeLock = null;
let currentLang = 'ru';

document.addEventListener('DOMContentLoaded', () => {
  initParams();
  initRealtime();
  initGpsToggle();
  initDestinationHandlers();
  initVoiceSearch();
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
    label.textContent = 'Подключено к Tesla';
  } else {
    pill.className = 'connection-pill disconnected';
    label.textContent = 'Ожидание автомобиля...';
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

async function startGpsSharing() {
  if (!navigator.geolocation) {
    alert('Геолокация не поддерживается вашим браузером');
    return;
  }

  const btn = document.getElementById('btn-share-gps');
  btn.classList.add('active');
  btn.innerHTML = `
    <svg class="satellite-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="2"></circle>
      <path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"></path>
    </svg>
    <span>Остановить передачу GPS</span>
  `;

  // Request Screen Wake Lock so phone doesn't sleep while driving
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      document.getElementById('wake-status').textContent = '• Экран бодрствует';
    }
  } catch (err) {
    console.warn('Wake Lock error:', err);
  }

  isSharingGps = true;

  // Start continuous watchPosition
  watchId = navigator.geolocation.watchPosition(
    (position) => {
      const coords = position.coords;
      const speedKmh = coords.speed ? Math.round(coords.speed * 3.6) : 0;
      
      // Update phone UI
      document.getElementById('phone-speed-val').textContent = speedKmh;
      document.getElementById('phone-accuracy-val').textContent = `±${Math.round(coords.accuracy)}м`;

      // Broadcast to Tesla display
      realtimeClient.sendGps({
        lat: coords.latitude,
        lng: coords.longitude,
        heading: coords.heading || 0,
        speed: coords.speed || 0,
        accuracy: coords.accuracy || 5
      });
    },
    (error) => {
      console.error('GPS error:', error);
      if (error.code === error.PERMISSION_DENIED) {
        alert('Пожалуйста, разрешите доступ к геопозиции в настройках браузера');
        stopGpsSharing();
      }
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10000
    }
  );
}

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
    <span>Включить передачу GPS</span>
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
  btnSend.textContent = 'Отправка в Tesla...';
  btnSend.disabled = true;

  try {
    // 1. First check if direct coordinates (e.g. 40.189551, 44.468663)
    const coordRegex = /(-?\d+\.\d+)[,\s]+(-?\d+\.\d+)/;
    const match = query.match(coordRegex);

    if (match && !query.includes('http')) {
      const lat = parseFloat(match[1]);
      const lng = parseFloat(match[2]);
      sendToTeslaAndNotify({ name: 'Координаты точки', lat, lng }, btnSend, originalText);
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
      alert('Не удалось определить адрес или ссылку. Попробуйте уточнить название.');
      btnSend.disabled = false;
      btnSend.textContent = originalText;
    }
  } catch (err) {
    console.error('Resolve error:', err);
    // Direct fallback
    alert('Ошибка сети при поиске адреса: ' + err.message);
    btnSend.disabled = false;
    btnSend.textContent = originalText;
  }
}

function sendToTeslaAndNotify(dest, btn, originalText) {
  console.log('⚡ Sending destination to Tesla:', dest);
  realtimeClient.sendDestination(dest);

  btn.disabled = false;
  btn.style.background = '#10b981';
  btn.textContent = '✓ Отправлено в Tesla!';

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
  recognition.lang = 'ru-RU';

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
