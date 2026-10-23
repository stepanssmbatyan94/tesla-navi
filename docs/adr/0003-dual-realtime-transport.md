# 0003 — Supabase Broadcast + local WebSocket relay

- Status: Accepted, revisit
- Date: 2026-10-23 (documents the existing design)

## Context

The phone streams ~1 GPS fix per second to the car with minimal latency; no accounts, no persistence. The reference product (tmap.ge) uses Supabase Realtime Broadcast.

## Decision

Both pages join Supabase Broadcast channel `pair-<code>` and the server's in-memory `/ws?room=<code>` relay, send every message over both, and dedupe on the receiver by sender `timestamp`. The local relay reconnects with backoff.

## Consequences

- + Works when either transport is down; local development works without Supabase.
- − On Cloud Run the `/ws` rooms are per instance (0–3 instances, no session affinity) and WebSockets are cut at the 300 s request timeout, so the local relay is unreliable in production; Supabase is effectively primary there.
- − The channel is open to anyone with the code: all payloads are untrusted and validated/escaped.
- Options: session affinity or max 1 instance; a shared broker (Redis pub/sub) for rooms; or Supabase-only in production with the relay for development.
