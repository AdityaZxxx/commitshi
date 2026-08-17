// The interactive accept / edit / regenerate loop around a commit draft.
//
// Stage contract (the loop is the stage before the commit stage, ticket 08):
//   ok: "accepted"  — this draft (edited or not) proceeds to the next stage.
//   ok: "cancel"    — the user aborted; nothing proceeds, exit 0.
//   ok: false       — a hard failure (editor, stdin, TTY); the loud message
//                     is printed and the loop's exit code is used. Never a
//                     silent accept, never a commit.
//
// All IO is behind seams: keys come from `ask` (default: raw-mode keypresses
// on a TTY), the editor runs through `spawn`, and regeneration calls the
// injected `regenerate` (which re-runs the draft pipeline against the SAME
// unchanged staged diff). Tests drive the loop headless by injecting `ask`.

import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { spawn as nodeSpawn } from "node:child_process";
import { presentDraft, resolveColors, shouldEmitColor } from "./presentation.ts";
import { startLoader } from "./loader.ts";
import {
  run,
  type EditorStdin,
  type EditorStdout,
  type InlineResult,
} from "./inline-editor/index.ts";
import type { NumstatEntry } from "./compaction.ts";

/** One raw keypress chunk from the user: the bytes as typed, unnormalized; null on EOF. */
export type AskKey = () => Promise<string | null>;

export type LoopDeps = Readonly<{
  stdin: EditorStdin;
  stdout: EditorStdout;
  stderr: Pick<NodeJS.WriteStream, "write">;
  /** TTY checks are seams so tests drive the loop without a pty. */
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  /** Resolved $EDITOR (deps.env wins over process.env). */
  env?: NodeJS.ProcessEnv;
  /** Editor spawn seam: runs `$EDITOR <path>`, resolves with the exit code. */
  spawn?: (editor: string, path: string) => Promise<number>;
  /** Key source seam; production reads single keypresses in raw mode. */
  ask?: AskKey;
  /** Color-emission seam (tests); production derives it from TTY + NO_COLOR + CI. */
  colorEnabled?: boolean;
  /** Produces a fresh draft for the same staged diff; receives the draft being
   * replaced so the model can write a different one. Failure ends the loop loud. */
  regenerate: (previousDraft: string) => Promise<DraftAttempt>;
  /** Revise the current draft with a user instruction; failure ends the loop loud. */
  revise?: (draft: string, instruction: string) => Promise<DraftAttempt>;
  /** Loader seam (tests): called around await regenerate(). Production shows
   *  the spinner; tests may inject a no-op. */
  startLoader?: (label: string, write: (s: string) => void, isTTY: boolean) => { stop: () => void };
}>;

/** One draft under consideration, or the loud failure to produce one. */
export type DraftAttempt =
  | Readonly<{ ok: true; draft: string; truncated: boolean; numstat: readonly NumstatEntry[] }>
  | Readonly<{ ok: false; exitCode: number; message: string }>;

export type LoopResult =
  | Readonly<{ ok: true; action: "accepted"; draft: string; regenerations: number }>
  | Readonly<{ ok: true; action: "cancel"; draft: string; regenerations: number }>
  | Readonly<{ ok: false; exitCode: number; message: string }>;

/**
 * The decision prompt, rendered once per frame by presentDraft (the frame's
 * own source of truth about editing modes is one rule away from the docs:
 * `i` splits into the EDIT floor below the rows; the DRAFT section keeps the
 * default English names for the commands, single-bucket and consultable).
 */
const PROMPT =
  "[Enter] accept  ·  [i] edit here  ·  [e] edit in editor  ·  [r] regenerate  ·  [p] revise  ·  [q] quit";

type FileIo = { file: (path: string) => { text: () => Promise<string> } };

const nodeFileIo: FileIo = { file: (path) => ({ text: () => readFile(path, "utf8") }) };

/**
 * Production key source: raw-mode keypress chunks on the TTY, delivered
 * verbatim. null on EOF. Ctrl-C arrives as "\x03"; what it means (interrupt
 * vs cancel) is the consumer's call.
 */
