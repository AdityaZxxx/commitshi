import { describe, expect, test } from "bun:test";
import { parseArgs, USAGE } from "./cli.ts";

describe("parseArgs", () => {
  test("no flags parses with all defaults", () => {
    const result = parseArgs([]);
    expect(result).toEqual({
      ok: true,
      flags: { help: false, noCommit: false, regenerate: false },
    });
  });

  test("boolean flags parse", () => {
    const result = parseArgs(["--no-commit", "--regenerate"]);
    expect(result.ok && result.flags.noCommit).toBe(true);
    expect(result.ok && result.flags.regenerate).toBe(true);
    expect(result.ok && result.flags.help).toBe(false);
  });

  test("value flags capture their following argument", () => {
    const result = parseArgs([
      "--instructions",
      "keep it under 50 chars",
      "--template",
      "{type}: {summary}",
      "--provider",
      "openai",
      "--model",
      "gpt-4o-mini",
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flags.instructions).toBe("keep it under 50 chars");
    expect(result.flags.template).toBe("{type}: {summary}");
    expect(result.flags.provider).toBe("openai");
    expect(result.flags.model).toBe("gpt-4o-mini");
  });

  test("unknown flag is a clean error, not a throw", () => {
    const result = parseArgs(["--nope"]);
    expect(result).toEqual({ ok: false, error: "unknown flag: --nope" });
  });

  test("unknown bare arguments are rejected", () => {
    const result = parseArgs(["foo"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("foo");
  });

  test("a value flag missing its value is an error", () => {
    const result = parseArgs(["--model"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("--model");
  });

  test("a value flag followed by another flag is an error, not a swallowed flag", () => {
    const result = parseArgs(["--instructions", "--no-commit"]);
    expect(result.ok).toBe(false);
  });

  test("usage text lists every documented flag for --help", () => {
    for (const flag of [
      "--no-commit",
      "--regenerate",
      "--instructions",
      "--template",
      "--provider",
      "--model",
      "--help",
    ]) {
      expect(USAGE).toContain(flag);
    }
  });
});
