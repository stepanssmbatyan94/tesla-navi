# Playbook: verify a change

Prove a change works in the running app. Syntax checks are not verification.

## 1. Automated (any agent, CI, human)

```bash
npm run check
npm test                               # unit tests (node:test), ~1 s, no network
npm run verify                         # all browser checks, ~45 s, needs network + Google Chrome
npm run verify -- smoke maneuvers      # selected checks
npm run verify -- route-layers --verbose
```

The runner (`scripts/verify/run.mjs`) starts its own server on port 8199 (`VERIFY_PORT` to change), opens each check in a fresh headless Chrome context and exits non-zero if any check's `pass` is false, printing the check's JSON. `CHROME_PATH=/path/to/chrome` overrides the browser.

| Change touches | Checks |
|---|---|
| anything | `smoke` (and `npm test`) |
| route steps, HUD, voice, `trackNavigationProgress`, server route parsing | `maneuvers` |
| route rendering, theme/style, cancel/arrival | `route-layers` |
| innerHTML/templates, realtime, phone packets, search/places | `security` |
| GPS sources, `initTeslaCarGps`, `handleIncomingGps` | `dual-gps` |
| UI strings, `I18N`, markup labels | `i18n` |
| Yandex provider code paths | `yandex` |
| map init, library loading, Leaflet paths | `fallback-cdn`, `fallback-webgl` |
| `phone.html`, `phone-remote.js`, `realtime.js` | `phone` |

`fallback-cdn` blocks the MapLibre script and `fallback-webgl` starts Chrome without WebGL, so they only run through the runner.

What each check asserts is written at the top of its file in `scripts/verify/checks/`.

## 2. Server checks (when `server.js` changes)

```bash
PORT=8199 node server.js &   # or reuse a running server
B=http://localhost:8199
for p in /.git/config /server.js /package.json /refs/x.jpg /node_modules/ws/package.json "/js/../server.js" /AGENTS.md; do echo "$p $(curl -s --path-as-is -o /dev/null -w '%{http_code}' $B$p)"; done   # all 404
for p in / /phone /js/realtime.js /styles/mapsev-day.json /sounds/nav-chime.wav /api/speed-cameras; do echo "$p $(curl -s -o /dev/null -w '%{http_code}' $B$p)"; done   # all 200
```

Plus endpoint-specific calls from [API.md](../API.md) for the endpoint you changed.

## 3. With a browser tool (interactive agents)

If you can drive a browser (Claude desktop browser pane, Playwright MCP, Chrome DevTools MCP, …):

1. Start a server on a free port (`PORT=8199 node server.js`), open `http://localhost:8199/?code=VERIFY1` (add `&mode=dev` for dev-panel changes; `/phone?code=VERIFY1` for the phone page).
2. Paste a whole check file from `scripts/verify/checks/` into the page's JS console/evaluate tool; each file is an async IIFE that resolves to `{ pass, … }` and finishes within 45 s.
3. Look at the page (screenshot) for visual changes; the checks don't judge layout.

Hidden tabs and some embedded browser panes don't tick `requestAnimationFrame`: drive the simulator with explicit `mapEngine.updateCarPosition(...)` calls or the "+100 m" button instead of Play.

## 4. Interpreting results

- Report each check in one line with its key numbers (e.g. `maneuvers: PASS, 9/10 and 4/4 turns match geometry`).
- A failure is a failure: report the JSON, don't explain it away. Distinguish a bug in the check from an app bug by the stack (`<anonymous>` / `evaluate` = the check script) and fix the check only when it measured the wrong thing.
- `maneuvers` mismatches right after a step shorter than 120 m are a measurement artifact (the HUD correctly shows the earlier turn); Yandex reroutes with live traffic, so routes differ between runs.
- Checks write to localStorage and restore it; if a run aborts, remove `tesla_search_history`, `tesla_saved_places`, `tesla_yt_history` manually.
- Stop any server you started.
