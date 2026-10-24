#!/usr/bin/env node
// Refreshes data/ev-chargers.json from OpenStreetMap (Overpass API): car charging stations
// in Armenia. Run manually when the snapshot gets old:  node scripts/update_chargers.mjs
// Data © OpenStreetMap contributors, ODbL — keep the attribution in the output file.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/ev-chargers.json');
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const QUERY = `[out:json][timeout:120];
area["ISO3166-1"="AM"][admin_level=2]->.am;
nwr["amenity"="charging_station"](area.am);
out center tags;`;

// OSM socket keys → labels drivers recognise
const SOCKETS = {
  'socket:type2': 'Type 2',
  'socket:type2_cable': 'Type 2',
  'socket:type2_combo': 'CCS2',
  'socket:chademo': 'CHAdeMO',
  'socket:gb_dc': 'GB/T DC',
  'socket:gb_ac': 'GB/T AC',
  'socket:tesla_supercharger': 'Tesla',
  'socket:tesla_destination': 'Tesla',
  'socket:type1': 'Type 1',
  'socket:type1_combo': 'CCS1'
};

function isForCars(tags) {
  if (tags.motorcar === 'yes' || tags['capacity:motorcar']) return true;
  if (tags.bicycle === 'yes' || tags.scooter === 'yes' || tags.motorcar === 'no') return false;
  return true;
}

function maxPowerKw(tags) {
  let best = null;
  for (const [key, value] of Object.entries(tags)) {
    if (!key.endsWith(':output') && key !== 'charging_station:output') continue;
    const m = String(value).match(/([\d.]+)\s*kw/i);
    if (m) best = Math.max(best || 0, parseFloat(m[1]));
  }
  return best;
}

function normalize(el) {
  const tags = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  const sockets = [...new Set(Object.keys(tags).filter(k => SOCKETS[k] && tags[k] !== 'no' && tags[k] !== '0').map(k => SOCKETS[k]))];
  const street = tags['addr:street'];
  return {
    id: `${el.type}/${el.id}`,
    name: tags.name || tags['name:en'] || tags.brand || tags.operator || null,
    operator: tags.operator || tags.brand || null,
    lat: Number(lat.toFixed(6)),
    lng: Number(lng.toFixed(6)),
    capacity: Number(tags['capacity:motorcar'] || tags.capacity) || null,
    sockets,
    maxPowerKw: maxPowerKw(tags),
    openingHours: tags.opening_hours || null,
    fee: tags.fee || null,
    address: street ? [street, tags['addr:housenumber']].filter(Boolean).join(' ') : null
  };
}

const res = await fetch(OVERPASS_URL, {
  method: 'POST',
  headers: { 'User-Agent': 'TeslaNavi/1.0 (charger snapshot)', 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'data=' + encodeURIComponent(QUERY),
  signal: AbortSignal.timeout(180000)
});
if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
const data = await res.json();
const stations = data.elements
  .filter(el => (el.lat ?? el.center?.lat) != null && isForCars(el.tags || {}))
  .map(normalize)
  .sort((a, b) => a.id.localeCompare(b.id));

writeFileSync(OUT, JSON.stringify({
  source: 'OpenStreetMap contributors (ODbL) via Overpass API',
  generatedAt: new Date().toISOString(),
  osmBase: data.osm3s?.timestamp_osm_base || null,
  stations
}, null, 2) + '\n');
console.log(`Wrote ${stations.length} car charging stations (of ${data.elements.length} OSM elements) to ${path.relative(process.cwd(), OUT)}`);
