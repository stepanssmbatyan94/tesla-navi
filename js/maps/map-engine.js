// Tesla Navi Unified Map Engine (Yandex Maps + Leaflet/OSM)

class TeslaMapEngine {
  constructor(containerId, options = {}) {
    this.containerId = containerId;
    this.provider = options.provider || 'yandex'; // 'yandex' | 'osm'
    this.center = options.center || CONFIG.defaultCenter;
    this.navZoom = CONFIG.navigationZoom || 16.5;
    this.onRouteCalculated = options.onRouteCalculated || (() => {});
    
    this.map = null;
    this.carMarker = null;
    this.routePolyline = null; // Can be a GeoObjectCollection or FeatureGroup
    this.destMarker = null;
    this.trafficLayer = null;
    this.trafficEnabled = true;
    this.followCar = true;

    this.currentPosition = { lat: this.center.lat, lng: this.center.lng, heading: 0, speed: 0 };
    this.activeRoute = null;
  }

  async init() {
    console.log(`[MapEngine] Initializing provider: ${this.provider} at zoom ${this.navZoom}`);
    const container = document.getElementById(this.containerId);
    container.innerHTML = '';

    if (this.provider === 'yandex' && window.ymaps) {
      await this.initYandex();
    } else {
      await this.initLeaflet();
    }
  }

  // Yandex Maps Implementation
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

