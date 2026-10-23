---
name: release-check
description: >
  Pre-commit / pre-PR gate for Tesla Navi: syntax-check all JS, enforce the
  cache-buster bump, scan the diff for raw innerHTML interpolation, fake data,
  empty catches, missing translations and static-path changes, then run the
  verify-nav checks. Use before committing, before opening a PR, or when asked
  "можно коммитить?", "release check", "проверь перед PR".
---

# release-check

Run against the diff you are about to commit (`git diff` + `git diff --cached`, or `git diff main...HEAD` for a whole branch). Report a short PASS/FAIL list; fix FAILs (or ask) before committing.

## 1. Syntax

```bash
for f in server.js js/*.js js/maps/*.js; do node --check "$f" || echo "FAIL $f"; done
```

## 2. Cache buster

If the diff touches anything `index.html` loads (`js/config.js`, `js/realtime.js`, `js/maps/map-engine.js`, `js/tesla-cockpit.js`, `css/tesla-display.css`), every `?v=` in `index.html` must be bumped to one new number. Same for `phone.html` (`js/config.js`, `js/realtime.js`, `js/phone-remote.js`, `css/phone-remote.css`).

```bash
grep -o '?v=[0-9]*' index.html phone.html | sort | uniq -c
```

## 3. Diff scans

Read every hit; each is a FAIL unless clearly safe.

```bash
R=main...HEAD   # range to check; for uncommitted work use: git diff -U0 HEAD
# raw interpolation into HTML (allowed only for numbers, dict.* strings, static SVG, escapeHtml(...))
git diff -U0 $R -- 'js/*' | grep -nE '^\+.*(innerHTML|insertAdjacentHTML).*\$\{'
git diff -U0 $R -- 'js/*' | grep -nE '^\+.*\$\{[^}]*\}' | grep -vE 'escapeHtml|dict\.|toFixed|Math\.|px|deg|%|svg|stroke|color' | head -40
# swallowed errors
git diff -U0 $R | grep -nE '^\+.*catch \((e|err)\) \{\s*\}'
# likely fake data: hardcoded counts/times/availability in UI strings
git diff -U0 $R -- 'js/*' | grep -nE '^\+.*(свободно|светофор|спутник|мс`|ms`|\b[0-9]{1,2}:[0-9]{2}\b)'
# new user-visible Russian strings outside I18N
git diff -U0 $R -- js/tesla-cockpit.js js/maps/map-engine.js | grep -nE "^\+.*['\`][А-Яа-я][^'\`]{3,}['\`]" | grep -v console
```

Each grep is a lead, not a verdict: `${...}` inside `escapeHtml(...)`, a `.title =` property or a template passed to `textContent` is fine.

- New `I18N` keys must exist in `ru`, `hy` and `en` (compare `grep -c` per block in `js/config.js`).
- New static files served to the browser must sit in `index.html`/`phone.html` or `css/`, `js/`, `styles/`, `sounds/` (`PUBLIC_FILES`/`PUBLIC_DIRS` in `server.js`); anything else 404s by design.
- No secrets beyond the public Supabase anon key; no personal data (addresses, names, photos) added.

## 4. Behaviour

Run the `verify-nav` skill with the checks matching the change (always `smoke.js`).

## 5. Review

For non-trivial diffs, ask the `nav-reviewer` agent to review the same range and address its findings.

## 6. Commit

Conventional commit, one logical change per commit, body says what was broken and why the fix is right. Never commit on `main`; never include `.claude/settings.local.json` or files from `refs/`, `models/`.
