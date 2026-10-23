@./AGENTS.md

# Gemini CLI specifics

All project knowledge lives in `AGENTS.md` (imported above) and `docs/`. If the import above did not load, read `AGENTS.md` before doing anything else.

- Procedures: `docs/playbooks/` (verify, release-check, code-review, add-voice-phrase).
- Deployment to Cloud Run is described in `docs/DEPLOYMENT.md`. Deploy only when the owner asks in the current conversation, and run `npm run check && npm run verify` first.
