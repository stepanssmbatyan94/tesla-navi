#!/usr/bin/env node
// Refreshes data/speed-limits.json from OpenStreetMap (Armenia):
//   ways  — every drivable road with a speed limit in OSM (maxspeed, or maxspeed:type /
//           source:maxspeed = AM:urban / AM:rural), with its geometry;
//   urban — a ~100 m grid of built-up areas (landuse=residential, city/town/village outlines,
//           circles around place nodes). Most streets carry no maxspeed tag (in Yerevan
//           ~2 % of residential streets do), so where no tagged road matches, the server applies
//           the legal default of the Armenian traffic rules: 60 km/h in a settlement, 90 outside.
// Run manually when the snapshot gets old:  node scripts/update_speed_limits.mjs  (~2-4 min)
// Data © OpenStreetMap contributors, ODbL — keep the attribution in the output file.
//
// Output format (compact):
//   ways: [[limitKmh, oneway, lng0, lat0, lng1, lat1, ...], ...] with coordinates as integers
//         (degrees × 1e5, ~1 m); oneway: 1 forward, -1 reverse, 0 both.
//   urban: { south, west, cellDeg, rows: [[row, colFrom, colTo, colFrom, colTo, ...], ...] }

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/speed-limits.json');
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const BBOX = { south: 38.83, west: 43.44, north: 41.31, east: 46.64 };
const BBOX_STR = `${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}`;
const HIGHWAYS = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';
// Armenian traffic rules: 60 in settlements, 90 outside, 20 in living streets
const IMPLICIT_LIMITS = { 'AM:urban': 60, 'AM:rural': 90, 'AM:living_street': 20 };
const URBAN_CELL_DEG = 0.001; // ~110 × 85 m
// place nodes without an outline count as built-up within this radius (metres)
// (only when the node is not inside an outline already; suburbs/neighbourhoods lie inside cities)
const PLACE_RADIUS_M = { city: 2000, town: 800, village: 350, hamlet: 200 };

// The public Overpass instance answers 429/502/504 when busy: retry a few times
async function overpass(query) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'User-Agent': 'TeslaNavi/1.0 (speed limit snapshot)', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
      signal: AbortSignal.timeout(300000)
    });
    if (res.ok) return res.json();
    if (attempt >= 5 || ![429, 502, 503, 504].includes(res.status)) throw new Error(`Overpass HTTP ${res.status}`);
    console.warn(`Overpass HTTP ${res.status}, retrying in ${attempt * 15} s`);
    await new Promise(r => setTimeout(r, attempt * 15000));
  }
}

