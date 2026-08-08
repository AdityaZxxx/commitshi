# 01 — Scaffold + CLI

**What to build:** a runnable `commitshi` command with a flag surface that parses and doesn't crash on anything. Running `commitshi --help` lists every flag; running it in a repo with no flag errors just works. This lets every later ticket hang its behavior on an existing entrance.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] `bun init`-style project, TS config, npm packaging so `bunx commitshi` resolves
- [x] `commitshi --help` prints usage with `--no-commit`, `--regenerate`, `--instructions`, `--template`, `--provider`, `--model`
- [x] Unknown flags produce a clean error and non-zero exit, never a crash
- [x] An empty run (no diff to process) reaches and exits gracefully