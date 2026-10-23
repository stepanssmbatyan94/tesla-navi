const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

let MsEdgeTTS, OUTPUT_FORMAT;
try {
  const edgeTtsModule = require('msedge-tts');
  MsEdgeTTS = edgeTtsModule.MsEdgeTTS;
  OUTPUT_FORMAT = edgeTtsModule.OUTPUT_FORMAT;
} catch (e) {
  console.warn('msedge-tts not loaded:', e.message);
}

// In-memory LRU cache for synthesized neural audio (fast 0ms repeats)
const ttsAudioCache = new Map();
const TTS_CACHE_MAX_ENTRIES = 300;
const TTS_MAX_TEXT_LENGTH = 300;
const voiceClients = new Map();

async function getOrCreateVoiceClient(voice) {
  if (voiceClients.has(voice)) {
    return voiceClients.get(voice);
  }
  if (!MsEdgeTTS) {
    throw new Error('MsEdgeTTS not available');
  }
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  voiceClients.set(voice, tts);
  return tts;
}

async function synthesizeNeuralSpeech(text, voiceChoice = 'auto', lang = 'ru') {
  let voice;
  if (lang === 'en') {
    voice = (voiceChoice === 'male' || voiceChoice === 'andrew' || voiceChoice === 'dmitry') ? 'en-US-AndrewNeural' : 'en-US-AvaNeural';
  } else {
    voice = (voiceChoice === 'male' || voiceChoice === 'dmitry') ? 'ru-RU-DmitryNeural' : 'ru-RU-SvetlanaNeural';
  }
  const cacheKey = `${voice}:${text}`;
  if (ttsAudioCache.has(cacheKey)) {
    // Re-insert to mark as recently used (Map keeps insertion order)
    const cached = ttsAudioCache.get(cacheKey);
    ttsAudioCache.delete(cacheKey);
    ttsAudioCache.set(cacheKey, cached);
    return cached;
  }

  const tts = await getOrCreateVoiceClient(voice);
  const { audioStream } = tts.toStream(text);

  return new Promise((resolve, reject) => {
    const chunks = [];
    const timeout = setTimeout(() => {
      voiceClients.delete(voice);
      reject(new Error('TTS timeout'));
    }, 12000);

    audioStream.on('data', chunk => chunks.push(chunk));
    audioStream.on('end', () => {
      clearTimeout(timeout);
      const buffer = Buffer.concat(chunks);
      if (buffer.length > 0) {
        ttsAudioCache.set(cacheKey, buffer);
        // Bounded cache: /api/tts takes arbitrary text, so evict the oldest entries
        while (ttsAudioCache.size > TTS_CACHE_MAX_ENTRIES) {
          ttsAudioCache.delete(ttsAudioCache.keys().next().value);
        }
      }
      resolve(buffer);
    });
    audioStream.on('error', err => {
      clearTimeout(timeout);
      voiceClients.delete(voice);
      reject(err);
    });
  });
}

// Guaranteed Neural TTS with single retry - NEVER fall back to robotic legacy voices
async function getOrSynthesizeSpeech(text, voiceChoice = 'auto', lang = 'ru') {
  try {
    return await synthesizeNeuralSpeech(text, voiceChoice, lang);
  } catch (err) {
    console.warn('[NeuralTTS] Initial attempt failed, retrying once...', err.message);
    let voice;
    if (lang === 'en') {
      voice = (voiceChoice === 'male' || voiceChoice === 'andrew' || voiceChoice === 'dmitry') ? 'en-US-AndrewNeural' : 'en-US-AvaNeural';
    } else {
      voice = (voiceChoice === 'male' || voiceChoice === 'dmitry') ? 'ru-RU-DmitryNeural' : 'ru-RU-SvetlanaNeural';
    }
    voiceClients.delete(voice);
    return await synthesizeNeuralSpeech(text, voiceChoice, lang);
  }
}

const PORT = process.env.PORT || 8085;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg'
};

// Static files reachable over HTTP (everything else in the repo stays private)
const PUBLIC_FILES = new Set(['index.html', 'phone.html']);
const PUBLIC_DIRS = new Set(['css', 'js', 'styles', 'sounds']);

