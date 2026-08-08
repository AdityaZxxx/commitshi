# 10 — Style-aware opt-in

**What to build:** matching the repo's own voice — on request only. `--style` pulls the most recent ~8 commit subjects into the prompt so the draft adopts the repo's local conventions; without the flag, history is never read silently. This is the output-complement to the "matches the repo's voice" position.

**Blocked by:** 05 — Prompt + template + provider

**Status:** ready-for-agent

- [ ] `--style` includes the last ~8 subjects in the prompt
- [ ] Without `--style`, git history relevant to the prompt stays unread (verify no accidental read)
- [ ] Styled drafts conform to the repository's visible subject conventions
- [ ] History unavailability (fresh repo) does not crash the flow — degrades gracefully