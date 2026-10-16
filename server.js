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

      // High-precision Photon fuzzy search first (understands Latin & Armenian transliterations)
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

      // Nominatim Fallback
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

  // API 2: /api/geocode (Auto-suggestions with Photon multilingual search)
  if (pathname === '/api/geocode') {
    const q = (parsedUrl.searchParams.get('q') || '').trim();
    if (!q || q.length < 2) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }

    try {
      // 1. Try Photon (Best for Armenian, Russian, Latin transliterations like "hakob hakobyan 3")
      const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lat=40.18&lon=44.49&limit=6`;
      const pRes = await fetch(photonUrl);
      const pData = await pRes.json();

      let items = [];
      if (pData.features && pData.features.length > 0) {
        items = pData.features.map(f => {
          const p = f.properties;
          const title = [p.housenumber, p.name || p.street].filter(Boolean).join(' ') || q;
          const subtitle = [p.district || p.city, p.country || 'Հայաստան'].filter(Boolean).join(', ');
          return {
            title,
            subtitle,
            lat: f.geometry.coordinates[1],
            lng: f.geometry.coordinates[0]
          };
        });
      }

      // 2. If Photon returned few or empty, merge with Nominatim
      if (items.length < 2) {
        try {
          const nomUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&countrycodes=am,ge&addressdetails=1&limit=4`;
          const nomRes = await fetch(nomUrl, { headers: { 'User-Agent': 'TeslaNavi/1.0 (stepansmbatyan94@gmail.com)' } });
          const nomResults = await nomRes.json();
          const nomItems = (nomResults || []).map(r => ({
            title: r.display_name.split(',')[0],
            subtitle: r.display_name.split(',').slice(1, 3).join(',').trim(),
            lat: parseFloat(r.lat),
            lng: parseFloat(r.lon)
          }));
          items = items.concat(nomItems);
        } catch (e) {}
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(items.slice(0, 6)));
    } catch (err) {
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
            'FREE': '#26ba56',       // Yandex Official Vivid Green
            'LIGHT': '#ff9f1a',      // Yandex Official Warm Amber/Orange
            'HARD': '#ed4543',       // Yandex Official Traffic Red
            'VERY_HARD': '#990000',  // Yandex Official Deep Burgundy
            'UNKNOWN': '#26ba56'
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