        // Live Traffic Control Layer (Auto-shown)
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
        } catch (e) {
          console.warn('[Yandex] Traffic warning:', e);
        }

        // Custom High-Visibility Vehicle Cursor Layout (Electric Blue Chevron with White Border)
        const CarLayout = window.ymaps.templateLayoutFactory.createClass(
          `<div id="yandex-car-marker" class="tesla-car-marker" style="transform: rotate(0deg);">
            <div class="tesla-car-pulse"></div>
            <div class="tesla-car-body">
              <svg viewBox="0 0 48 48" width="48" height="48">
                <polygon points="24,4 42,40 24,31 6,40" fill="#0066ff" stroke="#ffffff" stroke-width="3" stroke-linejoin="round"/>
                <circle cx="24" cy="24" r="3.5" fill="#ffffff" />
              </svg>
            </div>
          </div>`
        );

        this.carMarker = new window.ymaps.Placemark([this.center.lat, this.center.lng], {}, {
          iconLayout: CarLayout,
          iconImageSize: [48, 48],
          iconImageOffset: [-24, -24]
        });

        this.map.geoObjects.add(this.carMarker);
        resolve();
      });
    });
  }

  // Leaflet / OSM Implementation
  async initLeaflet() {
    return new Promise((resolve) => {
      if (!window.L) {
        console.error('Leaflet not loaded');
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
          <div id="leaflet-car-marker" class="tesla-car-marker" style="transform: rotate(0deg);">
            <div class="tesla-car-pulse"></div>
            <div class="tesla-car-body">
              <svg viewBox="0 0 48 48" width="48" height="48">
                <polygon points="24,4 42,40 24,31 6,40" fill="#0066ff" stroke="#ffffff" stroke-width="3" stroke-linejoin="round"/>
                <circle cx="24" cy="24" r="3.5" fill="#ffffff" />
              </svg>
            </div>
          </div>`,
        iconSize: [48, 48],
        iconAnchor: [24, 24]
      });

      this.carMarker = window.L.marker([this.center.lat, this.center.lng], { icon: carIcon }).addTo(this.map);
      resolve();
    });
  }

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

  updateCarPosition(lat, lng, heading = 0, speed = 0) {
    this.currentPosition = { lat, lng, heading, speed };

    if (this.provider === 'yandex' && this.carMarker) {
      this.carMarker.geometry.setCoordinates([lat, lng]);
      const markerEl = document.getElementById('yandex-car-marker');
      if (markerEl) {
        markerEl.style.transform = `rotate(${heading}deg)`;
      }
      if (this.followCar && this.map) {
        this.map.panTo([lat, lng], { duration: 300, flying: false });
      }
    } 
    else if (this.carMarker && window.L && this.provider === 'osm') {
      this.carMarker.setLatLng([lat, lng]);
      const markerEl = document.getElementById('leaflet-car-marker');
      if (markerEl) {
        markerEl.style.transform = `rotate(${heading}deg)`;
      }
      if (this.followCar && this.map) {
        this.map.panTo([lat, lng], { animate: true, duration: 0.3 });
      }
    }
  }

  // Build traffic-colored segments along route coordinates
  generateTrafficSegments(coordinates) {
    const total = coordinates.length;
    if (total < 4) {
      return [{ coords: coordinates, color: '#0066ff' }];
    }

    // Split route into realistic traffic colored segments:
    // 0 -> 45%: Smooth flowing (#0066ff)
    // 45% -> 65%: Moderate traffic / yellow-amber (#f59e0b)
    // 65% -> 80%: Heavy congestion / red (#ef4444)
    // 80% -> 90%: Gridlock / burgundy-purple (#880022)
    // 90% -> 100%: Approach / blue (#0066ff)
    const idx1 = Math.floor(total * 0.45);
    const idx2 = Math.floor(total * 0.65);
    const idx3 = Math.floor(total * 0.82);

    const seg1 = coordinates.slice(0, idx1 + 1);
    const seg2 = coordinates.slice(idx1, idx2 + 1);
    const seg3 = coordinates.slice(idx2, idx3 + 1);
    const seg4 = coordinates.slice(idx3);

    return [
      { coords: seg1, color: '#0066ff' },
      { coords: seg2, color: '#f59e0b' }, // Amber
      { coords: seg3, color: '#ef4444' }, // Red
      { coords: seg4, color: '#880022' }  // Burgundy / Purple
    ].filter(s => s.coords.length >= 2);
  }

  // Route calculation and drawing with Traffic Segments
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
        const coordinates = primaryRoute.geometry.coordinates.map(coord => [coord[1], coord[0]]);
        const segments = this.generateTrafficSegments(coordinates);

        // Render on YANDEX MAPS
        if (this.provider === 'yandex' && this.map && window.ymaps) {
          if (this.routePolyline) {
            this.map.geoObjects.remove(this.routePolyline);
          }
          if (this.destMarker) {
            this.map.geoObjects.remove(this.destMarker);
          }

          // Collection holding all traffic segments + outline
          this.routePolyline = new window.ymaps.GeoObjectCollection();

          // 1. Dark high-contrast base outline
          const baseOutline = new window.ymaps.Polyline(coordinates, {}, {
            strokeColor: '#002666',
            strokeWidth: 12,
            strokeOpacity: 0.85
          });
          this.routePolyline.add(baseOutline);

          // 2. Colored traffic segments
          segments.forEach(seg => {
            const segLine = new window.ymaps.Polyline(seg.coords, {}, {
              strokeColor: seg.color,
              strokeWidth: 8,
              strokeOpacity: 0.98
            });
            this.routePolyline.add(segLine);
          });

          this.map.geoObjects.add(this.routePolyline);

          // 3. Destination Pin
          this.destMarker = new window.ymaps.Placemark(end, {
            hintContent: destination.name || 'Пункт назначения'
          }, {
            preset: 'islands#redDotIconWithCaption'
          });
          this.map.geoObjects.add(this.destMarker);
        }

        // Render on LEAFLET / OSM
        else if (this.provider === 'osm' && this.map && window.L) {
          if (this.routePolyline) {
            this.map.removeLayer(this.routePolyline);
          }
          if (this.destMarker) {
            this.map.removeLayer(this.destMarker);
          }

          this.routePolyline = window.L.featureGroup();

          // Base outline
          window.L.polyline(coordinates, {
            color: '#002666',
            weight: 12,
            opacity: 0.85
          }).addTo(this.routePolyline);

          // Traffic segments
          segments.forEach(seg => {
            window.L.polyline(seg.coords, {
              color: seg.color,
              weight: 8,
              opacity: 0.98,
              lineJoin: 'round'
            }).addTo(this.routePolyline);
          });

          this.routePolyline.addTo(this.map);

          this.destMarker = window.L.circleMarker(end, {
            radius: 8,
            fillColor: '#ef4444',
            color: '#ffffff',
            weight: 2,
            opacity: 1,
            fillOpacity: 1
          }).addTo(this.map);
        }

        const distanceKm = (primaryRoute.distance / 1000).toFixed(1);
        const durationMin = Math.round(primaryRoute.duration / 60);

        this.onRouteCalculated({
          name: destination.name,
          distance: `${distanceKm} км`,
          duration: `${durationMin} мин`,
          eta: this.getEtaTime(durationMin),
          destination: destination
        });
        return;
      }
    } catch (e) {
      console.error('[Routing Error]:', e);
    }
  }

  startNavigation() {
    this.followCar = true;
    const coords = [this.currentPosition.lat, this.currentPosition.lng];
    if (this.provider === 'yandex' && this.map) {
      this.map.setCenter(coords, this.navZoom, { duration: 500 });
    } else if (this.map && window.L) {
      this.map.setView(coords, this.navZoom, { animate: true });
    }
  }

  cancelRoute() {
    if (this.routePolyline) {
      if (this.provider === 'yandex' && this.map) {
        this.map.geoObjects.remove(this.routePolyline);
      } else if (this.map && window.L) {
        this.map.removeLayer(this.routePolyline);
      }
      this.routePolyline = null;
    }
    if (this.destMarker) {
      if (this.provider === 'yandex' && this.map) {
        this.map.geoObjects.remove(this.destMarker);
      } else if (this.map && window.L) {
        this.map.removeLayer(this.destMarker);
      }
      this.destMarker = null;
    }
    this.activeRoute = null;
  }

  toggleTraffic(enabled) {
    this.trafficEnabled = enabled !== undefined ? enabled : !this.trafficEnabled;
    if (this.trafficLayer && this.trafficLayer.traffic) {
      if (this.trafficEnabled) {
        this.trafficLayer.traffic.show();
      } else {
        this.trafficLayer.traffic.hide();
      }
    }
    return this.trafficEnabled;
  }

  recenter() {
    this.followCar = true;
    const coords = [this.currentPosition.lat, this.currentPosition.lng];
    if (this.provider === 'yandex' && this.map) {
      this.map.setCenter(coords, this.navZoom, { duration: 400 });
    } else if (window.L && this.map) {
      this.map.setView(coords, this.navZoom);
    }
  }

  getEtaTime(minutesToAdd) {
    const d = new Date(Date.now() + minutesToAdd * 60000);
    const hours = String(d.getHours()).padStart(2, '0');
    const mins = String(d.getMinutes()).padStart(2, '0');
    return `${hours}:${mins}`;
  }
}
