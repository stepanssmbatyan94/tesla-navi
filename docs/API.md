# API Reference

All endpoints are served by `server.js`. Responses are JSON unless noted. CORS is open (`Access-Control-Allow-Origin: *`). There is no authentication. `/api/*` is rate-limited per client IP (burst 60, ~120 requests/min): over the limit → `429 {"error":"Too many requests"}` with `Retry-After: 5`. Upstream calls time out after 12 s. Coordinates in route geometry are **`[lng, lat]`**; query parameters are named explicitly.

## Pages and static files

| Path | Serves |
|---|---|
| `/`, `/map` | `index.html` (car screen) |
| `/phone`, `/phone/*` | `phone.html` (phone remote) |
| `/index.html`, `/phone.html`, `/css/*`, `/js/*`, `/styles/*`, `/sounds/*` | Static files, `Cache-Control: no-cache` |
| anything else | `404` (repo files such as `server.js`, `.git`, `data/`, `refs/` are deliberately not served) |

Query parameters understood by the car screen: `code` (pairing code), `mode=dev`, `provider=maplibre|yandex`, `theme=day|night|auto` (also `on`/`off`/`dark`/`light`). Phone page: `code`.

## `GET /api/route`

Builds driving routes.

| Param | Required | Notes |
|---|---|---|
| `startLat`, `startLng`, `destLat`, `destLng` | yes | decimal degrees |
| `provider` | no | accepted for compatibility; routing is always Yandex with OSRM fallback |

**Yandex response** (`source: "yandex"`):

```json
{
  "success": true,
  "source": "yandex",
  "routes": [
    {
      "index": 0,
      "summary": "через Sarmen Street",
      "distance": 3074.06,
      "duration": 890.4,
      "durationWithoutTraffic": 362.1,
      "coordinates": [[44.515, 40.1915], "..."],
      "segments": [{ "type": "FREE|LIGHT|HARD|VERY_HARD|UNKNOWN", "color": "#82ea0d", "coords": [[44.51, 40.19], "..."] }],
      "steps": [
        {
          "index": 1,
          "name": "Galoyan Brothers Street",
          "instruction": "Поверните налево на Galoyan Brothers Street",
          "action": "LEFT",
          "modifier": "left",
          "type": "turn",
          "distance": 142.0,
          "duration": 40.1,
          "location": [44.5097, 40.1929],
          "speedLimit": 60,
          "speedLimitSource": "estimated"
        }
      ],
      "laneIntersections": [
        { "location": [44.51, 40.19], "outBearing": 182, "lanes": [{ "valid": true, "indications": ["left"] }], "name": "…", "modifier": "left", "type": "turn" }
      ],
      "specialRoadPoints": []
    }
  ]
}
```

- Routes are sorted fastest first (`duration` includes traffic, seconds; `distance` meters).
- **Step semantics:** a step's `modifier`/`action`/`location` describe the maneuver at the **start** of the step; `distance` is the length driven after it. The turn at the end of step `k` is `steps[k+1]`.
- `modifier` ∈ `straight | left | right | slight left | slight right | u-turn | roundabout`.
- `speedLimit` is a heuristic (60 city, 70 named fast avenues, 90 highways / > 14 km from Yerevan center, 110 North–South highway), not map data; `speedLimitSource` is always `"estimated"`. The client upgrades it to a verified limit only near a route speed camera.
- `laneIntersections` come from OSRM for its own route; the client keeps only junctions on the Yandex route (≤ 20 m, `outBearing` within 35°).

**OSRM fallback** (`source: "osrm"`): the raw OSRM `route/v1/driving` response (`routes[].geometry.coordinates`, `legs[0].steps[].maneuver`, …) plus `laneIntersections` per route.

Errors: `400 {"error":"Missing coordinates"}`, `500 {"error": "<message>"}`.

## `GET /api/geocode`

Search suggestions for the search drawer and place editor.

| Param | Notes |
|---|---|
| `q` | query, ≥ 2 chars (shorter → `[]`) |
| `lat`, `lng` | bias point (defaults to Yerevan center) |

Response: up to 8 items `[{ "title": "…", "subtitle": "…", "lat": 40.18, "lng": 44.51 }]`. Sources: Yandex Suggest (word-order and en_US fallbacks, org coordinates resolved for the first 4), Photon merged in when Yandex returns < 2.

## `GET /api/resolve-location`

