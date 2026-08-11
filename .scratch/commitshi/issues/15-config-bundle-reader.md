# 15 — Deepen resolveKey into a config bundle reader

**What to build:** one config seam for the draft-facing keys. `resolveBundle(deps, flags)` resolves `provider` / `baseUrl` / `model` / `template` in a single config-file read (flag > env > file > repo git-config > global git-config, per key), replacing the pipeline's three per-key `resolveKey` calls (three disk reads). The API key stays behind its own narrower `resolveApiKey` seam — keys never consult git config, a security property, not config knowledge. `--instructions` is explicitly pipelined: with `resolveKey` gone from the pipeline's deps, a future ticket slots `instructions` into the bundle as a fifth key without touching the seam shape.

**Blocked by:** nothing (follows 14)

**Status:** done

- [x] One config-file read per run for the draft-facing keys (was 3× `resolveKey`)
- [x] Pipeline's config seam is exactly one `resolveBundle`; the per-key `makeResolveKey`/`resolveKey` is gone from `PipelineDeps`
- [x] API key resolution unchanged: env + config file only, never git config
- [x] Per-run `--model` / `--base-url` / `--template` / `--provider` flags still win, folded in at the bundle seam
- [x] Local-endpoint key drop unchanged: still the pipeline's structural rule at send time, not config's concern
- [x] Bundle resolver covered by direct tests (precedence per key, single read, absent ⇒ caller defaults)

## Implementation notes

**Files changed:**
- `src/config.ts` — new `BUNDLE_KEYS`, `ConfigBundle`, and `resolveBundle(deps, flags)`. One `readConfigFile` call shared across all four keys; precedence still per-key (a flag overrides only its key, env fills only keys the flag missed, etc.). Absent keys are simply not in the bundle — the pipeline substitutes its own defaults.
- `src/pipeline.ts` — `PipelineDeps` drops `resolveKey` for one `resolveBundle` seam; the body calls it once with the run's flags and reads `bundle.provider/baseUrl/model/template`. `resolveApiKey("openai")` unchanged (provider-tagged, key never goes to git config).
- `src/pipeline.test.ts` — the `makeResolveKey` stub becomes `makeResolveBundle`, the test twin of the production resolver (flags beat committed config, per key).
- `src/config.test.ts` — three new `resolveBundle` tests: precedence collapse across all four keys, absent-keys-are-absent, and per-key (not global) env precedence.
- `src/main.ts` — wires `resolveBundle(deps.config, flags)` as the production seam (one line).

**Judgment calls made (from the grilling I ran on myself):**
1. Kept the curried/pure style — `resolveBundle` is a function, not a stateful reader object. No lifecycle to test.
2. Kept validation soft. A garbage model still 404s loud at the adapter; `baseUrl` URL-shape stays the adapter's job. Deepening the seam didn't mean snapping on validation the tool didn't have.
3. Local-endpoint key suppression stayed in the pipeline (send-time security), not pushed into config.
4. Bundle is exactly the four draft-facing keys. `instructions` stays out (it's a prompt-block input, not config the wizard owns); the seam accepts a fifth key without a shape change when a future ticket wants it.
5. Key sources unchanged (env + plaintext file). The "keys stop at the config file" docstring in config.ts is load-bearing — the bundle deliberately does not extend to git config for keys.
6. `main`'s config mirror was already dead from ticket 14; this ticket is pipeline-side only, so it doesn't re-litigate #1.

**Suite:** `bun test` → 178 pass / 0 fail (was 175); `bun run typecheck` → clean.

**Verified:** per-run flags flow through the bundle — `--template '{summary}'` produced the one-line fill contract end-to-end against local Ollama; default template path unchanged and drafts.
