# 04 — Client-side compaction

**What to build:** turning a large staged diff into a compact digest before it ever reaches a model — the thing that makes the tool cheap on big changes. Parse the diff into per-file numstat plus slim hunks with unchanged context and trailing lines collapsed, preserving the change's real semantics. Above a generous cap (~10k hunks) truncate and mark the digest as truncated so the model is told it saw a partial change.

**Blocked by:** 03 — Diff selection + boundary guards

**Status:** done

- [x] Dense digest: per-file stats + lean hunks, unchanged noise stripped
- [x] A large real diff compacts to a fraction of its raw size without losing which files changed and how
- [x] Diff over the ~10k-hunk cap → truncated marker present, flagged to the caller
- [x] Verifiable unit-level: needs no live model call to exercise

## notes

Spec term: "compacted diff".