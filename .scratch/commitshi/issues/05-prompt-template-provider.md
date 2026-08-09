# 05 — Tracer bullet: prompt + template + OpenAI adapter

**What to build:** the first end-to-end one: run `commitshi` with staged changes, get a real commit message draft printed, in a single round trip. This ticket names the plumbing — the OpenAI-compatible provider adapter (configurable baseUrl, so OpenAI/Groq/DeepSeek/Ollama all work), the template engine honoring `{type}`, `{scope}`, `{summary}`, `{body}`, strict token-fill parsing with validation (exactly one value per token, no freeform prose outside token positions), and the prompt assembly with the compacted diff as its core input. A default Conventional Commits template applies when `commitshi.template` is empty. Timeout/rate-limit → fail loud, never retry-stale, never invent output.

**Blocked by:** 02 — Config resolution, 04 — Client-side compaction

**Status:** done

- [x] `--no-commit` path prints a drafted commit message from a staged diff, end to end, no editor
- [x] OpenAI-compatible adapter performs a real call against a configurable baseUrl
- [x] Strict token fill: output with text outside token positions or a missing token is rejected, explained
- [x] A truncated-marker diff is passed onward as truncated, disclosed to the model
- [x] Empty `commitshi.template` → Conventional Commits default shapes the output
- [x] Provider failure: loud message, no retry loop, no commit

## Implementation notes

**Files added/changed** (nothing committed; left for the human):
- `src/provider/openai.ts` — OpenAI-compatible chat adapter: `${baseUrl}/chat/completions`, `Authorization` only when a key is configured, timeout via `AbortController`, 401/403/408/429→distinct failure kinds. Configurable `baseUrl` ⇒ OpenAI, Groq, DeepSeek, Ollama all work.
- `src/provider/openai.test.ts` — 10 tests (URL/headers/normalization, all failure kinds, no-retry) + one **opt-in live** test gated on `COMMITSHI_LIVE=1`.
- `src/template.ts` — the fill-contract engine: template segmentation/validation, per-line `name: value` parsing, scope/body omission, strict value discipline, and template render (message constructed from the template + parsed values, so stray prose outside token positions is structurally impossible).
- `src/template.test.ts` — 26 tests pinning the contract and every rejection.
- `src/pipeline.ts` — diff → compact → resolve (02 chain, `--model`/`--template`/`--provider` one-shot overrides) → prompt assembly → chat → strict fill → draft. `--provider anthropic` refuses loud (06's job). Real credentials are never forwarded to a local baseUrl.
- `src/main.ts` / `src/main.test.ts` — wire `--no-commit` end to end with an injectable `chat` seam; replaced the scaffold's "not implemented" test with the real path (offline stub) + a strict-fill rejection test.

**Contract design (the one real decision):** the model never echoes the raw `{token}` shape — tiny local models (gemma3:270m, phi4-mini) literally reflect it or append the diff. Instead the model fills a strict per-line `name: value` contract; we parse fields and **fill the template** ourselves. Prose outside token positions therefore cannot reach the commit by construction, and a missing/extra/echoed token is rejected with a named reason. Renegotiate if a future provider *requires* true freeform-fills-the-template output.

**Live proof:** real end-to-end against local Ollama (`http://localhost:11434/v1`), model `gemma3:4b`, staged `login.ts`: printed `feat(login): add login function` + body, exit 0. Also `src/provider/openai.test.ts`'s opt-in live round trip (`COMMITSHI_LIVE=1`) passes. Default adapter timeout raised to 120 s because gemma3:4b takes ~32 s on the real prompt.

**Suite:** `bun test` → 77 pass / 0 fail; `bun run typecheck` → clean. (Was 42 passing at claim time.)