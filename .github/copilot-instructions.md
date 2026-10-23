# Copilot instructions — Tesla Navi

Read and follow `AGENTS.md` at the repository root: it is the single source of truth for every AI agent in this repo (architecture map, navigation invariants, rules, definition of done, git conventions). Detailed docs are in `docs/` (ARCHITECTURE, API, DEPLOYMENT, DEVELOPMENT, adr/, playbooks/).

The rules that matter most when suggesting code:

- A route step's maneuver happens at the step START: the turn at the end of step `k` is `steps[k+1]`.
- Route geometry is `[lng, lat]`; `updateCarPosition` / `calculateDistance` take `lat` first.
- Never interpolate untrusted text into `innerHTML` without `escapeHtml()`.
- No fake data presented as real; every UI string in all three `I18N` dictionaries (ru, hy, en).
- Bump `?v=` cache busters in `index.html` / `phone.html` when their assets change.
