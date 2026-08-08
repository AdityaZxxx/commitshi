# commitshi spec

A CLI that generates commit messages from the staged diff using an LLM, then walks the user through an accept / edit / commit loop. The finished commit flows through the user's normal git path — hooks, signing, and `prepare-commit-msg` all fire as usual.

## Position (product gap)

Fast, cheap, no wizard, matches the repo's own voice. Built from dissatisfaction with competitor tools that were provider-locked, verbose, or spent tokens on expensive chunk-and-synthesis for large diffs.

## Core loop

1. Read the staged diff (`git diff --cached`). Nothing else — unstaged and untracked stay untouched.
2. Compact it client-side into a dense digest (numstat + slim hunks). If the diff breaks a ~10k-hunk cap, mark it truncated (told and disclosed to the model and flagged onward).
3. Build the prompt: compacted diff + template + (scope) style history when `--style` is set + a `### User instructions` block when `--instructions` is given (default: block omitted entirely).
4. Model fills exactly one token per template token — `{type}`, `{scope}`, `{summary}`, `{body}` — constrained to the template's shape. No freeform output.

**Instructions precedence**: instructions from `--instructions` outrank the template and default conventions — they may reword `{summary}`/`{body}` and steer type/scope selection, but they can never break the strict token-fill shape (no fifth token, no text outside token positions). One-shot flag only; not persisted as config in v0.
5. Show inline: Enter=accept, `e` = open in `$EDITOR`, `r` = regenerate the draft. `--no-commit` stops here, printing the finished message.
6. Commit via `git commit -F -` (stdin); local hooks run. `commitshi` never runs `git add`.

## Non-features

- No `git add`, no `--banner`, no wizard, no verbose mode.
- No chunk-and-synthesize for large diffs in v0 — compaction covers it; a chunking path is scaffolding.
- No multi-provider adapter matrix — two seams (OpenAI-compatible arbitrary baseUrl + Anthropic), provider-agnostic channel.

## Config & precedence

`flag > env > ~/.config/commitshi* file > repo git-config > global git-config`. Keys via standard provider env vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) first, plaintext file second, first-run tip last. Missing key → explanatory message and exit 1. Timeout/rate limit → fail loud, never retry-stale, never commit.

## Flags

- `commitshi` — full loop (generate → accept/`e`/`r` → commit)
- `--no-commit` — print message only, no commit
- `--regenerate` — fresh draft for the same diff
- `--instructions "<text>"` — one-shot user instructions appended as a `### User instructions` prompt block; outranks template/default conventions (flag only, not persisted)
- `--template` — one-shot template override
- `--provider` / `--model` — one-shot overrides

## Boundaries

- Nothing staged → explain and exit non-zero, no commit.
- Merge in progress, or only-unstaged/untracked → refuse with a reason.
- Empty template → default Conventional Commits behavior.

## Tech

TypeScript on Bun, distributed via `bunx commitshi` (npm package). Provider adapters: OpenAI-compatible endpoint + Anthropic-native.