# 13 — Commit draft presentation

**What to build:** the generated commit message is the *product* of this tool. Right now it's printed bare (`\n${draft}\n\n${PROMPT}`), with no framing, no file context, and no sense of "this is what you've been waiting for." Add a presentation layer that:

- Segments the interactive output into clear sections (staged changes / draft / prompt) using horizontal-rule labels, not enclosing boxes.
- Shows the per-file stat (already in `compacted.numstat`) above the draft so the user has file-level context.
- Shows draft N (where N=1 is the first generation; r increments).
- Pulls the truncation note out of stderr into the staged-changes label as a ` (truncated)` badge.
- Adds three restrained color roles: muted (grey) for stage direction, accent (green) for the draft subject, warn (amber) for the truncation badge.
- Honors `NO_COLOR` and falls back to unstyled output on non-TTY streams and in `--no-commit` mode.

**Blocked by:** none (but 12 should land first — it moves the truncation note to stdout, which this ticket relies on).

**Status:** done

- [x] A `presentDraft` function that takes a draft + context (truncated, regenerations count, numstat, isTTY, color) and emits the sectioned output to stdout.
- [x] `loop.ts` calls `presentDraft` instead of `deps.stdout.write(`\n${draft}\n\n${PROMPT}`)`.
- [x] `regenerating — draft N ›` carries the draft number during the model call.
- [x] Truncation note renders as a ` (truncated)` badge in the staged-changes label, not a separate stderr line.
- [x] Color emission is gated by TTY + `NO_COLOR`; tests + CI get stable plain text.
- [x] `--no-commit` output stays clean: bare draft text, no labels, no color. (The presentation is for interactive use.)

## Design

### Output shape (interactive mode, TTY + color, no truncation)

```
─── staged changes ─────────────────────
  app.js         +2 -0
  tests/app.js   +1 -0

─── draft 1 ─────────────────────────────
  feat(app): handle negative numbers in add function    ← subject rendered in accent (green)
  Handle the edge case where the user passes negative
  numbers to add().

  [Enter] accept · [e] edit · [r] regenerate · [q] quit ›     ← prompt in muted (grey), keys default
```

Plain-text version of the same output (TTY but `NO_COLOR` set, or `CLICOLOR=0`):

```
─── staged changes ─────────────────────
  app.js         +2 -0
  tests/app.js   +1 -0

─── draft 1 ─────────────────────────────
  feat(app): handle negative numbers in add function
  Handle the edge case where the user passes negative
  numbers to add().

  [Enter] accept · [e] edit · [r] regenerate · [q] quit ›
```

The only difference is the absence of ANSI color codes around the subject line.

### Output shape (interactive mode, truncation disclosed)

```
─── staged changes (truncated) ──────────    ← `(truncated)` badge in warn (amber)
  bigfile.js    +1247 -892
  …

─── draft 1 ─────────────────────────────
  feat(bigfile): ...
```

The `(truncated)` badge lives in the staged-changes label so the user sees it once per run, not on every regenerated draft.

### Output shape (regenerating)

While the model call is in flight, overwrite the prompt line in place using `\r`:

```
  regenerating — draft 2 ›
```

**TTY only.** On non-TTY (CI, captured output, `NO_COLOR`-respecting tests), fall back to a fresh line: `commitshi: regenerating — draft 2`. The inline-rewrite move only makes sense when the cursor is sitting at end-of-line waiting for input.

### Output shape (after edit, before the next prompt)

The user just exited `$EDITOR`. The new draft should re-render in the same section format, with the draft number **unchanged** (editing is not a regeneration):

```
─── draft 1 (edited) ─────────────────────    ← `(edited)` badge in accent (green), same hue as the subject
  fix(app): corrected by editor

  [Enter] accept · [e] edit · [r] regenerate · [q] quit ›
```

The `(edited)` badge tells the user: this is still good, but it's theirs, not the model's.

### Output shape (`--no-commit` mode)

Plain, single-line-per-line, exactly as today:

```
feat(app): handle negative numbers in add function
Handle the edge case where the user passes negative numbers to add().
```

No labels, no badges, no color. The presentation is a UX of the accept/edit/regenerate decision, not a property of the message itself.

## Color system

### Three roles, three colors. No more.

