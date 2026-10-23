# 0002 — Yandex Maps page data for routing, traffic and search

- Status: Accepted (high risk)
- Date: 2026-10-23 (documents the existing design)

## Context

Armenia needs routes that account for live traffic and local addresses in Russian/Armenian. Open routers (OSRM) have no traffic; Google Directions is paid and has no Yandex-level local traffic. Yandex has the best coverage and traffic for Yerevan but no suitable public routing API for this use.

## Decision

The server fetches the public Yandex Maps routes page and parses the embedded `state-view` JSON (`config.routerResponse.routes`), uses Yandex Suggest for search and the Yandex traffic XML for the city score. OSRM's public server provides lane data and a fallback route. Photon and Nominatim back up geocoding.

## Consequences

- + Best available routes, alternatives and traffic colors for the region at zero cost.
- − Undocumented format: any Yandex change breaks routing silently (watch for `source:"osrm"` responses). Possible terms-of-service and IP-blocking issues, especially from cloud IPs.
- − OSRM's route differs from Yandex's, so lane data must be matched geometrically (≤ 20 m, same exit direction) and OSRM never overrides Yandex maneuvers.
- Mitigations to consider: response-shape monitoring, a licensed routing provider, caching frequent routes.
