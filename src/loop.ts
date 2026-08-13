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
import { presentDraft, resolveColors, shouldEmitColor, type ColorGate } from "./presentation.ts";
import { startLoader } from "./loader.ts";
import { run } from "./inline-editor/index.ts";
import type { NumstatEntry } from "./compaction.ts";

/** One raw keypress chunk from the user: the bytes as typed, unnormalized; null on EOF. */
export type AskKey = () => Promise<string | null>;

export type LoopDeps = Readonly<{
  stdin: NodeJS.ReadStream;
  stdout: Pick<NodeJS.WriteStream, "write">;
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
  /** Produces a fresh draft for the same staged diff; failure ends the loop loud. */
  regenerate: () => Promise<DraftAttempt>;
  /** Loader seam (tests): called around await regenerate(). Production shows
   *  the spinner; tests may inject a no-op. */
  startLoader?: (label: string, write: (s: string) => unknown, isTTY: boolean) => { stop: () => void };
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
const PROMPT = "[Enter] accept  ·  [i] edit here  ·  [e] edit in editor  ·  [r] regenerate  ·  [q] quit";

type FileIo = { file: (path: string) => { text: () => Promise<string> } };

const nodeFileIo: FileIo = { file: (path) => ({ text: () => readFile(path, "utf8") }) };

/**
 * Production key source: raw-mode keypress chunks on the TTY, delivered
 * verbatim. null on EOF. Ctrl-C arrives as "\x03"; what it means (interrupt
 * vs cancel) is the consumer's call.
 */
function makeKeyAsker(stdin: NodeJS.ReadStream): { ask: AskKey; close: () => void } {
  const raw = stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
  const restore = () => {
    raw.setRawMode?.(false);
    stdin.pause();
  };
  raw.setRawMode?.(true);
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
      message: "commitshi: $EDITOR is not set. Set $EDITOR in your shell, or press Enter to accept the draft or q to quit.",
    };
  }

  const path = join(tmpdir(), `commitshi-${process.pid}-${Date.now()}.msg`);
  await writeFile(path, draft.endsWith("\n") ? draft : `${draft}\n`, "utf8");
  try {
    const spawn = deps.spawn ?? runEditor;
    const code = await spawn(editor, path);
    if (code !== 0) {
      return { ok: false, message: `commitshi: editor "${editor}" exited with code ${code}. Fix the editor and re-run commitshi.` };
    }
    // Strip trailing newlines the editor added; the draft keeps its interior.
    const text = (await fileIo.file(path).text()).replace(/\n+$/, "");
    if (text.trim() === "") {
      return { ok: false, message: "commitshi: editor left the draft empty. Re-run commitshi to draft again." };
    }
    return { ok: true, text };
  } catch (error) {
    return { ok: false, message: `commitshi: could not run editor "${editor}": ${(error as Error).message}. Fix $EDITOR and re-run commitshi.` };
  } finally {
    await unlink(path).catch(() => {});
  }
}

/**
 * Inline edit of the draft using the zero-dep state machine editor.
 */
async function inlineEdit(
  draft: string,
  _ask: AskKey,
  _pushback: (s: string) => void,
  stdin: NodeJS.ReadStream,
  stdout: Pick<NodeJS.WriteStream, "write">,
  _colors: ColorGate,
  _columns: number | undefined,
): Promise<{ ok: true; text: string } | { ok: false; kind: "cancelled" } | { ok: false; kind: "empty-subject"; message: string }> {
  const result = await run(draft, stdin as NodeJS.ReadStream, stdout as NodeJS.WriteStream);
  if (!result.ok) {
    return result;
  }
  return { ok: true, text: result.text };
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
  const stdoutIsTTY = deps.stdoutIsTTY ?? Boolean((deps.stdout as NodeJS.WriteStream).isTTY);
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

  // The color gate resolves once: TTY + !NO_COLOR + !CI. The render seam is
  // presentDraft; the prompt string stays exactly the 12-pinned constant.
  const env = { ...process.env, ...deps.env };
  // getColorDepth / isTTY live on the real stream; they're probed optionally so
  // the write-only test seam still satisfies the type.
  const probe = deps.stdout as NodeJS.WriteStream;
  const colorEnabled = deps.colorEnabled ?? shouldEmitColor(deps.stdout, env, stdoutIsTTY);
  const colors = resolveColors(colorEnabled, probe.getColorDepth?.bind(probe));

  const injectedAsk = deps.ask !== undefined;
  const asker = injectedAsk ? { ask: deps.ask, close: () => {} } : makeKeyAsker(deps.stdin);
  // A pushback buffer shared with inlineEdit: the editor can return a
  // look-ahead input (read during escape reassembly) back to the loop.
  let pushedBack: string | null = null;
  const ask = injectedAsk
    ? async (): Promise<string | null> => {
        if (pushedBack !== null) { const v = pushedBack; pushedBack = null; return v; }
        return asker.ask();
      }
    : asker.ask;
  const pushback = (s: string) => { pushedBack = s; };
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
        truncated: attempt.truncated,
        numstat: attempt.numstat,
        prompt: PROMPT,
        colors,
        columns: probe.isTTY ? probe.columns : undefined,
      });
      needsRender = false;
    }
    const rawAnswer = await ask();

    if (rawAnswer === null) {
      close();
      return { ok: false, exitCode: 1, message: "commitshi: input closed — nothing accepted, no commit" };
    }
    // The seam delivers raw bytes; the decision prompt reads keys. Ctrl-C at
    // the decision prompt is a real interrupt (restore the terminal, re-raise).
    if (rawAnswer === "\x03") {
      close();
      process.kill(process.pid, "SIGINT");
      return { ok: false, exitCode: 130, message: "commitshi: interrupted — nothing accepted, no commit" };
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
      needsRender = true;
      continue;
    }
    if (answer === "i") {
      const editResult = await inlineEdit(draft, ask, pushback, deps.stdin, deps.stdout, colors, probe.isTTY ? probe.columns : undefined);
      // readMultiline pauses raw mode and stdin; restore for the loop.
      if (!injectedAsk) {
        (deps.stdin as any).setRawMode?.(true);
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
      needsRender = true;
      continue;
    }
    if (answer === "r") {
      regenerations++;
      edited = false; // a fresh draft is the model's, not the edited one
      // Loader around the model call: spinner on TTY, silent off-TTY. It
      // fully erases itself before the next presentDraft frame is written,
      // so the framed stage layout is never garbled by loader output.
      const loader = (deps.startLoader ?? ((label, write, isTTY) => startLoader(label, write, isTTY)))(
        `regenerating — draft ${1 + regenerations}`,
        (s) => deps.stdout.write(s),
        stdoutIsTTY,
      );
      try {
        attempt = await deps.regenerate();
      } finally {
        loader.stop();
      }
      needsRender = true;
      continue;
    }
    if (answer === "q" || answer === "quit") {
      close();
      return { ok: true, action: "cancel", draft, regenerations };
    }
    // Unknown key: name it once to avoid terminal pollution
    if (!unknownNotified) {
      deps.stdout.write("\ncommitshi: unknown key — press Enter to accept, i to edit here, e to edit in editor, r to regenerate, q to quit\n");
      unknownNotified = true;
    }
  }
}
