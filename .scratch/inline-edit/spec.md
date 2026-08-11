# `i` — inline draft edit

Adds an inline edit of the commit draft, triggered by the `i` key in the interactive loop. This is the fast, light alternative to `e` (`$EDITOR`) for the common case: fixing a typo, polishing the subject, or tweaking wording, without leaving the terminal.

## Position

`e` opens `$EDITOR` — a full-screen, stateful escape hatch. That's the right tool for a large rewrite, but too heavy for a two-character typo. Inline edit is for the user who wants to stay in the flow: the draft they see on screen becomes editable in one pre-filled line, they fix it, they press Enter once, and the loop carries the edited text on.

## Interaction contract

The user is shown the current draft (subject + body), and the prompt line gains an `[i]` option:

```
  [Enter] accept · [i] edit · [e] $EDITOR · [r] regenerate · [q] quit ›
```

Pressing `i` enters inline edit mode on the **current draft text** as **one pre-filled line**, in the style of `@clack/prompts`' `text({ initialValue })`. The whole draft — subject and body — is the initial value; a literal newline in the draft is shown inside the line as the two-character sequence `\n`, so the user sees exactly what they're editing. There is no per-line walk, no double-Enter — one Enter commits and returns. This is the pattern opencommit, lazycommit, and aicommits all converge on; nobody in this space ships multi-line inline editing, and v1 of commitshi's `i` (a per-line walk) was replaced with this for that reason.

The line being edited is drawn *below* the framed draft — one `> `-prefixed line, prepainted with the draft, repainted in place as you type, so you always see your keystrokes.

- **Enter** commits the line and returns to the decision prompt with the edited draft.
- **Esc or Ctrl-C** cancels the entire edit; the draft reverts to what it was before `i` was pressed and the decision prompt reappears with the `(edited)` badge cleared.

## Rules

- **Sovereign text.** The edited draft bypasses the fill contract entirely. It is not re-parsed, not re-validated against the template, and not checked for Conventional Commits shape. The only rule: **the subject (the first line of the resulting commit) must be non-empty.** An empty subject after edit is a loud failure — nothing is committed, and the loop returns to the pre-edit draft. Everything else is accepted verbatim.
- **Newline handling.** A body is stored as `\n` in the draft. When the draft is flattened for editing, each `\n` becomes the two-character sequence `\n` on screen, and on save that sequence is restored to a real newline. Most drafts are a single line, and the user sees only that.
- **No new tokens or fields.** This is a raw-text edit. The user doesn't see `{type}` or `{scope}` — they see the rendered draft (`feat(cli): add a login flow`) and edit the rendered text. `commitshi` never tries to back-parse the text into tokens.

## Non-goals

- No multi-line editing, no per-line walking, no double-Enter — the research in `.scratch/product-research/inline-edit-ux.md` settled this. Multi-line editing in a terminal accumulates bug reports forever and adds nothing over `$EDITOR` for the rare body-heavy case.
- No re-validation or shape hints ("that doesn't look like a conventional commit") — the user is in charge.
- No persistence: the edited text lives for the duration of the loop. If the user then presses `r`, the edited text is discarded and a fresh draft replaces it. The `(edited)` badge drops.

## Effect on the rest of the loop

- The `(edited)` badge behavior matches `e`: it shows on the draft after a successful inline edit, and drops on `r`.
- Accepting with Enter takes the inline-edited text verbatim to the commit stage (`git commit -F -`).
- The inline edit state is local to the loop. It never touches the pipeline, the template, or git config.

## Where it lives

`src/loop.ts` gains an `i` branch. The edit is a one-shot readline over the same `ask` seam that reads single keypresses for the decision prompt — the seam reads single keypresses, `inlineEdit` consumes them until Enter or cancel.
