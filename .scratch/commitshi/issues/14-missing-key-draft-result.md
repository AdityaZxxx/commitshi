# 14 — Missing key as a draft result

**What to build:** move the key-demand check out of `main.ts` into the draft pipeline, and report it as a dedicated draft-result variant (`kind: "missing-key"`, message + wizard hint included). `main` reduces to mapping that variant to behavior: on an interactive TTY (without `--no-commit`) it runs the setup wizard and retries the draft once; everywhere else it prints the guidance and exits 1. The `flagsCoverBundle` / `configBundleUsable` mirror chain in `main.ts` is deleted; the pipeline's own `OPENAI_API_KEY`-in-env check absorbs what that chain papered over.

**Blocked by:** nothing

**Status:** done

- [x] Kept: empty config on a TTY with staged changes still gets the wizard, then a draft — now sandboxed end to end (wizard line-reader writes a real config file; the same run drafts)
- [x] Kept: non-interactive run with a missing key exits 1 with the full guidance message; no wizard attempt
- [x] Kept: `--no-commit` never triggers the wizard; missing key fails loud as today
- [x] Kept: env-provided key / local baseUrl never detours into the wizard (no change in direction)
- [x] Changed: fresh user on a TTY with *nothing staged* sees "nothing staged" first; the wizard fires only once a draft is actually possible (guard-before-key ordering)
- [x] `flagsCoverBundle` and `configBundleUsable` no longer exist in `main.ts`
- [x] One `missingKeyMessage` callsite (pipeline); `main` prints `result.message`

## Implementation notes

**The deepening:** key demand moved from two mirrored predicates in `main.ts` (`flagsCoverBundle` / `configBundleUsable`, deleted) into the draft pipeline's front door, where it was already half-computed. Failure is now a discriminated draft result — `{ ok: false, kind: "missing-key", message }` — and `main` reduces to one mapping: `kind === "missing-key" && interactive TTY && !--no-commit` → run the wizard → retry the pipeline once. Otherwise the result's message is printed verbatim and its exit code used. The message (`missingKeyMessage("openai")`) has exactly one callsite now, in `pipeline.ts`.

**Files changed:**
- `src/pipeline.ts` — `DraftResult` failure gains `kind?: "missing-key"`; the non-local/no-key refusal becomes that variant carrying the full guidance (which now names the wizard). `PipelineDeps` gains an `env` seam so `OPENAI_BASE_URL` / `OPENAI_API_KEY` fallbacks read the injected env, not the developer's exported vars.
- `src/main.ts` — ~60 lines deleted (both mirror predicates, three `missingKeyMessage` callsites, the pre-guard trigger block, the `else if` refusal). New: a `setupInput` seam (`Parameters<typeof runSetup>[0]`) so tests drive the real wizard headless through `main`; the wizard-retry block after the first `runPipeline()`; loop TTY seams now fall back to the top-level TTY seams.
- `src/main.test.ts` / `src/setup.test.ts` — the pre-staging ticket-11 test replaced by a guard-precedes-key pin and a sandboxed end-to-end auto-trigger test (real wizard via `scriptedLines`, real config write, real retry).

**The ordering change (deliberate):** the wizard used to fire *before* the staged guard, so a fresh user with nothing staged met setup before learning the tool wants staged changes. Now the guard speaks first ("nothing staged — stage changes with git add"), and the wizard fires only once something is staged and a draft is actually blocked on the key. Matches the "stage, run commitshi, commit" promise from the spec.

**Verified against real IO** (not just seams): fresh `/tmp` repo + empty `XDG_CONFIG_HOME` + pty via `script(1)` → wizard fired, wrote `baseurl`/`model`; a follow-up `--no-commit` against that generated config drafted `feat(a): add x` from local Ollama `gemma3:4b`, exit 0. Missing-key non-local refusal exits 1 with the full guidance.

**Suite:** `bun test` → 175 pass / 0 fail; `bun run typecheck` → clean. (Was 174/2 at claim.)
