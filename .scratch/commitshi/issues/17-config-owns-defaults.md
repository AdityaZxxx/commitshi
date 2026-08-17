# 17 — Config owns the defaults: the bundle comes back total

**What to build:** make `resolveBundle` return a TOTAL bundle. Under the old rule ("resolution never invents") default-substitution leaked across the seam: the pipeline substituted the template default and the per-provider baseUrl/model defaults, and the setup wizard imported the pipeline's `DEFAULT_*` constants to stay in sync. Resolution now fills the defaults itself — tagged `source: "default"` — so callers receive values, never absences. The four `DEFAULT_*` constants move from `pipeline.ts` to `config.ts`; the undocumented `OPENAI_BASE_URL` fallback is dropped outright.

**Blocked by:** nothing (follows 15/16)

**Status:** done

- [x] `ConfigBundle` is total: `Record<BundleKey, Resolved>`, never partial
- [x] `Source` gains `"default"`; every filled default is tagged with it
- [x] `DEFAULT_BASE_URL` / `DEFAULT_MODEL` / `DEFAULT_ANTHROPIC_BASE_URL` / `DEFAULT_ANTHROPIC_MODEL` live in `config.ts`; `pipeline.ts` exports none of them
- [x] `resolveCallContext` substitutes nothing — it reads `bundle.baseUrl.value` / `bundle.model.value` and routes
- [x] Provider resolves first inside `resolveBundle` (baseUrl/model defaults depend on it); unknown-provider refusal stays loud in the pipeline
- [x] `OPENAI_BASE_URL` legacy fallback REMOVED — undocumented ecosystem convention; the documented env path is `COMMITSHI_BASEURL`
- [x] Empty git-config value counts as absent (consistent with flag/env/file levels)
- [x] Blank-provider guard removed from `resolveCallContext` — config always fills provider; unknown names still refuse loud
- [x] Whitespace-only template counts as absent → default template
- [x] Setup wizard imports its defaults from `config.ts`, not `pipeline.ts`
- [x] Rule change recorded: `docs/adr/0001-config-owns-defaults.md`

## Implementation notes

**Files changed:**
- `src/config.ts` — `Source` gains `"default"`; the four `DEFAULT_*` constants move in from pipeline.ts; `ConfigBundle` becomes `Record<BundleKey, Resolved>`; `resolveBundle` refactored to a per-key `found()` helper plus a default-fill tail (provider first, then baseUrl, model, template with whitespace-only-as-absent); empty git-config values count as absent.
- `src/pipeline.ts` — `DEFAULT_*` constants deleted; `resolveCallContext` reads the total bundle directly (no `??` substitution) and the blank-provider guard is gone (config always fills provider; unknown names still refuse loud); template read is `bundle.template.value.trim()`; the dead `isLocalBaseUrl` re-export removed (setup imports it from config directly).
- `src/setup.ts` — `DEFAULT_BASE_URL` / `DEFAULT_MODEL` imported from `./config.ts`; the `./pipeline.ts` import is gone.
- `src/config.test.ts` — the "absent keys are absent" test replaced by total-bundle tests: all-defaults shape, anthropic default switch, configured values beat defaults, `OPENAI_BASE_URL` is NOT consulted, empty git-config value falls back to default, whitespace-only template.
- `src/pipeline.test.ts` — the `makeResolveBundle` test twin now returns a total bundle (flags > committed > per-provider defaults), mirroring production; Anthropic default imports move to `./config.ts`.
- `src/setup.test.ts` — `DEFAULT_MODEL` import moves to `./config.ts`.
- `docs/adr/0001-config-owns-defaults.md` — the rule change: "resolution never invents" reopened because the inventing already happened, scattered across three callers.

**Judgment calls:**
1. `OPENAI_BASE_URL` fallback DROPPED, not moved. It was another tool's ecosystem convention, undocumented in README/spec, and a fresh project has no users relying on it. The documented env path is `COMMITSHI_BASEURL` (generated from the key). Carrying a second env var was exactly the "default knowledge scattered" smell this ticket eliminates.
2. Blank-provider guard removed from `resolveCallContext`. Now that config always fills `provider` (never blank), that branch was unreachable in production — a vestige of the old partial-bundle contract. Unknown-provider refusal stays loud in the pipeline.
3. Empty git-config value now counts as absent, consistent with the flag/env/file levels. The old `??` chains had the same hole for baseUrl/model; closing it here means a present-but-empty key never routes anywhere on its own.
4. Unknown-provider refusal stays in the pipeline, not config: config fills `provider: "openai"` only when the key is ABSENT; a present-but-unknown value still travels to the pipeline's loud refusal with the supported set.
5. `makeResolveKey` untouched — ticket 17 is the bundle seam only (candidate 4 in the architecture review deletes `makeResolveKey` separately).

**Suite:** `bun test` → 262 pass / 0 fail; `bun run typecheck` → clean; `bun run lint` → clean; `bun run format:check` → clean.