function parseMaxspeed(value) {
  const m = String(value || '').trim().match(/^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Math.round(m[2] && m[2].toLowerCase() === 'mph' ? n * 1.609 : n);
}

function wayLimit(tags) {
  return parseMaxspeed(tags.maxspeed) || IMPLICIT_LIMITS[tags['maxspeed:type']] || IMPLICIT_LIMITS[tags['source:maxspeed']] ||
    IMPLICIT_LIMITS[tags.maxspeed] || null;
}

// --- roads with a limit ---
const roads = await overpass(`[out:json][timeout:270][bbox:${BBOX_STR}];
(
  way["highway"~"^(${HIGHWAYS})$"]["maxspeed"];
  way["highway"~"^(${HIGHWAYS})$"]["maxspeed:type"];
  way["highway"~"^(${HIGHWAYS})$"]["source:maxspeed"];
);
out tags geom;`);

const ways = [];
let skipped = 0;
for (const el of roads.elements) {
  const limit = wayLimit(el.tags || {});
  const geometry = el.geometry || [];
  if (!limit || geometry.length < 2) { skipped++; continue; }
  const oneway = el.tags.oneway === 'yes' || el.tags.oneway === '1' ? 1 : (el.tags.oneway === '-1' ? -1 : 0);
  const row = [limit, oneway];
  for (const p of geometry) row.push(Math.round(p.lon * 1e5), Math.round(p.lat * 1e5));
  ways.push(row);
}

// --- built-up areas ---
const areas = await overpass(`[out:json][timeout:270][bbox:${BBOX_STR}];
(
  way["landuse"="residential"];
  relation["landuse"="residential"];
  way["place"~"^(city|town|village|hamlet|suburb|neighbourhood)$"];
  relation["place"~"^(city|town|village|hamlet|suburb|neighbourhood)$"];
  node["place"~"^(city|town|village|hamlet|suburb|neighbourhood)$"];
);
out geom;`);

const rows = Math.ceil((BBOX.north - BBOX.south) / URBAN_CELL_DEG);
const cols = Math.ceil((BBOX.east - BBOX.west) / URBAN_CELL_DEG);
const grid = new Uint8Array(rows * cols);
const rowOf = lat => Math.floor((lat - BBOX.south) / URBAN_CELL_DEG);
const colOf = lng => Math.floor((lng - BBOX.west) / URBAN_CELL_DEG);

// Even-odd scanline fill over all segments of a feature: works for rings split across several
// relation members and treats inner rings as holes, without assembling the rings.
function fillPolygon(segments) {
  let minY = Infinity, maxY = -Infinity;
  for (const [, y1, , y2] of segments) { minY = Math.min(minY, y1, y2); maxY = Math.max(maxY, y1, y2); }
  for (let r = Math.max(0, rowOf(minY)); r <= Math.min(rows - 1, rowOf(maxY)); r++) {
    const yc = BBOX.south + (r + 0.5) * URBAN_CELL_DEG;
    const xs = [];
    for (const [x1, y1, x2, y2] of segments) {
      if ((y1 <= yc) !== (y2 <= yc)) xs.push(x1 + (yc - y1) / (y2 - y1) * (x2 - x1));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const c1 = Math.max(0, Math.ceil((xs[i] - BBOX.west) / URBAN_CELL_DEG - 0.5));
      const c2 = Math.min(cols - 1, Math.floor((xs[i + 1] - BBOX.west) / URBAN_CELL_DEG - 0.5));
      for (let c = c1; c <= c2; c++) grid[r * cols + c] = 1;
    }
  }
}

function segmentsOf(geometry) {
  const segs = [];
  for (let i = 0; i + 1 < (geometry || []).length; i++) {
    const a = geometry[i], b = geometry[i + 1];
    if (a && b) segs.push([a.lon, a.lat, b.lon, b.lat]);
  }
  return segs;
}

let polygons = 0, circles = 0;
// outlines first, so place nodes inside them add nothing
const ordered = [...areas.elements.filter(el => el.type !== 'node'), ...areas.elements.filter(el => el.type === 'node')];
for (const el of ordered) {
  if (el.type === 'node') {
    const radius = PLACE_RADIUS_M[el.tags && el.tags.place];
    if (!radius || grid[rowOf(el.lat) * cols + colOf(el.lon)]) continue;
    const dr = Math.ceil(radius / 110540 / URBAN_CELL_DEG);
    const dc = Math.ceil(radius / (111320 * Math.cos(el.lat * Math.PI / 180)) / URBAN_CELL_DEG);
    const r0 = rowOf(el.lat), c0 = colOf(el.lon);
    for (let r = r0 - dr; r <= r0 + dr; r++) {
      for (let c = c0 - dc; c <= c0 + dc; c++) {
        if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
        if (((r - r0) / dr) ** 2 + ((c - c0) / dc) ** 2 <= 1) grid[r * cols + c] = 1;
      }
    }
    circles++;
  } else if (el.tags && el.tags.boundary === 'administrative' && el.tags.place !== 'city') {
    // community territories in Armenia include fields and roads between villages: not built-up
    continue;
  } else if (el.type === 'way') {
    const segs = segmentsOf(el.geometry);
    if (segs.length >= 3) { fillPolygon(segs); polygons++; }
  } else if (el.type === 'relation') {
    const segs = (el.members || []).filter(m => m.type === 'way' && (m.role === 'outer' || m.role === 'inner'))
      .flatMap(m => segmentsOf(m.geometry));
    if (segs.length >= 3) { fillPolygon(segs); polygons++; }
  }
}

// Dilate by one cell: roads often run along the edge of a residential outline
const urbanGrid = grid.slice();
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    if (grid[r * cols + c]) continue;
    for (let dr = -1; dr <= 1 && !urbanGrid[r * cols + c]; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && cc >= 0 && rr < rows && cc < cols && grid[rr * cols + cc]) { urbanGrid[r * cols + c] = 1; break; }
      }
    }
  }
}

const urbanRows = [];
let urbanCells = 0;
for (let r = 0; r < rows; r++) {
  const runs = [];
  for (let c = 0; c < cols; c++) {
    if (!urbanGrid[r * cols + c]) continue;
    const start = c;
    while (c + 1 < cols && urbanGrid[r * cols + c + 1]) c++;
    runs.push(start, c);
    urbanCells += c - start + 1;
  }
  if (runs.length) urbanRows.push([r, ...runs]);
}

writeFileSync(OUT, JSON.stringify({
  source: 'OpenStreetMap contributors (ODbL) via Overpass API',
  generatedAt: new Date().toISOString(),
  osmBase: roads.osm3s?.timestamp_osm_base || null,
  format: 'ways: [limitKmh, oneway(1|-1|0), lng*1e5, lat*1e5, ...]; urban rows: [row, colFrom, colTo, ...]',
  legalDefaults: { urban: 60, rural: 90 },
  ways,
  urban: { south: BBOX.south, west: BBOX.west, cellDeg: URBAN_CELL_DEG, rows: urbanRows }
}) + '\n');
console.log(`Wrote ${ways.length} ways with a limit (${skipped} skipped), ${urbanCells} built-up cells ` +
  `from ${polygons} outlines + ${circles} place nodes to ${path.relative(process.cwd(), OUT)}`);
