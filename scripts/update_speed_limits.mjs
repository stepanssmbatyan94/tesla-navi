#!/usr/bin/env node
// Refreshes data/speed-limits.json: every drivable road in Armenia that has a maxspeed tag in
// OpenStreetMap, with its geometry, so /api/route can attach real limits to a route.
// Run manually when the snapshot gets old:  node scripts/update_speed_limits.mjs  (~1-2 min)
// Data © OpenStreetMap contributors, ODbL — keep the attribution in the output file.
//
// Output format (compact): ways: [[limitKmh, oneway, lng0, lat0, lng1, lat1, ...], ...]
// with coordinates as integers (degrees × 1e5, ~1 m); oneway: 1 forward, -1 reverse, 0 both.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/speed-limits.json');
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const ARMENIA_BBOX = '38.83,43.44,41.31,46.64';
const HIGHWAYS = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';
const QUERY = `[out:json][timeout:270][bbox:${ARMENIA_BBOX}];
way["highway"~"^(${HIGHWAYS})$"]["maxspeed"];
out tags geom;`;

function parseMaxspeed(value) {
  const m = String(value || '').trim().match(/^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Math.round(m[2] && m[2].toLowerCase() === 'mph' ? n * 1.609 : n);
}

const res = await fetch(OVERPASS_URL, {
  method: 'POST',
  headers: { 'User-Agent': 'TeslaNavi/1.0 (speed limit snapshot)', 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'data=' + encodeURIComponent(QUERY),
  signal: AbortSignal.timeout(300000)
});
if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
const data = await res.json();

const ways = [];
let skipped = 0;
for (const el of data.elements) {
  const limit = parseMaxspeed(el.tags && el.tags.maxspeed);
  const geometry = el.geometry || [];
  if (!limit || geometry.length < 2) { skipped++; continue; }
  const oneway = el.tags.oneway === 'yes' || el.tags.oneway === '1' ? 1 : (el.tags.oneway === '-1' ? -1 : 0);
  const row = [limit, oneway];
  for (const p of geometry) row.push(Math.round(p.lon * 1e5), Math.round(p.lat * 1e5));
  ways.push(row);
}

writeFileSync(OUT, JSON.stringify({
  source: 'OpenStreetMap contributors (ODbL) via Overpass API',
  generatedAt: new Date().toISOString(),
  osmBase: data.osm3s?.timestamp_osm_base || null,
  format: 'ways: [limitKmh, oneway(1|-1|0), lng*1e5, lat*1e5, ...]',
  ways
}) + '\n');
console.log(`Wrote ${ways.length} ways with maxspeed (${skipped} skipped) to ${path.relative(process.cwd(), OUT)}`);
