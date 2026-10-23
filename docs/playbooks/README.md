# Playbooks

Tool-neutral, step-by-step procedures for any AI agent (or human). Claude Code exposes the same procedures as skills in `.claude/skills/` and the review as the `nav-reviewer` agent; other agents read these files directly.

| Playbook | Use when |
|---|---|
| [verify.md](verify.md) | After any code change, before claiming it works |
| [release-check.md](release-check.md) | Before committing, opening a PR or deploying |
| [code-review.md](code-review.md) | Reviewing a diff or PR |
| [add-voice-phrase.md](add-voice-phrase.md) | Adding/changing a spoken prompt (ru/en/hy) |

Deployment steps live in [../DEPLOYMENT.md](../DEPLOYMENT.md).
