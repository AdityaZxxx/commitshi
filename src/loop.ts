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
import { presentDraft, regenerating, resolveColors, shouldEmitColor } from "./presentation.ts";
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
}>;

/** One draft under consideration, or the loud failure to produce one. */
export type DraftAttempt =
  | Readonly<{ ok: true; draft: string; truncated: boolean; numstat: readonly NumstatEntry[] }>
  | Readonly<{ ok: false; exitCode: number; message: string }>;

export type LoopResult =
  | Readonly<{ ok: true; action: "accepted"; draft: string; regenerations: number }>
  | Readonly<{ ok: true; action: "cancel"; draft: string; regenerations: number }>
  | Readonly<{ ok: false; exitCode: number; message: string }>;

const PROMPT = "  [Enter] accept · [i] edit · [e] $EDITOR · [r] regenerate · [q] quit › ";

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
      message: "commitshi: $EDITOR is not set — set it to edit the draft, or press Enter to accept / q to quit",
    };
  }

  const path = join(tmpdir(), `commitshi-${process.pid}-${Date.now()}.msg`);
  await writeFile(path, draft.endsWith("\n") ? draft : `${draft}\n`, "utf8");
  try {
    const spawn = deps.spawn ?? runEditor;
    const code = await spawn(editor, path);
    if (code !== 0) {
      return { ok: false, message: `commitshi: editor "${editor}" exited with code ${code} — draft unchanged, nothing accepted` };
    }
    // Strip trailing newlines the editor added; the draft keeps its interior.
    const text = (await fileIo.file(path).text()).replace(/\n+$/, "");
    if (text.trim() === "") {
      return { ok: false, message: "commitshi: editor left the draft empty — nothing accepted, no commit" };
    }
    return { ok: true, text };
  } catch (error) {
    return { ok: false, message: `commitshi: could not run editor "${editor}": ${(error as Error).message} — nothing accepted` };
  } finally {
    await unlink(path).catch(() => {});
  }
}

/** The outcome of an inline edit of the current draft. */
type InlineEditResult =
  | Readonly<{ ok: true; text: string }>
  | Readonly<{ ok: false; kind: "cancelled" }>
  | Readonly<{ ok: false; kind: "empty-subject"; message: string }>;

// Readline control chars (DEL, BS, ESC, etc.) named once so the inline-edit
// branches read as a control-character → action map, not a string table.
const CTRL_W = "\x17", CTRL_U = "\x15", BACKSPACE = "\x7f", ESC = "\x1b", CTRL_C = "\x03";

/**
 * Edits the draft in one pre-filled line, in the style of `@clack/prompts`'
 * `text({ initialValue })`: the whole draft is the initial value, the user
 * edits it as one line, and a single Enter commits and returns. There is no
 * double-Enter, no per-line walk — the opencommit pattern. If the draft has a
 * body the newline is shown as `\n` inside the line; most drafts are one line.
 */
async function inlineEdit(draft: string, ask: AskKey, stdout: Pick<NodeJS.WriteStream, "write">): Promise<InlineEditResult> {
  stdout.write("commitshi: editing in place — Enter saves; Esc or Ctrl-C cancels\n");

  // The whole draft flattened to one line; a body shows its \n visibly.
  let text = draft.replace(/\n/g, "\\n");
  let aborted = false;
  let committed = false;
  // Echo-driven in-place edit: printable characters echo as typed, Backspace
  // erases the character just written, and only wholesale rewrites (Ctrl-U,
  // Ctrl-W) redraw. There is no `\r` mid-typing — the cursor's position IS
  // the state, so a redraw only happens when the screen no longer matches it.
  const rewrite = () => {
    stdout.write(`\r\x1b[K> ${text}`);
  };
  const erase = (n: number) => {
    for (let i = 0; i < n; i++) stdout.write("\b \b");
  };
  stdout.write(`> ${text}`);
  while (!aborted && !committed) {
    const key = await ask();
    if (key === null || key === ESC || key === CTRL_C) {
      aborted = true;
      break;
    }
    if (key === "\r" || key === "\n") {
      committed = true;
      stdout.write("\n");
      break;
    }
    if (key === BACKSPACE || key === "\b") {
      if (text.length > 0) {
        text = text.slice(0, -1);
        erase(1);
      }
      continue;
    }
    if (key === CTRL_U) {
      text = "";
      rewrite();
      continue;
    }
    if (key === CTRL_W) {
      const kept = text.replace(/\s*\S+\s*$/, "");
      const removed = text.length - kept.length;
      text = kept;
      erase(removed);
      continue;
    }
    text += key;
    stdout.write(key);
  }

  if (aborted) {
    stdout.write("\r\x1b[Kcommitshi: inline edit cancelled — draft unchanged\n");
    return { ok: false, kind: "cancelled" };
  }

  // The user's text is sovereign except for one rule: the subject must be
  // non-empty. A body was flattened to `\\n` on screen; turn it back into a
  // real newline before saving. The one check: the first line is the subject.
  const restored = text.replace(/\\n/g, "\n");
  const subject = restored.split("\n")[0] ?? "";
  if (subject.trim() === "") {
    return {
      ok: false,
      kind: "empty-subject",
      message: "commitshi: inline edit left the subject empty — nothing accepted, no commit; draft reverted",
    };
  }
  stdout.write("\r\x1b[Kcommitshi: inline edit saved\n");
  return { ok: true, text: restored };
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
  const ask = asker.ask;
  const close = () => {
    if (!injectedAsk) asker.close();
  };

  for (;;) {
    if (!attempt.ok) {
      close();
      return { ok: false, exitCode: 1, message: attempt.message };
    }
    const draft = attempt.draft;
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
    });
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
      continue;
    }
    if (answer === "i") {
      const editResult = await inlineEdit(draft, ask, deps.stdout);
      if (!editResult.ok) {
        if (editResult.kind === "empty-subject") {
          close();
          return { ok: false, exitCode: 1, message: editResult.message };
        }
        continue; // cancelled: revert, no badge, re-present the decision
      }
      attempt = { ok: true, draft: editResult.text, truncated: false, numstat: attempt.numstat };
      edited = true;
      continue;
    }
    if (answer === "r") {
      regenerations++;
      edited = false; // a fresh draft is the model's, not the edited one
      deps.stdout.write(regenerating(1 + regenerations, stdoutIsTTY));
      attempt = await deps.regenerate();
      continue;
    }
    if (answer === "q" || answer === "quit") {
      close();
      return { ok: true, action: "cancel", draft, regenerations };
    }
    // Unknown key: name it once, then a quiet re-prompt — the prompt above the
    // frame is the loud line; this one just nudges the user back to it.
    deps.stdout.write("commitshi: unknown key — press Enter to accept, i to edit inline, e for $EDITOR, r to regenerate, q to quit\n");
  }
}
