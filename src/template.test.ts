import { describe, expect, test } from "bun:test";
import {
  buildFillInstructions,
  buildPrompt,
  DEFAULT_CONVENTIONAL_TEMPLATE,
  parseTemplate,
  segmentTemplate,
  strictFill,
} from "./template.ts";

const TPL = DEFAULT_CONVENTIONAL_TEMPLATE; // "{type}{scope}: {summary}\n\n{body}"

describe("parseTemplate", () => {
  test("accepts the conventional shape; type-first ⇒ conventional", () => {
    const r = parseTemplate(TPL);
    expect(r).toEqual({
      ok: true,
      kind: "conventional",
      tokens: ["type", "scope", "summary", "body"],
    });
  });
  test("anything else ⇒ custom", () => {
    const custom = parseTemplate("{summary}");
    expect(custom.ok && custom.kind).toBe("custom");
    const conv = parseTemplate("change {type} — {summary}");
    expect(conv.ok && conv.kind).toBe("conventional");
  });
  test("rejects an empty template (the caller substitutes the default)", () => {
    expect(parseTemplate("").ok).toBe(false);
    expect(parseTemplate("  \n ").ok).toBe(false);
  });
  test("rejects unknown tokens, naming the known set", () => {
    const r = parseTemplate("{type}: {msg}");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("{msg}");
      expect(r.error).toContain("{type}");
    }
  });
  test("rejects a token-less template", () => {
    const r = parseTemplate("a fixed subject");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no tokens");
  });
  test("rejects a repeated token", () => {
    const r = parseTemplate("{type} {type}: {summary}");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("more than once");
  });
});

describe("segmentTemplate", () => {
  test("splits literals and tokens in order", () => {
    const segs = segmentTemplate("{type}({scope}): {summary}\n{body}");
    expect(segs.map((s) => s.kind)).toEqual([
      "token",
      "literal",
      "token",
      "literal",
      "token",
      "literal",
      "token",
    ]);
    expect(segs[0]).toMatchObject({ kind: "token", name: "type" });
    expect(segs[1]).toMatchObject({ kind: "literal", text: "(" });
  });
});

describe("strictFill — happy path (fill contract)", () => {
  test("all tokens filled, subject and body separated by a blank line", () => {
    const out = [
      "type: feat",
      "scope: auth",
      "summary: add a login flow",
      "body: Replaces the cookie stub with session-backed auth.",
      "Second body line stays.",
    ].join("\n");
    const r = strictFill(TPL, out);
    expect(r).toEqual({
      ok: true,
      message:
        "feat(auth): add a login flow\n\nReplaces the cookie stub with session-backed auth.\nSecond body line stays.",
    });
  });

  test("scope sentinel '-' renders no scope and no parens", () => {
    const out = "type: chore\nscope: -\nsummary: bump deps\nbody: -";
    const r = strictFill(TPL, out);
    expect(r).toEqual({ ok: true, message: "chore: bump deps" });
  });

  test("empty value also means 'no value'", () => {
    const out = "type: docs\nscope:\nsummary: document the release step\nbody:";
    expect(strictFill(TPL, out)).toEqual({ ok: true, message: "docs: document the release step" });
  });

  test("a token alone on its line drops cleanly when empty", () => {
    const tpl = "{type}{scope}: {summary}\n\n{body}";
    const out = "type: feat\nscope: -\nsummary: add --no-commit\nbody: -";
    expect(strictFill(tpl, out)).toEqual({ ok: true, message: "feat: add --no-commit" });
  });

  test("single-token template", () => {
    expect(strictFill("{summary}", "summary: tighten the loop")).toEqual({
      ok: true,
      message: "tighten the loop",
    });
  });

  test("prefix literal is preserved", () => {
    const r = strictFill("COMMIT {type}: {summary}", "type: feat\nsummary: add thing");
    expect(r).toEqual({ ok: true, message: "COMMIT feat: add thing" });
  });

  test("the scope value gains its parens wherever {scope} sits in the template", () => {
    const r = strictFill("{type}: {summary} {scope}", "type: feat\nscope: cli\nsummary: add flags");
    expect(r).toEqual({ ok: true, message: "feat: add flags (cli)" });
  });

  test("a custom template's literal blank line survives render", () => {
    const r = strictFill(
      "{summary}\n\n{body}",
      "summary: tighten the loop\nbody: Because reasons.",
    );
    expect(r).toEqual({ ok: true, message: "tighten the loop\n\nBecause reasons." });
  });

  test("a legacy custom template with literal parens renders them once (idempotent)", () => {
    const r = strictFill(
      "{type}({scope}): {summary}",
      "type: feat\nscope: auth\nsummary: add login helper",
    );
    expect(r).toEqual({ ok: true, message: "feat(auth): add login helper" });
  });
});

