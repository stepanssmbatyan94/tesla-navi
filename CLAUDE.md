# Tesla Navi

Browser navigator for the Tesla in-car browser (Armenia/Georgia, where the built-in nav doesn't route). The phone opens `/phone?code=XXXXXX`, streams GPS + destinations to the car screen over Supabase Broadcast **and** a local WebSocket relay; the car screen renders a MapLibre map with Yandex routes/traffic, turn-by-turn HUD, voice, lanes and speed cameras.

Vanilla JS, no build step, no framework, no tests yet. Target hardware is a weak MCU (Intel Atom on older cars): every layer, DOM node and per-frame computation counts.

## Run

```bash
npm install
npm start            # node server.js, PORT defaults to 8085
```

- Car screen: `http://localhost:8085/?code=TEST01` · simulator & diagnostics: `?mode=dev`
- Phone remote: `http://localhost:8085/phone?code=TEST01`
- Other URL params: `provider=maplibre|yandex`, `theme=day|night|auto`
- Syntax check (there is no linter): `for f in server.js js/*.js js/maps/*.js; do node --check "$f"; done`

## Map of the code

| File | What lives there |
|---|---|
| `server.js` | Static allowlist, `/api/route` (scrapes Yandex router state-view + OSRM for lanes), `/api/geocode` & `/api/resolve-location` (Yandex Suggest → Photon → Nominatim), `/api/tts` (Edge neural voices; Armenian = prerecorded mp3 via `getArmenianAudio`), traffic, YouTube, `/ws` room relay |
| `js/realtime.js` | `TeslaRealtime`: Supabase + local WS, dedup by sender `timestamp`, WS reconnect, heartbeat |
| `js/maps/map-engine.js` | `TeslaMapEngine`: map init, GPS snapping, `trackNavigationProgress` (HUD/voice/cameras/arrival), route rendering, theme, voice |
| `js/tesla-cockpit.js` | All car-screen UI: i18n apply, pairing, saved places, search, route drawer, HUD, chargers, YouTube, dev simulator |
| `js/phone-remote.js` | Phone page: GPS watcher, wake lock, destination search |
| `js/config.js` | `CONFIG` + `I18N` dictionaries (ru default, hy, en) |
| `styles/` | MapLibre day/night styles + sprites · `sounds/hy/{gor,suzie}/` Armenian clips · `data/` camera DB (served only via API) |

## Invariants — break these and navigation lies to the driver

- **A route step's maneuver happens at the step START.** For both Yandex and OSRM, the turn at the end of step `k` is `steps[k+1]`. The HUD/voice countdown to the end of step `k` must announce `steps[k+1]` (see `trackNavigationProgress`). The route-steps list in the drawer shows steps as-is.
- Coordinates from routes are `[lng, lat]`; `updateCarPosition(lat, lng, …)` and Yandex `ymaps` take `lat, lng`. Check the order at every boundary.
- Yandex is the authoritative route/maneuver source. OSRM only contributes lane arrows, and only for junctions within 20 m of the Yandex polyline that OSRM leaves in the same direction.
- Turn prompts, route cameras and arrival only fire while `isNavigating`; route preview stays silent.
- MapLibre route rendering uses fixed ids (`route-alt*`, `route-full`, `route-casing`, `route-traffic`, `route-traveled*`) with data-driven colors. Never create one layer per segment; clear through `clearMapLibreRouteLayers()`.
- `setStyle` (theme switch) drops runtime layers: anything drawn at runtime must be redrawn on `style.load` (see `lastRouteRender`).

## Rules

- **Untrusted text never goes raw into `innerHTML`.** Phone packets, geocoder/Yandex names, YouTube titles, saved places and log text go through `escapeHtml()` (in `tesla-cockpit.js`) or `textContent`.
- **No fake data presented as real.** Don't invent traffic, ETAs, charger availability, ping, POIs or video IDs. If data is unavailable, hide the element or say so. (Legacy fakes still exist — don't add new ones; remove them when touching that code.)
- Every user-visible string goes into all three `I18N` dictionaries; voice phrases need ru + en neural text and an Armenian clip (use the `add-voice-phrase` skill).
- New static paths must be added to `PUBLIC_FILES` / `PUBLIC_DIRS` in `server.js`; the rest of the repo is deliberately not served.
- When a change touches files loaded by `index.html` or `phone.html`, bump the `?v=` cache buster in that page (the Tesla browser caches aggressively).
- Empty `catch (e) {}` hides real failures: log or handle instead.
- Match the surrounding style: classic scripts (no modules), globals, 2-space indent, comments that explain *why*.

## Verifying changes

Syntax-checking is not verification. Run the app and use the `verify-nav` skill (dev simulator, maneuver-vs-geometry check, layer leak and console-error checks). Use `release-check` before committing and the `nav-reviewer` agent to review a diff.

Note: in the Claude desktop browser pane `requestAnimationFrame` doesn't tick while the pane is hidden, so drive the simulator with explicit `updateCarPosition` calls or the "+100 m" button instead of Play.

## Git

Conventional commits (`fix(nav): …`, `feat(voice): …`), one logical fix per commit, body explains the bug and why. Branch off `main`; never commit to `main` directly.
