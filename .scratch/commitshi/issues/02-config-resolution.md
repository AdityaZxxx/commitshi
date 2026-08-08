# 02 — Config resolution

**What to build:** the configuration lookup chain so a user can set their provider, model, and API key once and have later runs just work. Precedence: `flag > env > ~/.config/commitshi config file > repo git-config > global git-config`. Key resolution: standard provider env vars (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) first, then the config file, then a first-run tip. When no key can be found anywhere, print an explanatory message and exit 1.

**Blocked by:** 01 — Scaffold + CLI

**Status:** done

- [x] Precedence order resolves correctly for a given key name
- [x] Key found in standard provider env var → zero config needed
- [x] Key only in config file → used as fallback
- [x] No key anywhere → explanatory first-run skill message, exit 1
- [x] `--provider` / `--model` flags override file and git-config values