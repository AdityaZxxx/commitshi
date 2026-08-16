# 06 — Anthropic adapter

**What to build:** the second provider on the same seam — a user with `ANTHROPIC_API_KEY` set can generate a draft with `--provider anthropic` and nothing else. The adapter shares prompt assembly with the OpenAI-compatible one; only the transport differs. All behavior from 05 (strict token fill, failure handling) works identically.

**Blocked by:** 05 — Prompt + template + provider

**Status:** done

- [x] `--provider anthropic` generates a valid draft using `ANTHROPIC_API_KEY`
- [x] Token-fill validation and failure semantics match 05's
- [x] No Anthropic-specific code paths leak into the OpenAI-compatible flow or vice versa

## Implementation notes

**Files added/changed** (nothing committed; left for the human):
- `src/provider/anthropic.ts` — the second transport on the same seam: `${baseUrl}/v1/messages`, `x-api-key` + pinned `anthropic-version: 2023-06-01` headers, the leading system message hoisted into the top-level `system` field (the Messages API has no system role in `messages`), `max_tokens` always present (required; default 1024, right-sized for a ~600-token subject). Consumes the SAME `CompletionRequest`/returns the SAME `CompletionResult` union as the OpenAI adapter — timeout via `AbortController`, 429→rate_limited / 401+403→auth / else→server, single attempt, never thrown. Multiple text blocks concatenate.
- `src/provider/anthropic.test.ts` — 15 tests (request shape incl. system hoist, header contract, normalization, all failure kinds, no-retry) + one **opt-in live** round trip gated on `COMMITSHI_LIVE=1` + `ANTHROPIC_API_KEY`.
- `src/pipeline.ts` — provider selection, per-provider defaults, and the key demand collapsed into one shared `resolveCallContext` (used by both `generateDraft` and `reviseDraft`, so they can never drift). Unknown providers refuse loud naming the supported set (`openai`, `anthropic`); matching is case-insensitive. Anthropic defaults: `https://api.anthropic.com` + `claude-haiku-4-5` (cheapest current Claude, same cheap/fast rationale as `gpt-5.6-luna`). `dispatchChat` routes the provider-agnostic `CompletionRequest` to the right transport — prompt assembly stays shared, byte for byte. New `anthropicChat` seam on `PipelineDeps`; the key demand reads `ANTHROPIC_API_KEY` / `anthropic_api_key` for the anthropic provider and never accepts the OpenAI key.
- `src/main.ts` — wires the `anthropicChat` seam through both the first-draft and revise paths.
- `src/cli.ts` / `README.md` — `--provider` help now names the supported set; README usage block re-synced to the real `--help` output.
- `src/pipeline.test.ts` — 11 new tests: anthropic routing (OpenAI transport untouched), shared prompt assembly, identical strict-fill rejection, identical failure exit codes (429/401→3, 500→1), missing-key naming `ANTHROPIC_API_KEY`, env-key satisfaction, no cross-provider key leak, unknown-provider refusal, case-insensitivity, and revise-through-anthropic.
- `src/main.test.ts` — 2 end-to-end tests through `main`: `--no-commit --provider anthropic` with `ANTHROPIC_API_KEY` drafts via the Anthropic transport (OpenAI seam provably uncalled); missing key fails loud exit 1.

**Design note:** the OpenAI flow is untouched by construction — all 224 pre-existing tests pass unchanged, and the new tests pin `openaiCalls === 0` on the anthropic path (and vice versa). The ticket-05 rule "never forward a real credential to a local server" applies to Anthropic too: a local `--base-url` gets no `x-api-key`.

**Live proof:** no `ANTHROPIC_API_KEY` on this machine, so the real-API round trip is the opt-in test. The full wire path was instead proven end to end against a local Messages-API mock speaking the exact Anthropic shape: `--no-commit --provider anthropic` drafted `feat: add a.txt`, exit 0; the mock validated path, `anthropic-version`, system hoist, `max_tokens`, and temperature. Missing-key against the real `https://api.anthropic.com` default fails loud exit 1 before any network call.

**Suite:** `bun test` → 253 pass / 0 fail (was 224); `bun run typecheck` → clean.