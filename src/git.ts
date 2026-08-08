import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type GitError = Error & { code?: number | string };

async function runGit(args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [...args], { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (cause) {
    const err = cause as GitError;
    if ((err as { code?: string }).code === "ENOENT") {
      throw new Error("git not found on PATH — commitshi runs inside a git repository");
    }
    // "not a git repository" and any other git-level failure land the same way:
    // commitshi only operates on staged changes inside a repo.
    throw new Error("not a git repository (or git failed) — commitshi reads staged changes in a repo");
  }
}

export async function hasStagedChanges(): Promise<boolean> {
  const stdout = await runGit(["diff", "--cached", "--name-only"]);
  return stdout.trim().length > 0;
}
