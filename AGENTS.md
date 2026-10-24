# AGENTS.md — Tesla Navi

Single source of truth for every AI coding agent working in this repo (Claude Code, Codex/GPT, Gemini CLI, Cursor, Copilot, …). Tool-specific files (`CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`) only import or point to this file. **Update this file, not the wrappers.**

## What this is

Browser navigator for the Tesla in-car browser in regions where Tesla's own navigation doesn't route (Armenia first, Georgia next). The driver's phone opens `/phone?code=XXXXXX`, streams GPS and destinations to the car screen; the car screen renders a MapLibre map with live Yandex routes and traffic, a turn-by-turn HUD, voice prompts (ru/en neural, Armenian prerecorded), lane arrows and speed cameras.

- Production: Google Cloud Run, service `tesla-navi`, project `botifyshop-453014`, region `europe-central2` → https://tesla-navi-466066606601.europe-central2.run.app (see `docs/DEPLOYMENT.md`).
- Stack: Node ≥ 20 server (`http` + `ws`, no framework), vanilla browser JS (classic scripts, no build, no bundler), MapLibre GL 4.7 from CDN, Supabase Realtime Broadcast.
- Target hardware: Tesla MCU (Intel Atom on older cars) — every map layer, DOM node and per-fix computation counts.

## Commands

```bash
npm install            # Node >= 20
npm start              # http://localhost:8085 (PORT env overrides; Cloud Run sets 8080)
npm run check          # node --check on all server/client JS
npm test               # unit tests (node:test, no network), ~1 s
npm run verify         # 11 headless browser checks (system Chrome, live network), ~45 s
npm run verify -- smoke maneuvers --verbose
node scripts/update_chargers.mjs   # refresh the OSM charging-station snapshot (~1 min)
node scripts/update_speed_limits.mjs  # refresh the OSM speed-limit + built-up snapshot (~1-4 min)
```

Manual URLs: car screen `/?code=TEST01`, simulator/diagnostics `/?mode=dev`, phone `/phone?code=TEST01`; params `provider=maplibre|yandex`, `theme=day|night|auto`.

## Repository map

```
server.js                 HTTP server: static allowlist, /api/*, /ws room relay
index.html, phone.html    The two pages (car screen, phone remote)
js/config.js              CONFIG + I18N (ru default, hy, en)
js/realtime.js            TeslaRealtime: Supabase + local WS, dedup, reconnect, heartbeat
js/maps/map-engine.js     TeslaMapEngine: map, GPS snapping, navigation loop, route render, voice
js/tesla-cockpit.js       Car-screen UI: pairing, places, search, HUD, drawers, music, dev simulator
js/phone-remote.js        Phone page: GPS watcher, wake lock, destination search
css/                      Car + phone styles
styles/                   MapLibre day/night styles + sprites (tiles: OpenFreeMap)
sounds/                   nav chime + Armenian clips sounds/hy/{gor,suzie}/<key>.mp3
data/                     Speed-camera DB, OSM charging stations and speed limits (served only via /api/*)
tests/                    Unit tests (node:test); browser scripts load in a vm with DOM stubs
scripts/verify/           npm run verify runner + page checks
scripts/update_chargers.mjs  Refreshes data/ev-chargers.json from OpenStreetMap
scripts/update_speed_limits.mjs  Refreshes data/speed-limits.json (OSM maxspeed) from OpenStreetMap
.github/workflows/ci.yml  CI: check + unit tests (blocking), browser checks (non-blocking)
scripts/generate_*.py     Armenian voice pack generators (piper; model in models/, git-ignored)
docs/                     Architecture, API, deployment, development, ADRs, playbooks
```

Agent tooling: `.agents/skills/` (Agent Skills wrappers over `docs/playbooks/`), `.claude/` (Claude Code skills, `nav-reviewer` agent, preview config), `CLAUDE.md` / `GEMINI.md` / `.github/copilot-instructions.md` (import or point to this file).

Not served and not for agents to modify casually: `refs/` (personal reference photos, git-ignored), `models/` (local TTS model), `.agents/skills/stitch/` (third-party Stitch skill, git-ignored).

## Documentation map

| Need | Read |
|---|---|
| Product overview, features, quick start | `README.md` |
| System design, components, data flows, scaling, security | `docs/ARCHITECTURE.md` |
| HTTP API and WebSocket/Supabase message formats | `docs/API.md` |
| How production is deployed, rollback, logs | `docs/DEPLOYMENT.md` |
| Local setup, workflow, debugging, conventions | `docs/DEVELOPMENT.md` |
| Why things are the way they are | `docs/adr/` |
| Step-by-step procedures for agents | `docs/playbooks/` (also exposed as skills in `.agents/skills/` and `.claude/skills/`) |
| Visual design tokens (from Stitch, partly outdated: the live UI uses the MapsEV day/night styles) | `DESIGN.md` |
| Historical task log (Russian) | `docs/HYBRID_NAVIGATION_ROADMAP.md` |

## Invariants — break these and the driver gets wrong guidance

