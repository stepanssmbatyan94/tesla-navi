---
name: verify-nav
description: >
  Verify a Tesla Navi change in the running app: npm run verify (headless Chrome
  checks: smoke flow, maneuver-vs-geometry, route layer leaks + theme swap, XSS
  through the phone channel, phone page), server curl checks, and a look at the
  page in the browser pane. Use after any change to js/, server.js, index.html or
  phone.html, before saying a fix works, or when asked to "проверь", "verify",
  "test in browser", "прогони симулятор".
---

# verify-nav

Follow `docs/playbooks/verify.md` — it is the canonical procedure shared with every agent. Read it first, then:

1. `npm run check`, then `npm run verify` with the checks matching the change (run in the foreground; ~30 s for all).
2. For server changes, the curl block from the playbook.
3. For visible UI changes, also open the page in the desktop browser pane (start `PORT=8199 node server.js` in the background, navigate to `http://localhost:8199/?code=VERIFY1`) and take a screenshot. To run a check interactively, paste the whole file from `scripts/verify/checks/` into `javascript_tool` (fits the 45 s limit). The pane doesn't tick `requestAnimationFrame` while hidden.
4. Report one line per check with its key numbers; stop servers you started.
