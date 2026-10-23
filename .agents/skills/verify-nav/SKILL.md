---
name: verify-nav
description: >
  Verify a Tesla Navi change in the running app: npm run verify (headless Chrome
  checks: smoke flow, maneuver-vs-geometry, route layer leaks + theme swap, XSS
  through the phone channel, phone page), server curl checks and a visual look at the
  page. Use after any change to js/, server.js, index.html or
  phone.html, before saying a fix works, or when asked to "проверь", "verify",
  "test in browser", "прогони симулятор".
---

# verify-nav

Read and follow `docs/playbooks/verify.md` — the canonical, tool-neutral procedure for this repository (project rules: `AGENTS.md`). This file only makes the playbook discoverable as a skill.
