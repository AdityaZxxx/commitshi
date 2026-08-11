# 15 — Surface `[i]` in the decision prompt

**What to build:** add the inline-edit affordance to the loop's prompt and keep the presentation layer's single-source-of-truth contract intact.

**Blocked by:** 14 — Inline draft edit (`i`)

**Status:** done

## Contract

`src/loop.ts`'s `PROMPT` constant is the single source of truth for what the user sees in the decision prompt. Today it reads:

```
  [Enter] accept · [e] edit · [r] regenerate · [q] quit ›
```

Change it to include the inline-edit key. The wording should keep the existing style — terse, bracketed key, action — and name the two edit paths distinctly so it's clear `e` is the heavyweight escape hatch:

```
  [Enter] accept · [i] edit · [e] $EDITOR · [r] regenerate · [q] quit ›
```

`e` becomes the explicit "$EDITOR" path; `i` is the new lightweight one. The vertical bar separator and the caret at the end stay.

## Why this is its own ticket

`PROMPT` is deliberately a single constant because the presentation layer renders what's there, byte-for-byte. Changing the prompt is not a rendering change — it's a copy change that ripples into the one place the user reads to decide what to do. It's worth landing after the key actually works (ticket 14), so the user never sees a dead key binding.

## Tests

- The existing presentation layer tests (`src/presentation.test.ts`) cover the rendering of `PROMPT` verbatim — update the expectation to the new string.
- A loop-level test drives a full `i` flow through the seams and asserts the new prompt line appeared in stdout.
