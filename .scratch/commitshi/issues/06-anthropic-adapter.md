# 06 — Anthropic adapter

**What to build:** the second provider on the same seam — a user with `ANTHROPIC_API_KEY` set can generate a draft with `--provider anthropic` and nothing else. The adapter shares prompt assembly with the OpenAI-compatible one; only the transport differs. All behavior from 05 (strict token fill, failure handling) works identically.

**Blocked by:** 05 — Prompt + template + provider

**Status:** ready-for-agent

- [ ] `--provider anthropic` generates a valid draft using `ANTHROPIC_API_KEY`
- [ ] Token-fill validation and failure semantics match 05's
- [ ] No Anthropic-specific code paths leak into the OpenAI-compatible flow or vice versa