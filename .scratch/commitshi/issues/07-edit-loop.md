# 07 — Accept / edit / regenerate loop

**What to build:** the inline interactive loop around a generated draft. After generation the user sees the draft and chooses: Enter accepts, `e` opens the message in `$EDITOR` for real editing, `r` regenerates a fresh draft for the same diff. `--no-commit` prints the finished message and stops headless. Accepting with an edited message proceeds with the edited one.

**Blocked by:** 05 — Prompt + template + provider

**Status:** done

- [x] Draft shown → Enter accepts → proceeds to next stage
- [x] `e` opens `$EDITOR`; the edited message is the new draft
- [x] `r` produces a variant of the commit draft for the same (unchanged) staged diff — subject wording differs from the prior draft
- [ ] verified live on NIM that the initial draft is deterministic (temperature: 0) and `r` produces a varied draft (temperature: 0.3)
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

## Resolution

**Amendment (ticket r):** the regenerate path now bumps sampling temperature on the wire request, so `r` produces a variant instead of an identical re-fetch.

- Initial draft temperature: 0 (unchanged — the model's deterministic best guess).
- Regenerate temperature: 0.3 (a small, targeted nudge toward varied wording).
- Implementation: a module-scoped `regenerateTemperatureOverride` in `src/pipeline.ts`, captured-then-reset at the very top of `generateDraft()` so it can never leak from a regenerate call into a subsequent initial call. The override is set ONLY by the regenerate call site at `src/main.ts:203` (via the exported `setRegenerateTemperatureOverride(0.3)` setter, in a try/finally that clears it after the call).
- Spec update: `.scratch/commitshi/spec.md` line 39 area now reads `--regenerate` as "produce a fresh variant of the commit draft for the same diff (temperature is bumped only on regenerate, so the first draft is the model's best guess and `r` explores alternatives)", with a follow-up paragraph documenting the temperature split and the reset-on-entry safety belt.
- Tests: 5 new tests cover the wire request — initial = 0, regenerate = 0.3, no leak across calls, reset-on-entry even when the caller forgets to clear, and an end-to-end drive through `main.ts` over a real staged repo with two `r` presses that captures `[0, 0.3, 0.3]`. Suite: 166 pass / 0 fail (was 161); `bun run typecheck` clean.
- Live NIM verification: not exercised in this session (interactive `script -q` not feasible headless); left for the user.