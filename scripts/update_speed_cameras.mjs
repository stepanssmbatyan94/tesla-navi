#!/usr/bin/env node
// Refreshes data/speed-cameras.json: traffic-enforcement cameras in Armenia from two sources.
//   node scripts/update_speed_cameras.mjs             OpenStreetMap + SpeedCamOnLine.ru
//   node scripts/update_speed_cameras.mjs --osm-only  OpenStreetMap only
//
// - OpenStreetMap (ODbL, via Overpass): highway=speed_camera nodes and red-light cameras
//   (traffic-signal nodes tagged enforcement=traffic_signals).
// - SpeedCamOnLine.ru, community database "Armenia": the public iGo export (id, position, limit,
//   travel course) joined with the CityGuide export (camera type). Their terms: attribution is
//   required, commercial use only with the owner's permission. Dummies (МЛЖ) are dropped.
//
// Direction: SpeedCamOnLine gives the course of the traffic a camera enforces. OSM `direction`
// is tagged both ways by different mappers (about a third of the cameras that both sources know
// point the opposite way), so OSM-only cameras get no direction and warn for both directions.
// A missed camera costs a fine, an extra warning costs nothing.

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data/speed-cameras.json');
const OSM_ONLY = process.argv.includes('--osm-only');

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const OVERPASS_QUERY = `[out:json][timeout:120];
area["ISO3166-1"="AM"][admin_level=2]->.am;
(
  node["highway"="speed_camera"](area.am);
  node["enforcement"="traffic_signals"](area.am);
);
out;`;
const SCO_IGO_URL = 'https://speedcamonline.ru/igo/Armenia/';
const SCO_TYPES_URL = 'https://speedcamonline.ru/cityguide/Armenia/';
const USER_AGENT = 'TeslaNavi/1.0 (speed-camera snapshot)';

// A SpeedCamOnLine and an OSM camera this close are the same pole
const SAME_CAMERA_M = 30;
// ...and up to this far when the OSM direction lies on the same road axis as the SpeedCamOnLine
// course: mappers place one pole 30-80 m apart, and an unmerged copy would warn both ways
const SAME_ROAD_CAMERA_M = 80;
const SAME_AXIS_DEG = 30;
// Two OSM-only speed cameras this close (one node per carriageway) become one
const OSM_TWIN_M = 25;
// Red-light cameras of one junction (one OSM node per approach) become one point at its centre
const JUNCTION_M = 40;
// SpeedCamOnLine often places the two directions of one pole as separate points this far apart
const REVERSE_SEARCH_M = 80;
// CityGuide type codes in the Armenia base; anything else is reported and skipped
const SCO_TYPES = {
  'ММ': 'speed',  // маломощный радар
  'СТЦ': 'speed', // стационарный радар
  'ВБ': 'speed',  // видеоблок
  'МЛЖ': null     // муляж: no enforcement
};

function distanceM(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lng - a.lng) * rad / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function angleDiff(a, b) {
  return Math.abs(((a - b) % 360 + 540) % 360 - 180);
}

function plausibleLimit(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 5 && n <= 130 ? n : null;
}

// The public Overpass instance answers 429/502/504 when busy: retry a few times
async function overpass(query) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
      signal: AbortSignal.timeout(180000)
    });
    if (res.ok) return res.json();
    if (attempt >= 5 || ![429, 502, 503, 504].includes(res.status)) throw new Error(`Overpass HTTP ${res.status}`);
    console.warn(`Overpass HTTP ${res.status}, retrying in ${attempt * 15} s`);
    await new Promise(r => setTimeout(r, attempt * 15000));
  }
}