| Role | Light bg | Dark bg | Used for |
|---|---|---|---|
| `muted` (grey) | `oklch(0.5 0.01 250)` | `oklch(0.65 0.01 250)` | section labels, prompt wrapper |
| `accent` (green) | `oklch(0.55 0.13 150)` | `oklch(0.72 0.13 150)` | draft subject, `(edited)` badge |
| `warn` (amber) | `oklch(0.6 0.13 70)` | `oklch(0.75 0.13 70)` | `(truncated)` badge only |

These are concrete values for the implementation, encoded as ANSI 24-bit truecolor escapes when the terminal supports it (`process.stdout.getColorDepth() >= 24`), otherwise ANSI 256 palette equivalents — pick the nearest 256-color cube match per role. No design-token system, no theming layer. **Three colors, one screen.**

No red (reserved for errors elsewhere in the tool). No blue (no information role needs it). No secondary hues.

### Where color goes, and where it doesn't

| Element | Color | Why |
|---|---|---|
| Section labels (`─── staged changes ───`, `─── draft 1 ───`) | muted | Stage direction. Read once, ignored after. |
| Prompt wrapper (`  [Enter] accept · …`) | muted | Active but secondary to the draft. |
| Key names inside prompt (`accept`, `edit`, `regenerate`, `quit`) | default / slightly bold | The user is looking for these. |
| File paths in the staged-changes list | default | They're names, not decoration. |
| `+N -N` counts in the staged-changes list | default | Numbers don't tint. |
| `(truncated)` badge | warn | The one place warm color earns its keep. |
| `(edited)` badge | accent (same hue as the subject) | "This is still good, but it's yours." |
| **Draft subject** (the commit message title) | **accent** | **The deliverable. Highlight it.** |
| Draft body (the commit message body) | default | The subject carries the color; the body is prose. |

The last row is the move to defend hardest: **the subject line gets color because it's the deliverable.** The body doesn't, because it's prose. One color, one job.

### Color emission discipline

Color is emitted when **all** of these hold:

- `process.stdout.isTTY === true`
- `process.env.NO_COLOR === undefined` (no-color.org)
- `process.env.CI === undefined` (some CI environments set CI=1; many terminals in CI are fake-TY)

When any of those fail, emit the unstyled version (still with section labels — the labels are useful even uncolored).

`CLICOLOR_FORCE=1` is NOT honored — the tool does not override a user's `NO_COLOR` choice. This is a deliberate refusal: once you respect `NO_COLOR`, the override surface explodes and you end up back where `ls` is.

## Implementation notes

### Constraints

- **No runtime deps.** Pure ANSI escape sequences; `─`, `…`, `›`, `(truncated)`, `(edited)` are standard Unicode. No `chalk`, no `kleur`, no `colorette`.
- **TTY-aware.** Detect with `process.stdout.isTTY`. When `false`, emit bare labels (no color). When `true`, gate color on `NO_COLOR` + `CI`.
- **Width-aware but not width-perfect.** Section label widths in the design above are illustrative. Compute the actual width from a constant (~50 chars) — pad the label's `───` tail to that width. Don't try to be smarter than that — no terminal-width queries, no `$COLUMNS` reads.
- **No background colors.** Foreground only. Backgrounds in a CLI commit-message tool look gimmicky.
- **Reuse existing data.** `compacted.numstat` is already in `pipeline.ts` — it needs to thread through `generateDraft` → `DraftResult` → `DraftAttempt`. The loop already tracks `regenerations`.
- **Tests don't break.** Existing loop tests assert specific output strings (truncation note text, "regenerating…", prompt). Keep the *words* of these strings stable even though their *positions* change. (Ticket 12 already moves the truncation note to stdout — that change ships here.)

### ANSI helpers

Add a small set of helpers in `src/presentation.ts` (or inline in `loop.ts` — see below):

```ts
// Wrap `s` in a color role. No-op when color emission is disabled.
muted(s: string): string
accent(s: string): string
warn(s: string): string

// Decide once at startup whether to emit color.
shouldEmitColor(stdout: NodeJS.WriteStream, env: NodeJS.ProcessEnv): boolean
```

Each helper, when color is enabled, wraps in `\x1b[<n>m…\x1b[0m` with the right SGR code for the resolved palette. When disabled, returns the string unchanged. **`shouldEmitColor` is the only place the three env vars are read** — every helper reads a captured boolean.

### What touches what

**Files added/changed:**

