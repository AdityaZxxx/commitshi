# 14 — Inline draft edit (`i`), single-line `text()`-style

**What to build:** the in-place edit mode for the current draft, reachable via `i`. Pressing `i` puts the whole draft (subject and body, flattened to one line with `\n` shown literally) into a single pre-filled line, readline-style. The user edits it and presses Enter once. There is no double-Enter, no per-line walk — this is the opencommit pattern, landed deliberately after research showed nobody ships multi-line inline editing for commit messages.

**Blocked by:** 07 — Accept / edit / regenerate loop (done)

**Status:** done

## Contract

The loop's prompt is `[Enter] accept · [i] edit · [e] $EDITOR · [r] regenerate · [q] quit ›`.

Pressing `i` puts the current draft into inline edit mode:

- The whole draft appears in **one editable line**, pre-filled. A body (a `\n` in the draft) is shown as the two-character sequence `\n` inside the line; restoring it turns those sequences back into real newlines on save.
- Editing is readline-style, same as it always was: characters insert at the end, Backspace and Delete remove, Ctrl-W deletes back a word, Ctrl-U clears the whole line.
- **One Enter** commits the line and returns to the decision prompt. The first character of a newline (`\r` or `\n`) from the keypress is consumed; the draft is the text the user left on screen.
- **Esc or Ctrl-C** cancels: the draft reverts to its pre-`i` state, the `(edited)` badge stays off, the loop re-presents the decision prompt. Nothing is left half-edited.

## Interaction details

- The editing view shows the raw draft text, not the framed commit view. No color, no badges, no numstat — the user edits the message, not the presentation.
- The only validation is the subject-non-empty rule, enforced on save: if the user clears the whole line and hits Enter, the loop fails loud (exit code 1) and the draft reverts. A body is optional and may be present or absent either way.

## How it connects

- `src/loop.ts`: `answer === "i"` branch builds the pre-filled line from the draft (`draft.replace(/\n/g, "\\n")`), runs a one-shot readline on it, and on success restores the newlines (`text.replace(/\\n/g, "\n")`) and sets `edited = true`.
- The inline edit state is loop-local. It does not touch the pipeline, the template, or the fill contract. The accepted text flows to the commit stage exactly as `$EDITOR`-edited text does (`git commit -F -`).

## Implementation notes

The loop's `ask` seam reads single keypresses; inline edit consumes them through the same seam. The one-shot readline lives in `inlineEdit()` in `src/loop.ts` and repaints the current line in place with `\r\x1b[K> ` after every keystroke.

## Tests (headless, over the seams)

- `i` pre-fills the draft as one line; typing over it and Enter saves and accepts (badge shows).
- `i` keeps the draft unchanged when the user just presses Enter (badge still shows — running `i` and confirming is an edit).
- `i` shows the pre-filled draft on screen while editing; a typed char repaints the line.
- `i` then Esc: the draft reverts, the badge stays off, the prompt reappears.
- Ctrl-C inside an inline edit cancels like Esc; no SIGINT re-raise.
- `i` clears the line and hits Enter → loud failure, draft reverts, exit code 1.
- `i` edits, then `r` regenerates: the edited text is discarded and the badge drops.

All of these drive the loop through the same `ask` seam the existing loop tests use.
