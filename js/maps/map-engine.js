// Tesla Navi Advanced Map Engine (MapLibre GL Clean 2D/Heading-Up + Yandex Navigator Styling)

class TeslaMapEngine {
  constructor(containerId, options = {}) {
    this.containerId = containerId;
    this.provider = options.provider || CONFIG.defaultProvider || 'maplibre';
    this.center = options.center || CONFIG.defaultCenter;
    this.navZoom = CONFIG.navigationZoom || 16.5;
    this.onRouteCalculated = options.onRouteCalculated || (() => {});
    this.onArrival = options.onArrival || (() => {});
    this.onManeuverUpdate = options.onManeuverUpdate || (() => {});
    this.onUserPan = options.onUserPan || (() => {});
    this.onProgressUpdate = options.onProgressUpdate || (() => {});
    this.onCameraAlert = options.onCameraAlert || (() => {});
    
    this.map = null;
    this.carMarker = null;
    this.destMarker = null;
    this.trafficLightMarkers = [];
    this.cameraMarkers = [];
    this.routePolyline = null;
    this.followCar = true;
    this.isHeadingUp = true; // True = map turns with car, False = North-up
    const saved3D = typeof localStorage !== 'undefined' ? localStorage.getItem('tesla_map_3d_mode') : null;
    this.is3D = saved3D !== null ? saved3D === '3d' : false; // Default to authentic MapsEV 2D flat view
    this.voiceEnabled = true;
    this.hasRealFix = false;

    this.currentPosition = { lat: this.center.lat, lng: this.center.lng, heading: 0, speed: 0 };
    this.currentHeading = 0;
    this.currentSegIndex = 0;
    this.isUserPinching = false;
    this.lastRawPosition = null;
    this.routeCoordinates = [];
    this.offRouteCounter = 0;
    this.autoFollowTimer = null;
    this.isRerouting = false;
    this.activeRoute = null;
    this.isNavigating = false;
    this.routeSteps = [];
    this.laneIntersections = [];
    this.currentStepIndex = 0;
    this.totalDistance = 0;
    this.spokenDistanceThresholds = {};

    // Key Speed Cameras in Yerevan (Alert only, no ugly blocking sprites on map)
    this.trafficPoints = [
      { type: 'camera', lat: 40.1915, lng: 44.4735, name: 'Speed Cam 60', limit: 60 },
      { type: 'camera', lat: 40.1955, lng: 44.4880, name: 'Speed Cam 60', limit: 60 },
      { type: 'camera', lat: 40.1830, lng: 44.4780, name: 'Monte Melkonyan Cam', limit: 60 }
    ];

    // Load full verified speed camera database for Yerevan (185 real speed cameras)
    this.loadRealSpeedCameras();
  }

  async init() {
    console.log(`[MapEngine] Initializing provider: ${this.provider}`);
    const container = document.getElementById(this.containerId);
    container.innerHTML = '';

    if (this.provider === 'maplibre' && window.maplibregl) {
      await this.initMapLibre();
    } else if (this.provider === 'yandex' && window.ymaps) {
      await this.initYandex();
    } else {
      await this.initLeaflet();
    }
    this.startMotionExtrapolator();
  }

  // Get interpolated coordinate and smooth lookahead bearing at distance along route polyline
  getPositionAtDistance(distMeters, lookaheadMeters = 24) {
    if (!this.routeCoordinates || this.routeCoordinates.length < 2 || !this.routeCumulativeDistances) return null;
    const totalDist = this.totalRouteMeters || this.routeCumulativeDistances[this.routeCumulativeDistances.length - 1] || 1000;
    const clampedDist = Math.max(0, Math.min(totalDist, distMeters));

    let segIdx = 0;
    for (let i = 0; i < this.routeCumulativeDistances.length - 1; i++) {
      if (clampedDist >= this.routeCumulativeDistances[i] && clampedDist <= this.routeCumulativeDistances[i + 1]) {
        segIdx = i;
        break;
      }
    }

    const segStartDist = this.routeCumulativeDistances[segIdx] || 0;
    const segEndDist = this.routeCumulativeDistances[segIdx + 1] || (segStartDist + 1);
    const segLen = Math.max(0.001, segEndDist - segStartDist);
    const t = Math.max(0, Math.min(1, (clampedDist - segStartDist) / segLen));

    const p1 = this.routeCoordinates[segIdx];
    const p2 = this.routeCoordinates[Math.min(this.routeCoordinates.length - 1, segIdx + 1)];

    const lng = p1[0] + (p2[0] - p1[0]) * t;
    const lat = p1[1] + (p2[1] - p1[1]) * t;

    // Lookahead point along polyline for smooth curve anticipation
    const aheadDist = Math.min(totalDist, clampedDist + lookaheadMeters);
    let aheadSegIdx = segIdx;
    for (let i = segIdx; i < this.routeCumulativeDistances.length - 1; i++) {
      if (aheadDist >= this.routeCumulativeDistances[i] && aheadDist <= this.routeCumulativeDistances[i + 1]) {
        aheadSegIdx = i;
        break;
      }
    }
    const aheadStart = this.routeCumulativeDistances[aheadSegIdx] || 0;
    const aheadEnd = this.routeCumulativeDistances[aheadSegIdx + 1] || (aheadStart + 1);
    const aheadT = Math.max(0, Math.min(1, (aheadDist - aheadStart) / Math.max(0.001, aheadEnd - aheadStart)));
    const ap1 = this.routeCoordinates[aheadSegIdx];
    const ap2 = this.routeCoordinates[Math.min(this.routeCoordinates.length - 1, aheadSegIdx + 1)];
    const aheadLng = ap1[0] + (ap2[0] - ap1[0]) * aheadT;
    const aheadLat = ap1[1] + (ap2[1] - ap1[1]) * aheadT;

    let heading = this.calculateBearing(p1[1], p1[0], p2[1], p2[0]);
    if (aheadDist > clampedDist + 0.5) {
      heading = this.calculateBearing(lat, lng, aheadLat, aheadLng);
    }

    return { lat, lng, heading };
  }

  // Start continuous 60fps dead-reckoning loop for real-time motion during live driving
  startMotionExtrapolator() {
    if (this.extrapolatorAnimId) return;
    let lastTime = performance.now();

    const loop = (now) => {
      const dt = Math.min(0.08, (now - lastTime) / 1000);
      lastTime = now;

      // Only extrapolate during live driving when simulator is NOT active, vehicle speed > 2 km/h, and followCar is true
      if (!window.IS_SIMULATOR_RUNNING && this.currentPosition && this.currentPosition.speed > 2 && this.followCar) {
        if (this.activeRoute && this.routeCoordinates && this.routeCoordinates.length > 1 && this.totalRouteMeters) {
          const speedMps = this.currentPosition.speed / 3.6;
          const distMeters = speedMps * dt;
          this.simulatedNavDistance = (this.simulatedNavDistance || 0) + distMeters;
          const pt = this.getPositionAtDistance(this.simulatedNavDistance);
          if (pt) {
            this.updateCarPosition(pt.lat, pt.lng, pt.heading, this.currentPosition.speed, false);
          }
        } else if (this.currentPosition) {
          const speedMps = this.currentPosition.speed / 3.6;
          const distMeters = speedMps * dt;
          const headingRad = (this.currentHeading * Math.PI) / 180;
          const dLat = (distMeters * Math.cos(headingRad)) / 111111;
          const dLng = (distMeters * Math.sin(headingRad)) / (111111 * Math.cos((this.currentPosition.lat * Math.PI) / 180));
          this.updateCarPosition(this.currentPosition.lat + dLat, this.currentPosition.lng + dLng, this.currentHeading, this.currentPosition.speed, false);
        }
      }

      this.extrapolatorAnimId = requestAnimationFrame(loop);
    };

    this.extrapolatorAnimId = requestAnimationFrame(loop);
  }

  // 1. MapLibre GL Clean Vector Map (Tuned with MapsEV Tesla MCU profile for 0 crashes & 60 FPS)
  async initMapLibre() {
    return new Promise((resolve) => {
      const isNightTime = this.isNightActive();
      const activeStyle = isNightTime ? (CONFIG.maplibreNightStyle || '/styles/mapsev-night.json') : (CONFIG.maplibreStyle || '/styles/mapsev-day.json');
      this.lastIsNight = isNightTime;

      this.map = new window.maplibregl.Map({
        container: this.containerId,
        style: activeStyle,
        center: [this.center.lng, this.center.lat],
        zoom: this.navZoom,
        minZoom: 3,
        maxZoom: 19.5,
        maxPitch: 60,
        pitch: this.is3D ? (CONFIG.navigationPitch || 45) : 0, // 2D flat or 3D Perspective Driving View (MapsEV)
        bearing: 0,
        attributionControl: false,
        // Authentic MapsEV Tesla MCU performance optimizations (Prevents memory leak & MCU crash)
        fadeDuration: 0,
        maxTileCacheZoomLevels: 1,
        antialias: false,
        renderWorldCopies: false,
        refreshExpiredTiles: false,
        validateStyle: false,
        crossSourceCollisions: false
      });

      // Tesla MCU WebGL Context Loss & Auto-Recovery
      try {
        const canvas = this.map.getCanvas();
        if (canvas) {
          canvas.addEventListener('webglcontextlost', (e) => {
            e.preventDefault();
            console.warn('[MapEngine] Tesla MCU WebGL context lost — paused rendering to prevent crash.');
          });
          canvas.addEventListener('webglcontextrestored', () => {
            console.log('[MapEngine] Tesla MCU WebGL context restored — rebuilding layers.');
            try { this.map.resize(); } catch (err) {}
          });
        }
      } catch (ctxErr) {}

      // Enable full touch gestures for Tesla touchscreen
      this.map.touchZoomRotate.enable();
      this.map.dragPan.enable();
      this.map.scrollZoom.enable();
      this.map.doubleClickZoom.enable();
      this.map.touchPitch.enable();

      // Persistent navigation padding so all zoom and camera operations anchor directly on the vehicle
      this.navPadding = { top: Math.round(window.innerHeight * 0.28), bottom: 0, left: 0, right: 0 };
      try {
        this.map.setPadding(this.navPadding);
      } catch (e) {}

      window.addEventListener('resize', () => {
        if (this.map && typeof this.map.setPadding === 'function') {
          this.navPadding = { top: Math.round(window.innerHeight * 0.28), bottom: 0, left: 0, right: 0 };
          this.map.setPadding(this.navPadding);
        }
      });

      // Detect manual user touch/drag ONLY from genuine user drag gestures (ignore programmatic easeTo/jumpTo)
      const handleUserPan = (e) => {
        if (!e || !e.originalEvent) return; // Programmatic camera animations must never disable car follow!
        this.followCar = false;
        const recenterBtn = document.getElementById('floating-recenter-btn');
        if (recenterBtn) recenterBtn.classList.remove('hidden');
        if (this.onUserPan) this.onUserPan();
        this.resetAutoFollowTimer();
      };
      this.map.on('dragstart', handleUserPan);
      this.map.on('zoomstart', (e) => {
        if (e && e.originalEvent) {
          const recenterBtn = document.getElementById('floating-recenter-btn');
          if (recenterBtn) recenterBtn.classList.remove('hidden');
        }
      });

      this.map.on('styleimagemissing', (e) => {
        const id = e.id;
        if (this.map && !this.map.hasImage(id)) {
          this.map.addImage(id, { width: 1, height: 1, data: new Uint8Array(4) });
        }
      });

      this.map.on('load', () => {
        // Apply 2D / 3D Building Styling (Clean 2D footprints & Delicate MapsEV 3D)
        this.update3DMode(this.is3D);
        this.updateThemeUI();

        // Periodic auto-theme transition checker (every 60s)
        if (!this._themeCheckInterval && typeof window !== 'undefined') {
          this._themeCheckInterval = setInterval(() => {
            if (this.getThemeMode() === 'auto') {
              const shouldBeNight = this.isNightActive();
              if (this.lastIsNight !== shouldBeNight) {
                console.log('[Theme] Auto transition triggered:', shouldBeNight ? 'night' : 'day');
                this.setTheme('auto');
              }
            }
          }, 60000);
        }

        // Render Traffic Lights and Speed Cameras
        this.renderTrafficPoints();

        // High-Visibility Golden 3D Navigation Arrow (Matching Mapsev & Yandex Navigator)
        const el = document.createElement('div');
        el.id = 'maplibre-car-marker';
        el.className = 'tesla-3d-car-marker';
        el.innerHTML = `
          <div class="tesla-car-pulse"></div>
          <div class="tesla-car-arrow" style="transform: rotate(0deg); transition: none;">
            <svg viewBox="0 0 54 54" width="52" height="52">
              <defs>
                <filter id="car-shadow" x="-30%" y="-30%" width="160%" height="160%">
                  <feDropShadow dx="0" dy="3" stdDeviation="3.5" flood-color="#000000" flood-opacity="0.45"/>
                </filter>
                <linearGradient id="arrow-facet-left" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#ff7675" />
                  <stop offset="50%" stop-color="#ee5253" />
                  <stop offset="100%" stop-color="#ea2027" />
                </linearGradient>
                <linearGradient id="arrow-facet-right" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#d63031" />
                  <stop offset="60%" stop-color="#b71540" />
                  <stop offset="100%" stop-color="#800e28" />
                </linearGradient>
              </defs>
              <g filter="url(#car-shadow)">
                <!-- Crisp white outer contour -->
                <polygon points="27,4 47,46 27,35 7,46" fill="#ffffff" stroke="#ffffff" stroke-width="2.5" stroke-linejoin="round"/>
                <!-- Left illuminated 3D facet (MapsEV Red/Coral) -->
                <polygon points="27,6 27,34 9,44" fill="url(#arrow-facet-left)"/>
                <!-- Right shaded 3D facet -->
                <polygon points="27,6 45,44 27,34" fill="url(#arrow-facet-right)"/>
                <!-- Central ridge highlight line -->
                <line x1="27" y1="6" x2="27" y2="34" stroke="#ffffff" stroke-width="1.2" stroke-opacity="0.9"/>
              </g>
            </svg>
          </div>
        `;

        this.carMarker = new window.maplibregl.Marker({
          element: el,
          anchor: 'center',
          rotationAlignment: 'viewport'
        })
          .setLngLat([this.currentPosition.lng, this.currentPosition.lat])
          .addTo(this.map);

        // Compass / heading change listeners
        this.map.on('rotate', () => {
          const bearing = this.map.getBearing();
          const compassNeedle = document.getElementById('compass-needle');
          if (compassNeedle) {
            compassNeedle.style.transform = `rotate(${-bearing}deg)`;
          }
        });

        resolve();
      });
    });
  }