- `src/presentation.ts` (new) — `shouldEmitColor`, `muted`, `accent`, `warn`, `presentDraft(opts)`. Keep it small; ~60 lines. Pure, no IO of its own except `stdout.write`.
- `src/pipeline.ts` — add `numstat: readonly NumstatEntry[]` to `DraftResult.ok` and `DraftAttempt.ok`. (Read-only widening of an internal type — the test seams already inject the full `generateDraft` return.)
- `src/loop.ts` — call `presentDraft` instead of the inline write. Regenerate path emits `regenerating — draft N ›` via `\r` overwrite on TTY, plain line on non-TTY.
- `src/main.ts` — minor: pass the resolved TTY/env into the loop so `presentDraft` can read it. (`main.ts` already injects `deps.loop?.stdinIsTTY` and `deps.loop?.stdoutIsTTY`; add `deps.loop?.env` if it isn't already there. It is — `LoopDeps.env` already exists.)
- `src/loop.test.ts` — capture stdout, assert on the assembled string. With `stdoutIsTTY: false`, the test asserts plain text. With `stdoutIsTTY: true`, the test asserts the labels appear in the right order (don't pin exact ANSI codes in tests; use a `stripAnsi` helper for substring assertions).
- `src/main.test.ts` — add the `--no-commit` regression: output is bare draft text, no labels.

### New module? Inline?

A small helper inline in `loop.ts` is fine for the first cut, **but** the color helpers + `shouldEmitColor` + `presentDraft` are ~60 lines of distinct concerns. Promote them to `src/presentation.ts` from day one — it's the right seam, and the test file gets cleaner.

### New tests

- Labels are emitted in correct order (`staged changes`, then `draft N`, then prompt) when `stdoutIsTTY: true`.
- Truncation badge appears in the staged-changes label; no separate stderr line.
- `draft 2` appears on the second iteration after `r`.
- `(edited)` badge appears after `e`; draft number is unchanged.
- With `stdoutIsTTY: false`, no section labels appear.
- With `stdoutIsTTY: true` and `NO_COLOR=1`, labels appear but no ANSI escapes are present in stdout.
- `--no-commit` produces bare draft text regardless of TTY.

### Verification checklist

After implementation:

1. `bun test` and `bun run typecheck` pass.
2. Live run against NIM in a sandbox repo (per existing live-verify pattern). Visually confirm:
   - Section labels render with horizontal-rule chars.
   - Subject line is visibly green.
   - Truncation badge (when triggered) is amber.
   - Prompt line is muted; key names inside are readable.
   - `r` updates the draft counter.
   - `e` adds `(edited)` without changing the counter.
3. Live run with `NO_COLOR=1 commitshi` in the same sandbox: labels still render, but no color. Visually confirm it looks clean (the labels alone carry the structure).
4. Live run with `commitshi --no-commit`: bare draft text only, no labels.
5. Live run with stdout piped: `commitshi | cat` — bare labels, no color.

**Suite:** `bun test` → +0 fail; `bun run typecheck` → clean.
**Verified live:** NIM, sandbox repo. All four modes (TTY+color, TTY+NO_COLOR, non-TTY, `--no-commit`).

## Comments

**done (agent).** Implemented per design. Key choices made where the ticket left latitude:

- **Seam kept `write`-only:** widened `DraftAttempt.ok` with `numstat` but left `LoopDeps.stdout` as `Pick<WriteStream,"write">`. `shouldEmitColor` takes the already-resolved `stdoutIsTTY` as a parameter (the loop owns that seam) plus env; `getColorDepth` is probed optionally. No test/main type churn.
- **`CI` in the gate as written.** Ticket said TTY + `NO_COLOR`, the Color-emission section and your brief both list `CI`. Went with the stricter gate (`TTY + !NO_COLOR + !CI`).
- **Prompt keys bolded** per the color table ("Key names inside prompt → slightly bold"). `PROMPT` string bytes untouched; wrapping is applied at render, not to the constant.
- **Rule widths are escape-safe:** padding is computed on the plain label; ANSI-wrapped badges are separate segments so escapes never shorten the rule. Verified all three variant rules pad to the same visible width.
- **`main.ts:181` truncation write kept as-is.** `--no-commit` has no frame, so the prose note is the only disclosure there. Not this ticket's to remove (see summary).
- **Verified visually by forcing the palette on in a harness, not on NIM** — no live endpoint was available in-session; the framing/labels/ANSI were confirmed via a local render (see summary). Checkbox "Verified live: NIM" therefore not checked by me.
