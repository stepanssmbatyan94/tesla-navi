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
      const coords = data.stack?.[0]?.results?.items?.[0]?.coordinates;
      if (coords && coords.length === 2) {
        return { lat: coords[1], lng: coords[0] };
      }
    }
  } catch (e) {}
  return null;
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
          const yUrl = `https://suggest-maps.yandex.ru/suggest-geo?v=9&search_type=all&part=${encodeURIComponent(input)}&lang=ru_RU&n=3&origin=maps-form&ll=44.5125,40.1776&spn=1.8,1.8`;
          const yRes = await fetch(yUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          const yText = await yRes.text();
          const yJson = JSON.parse(yText.replace(/^[^({]*\(/, '').replace(/\);?$/, ''));
          if (yJson.results && yJson.results.length > 0) {
            for (const r of yJson.results) {
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
      // 1. Primary: Yandex Maps Suggest API (armenia bounding box, exact village, street & region names)
      const yandexSuggestUrl = `https://suggest-maps.yandex.ru/suggest-geo?v=9&search_type=all&part=${encodeURIComponent(q)}&lang=ru_RU&n=8&origin=maps-form&ll=${userLng},${userLat}&spn=1.8,1.8`;
      const yRes = await fetch(yandexSuggestUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } });
      const yText = await yRes.text();
      const yJson = JSON.parse(yText.replace(/^[^({]*\(/, '').replace(/\);?$/, ''));

      let items = [];
      if (yJson.results && yJson.results.length > 0) {
        const rawItems = [];
        for (const r of yJson.results) {
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

  // API 3: /api/route (100% Genuine Yandex Route with Live Traffic Segments & OSRM Fallback)
  if (pathname === '/api/route') {
    const startLat = parsedUrl.searchParams.get('startLat');
    const startLng = parsedUrl.searchParams.get('startLng');
    const destLat = parsedUrl.searchParams.get('destLat');
    const destLng = parsedUrl.searchParams.get('destLng');

    if (!startLat || !startLng || !destLat || !destLng) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing coordinates' }));
      return;
    }

    try {
      // 1. Query live Yandex Maps Router
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

            return {
              index: idx,
              distance: r.distance?.value || 0,
              duration: r.durationInTraffic || r.duration || 0,
              durationWithoutTraffic: r.duration || 0,
              coordinates: coords, // [lng, lat]
              segments: segments.length ? segments : [{ type: 'FREE', color: '#22c55e', coords }]
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

  // API 3: /api/traffic-yerevan (Live Official Yandex Traffic Score for Yerevan, Region 10262)
  if (pathname === '/api/traffic-yerevan') {
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