function makeKeyAsker(stdin: EditorStdin) {
  const restore = () => {
    stdin.setRawMode?.(false);
    stdin.pause();
  };
  stdin.setRawMode?.(true);
  stdin.resume();

  const ask: AskKey = () =>
    new Promise<string | null>((resolve) => {
      const cleanup = () => {
        stdin.removeListener("data", onData);
        stdin.removeListener("end", onEnd);
        stdin.removeListener("close", onEnd);
      };
      const onData = (chunk: Buffer) => {
        cleanup();
        resolve(chunk.toString("utf8"));
      };
      const onEnd = () => {
        cleanup();
        resolve(null);
      };
      stdin.once("data", onData);
      stdin.once("end", onEnd);
      stdin.once("close", onEnd);
    });

  return { ask, close: restore };
}

/** Real IO behind the editor spawn seam, used in production. */
const runEditor: NonNullable<LoopDeps["spawn"]> = async (editor, path) => {
  // The editor inherits stdio so it takes over the terminal; the user edits
  // in place. We resolve with the editor's exit code. Node's `spawn` fires
  // `exit` once the process ends; with stdio inherited there are no streams
  // left to drain, so `exit` is the right event here (not `close`).
  return await new Promise<number>((resolve, reject) => {
    const proc = nodeSpawn(editor, [path], { stdio: "inherit" });
    proc.once("error", reject);
    proc.once("exit", (code) => resolve(code ?? 1));
  });
};

/** Opens the draft in $EDITOR and returns the edited text, or a loud failure. */
async function editDraft(
  draft: string,
  deps: LoopDeps,
  fileIo: FileIo,
): Promise<Readonly<{ ok: true; text: string }> | Readonly<{ ok: false; message: string }>> {
  const env = deps.env ?? process.env;
  const editor = env.EDITOR;
  if (editor === undefined || editor.trim() === "") {
    return {
      ok: false,
      message:
        "commitshi: $EDITOR is not set. Set $EDITOR in your shell, or press Enter to accept the draft or q to quit.",
    };
  }

  const path = join(tmpdir(), `commitshi-${process.pid}-${Date.now()}.msg`);
  await writeFile(path, draft.endsWith("\n") ? draft : `${draft}\n`, "utf8");
  try {
    const spawn = deps.spawn ?? runEditor;
    const code = await spawn(editor, path);
    if (code !== 0) {
      return {
        ok: false,
        message: `commitshi: editor "${editor}" exited with code ${code}. Fix the editor and re-run commitshi.`,
      };
    }
    // Strip trailing newlines the editor added; the draft keeps its interior.
    const text = (await fileIo.file(path).text()).replace(/\n+$/, "");
    if (text.trim() === "") {
      return {
        ok: false,
        message: "commitshi: editor left the draft empty. Re-run commitshi to draft again.",
      };
    }
    return { ok: true, text };
  } catch (error) {
    return {
      ok: false,
      // SAFETY: fs/spawn failures surface as Error instances.
      message: `commitshi: could not run editor "${editor}": ${(error as Error).message}. Fix $EDITOR and re-run commitshi.`,
    };
  } finally {
    await unlink(path).catch(() => {});
  }
}

/** One line of user input, assembled from raw keypress chunks. The byte
 *  protocol (echo, backspace, escape, Ctrl-C, EOF) lives here once, so the
 *  loop's branches stay decisions instead of byte handling. Escape cancels;
 *  Ctrl-C interrupts; null (EOF) is its own kind so the loop can fail loud. */
export type ReadLineResult =
  | Readonly<{ kind: "ok"; line: string }>
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "interrupted" }>
  | Readonly<{ kind: "eof" }>;

/**
 * Reads one line through the loop's existing `ask` seam, echoing as it goes.
 * Writes nothing else: erasing the line afterwards is the caller's frame
 * layout, not the reader's.
 */
