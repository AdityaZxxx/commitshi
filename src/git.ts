// Git access for commitshi. Everything here is read-only against the
// worktree: the tool only ever reads the staged changes and never stages,
// unstages, or writes anything.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runGit(args: readonly string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (cause) {
    const err = cause as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error("git not found on PATH — commitshi runs inside a git repository");
    }
    throw new Error("not a git repository (or git failed) — commitshi reads staged changes in a repo");
  }
}

export async function hasStagedChanges(cwd: string = process.cwd()): Promise<boolean> {
  const stdout = await runGit(["diff", "--cached", "--name-only"], cwd);
  return stdout.trim().length > 0;
}

/** Returns the root of the working tree (shared git dir layout aware). */
export async function workTreeRoot(cwd: string = process.cwd()): Promise<string> {
  return (await runGit(["rev-parse", "--show-toplevel"], cwd)).trim();
}

async function mergeInProgress(root: string): Promise<boolean> {
  return existsSync(join(root, ".git", "MERGE_HEAD"));
}

/** The full staged diff — the tool's only input. Unstaged/untracked never appear here. */
export async function stagedDiff(cwd: string = process.cwd()): Promise<string> {
  return runGit(["diff", "--cached"], cwd);
}

export type GuardResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: string; exitCode: number }>;

/**
 * Boundary checks before any pipeline work or model call: merge in progress,
 * nothing staged. Purely read-only; refusal explains why and never touches
 * the worktree.
 */
export async function guardStagedChanges(cwd: string = process.cwd()): Promise<GuardResult> {
  const root = await workTreeRoot(cwd);

  if (await mergeInProgress(root)) {
    return {
      ok: false,
      reason: "commitshi: merge in progress — finish or abort the merge, then stage and run again",
      exitCode: 1,
    };
  }

  if (!(await hasStagedChanges(cwd))) {
    return {
      ok: false,
      reason: "commitshi: nothing staged — stage changes with git add, then run commitshi",
      exitCode: 1,
    };
  }

  return { ok: true };
}
