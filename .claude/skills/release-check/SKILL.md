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

Follow `docs/playbooks/release-check.md` (canonical, shared with every agent). Run each scan command separately as written there (zsh doesn't word-split a command stored in a variable). For step 5 use the `nav-reviewer` agent on the same range. Report a PASS/FAIL list and fix or ask before committing.
