# 05 — Tracer bullet: prompt + template + OpenAI adapter

**What to build:** the first end-to-end one: run `commitshi` with staged changes, get a real commit message draft printed, in a single round trip. This ticket names the plumbing — the OpenAI-compatible provider adapter (configurable baseUrl, so OpenAI/Groq/DeepSeek/Ollama all work), the template engine honoring `{type}`, `{scope}`, `{summary}`, `{body}`, strict token-fill parsing with validation (exactly one value per token, no freeform prose outside token positions), and the prompt assembly with the compacted diff as its core input. A default Conventional Commits template applies when `commitshi.template` is empty. Timeout/rate-limit → fail loud, never retry-stale, never invent output.

**Blocked by:** 02 — Config resolution, 04 — Client-side compaction

**Status:** ready-for-agent

- [ ] `--no-commit` path prints a drafted commit message from a staged diff, end to end, no editor
- [ ] OpenAI-compatible adapter performs a real call against a configurable baseUrl
- [ ] Strict token fill: output with text outside token positions or a missing token is rejected, explained
- [ ] A truncated-marker diff is passed onward as truncated, disclosed to the model
- [ ] Empty `commitshi.template` → Conventional Commits default shapes the output
- [ ] Provider failure: loud message, no retry loop, no commit