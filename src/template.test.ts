import { describe, expect, test } from "bun:test";
import {
  buildFillInstructions,
  DEFAULT_CONVENTIONAL_TEMPLATE,
  parseTemplate,
  segmentTemplate,
  strictFill,
} from "./template.ts";

const TPL = DEFAULT_CONVENTIONAL_TEMPLATE; // "{type}({scope}): {summary}\n{body}"

describe("parseTemplate", () => {
  test("accepts the conventional shape; type-first ⇒ conventional", () => {
    const r = parseTemplate(TPL);
    expect(r).toEqual({ ok: true, kind: "conventional", tokens: ["type", "scope", "summary", "body"] });
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
    expect(segs.map((s) => s.kind)).toEqual(["token", "literal", "token", "literal", "token", "literal", "token"]);
    expect(segs[0]).toMatchObject({ kind: "token", name: "type" });
    expect(segs[1]).toMatchObject({ kind: "literal", text: "(" });
  });
});

describe("strictFill — happy path (fill contract)", () => {
  test("all tokens filled, body multi-line", () => {
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
      message: "feat(auth): add a login flow\nReplaces the cookie stub with session-backed auth.\nSecond body line stays.",
    });
  });

  test("scope sentinel '-' renders empty between the parens", () => {
    const out = "type: chore\nscope: -\nsummary: bump deps\nbody: -";
    const r = strictFill(TPL, out);
    expect(r).toEqual({ ok: true, message: "chore(): bump deps" });
  });

  test("empty value also means 'no value'", () => {
    const out = "type: docs\nscope:\nsummary: document the release step\nbody:";
    expect(strictFill(TPL, out)).toEqual({ ok: true, message: "docs(): document the release step" });
  });

  test("a token alone on its line drops cleanly when empty", () => {
    const tpl = "{type}: {summary}\n{body}";
    const out = "type: feat\nsummary: add --no-commit\nbody: -";
    expect(strictFill(tpl, out)).toEqual({ ok: true, message: "feat: add --no-commit" });
  });

  test("single-token template", () => {
    expect(strictFill("{summary}", "summary: tighten the loop")).toEqual({ ok: true, message: "tighten the loop" });
  });

  test("prefix literal is preserved", () => {
    const r = strictFill("COMMIT {type}: {summary}", "type: feat\nsummary: add thing");
    expect(r).toEqual({ ok: true, message: "COMMIT feat: add thing" });
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
