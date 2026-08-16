import { describe, expect, test } from "bun:test";
import {
  HUNK_CAP,
  compact,
  numstat,
  parseDiff,
  renderCompacted,
  slimHunk,
  type DiffHunk,
} from "./compaction.ts";

function hunk(oldStart: number, ...lines: string[]): DiffHunk {
  return { oldStart, lines };
}

describe("slimHunk", () => {
  test("small hunk is unchanged", () => {
    const body = hunk(10, " const a", "-old", "+new", " const b");
    expect(slimHunk(body)).toBe([" const a", "-old", "+new", " const b"].join("\n"));
  });

  test("middle unchanged gap collapses to a line-range slit", () => {
    const body = hunk(
      1,
      " head",
      "-removed",
      "+added",
      ...Array.from({ length: 10 }, (_, i) => ` ctx${i}`),
      "-gone",
      "+here",
      " tail",
    );
    expect(slimHunk(body)).toBe(
      [" head", "-removed", "+added", " ctx0", "⋮ 5–12", " ctx9", "-gone", "+here", " tail"].join(
        "\n",
      ),
    );
  });

  test("long added run is windowed with a remainder count", () => {
    const added = Array.from({ length: 60 }, (_, i) => `+line ${i}`);
    const body = hunk(1, " ctx", ...added);
    const slim = slimHunk(body);
    expect(slim).toContain("+line 0");
    expect(slim).toContain(`+line 39`);
    expect(slim).toContain("+… (20 more added lines)");
    expect(slim).not.toContain("+line 40\n");
    expect(slim).not.toContain("+line 59");
  });

  test("collapsed region spans correct old-line range", () => {
    const body = hunk(
      100,
      " a",
      "+x",
      ...Array.from({ length: 8 }, (_, i) => ` c${i}`),
      "+y",
      " b",
    );
    const slim = slimHunk(body);
    // old lines: a=100, c0..c7=101..108, b=109; radius 1 keeps c0 and c7
    expect(slim).toContain("⋮ 103–108");
    expect(slim).toContain(" c0");
    expect(slim).toContain(" c7");
  });
});

describe("parseDiff (real git binary diff)", () => {
  test("'Binary files differ' diff keeps paths and counts zero hunks", () => {
    const diff = [
      "diff --git a/logo.png b/logo.png",
      "index 08d0c92..b7d5379 100644",
      "Binary files a/logo.png and b/logo.png differ",
    ].join("\n");
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ oldPath: "logo.png", newPath: "logo.png", binary: true });
  });
});

describe("parseDiff", () => {
  test("splits files, detects new/deleted/binary, captures open hunks", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-old",
      "+new",
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "index 000..333",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1 @@",
      "+created",
      "diff --git a/img.png b/img.png",
      "Binary files a/img.png and b/img.png differ",
    ].join("\n");
    const files = parseDiff(diff);
    expect(files).toHaveLength(3);
    expect(files[0]).toMatchObject({ oldPath: "src/a.ts", newPath: "src/a.ts", binary: false });
    expect(files[0].hunks).toHaveLength(1);
    expect(files[1]).toMatchObject({ oldPath: null, newPath: "src/new.ts" });
    expect(files[2]).toMatchObject({ oldPath: "img.png", newPath: "img.png", binary: true });
    expect(files[2].hunks).toHaveLength(0);
  });

  test("quoted paths keep their inner spelling", () => {
    const diff = [
      'diff --git "a/a b.txt" "b/a b.txt"',
      '--- "a/a b.txt"',
      '+++ "b/a b.txt"',
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n");
    const [file] = parseDiff(diff);
    expect(file.oldPath).toBe("a b.txt");
    expect(file.newPath).toBe("a b.txt");
  });
});

describe("numstat", () => {
  test("counts +/- per file; binary files carry nulls", () => {
    const files = parseDiff(
      [
        "diff --git a/x b/x",
        "--- a/x",
        "+++ b/x",
        "@@ -1,2 +1,3 @@",
        " a",
        "-r1",
        "-r2",
        "+a1",
        "+a2",
        "+a3",
        "diff --git a/bin b/bin",
        "Binary files a/bin and b/bin differ",
      ].join("\n"),
    );
    expect(files).toHaveLength(2);
    expect(numstat(files)).toEqual([
      { path: "x", added: 3, removed: 2, binary: false },
      { path: "bin", added: null, removed: null, binary: true },
    ]);
  });
});

describe("compact", () => {
  test("small diff: numstat + slim hunks, not truncated", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,3 @@",
      " keep",
      "-old",
      "+new",
      " keep2",
    ].join("\n");
    const result = compact(diff);
    expect(result.truncated).toBe(false);
    expect(result.numstat).toEqual([{ path: "src/a.ts", added: 1, removed: 1, binary: false }]);
    expect(result.hunks).toContain("file: src/a.ts");
    expect(result.hunks).toContain("-old");
    expect(result.hunks).toContain("+new");
  });

  test("large real diff compacts to a fraction without losing file list", () => {
    // one file with a big unchanged middle between two edits
    const ctx = Array.from({ length: 2000 }, (_, i) => ` line ${i}`);
    const diff = [
      "diff --git a/big.txt b/big.txt",
      "--- a/big.txt",
      "+++ b/big.txt",
      "@@ -1,2004 +1,2004 @@",
      " head",
      "-v1",
      "+v2",
      ...ctx,
      "-t1",
      "+t2",
      " tail",
    ].join("\n");
    const result = compact(diff);
    expect(result.truncated).toBe(false);
    expect(result.numstat).toEqual([{ path: "big.txt", added: 2, removed: 2, binary: false }]);
    expect(result.hunks.length).toBeLessThan(diff.length / 4);
    expect(result.hunks).toContain("⋮");
    expect(result.hunks).toContain("-v1");
    expect(result.hunks).toContain("+t2");
    expect(result.numstat.map((s) => s.path)).toEqual(["big.txt"]);
  });

  test("over the hunk cap the digest is marked truncated and the render discloses it", () => {
    const many = Array.from({ length: HUNK_CAP + 1 }, (_, i) =>
      [`diff --git a/f${i} b/f${i}`, `--- a/f${i}`, `+++ b/f${i}`, "@@ -1 +1 @@", "-a", "+b"].join(
        "\n",
      ),
    ).join("\n");
    const result = compact(many);
    expect(result.truncated).toBe(true);
    const rendered = renderCompacted(result);
    expect(rendered).toContain("truncated");
    // every touched path still appears in the numstat even when hunks are cut
    const files = parseDiff(many)
      .map((f) => f.newPath)
      .filter((p): p is string => p !== null);
    for (const path of files) {
      expect(rendered).toContain(path);
    }
  });
});