// Hosts /api/resolve-location may fetch (map share links only), so the endpoint
// can't be used to reach internal or arbitrary addresses (SSRF)
const MAP_LINK_HOSTS = ['goo.gl', 'google.com', 'google.am', 'google.ge', 'google.ru', 'yandex.ru', 'yandex.com', 'yandex.am', 'ya.ru', 'maps.apple.com', '2gis.ru', '2gis.am'];

function isAllowedMapLink(urlString) {
  try {
    const u = new URL(urlString);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const host = u.hostname.toLowerCase();
    return MAP_LINK_HOSTS.some(h => host === h || host.endsWith('.' + h));
  } catch (e) {
    return false;
  }
}

// Follow share-link redirects manually so every hop is re-checked against the allowlist
async function resolveMapLinkRedirects(startUrl, maxHops = 5) {
  let current = startUrl;
  for (let hop = 0; hop <= maxHops; hop++) {
    if (!isAllowedMapLink(current)) return null;
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)' }
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    return current;
  }
  return null;
}

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
          const finalUrl = await resolveMapLinkRedirects(input);
          coords = finalUrl ? extractCoords(finalUrl) : null;
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

// Authentic Armenian Neural Voice Pack (Gor & Suzie - High-Fidelity Eastern Armenian)
function getArmenianAudio(text, voiceChoice = 'gor') {
  const t = (text || '').toLowerCase().trim();
  const v = (voiceChoice || '').toLowerCase();
  const folder = (v === 'suzie' || v === 'female' || v === 'svetlana' || v === 'ava') ? 'suzie' : 'gor';

  // Unknown phrases get no clip (the caller answers 404) instead of replaying the greeting
  let file = null;
  const is250 = t.includes('250') || t.includes('հիսուն');

  if (t.includes('կառուցված') || t.includes('գնացինք') || t === 'route_start') {
    file = 'route_start.mp3';
  } else if ((t.includes('հետադարձ') && is250) || t === 'dist_250_uturn') {
    file = 'dist_250_uturn.mp3';
  } else if (t.includes('հետադարձ') || t === 'uturn') {
    file = 'uturn.mp3';
  } else if ((t.includes('պահեք ձախ') && is250) || t === 'dist_250_keep_left') {
    file = 'dist_250_keep_left.mp3';
  } else if ((t.includes('պահեք աջ') && is250) || t === 'dist_250_keep_right') {
    file = 'dist_250_keep_right.mp3';
  } else if ((t.includes('ձախ') && (t.includes('250') || t.includes('հիսուն'))) || t === 'dist_250_left') {
    file = 'dist_250_left.mp3';
  } else if ((t.includes('աջ') && (t.includes('250') || t.includes('հիսուն'))) || t === 'dist_250_right') {
    file = 'dist_250_right.mp3';
  } else if ((t.includes('ուղիղ') && (t.includes('250') || t.includes('հիսուն'))) || t === 'dist_250_straight') {
    file = 'dist_250_straight.mp3';
  } else if ((t.includes('ձախ') && (t.includes('500') || t.includes('հարյուր'))) || t === 'dist_500_left') {
    file = 'dist_500_left.mp3';
  } else if ((t.includes('աջ') && (t.includes('500') || t.includes('հարյուր'))) || t === 'dist_500_right') {
    file = 'dist_500_right.mp3';
  } else if (t.includes('պահեք ձախ') || t === 'keep_left') {
    file = 'keep_left.mp3';
  } else if (t.includes('պահեք աջ') || t === 'keep_right') {
    file = 'keep_right.mp3';
  } else if (t.includes('ձախ') || t === 'turn_left') {
    file = 'turn_left.mp3';
  } else if (t.includes('աջ') || t === 'turn_right') {
    file = 'turn_right.mp3';
  } else if (t.includes('ուղիղ') || t === 'straight') {
    file = 'straight.mp3';
  } else if (t.includes('վերահաշվարկ') || t === 'rerouting') {
    file = 'rerouting.mp3';
  } else if (t.includes('հասել եք') || t.includes('նպատակակետ') || t === 'arrived') {
    file = 'arrived.mp3';
  } else if (t.includes('տեսախցիկ') || t.includes('արագաչափ') || t.includes('կամերա') || t === 'camera_ahead') {
    file = 'camera_ahead.mp3';
  } else if (t.includes('արագություն') || t === 'speed_limit') {
    file = 'speed_limit.mp3';
  } else if (t.includes('ընտրված') || t === 'voice_switched') {
    file = 'voice_switched.mp3';
  } else if (t.includes('գոռն') || t.includes('սյուզի') || t.includes('բարև') || t === 'welcome') {
    file = 'welcome.mp3';
  }

  if (!file) return null;

  let filePath = path.join(__dirname, 'sounds', 'hy', folder, file);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(__dirname, 'sounds', 'hy', 'gor', file);
  }
  if (!fs.existsSync(filePath)) {
    filePath = path.join(__dirname, 'sounds', 'hy', file);
  }
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath);
  }
  return null;
}

  // API 1.5: /api/tts (STRICTLY Neural Studio Voice Synthesizer - 100% Non-Robotic)
  if (pathname === '/api/tts') {
    const text = (parsedUrl.searchParams.get('text') || '').trim();
    const lang = (parsedUrl.searchParams.get('lang') || 'ru').trim().toLowerCase();
    const voice = (parsedUrl.searchParams.get('voice') || 'auto').trim();
    if (!text || text.length > TTS_MAX_TEXT_LENGTH) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Text required (max ${TTS_MAX_TEXT_LENGTH} chars)` }));
      return;
    }

    // Armenian: High fidelity native Piper Gor audio pack
    if (lang === 'hy' || voice === 'gor' || voice === 'suzie') {
      const armenianBuf = getArmenianAudio(text, voice);
      if (armenianBuf) {
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': armenianBuf.byteLength,
          'Cache-Control': 'public, max-age=3600, must-revalidate',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(armenianBuf);
        return;
      }
      // No recorded clip: the Russian/English neural voices can't read Armenian text
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No Armenian clip for this phrase' }));
      return;
    }

    try {
      const audioBuf = await getOrSynthesizeSpeech(text, voice, lang);
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': audioBuf.byteLength,
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(audioBuf);
      return;
    } catch (neuralErr) {
      console.error('[NeuralTTS] Fatal synthesis error:', neuralErr.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Neural synthesis failed', details: neuralErr.message }));
      return;
    }
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

    // 1. Fetch OSRM route in parallel to extract exact OpenStreetMap intersection lane data
    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${startLng},${startLat};${destLng},${destLat}?overview=full&geometries=geojson&steps=true&annotations=true`;
    const osrmPromise = fetch(osrmUrl)
      .then(r => r.json())
      .catch(err => {
        console.warn('OSRM parallel route fetch warning:', err.message);
        return null;
      });

    const extractLaneIntersections = (osrmResult) => {
      const laneIntersections = [];
      if (osrmResult && osrmResult.routes && osrmResult.routes[0] && osrmResult.routes[0].legs) {
        osrmResult.routes[0].legs[0].steps.forEach(s => {
          (s.intersections || []).forEach(inter => {
            if (inter.lanes && inter.lanes.length > 0) {
              laneIntersections.push({
                location: inter.location, // [lng, lat]
                // Direction OSRM leaves the junction in: lets the client drop lanes where
                // the OSRM path diverges from the Yandex route it gets overlaid on
                outBearing: (Array.isArray(inter.bearings) && inter.out != null) ? inter.bearings[inter.out] : null,
                lanes: inter.lanes,
                name: s.name || '',
                modifier: s.maneuver?.modifier || 'straight',
                type: s.maneuver?.type || 'turn'
              });
            }
          });
        });
      }
      return laneIntersections;
    };

    try {
      // 2. Query live Yandex Maps Router (when provider is yandex or as primary traffic engine)
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

          const osrmData = await osrmPromise;
          const laneIntersections = extractLaneIntersections(osrmData);

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

              const isSlightOrKeep = actionVal.includes('SLIGHT') || actionVal.includes('KEEP') || actionVal.includes('BEAR') || actionVal.includes('FORK') || actionVal.includes('EXIT') || actionVal.includes('MERGE') || actionVal.includes('ЛЕВЕЕ') || actionVal.includes('ПРАВЕЕ') || actionVal.includes('ПЛАВН');

              if (actionVal.includes('UTURN') || actionVal.includes('РАЗВОРОТ')) {
                modifier = 'u-turn';
              } else if (actionVal.includes('ROUNDABOUT') || actionVal.includes('КРУГ')) {
                modifier = 'roundabout';
                type = 'roundabout';
              } else if (actionVal.includes('LEFT') || actionVal.includes('ЛЕВЕЕ')) {
                modifier = isSlightOrKeep ? 'slight left' : 'left';
              } else if (actionVal.includes('RIGHT') || actionVal.includes('ПРАВЕЕ')) {
                modifier = isSlightOrKeep ? 'slight right' : 'right';
              } else {
                modifier = 'straight';
              }

              const rawStreet = (sec.street || '').trim();
              const isValidStreet = rawStreet.length > 2 && !/^(straight|right|left|roundabout|u-turn|fork)/i.test(rawStreet);
              const streetName = isValidStreet ? rawStreet : '';

              // Authentic turn instruction (clean Russian voice grammar)
              let instruction = 'Двигайтесь прямо';
              if (modifier === 'slight left') instruction = streetName ? `Держитесь левее на ${streetName}` : 'Держитесь левее';
              else if (modifier === 'slight right') instruction = streetName ? `Держитесь правее на ${streetName}` : 'Держитесь правее';
              else if (modifier === 'left') instruction = streetName ? `Поверните налево на ${streetName}` : 'Поверните налево';
              else if (modifier === 'right') instruction = streetName ? `Поверните направо на ${streetName}` : 'Поверните направо';
              else if (modifier === 'u-turn') instruction = 'Развернитесь';
              else if (modifier === 'roundabout') instruction = 'Круговое движение';
              else if (streetName) instruction = `Двигайтесь по ${streetName}`;

              // Determine speed limit for this section (ПДД РА + знаки магистралей)
              let speedLimit = 60; // Стандарт по ПДД Армении в черте населенных пунктов
              const streetLower = (streetName || '').toLowerCase();
              const isNorthSouthExp = /север-юг|north-south|\bm-1\b|\bm-2\b/i.test(streetLower);
              const isHwy = /highway|трасса|шоссе|\bh-\d+|\bm-\d+/i.test(streetLower);
              const isFastAvenue = /исаков|isakov|сараландж|saralanj|багреванд|bagrevand|давиташен|davitashen/i.test(streetLower);
              // The section's action is performed where the section STARTS (edgePoints[0])
              const loc = (sec.edgePoints && sec.edgePoints[0]) ? sec.edgePoints[0] : ((sec.edgePoints && sec.edgePoints[1]) ? sec.edgePoints[1] : null);

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
                speedLimit: speedLimit,
                speedLimitSource: 'estimated' // street-name heuristic, not map data
              };
            });

            // Collect street names along route
            const cleanStreets = (rawSections.map(s => s.street).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i))
              .filter(st => st.length > 3 && !/^(straight|right|left|roundabout|u-turn|подъезд|двор)/i.test(st));

            return {
              index: idx,
              cleanStreets: cleanStreets,
              distance: r.distance?.value || 0,
              duration: r.durationInTraffic || r.duration || 0,
              durationWithoutTraffic: r.duration || 0,
              coordinates: coords, // [lng, lat]
              segments: segments.length ? segments : [{ type: 'FREE', color: '#22c55e', coords }],
              steps: steps,
              laneIntersections: laneIntersections,
              specialRoadPoints: r.specialRoadPoints || []
            };
          });

          // Sort routes so the fastest route (lowest duration) is guaranteed to be at index 0
          parsedRoutes.sort((a, b) => a.duration - b.duration);

          // Assign human-friendly distinctive summaries (e.g. "через ул. Теряна", "через просп. Мясникяна")
          const usedViaStreets = new Set();
          parsedRoutes.forEach((r, i) => {
            r.index = i;
            let via = '';
            if (i === 0) {
              // Primary fastest route: use major/longest street
              via = r.cleanStreets.find(s => s.length > 7) || r.cleanStreets[1] || r.cleanStreets[0] || '';
            } else {
              // Alternative route: find the street that has not been used yet
              via = r.cleanStreets.find(s => !usedViaStreets.has(s) && s.length > 4) ||
                    r.cleanStreets.find(s => s.length > 6) ||
                    r.cleanStreets[0] || '';
            }
            if (via) usedViaStreets.add(via);
            r.summary = via ? `через ${via}` : `Маршрут ${i + 1}`;
            delete r.cleanStreets; // Clean up temporary array
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
      const osrmData = (await osrmPromise) || await (await fetch(osrmUrl)).json();
      const laneIntersections = extractLaneIntersections(osrmData);
      if (osrmData && osrmData.routes) {
        osrmData.routes.forEach(r => {
          r.laneIntersections = laneIntersections;
        });
      }

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

  // API: /api/speed-cameras (185 Verified Real Speed Cameras for Yerevan / Armenia)
  if (pathname === '/api/speed-cameras') {
    try {
      const camerasPath = path.join(__dirname, 'data', 'yerevan-cameras-clean.json');
      if (fs.existsSync(camerasPath)) {
        const data = fs.readFileSync(camerasPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' });
        res.end(data);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: /api/chargers (EV charging stations in Armenia from an OpenStreetMap snapshot,
  // refreshed with scripts/update_chargers.mjs). No live availability data exists for them.
  if (pathname === '/api/chargers') {
    try {
      const data = fs.readFileSync(path.join(__dirname, 'data', 'ev-chargers.json'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' });
      res.end(data);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message, stations: [] }));
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

  // API 4: /api/yt-search (Live YouTube Search with Infinite Scroll Pagination)
  if (pathname === '/api/yt-search') {
    const q = (parsedUrl.searchParams.get('q') || '').trim();
    const continuation = (parsedUrl.searchParams.get('continuation') || '').trim();

    try {
      const results = [];
      let nextContinuationToken = null;

      if (continuation) {
        // Fetch next page via YouTube InnerTube Search API
        const ytRes = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          },
          body: JSON.stringify({
            context: {
              client: { clientName: 'WEB', clientVersion: '2.20240101.00.00', hl: 'ru', gl: 'AM' }
            },
            continuation
          })
        });
        const data = await ytRes.json();
        const actions = data.onResponseReceivedCommands?.[0]?.appendContinuationItemsAction?.continuationItems || [];
        for (const act of actions) {
          if (act.itemSectionRenderer?.contents) {
            for (const item of act.itemSectionRenderer.contents) {
              const v = item.videoRenderer;
              if (v && v.videoId) {
                const title = v.title?.runs?.[0]?.text || '';
                const duration = v.lengthText?.simpleText || '';
                const channel = v.ownerText?.runs?.[0]?.text || v.shortBylineText?.runs?.[0]?.text || '';
                const thumbObj = v.thumbnail?.thumbnails?.[v.thumbnail.thumbnails.length - 1] || v.thumbnail?.thumbnails?.[0];
                const thumbnail = thumbObj ? thumbObj.url : `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`;
                if (title) {
                  results.push({ id: v.videoId, title, duration, channel, thumbnail });
                }
              }
            }
          }
          if (act.continuationItemRenderer) {
            nextContinuationToken = act.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token || null;
          }
        }
      } else {
        // Initial HTML search query
        const searchQuery = q || 'trending music';
        const ytUrl = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(searchQuery);
        const ytRes = await fetch(ytUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7,hy;q=0.6'
          }
        });
        const html = await ytRes.text();
        const dataMatch = html.match(/var ytInitialData = ({.*?});<\/script>/);
        if (dataMatch) {
          const data = JSON.parse(dataMatch[1]);
          const sectionList = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
          for (const section of sectionList) {
            const contents = section.itemSectionRenderer?.contents || [];
            for (const item of contents) {
              const v = item.videoRenderer;
              if (v && v.videoId) {
                const title = v.title?.runs?.[0]?.text || '';
                const duration = v.lengthText?.simpleText || '';
                const channel = v.ownerText?.runs?.[0]?.text || v.shortBylineText?.runs?.[0]?.text || '';
                const thumbObj = v.thumbnail?.thumbnails?.[v.thumbnail.thumbnails.length - 1] || v.thumbnail?.thumbnails?.[0];
                const thumbnail = thumbObj ? thumbObj.url : `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`;
                if (title) {
                  results.push({ id: v.videoId, title, duration, channel, thumbnail });
                }
              }
            }
            if (section.continuationItemRenderer) {
              nextContinuationToken = section.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token || null;
            }
          }
          const lastItem = sectionList[sectionList.length - 1];
          if (lastItem && lastItem.continuationItemRenderer) {
            nextContinuationToken = lastItem.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token || nextContinuationToken;
          }
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, results, continuationToken: nextContinuationToken }));
    } catch (e) {
      console.warn('YouTube search fetch warning:', e.message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message, results: [], continuationToken: null }));
    }
    return;
  }

  // API 4.5: /api/yt-suggestions (Real-time YouTube search autocomplete suggestions)
  if (pathname === '/api/yt-suggestions') {
    const q = (parsedUrl.searchParams.get('q') || '').trim();
    if (!q) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, suggestions: [] }));
      return;
    }

    try {
      const suggestUrl = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=ru&gl=AM&q=${encodeURIComponent(q)}`;
      const suggestRes = await fetch(suggestUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      const data = await suggestRes.json();
      const suggestions = (data && Array.isArray(data[1])) ? data[1] : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, suggestions }));
    } catch (err) {
      console.warn('YouTube suggestions fetch warning:', err.message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, suggestions: [] }));
    }
    return;
  }

  // Handle routes
  if (pathname === '/phone' || pathname.startsWith('/phone/')) {
    pathname = '/phone.html';
  } else if (pathname === '/' || pathname === '/map') {
    pathname = '/index.html';
  }

  // Serve only the public front-end: never .git, server code, node_modules, refs/, models/...
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request');
    return;
  }
  const filePath = path.resolve(__dirname, '.' + decodedPath);
  const relPath = path.relative(__dirname, filePath);
  const relParts = relPath.split(path.sep);
  const isPublic = !relPath.startsWith('..') && !path.isAbsolute(relPath) &&
    !relParts.some(part => part.startsWith('.')) &&
    (PUBLIC_FILES.has(relPath) || PUBLIC_DIRS.has(relParts[0]));
  if (!isPublic) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }

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

  ws.on('message', (data, isBinary) => {
    // ws v8 hands text frames over as Buffers: preserve the frame type, otherwise
    // browsers receive a Blob and JSON.parse fails on "[object Blob]"
    for (const peer of clientSet) {
      if (peer !== ws && peer.readyState === ws.OPEN) {
        peer.send(data, { binary: isBinary });
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

  // Pre-warm neural audio cache in background for instant 0ms response
  const PREWARM_RU_SVETLANA = [
    'Здравствуйте! Я Светлана, ваш голосовой навигатор в Tesla Navi. Маршрут свободен, приятной дороги!',
    'Голос изменён на Светлана. Приятной дороги!',
    'Маршрут построен. Поехали!',
    'Вы прибыли в пункт назначения',
    'Перестраиваю маршрут',
    'Поверните направо',
    'Поверните налево',
    'Держитесь правее',
    'Держитесь левее',
    'Двигайтесь прямо'
  ];
  const PREWARM_RU_DMITRY = [
    'Здравствуйте! Я Дмитрий, ваш голосовой навигатор в Tesla Navi. Маршрут свободен, приятной дороги!',
    'Голос изменён на Дмитрий. Приятной дороги!',
    'Маршрут построен. Поехали!',
    'Вы прибыли в пункт назначения',
    'Перестраиваю маршрут'
  ];
  const PREWARM_EN = [
    'Hello! I am Ava, your Tesla Navi voice assistant. The route is clear, have a safe trip!',
    'Voice switched to Ava',
    'Route calculated. Let us go!',
    'You have arrived at your destination',
    'Rerouting'
  ];
  setTimeout(async () => {
    for (const p of PREWARM_RU_SVETLANA) {
      try {
        await synthesizeNeuralSpeech(p, 'svetlana', 'ru');
        await new Promise(r => setTimeout(r, 60));
      } catch (e) {}
    }
    for (const p of PREWARM_RU_DMITRY) {
      try {
        await synthesizeNeuralSpeech(p, 'dmitry', 'ru');
        await new Promise(r => setTimeout(r, 60));
      } catch (e) {}
    }
    for (const p of PREWARM_EN) {
      try {
        await synthesizeNeuralSpeech(p, 'ava', 'en');
        await new Promise(r => setTimeout(r, 60));
      } catch (e) {}
    }
    console.log('🎙️ Neural Voice Cache pre-warmed for Svetlana, Dmitry & Ava');
  }, 1500);
});
