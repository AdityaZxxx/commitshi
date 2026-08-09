# 08 — Commit via stdin

**What to build:** the accepted message becomes a real commit through the user's normal path — `git commit -F -` with the message on stdin so hooks, signing, and prepare-commit-msg all fire exactly as with their message. The tool never runs `git add`, and an empty/refused draft never yields a commit.

**Blocked by:** 07 — Accept / edit / regenerate loop

**Status:** done

- [x] Accepted message committed via `git commit -F -` (no `-m`)
- [x] Hooks (`prepare-commit-msg`, commit-msg) fire on the commit
- [x] No `git add` is ever invoked; staging contact stays exclusively the user's
- [x] `--no-commit` under no circumstances creates a commit

## Comments

**2025-08-09 (agent):** Implemented in `src/commit.ts` + wiring in `src/main.ts`. Proof in `src/commit.test.ts` — integration tests in sandboxed temp repos with real shell hooks. Suite: 107 pass / 0 fail; typecheck green. The commit seam (`deps.commit`) exists only so `main.test.ts`'s scripted 07-loop tests stay hermetic; the default path is real git against the cwd. One judgment call to note: the accepted draft is trimmed of outer whitespace and given exactly one trailing newline before going down stdin (guards `git commit`'s editor-for-body path on an empty file and keeps the commit object byte-exact). No acceptance criterion needs renegotiation.