  // Load full verified speed camera database for Yerevan (185 real speed cameras)
  async loadRealSpeedCameras() {
    try {
      const res = await fetch('/api/speed-cameras');
      if (res.ok) {
        const cams = await res.json();
        if (Array.isArray(cams) && cams.length > 0) {
          const lights = this.trafficPoints.filter(p => p.type === 'light');
          const realCamPoints = cams.map(c => ({
            type: 'camera',
            lat: c.lat,
            lng: c.lng,
            limit: c.limit || 60,
            direction: c.direction,
            name: c.name || `Камера ${c.limit || 60} км/ч`
          }));
          this.trafficPoints = [...lights, ...realCamPoints];
          if (this.map) {
            this.renderTrafficPoints();
          }
        }
      }
    } catch (e) {
      console.warn('[MapEngine] Could not load speed cameras:', e);
    }
  }

  // Render Traffic Lights (🚦) and Speed Cameras (📷) matching Yandex Navigator
  renderTrafficPoints() {
    if (!this.map) return;

    // Clear previous markers
    if (this.trafficLightMarkers) {
      this.trafficLightMarkers.forEach(m => {
        if (typeof m.remove === 'function') m.remove();
        else if (this.map.geoObjects && typeof this.map.geoObjects.remove === 'function') this.map.geoObjects.remove(m);
      });
      this.trafficLightMarkers = [];
    }
    if (this.cameraMarkers) {
      this.cameraMarkers.forEach(m => {
        if (typeof m.remove === 'function') m.remove();
        else if (this.map.geoObjects && typeof this.map.geoObjects.remove === 'function') this.map.geoObjects.remove(m);
      });
      this.cameraMarkers = [];
    }

    if (this.provider === 'maplibre' && window.maplibregl) {
      this.trafficPoints.forEach(point => {
        const el = document.createElement('div');
        if (point.type === 'light') {
          el.className = 'traffic-light-pill-icon';
          el.innerHTML = `
            <div class="tl-box">
              <span class="tl-dot red"></span>
              <span class="tl-dot yellow"></span>
              <span class="tl-dot green"></span>
            </div>
          `;
          const marker = new window.maplibregl.Marker({ element: el })
            .setLngLat([point.lng, point.lat])
            .addTo(this.map);
          this.trafficLightMarkers.push(marker);
        } else {
          el.className = 'map-speed-camera-pin';
          el.innerHTML = `
            <div class="camera-map-badge" title="Камера контроля скорости ${point.limit || 60} км/ч">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="#1e293b">
                <path d="M4 4h3l2-2h6l2 2h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm8 3a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/>
              </svg>
            </div>
          `;
          const marker = new window.maplibregl.Marker({ element: el, anchor: 'center' })
            .setLngLat([point.lng, point.lat])
            .addTo(this.map);
          this.cameraMarkers.push(marker);
        }
      });
    } else if (this.provider === 'yandex' && window.ymaps && this.map.geoObjects) {
      const CamLayout = window.ymaps.templateLayoutFactory.createClass(
        `<div class="map-speed-camera-pin" style="transform: translate(-50%, -50%);">
          <div class="camera-map-badge">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="#1e293b">
              <path d="M4 4h3l2-2h6l2 2h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm8 3a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/>
            </svg>
          </div>
        </div>`
      );

      this.trafficPoints.forEach(point => {
        if (point.type === 'camera') {
          const placemark = new window.ymaps.Placemark([point.lat, point.lng], {
            hintContent: `Камера контроля скорости ${point.limit || 60} км/ч`
          }, {
            iconLayout: CamLayout,
            iconImageSize: [28, 28],
            iconImageOffset: [0, 0]
          });
          this.map.geoObjects.add(placemark);
          this.cameraMarkers.push(placemark);
        }
      });
    }
  }

  // On-Road Lane Callout Marker (Disabled: prevents elongated blue lines on the map; lanes are cleanly in HUD)
  renderRoadLaneMarker(location, modifier) {
    this.clearRoadLaneMarker();
  }

  clearRoadLaneMarker() {
    if (this.roadLaneMarker) {
      this.roadLaneMarker.remove();
      this.roadLaneMarker = null;
      this.roadLaneMarkerEl = null;
    }
    if (this.yandexRoadLaneMarker && this.map && this.map.geoObjects) {
      this.map.geoObjects.remove(this.yandexRoadLaneMarker);
      this.yandexRoadLaneMarker = null;
    }
  }

