# 16 — Collapse the draft-fill cluster

**What to build:** deepen the template module from a grab-bag of helpers into the single owner of the fill contract. Three changes: (1) `buildPrompt(template)` absorbs the system-prompt assembly from `pipeline.ts` so the prose-promised contract and the `strictFill`-enforced contract are authored in one file; (2) a small `checkTemplate(template) → error | null` preflight lets the pipeline reject a malformed template before paying a model; (3) the pipeline stops threading `TemplateParse` through its body (no `parseTemplate` call, no `buildSystemPrompt(parsed)`, no `strictFill(template, reply)` three-step) and drops `templateKind` from `DraftResult` — it was computed, stored, and read by no one.

**Blocked by:** nothing

**Status:** done

- [x] `pipeline.ts` no longer imports `parseTemplate` / `buildFillInstructions` / `TemplateParse`
- [x] Prompt prose and parse contract live in one module (`template.ts`)
- [x] Malformed `--template` fails with exit 2 **before** any model call (`checkTemplate`)
- [x] `{nope}` end-to-end: zero chat traffic, reason names the unknown token
- [x] `templateKind` removed from the success result (no reader, computed-for-free)

## Implementation notes

**Files changed (nothing staged; left for the human):**
- `src/template.ts` — `buildFillInstructions` was already here; added `buildPrompt(template)` (grows the prompt prose + fill instructions in one place, internal re-parse; deliberately does NOT take `TemplateParse`), and `checkTemplate(template)` for the fail-fast seam.
- `src/pipeline.ts` — deleted `buildSystemPrompt` (its body moved into `buildPrompt`), the early `parseTemplate` threading, the trailing `strictFill(template, …)` re-parse responsibility stays. Imports slimmed to `{ buildPrompt, checkTemplate, DEFAULT_CONVENTIONAL_TEMPLATE, strictFill }`.
- `src/pipeline.test.ts` / `src/main.test.ts` — added the pins the card promised: invalid-template runs zero model calls and exits 2; the system prompt carries the fill rules worded by the template's own tokens; `--template {wat}: …` fails before chat fires.
- `src/template.test.ts` — retroactively kept tight: the module's contract (`strictFill` happy/rejection paths, `buildFillInstructions`, `parseTemplate`) was already pinned; the two new pipeline tests now pin the seams the module exposes.

**Judgment call (from the report):** `strictFill` still re-parses internally — the interface the model reply crosses is exactly one call (`strictFill(template, reply)` in the pipeline). What changed is that the pipeline no longer *also* parsed the template to build the prompt; the phrase "interface shrinks" in the card refers to what `pipeline.ts` must know, not to `strictFill`'s own internals.

**Suite:** `bun test` → 181 pass / 0 fail (was 178); `bun run typecheck` → clean.
