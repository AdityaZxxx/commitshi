import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recentCommitSubjects } from "./git.ts";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "commitshi test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "commitshi test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
}

describe("recentCommitSubjects (ticket 10 — the --style seam)", () => {
  let workdir: string;
  const cleanup: Array<() => Promise<void>> = [];

  const freshRepo = async (): Promise<string> => {
    workdir = realpathSync(await mkdtemp(join(tmpdir(), "commitshi-history-")));
    cleanup.push(async () => rm(workdir, { recursive: true, force: true }));
    await git(workdir, "init", "-q");
    return workdir;
  };

  test("a fresh repo (unborn HEAD) returns [] without crashing", async () => {
    const repo = await freshRepo();
    const subjects = await recentCommitSubjects(8, repo);
    expect(subjects).toEqual([]);
    await Promise.all(cleanup.map((fn) => fn()));
  });

  test("returns the recent subjects newest-first", async () => {
    const repo = await freshRepo();
    await writeFile(join(repo, "a.txt"), "one\n");
    await git(repo, "add", "a.txt");
    await git(repo, "commit", "-q", "-m", "feat: first commit");
    await writeFile(join(repo, "b.txt"), "two\n");
    await git(repo, "add", "b.txt");
    await git(repo, "commit", "-q", "-m", "fix: second commit");
    await writeFile(join(repo, "c.txt"), "three\n");
    await git(repo, "add", "c.txt");
    await git(repo, "commit", "-q", "-m", "chore: third commit");

    const subjects = await recentCommitSubjects(8, repo);
    expect(subjects).toEqual(["chore: third commit", "fix: second commit", "feat: first commit"]);
    await Promise.all(cleanup.map((fn) => fn()));
  });

  test("caps at the requested limit (~8) when history is longer", async () => {
    const repo = await freshRepo();
    for (let i = 1; i <= 11; i++) {
      await writeFile(join(repo, `f${i}.txt`), `${i}\n`);
      await git(repo, "add", `f${i}.txt`);
      await git(repo, "commit", "-q", "-m", `commit number ${i}`);
    }
    const subjects = await recentCommitSubjects(8, repo);
    expect(subjects).toHaveLength(8);
    expect(subjects[0]).toBe("commit number 11");
    expect(subjects[7]).toBe("commit number 4");
    await Promise.all(cleanup.map((fn) => fn()));
  });

  test("multi-line commit bodies never leak past the subject", async () => {
    const repo = await freshRepo();
    await writeFile(join(repo, "a.txt"), "one\n");
    await git(repo, "add", "a.txt");
    await git(
      repo,
      "commit",
      "-q",
      "-m",
      "feat: subject only",
      "-m",
      "body line one\nbody line two",
    );
    const subjects = await recentCommitSubjects(8, repo);
    expect(subjects).toEqual(["feat: subject only"]);
    await Promise.all(cleanup.map((fn) => fn()));
  });

  test("a repo with history but a deleted .git returns [] instead of throwing", async () => {
    const repo = await freshRepo();
    await writeFile(join(repo, "a.txt"), "one\n");
    await git(repo, "add", "a.txt");
    await git(repo, "commit", "-q", "-m", "feat: one");
    await rm(join(repo, ".git"), { recursive: true, force: true });
    const subjects = await recentCommitSubjects(8, repo);
    expect(subjects).toEqual([]);
    await Promise.all(cleanup.map((fn) => fn()));
  });
});

// Acceptance: without --style the pipeline must never read git history.
// Rather than only a behavioral test, this is a static scan of the shipped
// source: the only file allowed to spawn `git log` is git.ts itself, the
// seam; main.ts may only mention it inside the `flags.style && ...` wiring
// and pipeline.ts must treat it as an absent seam by default.
describe("no silent history reads (ticket 10 acceptance)", () => {
  test("`git log` appears only in git.ts (the seam), nowhere else in shipped code", async () => {
    // main.ts wires the seam; everything else must be silent.
    for (const file of [
      "src/pipeline.ts",
      "src/loop.ts",
      "src/commit.ts",
      "src/compaction.ts",
      "src/config.ts",
    ]) {
      const text = await readFile(file, "utf8");
      expect(text).not.toContain("git log");
      expect(text).not.toContain("recentCommitSubjects");
    }
  });

  test("main.ts wires history strictly behind flags.style", async () => {
    const text = await readFile("src/main.ts", "utf8");
    // The exact wiring: the seam is reachable ONLY through the flag gate —
    // any unconditional history read would not match this string.
    expect(text).toContain("styleHistory: flags.style ? () => recentCommitSubjects() : undefined");
  });

  test("pipeline.ts declares history strictly optional and default-absent", async () => {
    const text = await readFile("src/pipeline.ts", "utf8");
    // styleHistory is `?:` — the no-flag path carries no seam at all, and the
    // one place that reads it refuses an absent seam before any read.
    expect(text).toContain("styleHistory?:");
    expect(text).toContain("if (deps.styleHistory === undefined) return null;");
  });
});