async function loadOsm() {
  const data = await overpass(OVERPASS_QUERY);
  const speed = [];
  const redLight = [];
  for (const el of data.elements) {
    const tags = el.tags || {};
    const base = { id: `osm/node/${el.id}`, lat: Number(el.lat.toFixed(7)), lng: Number(el.lon.toFixed(7)) };
    if (tags.highway === 'speed_camera') {
      // direction is "120", "90;270" or a word (forward, NE ...): only the degrees are usable
      const directions = String(tags.direction || '').split(';').filter(v => /^\d+(\.\d+)?$/.test(v.trim())).map(Number);
      speed.push({ ...base, limit: plausibleLimit(tags.maxspeed), directions, twoWay: /;/.test(tags.direction || '') });
    } else if (tags.enforcement === 'traffic_signals') {
      redLight.push(base);
    }
  }
  return { speed, redLight, osmBase: data.osm3s?.timestamp_osm_base || null };
}

// Both exports are windows-1251 text files
async function fetchCp1251(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new TextDecoder('windows-1251').decode(await res.arrayBuffer());
}

async function loadSpeedCamOnline() {
  const [igo, cityguide] = await Promise.all([fetchCp1251(SCO_IGO_URL), fetchCp1251(SCO_TYPES_URL)]);
  // CityGuide lines: "<id>. <TYPE>|lat|lng" (the id is missing on a few lines): join on position
  const typeAt = new Map();
  for (const line of cityguide.split(/\r?\n/)) {
    const m = line.match(/^(?:\d+\.\s*)?([^|\d]+?)\s*\|(-?[\d.]+)\|(-?[\d.]+)\s*$/);
    if (m) typeAt.set(`${Number(m[2])},${Number(m[3])}`, m[1].trim());
  }
  const cameras = [];
  const skipped = {};
  for (const line of igo.split(/\r?\n/).slice(1)) {
    // IDX,X(lng),Y(lat),TYPE,SPEED,DIRTYPE(0 any, 1 one way, 2 both ways),DIRECTION(course of traffic)
    const [id, x, y, , speed, dirType, course] = line.split(',').map(Number);
    if (!Number.isFinite(id) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const code = typeAt.get(`${y},${x}`);
    const type = SCO_TYPES[code];
    if (!type) {
      skipped[code || 'no type'] = (skipped[code || 'no type'] || 0) + 1;
      continue;
    }
    cameras.push({
      id: `sco/${id}`,
      lat: y,
      lng: x,
      limit: plausibleLimit(speed),
      direction: dirType === 1 && Number.isFinite(course) ? ((course % 360) + 360) % 360 : null
    });
  }
  return { cameras, skipped };
}

function merge(osm, sco) {
  const conflicts = [];
  const cameras = sco.map(c => ({ ...c, type: 'speed', source: 'speedcamonline' }));
  let matched = 0;
  const sameAxis = (course, o) => course !== null && o.directions.some(d => {
    const diff = angleDiff(course, d);
    return diff <= SAME_AXIS_DEG || diff >= 180 - SAME_AXIS_DEG;
  });
  for (const o of osm.speed) {
    const same = cameras.filter(c => {
      if (c.source !== 'speedcamonline') return false;
      const d = distanceM(c, o);
      return d <= SAME_CAMERA_M || (d <= SAME_ROAD_CAMERA_M && sameAxis(c.direction, o));
    });
    if (!same.length) {
      // OSM often has one node per carriageway; without a course both mean the same warning
      const twin = cameras.find(c => c.source === 'osm' && c.type === 'speed' && distanceM(c, o) <= OSM_TWIN_M);
      if (twin) {
        if (o.limit) twin.limit = twin.limit ? Math.min(twin.limit, o.limit) : o.limit;
        continue;
      }
      cameras.push({ id: o.id, type: 'speed', source: 'osm', lat: o.lat, lng: o.lng, limit: o.limit, direction: null });
      continue;
    }
    matched++;
    for (const c of same) {
      // Two sources disagree on the limit: keep the lower one. A wrong low limit gives a needless
      // warning, a wrong high one a fine; the list is printed for checking by hand.
      if (o.limit && c.limit !== o.limit) {
        conflicts.push(`${c.id} (${c.lat},${c.lng}) SpeedCamOnLine ${c.limit ?? '—'} vs OSM ${o.id} ${o.limit}`);
        c.limit = c.limit ? Math.min(c.limit, o.limit) : o.limit;
      }
    }
    // OSM says the pole enforces both ways but SpeedCamOnLine knows only one: add the other way,
    // unless SpeedCamOnLine has it as a separate record a little further along the road
    const c = same[0];
    if (o.twoWay && same.length === 1 && c.direction !== null) {
      const reverse = (c.direction + 180) % 360;
      const known = cameras.some(k => k.source === 'speedcamonline' && k.direction !== null &&
        distanceM(k, o) <= REVERSE_SEARCH_M && angleDiff(k.direction, reverse) <= 45);
      if (!known) cameras.push({ ...c, id: `${c.id}-reverse`, direction: reverse });
    }
  }
  const junctions = [];
  for (const r of osm.redLight) {
    const junction = junctions.find(j => j.some(n => distanceM(n, r) <= JUNCTION_M));
    if (junction) junction.push(r);
    else junctions.push([r]);
  }
  for (const nodes of junctions) {
    const lat = nodes.reduce((s, n) => s + n.lat, 0) / nodes.length;
    const lng = nodes.reduce((s, n) => s + n.lng, 0) / nodes.length;
    cameras.push({ id: nodes[0].id, type: 'red_light', source: 'osm', lat: Number(lat.toFixed(7)), lng: Number(lng.toFixed(7)), limit: null, direction: null });
  }
  cameras.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  return { cameras, conflicts, matched };
}

// SpeedCamOnLine cameras whose limit differs from the OSM maxspeed of the nearest road: printed
// only. The nearest road can be the wrong one at junctions, so the data is not changed.
function roadLimitReport(cameras) {
  const require = createRequire(import.meta.url);
  const { loadSpeedLimitIndex, speedLimitAt } = require(path.join(ROOT, 'server.js'));
  const index = loadSpeedLimitIndex();
  return cameras
    .filter(c => c.type === 'speed' && c.source === 'speedcamonline' && c.limit)
    .map(c => ({ c, road: speedLimitAt(index, c.lng, c.lat, c.direction) }))
    .filter(({ c, road }) => road && road.source === 'osm' && road.limit !== c.limit)
    .map(({ c, road }) => `${c.id} (${c.lat},${c.lng}) camera ${c.limit} vs road ${road.limit}`);
}

const osm = await loadOsm();
const sco = OSM_ONLY ? { cameras: [], skipped: {} } : await loadSpeedCamOnline();
const { cameras, conflicts, matched } = merge(osm, sco.cameras);

const count = (pred) => cameras.filter(pred).length;
writeFileSync(OUT, JSON.stringify({
  source: OSM_ONLY
    ? ['OpenStreetMap contributors (ODbL) via Overpass API']
    : ['OpenStreetMap contributors (ODbL) via Overpass API', 'SpeedCamOnLine.ru (community database "Armenia")'],
  generatedAt: new Date().toISOString(),
  osmBase: osm.osmBase,
  counts: {
    speed: count(c => c.type === 'speed'),
    redLight: count(c => c.type === 'red_light'),
    withDirection: count(c => c.direction !== null)
  },
  cameras
}, null, 2) + '\n');

console.log(`OSM: ${osm.speed.length} speed cameras (${matched} also in SpeedCamOnLine), ${osm.redLight.length} red-light cameras`);
if (!OSM_ONLY) console.log(`SpeedCamOnLine: ${sco.cameras.length} cameras kept, skipped by type: ${JSON.stringify(sco.skipped)}`);
console.log(`Wrote ${cameras.length} cameras to ${path.relative(process.cwd(), OUT)}`);
if (conflicts.length) console.log(`\nLimit conflicts between the sources (lower kept):\n  ${conflicts.join('\n  ')}`);
if (!OSM_ONLY) {
  const road = roadLimitReport(cameras);
  if (road.length) console.log(`\nCamera limit differs from the road's OSM maxspeed (check by hand):\n  ${road.join('\n  ')}`);
}
