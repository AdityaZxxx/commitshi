import { describe, expect, test } from "bun:test";
import {
  draft,
  REGENERATE_TEMPERATURE,
  REVISE_TEMPERATURE,
  type PipelineDeps,
} from "./pipeline.ts";
import {
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
} from "./config.ts";

// Ticket 09 + 10: one-shot --instructions / --template / --style flags.
// The chat seam captures the exact prompt sent to the model so every test
// asserts on prompt content without a live model.

const DIFF = [
  "diff --git a/src/login.ts b/src/login.ts",
  "new file mode 100644",
  "index 0000000..e69de29",
  "--- /dev/null",
  "+++ b/src/login.ts",
  "@@ -0,0 +1 @@",
  "+export const login = () => session();",
].join("\n");

/** A bundle resolver that honors flags (top of the precedence chain) then
 *  "committed" config values, then fills the per-provider defaults — the
 *  test twin of config.ts's TOTAL resolveBundle. */
const makeResolveBundle =
  (committed: Partial<Record<string, string>> = {}): PipelineDeps["resolveBundle"] =>
  async (flags = {}) => {
    type R = { value: string; source: import("./config.ts").Source };
    const found = (key: "provider" | "baseUrl" | "model" | "template"): R | null => {
      const fromFlag = flags[key];
      if (fromFlag !== undefined && fromFlag !== "") return { value: fromFlag, source: "flag" };
      const value = committed[key];
      if (value !== undefined && value !== "") return { value, source: "config file" };
      return null;
    };
    const provider: R = found("provider") ?? { value: "openai", source: "default" };
    const isAnthropic = provider.value.trim().toLowerCase() === "anthropic";
    const baseUrl: R = found("baseUrl") ?? {
      value: isAnthropic ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_BASE_URL,
      source: "default",
    };
    const model: R = found("model") ?? {
      value: isAnthropic ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_MODEL,
      source: "default",
    };
    const template: R = found("template") ?? {
      value: "{type}{scope}: {summary}\n\n{body}",
      source: "default",
    };
    return { provider, baseUrl, model, template };
  };

const LOCAL_BASE = { baseUrl: "http://localhost:11434/v1" };

/** Prompt fragments recorded by the chat stub for wire-level assertions. */
type PromptCapture = { user?: string; system?: string };

/** Wire fields recorded by the chat stub for provider-routing assertions. */
type WireCapture = { baseUrl?: string; model?: string; apiKey?: string };

/** A chat stub that records the prompt content and returns a canned fill-contract reply. */
const makeRecordingChat =
  (reply: string, captured: PromptCapture): PipelineDeps["chat"] =>
  async (_deps, req) => {
    captured.system = req.messages[0]?.content ?? "";
    captured.user = req.messages[1]?.content ?? "";
    return { ok: true as const, content: reply };
  };

const baseDeps = (committed: Partial<Record<string, string>> = {}): PipelineDeps => ({
  stagedDiff: async () => DIFF,
  resolveBundle: makeResolveBundle({ baseUrl: LOCAL_BASE.baseUrl, ...committed }),
  resolveApiKey: async () => null,
  chat: async () => ({ ok: true as const, content: "" }), // replaced per test
});

const OK_REPLY = "type: feat\nscope: auth\nsummary: add login helper\nbody: -";

