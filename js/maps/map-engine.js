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
    
    this.map = null;
    this.carMarker = null;
    this.destMarker = null;
    this.trafficLightMarkers = [];
    this.cameraMarkers = [];
    this.routePolyline = null;
    this.followCar = true;
    this.isHeadingUp = true; // True = map turns with car, False = North-up
    this.is3D = false; // Default clean flat 2D like Mapsev & Yandex Navigator
    this.voiceEnabled = true;

    this.currentPosition = { lat: this.center.lat, lng: this.center.lng, heading: 0, speed: 0 };
    this.activeRoute = null;
    this.routeSteps = [];
    this.currentStepIndex = 0;
    this.totalDistance = 0;
    this.spokenDistanceThresholds = {};

    // Yerevan Key Traffic Lights & Speed Cameras (Sample coordinates around Center/Arabkir/Ajapnyak)
    this.trafficPoints = [
      { type: 'light', lat: 40.1898, lng: 44.4695, name: 'Leningradian / Kerkorian' },
      { type: 'camera', lat: 40.1915, lng: 44.4735, name: 'Speed Cam 60' },
      { type: 'light', lat: 40.1930, lng: 44.4840, name: 'Kievyan Bridge' },
      { type: 'camera', lat: 40.1955, lng: 44.4880, name: 'Speed Cam 60' },
      { type: 'light', lat: 40.1982, lng: 44.4928, name: 'Barekamutyun Square' },
      { type: 'light', lat: 40.1988, lng: 44.4935, name: 'Hakob Hakobyan St' },
      { type: 'camera', lat: 40.1830, lng: 44.4780, name: 'Monte Melkonyan Cam' },
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
  }

  // 1. MapLibre GL Clean Vector Map (No bulky 3D extruded blocks, fluid touch gestures)
  async initMapLibre() {
    return new Promise((resolve) => {
      this.map = new window.maplibregl.Map({
        container: this.containerId,
        style: CONFIG.maplibreStyle || 'https://tiles.openfreemap.org/styles/liberty',
        center: [this.center.lng, this.center.lat],
        zoom: this.navZoom,
        pitch: 0, // Clean flat 2D like Mapsev & Yandex Navigator
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

      // Detect manual user touch/pan to show Recenter button
      this.map.on('dragstart', () => {
        this.followCar = false;
        this.onUserPan();
      });
      this.map.on('rotatestart', () => {
        this.followCar = false;
        this.onUserPan();
      });
      this.map.on('zoomstart', () => {
        this.followCar = false;
        this.onUserPan();
      });

      this.map.on('load', () => {
        // Remove/hide bulky 3D extruded building blocks so map stays completely clean & unobstructed
        try {
          const layers = this.map.getStyle().layers || [];
          layers.forEach(layer => {
            if (layer.type === 'fill-extrusion' || layer.id.includes('3d') || layer.id.includes('building-extrusion')) {
              this.map.setLayoutProperty(layer.id, 'visibility', 'none');
            }
          });
        } catch (e) {
          console.warn('Building 3d hide error:', e);
        }

        // Render Traffic Lights and Speed Cameras
        this.renderTrafficPoints();

        // High-Visibility 3D Arrow Vehicle Marker (Red chevron matching Mapsev & Yandex)
        const el = document.createElement('div');
        el.id = 'maplibre-car-marker';
        el.className = 'tesla-3d-car-marker';
        el.innerHTML = `
          <div class="tesla-car-pulse"></div>
          <div class="tesla-car-arrow" style="transform: rotate(0deg);">
            <svg viewBox="0 0 54 54" width="52" height="52">
              <defs>
                <filter id="car-shadow" x="-30%" y="-30%" width="160%" height="160%">
                  <feDropShadow dx="0" dy="3" stdDeviation="3.5" flood-color="#000" flood-opacity="0.6"/>
                </filter>
              </defs>
              <polygon points="27,4 49,46 27,35 5,46" fill="#ef4444" stroke="#ffffff" stroke-width="3.5" stroke-linejoin="round" filter="url(#car-shadow)"/>
              <circle cx="27" cy="26" r="3.5" fill="#ffffff" />
            </svg>
          </div>
        `;

        this.carMarker = new window.maplibregl.Marker({
          element: el,
          anchor: 'center',
          rotationAlignment: 'map'
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

  // Render Traffic Lights (🚦) and Cameras (📷) on the map
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
        el.className = 'speed-cam-icon-pin';
        el.innerHTML = `<div class="cam-box">📷</div>`;
        const marker = new window.maplibregl.Marker({ element: el })
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
          yandexMapDisablePoiInteractivity: true
        });

        try {
          this.trafficLayer = new window.ymaps.control.TrafficControl({
            state: { providerKey: 'traffic#actual', trafficShown: true }
          });
          this.map.controls.add(this.trafficLayer);
        } catch (e) {}

        const CarLayout = window.ymaps.templateLayoutFactory.createClass(
          `<div id="yandex-car-marker" class="tesla-3d-car-marker">
            <div class="tesla-car-pulse"></div>
            <div class="tesla-car-arrow" style="transform: rotate(0deg);">
              <svg viewBox="0 0 54 54" width="52" height="52">
                <polygon points="27,4 49,46 27,35 5,46" fill="#ef4444" stroke="#ffffff" stroke-width="3.5" stroke-linejoin="round"/>
                <circle cx="27" cy="26" r="3.5" fill="#ffffff" />
              </svg>
            </div>
          </div>`
        );

        this.carMarker = new window.ymaps.Placemark([this.center.lat, this.center.lng], {}, {
          iconLayout: CarLayout,
          iconImageSize: [52, 52],
          iconImageOffset: [-26, -26]
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

      window.L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        subdomains: 'abcd'
      }).addTo(this.map);

      const carIcon = window.L.divIcon({
        className: 'tesla-car-marker-container',
        html: `
          <div id="leaflet-car-marker" class="tesla-3d-car-marker">
            <div class="tesla-car-pulse"></div>
            <div class="tesla-car-arrow" style="transform: rotate(0deg);">
              <svg viewBox="0 0 54 54" width="52" height="52">
                <polygon points="27,4 49,46 27,35 5,46" fill="#ef4444" stroke="#ffffff" stroke-width="3.5" stroke-linejoin="round"/>
                <circle cx="27" cy="26" r="3.5" fill="#ffffff" />
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

  // Recenter map back onto vehicle & re-enable auto-follow
  recenter() {
    this.followCar = true;
    if (this.provider === 'maplibre' && this.map) {
      this.map.easeTo({
        center: [this.currentPosition.lng, this.currentPosition.lat],
        zoom: this.navZoom,
        bearing: this.isHeadingUp ? this.currentPosition.heading : 0,
        pitch: 0,
        duration: 500
      });
    } else if (this.provider === 'yandex' && this.map) {
      this.map.panTo([this.currentPosition.lat, this.currentPosition.lng], { duration: 400 });
    } else if (this.map) {
      this.map.panTo([this.currentPosition.lat, this.currentPosition.lng]);
    }
  }

  // Toggle Heading-Up Driving View vs North-Up Overview
  toggleHeadingUp() {
    this.isHeadingUp = !this.isHeadingUp;
    if (this.provider === 'maplibre' && this.map) {
      if (this.isHeadingUp) {
        this.map.easeTo({
          center: [this.currentPosition.lng, this.currentPosition.lat],
          bearing: this.currentPosition.heading,
          pitch: 0,
          duration: 500
        });
      } else {
        this.map.easeTo({
          center: [this.currentPosition.lng, this.currentPosition.lat],
          bearing: 0,
          pitch: 0,
          duration: 500
        });
      }
    }
    return this.isHeadingUp;
  }

  // Toggle Voice Sound On/Off
  toggleVoice() {
    this.voiceEnabled = !this.voiceEnabled;
    if (!this.voiceEnabled && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    return this.voiceEnabled;
  }

  // Primary Position Update Handler
  updateCarPosition(lat, lng, heading = 0, speed = 0) {
    this.currentPosition = { lat, lng, heading, speed };

    if (this.provider === 'maplibre' && this.map) {
      if (this.carMarker) {
        this.carMarker.setLngLat([lng, lat]);
      }

      const markerEl = document.querySelector('#maplibre-car-marker .tesla-car-arrow');
      if (this.isHeadingUp) {
        // Heading-Up: Arrow points UP, map rotates around car
        if (markerEl) markerEl.style.transform = `rotate(0deg)`;
        if (this.followCar) {
          this.map.easeTo({
            center: [lng, lat],
            bearing: heading,
            pitch: 0,
            duration: 350,
            easing: (t) => t
          });
        }
      } else {
        // North-Up: Map fixed to North, arrow rotates
        if (markerEl) markerEl.style.transform = `rotate(${heading}deg)`;
        if (this.followCar) {
          this.map.easeTo({
            center: [lng, lat],
            bearing: 0,
            pitch: 0,
            duration: 350,
            easing: (t) => t
          });
        }
      }
    } else if (this.provider === 'yandex' && this.carMarker && this.map) {
      this.carMarker.geometry.setCoordinates([lat, lng]);
      const markerEl = document.querySelector('#yandex-car-marker .tesla-car-arrow');
      if (markerEl) markerEl.style.transform = `rotate(${heading}deg)`;
      if (this.followCar) this.map.panTo([lat, lng], { duration: 300, flying: false });
    } else if (this.carMarker && window.L && this.provider === 'osm') {
      this.carMarker.setLatLng([lat, lng]);
      const markerEl = document.querySelector('#leaflet-car-marker .tesla-car-arrow');
      if (markerEl) markerEl.style.transform = `rotate(${heading}deg)`;
      if (this.followCar && this.map) this.map.panTo([lat, lng], { animate: true, duration: 0.3 });
    }

    if (this.activeRoute && this.routeSteps.length > 0) {
      this.trackNavigationProgress(lat, lng);
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

  trackNavigationProgress(currentLat, currentLng) {
    if (!this.activeRoute) return;

    const dest = this.activeRoute.destination;
    const distToDest = this.calculateDistance(currentLat, currentLng, dest.lat, dest.lng);

    // Update bottom traffic progress bar cursor
    if (this.totalDistance > 0) {
      const remainingRatio = Math.max(0, Math.min(1, distToDest / this.totalDistance));
      const progressPercent = Math.round((1 - remainingRatio) * 100);
      this.onProgressUpdate(progressPercent);
    }

    // Destination Arrival
    if (distToDest < 25) {
      this.speakVoice(I18N[window.CURRENT_LANG || 'ru'].voiceArrived);
      this.onArrival(dest);
      this.cancelRoute();
      return;
    }

    // Maneuver advancement
    if (this.currentStepIndex < this.routeSteps.length) {
      const step = this.routeSteps[this.currentStepIndex];
      const stepDist = this.calculateDistance(currentLat, currentLng, step.location[1], step.location[0]);

      if (stepDist < 25 && this.currentStepIndex < this.routeSteps.length - 1) {
        this.currentStepIndex++;
        this.spokenDistanceThresholds = {};
      }

      const activeStep = this.routeSteps[this.currentStepIndex];
      const activeDist = Math.round(this.calculateDistance(currentLat, currentLng, activeStep.location[1], activeStep.location[0]));

      this.onManeuverUpdate({
        distance: activeDist < 1000 ? `${activeDist} м` : `${(activeDist / 1000).toFixed(1)} км`,
        distanceMeters: activeDist,
        instruction: activeStep.name || activeStep.instruction,
        modifier: activeStep.modifier || 'straight',
        type: activeStep.type || 'turn',
        lanes: activeStep.lanes || null
      });

      // Voice announcements at 250m and 50m
      if (this.voiceEnabled) {
        if (activeDist <= 260 && activeDist >= 200 && !this.spokenDistanceThresholds['250']) {
          this.spokenDistanceThresholds['250'] = true;
          this.speakVoice(`${this.getTurnSpeech(activeStep.modifier)} через 250 метров`);
        } else if (activeDist <= 70 && activeDist >= 30 && !this.spokenDistanceThresholds['50']) {
          this.spokenDistanceThresholds['50'] = true;
          this.speakVoice(this.getTurnSpeech(activeStep.modifier));
        }
      }
    }
  }

  getTurnSpeech(modifier) {
    const lang = window.CURRENT_LANG || 'ru';
    const dict = I18N[lang] || I18N.ru;
    if (modifier && modifier.includes('left')) return dict.voiceTurnLeft;
    if (modifier && modifier.includes('right')) return dict.voiceTurnRight;
    return dict.voiceStraight;
  }

  speakVoice(text) {
    if (!this.voiceEnabled || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.05;
      const lang = window.CURRENT_LANG || 'ru';
      if (lang === 'hy') utterance.lang = 'hy-AM';
      else if (lang === 'en') utterance.lang = 'en-US';
      else utterance.lang = 'ru-RU';
      window.speechSynthesis.speak(utterance);
    } catch (e) {
      console.warn('SpeechSynthesis error:', e);
    }
  }

  // Generate Yandex Navigator-style traffic colored segments
  // Emerald Green (#22c55e), Yellow/Amber (#f59e0b), Bright Red (#ef4444), Dark Burgundy (#991b1b)
  generateTrafficSegments(coordinates) {
    const total = coordinates.length;
    if (total < 4) {
      return [{ coords: coordinates, color: '#22c55e' }];
    }

    const idx1 = Math.floor(total * 0.35);
    const idx2 = Math.floor(total * 0.60);
    const idx3 = Math.floor(total * 0.85);

    return [
      { coords: coordinates.slice(0, idx1 + 1), color: '#22c55e' }, // Emerald Green (Free)
      { coords: coordinates.slice(idx1, idx2 + 1), color: '#f59e0b' }, // Amber/Yellow (Moderate)
      { coords: coordinates.slice(idx2, idx3 + 1), color: '#ef4444' }, // Bright Red (Heavy)
      { coords: coordinates.slice(idx3), color: '#22c55e' }            // Approach Green
    ].filter(s => s.coords.length >= 2);
  }

  // Route calculation and drawing with Yandex Navigator styling
  async buildRouteTo(destination) {
    this.activeRoute = { destination };
    const start = [this.currentPosition.lat, this.currentPosition.lng];
    const end = [destination.lat, destination.lng];

    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${start[1]},${start[0]};${end[1]},${end[0]}?overview=full&geometries=geojson&steps=true`;
      const res = await fetch(url);
      const data = await res.json();

      if (data.routes && data.routes.length > 0) {
        const primaryRoute = data.routes[0];
        const coordinates = primaryRoute.geometry.coordinates; // [lng, lat]
        const durationSec = primaryRoute.duration;
        const distanceMeters = primaryRoute.distance;
        this.totalDistance = distanceMeters;

        // Parse navigation steps
        this.routeSteps = [];
        this.currentStepIndex = 0;
        this.spokenDistanceThresholds = {};

        if (primaryRoute.legs && primaryRoute.legs.length > 0) {
          primaryRoute.legs[0].steps.forEach(step => {
            const maneuver = step.maneuver || {};
            this.routeSteps.push({
              name: step.name || destination.name,
              instruction: `${maneuver.type || ''} ${maneuver.modifier || ''}`.trim(),
              type: maneuver.type,
              modifier: maneuver.modifier,
              location: maneuver.location,
              distance: step.distance,
              lanes: (step.intersections && step.intersections[0] && step.intersections[0].lanes) ? step.intersections[0].lanes : null
            });
          });
        }

        // 1. Render on MAPLIBRE GL JS
        if (this.provider === 'maplibre' && this.map) {
          this.renderMapLibreRoute(coordinates, destination);
        }
        // 2. Render on YANDEX MAPS
        else if (this.provider === 'yandex' && this.map && window.ymaps) {
          this.renderYandexRoute(coordinates.map(c => [c[1], c[0]]), destination);
        }
        // 3. Render on LEAFLET
        else if (this.map && window.L) {
          this.renderLeafletRoute(coordinates.map(c => [c[1], c[0]]), destination);
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
          steps: this.routeSteps
        };

        this.onRouteCalculated(routeInfo);
        return routeInfo;
      }
    } catch (err) {
      console.error('[MapEngine] Route error:', err);
    }
    return null;
  }

  // Render Route on MapLibre GL with Yandex Navigator Styling
  renderMapLibreRoute(coordinates, destination) {
    // Clear old layers
    if (this.map.getLayer('route-casing')) this.map.removeLayer('route-casing');
    for (let i = 0; i < 8; i++) {
      if (this.map.getLayer(`route-seg-${i}`)) this.map.removeLayer(`route-seg-${i}`);
      if (this.map.getSource(`route-seg-${i}`)) this.map.removeSource(`route-seg-${i}`);
    }
    if (this.map.getSource('route-full')) this.map.removeSource('route-full');

    // 1. Full Line Source for Dark Navy Casing
    this.map.addSource('route-full', {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates }
      }
    });

    // Dark Navy Under-Casing (gives high contrast like Yandex Navigator)
    this.map.addLayer({
      id: 'route-casing',
      type: 'line',
      source: 'route-full',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#0f172a',
        'line-width': 10,
        'line-opacity': 0.95
      }
    });

    // 2. Colored Traffic Segments (Green, Amber, Red)
    const segments = this.generateTrafficSegments(coordinates);
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
          'line-width': 7,
          'line-opacity': 1.0
        }
      });
    });

    // 3. Destination Pin (Yandex-style Black/White destination target circle)
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

  renderYandexRoute(latLngs, destination) {
    if (this.routePolyline) this.map.geoObjects.remove(this.routePolyline);
    if (this.destMarker) this.map.geoObjects.remove(this.destMarker);

    this.routePolyline = new window.ymaps.GeoObjectCollection();
    this.routePolyline.add(new window.ymaps.Polyline(latLngs, {}, {
      strokeColor: '#0f172a',
      strokeWidth: 10,
      strokeOpacity: 0.95
    }));

    const segments = this.generateTrafficSegments(latLngs);
    segments.forEach(seg => {
      this.routePolyline.add(new window.ymaps.Polyline(seg.coords, {}, {
        strokeColor: seg.color,
        strokeWidth: 7,
        strokeOpacity: 1.0
      }));
    });

    this.map.geoObjects.add(this.routePolyline);

    this.destMarker = new window.ymaps.Placemark([destination.lat, destination.lng], {
      hintContent: destination.name || 'Пункт назначения'
    }, {
      preset: 'islands#redDotIconWithCaption'
    });
    this.map.geoObjects.add(this.destMarker);
  }

  renderLeafletRoute(latLngs, destination) {
    if (this.routePolyline) this.map.removeLayer(this.routePolyline);
    if (this.destMarker) this.map.removeLayer(this.destMarker);

    this.routePolyline = window.L.featureGroup();
    this.routePolyline.addLayer(window.L.polyline(latLngs, {
      color: '#0f172a',
      weight: 10,
      opacity: 0.95,
      lineCap: 'round',
      lineJoin: 'round'
    }));

    const segments = this.generateTrafficSegments(latLngs);
    segments.forEach(seg => {
      this.routePolyline.addLayer(window.L.polyline(seg.coords, {
        color: seg.color,
        weight: 7,
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

  cancelRoute() {
    this.activeRoute = null;
    this.routeSteps = [];
    this.currentStepIndex = 0;
    this.totalDistance = 0;

    if (this.provider === 'maplibre' && this.map) {
      if (this.map.getLayer('route-casing')) this.map.removeLayer('route-casing');
      if (this.map.getSource('route-full')) this.map.removeSource('route-full');
      for (let i = 0; i < 8; i++) {
        if (this.map.getLayer(`route-seg-${i}`)) this.map.removeLayer(`route-seg-${i}`);
        if (this.map.getSource(`route-seg-${i}`)) this.map.removeSource(`route-seg-${i}`);
      }
      if (this.destMarker) {
        this.destMarker.remove();
        this.destMarker = null;
      }
    } else if (this.provider === 'yandex' && this.map) {
      if (this.routePolyline) this.map.geoObjects.remove(this.routePolyline);
      if (this.destMarker) this.map.geoObjects.remove(this.destMarker);
      this.routePolyline = null;
      this.destMarker = null;
    } else if (this.map) {
      if (this.routePolyline) this.map.removeLayer(this.routePolyline);
      if (this.destMarker) this.map.removeLayer(this.destMarker);
      this.routePolyline = null;
      this.destMarker = null;
    }
  }
}
