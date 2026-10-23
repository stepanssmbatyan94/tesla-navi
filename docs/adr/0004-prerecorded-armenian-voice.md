# 0004 — Prerecorded Armenian voice clips

- Status: Accepted
- Date: 2026-10-23 (documents the existing design)

## Context

Microsoft Edge neural TTS (used for Russian and English) has no Armenian voice. Drivers in Armenia expect Armenian guidance.

## Decision

Armenian prompts are a fixed set of clips per voice (`sounds/hy/gor`, `sounds/hy/suzie`), generated offline with a local piper model (`scripts/generate_armenian_pack.py`; older Suzie clips from armtts.online). `/api/tts?lang=hy` maps a clip key or keywords in Armenian text to a file via `getArmenianAudio()`; unknown phrases return 404 (only the chime plays).

## Consequences

- + Instant playback, no runtime dependency for Armenian, consistent quality.
- − Only fixed phrases: no street names or arbitrary distances in Armenian; every new prompt needs clips for both voices plus a mapping (`docs/playbooks/add-voice-phrase.md`).
- − Keyword matching is order-sensitive (`աջ` is also inside `առաջ`); specific matches must precede generic ones.