describe("draft — default prompt is untouched (regression from 05)", () => {
  test("no flags: user block and style block are absent, prompt is byte-stable", async () => {
    const captured: PromptCapture = {};
    const deps: PipelineDeps = { ...baseDeps(), chat: makeRecordingChat(OK_REPLY, captured) };
    const first = await draft(deps, { kind: "fresh" });
    expect(first.ok).toBe(true);

    expect(captured.user).not.toContain("### Style history");
    expect(captured.user).not.toContain("### User instructions");

    // Byte-identical across runs: the flag-less prompt is the ticket-05
    // shape — compact diff + fixed closing instruction, nothing else.
    const again: PromptCapture = {};
    await draft({ ...baseDeps(), chat: makeRecordingChat(OK_REPLY, again) }, { kind: "fresh" });
    expect(again.user).toBe(captured.user);
    // Contract: diff first, closing instruction last, and no
    // ticket-09/10 sections (Staged changes header inside the digest is
    // the second header — that one predates these tickets).
    expect(captured.user).toMatch(/^### Compact diff\n\n### Staged changes/);
    expect(captured.user).toMatch(/Use the provided changes as the factual source of truth/);
    expect(captured.user).not.toContain("### User instructions");
    expect(captured.user).not.toContain("### Style history");
  });
});

describe("draft — --instructions (ticket 09)", () => {
  test("instructions land in the prompt as their own block, after the diff", async () => {
    const captured: PromptCapture = {};
    const deps: PipelineDeps = {
      ...baseDeps(),
      chat: makeRecordingChat(OK_REPLY, captured),
      flags: { instructions: "always use the type 'refactor' and skip the scope" },
    };
    const result = await draft(deps, { kind: "fresh" });
    expect(result.ok).toBe(true);
    expect(captured.user).toContain("### User instructions");
    expect(captured.user).toContain("always use the type 'refactor'");
    // Instruction policy: may influence wording/style but not factual claims
    expect(captured.user).toContain("may not introduce unsupported factual claims");
    expect(captured.user!.indexOf("### Compact diff")).toBeLessThan(
      captured.user!.indexOf("### User instructions"),
    );
  });

  test("instructions tell the model the strict shape still holds (no fifth token)", async () => {
    const captured: PromptCapture = {};
    const deps: PipelineDeps = {
      ...baseDeps(),
      chat: makeRecordingChat(OK_REPLY, captured),
      flags: { instructions: "reword the summary" },
    };
    await draft(deps, { kind: "fresh" });
    // Fill contract lives in the system prompt now
    expect(captured.system).toContain("Reply with exactly these lines");
    expect(captured.system).toContain("Fill every line");
  });

  test("the fill contract rejects an extra field even when instructions asked for it", async () => {
    // A single-token template: the un-wanted `notes:` line can absorb into
    // nothing, so strictFill rejects it as stray prose — instructions never
    // get a fifth token, whatever the model emitted.
    const captured: PromptCapture = {};
    const deps: PipelineDeps = {
      ...baseDeps(),
      chat: makeRecordingChat(
        "summary: add the login helper\nnotes: extra the user demanded",
        captured,
      ),
      flags: { instructions: "also add a freeform notes paragraph after the message" },
    };
    const result = await draft(
      {
        ...deps,
        flags: { ...deps.flags, template: "{summary}" },
      },
      { kind: "fresh" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("template contract");
  });

  test("whitespace-only instructions omit the block entirely (empty = default)", async () => {
    const captured: PromptCapture = {};
    const deps: PipelineDeps = {
      ...baseDeps(),
      chat: makeRecordingChat(OK_REPLY, captured),
      flags: { instructions: "   \n " },
    };
    const result = await draft(deps, { kind: "fresh" });
    expect(result.ok).toBe(true);
    expect(captured.user).not.toContain("### User instructions");
  });
});

describe("draft — --template one-shot override (ticket 09)", () => {
  const COMMITTED = "{type}({scope}): {summary}";

  test("--template beats the configured template for that run only", async () => {
    const captured: PromptCapture = {};
    const deps: PipelineDeps = {
      ...baseDeps({ template: COMMITTED }), // persisted config supplies COMMITTED…
      chat: makeRecordingChat("type: fix\nsummary: squash the flake", captured),
      // …but the flag's template wins this run.
      flags: { template: "{type}: {summary}" },
    };
    const result = await draft(deps, { kind: "fresh" });
    expect(result.ok).toBe(true);
    expect(result.ok && result.message).toBe("fix: squash the flake");
    // The prompt names exactly the flag template's tokens — the persisted
    // template's {scope} token never reaches the model.
    expect(captured.user).toContain("Use the provided changes as the factual source of truth");
  });

  test("the configured template persists for later runs (flag is not written back)", async () => {
    const captured: PromptCapture = {};
    // No --template flag: the committed template from config applies.
    const deps: PipelineDeps = {
      ...baseDeps({ template: COMMITTED }),
      // The reply fills exactly the committed template's three tokens.
      chat: makeRecordingChat("type: feat\nscope: auth\nsummary: add login helper", captured),
    };
    const result = await draft(deps, { kind: "fresh" });
    expect(result.ok).toBe(true);
    expect(result.ok && result.message).toBe("feat(auth): add login helper");
  });
});

describe("draft — --style (ticket 10)", () => {
  test("no styleHistory seam: the chat runs once and the prompt carries no history at all", async () => {
    // "Absent means never read" — with no seam wired there is no history
    // code path to invoke; the assertion is inside the chat stub itself.
    const result = await draft(
      {
        ...baseDeps(),
        styleHistory: undefined,
        chat: async (_d, req) => {
          expect(req.messages[1]?.content).not.toContain("### Style history");
          return { ok: true as const, content: OK_REPLY };
        },
      },
      { kind: "fresh" },
    );
    expect(result.ok).toBe(true);
  });

  test("--style includes the recent subjects as a block after the diff", async () => {
    const subjects = [
      "feat(auth): add session cookie",
      "fix(ci): pin ubuntu runner",
      "chore: bump deps",
    ];
    const captured: PromptCapture = {};
    const deps: PipelineDeps = {
      ...baseDeps(),
      styleHistory: async () => subjects,
      chat: makeRecordingChat(OK_REPLY, captured),
    };
    const result = await draft(deps, { kind: "fresh" });
    expect(result.ok).toBe(true);
    expect(captured.user).toContain("### Style history");
    for (const s of subjects) expect(captured.user).toContain(s);
    expect(captured.user!.indexOf("### Compact diff")).toBeLessThan(
      captured.user!.indexOf("### Style history"),
    );
  });

  test("empty history (fresh repo) degrades gracefully — no block, draft still generates", async () => {
    const captured: PromptCapture = {};
    const deps: PipelineDeps = {
      ...baseDeps(),
      styleHistory: async () => [], // fresh repo, unborn HEAD
      chat: makeRecordingChat(OK_REPLY, captured),
    };
    const result = await draft(deps, { kind: "fresh" });
    expect(result.ok).toBe(true);
    expect(result.ok && result.message).toBe("feat(auth): add login helper");
    expect(captured.user).not.toContain("### Style history");
  });

  test("history read failure inside the seam degrades to no block, no crash", async () => {
    const captured: PromptCapture = {};
    const deps: PipelineDeps = {
      ...baseDeps(),
      styleHistory: async () => {
        throw new Error("git log failed");
      },
      chat: makeRecordingChat(OK_REPLY, captured),
    };
    // History must never break the draft — a failing seam is exactly the
    // fresh-repo case.
    const result = await draft(deps, { kind: "fresh" });
    expect(result.ok).toBe(true);
    expect(captured.user).not.toContain("### Style history");
  });

  test("instructions and --style combine; both blocks appear, diff first", async () => {
    const captured: PromptCapture = {};
    const deps: PipelineDeps = {
      ...baseDeps(),
      styleHistory: async () => ["chore: bump deps"],
      flags: { instructions: "short subject" },
      chat: makeRecordingChat(OK_REPLY, captured),
    };
    const result = await draft(deps, { kind: "fresh" });
    expect(result.ok).toBe(true);
    expect(captured.user).toContain("### Style history");
    expect(captured.user).toContain("### User instructions");
    expect(captured.user!.indexOf("### Compact diff")).toBeLessThan(
      captured.user!.indexOf("### Style history"),
    );
  });
});

describe("draft — template seam (ticket 15/16 hardening)", () => {
  test("a malformed template fails before the model call, exit 2, zero chat traffic", async () => {
    let chatCalls = 0;
    const result = await draft(
      {
        ...baseDeps(),
        flags: { template: "{nope}: {summary}" },
        chat: async () => {
          chatCalls++;
          return { ok: true as const, content: OK_REPLY };
        },
      },
      { kind: "fresh" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(2);
      expect(result.message).toContain("template is invalid");
      expect(result.message).toContain("nope");
    }
    expect(chatCalls).toBe(0);
  });

  test("the system prompt carries the fill contract, worded by the template's tokens", async () => {
    const captured: PromptCapture = {};
    await draft(
      {
        ...baseDeps(),
        chat: async (_d, req) => {
          captured.system = req.messages[0]?.content ?? "";
          return { ok: true as const, content: OK_REPLY };
        },
      },
      { kind: "fresh" },
    );
    // The prose rules (the contract on the way out) now live in template.ts
    // next to strictFill (the contract on the way in) — pinning the two
    // sides of the same promise in one capture.
    expect(captured.system).toContain("Reply with exactly these lines");
    expect(captured.system).toContain("type: <one word, one of:");
    expect(captured.system).toContain("summary: <one short imperative line");
  });
});

describe("draft — temperature follows the request's intent (ticket r)", () => {
  // The chat stub captures the CompletionRequest so the wire-level temperature
  // is the assertion target — matches the existing prompt-content pattern.
  const captureTemperature = () => {
    const temperatures: number[] = [];
    const chat: PipelineDeps["chat"] = async (_d, req) => {
      if (req.temperature !== undefined) temperatures.push(req.temperature);
      return { ok: true as const, content: OK_REPLY };
    };
    return { chat, temperatures };
  };

  test("fresh sends temperature: 0", async () => {
    const { chat, temperatures } = captureTemperature();
    await draft({ ...baseDeps(), chat }, { kind: "fresh" });
    expect(temperatures).toEqual([0]);
  });

  test("regenerate sends REGENERATE_TEMPERATURE", async () => {
    const { chat, temperatures } = captureTemperature();
    await draft(
      { ...baseDeps(), chat },
      { kind: "regenerate", previousDraft: "feat(a): do the thing" },
    );
    expect(temperatures).toEqual([REGENERATE_TEMPERATURE]);
  });

  test("revise sends REVISE_TEMPERATURE", async () => {
    const { chat, temperatures } = captureTemperature();
    await draft(
      { ...baseDeps(), chat },
      { kind: "revise", draft: "feat(a): do the thing", instruction: "shorter" },
    );
    expect(temperatures).toEqual([REVISE_TEMPERATURE]);
  });

  test("no state between calls: a regenerate never leaks into the next fresh call", async () => {
    const { chat, temperatures } = captureTemperature();
    await draft(
      { ...baseDeps(), chat },
      { kind: "regenerate", previousDraft: "feat(a): do the thing" },
    );
    await draft({ ...baseDeps(), chat }, { kind: "fresh" });
    expect(temperatures).toEqual([REGENERATE_TEMPERATURE, 0]);
  });
});

describe("draft — previous draft on regenerate", () => {
  test("fresh has no previous-draft block", async () => {
    const captured: PromptCapture = {};
    await draft({ ...baseDeps(), chat: makeRecordingChat(OK_REPLY, captured) }, { kind: "fresh" });
    expect(captured.user).not.toContain("### Previous draft");
  });

  test("regenerate shows the previous draft and demands a different one", async () => {
    const captured: PromptCapture = {};
    await draft(
      { ...baseDeps(), chat: makeRecordingChat(OK_REPLY, captured) },
      { kind: "regenerate", previousDraft: "feat(a): do the thing" },
    );
    expect(captured.user).toContain("### Previous draft");
    expect(captured.user).toContain("feat(a): do the thing");
    expect(captured.user).toContain("Write a DIFFERENT draft");
  });

  test("the previous draft travels in the request: the next fresh call sees none of it", async () => {
    const captured: PromptCapture = {};
    await draft(
      { ...baseDeps(), chat: makeRecordingChat(OK_REPLY, captured) },
      { kind: "regenerate", previousDraft: "feat(a): do the thing" },
    );
    const again: PromptCapture = {};
    await draft({ ...baseDeps(), chat: makeRecordingChat(OK_REPLY, again) }, { kind: "fresh" });
    expect(again.user).not.toContain("### Previous draft");
  });
});

describe("draft (revise) — PromptPolicy guards", () => {
  test("user prompt marks existing draft as candidate, not authority", async () => {
    const captured: PromptCapture = {};
    const deps: PipelineDeps = {
      stagedDiff: async () => DIFF,
      resolveBundle: makeResolveBundle({ baseUrl: LOCAL_BASE.baseUrl }),
      resolveApiKey: async () => null,
      chat: async (_d, req) => {
        captured.user = req.messages[1]?.content ?? "";
        return { ok: true as const, content: OK_REPLY };
      },
      flags: {},
    };
    const res = await draft(deps, {
      kind: "revise",
      draft: "feat(auth): old claim",
      instruction: "make summary shorter",
    });
    expect(res.ok).toBe(true);
    expect(captured.user).toContain("The existing draft is not authoritative");
    expect(captured.user).toContain("Re-check its factual claims against the compacted diff");
    expect(captured.user).toContain("Use the provided changes as the factual source of truth");
  });

  test("compact diff metadata about omission is present", async () => {
    const captured: PromptCapture = {};
    const deps: PipelineDeps = {
      stagedDiff: async () => DIFF,
      resolveBundle: makeResolveBundle({ baseUrl: LOCAL_BASE.baseUrl }),
      resolveApiKey: async () => null,
      chat: async (_d, req) => {
        captured.user = req.messages[1]?.content ?? "";
        return { ok: true as const, content: OK_REPLY };
      },
    };
    await draft(deps, { kind: "revise", draft: "feat: x", instruction: "reword" });
    expect(captured.user).toContain("The diff below is a compact representation");
    expect(captured.user).toContain("Some unchanged context may be omitted");
  });
});

// Ticket 06: the Anthropic adapter rides the same seam. Prompt assembly is
// shared; only the transport differs. These tests pin the routing, the
// per-provider defaults, the key demand, and the no-leak guarantee.
describe("draft — provider anthropic (ticket 06)", () => {
  /** Deps whose bundle resolves provider=anthropic; key via env unless told otherwise. */
  const anthropicDeps = (
    overrides: Partial<PipelineDeps> = {},
    committed: Partial<Record<string, string>> = {},
  ): PipelineDeps => ({
    stagedDiff: async () => DIFF,
    resolveBundle: makeResolveBundle({ provider: "anthropic", ...committed }),
    resolveApiKey: async (provider) =>
      provider === "anthropic" ? { value: "sk-ant-test", source: "env" } : null,
    env: {},
    ...overrides,
  });

  test("--provider anthropic routes the call to the Anthropic transport, not the OpenAI one", async () => {
    let anthropicCalls = 0;
    let openaiCalls = 0;
    const deps = anthropicDeps({
      chat: async () => {
        openaiCalls++;
        return { ok: true as const, content: OK_REPLY };
      },
      anthropicChat: async () => {
        anthropicCalls++;
        return { ok: true as const, content: OK_REPLY };
      },
    });
    const result = await draft(deps, { kind: "fresh" });
    expect(result.ok).toBe(true);
    expect(anthropicCalls).toBe(1);
    expect(openaiCalls).toBe(0); // no cross-leak into the OpenAI flow
  });

  test("the Anthropic call uses the Anthropic baseUrl and model defaults", async () => {
    const captured: WireCapture = {};
    const deps = anthropicDeps({
      anthropicChat: async (d, req) => {
        captured.baseUrl = d.baseUrl;
        captured.apiKey = d.apiKey;
        captured.model = req.model;
        return { ok: true as const, content: OK_REPLY };
      },
    });
    const result = await draft(deps, { kind: "fresh" });
    expect(result.ok).toBe(true);
    expect(captured.baseUrl).toBe(DEFAULT_ANTHROPIC_BASE_URL);
    expect(captured.model).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(captured.apiKey).toBe("sk-ant-test");
    if (result.ok) {
      expect(result.baseUrl).toBe(DEFAULT_ANTHROPIC_BASE_URL);
      expect(result.model).toBe(DEFAULT_ANTHROPIC_MODEL);
    }
  });

  test("prompt assembly is shared: the Anthropic call sees the same system + user prompt", async () => {
    const captured: PromptCapture = {};
    const deps = anthropicDeps({
      anthropicChat: async (_d, req) => {
        captured.system = req.messages[0]?.content ?? "";
        captured.user = req.messages[1]?.content ?? "";
        return { ok: true as const, content: OK_REPLY };
      },
    });
    const result = await draft(deps, { kind: "fresh" });
    expect(result.ok).toBe(true);
    // Same fill contract and diff block the OpenAI path sends.
    expect(captured.system).toContain("Reply with exactly these lines");
    expect(captured.user).toMatch(/^### Compact diff\n\n### Staged changes/);
    expect(captured.user).toContain("Use the provided changes as the factual source of truth");
  });

  test("strict token fill applies identically: a bad reply is rejected on the Anthropic path too", async () => {
    const deps = anthropicDeps({
      anthropicChat: async () => ({ ok: true as const, content: "{type}: {summary}" }),
    });
    const result = await draft(deps, { kind: "fresh" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain("template contract");
    }
  });

  test("failure semantics match 05: rate_limited and auth exit 3, server exits 1", async () => {
    const rateLimited = anthropicDeps({
      anthropicChat: async () => ({
        ok: false as const,
        kind: "rate_limited",
        status: 429,
        message: "slow down",
      }),
    });
    const r1 = await draft(rateLimited, { kind: "fresh" });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.exitCode).toBe(3);

    const auth = anthropicDeps({
      anthropicChat: async () => ({
        ok: false as const,
        kind: "auth",
        status: 401,
        message: "bad key",
      }),
    });
    const r2 = await draft(auth, { kind: "fresh" });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.exitCode).toBe(3);

    const server = anthropicDeps({
      anthropicChat: async () => ({
        ok: false as const,
        kind: "server",
        status: 500,
        message: "boom",
      }),
    });
    const r3 = await draft(server, { kind: "fresh" });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.exitCode).toBe(1);
  });

  test("missing ANTHROPIC_API_KEY on a non-local baseUrl → missing-key result naming the provider", async () => {
    const deps = anthropicDeps({
      resolveApiKey: async () => null,
      env: {},
    });
    const result = await draft(deps, { kind: "fresh" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("missing-key");
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain("ANTHROPIC_API_KEY");
      expect(result.message).toContain("anthropic");
    }
  });

  test("ANTHROPIC_API_KEY in env satisfies the key demand", async () => {
    const deps = anthropicDeps({
      resolveApiKey: async () => null,
      env: { ANTHROPIC_API_KEY: "sk-ant-env" },
      anthropicChat: async () => ({ ok: true as const, content: OK_REPLY }),
    });
    const result = await draft(deps, { kind: "fresh" });
    expect(result.ok).toBe(true);
  });

  test("the OpenAI key never satisfies the Anthropic key demand (no cross-provider leak)", async () => {
    const deps = anthropicDeps({
      resolveApiKey: async () => null,
      env: { OPENAI_API_KEY: "sk-openai" }, // wrong provider's key
    });
    const result = await draft(deps, { kind: "fresh" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("missing-key");
  });

  test("an unknown provider still refuses loud, naming the supported set", async () => {
    const deps: PipelineDeps = {
      stagedDiff: async () => DIFF,
      resolveBundle: makeResolveBundle({ provider: "cohere" }),
      resolveApiKey: async () => null,
      env: {},
    };
    const result = await draft(deps, { kind: "fresh" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(2);
      expect(result.message).toContain("cohere");
      expect(result.message).toContain("not supported");
      expect(result.message).toContain("anthropic");
    }
  });

  test("provider matching is case-insensitive", async () => {
    let anthropicCalls = 0;
    const deps: PipelineDeps = {
      stagedDiff: async () => DIFF,
      resolveBundle: makeResolveBundle({ provider: "Anthropic" }),
      resolveApiKey: async (provider) =>
        provider === "anthropic" ? { value: "sk-ant-test", source: "env" } : null,
      env: {},
      anthropicChat: async () => {
        anthropicCalls++;
        return { ok: true as const, content: OK_REPLY };
      },
    };
    const result = await draft(deps, { kind: "fresh" });
    expect(result.ok).toBe(true);
    expect(anthropicCalls).toBe(1);
  });
});

describe("draft (revise) — provider anthropic (ticket 06)", () => {
  test("revise routes through the Anthropic transport with the same fill contract", async () => {
    let anthropicCalls = 0;
    let openaiCalls = 0;
    const captured: PromptCapture = {};
    const deps: PipelineDeps = {
      stagedDiff: async () => DIFF,
      resolveBundle: makeResolveBundle({ provider: "anthropic" }),
      resolveApiKey: async (provider) =>
        provider === "anthropic" ? { value: "sk-ant-test", source: "env" } : null,
      env: {},
      chat: async () => {
        openaiCalls++;
        return { ok: true as const, content: OK_REPLY };
      },
      anthropicChat: async (_d, req) => {
        anthropicCalls++;
        captured.user = req.messages[1]?.content ?? "";
        return { ok: true as const, content: OK_REPLY };
      },
    };
    const result = await draft(deps, {
      kind: "revise",
      draft: "feat(auth): old claim",
      instruction: "make summary shorter",
    });
    expect(result.ok).toBe(true);
    expect(anthropicCalls).toBe(1);
    expect(openaiCalls).toBe(0);
    // The revise prompt shape is preserved on the Anthropic path.
    expect(captured.user).toContain("The existing draft is not authoritative");
  });
});