  // 2. Yandex Maps 2.1 Fallback Implementation
  async initYandex() {
    return new Promise((resolve) => {
      window.ymaps.ready(() => {
        this.map = new window.ymaps.Map(this.containerId, {
          center: [this.center.lat, this.center.lng],
          zoom: this.navZoom,
          controls: [],
          type: 'yandex#map'
        }, {
          suppressMapOpenBlock: true,
          autoFitToViewport: 'always',
          yandexMapDisablePoiInteractivity: true,
          minZoom: 4,
          maxZoom: 21
        });

        try {
          this.map.options.set({
            minZoom: 4,
            maxZoom: 21
          });
        } catch (e) {}

        try {
          this.trafficLayer = new window.ymaps.control.TrafficControl({
            state: { providerKey: 'traffic#actual', trafficShown: true }
          });
          this.map.controls.add(this.trafficLayer);
          this.trafficLayer.showTraffic();
        } catch (e) {}

        try {
          this.map.behaviors.disable('multiTouch');
          this.map.behaviors.enable(['drag', 'scrollZoom', 'dblClickZoom']);
        } catch (e) {}

        const containerEl = document.getElementById(this.containerId);
        this.isUserPinching = false;
        this.isUserTouching = false;
        let touchStartPos = null;
        let pinchStartDist = null;
        let pinchStartZoom = null;
        let pinchTimeout = null;

        if (containerEl) {
          containerEl.addEventListener('touchstart', (e) => {
            this.isUserTouching = true;
            this.clearAutoFollowTimer();
            if (e.touches.length >= 2) {
              this.isUserPinching = true;
              if (pinchTimeout) clearTimeout(pinchTimeout);
              pinchStartDist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
              );
              pinchStartZoom = this.navZoom;
            } else if (e.touches.length === 1) {
              touchStartPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            }
          }, { passive: false });

          containerEl.addEventListener('touchmove', (e) => {
            if (e.touches.length >= 2 && pinchStartDist && pinchStartZoom != null) {
              if (e.cancelable) e.preventDefault();
              this.isUserPinching = true;
              const curDist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
              );
              if (curDist > 10 && pinchStartDist > 10) {
                const deltaZoom = Math.log2(curDist / pinchStartDist);
                const targetZoom = Math.min(21, Math.max(4, +(pinchStartZoom + deltaZoom).toFixed(2)));
                if (Math.abs(targetZoom - this.navZoom) >= 0.05) {
                  this.navZoom = targetZoom;
                  const recenterBtn = document.getElementById('floating-recenter-btn');
                  if (recenterBtn && Math.abs(this.navZoom - (CONFIG.navigationZoom || 16.5)) > 0.3) {
                    recenterBtn.classList.remove('hidden');
                  }
                  if (this.currentPosition && this.map) {
                    this.map.setCenter([this.currentPosition.lat, this.currentPosition.lng], targetZoom, { duration: 0, checkZoomRange: false });
                  }
                }
              }
            } else if (e.touches.length === 1 && touchStartPos && !this.isUserPinching) {
              const dx = e.touches[0].clientX - touchStartPos.x;
              const dy = e.touches[0].clientY - touchStartPos.y;
              if (Math.hypot(dx, dy) > 55) {
                // User intentionally dragged map with 1 finger to pan away
                this.followCar = false;
                const recenterBtn = document.getElementById('floating-recenter-btn');
                if (recenterBtn) recenterBtn.classList.remove('hidden');
                if (this.onUserPan) this.onUserPan();
                this.startAutoFollowTimer();
              }
            }
          }, { passive: false });

          containerEl.addEventListener('touchend', (e) => {
            this.isUserTouching = false;
            if (e.touches.length === 0) {
              touchStartPos = null;
              pinchStartDist = null;
              pinchStartZoom = null;
              if (this.isUserPinching) {
                pinchTimeout = setTimeout(() => {
                  this.isUserPinching = false;
                  // Re-lock center on vehicle immediately after pinch release
                  if (this.followCar && this.currentPosition && this.map) {
                    this.map.setCenter([this.currentPosition.lat, this.currentPosition.lng], this.navZoom, { duration: 0, checkZoomRange: false });
                  }
                }, 150);
              }
              if (!this.followCar) {
                this.startAutoFollowTimer();
              }
            } else if (e.touches.length === 1 && this.isUserPinching) {
              touchStartPos = null;
            }
          }, { passive: true });

          let mouseDownPos = null;
          containerEl.addEventListener('mousedown', (e) => {
            if (e.button === 0) {
              mouseDownPos = { x: e.clientX, y: e.clientY };
              this.clearAutoFollowTimer();
            }
          }, { passive: true });

          containerEl.addEventListener('mousemove', (e) => {
            if (mouseDownPos && e.buttons === 1) {
              const dx = e.clientX - mouseDownPos.x;
              const dy = e.clientY - mouseDownPos.y;
              if (Math.hypot(dx, dy) > 55) {
                this.followCar = false;
                const recenterBtn = document.getElementById('floating-recenter-btn');
                if (recenterBtn) recenterBtn.classList.remove('hidden');
                if (this.onUserPan) this.onUserPan();
                this.startAutoFollowTimer();
              }
            }
          }, { passive: true });

          window.addEventListener('mouseup', () => {
            mouseDownPos = null;
            if (!this.followCar) {
              this.startAutoFollowTimer();
            }
          }, { passive: true });
        }

        // Update navZoom when user zooms with pinch or scroll gestures
        this.map.events.add('boundschange', (e) => {
          const newZ = e.get('newZoom');
          if (newZ !== undefined && Math.abs(newZ - this.navZoom) > 0.05) {
            this.navZoom = newZ;
            const recenterBtn = document.getElementById('floating-recenter-btn');
            if (recenterBtn && Math.abs(this.navZoom - (CONFIG.navigationZoom || 16.5)) > 0.3) {
              recenterBtn.classList.remove('hidden');
            }
          }
        });

        const CarLayout = window.ymaps.templateLayoutFactory.createClass(
          `<div id="yandex-car-marker" class="tesla-3d-car-marker" style="transform: translate(-50%, -50%);">
            <div class="tesla-car-pulse"></div>
            <div class="tesla-car-arrow" style="transform: rotate(0deg); transition: none;">
              <svg viewBox="0 0 54 54" width="52" height="52">
                <defs>
                  <filter id="yandex-car-shadow" x="-30%" y="-30%" width="160%" height="160%">
                    <feDropShadow dx="0" dy="3" stdDeviation="3.5" flood-color="#000000" flood-opacity="0.55"/>
                  </filter>
                  <linearGradient id="yandex-facet-left" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#fffbeb" />
                    <stop offset="45%" stop-color="#fef08a" />
                    <stop offset="100%" stop-color="#facc15" />
                  </linearGradient>
                  <linearGradient id="yandex-facet-right" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#eab308" />
                    <stop offset="60%" stop-color="#ca8a04" />
                    <stop offset="100%" stop-color="#a16207" />
                  </linearGradient>
                </defs>
                <g filter="url(#yandex-car-shadow)">
                  <polygon points="27,4 47,46 27,35 7,46" fill="#ffffff" stroke="#ffffff" stroke-width="2.5" stroke-linejoin="round"/>
                  <polygon points="27,6 27,34 9,44" fill="url(#yandex-facet-left)"/>
                  <polygon points="27,6 45,44 27,34" fill="url(#yandex-facet-right)"/>
                  <line x1="27" y1="6" x2="27" y2="34" stroke="#ffffff" stroke-width="1.2" stroke-opacity="0.85"/>
                </g>
              </svg>
            </div>
          </div>`
        );

        this.carMarker = new window.ymaps.Placemark([this.center.lat, this.center.lng], {}, {
          iconLayout: CarLayout,
          iconImageSize: [52, 52],
          iconImageOffset: [0, 0]
        });

        this.map.geoObjects.add(this.carMarker);
        resolve();
      });
    });
  }

  // 3. Leaflet Fallback
  async initLeaflet() {
    return new Promise((resolve) => {
      if (!window.L) {
        resolve();
        return;
      }

      this.map = window.L.map(this.containerId, {
        center: [this.center.lat, this.center.lng],
        zoom: this.navZoom,
        zoomControl: false,
        attributionControl: false
      });

      window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19
      }).addTo(this.map);

      const carIcon = window.L.divIcon({
        className: 'tesla-car-marker-container',
        html: `
          <div id="leaflet-car-marker" class="tesla-3d-car-marker">
            <div class="tesla-car-pulse"></div>
            <div class="tesla-car-arrow" style="transform: rotate(0deg);">
              <svg viewBox="0 0 54 54" width="52" height="52">
                <g>
                  <polygon points="27,4 47,46 27,35 7,46" fill="#ffffff" stroke="#ffffff" stroke-width="2.5" stroke-linejoin="round"/>
                  <polygon points="27,6 27,34 9,44" fill="#facc15"/>
                  <polygon points="27,6 45,44 27,34" fill="#ca8a04"/>
                  <line x1="27" y1="6" x2="27" y2="34" stroke="#ffffff" stroke-width="1.2" stroke-opacity="0.85"/>
                </g>
              </svg>
            </div>
          </div>`,
        iconSize: [52, 52],
        iconAnchor: [26, 26]
      });

      this.carMarker = window.L.marker([this.center.lat, this.center.lng], { icon: carIcon }).addTo(this.map);
      resolve();
    });
  }

  // Recenter map back onto vehicle & reset zoom to default
  recenter() {
    this.followCar = true;
    this.isUserPinching = false;
    this.navZoom = CONFIG.navigationZoom || 16.5;
    if (this.autoFollowTimer) {
      clearTimeout(this.autoFollowTimer);
      this.autoFollowTimer = null;
    }
    const recenterBtn = document.getElementById('floating-recenter-btn');
    if (recenterBtn) recenterBtn.classList.add('hidden');

    const targetHeading = this.currentHeading || (this.currentPosition && this.currentPosition.heading) || 0;
    const pad = this.isHeadingUp
      ? { top: Math.round(window.innerHeight * 0.28), bottom: 0, left: 0, right: 0 }
      : { top: 0, bottom: 0, left: 0, right: 0 };

    if (this.provider === 'maplibre' && this.map) {
      const markerEl = document.querySelector('#maplibre-car-marker .tesla-car-arrow');
      if (this.isHeadingUp && markerEl) {
        markerEl.style.transform = 'rotate(0deg)';
      }
      this.map.jumpTo({
        center: [this.currentPosition.lng, this.currentPosition.lat],
        zoom: this.navZoom,
        bearing: this.isHeadingUp ? targetHeading : 0,
        pitch: (this.is3D && this.isHeadingUp) ? (CONFIG.navigationPitch || 45) : 0,
        padding: pad
      });
    } else if (this.provider === 'yandex' && this.map) {
      this.map.setCenter([this.currentPosition.lat, this.currentPosition.lng], this.navZoom, { duration: 0 });
    } else if (this.map) {
      this.map.panTo([this.currentPosition.lat, this.currentPosition.lng]);
    }
  }

  // Auto-follow recovery timer: automatically restores car follow after 6s of user inactivity
  startAutoFollowTimer() {
    this.clearAutoFollowTimer();
    this.autoFollowTimer = setTimeout(() => {
      this.recenter();
    }, 6000);
  }

  clearAutoFollowTimer() {
    if (this.autoFollowTimer) {
      clearTimeout(this.autoFollowTimer);
      this.autoFollowTimer = null;
    }
  }

  resetAutoFollowTimer() {
    this.clearAutoFollowTimer();
  }

  // Zoom In map (anchored strictly on vehicle position with perspective padding)
  zoomIn() {
    const recenterBtn = document.getElementById('floating-recenter-btn');
    if (recenterBtn) recenterBtn.classList.remove('hidden');

    this.navZoom = Math.min(19, Math.round(this.navZoom + 0.1) + 1);

    if (this.provider === 'maplibre' && this.map) {
      const pad = this.isHeadingUp
        ? { top: Math.round(window.innerHeight * 0.28), bottom: 0, left: 0, right: 0 }
        : { top: 0, bottom: 0, left: 0, right: 0 };
      if (this.currentPosition) {
        this.map.jumpTo({
          center: [this.currentPosition.lng, this.currentPosition.lat],
          zoom: this.navZoom,
          bearing: this.isHeadingUp ? this.currentHeading : 0,
          pitch: (this.is3D && this.isHeadingUp) ? (CONFIG.navigationPitch || 45) : 0,
          padding: pad
        });
      } else {
        this.map.setZoom(this.navZoom);
      }
    } else if (this.provider === 'yandex' && this.map) {
      this.navZoom = Math.min(18, Math.round(this.navZoom + 0.1) + 1);
      if (this.currentPosition) {
        this.map.setCenter([this.currentPosition.lat, this.currentPosition.lng], this.navZoom, { duration: 0 });
      } else {
        this.map.setZoom(this.navZoom, { duration: 0 });
      }
    } else if (this.map && typeof this.map.zoomIn === 'function') {
      this.map.zoomIn();
    }
  }

  // Zoom Out map (anchored strictly on vehicle position with perspective padding)
  zoomOut() {
    const recenterBtn = document.getElementById('floating-recenter-btn');
    if (recenterBtn) recenterBtn.classList.remove('hidden');

    this.navZoom = Math.max(3, Math.round(this.navZoom - 0.1) - 1);

    if (this.provider === 'maplibre' && this.map) {
      const pad = this.isHeadingUp
        ? { top: Math.round(window.innerHeight * 0.28), bottom: 0, left: 0, right: 0 }
        : { top: 0, bottom: 0, left: 0, right: 0 };
      if (this.currentPosition) {
        this.map.jumpTo({
          center: [this.currentPosition.lng, this.currentPosition.lat],
          zoom: this.navZoom,
          bearing: this.isHeadingUp ? this.currentHeading : 0,
          pitch: (this.is3D && this.isHeadingUp) ? (CONFIG.navigationPitch || 45) : 0,
          padding: pad
        });
      } else {
        this.map.setZoom(this.navZoom);
      }
    } else if (this.provider === 'yandex' && this.map) {
      this.navZoom = Math.max(4, Math.round(this.navZoom - 0.1) - 1);
      if (this.currentPosition) {
        this.map.setCenter([this.currentPosition.lat, this.currentPosition.lng], this.navZoom, { duration: 0 });
      } else {
        this.map.setZoom(this.navZoom, { duration: 0 });
      }
    } else if (this.map && typeof this.map.zoomOut === 'function') {
      this.map.zoomOut();
    }
  }

  // Smart Maneuver & Route Distance Quantization
  formatNavDistance(meters) {
    if (meters == null || isNaN(meters)) return '0 м';
    const m = Math.max(0, meters);
    if (m < 20) {
      return `${Math.round(m)} м`;
    }
    if (m < 100) {
      return `${Math.round(m / 5) * 5} м`;
    }
    if (m < 300) {
      return `${Math.round(m / 10) * 10} м`;
    }
    if (m < 800) {
      return `${Math.round(m / 50) * 50} м`;
    }
    if (m < 1500) {
      if (m < 1000) {
        return `${Math.round(m / 100) * 100} м`;
      } else {
        return `${(Math.round(m / 100) / 10).toFixed(1)} км`;
      }
    }
    if (m < 10000) {
      return `${(Math.round(m / 100) / 10).toFixed(1)} км`;
    }
    return `${Math.round(m / 1000)} км`;
  }

  // Toggle Heading-Up Driving View vs North-Up Overview
  toggleHeadingUp() {
    this.isHeadingUp = !this.isHeadingUp;
    const targetHeading = this.currentHeading || 0;
    if (this.provider === 'maplibre' && this.map) {
      const markerEl = document.querySelector('#maplibre-car-marker .tesla-car-arrow');
      if (this.isHeadingUp) {
        if (markerEl) markerEl.style.transform = 'rotate(0deg)';
        this.map.easeTo({
          center: [this.currentPosition.lng, this.currentPosition.lat],
          bearing: targetHeading,
          pitch: (this.is3D && this.isHeadingUp) ? (CONFIG.navigationPitch || 45) : 0,
          padding: { top: 220, bottom: 0, left: 0, right: 0 },
          duration: 500
        });
      } else {
        if (markerEl) markerEl.style.transform = `rotate(${Math.round(this.currentHeading)}deg)`;
        this.map.easeTo({
          center: [this.currentPosition.lng, this.currentPosition.lat],
          bearing: 0,
          pitch: 0,
          padding: { top: 0, bottom: 0, left: 0, right: 0 },
          duration: 500
        });
      }
    } else if (this.provider === 'yandex') {
      const markerEl = document.querySelector('#yandex-car-marker .tesla-car-arrow');
      if (markerEl) markerEl.style.transform = `rotate(${this.currentHeading.toFixed(1)}deg)`;
    }
    return this.isHeadingUp;
  }

  // Update 2D / 3D Mode, building aesthetics, and camera pitch
  update3DMode(is3D) {
    this.is3D = !!is3D;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('tesla_map_3d_mode', this.is3D ? '3d' : '2d');
      }
    } catch (e) {}

    // Update floating toggle button state
    const btn = document.getElementById('btn-toggle-2d3d');
    const label = document.getElementById('btn-3d-mode-label');
    if (btn) {
      btn.classList.toggle('is-3d', this.is3D);
      btn.title = this.is3D ? 'Переключить в 2D плоский вид' : 'Переключить в 3D перспективный вид (MapsEV)';
    }
    if (label) {
      label.textContent = this.is3D ? '3D' : '2D';
    }

    if (this.provider === 'maplibre' && this.map) {
      try {
        if (!this.map.isStyleLoaded()) {
          this.map.once('load', () => this.update3DMode(this.is3D));
          return;
        }

        // 1. Control 2D and 3D layer visibility
        if (this.map.getLayer('3d-building')) {
          this.map.setLayoutProperty('3d-building', 'visibility', this.is3D ? 'visible' : 'none');
        }
        if (this.map.getLayer('building')) {
          this.map.setLayoutProperty('building', 'visibility', this.is3D ? 'none' : 'visible');
        }
        if (this.map.getLayer('building-3d')) {
          this.map.setLayoutProperty('building-3d', 'visibility', this.is3D ? 'visible' : 'none');
        }
        if (this.map.getLayer('building-ao-ground')) {
          this.map.setLayoutProperty('building-ao-ground', 'visibility', this.is3D ? 'visible' : 'none');
        }

        // 2. Smooth camera pitch transition (0 for 2D, 35 for MapsEV 3D Perspective Driving View)
        const targetPitch = this.is3D ? (CONFIG.navigationPitch || 35) : 0;
        this.map.easeTo({
          pitch: targetPitch,
          duration: 350
        });
      } catch (err) {
        console.warn('update3DMode styling error:', err);
      }
    }
  }

  // Toggle 2D / 3D mode
  toggle2D3D() {
    if (this.provider === 'yandex') {
      try {
        localStorage.setItem('tesla_map_3d_mode', '3d');
        localStorage.setItem('tesla_map_provider_v2', 'maplibre');
      } catch (e) {}
      const url = new URL(window.location.href);
      url.searchParams.set('provider', 'maplibre');
      window.location.href = url.toString();
      return true;
    }
    this.update3DMode(!this.is3D);
    return this.is3D;
  }

  // --- Theme Mode Management: auto / night / day (MapsEV Architecture) ---
  getThemeMode() {
    if (typeof window !== 'undefined') {
      const urlTheme = new URLSearchParams(window.location.search).get('theme');
      if (urlTheme) {
        const t = urlTheme.toLowerCase();
        if (t === 'night' || t === 'dark' || t === 'on') return 'night';
        if (t === 'day' || t === 'light' || t === 'off') return 'day';
        if (t === 'auto') return 'auto';
      }
      const saved = localStorage.getItem('tesla_map_theme');
      if (saved && ['auto', 'night', 'day'].includes(saved)) {
        return saved;
      }
    }
    return 'auto';
  }

  isNightActive() {
    const mode = this.getThemeMode();
    if (mode === 'night') return true;
    if (mode === 'day') return false;
    // Auto: 19:00 - 07:00 is night
    const hour = new Date().getHours();
    return hour >= 19 || hour < 7;
  }

  setTheme(mode) {
    const validModes = ['auto', 'night', 'day'];
    if (!validModes.includes(mode)) mode = 'auto';

    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('tesla_map_theme', mode);
      }
    } catch (e) {}

    const isNight = this.isNightActive();
    this.lastIsNight = isNight;
    const targetStyle = isNight
      ? (CONFIG.maplibreNightStyle || '/styles/mapsev-night.json')
      : (CONFIG.maplibreStyle || '/styles/mapsev-day.json');

    if (this.provider === 'maplibre' && this.map) {
      try {
        this.map.setStyle(targetStyle);
        this.map.once('style.load', () => {
          this.update3DMode(this.is3D);
          if (this.activeRoute) {
            this.drawRoute(this.activeRoute);
          }
        });
      } catch (err) {
        console.warn('[Theme] Error switching style:', err);
      }
    }

    this.updateThemeUI();
    return mode;
  }

  cycleTheme() {
    const cur = this.getThemeMode();
    let next = 'auto';
    if (cur === 'auto') next = 'night';
    else if (cur === 'night') next = 'day';
    else if (cur === 'day') next = 'auto';
    return this.setTheme(next);
  }

  updateThemeUI() {
    const mode = this.getThemeMode();
    const isNight = this.isNightActive();

    // 1. Right floating button
    const btnLabel = document.getElementById('btn-theme-mode-label');
    const iconSymbol = document.getElementById('theme-icon-symbol');
    const btn = document.getElementById('btn-toggle-theme');

    if (btnLabel && iconSymbol && btn) {
      if (mode === 'auto') {
        btnLabel.textContent = 'АВТО';
        iconSymbol.textContent = isNight ? '🌓' : '⛅';
        btn.title = `Тема: Авто (сейчас ${isNight ? 'Ночь' : 'День'}). Нажмите для переключения`;
      } else if (mode === 'night') {
        btnLabel.textContent = 'НОЧЬ';
        iconSymbol.textContent = '🌙';
        btn.title = 'Тема: Ночь (Всегда темная). Нажмите для переключения';
      } else {
        btnLabel.textContent = 'ДЕНЬ';
        iconSymbol.textContent = '☀️';
        btn.title = 'Тема: День (Всегда светлая). Нажмите для переключения';
      }
    }

    // 2. More tools menu card
    const menuIcon = document.getElementById('menu-theme-icon');
    const menuLabel = document.getElementById('menu-theme-label');
    if (menuLabel && menuIcon) {
      if (mode === 'auto') {
        menuIcon.textContent = isNight ? '🌓' : '⛅';
        menuLabel.textContent = `Тема: Авто (${isNight ? 'Ночь' : 'День'})`;
      } else if (mode === 'night') {
        menuIcon.textContent = '🌙';
        menuLabel.textContent = 'Тема: Ночь (Вкл)';
      } else {
        menuIcon.textContent = '☀️';
        menuLabel.textContent = 'Тема: День (Выкл)';
      }
    }
  }

  // Toggle Voice Sound On/Off
  toggleVoice() {
    this.voiceEnabled = !this.voiceEnabled;
    if (!this.voiceEnabled && this.currentAudioVoice) {
      try { this.currentAudioVoice.pause(); } catch (e) {}
      this.currentAudioVoice = null;
    }
    return this.voiceEnabled;
  }

  // Calculate Forward Azimuth Bearing between 2 GPS coordinates
  calculateBearing(lat1, lon1, lat2, lon2) {
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const lat1Rad = (lat1 * Math.PI) / 180;
    const lat2Rad = (lat2 * Math.PI) / 180;
    const y = Math.sin(dLon) * Math.cos(lat2Rad);
    const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);
    let brng = (Math.atan2(y, x) * 180) / Math.PI;
    return (brng + 360) % 360;
  }

  // Smooth Angle Interpolation (handles 359° -> 1° wrap-around shortest path)
  smoothAngle(current, target, factor = 0.35) {
    let diff = ((target - current) % 360 + 540) % 360 - 180;
    return (current + diff * factor + 360) % 360;
  }

  // Orthogonal projection of point onto segment
  projectPointToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    if (dx === 0 && dy === 0) {
      return { x: x1, y: y1, t: 0 };
    }
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
    return { x: x1 + t * dx, y: y1 + t * dy, t };
  }

  // Snap GPS Coordinate to Active Route Polyline (Map Matching with Heading Gating)
  snapToActiveRoute(lat, lng, rawHeading = null, speed = 0) {
    if (!this.activeRoute || !this.routeCoordinates || this.routeCoordinates.length < 2 || this.isRerouting) {
      return { snapped: false, lat, lng, bearing: null, dist: 0, headingDiff: 0 };
    }

    let minDistance = Infinity;
    let bestPoint = { lat, lng };
    let bestBearing = null;
    let bestSegIndex = 0;
    let bestHeadingDiff = 0;

    const totalSegs = this.routeCoordinates.length - 1;
    let searchStart = 0;
    let searchEnd = totalSegs;

    // Fast localized search window around last progress point (O(1))
    if (this.lastProgressIndex != null && this.lastProgressIndex > 0) {
      searchStart = Math.max(0, this.lastProgressIndex - 5);
      searchEnd = Math.min(totalSegs, this.lastProgressIndex + 40);
    }

    for (let i = searchStart; i < searchEnd; i++) {
      const p1 = this.routeCoordinates[i];     // [lng, lat]
      const p2 = this.routeCoordinates[i + 1]; // [lng, lat]

      const proj = this.projectPointToSegment(lng, lat, p1[0], p1[1], p2[0], p2[1]);
      const dist = this.calculateDistance(lat, lng, proj.y, proj.x);

      if (dist < minDistance) {
        minDistance = dist;
        bestPoint = { lat: proj.y, lng: proj.x };
        bestBearing = this.calculateBearing(p1[1], p1[0], p2[1], p2[0]);
        bestSegIndex = i;
      }
    }

    // Fallback to full search if not within localized window
    if (minDistance > 35 && searchStart > 0) {
      for (let i = 0; i < totalSegs; i++) {
        const p1 = this.routeCoordinates[i];
        const p2 = this.routeCoordinates[i + 1];
        const proj = this.projectPointToSegment(lng, lat, p1[0], p1[1], p2[0], p2[1]);
        const dist = this.calculateDistance(lat, lng, proj.y, proj.x);
        if (dist < minDistance) {
          minDistance = dist;
          bestPoint = { lat: proj.y, lng: proj.x };
          bestBearing = this.calculateBearing(p1[1], p1[0], p2[1], p2[0]);
          bestSegIndex = i;
        }
      }
    }

    // Calculate heading difference between vehicle movement and road segment tangent
    if (rawHeading != null && !isNaN(rawHeading) && bestBearing != null) {
      let diff = Math.abs((rawHeading - bestBearing + 360) % 360);
      if (diff > 180) diff = 360 - diff;
      bestHeadingDiff = diff;
    }

    // Intelligent Road Snap Criteria:
    // 1. If car is driving (speed >= 8 km/h): only snap if within 20m AND heading aligns with road (diff <= 45°)
    //    If heading differs > 45° (car turned onto a cross street), DO NOT SNAP!
    // 2. If crawling/stopping (speed < 8 km/h): snap if within 16m
    const isMoving = speed >= 8 && rawHeading != null && !isNaN(rawHeading);
    const allowSnap = isMoving
      ? (minDistance <= 20 && bestHeadingDiff <= 45)
      : (minDistance <= 16);

    if (allowSnap) {
      let roadBearing = bestBearing;
      let snappedDist = null;
      if (this.routeCumulativeDistances && this.routeCumulativeDistances.length > bestSegIndex) {
        const segDist = this.routeCumulativeDistances[bestSegIndex] || 0;
        const segLen = Math.max(0.1, (this.routeCumulativeDistances[bestSegIndex + 1] || (segDist + 1)) - segDist);
        const p1 = this.routeCoordinates[bestSegIndex];
        const p2 = this.routeCoordinates[bestSegIndex + 1];
        if (p1 && p2) {
          const projT = this.projectPointToSegment(lng, lat, p1[0], p1[1], p2[0], p2[1]).t;
          snappedDist = segDist + (projT * segLen);
          const aheadPt = this.getPositionAtDistance(snappedDist + 22);
          if (aheadPt) {
            roadBearing = this.calculateBearing(bestPoint.lat, bestPoint.lng, aheadPt.lat, aheadPt.lng);
          }
        }
      }
      return {
        snapped: true,
        lat: bestPoint.lat,
        lng: bestPoint.lng,
        bearing: roadBearing,
        dist: minDistance,
        segIndex: bestSegIndex,
        routeDistance: snappedDist,
        headingDiff: bestHeadingDiff
      };
    }

    return {
      snapped: false,
      lat,
      lng,
      bearing: null,
      dist: minDistance,
      segIndex: bestSegIndex,
      routeDistance: null,
      headingDiff: bestHeadingDiff
    };
  }

  // Primary Position Update Handler with Movement Bearing & Road Snapping
  updateCarPosition(lat, lng, rawHeading = 0, speed = 0, isRealFix = true) {
    // 0. Instant Snap on First Real GPS Fix (Bypass smoothing from arbitrary initial center)
    if (!this.hasRealFix && isRealFix) {
      this.hasRealFix = true;
      this.currentHeading = (rawHeading && !isNaN(rawHeading) && rawHeading > 0) ? rawHeading : this.currentHeading;
      this.currentPosition = { lat, lng, heading: this.currentHeading, speed };
      this.lastRawPosition = { lat, lng, time: Date.now() };

      if (this.carMarker) {
        if (this.provider === 'maplibre') {
          this.carMarker.setLngLat([lng, lat]);
        } else if (this.provider === 'yandex') {
          this.carMarker.geometry.setCoordinates([lat, lng]);
        }
      }

      if (this.map) {
        if (this.provider === 'maplibre') {
          this.map.jumpTo({
            center: [lng, lat],
            zoom: this.navZoom,
            bearing: this.isHeadingUp ? this.currentHeading : 0,
            pitch: (this.is3D && this.isHeadingUp) ? (CONFIG.navigationPitch || 45) : 0
          });
        } else if (this.provider === 'yandex') {
          this.map.setCenter([lat, lng], this.navZoom, { duration: 0 });
        }
      }
      return;
    }

    let targetHeading = this.currentHeading;
    const isStationary = speed < 2.5 && !window.IS_SIMULATOR_RUNNING;

    // 1. Calculate Real Movement Bearing from GPS updates
    if (window.IS_SIMULATOR_RUNNING && rawHeading != null && !isNaN(rawHeading)) {
      targetHeading = rawHeading;
    } else if (isStationary) {
      targetHeading = this.currentHeading; // Completely freeze heading when stationary to prevent twitching
    } else if (isRealFix && this.lastRawPosition) {
      const distMoved = this.calculateDistance(this.lastRawPosition.lat, this.lastRawPosition.lng, lat, lng);
      // Require at least 6m baseline to compute stable bearing without lateral jitter
      if (distMoved >= 6.0) {
        targetHeading = this.calculateBearing(this.lastRawPosition.lat, this.lastRawPosition.lng, lat, lng);
        this.lastRawPosition = { lat, lng, time: Date.now() };
      }
    } else if (rawHeading != null && !isNaN(rawHeading) && rawHeading > 0 && speed > 2.5) {
      targetHeading = rawHeading;
    } else if (isRealFix) {
      this.lastRawPosition = { lat, lng, time: Date.now() };
    }

    // 2. Road Snapping (Map Matching with Heading Gating)
    let displayLat = lat;
    let displayLng = lng;
    let isOffRoute = false;
    let distToRoute = 0;

    if (this.activeRoute && this.routeCoordinates && this.routeCoordinates.length >= 2 && !this.isRerouting) {
      const snap = this.snapToActiveRoute(lat, lng, targetHeading, speed);
      distToRoute = snap.dist;
      if (snap.segIndex != null) {
        this.currentSegIndex = snap.segIndex;
      }
      if (snap.snapped) {
        displayLat = snap.lat;
        displayLng = snap.lng;
        // Strictly lock vehicle arrow to the road polyline tangent while driving along route
        if (snap.bearing !== null && !isStationary) {
          targetHeading = snap.bearing;
        }
        if (isRealFix) {
          this.simulatedNavDistance = (snap.routeDistance != null) ? snap.routeDistance : (this.routeCumulativeDistances?.[snap.segIndex] || 0);
        }
      } else {
        // Driver has departed from the route polyline:
        // Distance exceeds corridor (> 20m), OR turned off (> 12m with heading deviation > 45°)
        if (distToRoute > 20 || (distToRoute > 12 && snap.headingDiff > 45)) {
          isOffRoute = true;
        }
      }
    } else if (this.isRerouting) {
      isOffRoute = true;
    }

    // Anti-Jitter Deadband & Smoothing (Prevents nervous sub-pixel shaking)
    if (this.currentPosition) {
      const shiftDist = this.calculateDistance(this.currentPosition.lat, this.currentPosition.lng, displayLat, displayLng);
      if (shiftDist > 60.0 && isRealFix) {
        // Jump directly when position shift exceeds 60m (signal restoration / tunnel exit)
        displayLat = lat;
        displayLng = lng;
      } else if (isStationary && shiftDist < 3.5) {
        // Stop micro-wandering when car is stationary at light/parking
        displayLat = this.currentPosition.lat;
        displayLng = this.currentPosition.lng;
      } else if (shiftDist < 1.4 && !this.activeRoute && !window.IS_SIMULATOR_RUNNING) {
        // Ignore lateral micro-noise during driving
        displayLat = this.currentPosition.lat;
        displayLng = this.currentPosition.lng;
      } else if (!this.activeRoute || isOffRoute || this.isRerouting) {
        // Free driving / Off-route: smooth 35% EMA filter to eliminate lateral zig-zag while accurately tracking the car
        displayLat = this.currentPosition.lat + (displayLat - this.currentPosition.lat) * 0.35;
        displayLng = this.currentPosition.lng + (displayLng - this.currentPosition.lng) * 0.35;
      }
    }

    // 3. Smooth Heading with Deadband (Zero wobble within 3.2 degrees)
    if (!isStationary) {
      const angleDiff = ((targetHeading - this.currentHeading) % 360 + 540) % 360 - 180;
      if (Math.abs(angleDiff) >= 3.2) {
        const factor = window.IS_SIMULATOR_RUNNING ? 0.35 : 0.25;
        this.currentHeading = (this.currentHeading + angleDiff * factor + 360) % 360;
      }
    }

    this.currentPosition = {
      lat: displayLat,
      lng: displayLng,
      heading: this.currentHeading,
      speed
    };

    // 4. Update Marker and Camera on MapLibre GL
    if (this.provider === 'maplibre' && this.map) {
      if (this.carMarker) {
        this.carMarker.setLngLat([displayLng, displayLat]);
      }

      const markerEl = document.querySelector('#maplibre-car-marker .tesla-car-arrow');

      if (this.isHeadingUp) {
        // Heading-Up: Arrow points ALWAYS STRAIGHT UP (0°), map rotates with car
        if (markerEl) markerEl.style.transform = 'rotate(0deg)';
        if (this.carMarker && typeof this.carMarker.setRotation === 'function') {
          this.carMarker.setRotation(0);
        }

        if (this.followCar) {
          const navPadding = { top: Math.round(window.innerHeight * 0.28), bottom: 0, left: 0, right: 0 };
          this.map.jumpTo({
            center: [displayLng, displayLat],
            zoom: this.navZoom,
            bearing: this.currentHeading,
            pitch: (this.is3D && this.isHeadingUp) ? (CONFIG.navigationPitch || 45) : 0,
            padding: navPadding
          });
        }
      } else {
        // North-Up: Map fixed to North (bearing 0), arrow rotates to vehicle heading
        if (markerEl) markerEl.style.transform = `rotate(${Math.round(this.currentHeading)}deg)`;
        if (this.carMarker && typeof this.carMarker.setRotation === 'function') {
          this.carMarker.setRotation(this.currentHeading);
        }

        if (this.followCar) {
          this.map.jumpTo({
            center: [displayLng, displayLat],
            zoom: this.navZoom,
            bearing: 0,
            pitch: 0,
            padding: { top: 0, bottom: 0, left: 0, right: 0 }
          });
        }
      }
    } else if (this.provider === 'yandex' && this.carMarker && this.map) {
      this.carMarker.geometry.setCoordinates([displayLat, displayLng]);
      const markerEl = document.querySelector('#yandex-car-marker .tesla-car-arrow');
      if (markerEl) markerEl.style.transform = `rotate(${this.currentHeading.toFixed(1)}deg)`;

      // Auto-recover followCar when vehicle is moving and user isn't interacting
      if (!this.followCar && speed > 4 && !this.isUserTouching && !this.isUserPinching) {
        this.movingWithoutTouchFrames = (this.movingWithoutTouchFrames || 0) + 1;
        if (this.movingWithoutTouchFrames > 15) { // ~1.5 - 2s of driving
          this.followCar = true;
          this.movingWithoutTouchFrames = 0;
          const recenterBtn = document.getElementById('floating-recenter-btn');
          if (recenterBtn) recenterBtn.classList.add('hidden');
        }
      } else {
        this.movingWithoutTouchFrames = 0;
      }

      if (this.followCar && !this.isUserPinching) {
        if (!this._isYandexCentering) {
          this._isYandexCentering = true;
          // Pan map without passing fixed zoom on every frame to avoid heavy tile re-layouts
          const centerPromise = this.map.setCenter([displayLat, displayLng], undefined, { duration: 0, checkZoomRange: false });
          if (centerPromise) {
            if (typeof centerPromise.always === 'function') {
              centerPromise.always(() => { this._isYandexCentering = false; });
            } else if (typeof centerPromise.then === 'function') {
              centerPromise.then(() => { this._isYandexCentering = false; }, () => { this._isYandexCentering = false; });
            }
          }
          // Guaranteed failsafe release timeout
          setTimeout(() => { this._isYandexCentering = false; }, 200);
        }
      }
    } else if (this.carMarker && window.L && this.provider === 'osm') {
      this.carMarker.setLatLng([displayLat, displayLng]);
      const markerEl = document.querySelector('#leaflet-car-marker .tesla-car-arrow');
      if (markerEl) markerEl.style.transform = `rotate(${Math.round(this.currentHeading)}deg)`;
      if (this.followCar && this.map) this.map.setView([displayLat, displayLng], this.map.getZoom(), { animate: false });
    }

    // 5. Track Progress & Check Off-Route Rerouting / Free Driving Camera Alerts
    if (this.activeRoute && this.routeSteps.length > 0) {
      this.trackNavigationProgress(displayLat, displayLng, isOffRoute, distToRoute, speed, isRealFix);
    } else {
      this.checkFreeDrivingCameraAlert(displayLat, displayLng, speed);
    }
  }

  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const dPhi = ((lat2 - lat1) * Math.PI) / 180;
    const dLambda = ((lon2 - lon1) * Math.PI) / 180;

    const a = Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
              Math.cos(phi1) * Math.cos(phi2) *
              Math.sin(dLambda / 2) * Math.sin(dLambda / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  trackNavigationProgress(currentLat, currentLng, isOffRoute = false, distToRoute = 0, speed = 0, isRealFix = true) {
    if (!this.activeRoute) return;

    // Off-route automatic rerouting: ONLY on genuine GPS fixes!
    // Triggers instantly after 2 consecutive ticks (~1.5s) of staying off-route, exactly like Yandex Navigator
    if (isRealFix && this.isNavigating && isOffRoute && !this.isRerouting) {
      this.offRouteCounter = (this.offRouteCounter || 0) + 1;
      if (this.offRouteCounter >= 2) {
        this.recalculateRoute(currentLat, currentLng);
        return;
      }
    } else if (!isOffRoute) {
      this.offRouteCounter = 0;
    }

    const dest = this.activeRoute.destination;
    const distToDest = this.calculateDistance(currentLat, currentLng, dest.lat, dest.lng);

    // 1. Determine vehicle progress along route polyline
    let closestIdx = 0;
    let minDist = Infinity;
    if (this.routeCoordinates && this.routeCoordinates.length > 1) {
      const startSearch = Math.max(0, (this.lastProgressIndex || 0) - 2);
      const endSearch = Math.min(this.routeCoordinates.length, startSearch + 50);
      for (let i = startSearch; i < endSearch; i++) {
        const pt = this.routeCoordinates[i];
        const d = this.calculateDistance(currentLat, currentLng, pt[1], pt[0]);
        if (d < minDist) {
          minDist = d;
          closestIdx = i;
        }
      }
      const prevProgressIdx = this.lastProgressIndex || 0;
      const currentSeg = (this.currentSegIndex != null) ? this.currentSegIndex : Math.max(0, closestIdx - 1);
      this.lastProgressIndex = Math.max(prevProgressIdx, currentSeg);

      // 2. Update traveled route line on MapLibre GL
      // Traveled route line must strictly end AT the vehicle position [currentLng, currentLat]:
      // Slicing 0..currentSeg + 1 includes only vertices 0..currentSeg (all passed vertices behind the car).
      // Vertex currentSeg + 1 (the upcoming vertex ahead of the car) is NEVER included!
      const now = performance.now();
      if (this.provider === 'maplibre' && this.map && (this.lastProgressIndex > prevProgressIdx || !this.lastTraveledUpdate || (now - this.lastTraveledUpdate > 120))) {
        this.lastTraveledUpdate = now;
        const traveledSource = this.map.getSource('route-traveled');
        if (traveledSource) {
          const traveledCoords = this.routeCoordinates.slice(0, currentSeg + 1);
          traveledCoords.push([currentLng, currentLat]);
          traveledSource.setData({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: traveledCoords }
          });
        }
      } else if (this.provider === 'yandex' && this.map && this.yandexTraveledPolyline && (this.lastProgressIndex > prevProgressIdx || !this.lastTraveledUpdate || (now - this.lastTraveledUpdate > 120))) {
        this.lastTraveledUpdate = now;
        const traveledCoords = this.routeCoordinates.slice(0, currentSeg + 1).map(c => [c[1], c[0]]);
        traveledCoords.push([currentLat, currentLng]);
        this.yandexTraveledPolyline.geometry.setCoordinates(traveledCoords);
      }

      // 3. Instant O(1) Remaining Route Distance
      const totalDist = this.totalRouteMeters || this.totalDistance || 1000;
      let remainingMeters = 0;
      if (this.routeCumulativeDistances && this.routeCumulativeDistances[this.lastProgressIndex] != null) {
        remainingMeters = Math.max(0, totalDist - this.routeCumulativeDistances[this.lastProgressIndex]);
      } else {
        remainingMeters = Math.max(0, distToDest);
      }

      const progressPercent = Math.min(96, Math.max(0, Math.round((1 - remainingMeters / totalDist) * 100)));

      // Calculate remaining duration and ETA
      const totalDurSec = this.activeRoute.durationSec || (totalDist / 11);
      const remainingRatio = Math.max(0, Math.min(1, remainingMeters / totalDist));
      const remainingDurationSec = Math.max(30, Math.round(totalDurSec * remainingRatio));
      const remainingMinutes = Math.max(1, Math.round(remainingDurationSec / 60));

      const nowTime = new Date();
      const etaDate = new Date(nowTime.getTime() + remainingDurationSec * 1000);
      const etaHours = String(etaDate.getHours()).padStart(2, '0');
      const etaMins = String(etaDate.getMinutes()).padStart(2, '0');

      this.onProgressUpdate({
        percent: progressPercent,
        remainingDistance: this.formatNavDistance(remainingMeters),
        remainingDuration: `${remainingMinutes} мин`,
        eta: `${etaHours}:${etaMins}`,
        remainingMeters: remainingMeters
      });
    }

    // Destination Arrival
    if (distToDest < 25) {
      const lang = window.CURRENT_LANG || 'ru';
      const dict = I18N[lang] || I18N.ru;
      this.speakVoice(dict.voiceArrived || 'Вы прибыли в пункт назначения');
      this.onArrival(dest);
      this.cancelRoute();
      return;
    }

    // 4. Maneuver advancement & countdown with smart rounding
    if (this.routeSteps && this.routeSteps.length > 0) {
      while (this.currentStepIndex < this.routeSteps.length - 1) {
        const step = this.routeSteps[this.currentStepIndex];
        if (!step.location) {
          break;
        }
        const stepDist = this.calculateDistance(currentLat, currentLng, step.location[1], step.location[0]);
        if (stepDist < 30) {
          this.currentStepIndex++;
          this.spokenDistanceThresholds = {};
        } else {
          break;
        }
      }

      const activeStep = this.routeSteps[this.currentStepIndex] || this.routeSteps[this.routeSteps.length - 1];
      let activeDist = 0;
      if (activeStep.location) {
        activeDist = Math.max(0, this.calculateDistance(currentLat, currentLng, activeStep.location[1], activeStep.location[0]));
      } else {
        activeDist = Math.max(0, distToDest);
      }

      // Search for the closest upcoming lane intersection along route (within 220m)
      let upcomingLaneInter = null;
      let upcomingLaneDist = Infinity;
      const currentCarDist = this.simulatedNavDistance != null
        ? this.simulatedNavDistance
        : (this.routeCumulativeDistances?.[this.lastProgressIndex || 0] || 0);

      if (this.laneIntersections && this.laneIntersections.length > 0) {
        for (const li of this.laneIntersections) {
          const dAhead = (li.routeDist != null ? li.routeDist : 0) - currentCarDist;
          if (dAhead >= -15 && dAhead <= 220) {
            upcomingLaneInter = li;
            upcomingLaneDist = Math.max(0, dAhead);
            break;
          }
        }
      }

      const activeLanes = (upcomingLaneInter && upcomingLaneDist <= 220)
        ? upcomingLaneInter.lanes
        : (activeDist <= 220 ? (activeStep.lanes || null) : null);

      const activeLaneDist = (upcomingLaneInter && upcomingLaneDist <= 220)
        ? upcomingLaneDist
        : activeDist;

      this.onManeuverUpdate({
        distance: this.formatNavDistance(activeDist),
        distanceMeters: activeDist,
        instruction: activeStep.instruction || activeStep.name || 'Двигайтесь прямо',
        street: activeStep.name || activeStep.instruction || dest.name,
        modifier: (upcomingLaneInter && upcomingLaneDist <= 220 && upcomingLaneInter.modifier)
          ? upcomingLaneInter.modifier
          : (activeStep.modifier || 'straight'),
        type: activeStep.type || 'turn',
        speedLimit: currentSpeedLimit,
        location: activeStep.location || null,
        lanes: activeLanes,
        laneDistanceMeters: activeLaneDist
      });

      // Voice announcements at 250m and 50m (localized phraseology)
      if (this.voiceEnabled) {
        if (activeDist <= 260 && activeDist >= 200 && !this.spokenDistanceThresholds['250']) {
          this.spokenDistanceThresholds['250'] = true;
          const lang = window.CURRENT_LANG || 'ru';
          const turnText = this.getTurnSpeech(activeStep.modifier);
          let phrase = '';
          if (lang === 'en') {
            const streetText = activeStep.name ? ` onto ${activeStep.name}` : '';
            phrase = `In 250 meters ${turnText.toLowerCase()}${streetText}`;
          } else if (lang === 'hy') {
            const mod = (activeStep.modifier || '').toLowerCase();
            if (mod.includes('slight left') || mod.includes('keep left') || mod.includes('fork left')) phrase = 'dist_250_keep_left';
            else if (mod.includes('slight right') || mod.includes('keep right') || mod.includes('fork right')) phrase = 'dist_250_keep_right';
            else if (mod.includes('left')) phrase = 'dist_250_left';
            else if (mod.includes('right')) phrase = 'dist_250_right';
            else phrase = 'dist_250_straight';
          } else {
            const streetText = activeStep.name ? ` на ${activeStep.name}` : '';
            phrase = `Через 250 метров ${turnText.toLowerCase()}${streetText}`;
          }
          this.speakVoice(phrase);
        } else if (activeDist <= 70 && activeDist >= 30 && !this.spokenDistanceThresholds['50']) {
          this.spokenDistanceThresholds['50'] = true;
          this.speakVoice(this.getTurnSpeech(activeStep.modifier));
        }
      }
    }

    // 5. Proximity to speed cameras: strictly along the active route ahead
    let nearestCameraDist = Infinity;
    let upcomingCameraLimit = null;

    if (this.routeCoordinates && this.routeCoordinates.length > 1) {
      const totalSegs = this.routeCoordinates.length - 1;
      const currentSeg = this.currentSegIndex || 0;

      for (const cam of this.trafficPoints.filter(p => p.type === 'camera')) {
        for (let i = currentSeg; i < Math.min(totalSegs, currentSeg + 60); i++) {
          const p1 = this.routeCoordinates[i];
          const p2 = this.routeCoordinates[i + 1];
          const proj = this.projectPointToSegment(cam.lng, cam.lat, p1[0], p1[1], p2[0], p2[1]);
          const perpDist = this.calculateDistance(cam.lat, cam.lng, proj.y, proj.x);
          // Strict corridor: camera must be within 24m of the route polyline
          if (perpDist <= 24) {
            const segDist = this.routeCumulativeDistances?.[i] || 0;
            const segLen = Math.max(0.1, (this.routeCumulativeDistances?.[i + 1] || (segDist + 1)) - segDist);
            const camRouteDist = segDist + (proj.t * segLen);
            const currentRouteDist = this.simulatedNavDistance || (this.routeCumulativeDistances?.[currentSeg] || 0);
            const distAlongRoute = camRouteDist - currentRouteDist;

            if (distAlongRoute > 15 && distAlongRoute < 550 && distAlongRoute < nearestCameraDist) {
              nearestCameraDist = Math.round(distAlongRoute);
              upcomingCameraLimit = cam.limit || 60;
            }
            break;
          }
        }
      }
    }

    if (nearestCameraDist < 550) {
      this.onCameraAlert({
        visible: true,
        distance: this.formatNavDistance(nearestCameraDist),
        distanceMeters: nearestCameraDist,
        limit: upcomingCameraLimit
      });
    } else {
      this.onCameraAlert({ visible: false });
    }
  }

  // Free Driving Camera Proximity Check (When no active route is built)
  checkFreeDrivingCameraAlert(currentLat, currentLng, speed) {
    let nearestCameraDist = Infinity;
    let upcomingCameraLimit = null;

    for (const cam of this.trafficPoints.filter(p => p.type === 'camera')) {
      const d = this.calculateDistance(currentLat, currentLng, cam.lat, cam.lng);
      if (d > 15 && d < 450) {
        const bearingToCam = this.calculateBearing(currentLat, currentLng, cam.lat, cam.lng);
        const angleDiff = Math.abs(((bearingToCam - this.currentHeading) % 360 + 540) % 360 - 180);
        if (angleDiff <= 28) {
          const perp = d * Math.sin((angleDiff * Math.PI) / 180);
          if (perp <= 24 && d < nearestCameraDist) {
            nearestCameraDist = Math.round(d);
            upcomingCameraLimit = cam.limit || 60;
          }
        }
      }
    }

    if (nearestCameraDist < 450) {
      this.onCameraAlert({
        visible: true,
        distance: this.formatNavDistance(nearestCameraDist),
        distanceMeters: nearestCameraDist,
        limit: upcomingCameraLimit
      });
    } else {
      this.onCameraAlert({ visible: false });
    }
  }

  // Automatic Off-Route Rerouting from current road (authentic Yandex Navigator behaviour)
  async recalculateRoute(lat, lng) {
    if (!this.activeRoute || !this.activeRoute.destination || this.isRerouting) return;
    this.isRerouting = true;
    console.log('[MapEngine] Deviated from route. Recalculating from current road...');
    const lang = window.CURRENT_LANG || 'ru';
    const dict = I18N[lang] || I18N.ru;

    this.playNavChime();
    this.speakVoice(dict.voiceRerouting || 'Маршрут перестроен');

    try {
      const dest = this.activeRoute.destination;
      const url = `/api/route?startLat=${lat}&startLng=${lng}&destLat=${dest.lat}&destLng=${dest.lng}&provider=${this.provider}`;
      const res = await fetch(url);
      const data = await res.json();

      if (data && data.success && data.routes && data.routes.length > 0) {
        const routeInfo = this.applyRouteData(data, dest);
        if (routeInfo) {
          this.onRouteCalculated(routeInfo);
        }
        console.log('[MapEngine] Route recalculated successfully with Yandex live data.');
      }
    } catch (e) {
      console.warn('Recalculate route error:', e);
    } finally {
      this.offRouteCounter = 0;
      setTimeout(() => {
        this.isRerouting = false;
      }, 2000);
    }
  }

  getTurnSpeech(modifier) {
    const lang = window.CURRENT_LANG || 'ru';
    const dict = I18N[lang] || I18N.ru;
    const mod = (modifier || '').toLowerCase();
    if (mod.includes('slight left') || mod.includes('keep left') || mod.includes('bear left') || mod.includes('fork left') || mod.includes('левее')) {
      return dict.voiceKeepLeft || 'Держитесь левее';
    }
    if (mod.includes('slight right') || mod.includes('keep right') || mod.includes('bear right') || mod.includes('fork right') || mod.includes('правее')) {
      return dict.voiceKeepRight || 'Держитесь правее';
    }
    if (mod.includes('uturn') || mod.includes('u-turn') || mod.includes('разворот')) {
      return dict.voiceUTurn || 'Развернитесь';
    }
    if (mod.includes('left') || mod.includes('налево')) return dict.voiceTurnLeft;
    if (mod.includes('right') || mod.includes('направо')) return dict.voiceTurnRight;
    return dict.voiceStraight;
  }

  // Authentic Navigation Audio Chime (/sounds/nav-chime.wav with Web Audio fallback)
  playNavChime() {
    try {
      const chime = new Audio('/sounds/nav-chime.wav');
      chime.volume = 0.85;
      const playPromise = chime.play();
      if (playPromise && playPromise.catch) {
        playPromise.catch(() => {
          // Web Audio fallback if media element is delayed
          try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            if (!this.audioCtx) this.audioCtx = new AudioCtx();
            if (this.audioCtx.state === 'suspended') this.audioCtx.resume();

            const ctx = this.audioCtx;
            const now = ctx.currentTime;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();

            osc.type = 'sine';
            osc.frequency.setValueAtTime(1046.5, now);
            osc.frequency.exponentialRampToValueAtTime(1318.5, now + 0.08);

            gain.gain.setValueAtTime(0.0001, now);
            gain.gain.exponentialRampToValueAtTime(0.2, now + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);

            osc.connect(gain);
            gain.connect(ctx.destination);

            osc.start(now);
            osc.stop(now + 0.26);
          } catch (e) {}
        });
      }
    } catch (e) {}
  }

  // Strictly use our studio audio stream (/api/tts) for authentic, high-quality voice guidance
  speakVoice(text, forcedVoice) {
    if (!this.voiceEnabled) return;
    try {
      this.playNavChime();
      setTimeout(() => {
        if (this.currentAudioVoice) {
          try { this.currentAudioVoice.pause(); } catch (e) {}
          this.currentAudioVoice = null;
        }
        const lang = window.CURRENT_LANG || 'ru';
        const savedVoice = localStorage.getItem('tesla_navi_voice') || 'female';
        const isMale = (savedVoice === 'male' || savedVoice === 'dmitry' || savedVoice === 'gor' || savedVoice === 'andrew');
        let defaultVoice = 'svetlana';
        if (lang === 'hy') defaultVoice = 'gor';
        else if (lang === 'en') defaultVoice = isMale ? 'andrew' : 'ava';
        else defaultVoice = isMale ? 'dmitry' : 'svetlana';
        const voice = forcedVoice || defaultVoice;
        const cacheBuster = 'v=v4_gor_hd';
        const audio = new Audio(`/api/tts?text=${encodeURIComponent(text)}&lang=${lang}&voice=${encodeURIComponent(voice)}&${cacheBuster}`);
        audio.volume = 1.0;
        this.currentAudioVoice = audio;
        audio.play().catch(e => {
          console.warn('Audio TTS playback error:', e);
        });
      }, 220);
    } catch (e) {
      console.warn('Voice playback error:', e);
    }
  }

  // Generate Vibrant Traffic Colored Segments (Exact Mapsev & Yandex Navigator: Green #10b981, Amber #f59e0b, Red #ef4444)
  generateTrafficSegments(coordinates) {
    const total = coordinates.length;
    if (total < 4) {
      return [{ coords: coordinates, color: '#10b981' }];
    }

    const segments = [];
    const p1 = Math.floor(total * 0.38);
    const p2 = Math.floor(total * 0.60);
    const p3 = Math.floor(total * 0.78);

    // Initial section: Free flow green
    segments.push({
      coords: coordinates.slice(0, p1 + 1),
      color: '#10b981'
    });

    // Moderate slow section: Amber/yellow
    segments.push({
      coords: coordinates.slice(p1, p2 + 1),
      color: '#f59e0b'
    });

    // Congestion jam section: Red
    segments.push({
      coords: coordinates.slice(p2, p3 + 1),
      color: '#ef4444'
    });

    // Final arrival section: Free flow green
    segments.push({
      coords: coordinates.slice(p3),
      color: '#10b981'
    });

    return segments.filter(s => s.coords.length >= 2);
  }

  // Parse Yandex or OSRM route data and render on map (with full route alternatives support)
  applyRouteData(data, destination, activeIndex = 0) {
    this.rawRouteData = data;
    this.activeRouteIndex = activeIndex;
    const isYandex = data.source === 'yandex';
    const primaryRoute = (data.routes && data.routes[activeIndex]) ? data.routes[activeIndex] : data.routes[0];
    const coordinates = isYandex ? primaryRoute.coordinates : (primaryRoute.geometry?.coordinates || primaryRoute.coordinates); // [lng, lat]
    this.routeCoordinates = coordinates;
    const durationSec = primaryRoute.duration;
    const distanceMeters = primaryRoute.distance;
    this.totalDistance = distanceMeters;

    // Pre-calculate cumulative polyline distances for instant O(1) navigation tracking
    this.routeCumulativeDistances = [0];
    for (let i = 0; i < coordinates.length - 1; i++) {
      const p1 = coordinates[i];
      const p2 = coordinates[i + 1];
      const d = this.calculateDistance(p1[1], p1[0], p2[1], p2[0]);
      this.routeCumulativeDistances.push(this.routeCumulativeDistances[i] + d);
    }
    this.totalRouteMeters = this.routeCumulativeDistances[this.routeCumulativeDistances.length - 1] || distanceMeters;

    // Traffic segments (100% genuine Yandex real-time traffic colors)
    const trafficSegments = isYandex ? primaryRoute.segments : null;

    // Parse navigation steps
    this.routeSteps = [];
    this.currentStepIndex = 0;
    this.spokenDistanceThresholds = {};
    this.specialRoadPoints = primaryRoute.specialRoadPoints || [];
    this.activeRoute = { destination, durationSec, distanceMeters };
    this.laneIntersections = primaryRoute.laneIntersections || [];

    // Pre-calculate route distance for each lane intersection along routeCoordinates
    if (this.laneIntersections.length > 0 && this.routeCoordinates && this.routeCumulativeDistances) {
      this.laneIntersections.forEach(li => {
        let bestDist = 0;
        let minD = Infinity;
        for (let i = 0; i < this.routeCoordinates.length - 1; i++) {
          const p1 = this.routeCoordinates[i];
          const p2 = this.routeCoordinates[i + 1];
          const proj = this.projectPointToSegment(li.location[0], li.location[1], p1[0], p1[1], p2[0], p2[1]);
          const d = this.calculateDistance(li.location[1], li.location[0], proj.y, proj.x);
          if (d < minD) {
            minD = d;
            const segStartDist = this.routeCumulativeDistances[i] || 0;
            const segLen = (this.routeCumulativeDistances[i + 1] || segStartDist) - segStartDist;
            bestDist = segStartDist + proj.t * segLen;
          }
        }
        li.routeDist = bestDist;
      });
      this.laneIntersections.sort((a, b) => a.routeDist - b.routeDist);
    }

    if (primaryRoute.steps && primaryRoute.steps.length > 0) {
      this.routeSteps = primaryRoute.steps.map(s => ({
        name: s.name || destination.name,
        instruction: s.instruction || 'Двигайтесь прямо',
        action: s.action || '',
        modifier: s.modifier || 'straight',
        type: s.type || 'turn',
        location: s.location, // [lng, lat]
        distance: s.distance,
        duration: s.duration,
        speedLimit: s.speedLimit || 60,
        lanes: s.lanes || null
      }));
    } else if (primaryRoute.legs && primaryRoute.legs.length > 0) {
      primaryRoute.legs[0].steps.forEach(step => {
        const maneuver = step.maneuver || {};
        const mod = (maneuver.modifier || '').toLowerCase();
        let instruction = 'Двигайтесь прямо';
        if (mod.includes('slight left') || mod.includes('keep left') || mod.includes('fork left')) instruction = `Держитесь левее${step.name ? ` на ${step.name}` : ''}`;
        else if (mod.includes('slight right') || mod.includes('keep right') || mod.includes('fork right')) instruction = `Держитесь правее${step.name ? ` на ${step.name}` : ''}`;
        else if (mod.includes('left')) instruction = `Поверните налево${step.name ? ` на ${step.name}` : ''}`;
        else if (mod.includes('right')) instruction = `Поверните направо${step.name ? ` на ${step.name}` : ''}`;
        else if (mod.includes('uturn')) instruction = 'Развернитесь';
        else if (step.name) instruction = `Двигайтесь по ${step.name}`;

        this.routeSteps.push({
          name: step.name || destination.name,
          instruction: instruction,
          type: maneuver.type,
          modifier: maneuver.modifier,
          location: maneuver.location,
          distance: step.distance,
          speedLimit: 60,
          lanes: (step.intersections && step.intersections[0] && step.intersections[0].lanes) ? step.intersections[0].lanes : null
        });
      });
    } else {
      this.routeSteps.push({
        name: destination.name || 'Пункт назначения',
        instruction: 'Двигайтесь по маршруту',
        type: 'straight',
        modifier: '',
        distance: distanceMeters,
        speedLimit: 60
      });
    }

    // Prepare list of all routes for cards (up to 3 routes)
    const fastestDurationSec = data.routes[0]?.duration || durationSec;
    const allRoutes = (data.routes || []).slice(0, 3).map((r, i) => {
      const diffMins = Math.round((r.duration - fastestDurationSec) / 60);
      return {
        index: i,
        summary: r.summary || (i === 0 ? 'Самый быстрый' : `Вариант ${i + 1}`),
        duration: `${Math.round(r.duration / 60)} мин`,
        distance: r.distance >= 1000 ? `${(r.distance / 1000).toFixed(1)} км` : `${Math.round(r.distance)} м`,
        diffMins: diffMins > 0 ? `+${diffMins} мин` : '0 мин'
      };
    });

    // Alternative lines on map (all routes other than activeIndex)
    const altLines = [];
    (data.routes || []).forEach((r, idx) => {
      if (idx !== activeIndex && idx < 3) {
        const altCoords = isYandex ? r.coordinates : (r.geometry?.coordinates || r.coordinates);
        if (altCoords && altCoords.length >= 2) {
          altLines.push({ index: idx, coordinates: altCoords });
        }
      }
    });

    // 1. Render on MAPLIBRE GL JS
    if (this.provider === 'maplibre' && this.map) {
      this.renderMapLibreRoute(coordinates, destination, altLines, trafficSegments);
    }
    // 2. Render on YANDEX MAPS
    else if (this.provider === 'yandex' && this.map && window.ymaps) {
      this.renderYandexRoute(coordinates.map(c => [c[1], c[0]]), destination, trafficSegments);
    }
    // 3. Render on LEAFLET
    else if (this.map && window.L) {
      this.renderLeafletRoute(coordinates.map(c => [c[1], c[0]]), destination, trafficSegments);
    }

    // Calculate ETA
    const now = new Date();
    const etaDate = new Date(now.getTime() + durationSec * 1000);
    const etaHours = String(etaDate.getHours()).padStart(2, '0');
    const etaMins = String(etaDate.getMinutes()).padStart(2, '0');

    const routeInfo = {
      distance: distanceMeters >= 1000 ? `${(distanceMeters / 1000).toFixed(1)} км` : `${Math.round(distanceMeters)} м`,
      duration: `${Math.round(durationSec / 60)} мин`,
      eta: `${etaHours}:${etaMins}`,
      name: destination.name || 'Маршрут',
      summary: primaryRoute.summary || (activeIndex === 0 ? 'Самый быстрый' : `Вариант ${activeIndex + 1}`),
      steps: this.routeSteps,
      trafficSegments: (trafficSegments && trafficSegments.length > 0) ? trafficSegments : this.generateTrafficSegments(coordinates),
      allRoutes: allRoutes,
      activeRouteIndex: activeIndex,
      alternatives: allRoutes.filter(r => r.index !== activeIndex),
      alternative: allRoutes[1] || null
    };
    this.trafficSegments = routeInfo.trafficSegments;

    this.lastProgressIndex = 0;
    this.onProgressUpdate(0);

    return routeInfo;
  }

  // Route calculation using 100% Yandex live traffic router (/api/route)
  async buildRouteTo(destination) {
    this.activeRoute = { destination };
    const start = [this.currentPosition.lat, this.currentPosition.lng];
    const end = [destination.lat, destination.lng];

    try {
      const url = `/api/route?startLat=${start[0]}&startLng=${start[1]}&destLat=${end[0]}&destLng=${end[1]}&provider=${this.provider}`;
      const res = await fetch(url);
      const data = await res.json();

      if (data && data.success && data.routes && data.routes.length > 0) {
        const routeInfo = this.applyRouteData(data, destination, 0);
        this.onRouteCalculated(routeInfo);
        return routeInfo;
      }
    } catch (err) {
      console.error('[MapEngine] Route error:', err);
    }
    return null;
  }

  // Switch between Primary and Alternative Route
  selectRouteIndex(index) {
    if (!this.rawRouteData || !this.rawRouteData.routes || !this.rawRouteData.routes[index]) return;
    const routeInfo = this.applyRouteData(this.rawRouteData, this.activeRoute.destination, index);
    if (routeInfo) {
      this.onRouteCalculated(routeInfo);
    }
  }

  // Render Route on MapLibre GL with Yandex Navigator Styling & Alternative Blue Routes
  renderMapLibreRoute(coordinates, destination, alternatives = null, trafficSegments = null) {
    // Clear old alternative layers (alt 0, 1, 2, etc.)
    for (let a = 0; a < 5; a++) {
      if (this.map.getLayer(`route-alt-casing-${a}`)) this.map.removeLayer(`route-alt-casing-${a}`);
      if (this.map.getLayer(`route-alt-line-${a}`)) this.map.removeLayer(`route-alt-line-${a}`);
      if (this.map.getSource(`route-alt-${a}`)) this.map.removeSource(`route-alt-${a}`);
    }
    if (this.map.getLayer('route-alt-casing')) this.map.removeLayer('route-alt-casing');
    if (this.map.getLayer('route-alt-line')) this.map.removeLayer('route-alt-line');
    if (this.map.getSource('route-alt')) this.map.removeSource('route-alt');

    if (this.map.getLayer('route-casing')) this.map.removeLayer('route-casing');
    for (let i = 0; i < 200; i++) {
      if (this.map.getLayer(`route-seg-${i}`)) this.map.removeLayer(`route-seg-${i}`);
      if (this.map.getSource(`route-seg-${i}`)) this.map.removeSource(`route-seg-${i}`);
    }
    if (this.map.getSource('route-full')) this.map.removeSource('route-full');

    // 1. Alternative Routes (Cyan Blue lines underneath, like MapsEV & Yandex)
    const altList = Array.isArray(alternatives) ? alternatives : (alternatives ? [{ coordinates: alternatives, index: 1 }] : []);
    altList.forEach((alt, aIdx) => {
      const altCoords = alt.coordinates || alt;
      if (!altCoords || altCoords.length < 2) return;
      const srcId = `route-alt-${aIdx}`;
      this.map.addSource(srcId, {
        type: 'geojson',
        data: {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: altCoords }
        }
      });

      this.map.addLayer({
        id: `route-alt-casing-${aIdx}`,
        type: 'line',
        source: srcId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#0f172a',
          'line-width': 7.5,
          'line-opacity': 0.75
        }
      });

      this.map.addLayer({
        id: `route-alt-line-${aIdx}`,
        type: 'line',
        source: srcId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': aIdx === 0 ? '#0284c7' : '#0ea5e9', // Vibrant Sky/Cyan Blue
          'line-width': 5.0,
          'line-opacity': 0.80
        }
      });
    });

    // 2. Primary Route Dark Navy Casing
    this.map.addSource('route-full', {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates }
      }
    });

    this.map.addLayer({
      id: 'route-casing',
      type: 'line',
      source: 'route-full',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#223a18',
        'line-width': 9.5,
        'line-opacity': 0.5
      }
    });

    // 3. Colored Traffic Segments (100% Genuine Yandex Traffic or Smooth Fallback)
    const segments = (trafficSegments && trafficSegments.length > 0)
      ? trafficSegments
      : this.generateTrafficSegments(coordinates);

    segments.forEach((seg, i) => {
      const sourceId = `route-seg-${i}`;
      this.map.addSource(sourceId, {
        type: 'geojson',
        data: {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: seg.coords }
        }
      });

      this.map.addLayer({
        id: `route-seg-${i}`,
        type: 'line',
        source: sourceId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': seg.color,
          'line-width': 7.5,
          'line-opacity': 1.0
        }
      });
    });

    // 3.5. Traveled Route Line (Muted slate gray casing + solid gray line, covering driven road completely)
    if (this.map.getLayer('route-traveled-casing')) this.map.removeLayer('route-traveled-casing');
    if (this.map.getLayer('route-traveled-line')) this.map.removeLayer('route-traveled-line');
    if (this.map.getSource('route-traveled')) this.map.removeSource('route-traveled');

    this.map.addSource('route-traveled', {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [] }
      }
    });

    // Traveled Casing: neutral slate casing covering green #223a18 route casing
    this.map.addLayer({
      id: 'route-traveled-casing',
      type: 'line',
      source: 'route-traveled',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#475569',
        'line-width': 9.5,
        'line-opacity': 0.8
      }
    });

    // Traveled Core Line: solid distinct slate gray, 100% opaque (completely covering any green/red traffic colors underneath)
    this.map.addLayer({
      id: 'route-traveled-line',
      type: 'line',
      source: 'route-traveled',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#94a3b8',
        'line-width': 7.5,
        'line-opacity': 1.0
      }
    });

    // 4. Destination Pin
    if (this.destMarker) this.destMarker.remove();

    const destEl = document.createElement('div');
    destEl.className = 'yandex-dest-pin';
    destEl.innerHTML = `
      <div class="dest-target-pulse"></div>
      <div class="dest-target-box">
        <svg viewBox="0 0 32 32" width="32" height="32">
          <circle cx="16" cy="16" r="13" fill="#1e293b" stroke="#ffffff" stroke-width="2.5"/>
          <circle cx="16" cy="16" r="5" fill="#ef4444"/>
        </svg>
      </div>
    `;
    this.destMarker = new window.maplibregl.Marker({ element: destEl, anchor: 'center' })
      .setLngLat([destination.lng, destination.lat])
      .addTo(this.map);
  }

  renderYandexRoute(latLngs, destination, trafficSegments = null) {
    if (this.routePolyline) {
      this.map.geoObjects.remove(this.routePolyline);
      this.routePolyline = null;
    }
    if (this.yandexTraveledPolyline) {
      this.map.geoObjects.remove(this.yandexTraveledPolyline);
      this.yandexTraveledPolyline = null;
    }
    if (this.destMarker) {
      this.map.geoObjects.remove(this.destMarker);
      this.destMarker = null;
    }

    this.routePolyline = new window.ymaps.GeoObjectCollection();
    this.routePolyline.add(new window.ymaps.Polyline(latLngs, {}, {
      strokeColor: '#223a18',
      strokeWidth: 9.5,
      strokeOpacity: 0.5
    }));

    const segments = (trafficSegments && trafficSegments.length > 0)
      ? trafficSegments.map(s => ({ color: s.color, coords: s.coords.map(c => [c[1], c[0]]) }))
      : this.generateTrafficSegments(latLngs);

    segments.forEach(seg => {
      this.routePolyline.add(new window.ymaps.Polyline(seg.coords, {}, {
        strokeColor: seg.color,
        strokeWidth: 7.5,
        strokeOpacity: 1.0
      }));
    });

    this.map.geoObjects.add(this.routePolyline);

    // Traveled route polyline: rendered on top, starts empty, dims driven road with #94a3b8
    this.yandexTraveledPolyline = new window.ymaps.Polyline([], {}, {
      strokeColor: '#94a3b8',
      strokeWidth: 7.5,
      strokeOpacity: 1.0
    });
    this.map.geoObjects.add(this.yandexTraveledPolyline);

    this.destMarker = new window.ymaps.Placemark([destination.lat, destination.lng], {
      hintContent: destination.name || 'Пункт назначения'
    }, {
      preset: 'islands#redDotIconWithCaption'
    });
    this.map.geoObjects.add(this.destMarker);

    try {
      if (!this.isNavigating && this.routePolyline && this.routePolyline.getBounds()) {
        this.map.setBounds(this.routePolyline.getBounds(), {
          checkZoomRange: true,
          zoomMargin: 60
        });
      }
    } catch (e) {}
  }

  renderLeafletRoute(latLngs, destination, trafficSegments = null) {
    if (this.routePolyline) this.map.removeLayer(this.routePolyline);
    if (this.destMarker) this.map.removeLayer(this.destMarker);

    this.routePolyline = window.L.featureGroup();
    this.routePolyline.addLayer(window.L.polyline(latLngs, {
      color: '#223a18',
      weight: 9.5,
      opacity: 0.5,
      lineCap: 'round',
      lineJoin: 'round'
    }));

    const segments = (trafficSegments && trafficSegments.length > 0)
      ? trafficSegments.map(s => ({ color: s.color, coords: s.coords.map(c => [c[1], c[0]]) }))
      : this.generateTrafficSegments(latLngs);

    segments.forEach(seg => {
      this.routePolyline.addLayer(window.L.polyline(seg.coords, {
        color: seg.color,
        weight: 7.5,
        opacity: 1.0,
        lineCap: 'round',
        lineJoin: 'round'
      }));
    });

    this.routePolyline.addTo(this.map);

    const destIcon = window.L.divIcon({
      className: 'tesla-dest-pin-container',
      html: `
        <div class="yandex-dest-pin">
          <div class="dest-target-pulse"></div>
          <div class="dest-target-box">
            <svg viewBox="0 0 32 32" width="32" height="32">
              <circle cx="16" cy="16" r="13" fill="#1e293b" stroke="#ffffff" stroke-width="2.5"/>
              <circle cx="16" cy="16" r="5" fill="#ef4444"/>
            </svg>
          </div>
        </div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16]
    });

    this.destMarker = window.L.marker([destination.lat, destination.lng], { icon: destIcon }).addTo(this.map);
  }

  startNavigation() {
    this.isNavigating = true;
    this.followCar = true;
    this.isHeadingUp = true;
    this.offRouteCounter = 0;
    this.lastProgressIndex = 0;
    this.currentStepIndex = 0;
    this.spokenDistanceThresholds = {};

    if (this.provider === 'maplibre' && this.map) {
      const markerEl = document.querySelector('#maplibre-car-marker .tesla-car-arrow');
      if (markerEl) markerEl.style.transform = 'rotate(0deg)';
      this.map.stop();
      this.map.easeTo({
        center: [this.currentPosition.lng, this.currentPosition.lat],
        bearing: this.currentHeading,
        pitch: (this.is3D && this.isHeadingUp) ? (CONFIG.navigationPitch || 45) : 0,
        padding: { top: 220, bottom: 0, left: 0, right: 0 },
        zoom: this.navZoom,
        duration: 500
      });
    } else if (this.provider === 'yandex' && this.map) {
      this.map.setCenter([this.currentPosition.lat, this.currentPosition.lng], this.navZoom, {
        checkZoomRange: true,
        duration: 500
      });
    }

    const lang = window.CURRENT_LANG || 'ru';
    const dict = I18N[lang] || I18N.ru;
    this.speakVoice(dict.voiceStart || 'Маршрут построен. Поехали!');
  }

  cancelRoute() {
    this.activeRoute = null;
    this.isNavigating = false;
    this.clearRoadLaneMarker();
    this.lastProgressIndex = 0;
    this.routeCoordinates = [];
    this.alternativeCoordinates = null;
    this.routeSteps = [];
    this.laneIntersections = [];
    this.currentStepIndex = 0;
    this.totalDistance = 0;
    this.specialRoadPoints = [];

    if (this.provider === 'maplibre' && this.map) {
      if (this.map.getLayer('route-traveled-casing')) this.map.removeLayer('route-traveled-casing');
      if (this.map.getLayer('route-traveled-line')) this.map.removeLayer('route-traveled-line');
      if (this.map.getSource('route-traveled')) this.map.removeSource('route-traveled');

      if (this.map.getLayer('route-alt-casing')) this.map.removeLayer('route-alt-casing');
      if (this.map.getLayer('route-alt-line')) this.map.removeLayer('route-alt-line');
      if (this.map.getSource('route-alt')) this.map.removeSource('route-alt');

      if (this.map.getLayer('route-casing')) this.map.removeLayer('route-casing');
      if (this.map.getSource('route-full')) this.map.removeSource('route-full');
      for (let i = 0; i < 200; i++) {
        if (this.map.getLayer(`route-seg-${i}`)) this.map.removeLayer(`route-seg-${i}`);
        if (this.map.getSource(`route-seg-${i}`)) this.map.removeSource(`route-seg-${i}`);
      }
      if (this.destMarker) {
        this.destMarker.remove();
        this.destMarker = null;
      }

      this.map.easeTo({
        pitch: 0,
        padding: { top: 0, bottom: 0, left: 0, right: 0 },
        duration: 400
      });
    } else if (this.provider === 'yandex' && this.map) {
      if (this.routePolyline) this.map.geoObjects.remove(this.routePolyline);
      if (this.yandexTraveledPolyline) this.map.geoObjects.remove(this.yandexTraveledPolyline);
      if (this.destMarker) this.map.geoObjects.remove(this.destMarker);
      this.routePolyline = null;
      this.yandexTraveledPolyline = null;
      this.destMarker = null;
    } else if (this.map) {
      if (this.routePolyline) this.map.removeLayer(this.routePolyline);
      if (this.destMarker) this.map.removeLayer(this.destMarker);
      this.routePolyline = null;
      this.destMarker = null;
    }
  }

  // Apply Authentic Mapsev & Yandex Navigator Road Palette (Refs: refs/map/)
  applyMapsevRoadColors() {
    if (!this.map || this.provider !== 'maplibre' || this._isApplyingColors) return;
    this._isApplyingColors = true;
    try {
      const style = this.map.getStyle();
      if (!style || !style.layers) return;

      style.layers.forEach(layer => {
        if (layer.type !== 'line') return;
        const id = (layer.id || '').toLowerCase();
        const srcLayer = (layer['source-layer'] || '').toLowerCase();

        // 1. Motorways, Trunks & Primary Avenues (Halabyan, Kirk Kerkorian, Monte Melkonyan, etc.)
        // Slate-blue-grey road fill matching Yandex & Mapsev
        if (
          id.includes('motorway') ||
          id.includes('trunk') ||
          id.includes('primary') ||
          (srcLayer === 'transportation' && (id.includes('major') || id.includes('high')))
        ) {
          if (id.includes('casing') || id.includes('case')) {
            this.map.setPaintProperty(layer.id, 'line-color', '#6e859b');
          } else {
            this.map.setPaintProperty(layer.id, 'line-color', '#8fa4b8');
          }
        }
        // 2. Secondary & Tertiary Urban Streets (Connecting roads)
        // Medium cool grey
        else if (
          id.includes('secondary') ||
          id.includes('tertiary')
        ) {
          if (id.includes('casing') || id.includes('case')) {
            this.map.setPaintProperty(layer.id, 'line-color', '#9eafbe');
          } else {
            this.map.setPaintProperty(layer.id, 'line-color', '#b8c5d1');
          }
        }
        // 3. Unpaved, Dirt Tracks, Country Roads (Грунтовые дороги - Distinct warm earthy ochre/tan)
        else if (
          id.includes('track') ||
          id.includes('unpaved') ||
          id.includes('dirt') ||
          id.includes('path')
        ) {
          if (id.includes('casing') || id.includes('case')) {
            this.map.setPaintProperty(layer.id, 'line-color', '#ab947a');
          } else {
            this.map.setPaintProperty(layer.id, 'line-color', '#d2be9f');
          }
        }
        // 4. Minor, Residential Streets & Alleys
        // Clean crisp light grey / white
        else if (
          id.includes('minor') ||
          id.includes('service') ||
          id.includes('residential') ||
          id.includes('living_street')
        ) {
          if (id.includes('casing') || id.includes('case')) {
            this.map.setPaintProperty(layer.id, 'line-color', '#cbd5e1');
          } else {
            this.map.setPaintProperty(layer.id, 'line-color', '#edf2f7');
          }
        }
      });
    } catch (err) {
      console.warn('Mapsev road palette application error:', err);
    } finally {
      this._isApplyingColors = false;
    }
  }
}

