---
name: verify-nav
description: >
  Verify a Tesla Navi change in the running app: start the server, open the car
  screen in the built-in browser and run the bundled page checks (smoke flow,
  maneuver-vs-geometry, route layer leaks + theme swap, XSS through the phone
  channel, phone page). Use after any change to js/, server.js, index.html or
  phone.html, before saying a fix works, or when asked to "проверь", "verify",
  "test in browser", "прогони симулятор".
---

# verify-nav

Prove a change works in the real app, not just `node --check`. Each check is a self-contained page script in `checks/` that returns a JSON verdict.

## 1. Start the server

```bash
for f in server.js js/*.js js/maps/*.js; do node --check "$f" || exit 1; done
lsof -ti tcp:8199 | xargs kill 2>/dev/null
PORT=8199 node server.js   # run_in_background
```

Use port 8199 so it never collides with a server the user runs on 8085. Restart it after every `server.js` change (exit code 143 when you kill it is expected).

## 2. Open the page

Navigate the built-in browser to `http://localhost:8199/?code=VERIFY` (add `&mode=dev` only when the change is about the dev panel). Use a fresh `code` per run so stale rooms don't interfere.

## 3. Run the checks that match the change

Read the check file, paste its whole content into `javascript_tool`, read the returned JSON. Every script must finish in < 45 s (tool limit), so they never rely on `requestAnimationFrame` — the hidden browser pane doesn't tick it.

| Change touches | Run |
|---|---|
| anything | `checks/smoke.js` |
| route steps, HUD, voice, `trackNavigationProgress`, server route parsing | `checks/maneuvers.js` |
| route rendering, theme/style, cancel/arrival | `checks/route-layers.js` |
| innerHTML/templates, realtime, phone packets, search/places | `checks/security.js` |
| `phone.html`, `phone-remote.js`, `realtime.js` | navigate to `/phone?code=VERIFY`, run `checks/phone.js` |
| `server.js` static/API | the curl block below |

Pass criteria are written at the top of each script. Anything else is a failure: report it with the JSON, don't explain it away. A failure inside the check script itself (e.g. `getStyle()` undefined during a style reload) must be told apart from an app error by its stack (`<anonymous>` = the script).

Server checks:

```bash
B=http://localhost:8199
for p in /.git/config /server.js /package.json /refs/x.jpg /node_modules/ws/package.json "/js/../server.js"; do echo "$p $(curl -s --path-as-is -o /dev/null -w '%{http_code}' $B$p)"; done   # all 404
for p in / /phone /js/realtime.js /styles/mapsev-day.json /sounds/nav-chime.wav /api/speed-cameras; do echo "$p $(curl -s -o /dev/null -w '%{http_code}' $B$p)"; done   # all 200
```

## 4. Clean up

- The checks remove the localStorage keys they write; if one aborts midway, remove `tesla_search_history`, `tesla_saved_places`, `tesla_yt_history` yourself.
- Kill the server: `lsof -ti tcp:8199 | xargs kill`.
- Report each check's verdict in one line with the key numbers (e.g. "maneuvers: 8/9 turns match geometry").
