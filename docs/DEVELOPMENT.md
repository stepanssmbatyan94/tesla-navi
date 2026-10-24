# Development Guide

## Prerequisites

- Node.js ≥ 20 (production uses Node 24 via Cloud Run buildpacks)
- Google Chrome (used headless by `npm run verify`; no browser download)
- Optional: `ngrok` for testing on a real phone/car, `gcloud` for deployment, `piper` + `ffmpeg` for Armenian voice clips

## Setup and run

```bash
npm install
npm start                    # http://localhost:8085   (PORT=xxxx to change)
```

| URL | What |
|---|---|
| `/?code=TEST01` | Car screen paired to room `TEST01` |
| `/?mode=dev&code=TEST01` | Car screen + simulator (preset routes, speeds 60–250 km/h, scrub, ±100 m) and diagnostics (mic, voices, YouTube, log) |
| `/phone?code=TEST01` | Phone remote for the same room |
| `?provider=yandex` | Yandex Maps JS instead of MapLibre |
| `?theme=day|night|auto` | Force a theme |
| `/phone?code=…&lang=hy` | Phone remote in a given language (the car's QR adds it) |

Open the car screen and the phone page in two tabs with the same `code` to test pairing on one machine.

### Real phone / car

Geolocation and wake lock need HTTPS. Either use production, or tunnel your local server:

```bash
npm start
ngrok http 8085              # open https://<id>.ngrok.app/?code=… in the car, scan the QR with the phone
```

## Folder structure

```
.
├── server.js                  HTTP + WebSocket server (all endpoints in one handler)
├── index.html                 Car screen markup (drawers, modals, HUD, dev panel)
├── phone.html                 Phone remote markup
├── js/
│   ├── config.js              CONFIG (Supabase, default center, styles) + I18N (ru, hy, en)
│   ├── realtime.js            TeslaRealtime (Supabase + /ws, dedup, reconnect, heartbeat)
│   ├── maps/map-engine.js     TeslaMapEngine (map, snapping, navigation loop, routes, theme, voice)
│   ├── tesla-cockpit.js       Car UI controller (pairing, places, search, HUD, drawers, music, dev)
│   └── phone-remote.js        Phone controller (GPS, wake lock, destination search)
├── css/                       tesla-display.css (car), phone-remote.css (phone)
├── styles/                    mapsev-day.json, mapsev-night.json, sprites/
├── sounds/                    nav-chime.wav, hy/{gor,suzie}/*.mp3 (+ legacy hy/*.mp3)
├── data/                      yerevan-cameras-clean.json, ev-chargers.json (served via /api), yerevan-cameras.json (raw)
├── tests/                     npm test: node:test unit tests; helpers/browser-context.js loads js/*.js in a vm
├── scripts/
│   ├── verify/run.mjs         npm run verify runner (headless Chrome, per-check blocking/flags)
│   ├── verify/checks/*.js     Page checks (also pasteable into a browser console)
│   ├── update_chargers.mjs    Refresh data/ev-chargers.json from OpenStreetMap
│   └── generate_*.py          Armenian voice pack generators
├── docs/                      ARCHITECTURE, API, DEPLOYMENT, DEVELOPMENT, adr/, playbooks/
├── AGENTS.md                  AI agent instructions (CLAUDE.md, GEMINI.md, .github/ point here)
├── DESIGN.md                  Design tokens (Stitch)
├── .claude/                   Claude Code skills/agent/launch config (wrappers over docs/playbooks)
├── .github/workflows/ci.yml   CI: check + unit tests (blocking), browser checks (non-blocking)
└── .gcloudignore              What Cloud Run source deploys upload
```

Git-ignored, local only: `node_modules/`, `refs/` (reference screenshots/photos), `models/` (piper Armenian model), `.agents/` (Stitch skill), `.stitch.json`.

## Workflow

1. Branch off `main`: `fix/…`, `feat/…`, `chore/…`, `docs/…`.
2. Make the change following [AGENTS.md](../AGENTS.md) rules and invariants.
3. `npm run check`, `npm test` and `npm run verify` (see [playbooks/verify.md](playbooks/verify.md)); add unit tests for new logic in `server.js`, `map-engine.js` or `realtime.js`; look at the page yourself for UI changes.
4. Review the diff with [playbooks/code-review.md](playbooks/code-review.md); full gate: [playbooks/release-check.md](playbooks/release-check.md).
5. Conventional commit per logical change; PR with what/why/how verified.
6. Deploy after merge: [DEPLOYMENT.md](DEPLOYMENT.md).

## Conventions

- **Classic scripts, globals, no build.** Load order matters (`config` → `realtime` → `map-engine` → `tesla-cockpit`). Top-level `const`/`function` names are global: check for collisions.
- **Cache busters.** Bump every `?v=` in `index.html` / `phone.html` when files they load change — the Tesla browser caches hard.
- **i18n.** Add keys to `I18N.ru`, `I18N.hy`, `I18N.en`; render via `data-i18n`, `data-i18n-title`, `data-i18n-placeholder` or `I18N[lang]` lookups. `applyLanguage()` re-renders dynamic UI.
- **Escaping.** External/untrusted text → `escapeHtml()` or `textContent`.
- **Voice.** `mapEngine.speakVoice(text)`; ru/en go to Edge TTS, Armenian needs a clip ([playbooks/add-voice-phrase.md](playbooks/add-voice-phrase.md)).
- **Map layers.** Add sources/layers with fixed ids, remove them in `clearMapLibreRouteLayers()` (or an equivalent), redraw after `setStyle`.
- **Server endpoints.** One `if (pathname === '/api/…')` block per endpoint in `server.js`; timeouts on external fetches; document it in [API.md](API.md).

## Common tasks

| Task | Where |
|---|---|
| New UI string | `js/config.js` (3 dictionaries) + markup `data-i18n` |
| New API endpoint | `server.js` handler + `docs/API.md` |
| Change route parsing | `parseYandexRoutes` in `server.js` → `npm test`, `npm run verify -- maneuvers` |
| Change guidance/HUD logic | `map-engine.js` `trackNavigationProgress` → `verify -- smoke maneuvers` |
| New map layer | `map-engine.js` render + clear + style-swap redraw → `verify -- route-layers` |
| New voice prompt | [playbooks/add-voice-phrase.md](playbooks/add-voice-phrase.md) |
| New static asset folder | `PUBLIC_DIRS` in `server.js` |
| Refresh charging stations | `node scripts/update_chargers.mjs` (Overpass, ~1 min), commit `data/ev-chargers.json` |
| Map-provider code | branch on `mapEngine.provider` (`maplibre` / `yandex` / `osm`) → `verify -- yandex fallback-cdn fallback-webgl` |

## Debugging

- `?mode=dev` shows the dev pill: simulator tab drives the car along the route; diagnostics tab tests mic, all voices, YouTube and mirrors the console (dev mode only).
- `window.mapEngine` is the engine instance; useful: `mapEngine.routeSteps`, `mapEngine.currentStepIndex`, `mapEngine.updateCarPosition(lat, lng, heading, kmh, true)`, `mapEngine.getPositionAtDistance(m)`.
- `handleIncomingGps({lat, lng, speed, heading, timestamp})` and `handleIncomingDestination({name, lat, lng})` simulate phone packets.
- Server logs warnings for upstream failures (`Yandex route fetch warning`, `OSRM …`, `[NeuralTTS] …`).
- Headless browsers and hidden tabs throttle `requestAnimationFrame`; drive the simulator with explicit position updates when automating.
