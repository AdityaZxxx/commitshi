# 08 — Commit via stdin

**What to build:** the accepted message becomes a real commit through the user's normal path — `git commit -F -` with the message on stdin so hooks, signing, and prepare-commit-msg all fire exactly as with their message. The tool never runs `git add`, and an empty/refused draft never yields a commit.

**Blocked by:** 07 — Accept / edit / regenerate loop

**Status:** ready-for-agent

- [ ] Accepted message committed via `git commit -F -` (no `-m`)
- [ ] Hooks (`prepare-commit-msg`, commit-msg) fire on the commit
- [ ] No `git add` is ever invoked; staging contact stays exclusively the user's
- [ ] `--no-commit` under no circumstances creates a commit