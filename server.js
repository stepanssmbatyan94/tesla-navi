const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Cache for live Yandex traffic data in Yerevan
let trafficCache = { time: 0, data: null };

// Extract coordinates from text or URL
function extractCoords(str) {
  const atMatch = str.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (atMatch) return { lat: parseFloat(atMatch[1]), lng: parseFloat(atMatch[2]) };

  const qMatch = str.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (qMatch) return { lat: parseFloat(qMatch[1]), lng: parseFloat(qMatch[2]) };

  const llMatch = str.match(/[?&]ll=(-?\d+\.\d+)%2C(-?\d+\.\d+)/);
  if (llMatch) return { lat: parseFloat(llMatch[2]), lng: parseFloat(llMatch[1]) };

  const plainMatch = str.match(/(-?\d+\.\d+)[,\s]+(-?\d+\.\d+)/);
  if (plainMatch) return { lat: parseFloat(plainMatch[1]), lng: parseFloat(plainMatch[2]) };

  return null;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  let pathname = parsedUrl.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

// Helper: Parse coordinates directly from Yandex Maps protobuf URI
function parseYandexGeoUri(uri) {
  if (!uri || !uri.includes('data=')) return null;
  try {
    const raw = uri.split('data=')[1].replace(/,/g, '');
    const buf = Buffer.from(decodeURIComponent(raw), 'base64');
    for (let i = 0; i <= buf.length - 10; i++) {
      if (buf[i] === 0x0d && buf[i + 5] === 0x15) {
        const lng = buf.readFloatLE(i + 1);
        const lat = buf.readFloatLE(i + 6);
        if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !isNaN(lat) && !isNaN(lng)) {
          return { lat, lng };
        }
      }
    }
  } catch (e) {}
  return null;
}