1. **A route step's maneuver happens at the step START** (Yandex and OSRM alike). The turn at the end of step `k` is `steps[k+1]`; the HUD/voice countdown to the end of step `k` must announce `steps[k+1]`. The last step ends at the destination (arrival, not a turn).
2. **Coordinate order.** Route geometry is `[lng, lat]`; `updateCarPosition(lat, lng, …)`, `calculateDistance(lat1, lon1, …)`, Yandex `ymaps` and Leaflet take `lat` first.
3. **Yandex is authoritative** for routes and maneuvers. OSRM contributes lane arrows only, for junctions within 20 m of the Yandex polyline that OSRM leaves in the same direction.
4. **Navigation state.** Turn prompts, route cameras and arrival fire only while `isNavigating`; route preview is silent. Rerouting only on real GPS fixes.
5. **Map layers** use fixed ids (`route-alt*`, `route-full`, `route-casing`, `route-traffic`, `route-traveled*`) with data-driven colors; never one layer per segment; clear via `clearMapLibreRouteLayers()`. `setStyle` (theme switch) drops runtime layers → redraw on `style.load` (`lastRouteRender`).
6. **Realtime packets arrive twice** (Supabase + local WS) and `realtime.js` drops exact repeats (kind + timestamp + lat/lng). Anything new on the channel needs a `timestamp`.
7. **One GPS source at a time.** Phone fixes win; the car browser's own geolocation is used only when no phone fix arrived within 5 s (`PHONE_GPS_PRIORITY_MS`).
8. **Speed limits.** Priority: a route speed camera within 200 m ahead (`'camera'`) > the run the car is on in `route.speedLimits` — the OSM `maxspeed` (`'osm'`, solid sign) or, where OSM has no tag (most residential streets and yards), the legal default of the Armenian traffic rules: 60 in a built-up area, 90 outside (`'default'`, dashed sign; built-up areas come from OSM outlines in the snapshot) > the step's street-name heuristic (`'estimated'`, dashed, only without snapshot data). Without a route the same comes from `/api/speed-limit`; a dash `—` only when nothing is known. The overspeed chime fires only on `'camera'`/`'osm'` limits.
9. **Map providers.** `provider` must name the library actually running: `maplibre`, `yandex` (loaded on demand) or `osm` (Leaflet fallback when MapLibre can't load or start). Provider-specific code branches on it.

## Rules

- **Untrusted text never goes raw into `innerHTML`.** Phone packets, geocoder/Yandex names, YouTube titles, saved places, log text → `escapeHtml()` (in `tesla-cockpit.js`) or `textContent`. Validate packets from the phone channel (anyone with the 6-char code can publish).
- **No fake data presented as real** (traffic, ETAs, battery, charger availability, ping, satellites, POIs, video IDs). If data is unavailable, hide the element, show a dash or say so. Traffic exists only for Yerevan (Yandex score) and on Yandex routes; chargers come from OpenStreetMap without availability; the browser has no battery data.
- **i18n:** every user-visible string in all three `I18N` dictionaries. Voice prompts need ru/en text and an Armenian clip + mapping (`docs/playbooks/add-voice-phrase.md`).
- **Server:** new static paths go into `PUBLIC_FILES`/`PUBLIC_DIRS`; outbound fetches driven by user input stay allowlisted; give external fetches a timeout; keep caches bounded.
- **Cache busters:** changing files loaded by `index.html`/`phone.html` → bump every `?v=` in that page.
- No empty `catch (e) {}` in new code. Match surrounding style: classic scripts, globals, 2-space indent, comments explain *why*.
- Keep the MCU budget: no per-frame/per-fix O(route × cameras) scans, no unbounded DOM growth, no layers/markers per update.

## Definition of done

1. `npm run check` and `npm test` pass; new logic in `server.js`, `map-engine.js` or `realtime.js` comes with unit tests.
2. `npm run verify` passes (at least `smoke` plus the checks for the area you touched — see `docs/playbooks/verify.md`). If you have a browser tool, also look at the page.
3. Diff reviewed against `docs/playbooks/code-review.md` (`docs/playbooks/release-check.md` for the full gate).
4. Docs updated when behaviour, API, deployment or invariants change (this file first).

## Git & PRs

- Branch off `main` (`fix/…`, `feat/…`, `chore/…`); never commit to `main` directly.
- Conventional commits (`fix(nav): …`, `feat(voice): …`, `docs: …`), one logical change per commit, body says what was broken and why the fix is right.
- PR description: what changed, why, how it was verified (commands + results).

## Do not, without the owner's explicit request

- Deploy (`gcloud run deploy`), change Cloud Run settings, or touch GCP project `botifyshop-453014` (it also hosts other services).
- Push to `main`, force-push, rewrite history, or open/merge PRs.
- Send repository text to third-party services (e.g. the armtts.online voice generator).
- Commit anything from `refs/`, `models/`, local settings, or secrets. The Supabase anon key in `js/config.js` is public by design; nothing else secret belongs in the repo.
