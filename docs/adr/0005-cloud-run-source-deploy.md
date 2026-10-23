# 0005 — Google Cloud Run source deploy

- Status: Accepted
- Date: 2026-10-23 (documents the existing setup)

## Context

The app needs HTTPS (phone geolocation, wake lock), WebSockets and a Node runtime, with near-zero cost at low traffic.

## Decision

Deploy with `gcloud run deploy tesla-navi --source .` to project `botifyshop-453014`, region `europe-central2`, using Google buildpacks (no Dockerfile). 0–3 instances, 512 MiB, timeout 300 s. Upload contents controlled by `.gcloudignore`.

## Consequences

- + Managed HTTPS, scale to zero, no container maintenance.
- − Cold starts; per-instance memory (WS rooms, caches) — see ADR 0003.
- − Manual deploys from a laptop upload the working directory as-is; shared GCP project with other services.
- Next steps: CI deploy from `main`, dedicated project, decide on session affinity / max instances.
