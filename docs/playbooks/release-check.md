# Playbook: release check (before commit / PR / deploy)

Run against the diff you are about to ship and report a short PASS/FAIL list. Fix FAILs (or ask the owner) before committing.

## 1. Syntax and behaviour

```bash
npm run check
npm run verify            # or the subset from verify.md, always including smoke
```

## 2. Cache busters

Changed any file loaded by `index.html` (`js/config.js`, `js/realtime.js`, `js/maps/map-engine.js`, `js/tesla-cockpit.js`, `css/tesla-display.css`)? Every `?v=` in `index.html` must be bumped to one new number. Same for `phone.html` (`js/config.js`, `js/realtime.js`, `js/phone-remote.js`, `css/phone-remote.css`).

```bash
grep -o '?v=[0-9]*' index.html phone.html | sort | uniq -c
```

## 3. Diff scans

Each hit is a lead to read, not a verdict: `${…}` inside `escapeHtml(…)`, a `.title =` property or `textContent` is fine.

```bash
R=main...HEAD   # range to check; for uncommitted work use HEAD
# raw interpolation into HTML (allowed only for numbers, dict.* strings, static SVG, escapeHtml(...))
git diff -U0 $R -- 'js/*' | grep -nE '^\+.*(innerHTML|insertAdjacentHTML).*\$\{'
git diff -U0 $R -- 'js/*' | grep -nE '^\+.*\$\{[^}]*\}' | grep -vE 'escapeHtml|dict\.|toFixed|Math\.|px|deg|%|svg|stroke|color' | head -40
# swallowed errors
git diff -U0 $R | grep -nE '^\+.*catch \((e|err)\) \{\s*\}'
# likely fake data: hardcoded counts/times/availability in UI strings
git diff -U0 $R -- 'js/*' | grep -nE '^\+.*(свободно|светофор|спутник|мс`|ms`|\b[0-9]{1,2}:[0-9]{2}\b)'
# user-visible Russian strings outside I18N
git diff -U0 $R -- js/tesla-cockpit.js js/maps/map-engine.js | grep -nE "^\+.*['\`][А-Яа-я][^'\`]{3,}['\`]" | grep -v console
```

(Write these as separate commands as shown: in zsh a command stored in a variable with spaces is not word-split.)

## 4. Consistency

- New `I18N` keys exist in `ru`, `hy` and `en` (`js/config.js`).
- New static files served to browsers live in `index.html`/`phone.html` or `css/ js/ styles/ sounds/` (`PUBLIC_FILES`/`PUBLIC_DIRS`).
- New runtime files are not excluded by `.gcloudignore` (`gcloud meta list-files-for-upload` lists what a deploy uploads).
- Docs updated when behaviour/API/deploy/invariants changed: `AGENTS.md`, `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`.
- No secrets beyond the public Supabase anon key; no personal data (addresses, names, photos); nothing from `refs/`, `models/`, local settings.

## 5. Review

Review the same range with [code-review.md](code-review.md) (Claude Code: the `nav-reviewer` agent) and address its findings.

## 6. Commit

Conventional commit, one logical change per commit, body says what was broken and why the fix is right. Never commit on `main`.
