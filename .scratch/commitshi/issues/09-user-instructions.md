# 09 — One-shot user instructions + template override

**What to build:** the escape hatch for someone who needs to say something very specific to the model. `--instructions "<text>"` appends a `### User instructions` block to the prompt and outranks the template/default — it may steer type/scope choice and reword summary/body, but it can never break strict token-fill shape (no fifth token, no text outside token positions). `--template "<string>"` overrides the configured template for one run. Both are one-shot flags, never persisted.

**Blocked by:** 05 — Prompt + template + generation

**Status:** done

- [x] `--instructions` text appears in the prompt as its own block and is honored by the model
- [x] Instructions reword summary/body per user request; token-fill shape is still enforced
- [x] `--template` overrides configured/global template for that run only
- [x] Neither overrides are written to any config; later runs use committed values

## Resolution

- `--instructions` appends a `### User instructions` block in `generateDraft` (src/pipeline.ts) after `### Compact diff`; the block tells the model the instructions outrank template/default but can never break the fill contract. Whitespace-only instructions omit the block (empty = default).
- `--template` was already routed through `resolveKey("template", { flags })` at flag precedence; tests now prove it beats a committed template for one run and that later runs fall back to the committed template (nothing written back — no config write seam exists anywhere).
- strictFill shape discipline is unchanged: a test proves an instruction-demanded extra field is still rejected as a template-contract violation.