# 10 — Style-aware opt-in

**What to build:** matching the repo's own voice — on request only. `--style` pulls the most recent ~8 commit subjects into the prompt so the draft adopts the repo's local conventions; without the flag, history is never read silently. This is the output-complement to the "matches the repo's voice" position.

**Blocked by:** 05 — Prompt + template + provider

**Status:** done

- [x] `--style` includes the last ~8 subjects in the prompt
- [x] Without `--style`, git history relevant to the prompt stays unread (verify no accidental read)
- [x] Styled drafts conform to the repository's visible subject conventions
- [x] History unavailability (fresh repo) does not crash the flow — degrades gracefully

## Resolution

- New seam `recentCommitSubjects(limit = 8)` in src/git.ts runs `git log -8 --format=%s` (subjects only; bodies never cross); any failure — including an unborn HEAD in a fresh repo — degrades to `[]`, never throws.
- The pipeline only sees history through an optional `styleHistory` dep (src/pipeline.ts): absent by default, so the no-flag path has no history code path at all. main.ts wires it exclusively as `styleHistory: flags.style ? () => recentCommitSubjects() : undefined`.
- With subjects present, a `### Style history` block lands after `### Compact diff` telling the model to match local conventions; empty history omits the block entirely (fresh-repo flow still drafts).
- Proven no-silent-read three ways: behavioral tests through main (no style block / subjects absent without `--style`, present with it, fresh repo drafts without a block) AND a static scan in src/git.test.ts asserting `git log`/`recentCommitSubjects` appear only in git.ts and the exact `flags.style`-gated wiring in main.ts.