describe("strictFill — the rejections the contract exists for", () => {
  test("a missing token is rejected, named", () => {
    const r = strictFill(TPL, "type: feat\nscope: auth\nsummary: x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("{body}");
  });

  // A prose line directly after a single-line field is absorbed into that
  // field's value and surfaces as a single-line violation on the same token —
  // still a rejected shape break, named where it belongs.
  test("stray prose absorbed into a single-line value is rejected at that token", () => {
    const r = strictFill(TPL, "type: feat\nHere is my commit:\nscope: auth\nsummary: x\nbody: y");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("{type}");
  });

  test("free-floating prose that absorbs into nothing is rejected as not a token line", () => {
    const r = strictFill(TPL, "Here is the commit:\ntype: feat\nscope: auth\nsummary: x\nbody: y");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not a token line");
  });

  test("a field the template did not ask for is stray prose", () => {
    const r = strictFill("{type}: {summary}", "type: feat\nscope: auth\nsummary: x");
    expect(r.ok).toBe(false);
  });

  test("leftover { } token names inside a value are rejected (the tiny-model echo)", () => {
    const r = strictFill(TPL, "type: {type}\nscope: -\nsummary: x\nbody: y");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("{type}");
  });

  test("a non-omissible token given no value is rejected", () => {
    // summary is not alone on its line in the default template → required
    const r = strictFill(TPL, "type: feat\nscope: auth\nsummary: -\nbody: -");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("{summary}");
  });

  test("type must be one word", () => {
    const r = strictFill(TPL, "type: add feature\nscope: x\nsummary: y\nbody: -");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("{type}");
  });

  test("scope must be a single word", () => {
    const r = strictFill(TPL, "type: feat\nscope: user login\nsummary: y\nbody: -");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("{scope}");
  });

  test("summary must stay on one line", () => {
    const r = strictFill(TPL, "type: feat\nscope: x\nsummary: first\nsecond\nbody: -");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("{summary}");
  });
});

describe("buildFillInstructions", () => {
  test("names exactly the template's tokens, in order", () => {
    const s = buildFillInstructions(["type", "scope", "summary", "body"]);
    for (const t of ["type:", "scope:", "summary:", "body:"]) expect(s).toContain(t);
    expect(s.indexOf("type:")).toBeLessThan(s.indexOf("scope:"));
    expect(s.indexOf("scope:")).toBeLessThan(s.indexOf("summary:"));
  });
  test("omits tokens the template does not use", () => {
    const s = buildFillInstructions(["summary"]);
    expect(s).toContain("summary:");
    expect(s).not.toContain("body:");
  });
});

describe("buildPrompt — PromptPolicy integration", () => {
  test("system prompt contains grounding, commit semantics, user instruction and style policies", () => {
    const p = buildPrompt(DEFAULT_CONVENTIONAL_TEMPLATE);
    expect(p).toContain("GROUNDING POLICY");
    expect(p).toContain("Treat the provided diff as the source of truth for what changed");
    expect(p).toContain(
      "Use file names as authoritative evidence of which files are represented in the input",
    );
    expect(p).toContain("COMMIT SEMANTICS");
    expect(p).toContain("Prefer the smallest accurate claim");
    expect(p).toContain("COMMIT TYPE");
    expect(p).toContain("not the file it touches");
    expect(p).toContain("Use feat for a new user-facing capability");
    expect(p).toContain("Use refactor for restructuring code without changing intended behavior");
    expect(p).toContain(
      "Do not choose feat merely because new code or functionality was added internally",
    );
    // Anti-slop: a generic subject/scope/body is the product's most visible failure.
    expect(p).toContain("SUBJECT");
    expect(p).toContain("name the concrete thing that changed");
    expect(p).toContain("SCOPE");
    expect(p).toContain("a scope that fits any change fits none");
    expect(p).toContain("BODY");
    expect(p).toContain("whether behavior changed");
    expect(p).toContain("boilerplate like for consistency");
    // Conventional-changelog heuristics: changelog-bullet subjects, backticked
    // identifiers, omit-scope-by-default, and visible-vs-hidden type split.
    expect(p).toContain("changelog bullet");
    expect(p).toContain("in backticks");
    expect(p).toContain("Omit scope by default");
    expect(p).toContain("Visible types");
    expect(p).toContain("Hidden types");
    expect(p).toContain(
      "Prompt text, user-facing messages, defaults, and config values are behavior",
    );
    expect(p).toContain("USER INSTRUCTION POLICY");
    expect(p).toContain("may not introduce unsupported factual claims");
    expect(p).toContain("STYLE HISTORY POLICY");
    expect(p).toContain("Style history is provided only as a stylistic reference");
    expect(p).toContain("Reply with exactly these lines");
  });
  test("output contract remains identical before/after refactor for conventional template", () => {
    const p = buildPrompt(DEFAULT_CONVENTIONAL_TEMPLATE);
    expect(p).toContain("type: <one word, one of:");
    expect(p).toContain("scope: <one short word");
    expect(p).toContain("summary: <one short imperative line naming the concrete thing changed");
    expect(p).toContain("body: <one short paragraph: what changed and whether behavior changed");
  });
});