export async function readLine(ask: AskKey, write: (s: string) => void): Promise<ReadLineResult> {
  let line = "";
  for (;;) {
    const raw = await ask();
    if (raw === null) return { kind: "eof" };
    if (raw === "\x03") return { kind: "interrupted" };
    if (raw === "\x1b") return { kind: "cancelled" };
    if (raw === "\r" || raw === "\n") {
      write("\n");
      return { kind: "ok", line };
    }
    if (raw === "\x7f" || raw === "\b") {
      if (line.length > 0) {
        line = line.slice(0, -1);
        write("\b \b");
      }
      continue;
    }
    line += raw;
    write(raw);
  }
}

/**
 * Runs the inline loop around the first generated draft. Enter (empty key)
 * always accepts the CURRENT draft, edits included; `r` swaps in a fresh
 * draft for the same unchanged staged diff. Returns the draft to proceed
 * with, a cancel, or a hard failure.
 */
export async function interactLoop(first: DraftAttempt, deps: LoopDeps): Promise<LoopResult> {
  // The loop needs a real terminal: keys come from a TTY and the editor
  // takes over the TTY. Non-interactive runs (hooks, pipes, CI) get a clear
  // error — never a silent accept.
  const stdinIsTTY = deps.stdinIsTTY ?? Boolean(deps.stdin.isTTY);
  const stdoutIsTTY = deps.stdoutIsTTY ?? Boolean(deps.stdout.isTTY);
  if (!stdinIsTTY || !stdoutIsTTY) {
    return {
      ok: false,
      exitCode: 1,
      message:
        "commitshi: the accept/edit/regenerate loop needs an interactive terminal (stdin and stdout must both be TTYs) — re-run in a terminal, or use --no-commit to print the draft and exit",
    };
  }

  const fileIo: FileIo = nodeFileIo;
  let attempt = first;
  let regenerations = 0;
  let edited = false; // set after a successful edit ($EDITOR or inline); shows the (edited) badge
  let revised = false; // set after a successful revise; shows the (revised) badge

  // The color gate resolves once: TTY + !NO_COLOR + !CI. The render seam is
  // presentDraft; the prompt string stays exactly the 12-pinned constant.
  const env = { ...process.env, ...deps.env };
  const colorEnabled = deps.colorEnabled ?? shouldEmitColor(deps.stdout, env, stdoutIsTTY);
  const colors = resolveColors(colorEnabled, deps.stdout.getColorDepth?.bind(deps.stdout));

  const injectedAsk = deps.ask !== undefined;
  const asker = injectedAsk ? { ask: deps.ask, close: () => {} } : makeKeyAsker(deps.stdin);
  const ask = asker.ask;
  const close = () => {
    if (!injectedAsk) asker.close();
  };

  let firstRender = true;
  let needsRender = true;
  let unknownNotified = false;
  for (;;) {
    if (!attempt.ok) {
      close();
      return { ok: false, exitCode: 1, message: attempt.message };
    }
    const draft = attempt.draft;
    if (needsRender) {
      // Clear only on first render to avoid flicker; subsequent re-renders overwrite in place
      if (firstRender) {
        deps.stdout.write("\x1b[2J\x1b[H");
        firstRender = false;
      }
      // Render the framed draft: staged-changes numstat (with (truncated) badge
      // in the label on a truncated digest), the numbered draft (subject in
      // accent, (edited) badge once edited), then the prompt awaiting the key.
      presentDraft(deps.stdout, {
        draft,
        draftNumber: 1 + regenerations,
        edited,
        revised,
        truncated: attempt.truncated,
        numstat: attempt.numstat,
        prompt: PROMPT,
        colors,
        columns: deps.stdout.isTTY ? deps.stdout.columns : undefined,
      });
      needsRender = false;
    }
    const rawAnswer = await ask();

    if (rawAnswer === null) {
      close();
      return {
        ok: false,
        exitCode: 1,
        message: "commitshi: input closed — nothing accepted, no commit",
      };
    }
    // The seam delivers raw bytes; the decision prompt reads keys. Ctrl-C at
    // the decision prompt is a real interrupt (restore the terminal, re-raise).
    if (rawAnswer === "\x03") {
      close();
      process.kill(process.pid, "SIGINT");
      return {
        ok: false,
        exitCode: 130,
        message: "commitshi: interrupted — nothing accepted, no commit",
      };
    }
    const answer = rawAnswer === "\r" || rawAnswer === "\n" ? "" : rawAnswer.trim().toLowerCase();

    if (answer === "") {
      close();
      return { ok: true, action: "accepted", draft, regenerations };
    }
    if (answer === "e") {
      const editResult = await editDraft(draft, deps, fileIo);
      if (!editResult.ok) {
        close();
        return { ok: false, exitCode: 1, message: editResult.message };
      }
      attempt = { ok: true, draft: editResult.text, truncated: false, numstat: attempt.numstat };
      edited = true;
      revised = false;
      needsRender = true;
      continue;
    }
    if (answer === "i") {
      const editResult: InlineResult = await run(draft, deps.stdin, deps.stdout);
      // run leaves raw mode off; restore it for the production key source.
      if (!injectedAsk) {
        deps.stdin.setRawMode?.(true);
        deps.stdin.resume();
      }
      if (!editResult.ok) {
        if (editResult.kind === "empty-subject") {
          close();
          return { ok: false, exitCode: 1, message: editResult.message };
        }
        // cancelled: inline editor cleared the screen, so we must re-render the draft frame
        needsRender = true;
        continue;
      }
      attempt = { ok: true, draft: editResult.text, truncated: false, numstat: attempt.numstat };
      edited = true;
      revised = false;
      needsRender = true;
      continue;
    }
    if (answer === "r") {
      regenerations++;
      edited = false; // a fresh draft is the model's, not the edited one
      revised = false;

      // Loader around the model call: spinner on TTY, silent off-TTY. It
      // fully erases itself before the next presentDraft frame is written,
      // so the framed stage layout is never garbled by loader output.
      const loader = (
        deps.startLoader ?? ((label, write, isTTY) => startLoader(label, write, isTTY))
      )(`regenerating — draft ${1 + regenerations}`, (s) => deps.stdout.write(s), stdoutIsTTY);
      try {
        attempt = await deps.regenerate(draft);
      } finally {
        loader.stop();
      }
      needsRender = true;
      continue;
    }
    if (answer === "p") {
      if (!deps.revise) {
        deps.stdout.write("\ncommitshi: revise is not available\n");
        needsRender = true;
        continue;
      }
      deps.stdout.write("\nRevision instruction: ");
      const line = await readLine(ask, (s) => deps.stdout.write(s));
      if (line.kind === "eof") {
        close();
        return {
          ok: false,
          exitCode: 1,
          message: "commitshi: input closed — nothing accepted, no commit",
        };
      }
      if (line.kind === "interrupted") {
        close();
        process.kill(process.pid, "SIGINT");
        return {
          ok: false,
          exitCode: 130,
          message: "commitshi: interrupted — nothing accepted, no commit",
        };
      }
      if (line.kind === "cancelled" || line.line.trim() === "") {
        // Escape or blank: erase the revision line and return to the prompt —
        // no draft change, no re-render (avoids flicker).
        deps.stdout.write("\r\x1b[K\x1b[1A");
        needsRender = false;
        continue;
      }
      edited = false;
      const loader = (
        deps.startLoader ?? ((label, write, isTTY) => startLoader(label, write, isTTY))
      )(`revising draft…`, (s) => deps.stdout.write(s), stdoutIsTTY);
      try {
        attempt = await deps.revise(draft, line.line);
      } finally {
        loader.stop();
      }
      revised = true;
      needsRender = true;
      continue;
    }
    if (answer === "q" || answer === "quit") {
      close();
      return { ok: true, action: "cancel", draft, regenerations };
    }
    // Unknown key: name it once to avoid terminal pollution
    if (!unknownNotified) {
      deps.stdout.write(
        "\ncommitshi: unknown key — press Enter to accept, i to edit here, e to edit in editor, r to regenerate, p to revise, q to quit\n",
      );
      unknownNotified = true;
    }
  }
}
