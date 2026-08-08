# 03 — Diff selection + boundary guards

**What to build:** the tool only ever reads staged changes and never touches unstaged or untracked files. When there is nothing staged, or a merge is in progress, or only unstaged/untracked changes exist, print a reason and exit non-zero on without doing anything to the worktree.

**Blocked by:** 01 — Scaffold + CLI

**Status:** ready-for-agent

- [ ] Reads only `--cached` staged diff; unstaged/untracked never affect the result
- [ ] Nothing staged → explanatory error, non-zero exit, no model call
- [ ] Merge/conflict in progress → refuse with a reason
- [ ] Only-unstaged/untracked → refuse with a reason

## notes

Spec term: "staged changes".