Resolves free text, coordinates or a map share link to one point.

| Param | Notes |
|---|---|
| `url` or `q` | text, `lat,lng`, or a link (Google Maps incl. `maps.app.goo.gl`, Yandex, Apple Maps, 2GIS) |

Response: `{ "success": true, "name": "…", "lat": 40.17, "lng": 44.51 }` or `404 {"success": false, "error": "Location not found"}`.
Links are fetched only for allowlisted hosts, following at most 5 redirects, each re-checked. Order: coordinates in the text/URL → share-link expansion → Yandex Suggest → Photon → Nominatim (AM/GE).

## `GET /api/tts`

Returns `audio/mpeg`.

| Param | Notes |
|---|---|
| `text` | required, ≤ 300 chars (`400` otherwise) |
| `lang` | `ru` (default), `en`, `hy` |
| `voice` | `svetlana`/`female`, `dmitry`/`male`, `ava`, `andrew`, `gor`, `suzie`, `auto` |

- `ru`/`en`: Microsoft Edge neural voices (Svetlana/Dmitry, Ava/Andrew), cached in memory (LRU, 300 entries). `500` if synthesis fails twice.
- `hy` (or voice `gor`/`suzie`): a prerecorded clip from `sounds/hy/<voice>/`. `text` may be a clip key (`turn_left`, `dist_250_keep_left`, `uturn`, …) or Armenian text matched by keywords. Unknown phrase → `404`.

## `GET /api/speed-cameras`

`[{ "id": 130041119, "lat": 40.1637, "lng": 44.4187, "limit": 60, "direction": 120, "name": "Камера 60 км/ч" }]` — from `data/yerevan-cameras-clean.json`, `Cache-Control: max-age=86400`.

## `GET /api/chargers`

Car charging stations in Armenia from an OpenStreetMap snapshot (`data/ev-chargers.json`, refreshed with `node scripts/update_chargers.mjs`), `Cache-Control: max-age=86400`:

```json
{
  "source": "OpenStreetMap contributors (ODbL) via Overpass API",
  "generatedAt": "2026-10-23T20:22:37.062Z",
  "osmBase": "2026-10-23T20:20:51Z",
  "stations": [
    { "id": "node/123", "name": "EVAN", "operator": "EVAN", "lat": 40.18, "lng": 44.51, "capacity": 2,
      "sockets": ["Type 2", "CCS2"], "maxPowerKw": 50, "openingHours": "24/7", "fee": "yes", "address": "…" }
  ]
}
```

Any field except `id`, `lat`, `lng`, `sockets` may be `null` (OSM data is incomplete). There is no availability information.

## `GET /api/traffic-yerevan`

| Param | Notes |
|---|---|
| `lat`, `lng` | optional; selects Yerevan / another Armenian city / highway |

Yerevan: `{ "success": true, "city": "Ереван", "score": 5, "icon": "yellow", "color": "#eab308", "hint": "…", "time": "…", "source": "yandex" }` (Yandex XML, cached 60 s). Anywhere else there is no traffic data: `{ "success": true, "available": false, "city": "Гюмри" | null, "source": "none" }`. Upstream failure → `{ "success": false, "fallback": true }`. The client shows a dash in both no-data cases.

## `GET /api/yt-search`, `GET /api/yt-suggestions`

- `yt-search?q=…` or `?continuation=<token>` → `{ success, results: [{ id, title, duration, channel, thumbnail }], continuationToken }` (scraped YouTube).
- `yt-suggestions?q=…` → `{ success, suggestions: ["…"] }`.

## Realtime messages

Transport: Supabase Realtime Broadcast channel `pair-<code lowercase>` (event name = message type) **and** WebSocket `/ws?room=<code lowercase>` (JSON text frames `{"event": "<type>", "payload": {…}}`; the server relays each frame to the other room members). Every message is sent over both; receivers drop exact repeats (same kind, `timestamp`, `lat`, `lng`).

| Event | Direction | Payload |
|---|---|---|
| `gps_update` | phone → car | `{ lat, lng, heading (deg, 0 if unknown), speed (m/s), accuracy (m), timestamp (ms) }` |
| `destination_set` | phone → car | `{ name (≤ 120 chars used), lat, lng, timestamp }` — validated by the car |
| `ping` | both | `{ role: "display" \| "phone", timestamp }` every 4 s |

Any client knowing the code can publish to the channel; treat payloads as untrusted.
