---
name: release-check
description: >
  Pre-commit / pre-PR / pre-deploy gate for Tesla Navi: npm run check and verify,
  cache-buster bump, diff scans for raw innerHTML interpolation, fake data, empty
  catches, missing translations, static-path and .gcloudignore consistency, docs
  updates, then a nav-reviewer review. Use before committing, opening a PR or
  deploying, or when asked "можно коммитить?", "release check", "проверь перед PR".
---

# release-check

Read and follow `docs/playbooks/release-check.md` — the canonical, tool-neutral procedure for this repository (project rules: `AGENTS.md`). This file only makes the playbook discoverable as a skill.
