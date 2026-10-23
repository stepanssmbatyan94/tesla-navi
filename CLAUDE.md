@AGENTS.md

# Claude Code specifics

All project knowledge lives in `AGENTS.md` (imported above) and `docs/`. This file only adds what is specific to Claude Code.

- Skills in `.claude/skills/` wrap the tool-neutral playbooks in `docs/playbooks/`: `verify-nav` (verify.md), `add-voice-phrase`, `release-check`. The `nav-reviewer` agent in `.claude/agents/` applies `docs/playbooks/code-review.md` to a diff.
- `.claude/launch.json` starts the app on port 8085 for the desktop app's browser preview.
- In the desktop browser pane `requestAnimationFrame` doesn't tick while the pane is hidden: drive the simulator with explicit `updateCarPosition` calls or the "+100 m" button, or use `npm run verify` (headless Chrome, rAF works).
- `javascript_tool` calls time out after 45 s; the checks in `scripts/verify/checks/` are written to fit, paste a whole file to run it.
