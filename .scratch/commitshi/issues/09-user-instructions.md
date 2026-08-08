# 09 — One-shot user instructions + template override

**What to build:** the escape hatch for someone who needs to say something very specific to the model. `--instructions "<text>"` appends a `### User instructions` block to the prompt and outranks the template/default — it may steer type/scope choice and reword summary/body, but it can never break strict token-fill shape (no fifth token, no text outside token positions). `--template "<string>"` overrides the configured template for one run. Both are one-shot flags, never persisted.

**Blocked by:** 05 — Prompt + template + generation

**Status:** ready-for-agent

- [ ] `--instructions` text appears in the prompt as its own block and is honored by the model
- [ ] Instructions reword summary/body per user request; token-fill shape is still enforced
- [ ] `--template` overrides configured/global template for that run only
- [ ] Neither overrides are written to any config; later runs use committed values