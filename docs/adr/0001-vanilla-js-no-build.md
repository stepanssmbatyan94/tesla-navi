# 0001 — Vanilla JS classic scripts, no build step

- Status: Accepted
- Date: 2026-10-23 (documents the original design)

## Context

The car screen runs in the Tesla browser on a weak MCU and must start fast and stay responsive for whole trips. The project is developed largely by AI agents and deployed as plain files.

## Decision

Plain HTML + classic `<script>` files in a fixed load order, globals instead of modules, no framework, no bundler, third-party libraries (MapLibre, supabase-js, Yandex Maps JS) from CDNs. Cache busting by `?v=` query strings.

## Consequences

- + Zero build tooling, instant reload, small runtime, easy to deploy as static files.
- − Global namespace collisions, large files (`tesla-cockpit.js` ~4k lines), no type checking, no tree shaking, manual cache busters.
- − Harder to unit test; logic is coupled to the DOM.
- Revisit when splitting files: native ES modules (`<script type="module">`) work in the Tesla browser without a bundler and would be the first step.
