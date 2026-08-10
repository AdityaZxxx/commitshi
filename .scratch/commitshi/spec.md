# commitshi spec

A CLI that generates commit messages from the staged diff using an LLM, then walks the user through an accept / edit / commit loop. The finished commit flows through the user's normal git path — hooks, signing, and `prepare-commit-msg` all fire as usual.

## Position (product gap)

Fast, cheap, no ceremony, matches the repo's own voice. Built from dissatisfaction with competitor tools that were provider-locked, verbose, or spent tokens on expensive chunk-and-synthesis for large diffs.

First-run setup is a **constrained wizard**: it fires only when the tool genuinely cannot proceed (missing/unusable API config in an interactive shell), captures URL + key + model into `~/.config/commitshi/config`, and is invisible for the program's whole life afterwards. `commitshi --setup` re-opens it explicitly. The one-line promise is "stage, run `commitshi`, commit" — the wizard exists to get there, then gets out of the way.

## Core loop

1. Read the staged diff (`git diff --cached`). Nothing else — unstaged and untracked stay untouched.
2. Compact it client-side into a dense digest (numstat + slim hunks). If the diff breaks a ~10k-hunk cap, mark it truncated (told and disclosed to the model and flagged onward).
3. Build the prompt: compacted diff + template + (scope) style history when `--style` is set + a `### User instructions` block when `--instructions` is given (default: block omitted entirely).
4. Model fills exactly one token per template token — `{type}`, `{scope}`, `{summary}`, `{body}` — constrained to the template's shape. No freeform output.

**Instructions precedence**: instructions from `--instructions` outrank the template and default conventions — they may reword `{summary}`/`{body}` and steer type/scope selection, but they can never break the strict token-fill shape (no fifth token, no text outside token positions). One-shot flag only; not persisted as config in v0.
5. Show inline: Enter=accept, `e` = open in `$EDITOR`, `r` = regenerate the draft. `--no-commit` stops here, printing the finished message.
6. Commit via `git commit -F -` (stdin); local hooks run. `commitshi` never runs `git add`.

## Non-features

- No `git add`, no `--banner`, no verbose mode. Setup wizard exists only for the "can't proceed" case — it is not a banner, not a verbose tumbler, and it never appears once configured.
- No chunk-and-synthesize for large diffs in v0 — compaction covers it; a chunking path is scaffolding.
- No multi-provider adapter matrix — two seams (OpenAI-compatible arbitrary baseUrl + Anthropic), provider-agnostic channel.

## Config & precedence

`flag > env > ~/.config/commitshi/config (plaintext, TOML-compatible `key = value`) > repo git-config > global git-config`. Keys via standard provider env vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) first, plaintext file second, first-run tip last. Missing key → explanatory message and exit 1 (or the setup wizard when interactive). Timeout/rate limit → fail loud, never retry-stale, never commit.

The setup wizard is the **only place** that writes config, and it writes exactly the keys resolution already reads (`baseurl`, `model`, `openai_api_key`). Default model: `gpt-5.6-luna` — cheap, fast, right-sized for a ~600-token commit subject; the OpenAI alias `gpt-5.6` is deliberately avoided (it routes to the flagship Sol tier at $5/$30).

## Flags

- `commitshi` — full loop (generate → accept/`e`/`r` → commit)
- `--setup` — force the setup wizard (works outside a git repo); writes config, exits. Also the "already configured" path: prefills existing values, overwrites on confirm.
- `--no-commit` — print message only, no commit
- `--regenerate` — produce a fresh variant of the commit draft for the same diff (temperature is bumped only on regenerate, so the first draft is the model's best guess and `r` explores alternatives)
- `--instructions "<text>"` — one-shot user instructions appended as a `### User instructions` prompt block; outranks template/default conventions (flag only, not persisted)
- `--template` — one-shot template override
- `--provider` / `--model` — one-shot overrides

The initial commit draft and the regenerate variant use different sampling temperatures: the initial draft is sent at temperature 0 so it is the model's deterministic best guess for the diff, and `r` is sent at temperature 0.3 so each regeneration explores an alternative wording. The override is reset on every entry to the draft pipeline, so it never leaks from a regenerate into a later initial call — the temperature split is a property of the call site, not a persistent setting.

## Setup wizard triggers

Runs only when **all** hold — otherwise the existing "missing key → explain and exit" path applies:
1. Not a `--no-commit` piped run (stdin/stdout are a TTY).
2. Flags don't already cover the bundle (`--base-url`/`--model` + env/api-key); a complete flag/env config skips the wizard.
3. Not actually configured (missing key for a non-local URL, or `--setup` was given).

In a normal run, the config-check runs **before** the staging guard, so a fresh user sees "set up first" instead of "nothing staged".

## Boundaries

- Nothing staged → explain and exit non-zero, no commit.
- Merge in progress, or only-unstaged/untracked → refuse with a reason.
- Empty template → default Conventional Commits behavior.

## Tech

TypeScript on Bun, distributed via `bunx commitshi` (npm package). Provider adapters: OpenAI-compatible endpoint + Anthropic-native.