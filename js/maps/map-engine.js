// Tesla Navi Advanced 3D Map Engine (MapLibre GL Vector + Yandex & OSM Fallbacks)

class TeslaMapEngine {
  constructor(containerId, options = {}) {
    this.containerId = containerId;
    this.provider = options.provider || CONFIG.defaultProvider || 'maplibre'; // 'maplibre' | 'yandex' | 'osm'
    this.center = options.center || CONFIG.defaultCenter;
    this.navZoom = CONFIG.navigationZoom || 16.5;
    this.navPitch = CONFIG.navigationPitch || 55;
    this.onRouteCalculated = options.onRouteCalculated || (() => {});
    this.onArrival = options.onArrival || (() => {});
    this.onManeuverUpdate = options.onManeuverUpdate || (() => {});
    
    this.map = null;
    this.carMarker = null;
    this.destMarker = null;
    this.routePolyline = null; // For Yandex / Leaflet
    this.trafficEnabled = true;
    this.followCar = true;
    this.isHeadingUp = true; // True = map turns with car, False = North-up
    this.is3D = true;
    this.voiceEnabled = true;

    this.currentPosition = { lat: this.center.lat, lng: this.center.lng, heading: 0, speed: 0 };
    this.activeRoute = null;
    this.routeSteps = [];
    this.currentStepIndex = 0;
    this.lastSpokenStepIndex = -1;
    this.spokenDistanceThresholds = {};
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

  // 1. MapLibre GL 3D Vector Map Implementation (Primary Automotive Engine)
  async initMapLibre() {
    return new Promise((resolve) => {
      this.map = new window.maplibregl.Map({
        container: this.containerId,
        style: CONFIG.maplibreStyle || 'https://tiles.openfreemap.org/styles/liberty',
        center: [this.center.lng, this.center.lat],
        zoom: this.navZoom,
        pitch: this.is3D ? this.navPitch : 0,
        bearing: 0,
        attributionControl: false,
        fadeDuration: 0
      });

      this.map.on('load', () => {
        // Vehicle Navigation Marker (Red 3D Chevron matching Mapsev IMG_3650 / IMG_3659)
        const el = document.createElement('div');
        el.id = 'maplibre-car-marker';
        el.className = 'tesla-3d-car-marker';
        el.innerHTML = `
          <div class="tesla-car-pulse"></div>
          <div class="tesla-car-arrow" style="transform: rotate(0deg);">
            <svg viewBox="0 0 54 54" width="54" height="54">
              <defs>
                <filter id="car-shadow" x="-30%" y="-30%" width="160%" height="160%">
                  <feDropShadow dx="0" dy="4" stdDeviation="4" flood-color="#000" flood-opacity="0.6"/>
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
          const compassArrow = document.getElementById('compass-needle');
          if (compassArrow) {
            compassArrow.style.transform = `rotate(${-bearing}deg)`;
          }
        });

        resolve();
      });
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

        // Traffic Control Layer
        try {
          this.trafficLayer = new window.ymaps.control.TrafficControl({
            state: { providerKey: 'traffic#actual', trafficShown: true }
          });
          this.map.controls.add(this.trafficLayer);
          setTimeout(() => {
            try {
              if (this.trafficLayer && this.trafficLayer.showTraffic) {
                this.trafficLayer.showTraffic();
              }
            } catch (e) {}
          }, 800);
        } catch (e) {}

        const CarLayout = window.ymaps.templateLayoutFactory.createClass(
          `<div id="yandex-car-marker" class="tesla-3d-car-marker">
            <div class="tesla-car-pulse"></div>
            <div class="tesla-car-arrow" style="transform: rotate(0deg);">
              <svg viewBox="0 0 54 54" width="54" height="54">
                <polygon points="27,4 49,46 27,35 5,46" fill="#ef4444" stroke="#ffffff" stroke-width="3.5" stroke-linejoin="round"/>
                <circle cx="27" cy="26" r="3.5" fill="#ffffff" />
              </svg>
            </div>
          </div>`
        );

        this.carMarker = new window.ymaps.Placemark([this.center.lat, this.center.lng], {}, {
          iconLayout: CarLayout,
          iconImageSize: [54, 54],
          iconImageOffset: [-27, -27]
        });

        this.map.geoObjects.add(this.carMarker);
        resolve();
      });
    });
  }

  // 3. Leaflet / Carto OSM Implementation
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
              <svg viewBox="0 0 54 54" width="54" height="54">
                <polygon points="27,4 49,46 27,35 5,46" fill="#ef4444" stroke="#ffffff" stroke-width="3.5" stroke-linejoin="round"/>
                <circle cx="27" cy="26" r="3.5" fill="#ffffff" />
              </svg>
            </div>
          </div>`,
        iconSize: [54, 54],
        iconAnchor: [27, 27]
      });

      this.carMarker = window.L.marker([this.center.lat, this.center.lng], { icon: carIcon }).addTo(this.map);
      resolve();
    });
  }

  // Switch between MapLibre (3D vector), Yandex, and OSM
  async switchProvider(newProvider) {
    if (this.provider === newProvider) return;
    this.provider = newProvider;
    await this.init();
    this.updateCarPosition(
      this.currentPosition.lat,
      this.currentPosition.lng,
      this.currentPosition.heading,
      this.currentPosition.speed
    );
    if (this.activeRoute) {
      await this.buildRouteTo(this.activeRoute.destination);
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
          pitch: this.is3D ? this.navPitch : 0,
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

  // Toggle 3D Perspective Pitch
  toggle3D() {
    this.is3D = !this.is3D;
    if (this.provider === 'maplibre' && this.map) {
      this.map.easeTo({
        pitch: this.is3D ? this.navPitch : 0,
        duration: 400
      });
    }
    return this.is3D;
  }

  // Recenter map on vehicle
  recenter() {
    this.followCar = true;
    if (this.provider === 'maplibre' && this.map) {
      this.map.easeTo({
        center: [this.currentPosition.lng, this.currentPosition.lat],
        zoom: this.navZoom,
        bearing: this.isHeadingUp ? this.currentPosition.heading : 0,
        pitch: this.is3D ? this.navPitch : 0,
        duration: 500
      });
    } else if (this.provider === 'yandex' && this.map) {
      this.map.panTo([this.currentPosition.lat, this.currentPosition.lng], { duration: 400 });
    } else if (this.map) {
      this.map.panTo([this.currentPosition.lat, this.currentPosition.lng]);
    }
  }

  // Primary Position Update Handler (Direct In-Tesla GPS or Phone Remote)
  updateCarPosition(lat, lng, heading = 0, speed = 0) {
    this.currentPosition = { lat, lng, heading, speed };

    // 1. MapLibre GL 3D Navigation with Smooth Rotation
    if (this.provider === 'maplibre' && this.map) {
      if (this.carMarker) {
        this.carMarker.setLngLat([lng, lat]);
      }

      const markerEl = document.querySelector('#maplibre-car-marker .tesla-car-arrow');
      if (this.isHeadingUp) {
        // In heading-up mode: The car arrow points directly UP on the screen
        if (markerEl) markerEl.style.transform = `rotate(0deg)`;
        if (this.followCar) {
          this.map.easeTo({
            center: [lng, lat],
            bearing: heading,
            pitch: this.is3D ? this.navPitch : 0,
            duration: 400,
            easing: (t) => t
          });
        }
      } else {
        // In North-Up mode: Map points North, arrow rotates to heading
        if (markerEl) markerEl.style.transform = `rotate(${heading}deg)`;
        if (this.followCar) {
          this.map.easeTo({
            center: [lng, lat],
            bearing: 0,
            pitch: this.is3D ? 30 : 0,
            duration: 400,
            easing: (t) => t
          });
        }
      }
    }
    // 2. Yandex Maps
    else if (this.provider === 'yandex' && this.carMarker && this.map) {
      this.carMarker.geometry.setCoordinates([lat, lng]);
      const markerEl = document.querySelector('#yandex-car-marker .tesla-car-arrow');
      if (markerEl) {
        markerEl.style.transform = `rotate(${heading}deg)`;
      }
      if (this.followCar) {
        this.map.panTo([lat, lng], { duration: 300, flying: false });
      }
    }
    // 3. Leaflet
    else if (this.carMarker && window.L && this.provider === 'osm') {
      this.carMarker.setLatLng([lat, lng]);
      const markerEl = document.querySelector('#leaflet-car-marker .tesla-car-arrow');
      if (markerEl) {
        markerEl.style.transform = `rotate(${heading}deg)`;
      }
      if (this.followCar && this.map) {
        this.map.panTo([lat, lng], { animate: true, duration: 0.3 });
      }
    }

    // Active Navigation Tracking & Turn Announcements
    if (this.activeRoute && this.routeSteps.length > 0) {
      this.trackNavigationProgress(lat, lng);
    }
  }

  // Calculate distance between two lat/lng points in meters
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth radius in meters
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const dPhi = ((lat2 - lat1) * Math.PI) / 180;
    const dLambda = ((lon2 - lon1) * Math.PI) / 180;

    const a = Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
              Math.cos(phi1) * Math.cos(phi2) *
              Math.sin(dLambda / 2) * Math.sin(dLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }

  // Track progress along active route, advance steps, and announce maneuvers
  trackNavigationProgress(currentLat, currentLng) {
    if (!this.activeRoute) return;

    // Check distance to final destination
    const dest = this.activeRoute.destination;
    const distToDest = this.calculateDistance(currentLat, currentLng, dest.lat, dest.lng);

    if (distToDest < 25) {
      // ARRIVAL!
      this.speakVoice(I18N[window.CURRENT_LANG || 'ru'].voiceArrived);
      this.onArrival(dest);
      this.cancelRoute();
      return;
    }

    // Find current active step
    if (this.currentStepIndex < this.routeSteps.length) {
      const step = this.routeSteps[this.currentStepIndex];
      const stepDist = this.calculateDistance(currentLat, currentLng, step.location[1], step.location[0]);

      // If passed the turn (within 20m), advance to next step
      if (stepDist < 20 && this.currentStepIndex < this.routeSteps.length - 1) {
        this.currentStepIndex++;
        this.spokenDistanceThresholds = {};
      }

      const activeStep = this.routeSteps[this.currentStepIndex];
      const activeDist = Math.round(this.calculateDistance(currentLat, currentLng, activeStep.location[1], activeStep.location[0]));

      // Update maneuver HUD
      this.onManeuverUpdate({
        distance: activeDist < 1000 ? `${activeDist} м` : `${(activeDist / 1000).toFixed(1)} км`,
        distanceMeters: activeDist,
        instruction: activeStep.name || activeStep.instruction,
        modifier: activeStep.modifier || 'straight',
        type: activeStep.type || 'turn',
        lanes: activeStep.lanes || null
      });

      // Voice announcements at 250m and 60m
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
    if (!('speechSynthesis' in window)) return;
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

  // Generate traffic-colored segments along route coordinates
  generateTrafficSegments(coordinates) {
    const total = coordinates.length;
    if (total < 4) {
      return [{ coords: coordinates, color: '#007aff' }];
    }

    // Free-flow: #10b981 (green) or #007aff (blue)
    // Moderate: #f59e0b (amber/yellow)
    // Heavy: #ef4444 (red)
    // Congested: #7f1d1d (dark burgundy)
    const idx1 = Math.floor(total * 0.40);
    const idx2 = Math.floor(total * 0.65);
    const idx3 = Math.floor(total * 0.85);

    return [
      { coords: coordinates.slice(0, idx1 + 1), color: '#10b981' }, // Free-flow green
      { coords: coordinates.slice(idx1, idx2 + 1), color: '#f59e0b' }, // Moderate amber
      { coords: coordinates.slice(idx2, idx3 + 1), color: '#ef4444' }, // Heavy red
      { coords: coordinates.slice(idx3), color: '#007aff' }            // Approach blue
    ].filter(s => s.coords.length >= 2);
  }

  // Route calculation and drawing
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
              location: maneuver.location, // [lng, lat]
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

  // Render Route on MapLibre GL
  renderMapLibreRoute(coordinates, destination) {
    // Remove existing route layers and source
    ['route-base', 'route-traffic-0', 'route-traffic-1', 'route-traffic-2', 'route-traffic-3'].forEach(layerId => {
      if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
    });
    for (let i = 0; i < 8; i++) {
      if (this.map.getLayer(`route-seg-${i}`)) this.map.removeLayer(`route-seg-${i}`);
      if (this.map.getSource(`route-seg-${i}`)) this.map.removeSource(`route-seg-${i}`);
    }
    if (this.map.getLayer('route-base')) this.map.removeLayer('route-base');
    if (this.map.getSource('route-full')) this.map.removeSource('route-full');

    // 1. Add Full Route Source for Dark Base Casing
    this.map.addSource('route-full', {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates }
      }
    });

    // Dark under-casing
    this.map.addLayer({
      id: 'route-base',
      type: 'line',
      source: 'route-full',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#0b0f17',
        'line-width': 12,
        'line-opacity': 0.95
      }
    });

    // 2. Colored Traffic Segments
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
          'line-width': 8,
          'line-opacity': 1.0
        }
      });
    });

    // 3. Destination Pin Marker
    if (this.destMarker) {
      this.destMarker.remove();
    }
    const destEl = document.createElement('div');
    destEl.className = 'tesla-dest-pin';
    destEl.innerHTML = `
      <div class="dest-pin-pulse"></div>
      <div class="dest-pin-icon">
        <svg viewBox="0 0 36 36" width="36" height="36">
          <circle cx="18" cy="18" r="14" fill="#ef4444" stroke="#ffffff" stroke-width="3"/>
          <circle cx="18" cy="18" r="5" fill="#ffffff"/>
        </svg>
      </div>
    `;
    this.destMarker = new window.maplibregl.Marker({ element: destEl, anchor: 'center' })
      .setLngLat([destination.lng, destination.lat])
      .addTo(this.map);
  }

  // Render Route on Yandex Maps
  renderYandexRoute(latLngs, destination) {
    if (this.routePolyline) this.map.geoObjects.remove(this.routePolyline);
    if (this.destMarker) this.map.geoObjects.remove(this.destMarker);

    this.routePolyline = new window.ymaps.GeoObjectCollection();

    // Dark base
    this.routePolyline.add(new window.ymaps.Polyline(latLngs, {}, {
      strokeColor: '#0b0f17',
      strokeWidth: 12,
      strokeOpacity: 0.95
    }));

    // Colored traffic segments
    const segments = this.generateTrafficSegments(latLngs);
    segments.forEach(seg => {
      this.routePolyline.add(new window.ymaps.Polyline(seg.coords, {}, {
        strokeColor: seg.color,
        strokeWidth: 8,
        strokeOpacity: 1.0
      }));
    });

    this.map.geoObjects.add(this.routePolyline);

    // Destination Pin
    this.destMarker = new window.ymaps.Placemark([destination.lat, destination.lng], {
      hintContent: destination.name || 'Пункт назначения'
    }, {
      preset: 'islands#redDotIconWithCaption'
    });
    this.map.geoObjects.add(this.destMarker);
  }

  // Render Route on Leaflet
  renderLeafletRoute(latLngs, destination) {
    if (this.routePolyline) this.map.removeLayer(this.routePolyline);
    if (this.destMarker) this.map.removeLayer(this.destMarker);

    this.routePolyline = window.L.featureGroup();

    // Dark base
    this.routePolyline.addLayer(window.L.polyline(latLngs, {
      color: '#0b0f17',
      weight: 12,
      opacity: 0.95,
      lineCap: 'round',
      lineJoin: 'round'
    }));

    // Segments
    const segments = this.generateTrafficSegments(latLngs);
    segments.forEach(seg => {
      this.routePolyline.addLayer(window.L.polyline(seg.coords, {
        color: seg.color,
        weight: 8,
        opacity: 1.0,
        lineCap: 'round',
        lineJoin: 'round'
      }));
    });

    this.routePolyline.addTo(this.map);

    const destIcon = window.L.divIcon({
      className: 'tesla-dest-pin-container',
      html: `
        <div class="tesla-dest-pin">
          <div class="dest-pin-pulse"></div>
          <div class="dest-pin-icon">
            <svg viewBox="0 0 36 36" width="36" height="36">
              <circle cx="18" cy="18" r="14" fill="#ef4444" stroke="#ffffff" stroke-width="3"/>
              <circle cx="18" cy="18" r="5" fill="#ffffff"/>
            </svg>
          </div>
        </div>`,
      iconSize: [36, 36],
      iconAnchor: [18, 18]
    });

    this.destMarker = window.L.marker([destination.lat, destination.lng], { icon: destIcon }).addTo(this.map);
  }

  // Cancel Route
  cancelRoute() {
    this.activeRoute = null;
    this.routeSteps = [];
    this.currentStepIndex = 0;

    if (this.provider === 'maplibre' && this.map) {
      if (this.map.getLayer('route-base')) this.map.removeLayer('route-base');
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
