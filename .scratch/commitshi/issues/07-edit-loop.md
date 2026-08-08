# 07 — Accept / edit / regenerate loop

**What to build:** the inline interactive loop around a generated draft. After generation the user sees the draft and chooses: Enter accepts, `e` opens the message in `$EDITOR` for real editing, `r` regenerates a fresh draft for the same diff. `--no-commit` prints the finished message and stops headless. Accepting with an edited message proceeds with the edited one.

**Blocked by:** 05 — Prompt + template + provider

**Status:** ready-for-agent

- [ ] Draft shown → Enter accepts → proceeds to next stage
- [ ] `e` opens `$EDITOR`; the edited message is the new draft
- [ ] `r` produces a fresh draft for the same (unchanged) staged diff
- [ ] `--no-commit` prints final message and exits without further interaction