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
    this.is3D = saved3D !== null ? saved3D === '3d' : false; // Default to clean 2D (like Yandex) unless 3D is selected
    this.voiceEnabled = true;

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
    this.currentStepIndex = 0;
    this.totalDistance = 0;
    this.spokenDistanceThresholds = {};

    // Yerevan Key Traffic Lights & Speed Cameras (Sample coordinates around Center/Arabkir/Ajapnyak)
    this.trafficPoints = [
      { type: 'light', lat: 40.1898, lng: 44.4695, name: 'Leningradian / Kerkorian' },
      { type: 'camera', lat: 40.1915, lng: 44.4735, name: 'Speed Cam 60', limit: 60 },
      { type: 'light', lat: 40.1930, lng: 44.4840, name: 'Kievyan Bridge' },
      { type: 'camera', lat: 40.1955, lng: 44.4880, name: 'Speed Cam 60', limit: 60 },
      { type: 'light', lat: 40.1982, lng: 44.4928, name: 'Barekamutyun Square' },
      { type: 'light', lat: 40.1988, lng: 44.4935, name: 'Hakob Hakobyan St' },
      { type: 'camera', lat: 40.1830, lng: 44.4780, name: 'Monte Melkonyan Cam', limit: 60 },
      { type: 'light', lat: 40.1875, lng: 44.4750, name: 'Tsitsernakaberd Junction' },
      { type: 'light', lat: 40.1905, lng: 44.5020, name: 'Baghramyan / Proshyan' }
    ];
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

  // 1. MapLibre GL Clean Vector Map (No bulky 3D extruded blocks, fluid touch gestures)
  async initMapLibre() {
    return new Promise((resolve) => {
      this.map = new window.maplibregl.Map({
        container: this.containerId,
        style: CONFIG.maplibreStyle || 'https://tiles.openfreemap.org/styles/liberty',
        center: [this.center.lng, this.center.lat],
        zoom: this.navZoom,
        minZoom: 3,
        maxZoom: 19.5,
        pitch: (this.is3D && this.isHeadingUp) ? (CONFIG.navigationPitch || 45) : 0, // 2D flat or 3D Perspective Driving View
        bearing: 0,
        attributionControl: false,
        fadeDuration: 0
      });

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
        // Apply 2D / 3D Building Styling (Clean Yandex 2D footprints & Delicate MapsEV 3D)
        this.update3DMode(this.is3D);

        // Apply Authentic Mapsev & Yandex Navigator Road Palette (Refs: refs/map/)
        this.applyMapsevRoadColors();

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
                  <feDropShadow dx="0" dy="3" stdDeviation="3.5" flood-color="#000000" flood-opacity="0.55"/>
                </filter>
                <linearGradient id="arrow-facet-left" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#fffbeb" />
                  <stop offset="45%" stop-color="#fef08a" />
                  <stop offset="100%" stop-color="#facc15" />
                </linearGradient>
                <linearGradient id="arrow-facet-right" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#eab308" />
                  <stop offset="60%" stop-color="#ca8a04" />
                  <stop offset="100%" stop-color="#a16207" />
                </linearGradient>
              </defs>
              <g filter="url(#car-shadow)">
                <!-- Crisp white outer contour -->
                <polygon points="27,4 47,46 27,35 7,46" fill="#ffffff" stroke="#ffffff" stroke-width="2.5" stroke-linejoin="round"/>
                <!-- Left illuminated 3D facet -->
                <polygon points="27,6 27,34 9,44" fill="url(#arrow-facet-left)"/>
                <!-- Right shaded 3D facet -->
                <polygon points="27,6 45,44 27,34" fill="url(#arrow-facet-right)"/>
                <!-- Central ridge highlight line -->
                <line x1="27" y1="6" x2="27" y2="34" stroke="#ffffff" stroke-width="1.2" stroke-opacity="0.85"/>
              </g>
            </svg>
          </div>
        `;

        this.carMarker = new window.maplibregl.Marker({
          element: el,
          anchor: 'center',
          rotationAlignment: 'viewport'
        })
          .setLngLat([this.center.lng, this.center.lat])
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

  // Render Traffic Lights (🚦) and Speed Cameras with 60 km/h Signs (📷)
  renderTrafficPoints() {
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
        el.className = 'speed-cam-cluster-marker';
        el.innerHTML = `
          <div class="speed-cam-sign-circle">
            <span class="speed-cam-sign-val">${point.limit || 60}</span>
          </div>
          <div class="speed-cam-icon-bubble">📷</div>
        `;
        const marker = new window.maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat([point.lng, point.lat])
          .addTo(this.map);
        this.cameraMarkers.push(marker);
      }
    });
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
        let touchStartPos = null;
        let pinchStartDist = null;
        let pinchStartZoom = null;
        let pinchTimeout = null;

        if (containerEl) {
          containerEl.addEventListener('touchstart', (e) => {
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
              if (Math.hypot(dx, dy) > 20) {
                // User intentionally dragged map with 1 finger to pan away
                this.followCar = false;
                const recenterBtn = document.getElementById('floating-recenter-btn');
                if (recenterBtn) recenterBtn.classList.remove('hidden');
                if (this.onUserPan) this.onUserPan();
                this.resetAutoFollowTimer();
              }
            }
          }, { passive: false });

          containerEl.addEventListener('touchend', (e) => {
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
            } else if (e.touches.length === 1 && this.isUserPinching) {
              touchStartPos = null;
            }
          }, { passive: true });

          let mouseDownPos = null;
          containerEl.addEventListener('mousedown', (e) => {
            if (e.button === 0) {
              mouseDownPos = { x: e.clientX, y: e.clientY };
            }
          }, { passive: true });

          containerEl.addEventListener('mousemove', (e) => {
            if (mouseDownPos && e.buttons === 1) {
              const dx = e.clientX - mouseDownPos.x;
              const dy = e.clientY - mouseDownPos.y;
              if (Math.hypot(dx, dy) > 20) {
                this.followCar = false;
                const recenterBtn = document.getElementById('floating-recenter-btn');
                if (recenterBtn) recenterBtn.classList.remove('hidden');
                if (this.onUserPan) this.onUserPan();
                this.resetAutoFollowTimer();
              }
            }
          }, { passive: true });

          window.addEventListener('mouseup', () => {
            mouseDownPos = null;
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

  // Clear auto-follow recovery timer (recenter button stays visible until user clicks it)
  resetAutoFollowTimer() {
    if (this.autoFollowTimer) {
      clearTimeout(this.autoFollowTimer);
      this.autoFollowTimer = null;
    }
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
      btn.title = this.is3D ? 'Переключить в 2D плоский вид (как в Яндекс)' : 'Переключить в 3D перспективный вид';
    }
    if (label) {
      label.textContent = this.is3D ? '3D' : '2D';
    }

    if (this.provider === 'maplibre' && this.map) {
      try {
        // 1. Ensure clean 2D building footprints exist across all zoom levels (13 to 24)
        if (!this.map.getLayer('building-clean-2d') && this.map.getSource('openmaptiles')) {
          const beforeLayer = this.map.getLayer('building-3d') ? 'building-3d' : undefined;
          this.map.addLayer({
            id: 'building-clean-2d',
            type: 'fill',
            source: 'openmaptiles',
            'source-layer': 'building',
            minzoom: 13,
            maxzoom: 24,
            paint: {
              'fill-color': '#f5f2eb',
              'fill-opacity': 0.95,
              'fill-outline-color': '#dfd9cd'
            }
          }, beforeLayer);
        }

        // 2. Control 2D and 3D layer visibility & styling
        if (this.map.getLayer('building-clean-2d')) {
          this.map.setLayoutProperty('building-clean-2d', 'visibility', 'visible');
          this.map.setPaintProperty('building-clean-2d', 'fill-color', '#f5f2eb');
          this.map.setPaintProperty('building-clean-2d', 'fill-outline-color', '#dfd9cd');
        }

        if (this.map.getLayer('building-3d')) {
          this.map.setLayoutProperty('building-3d', 'visibility', this.is3D ? 'visible' : 'none');
          if (this.is3D) {
            this.map.setPaintProperty('building-3d', 'fill-extrusion-opacity', 0.72);
            this.map.setPaintProperty('building-3d', 'fill-extrusion-color', '#ede8df');
            this.map.setPaintProperty('building-3d', 'fill-extrusion-height', [
              '*',
              ['coalesce', ['get', 'render_height'], ['get', 'height'], 8],
              0.45
            ]);
            this.map.setPaintProperty('building-3d', 'fill-extrusion-base', [
              '*',
              ['coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0],
              0.45
            ]);
          }
        }

        // 3. Smooth camera pitch transition (0 for 2D, 45 for 3D Heading-Up)
        const targetPitch = (this.is3D && this.isHeadingUp) ? (CONFIG.navigationPitch || 45) : 0;
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
        localStorage.setItem('tesla_map_provider', 'maplibre');
      } catch (e) {}
      const url = new URL(window.location.href);
      url.searchParams.set('provider', 'maplibre');
      window.location.href = url.toString();
      return true;
    }
    this.update3DMode(!this.is3D);
    return this.is3D;
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

  // Snap GPS Coordinate to Active Route Polyline (Map Matching)
  snapToActiveRoute(lat, lng) {
    if (!this.routeCoordinates || this.routeCoordinates.length < 2) {
      return { snapped: false, lat, lng, bearing: null, dist: 0 };
    }

    let minDistance = Infinity;
    let bestPoint = { lat, lng };
    let bestBearing = null;
    let bestSegIndex = 0;

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
    if (minDistance > 45 && searchStart > 0) {
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

    // If within 40m of road centerline -> snap to road
    if (minDistance <= 40) {
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
          const aheadPt = this.getPositionAtDistance(snappedDist + 24);
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
        routeDistance: snappedDist
      };
    }

    return { snapped: false, lat, lng, bearing: null, dist: minDistance, segIndex: bestSegIndex, routeDistance: null };
  }

  // Primary Position Update Handler with Movement Bearing & Road Snapping
  updateCarPosition(lat, lng, rawHeading = 0, speed = 0, isRealFix = true) {
    let targetHeading = this.currentHeading;

    // 1. Calculate Real Movement Bearing from GPS updates
    if (window.IS_SIMULATOR_RUNNING && rawHeading != null && !isNaN(rawHeading)) {
      targetHeading = rawHeading;
    } else if (rawHeading != null && !isNaN(rawHeading) && rawHeading > 0 && speed > 2) {
      targetHeading = rawHeading;
    } else if (isRealFix && this.lastRawPosition) {
      const distMoved = this.calculateDistance(this.lastRawPosition.lat, this.lastRawPosition.lng, lat, lng);
      if (distMoved >= 1.5) {
        targetHeading = this.calculateBearing(this.lastRawPosition.lat, this.lastRawPosition.lng, lat, lng);
        this.lastRawPosition = { lat, lng, time: Date.now() };
      }
    } else if (isRealFix) {
      this.lastRawPosition = { lat, lng, time: Date.now() };
    }

    // 2. Road Snapping (Map Matching)
    let displayLat = lat;
    let displayLng = lng;
    let isOffRoute = false;
    let distToRoute = 0;

    if (this.activeRoute && this.routeCoordinates && this.routeCoordinates.length >= 2) {
      const snap = this.snapToActiveRoute(lat, lng);
      distToRoute = snap.dist;
      if (snap.segIndex != null) {
        this.currentSegIndex = snap.segIndex;
      }
      if (snap.snapped) {
        displayLat = snap.lat;
        displayLng = snap.lng;
        if (snap.bearing !== null) {
          let angleDiff = Math.abs(((targetHeading - snap.bearing) % 360 + 540) % 360 - 180);
          if (angleDiff < 85) {
            targetHeading = snap.bearing;
          }
        }
        if (isRealFix) {
          this.simulatedNavDistance = (snap.routeDistance != null) ? snap.routeDistance : (this.routeCumulativeDistances?.[snap.segIndex] || 0);
        }
      } else if (distToRoute > 45) {
        isOffRoute = true;
      }
    }

    // 3. Smooth Heading with Inertial Angular Rate Limiting
    const angleDiff = ((targetHeading - this.currentHeading) % 360 + 540) % 360 - 180;
    const smoothFactor = window.IS_SIMULATOR_RUNNING ? 0.09 : 0.08;
    let delta = angleDiff * smoothFactor;
    // Physical angular velocity clamp: maximum 1.25 degrees per frame (~75 deg/sec at 60fps)
    const maxAngularStep = 1.25;
    if (delta > maxAngularStep) delta = maxAngularStep;
    if (delta < -maxAngularStep) delta = -maxAngularStep;
    this.currentHeading = (this.currentHeading + delta + 360) % 360;
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

      if (this.followCar) {
        if (!this.isUserPinching) {
          const now = performance.now();
          // Instant lockstep setCenter throttled to 40ms (~25fps)
          // Eliminates easing cancellation hitch and keeps map locked to vehicle with zero jitter!
          if (!this.lastYandexCenterTime || (now - this.lastYandexCenterTime >= 40)) {
            this.lastYandexCenterTime = now;
            this.map.setCenter([displayLat, displayLng], this.navZoom, { duration: 0, checkZoomRange: false });
          }
        }
      }
    } else if (this.carMarker && window.L && this.provider === 'osm') {
      this.carMarker.setLatLng([displayLat, displayLng]);
      const markerEl = document.querySelector('#leaflet-car-marker .tesla-car-arrow');
      if (markerEl) markerEl.style.transform = `rotate(${Math.round(this.currentHeading)}deg)`;
      if (this.followCar && this.map) this.map.setView([displayLat, displayLng], this.map.getZoom(), { animate: false });
    }

    // 5. Track Progress & Check Off-Route Rerouting
    if (this.activeRoute && this.routeSteps.length > 0) {
      this.trackNavigationProgress(displayLat, displayLng, isOffRoute, distToRoute, speed, isRealFix);
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

    // Off-route automatic rerouting: ONLY on genuine GPS fixes, NEVER on dead-reckoning extrapolation!
    if (isRealFix && this.isNavigating && speed >= 5 && isOffRoute && distToRoute > 45) {
      this.offRouteCounter++;
      if (this.offRouteCounter >= 4 && !this.isRerouting) {
        this.recalculateRoute(currentLat, currentLng);
        return;
      }
    } else {
      this.offRouteCounter = Math.max(0, this.offRouteCounter - 1);
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

      // Check distance from Yerevan center to adjust speed limit if outside
      const dLatYerevan = (currentLat - 40.1772) * 111;
      const dLngYerevan = (currentLng - 44.5105) * 85;
      const distFromYerevan = Math.sqrt(dLatYerevan * dLatYerevan + dLngYerevan * dLngYerevan);
      const currentSpeedLimit = activeStep.speedLimit || (distFromYerevan > 14 ? 90 : 60);

      this.onManeuverUpdate({
        distance: this.formatNavDistance(activeDist),
        distanceMeters: activeDist,
        instruction: activeStep.instruction || activeStep.name || 'Двигайтесь прямо',
        street: activeStep.name || activeStep.instruction || dest.name,
        modifier: activeStep.modifier || 'straight',
        type: activeStep.type || 'turn',
        speedLimit: currentSpeedLimit,
        lanes: activeStep.lanes || null
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
            if (mod.includes('left')) phrase = 'dist_250_left';
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

    // 5. Proximity to speed cameras (Only show if camera < 600m, else hide)
    let nearestCameraDist = Infinity;
    const allCameras = [
      ...this.trafficPoints.filter(p => p.type === 'camera'),
      ...(this.specialRoadPoints || []).filter(p => p.type === 'camera' || p.type === 'speed_cam')
    ];

    for (const cam of allCameras) {
      const camLat = cam.lat || cam.location?.[1];
      const camLng = cam.lng || cam.location?.[0];
      if (camLat && camLng) {
        const d = this.calculateDistance(currentLat, currentLng, camLat, camLng);
        if (d < 600 && d < nearestCameraDist) {
          nearestCameraDist = Math.round(d);
        }
      }
    }

    if (nearestCameraDist < 600) {
      this.onCameraAlert({ visible: true, distance: this.formatNavDistance(nearestCameraDist) });
    } else {
      this.onCameraAlert({ visible: false });
    }
  }

  // Automatic Off-Route Rerouting from current road
  async recalculateRoute(lat, lng) {
    if (!this.activeRoute || !this.activeRoute.destination || this.isRerouting) return;
    this.isRerouting = true;
    console.log('[MapEngine] Deviated from route. Recalculating from current road...');
    const lang = window.CURRENT_LANG || 'ru';
    const dict = I18N[lang] || I18N.ru;
    this.speakVoice(dict.voiceRerouting || 'Перестраиваю маршрут');

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
      }, 3500);
    }
  }

  getTurnSpeech(modifier) {
    const lang = window.CURRENT_LANG || 'ru';
    const dict = I18N[lang] || I18N.ru;
    if (modifier && modifier.includes('left')) return dict.voiceTurnLeft;
    if (modifier && modifier.includes('right')) return dict.voiceTurnRight;
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

  // Parse Yandex or OSRM route data and render on map
  applyRouteData(data, destination) {
    this.rawRouteData = data;
    const isYandex = data.source === 'yandex';
    const primaryRoute = data.routes[0];
    const coordinates = isYandex ? primaryRoute.coordinates : primaryRoute.geometry.coordinates; // [lng, lat]
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

    // Alternative Route
    this.hasAlternative = data.routes.length > 1;
    this.alternativeRoute = this.hasAlternative ? data.routes[1] : null;
    this.alternativeCoordinates = this.hasAlternative
      ? (isYandex ? this.alternativeRoute.coordinates : this.alternativeRoute.geometry.coordinates)
      : null;

    // Traffic segments (100% genuine Yandex real-time traffic colors)
    const trafficSegments = isYandex ? primaryRoute.segments : null;

    // Parse navigation steps
    this.routeSteps = [];
    this.currentStepIndex = 0;
    this.spokenDistanceThresholds = {};
    this.specialRoadPoints = primaryRoute.specialRoadPoints || [];
    this.activeRoute = { destination, durationSec, distanceMeters };

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
        this.routeSteps.push({
          name: step.name || destination.name,
          instruction: `${maneuver.type || ''} ${maneuver.modifier || ''}`.trim(),
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

    // 1. Render on MAPLIBRE GL JS
    if (this.provider === 'maplibre' && this.map) {
      this.renderMapLibreRoute(coordinates, destination, this.alternativeCoordinates, trafficSegments);
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

    // Parse alternative info
    let altInfo = null;
    if (this.hasAlternative && this.alternativeRoute) {
      const altDurationSec = this.alternativeRoute.duration;
      const altDistMeters = this.alternativeRoute.distance;
      const diffMins = Math.round((altDurationSec - durationSec) / 60);
      const diffSign = diffMins >= 0 ? `+${diffMins}` : `${diffMins}`;
      altInfo = {
        name: this.alternativeRoute.legs && this.alternativeRoute.legs[0]?.summary ? `через ${this.alternativeRoute.legs[0].summary}` : 'Альтернативный маршрут',
        duration: `${Math.round(altDurationSec / 60)} мин`,
        distance: altDistMeters >= 1000 ? `${(altDistMeters / 1000).toFixed(1)} км` : `${Math.round(altDistMeters)} м`,
        diffMins: diffSign
      };
    }

    const routeInfo = {
      distance: distanceMeters >= 1000 ? `${(distanceMeters / 1000).toFixed(1)} км` : `${Math.round(distanceMeters)} м`,
      duration: `${Math.round(durationSec / 60)} мин`,
      eta: `${etaHours}:${etaMins}`,
      name: destination.name || 'Маршрут',
      steps: this.routeSteps,
      trafficSegments: (trafficSegments && trafficSegments.length > 0) ? trafficSegments : this.generateTrafficSegments(coordinates)
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
        const routeInfo = this.applyRouteData(data, destination);
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
    if (!this.rawRouteData || !this.rawRouteData.routes[index]) return;
    const selected = this.rawRouteData.routes[index];
    const other = this.rawRouteData.routes[index === 0 ? 1 : 0];

    // Swap
    this.rawRouteData.routes = [selected, other].filter(Boolean);
    const routeInfo = this.applyRouteData(this.rawRouteData, this.activeRoute.destination);
    if (routeInfo) {
      this.onRouteCalculated(routeInfo);
    }
  }

  // Render Route on MapLibre GL with Yandex Navigator Styling & Alternative Blue Route
  renderMapLibreRoute(coordinates, destination, alternativeCoordinates = null, trafficSegments = null) {
    // Clear old layers
    if (this.map.getLayer('route-alt-casing')) this.map.removeLayer('route-alt-casing');
    if (this.map.getLayer('route-alt-line')) this.map.removeLayer('route-alt-line');
    if (this.map.getSource('route-alt')) this.map.removeSource('route-alt');

    if (this.map.getLayer('route-casing')) this.map.removeLayer('route-casing');
    for (let i = 0; i < 200; i++) {
      if (this.map.getLayer(`route-seg-${i}`)) this.map.removeLayer(`route-seg-${i}`);
      if (this.map.getSource(`route-seg-${i}`)) this.map.removeSource(`route-seg-${i}`);
    }
    if (this.map.getSource('route-full')) this.map.removeSource('route-full');

    // 1. Alternative Route (Cyan Blue line underneath, like Mapsev & Yandex)
    if (alternativeCoordinates && alternativeCoordinates.length > 0) {
      this.map.addSource('route-alt', {
        type: 'geojson',
        data: {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: alternativeCoordinates }
        }
      });

      this.map.addLayer({
        id: 'route-alt-casing',
        type: 'line',
        source: 'route-alt',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#0f172a',
          'line-width': 8,
          'line-opacity': 0.8
        }
      });

      this.map.addLayer({
        id: 'route-alt-line',
        type: 'line',
        source: 'route-alt',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#0284c7', // Vibrant Sky/Cyan Blue
          'line-width': 5.5,
          'line-opacity': 0.85
        }
      });
    }

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

    // 3.5. Traveled Route Line (Dimmed slate gray, rendered on top of traffic segments)
    if (this.map.getLayer('route-traveled-line')) this.map.removeLayer('route-traveled-line');
    if (this.map.getSource('route-traveled')) this.map.removeSource('route-traveled');

    this.map.addSource('route-traveled', {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [] }
      }
    });

    this.map.addLayer({
      id: 'route-traveled-line',
      type: 'line',
      source: 'route-traveled',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#94a3b8',
        'line-width': 8.5,
        'line-opacity': 0.85
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
      strokeWidth: 8.5,
      strokeOpacity: 0.85
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
    this.lastProgressIndex = 0;
    this.routeCoordinates = [];
    this.alternativeCoordinates = null;
    this.routeSteps = [];
    this.currentStepIndex = 0;
    this.totalDistance = 0;
    this.specialRoadPoints = [];

    if (this.provider === 'maplibre' && this.map) {
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

