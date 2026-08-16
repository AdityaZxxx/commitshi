// The commit stage: an accepted commit draft becomes a real commit through
// the user's normal git path — `git commit -F -` with the message on stdin,
// NEVER `-m`. Stdin is the only channel where the user's hooks
// (prepare-commit-msg, commit-msg), signing config, and any
// editor-for-body-data flow fire exactly as on a hand-typed `git commit`.
//
// This stage never stages anything: staging contact is exclusively the
// user's. The diff pipeline (tickets 03–05) is read-only by construction,
// the loop (07) never touches the index, and this module only ever spawns
// `git commit` with the already-accepted draft text — a test scans this
// file to keep the boundary from regressing.
//
// Failures fail loud: a hook that rejects the message, a missing identity,
// or any other non-zero `git commit` surfaces git's own stderr with a
// non-zero exit. Nothing is swallowed, no success is claimed, and there is
// no retry — after any failure the user is expected to re-run, a fresh
// attempt.

import { spawn } from "node:child_process";

export type CommitResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; exitCode: number; message: string }>;

/**
 * Commits the accepted draft via `git commit -F -` with the draft on stdin.
 *
 * - An empty or whitespace-only draft is refused outright: an empty/refused
 *   draft never yields a commit. git would reject an empty message too, but
 *   with `-F` it would open an editor for the body — an interactive hang
 *   this stage must never produce, so the draft is checked before git runs.
 * - stdin is closed right after the draft is written, so hooks read EOF
 *   exactly as with a hand-typed message.
 */
export async function commitAcceptedMessage(
  message: string,
  cwd: string = process.cwd(),
): Promise<CommitResult> {
  if (message.trim() === "") {
    return {
      ok: false,
      exitCode: 1,
      message: "commitshi: the draft is empty — nothing was committed",
    };
  }

  return new Promise<CommitResult>((resolve) => {
    // `-C <cwd>` (rather than spawn's cwd option) keeps the failure loud
    // even when the repo path itself is gone: git exits non-zero instead of
    // falling back to the test or shell's cwd.
    const child = spawn("git", ["-C", cwd, "commit", "-F", "-"], {
      stdio: ["pipe", "ignore", "pipe"],
      env: { ...process.env, GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" },
    });
    let err = "";
    child.stderr.on("data", (chunk) => {
      err += chunk.toString();
    });
    child.on("error", (cause) => {
      resolve({
        ok: false,
        exitCode: 1,
        message: `commitshi: could not run git commit: ${cause.message}`,
      });
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      const detail = err.trim();
      resolve({
        ok: false,
        exitCode: code ?? 1,
        message:
          detail === ""
            ? "commitshi: git commit failed — no commit was made"
            : `commitshi: git commit failed — no commit was made\n${detail}`,
      });
    });
    // One pristine, newline-terminated message: stray outer whitespace is
    // trimmed and a single trailing newline restored so the commit object
    // records exactly the accepted draft, byte for byte.
    child.stdin.end(`${message.trim()}\n`);
  });
}
