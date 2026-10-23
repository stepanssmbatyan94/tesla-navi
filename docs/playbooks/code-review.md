# Playbook: code review

Review a Tesla Navi diff for real defects. Wrong output here means a driver gets a wrong instruction at an intersection, so look for correctness, safety and security problems, not style.

## Procedure

1. Read [AGENTS.md](../../AGENTS.md) (invariants and rules).
2. Read the diff and its commits: `git diff <range>`, `git log --oneline <range>` (e.g. `main...HEAD`).
3. Read enough surrounding code to judge each hunk; never judge a hunk that calls into code you haven't read.
4. Stay read-only: no edits, commits, pushes or deploys while reviewing.

## Checklist

1. **Maneuver alignment.** The turn at the end of step k is `steps[k+1]`; anything announcing, displaying or counting down to a turn uses the next step for the current step's end distance. Last step → arrival, not a turn.
2. **Coordinate order.** Route geometry `[lng, lat]`; `updateCarPosition(lat, lng)`, `calculateDistance(lat1, lon1, …)`, `ymaps`, Leaflet take lat first. Check every boundary the diff crosses.
3. **Map layer lifecycle.** Fixed ids, cleared via `clearMapLibreRouteLayers()`, no per-segment layers, runtime layers redrawn after `setStyle`/`style.load`, markers removed on cancel/arrival.
4. **Untrusted text.** Phone packets, geocoder/Yandex/Photon names, YouTube titles/suggestions, saved places, logged values never reach `innerHTML`/`insertAdjacentHTML`/attribute templates without `escapeHtml()`; destination packets validated.
5. **Navigation state.** Voice, route cameras and arrival only while `isNavigating`; rerouting only on real fixes; nothing double-fires per packet (packets arrive over Supabase and WS, deduped by `timestamp`).
6. **Fake data.** New hardcoded traffic, ETA, counts, availability, ping, POI coordinates or video IDs presented as real are defects.
7. **i18n & voice.** UI strings in all three dictionaries; voice prompts have Armenian clips and a `getArmenianAudio` mapping that doesn't shadow existing phrases.
8. **Server.** Static serving limited to the allowlist; user-driven outbound fetches allowlisted (SSRF); external fetches have timeouts; caches bounded; new endpoints documented in `docs/API.md`.
9. **MCU performance.** No per-frame/per-fix O(route × cameras) scans, no unbounded DOM growth, no layers/markers created per update.
10. **Deploy safety.** Cache busters bumped; runtime files not excluded by `.gcloudignore`; nothing secret or personal committed.

## Report format

For each finding: `file:line`, one-sentence defect, a concrete failure scenario (inputs → wrong output), severity (critical = wrong/unsafe guidance or security; serious = broken feature; minor). Report only what you verified by reading code; mark anything else "unverified". Order by severity. If nothing survives, say so plainly — no padding with style nits. End with one line: the most important thing to fix before merging, or "ready to merge".