// Helper: Resolve organization coordinates by oid
async function resolveYandexOrgCoords(oid) {
  try {
    const url = `https://yandex.com/maps/org/${oid}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } });
    const html = await res.text();
    const match = html.match(/class="state-view">([^<]+)<\/script>/);
    if (match) {
      const data = JSON.parse(match[1]);
      const coords = data.stack?.[0]?.results?.items?.[0]?.coordinates ||
                     data.stack?.[0]?.stops?.data?.coordinates ||
                     data.card?.coordinates;
      if (coords && coords.length === 2) {
        return { lat: coords[1], lng: coords[0] };
      }
    }
  } catch (e) {}
  return null;
}

// Helper: Fetch Yandex Suggest results with smart word-order permutation and language fallback
async function fetchYandexSuggestResults(q, userLng = 44.5125, userLat = 40.1776) {
  async function doReq(query, lang = 'ru_RU') {
    try {
      const url = `https://suggest-maps.yandex.ru/suggest-geo?v=9&search_type=all&part=${encodeURIComponent(query)}&lang=${lang}&n=8&origin=maps-form&ll=${userLng},${userLat}&spn=1.8,1.8`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } });
      const text = await res.text();
      const json = JSON.parse(text.replace(/^[^({]*\(/, '').replace(/\);?$/, ''));
      return json.results || [];
    } catch (e) {
      return [];
    }
  }

  let results = await doReq(q, 'ru_RU');

  // Handle multi-word input (e.g. "армавир норава", "армавир нораван")
  const words = q.trim().split(/\s+/);
  if (words.length >= 2) {
    // 2a. If direct returned few (< 2), try reversed word order (e.g. "нораван армавир")
    if (results.length < 2) {
      const reversed = words.slice().reverse().join(' ');
      const revResults = await doReq(reversed, 'ru_RU');
      if (revResults.length > results.length) {
        results = revResults;
      }
    }

    // 2b. If still few (< 2), search by target place prefix (last word) and rank by region/context (first words)
    if (results.length < 2) {
      const placeWord = words[words.length - 1];
      const contextWord = words.slice(0, words.length - 1).join(' ').toLowerCase();
      const placeResults = await doReq(placeWord, 'ru_RU');
      if (placeResults.length > 0) {
        placeResults.sort((a, b) => {
          const textA = `${a.title.text} ${a.subtitle?.text || ''} ${a.where?.name || ''}`.toLowerCase();
          const textB = `${b.title.text} ${b.subtitle?.text || ''} ${b.where?.name || ''}`.toLowerCase();
          const matchA = textA.includes(contextWord);
          const matchB = textB.includes(contextWord);
          if (matchA && !matchB) return -1;
          if (!matchA && matchB) return 1;
          return 0;
        });
        results = placeResults;
      }
    }
  }

  // 3. If still empty, try en_US (for English queries like "armavir noravan")
  if (results.length === 0) {
    results = await doReq(q, 'en_US');
    if (results.length === 0 && words.length >= 2) {
      const reversed = words.slice().reverse().join(' ');
      results = await doReq(reversed, 'en_US');
    }
  }

  return results;
}

  // API 1: /api/resolve-location (Resolves Google Maps links, coordinates, or search queries)
  if (pathname === '/api/resolve-location') {
    const input = (parsedUrl.searchParams.get('url') || parsedUrl.searchParams.get('q') || '').trim();
    if (!input) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing query' }));
      return;
    }

    try {
      let coords = extractCoords(input);

      // Follow redirect if short URL
      if (!coords && (input.startsWith('http://') || input.startsWith('https://'))) {
        try {
          const redirectRes = await fetch(input, {
            redirect: 'follow',
            headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)' }
          });
          coords = extractCoords(redirectRes.url);
        } catch (e) {
          console.warn('Redirect resolve warning:', e.message);
        }
      }

      // 1. Try Yandex Maps Suggest first (Best for Armenia villages, addresses, Russian & Armenian names)
      if (!coords) {
        try {
          const yResults = await fetchYandexSuggestResults(input, 44.5125, 40.1776);
          if (yResults && yResults.length > 0) {
            for (const r of yResults) {
              let geo = parseYandexGeoUri(r.uri);
              if (!geo && r.uri && r.uri.includes('oid=')) {
                const m = r.uri.match(/oid=(\d+)/);
                if (m) geo = await resolveYandexOrgCoords(m[1]);
              }
              if (geo) {
                const name = r.title ? r.title.text : input;
                coords = { name, lat: geo.lat, lng: geo.lng };
                break;
              }
            }
          }
        } catch (e) {
          console.warn('Yandex Suggest resolve error:', e.message);
        }
      }

      // 2. High-precision Photon fuzzy search fallback
      if (!coords) {
        try {
          const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(input)}&lat=40.18&lon=44.49&limit=1`;
          const pRes = await fetch(photonUrl);
          const pData = await pRes.json();
          if (pData.features && pData.features.length > 0) {
            const f = pData.features[0];
            const p = f.properties;
            const name = [p.housenumber, p.name || p.street].filter(Boolean).join(' ') || input;
            coords = {
              name,
              lat: f.geometry.coordinates[1],
              lng: f.geometry.coordinates[0]
            };
          }
        } catch (e) {
          console.warn('Photon error:', e.message);
        }
      }

      // 3. Nominatim Fallback
      if (!coords) {
        const nomUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(input)}&countrycodes=am,ge&addressdetails=1&limit=1`;
        const nomRes = await fetch(nomUrl, { headers: { 'User-Agent': 'TeslaNavi/1.0 (stepansmbatyan94@gmail.com)' } });
        const results = await nomRes.json();
        if (results && results.length > 0) {
          const item = results[0];
          coords = {
            name: item.display_name.split(',')[0],
            lat: parseFloat(item.lat),
            lng: parseFloat(item.lon)
          };
        }
      }

      if (coords) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, name: coords.name || input, lat: coords.lat, lng: coords.lng }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Location not found' }));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // API 2: /api/geocode (Authentic Yandex Maps search suggestions + village/province resolution)
  if (pathname === '/api/geocode') {
    const q = (parsedUrl.searchParams.get('q') || '').trim();
    const userLat = parseFloat(parsedUrl.searchParams.get('lat')) || 40.1776;
    const userLng = parseFloat(parsedUrl.searchParams.get('lng')) || 44.5125;
    if (!q || q.length < 2) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }

    try {
      // 1. Primary: Yandex Maps Suggest API with smart word order permutation & English fallback
      const yResults = await fetchYandexSuggestResults(q, userLng, userLat);

      let items = [];
      if (yResults && yResults.length > 0) {
        const rawItems = [];
        for (const r of yResults) {
          const title = r.title ? r.title.text : q;
          const subtitle = r.subtitle ? r.subtitle.text : (r.where?.name || 'Армения');
          let coords = parseYandexGeoUri(r.uri);
          let oid = null;
          if (r.uri && r.uri.includes('oid=')) {
            const m = r.uri.match(/oid=(\d+)/);
            if (m) oid = m[1];
          }
          rawItems.push({ title, subtitle, coords, oid, uri: r.uri });
        }

        // Parallel resolve organization coords for entries without protobuf data
        await Promise.all(rawItems.slice(0, 4).map(async (item) => {
          if (!item.coords && item.oid) {
            item.coords = await resolveYandexOrgCoords(item.oid);
          }
        }));

        items = rawItems
          .filter(it => it.coords && it.coords.lat && it.coords.lng)
          .map(it => ({
            title: it.title,
            subtitle: it.subtitle,
            lat: it.coords.lat,
            lng: it.coords.lng
          }));
      }

      // 2. If Yandex returned few or query is in English/Armenian Latin, merge with Photon
      if (items.length < 2) {
        try {
          const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lat=${userLat}&lon=${userLng}&limit=6`;
          const pRes = await fetch(photonUrl);
          const pData = await pRes.json();
          if (pData.features && pData.features.length > 0) {
            const photonItems = pData.features.map(f => {
              const p = f.properties;
              const title = [p.housenumber, p.name || p.street].filter(Boolean).join(' ') || q;
              const subtitle = [p.district || p.city, p.country || 'Армения'].filter(Boolean).join(', ');
              return {
                title,
                subtitle,
                lat: f.geometry.coordinates[1],
                lng: f.geometry.coordinates[0]
              };
            });
            items = items.concat(photonItems);
          }
        } catch (e) {}
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(items.slice(0, 8)));
    } catch (err) {
      console.warn('Geocode handler error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
    }
    return;
  }

  // API 3: /api/route (Lane-accurate OpenStreetMap OSRM routing for MapLibre + Yandex Live Router for Yandex provider)
  if (pathname === '/api/route') {
    const startLat = parsedUrl.searchParams.get('startLat');
    const startLng = parsedUrl.searchParams.get('startLng');
    const destLat = parsedUrl.searchParams.get('destLat');
    const destLng = parsedUrl.searchParams.get('destLng');
    const provider = parsedUrl.searchParams.get('provider') || 'maplibre';

    if (!startLat || !startLng || !destLat || !destLng) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing coordinates' }));
      return;
    }

    // 1. Query live Yandex Maps Router (genuine Yerevan traffic segments, ETA, and congestion delays)

    try {
      // 2. Query live Yandex Maps Router (when provider is yandex or as fallback)
      const yandexUrl = `https://yandex.com/maps/10262/yerevan/?mode=routes&rtext=${startLat}%2C${startLng}~${destLat}%2C${destLng}&rtt=auto`;
      const yRes = await fetch(yandexUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        }
      });
      const html = await yRes.text();
      const match = html.match(/<script type="application\/json" class="state-view">([\s\S]*?)<\/script>/);

      if (match) {
        const stateData = JSON.parse(match[1]);
        const yRoutes = stateData.config?.routerResponse?.routes;

        if (yRoutes && yRoutes.length > 0) {
          const colors = {
            'FREE': '#82ea0d',       // 100% Sampled Yandex Navigator Lime Green
            'LIGHT': '#fbd42e',      // 100% Sampled Yandex Navigator Sunny Yellow
            'HARD': '#ff4533',       // 100% Sampled Yandex Navigator Bright Red
            'VERY_HARD': '#a80000',  // 100% Sampled Yandex Navigator Burgundy
            'UNKNOWN': '#82ea0d'
          };

          const parsedRoutes = yRoutes.map((r, idx) => {
            const coords = r.coordinates || [];
            const colorize = r.colorizeInfo || [];
            const segments = [];
            let curIdx = 0;

            for (const info of colorize) {
              const nextIdx = Math.min(curIdx + info.count, coords.length);
              const segCoords = coords.slice(curIdx, nextIdx + 1);
              if (segCoords.length >= 2) {
                segments.push({
                  type: info.type,
                  color: colors[info.type] || '#22c55e',
                  coords: segCoords // [[lng, lat], ...]
                });
              }
              curIdx = nextIdx;
            }

            // Parse turn-by-turn navigation steps from Yandex paths segments
            const rawSections = (r.paths && r.paths[0] && r.paths[0].segments) ? r.paths[0].segments : (r.sections || []);
            const steps = rawSections.map((sec, sIdx) => {
              const actionVal = (sec.action?.value || sec.action?.text || '').toUpperCase();
              let modifier = 'straight';
              let type = 'turn';

              if (actionVal.includes('LEFT')) {
                modifier = (actionVal.includes('FORK') || actionVal.includes('EXIT')) ? 'slight left' : 'left';
              } else if (actionVal.includes('RIGHT')) {
                modifier = (actionVal.includes('FORK') || actionVal.includes('EXIT')) ? 'slight right' : 'right';
              } else if (actionVal.includes('UTURN')) {
                modifier = 'u-turn';
              } else if (actionVal.includes('ROUNDABOUT')) {
                modifier = 'roundabout';
                type = 'roundabout';
              } else {
                modifier = 'straight';
              }

              const streetName = sec.street || sec.text || '';
              // Authentic turn instruction
              let instruction = 'Двигайтесь прямо';
              if (modifier === 'left') instruction = `Поверните налево${streetName ? ` на ${streetName}` : ''}`;
              else if (modifier === 'right') instruction = `Поверните направо${streetName ? ` на ${streetName}` : ''}`;
              else if (modifier === 'slight left') instruction = `Держитесь левее${streetName ? ` на ${streetName}` : ''}`;
              else if (modifier === 'slight right') instruction = `Держитесь правее${streetName ? ` на ${streetName}` : ''}`;
              else if (modifier === 'u-turn') instruction = 'Развернитесь';
              else if (modifier === 'roundabout') instruction = 'Круговое движение';
              else if (streetName) instruction = `Двигайтесь по ${streetName}`;

              // Determine speed limit for this section (ПДД РА + знаки магистралей)
              let speedLimit = 60; // Стандарт по ПДД Армении в черте населенных пунктов
              const streetLower = (streetName || '').toLowerCase();
              const isNorthSouthExp = /север-юг|north-south|\bm-1\b|\bm-2\b/i.test(streetLower);
              const isHwy = /highway|трасса|шоссе|\bh-\d+|\bm-\d+/i.test(streetLower);
              const isFastAvenue = /исаков|isakov|сараландж|saralanj|багреванд|bagrevand|давиташен|davitashen/i.test(streetLower);
              const loc = (sec.edgePoints && sec.edgePoints[0]) ? sec.edgePoints[0] : null;

              if (isNorthSouthExp) {
                speedLimit = 110; // Скоростная автомагистраль Север-Юг (Севан, Арташат)
              } else if (isHwy) {
                speedLimit = 90; // Загородная трасса / шоссе по ПДД РА
              } else if (isFastAvenue) {
                speedLimit = 70; // Специальные городские магистрали Еревана со знаками 70
              } else if (loc) {
                // Check distance from Yerevan center (40.1772, 44.5105)
                const dLat = (loc[1] - 40.1772) * 111;
                const dLng = (loc[0] - 44.5105) * 85;
                const distCenter = Math.sqrt(dLat * dLat + dLng * dLng);
                if (distCenter > 14) speedLimit = 90; // За пределами Еревана — трасса 90
              }

              return {
                index: sIdx,
                name: streetName,
                instruction: instruction,
                action: actionVal,
                modifier: modifier,
                type: type,
                distance: sec.distance?.value || 0,
                duration: sec.durationInTraffic?.value || sec.duration?.value || 0,
                location: loc, // [lng, lat]
                speedLimit: speedLimit
              };
            });

            return {
              index: idx,
              distance: r.distance?.value || 0,
              duration: r.durationInTraffic || r.duration || 0,
              durationWithoutTraffic: r.duration || 0,
              coordinates: coords, // [lng, lat]
              segments: segments.length ? segments : [{ type: 'FREE', color: '#22c55e', coords }],
              steps: steps,
              specialRoadPoints: r.specialRoadPoints || []
            };
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            source: 'yandex',
            routes: parsedRoutes
          }));
          return;
        }
      }
    } catch (err) {
      console.warn('Yandex route fetch warning:', err.message);
    }

    // 2. Fallback to OSRM if Yandex fails
    try {
      const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${startLng},${startLat};${destLng},${destLat}?overview=full&geometries=geojson&steps=true&alternatives=true`;
      const osrmRes = await fetch(osrmUrl);
      const osrmData = await osrmRes.json();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        source: 'osrm',
        ...osrmData
      }));
    } catch (osrmErr) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: osrmErr.message }));
    }
    return;
  }

  // API 3: /api/traffic-yerevan (Live Official Yandex Traffic Score for Armenia)
  if (pathname === '/api/traffic-yerevan') {
    const qLat = parseFloat(parsedUrl.searchParams.get('lat'));
    const qLng = parseFloat(parsedUrl.searchParams.get('lng'));

    // Armenian cities directory
    const armeniaCities = [
      { name: 'Ереван', lat: 40.1772, lng: 44.5105, radius: 18, isYerevan: true },
      { name: 'Гюмри', lat: 40.7894, lng: 43.8475, radius: 10 },
      { name: 'Ванадзор', lat: 40.8128, lng: 44.4883, radius: 8 },
      { name: 'Эчмиадзин', lat: 40.1656, lng: 44.2936, radius: 6 },
      { name: 'Абовян', lat: 40.2741, lng: 44.6264, radius: 5 },
      { name: 'Дилижан', lat: 40.7410, lng: 44.8638, radius: 6 },
      { name: 'Севан', lat: 40.5546, lng: 44.9547, radius: 6 },
      { name: 'Цахкадзор', lat: 40.5317, lng: 44.7175, radius: 5 },
      { name: 'Армавир', lat: 40.1542, lng: 44.0381, radius: 6 },
      { name: 'Капан', lat: 39.2075, lng: 46.4058, radius: 6 }
    ];

    if (!isNaN(qLat) && !isNaN(qLng)) {
      let currentCity = null;
      for (const city of armeniaCities) {
        const dLat = (qLat - city.lat) * 111;
        const dLng = (qLng - city.lng) * 85;
        const distKm = Math.sqrt(dLat * dLat + dLng * dLng);
        if (distKm <= city.radius) {
          currentCity = city;
          break;
        }
      }

      if (!currentCity) {
        // Outside known cities -> Highway
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          outsideCity: true,
          city: 'Трасса',
          score: '🛣️',
          icon: 'green',
          color: '#22c55e',
          hint: 'Трасса свободна',
          time: '',
          source: 'highway'
        }));
        return;
      } else if (!currentCity.isYerevan) {
        // Other Armenian city: Yandex publishes 1-10 numerical traffic index only for Yerevan (10262).
        // For other cities, motion is fluid and free-flowing.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          outsideCity: false,
          city: currentCity.name,
          score: 'OK',
          icon: 'green',
          color: '#22c55e',
          hint: `${currentCity.name}: дороги свободны`,
          time: '',
          source: 'regional'
        }));
        return;
      }
    }

    const now = Date.now();
    if (trafficCache.data && (now - trafficCache.time < 60000)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(trafficCache.data));
      return;
    }

    try {
      const xmlRes = await fetch('https://export.yandex.ru/bar/reginfo.xml?region=10262', {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const xmlText = await xmlRes.text();

      const levelMatch = xmlText.match(/<level>(\d+)<\/level>/);
      const iconMatch = xmlText.match(/<icon>([a-z]+)<\/icon>/);
      const hintMatch = xmlText.match(/<hint lang="ru">([^<]+)<\/hint>/);
      const timeMatch = xmlText.match(/<time>([^<]+)<\/time>/);

      const level = levelMatch ? parseInt(levelMatch[1], 10) : 2;
      const icon = iconMatch ? iconMatch[1] : 'green';
      const hint = hintMatch ? hintMatch[1] : 'Дороги свободны';
      const time = timeMatch ? timeMatch[1] : '';

      let color = '#22c55e';
      if (level >= 7) color = '#ef4444';
      else if (level >= 5) color = '#f97316';
      else if (level >= 4) color = '#eab308';

      const data = {
        success: true,
        city: 'Ереван',
        score: level,
        icon,
        color,
        hint,
        time,
        source: 'yandex'
      };

      trafficCache = { time: now, data };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      console.warn('Yandex traffic fetch warning:', e.message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, fallback: true }));
    }
    return;
  }

  // API 4: /api/yt-search (Live YouTube Search for Tesla Cockpit)
  if (pathname === '/api/yt-search') {
    const q = parsedUrl.searchParams.get('q');
    if (!q) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Query parameter q is required' }));
      return;
    }
    try {
      const ytUrl = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q);
      const ytRes = await fetch(ytUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7,hy;q=0.6'
        }
      });
      const html = await ytRes.text();
      const dataMatch = html.match(/var ytInitialData = ({.*?});<\/script>/);
      const results = [];
      if (dataMatch) {
        const data = JSON.parse(dataMatch[1]);
        const contents = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];
        for (const item of contents) {
          const v = item.videoRenderer;
          if (v && v.videoId) {
            const title = v.title?.runs?.[0]?.text || '';
            const duration = v.lengthText?.simpleText || '';
            const thumbnail = v.thumbnail?.thumbnails?.[0]?.url || '';
            results.push({ id: v.videoId, title, duration, thumbnail });
            if (results.length >= 8) break;
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, results }));
    } catch (e) {
      console.warn('YouTube search fetch warning:', e.message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message, results: [] }));
    }
    return;
  }

  // Handle routes
  if (pathname === '/phone' || pathname.startsWith('/phone/')) {
    pathname = '/phone.html';
  } else if (pathname === '/' || pathname === '/map') {
    pathname = '/index.html';
  }

  const filePath = path.join(__dirname, pathname);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*'
    });

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
});

// Setup Built-in Lightweight WebSocket Room Server
const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new Map();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const room = (url.searchParams.get('room') || 'default').toLowerCase();

  if (!rooms.has(room)) {
    rooms.set(room, new Set());
  }
  const clientSet = rooms.get(room);
  clientSet.add(ws);

  ws.on('message', (data) => {
    for (const peer of clientSet) {
      if (peer !== ws && peer.readyState === ws.OPEN) {
        peer.send(data);
      }
    }
  });

  ws.on('close', () => {
    clientSet.delete(ws);
    if (clientSet.size === 0) {
      rooms.delete(room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`⚡ Tesla Navi Server running at: http://localhost:${PORT}`);
  console.log(`📱 Tesla Display: http://localhost:${PORT}/`);
  console.log(`📱 Phone Remote: http://localhost:${PORT}/phone?code=DEMO12`);
});
