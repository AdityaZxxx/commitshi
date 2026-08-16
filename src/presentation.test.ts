// Presentation-layer tests at the helper seams: what reaches the screen,
// not how the ANSI is assembled. Existing loop tests pin the interactive
// frame; these pin the presentation fixes from the interface review
// (muted legibility, width-aware rules and numstat).

import { describe, expect, test } from "bun:test";
import { muted, resolveColors, TRUECOLOR, presentDraft, renderNumstat } from "./presentation.ts";

const on = resolveColors(true);
const off = resolveColors(false);

describe("muted — legibility", () => {
  test("muted emits the lifted oklch(0.58 …) grey, legible on dark terminals", () => {
    // was 38;2;113;124;128 (oklch 0.5, ~3.8:1 on dark); the affordance copy
    // (the key prompt) renders in muted, so it must clear ~4.5:1.
    expect(muted(on, "x")).toContain(TRUECOLOR.muted);
    expect(TRUECOLOR.muted).toContain("146;157;161");
  });

  test("muted is a no-op when color is disabled", () => {
    expect(muted(off, "x")).toBe("x");
  });
});

describe("renderNumstat — narrow terminals", () => {
  const wide = [
    { path: "src/a-very-long-file-name-that-goes-on.ts", added: 10, removed: 2, binary: false },
    { path: "src/b.ts", added: 1, removed: 0, binary: false },
  ];

  test("fits the width budget: longest path is ellipsized, counts survive", () => {
    const lines = renderNumstat(wide, 40);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(40);
    expect(lines[0]).toContain("…");
    expect(lines[0]).toContain("+10 -2"); // the data cell never truncates
    expect(lines[1]).toContain("src/b.ts");
  });

  test("wide terminal: no ellipsization, full paths", () => {
    const lines = renderNumstat(wide, 120);
    expect(lines[0]).toContain("src/a-very-long-file-name-that-goes-on.ts");
    expect(lines[0]).not.toContain("…");
  });

  test("no width given: behaves exactly as before (uncapped)", () => {
    const lines = renderNumstat(wide);
    expect(lines[0]).toContain("src/a-very-long-file-name-that-goes-on.ts");
  });
});

describe("presentDraft — width propagation", () => {
  test("columns flows through: rules and numstat respect the same width", () => {
    let buf = "";
    const stdout = { write: (s: string | Uint8Array) => ((buf += s.toString()), true) };
    presentDraft(stdout, {
      draft: "feat: x",
      draftNumber: 1,
      edited: false,
      revised: false,
      truncated: false,
      numstat: [
        { path: "a/very/long/path/that/will/not/fit.ts", added: 3, removed: 1, binary: false },
      ],
      prompt: "  [Enter] accept › ",
      colors: off,
      columns: 40,
    });
    const ruleLine = buf.split("\n").find((l) => l.includes("STAGED CHANGES"));
    expect(ruleLine).toBeDefined();
    expect(ruleLine!.length).toBeLessThanOrEqual(40);
    const numLine = buf.split("\n").find((l) => l.includes("+3 -1"));
    expect(numLine!.length).toBeLessThanOrEqual(40);
    expect(numLine).toContain("…");
  });
});
