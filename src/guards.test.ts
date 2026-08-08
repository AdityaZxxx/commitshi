import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardStagedChanges, stagedDiff } from "./git.ts";
import { main } from "./main.ts";

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

describe("staged-change guards (sandboxed repos)", () => {
  let workdir: string;
  let previousCwd: string;

  beforeEach(async () => {
    previousCwd = process.cwd();
    workdir = realpathSync(await mkdtemp(join(tmpdir(), "commitshi-guard-")));
    process.chdir(workdir);
    await git(workdir, "init", "-q");
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    await rm(workdir, { recursive: true, force: true });
  });

  test("nothing staged refuses with a reason and no model call", async () => {
    const guard = await guardStagedChanges(process.cwd());
    expect(guard.ok).toBe(false);
    if (guard.ok) return;
    expect(guard.exitCode).not.toBe(0);
    expect(guard.reason).toContain("nothing staged");
  });

  test("merge in progress refuses even with staged changes", async () => {
    await writeFile(join(workdir, "base.txt"), "base\n");
    await git(workdir, "add", "base.txt");
    await git(workdir, "commit", "-q", "-m", "base");

    await git(workdir, "checkout", "-q", "-b", "theirs");
    await writeFile(join(workdir, "conflict.txt"), "theirs\n");
    await git(workdir, "add", "conflict.txt");
    await git(workdir, "commit", "-q", "-m", "theirs");

    await git(workdir, "checkout", "-q", "main");
    await writeFile(join(workdir, "conflict.txt"), "ours\n");
    await git(workdir, "add", "conflict.txt");
    await git(workdir, "commit", "-q", "-m", "ours");

    // Merging now conflicts on conflict.txt; MERGE_HEAD exists and the
    // conflicting path is staged (ours), which must not fool the guard.
    const merge = Bun.spawn(["git", "merge", "theirs"], {
      cwd: workdir,
      env: { ...process.env, ...GIT_ENV },
      stdout: "pipe",
      stderr: "pipe",
    });
    await merge.exited;

    const guard = await guardStagedChanges(process.cwd());
    expect(guard.ok).toBe(false);
    if (guard.ok) return;
    expect(guard.reason).toContain("merge");
    expect(guard.exitCode).not.toBe(0);
  });

  test("only unstaged changes: refuses, and stagedDiff returns empty", async () => {
    await writeFile(join(workdir, "a.txt"), "one\n");
    await git(workdir, "add", "a.txt");
    await git(workdir, "commit", "-q", "-m", "add a");
    await writeFile(join(workdir, "a.txt"), "one\ntwo\n"); // unstaged edit

    const guard = await guardStagedChanges(process.cwd());
    expect(guard.ok).toBe(false);
    expect(await stagedDiff(process.cwd())).toBe("");
  });

  test("only untracked files: refuses with a reason", async () => {
    await git(workdir, "commit", "-q", "--allow-empty", "-m", "init");
    await writeFile(join(workdir, "new.txt"), "never staged\n");

    const guard = await guardStagedChanges(process.cwd());
    expect(guard.ok).toBe(false);
    if (guard.ok) return;
    expect(guard.reason).toContain("nothing staged");
  });

  test("staged present and no merge: passes, and the diff is the staged view only", async () => {
    await writeFile(join(workdir, "staged.txt"), "staged content\n");
    await git(workdir, "add", "staged.txt");
    await writeFile(join(workdir, "unstaged.txt"), "unstaged content\n");

    const guard = await guardStagedChanges(process.cwd());
    expect(guard.ok).toBe(true);

    const diff = await stagedDiff(process.cwd());
    expect(diff).toContain("staged.txt");
    expect(diff).toContain("+staged content");
    expect(diff).not.toContain("unstaged content");
  });

  test("guard refusal is what main prints for an empty staged set", async () => {
    let errBuf = "";
    const err = { write: (c: string | Uint8Array) => ((errBuf += c.toString()), true) };
    const code = await main([], { write: () => true }, err);
    expect(code).not.toBe(0);
    expect(errBuf).toContain("nothing staged");
  });

  test("worktree is untouched after a refusal", async () => {
    await mkdir(join(workdir, "sub"), { recursive: true });
    await writeFile(join(workdir, "sub", "dirty.txt"), "dirty\n");

    await guardStagedChanges(process.cwd());

    const proc = Bun.spawn(["git", "status", "--porcelain"], {
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    const status = (await new Response(proc.stdout).text()).trim();
    expect(status).toBe("?? sub/");
  });
});
