# 07 — Accept / edit / regenerate loop

**What to build:** the inline interactive loop around a generated draft. After generation the user sees the draft and chooses: Enter accepts, `e` opens the message in `$EDITOR` for real editing, `r` regenerates a fresh draft for the same diff. `--no-commit` prints the finished message and stops headless. Accepting with an edited message proceeds with the edited one.

**Blocked by:** 05 — Prompt + template + provider

**Status:** done

- [x] Draft shown → Enter accepts → proceeds to next stage
- [x] `e` opens `$EDITOR`; the edited message is the new draft
- [x] `r` produces a fresh draft for the same (unchanged) staged diff
- [x] `--no-commit` prints final message and exits without further interaction

## Implementation notes

**Files added/changed** (nothing committed; left for the human):
- `src/loop.ts` — the accept/edit/regenerate loop. Stage contract: `ok:"accepted"` (this draft proceeds to the next stage), `ok:"cancel"` (user quit, exit 0, nothing proceeds), `ok:false` (loud failure, its exit code). All IO is behind seams — `ask` (one key), `spawn` (the editor), TTY overrides, `env`, `regenerate` — so the loop runs headless in tests. Production key source is raw-mode single keypresses on stdin (Enter → `""`); Ctrl-C restores the terminal and re-raises SIGINT. `$EDITOR` opens the draft in a tmpfile, inherits stdio, accepts the edited text (trailing newlines stripped); no `$EDITOR` / failing editor / empty result / non-TTY stdin-or-stdout all fail loud, never a silent accept.
- `src/loop.test.ts` — 14 loop tests over the seams (Enter/e/r/q, truncated disclosure, editor failures, regeneration failure, EOF, unknown key).
- `src/main.ts` — wired the loop after generation. `--no-commit` stays exactly as 05 locked it (headless print + exit, truncated disclosure kept). Regenerate re-runs the SAME pipeline against the SAME unchanged staged diff (stagedDiff() is re-read; the staged set is never touched). Accepted drafts cross a documented stage boundary with a clear message; the actual `git commit -F -` is ticket 08 and is intentionally NOT built.
- `src/main.test.ts` — 6 new end-to-end tests driving the loop through `main` over a real staged repo with the stubbed chat seam.

**Stage boundary:** "proceeds to the next stage" means the loop returns the accepted draft and main emits a clear stage-boundary line. Ticket 08 owns the commit hand-off.

**Verified live (pty + real Ollama, model `gemma4:31b-cloud`):** Enter accepted `feat(auth): add login function`; `r` regenerated and accepted a fresh draft; `q` canceled with no commit; `e` through a real (fake-script) `$EDITOR` accepted the edited `fix(auth): corrected by $EDITOR`; `e` with `$EDITOR` unset failed loud.

**Suite:** `bun test` → 97 pass / 0 fail (was 77); `bun run typecheck` → clean.