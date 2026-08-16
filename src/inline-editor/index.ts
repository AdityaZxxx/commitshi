import { parseDraft, composeDraft, initialState } from "./state.ts";
import { normalizeKeypress, applyKey } from "./input.ts";
import { renderToLines, cursorPosition, moveCursor, clearScreen } from "./renderer.ts";
import readline from "node:readline";

export type InlineResult =
  | { ok: true; text: string }
  | { ok: false; kind: "cancelled" }
  | { ok: false; kind: "empty-subject"; message: string };

/**
 * The terminal contract the editor runs on. The real process streams satisfy
 * it fully; test doubles (a PassThrough, a capture) satisfy it structurally,
 * so the seam needs no casts on either side. setRawMode is optional because
 * only a real TTY has it — its absence is refused below, not worked around.
 */
export type EditorStdin = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
};

export type EditorStdout = Pick<NodeJS.WriteStream, "write"> & {
  isTTY?: boolean;
  columns?: number;
  getColorDepth?: () => number;
};

export async function run(
  initialDraft: string,
  stdin: EditorStdin,
  stdout: EditorStdout,
): Promise<InlineResult> {
  readline.emitKeypressEvents(stdin);
  // Bind once so the narrowed capability survives the await below.
  const setRawMode = stdin.setRawMode?.bind(stdin);
  if (!stdin.isTTY || setRawMode === undefined) {
    throw new Error("inline editor requires a TTY with setRawMode");
  }
  let rawEnabled = false;

  try {
    setRawMode(true);
    rawEnabled = true;
    stdin.resume();

    let state = initialState(parseDraft(initialDraft));
    let active = true;

    const columns = stdout.columns;
    const render = () => {
      const lines = renderToLines(state, columns);
      stdout.write(clearScreen());
      stdout.write(lines.join("\n"));
      const pos = cursorPosition(state, columns);
      stdout.write(moveCursor(pos.row, pos.col));
    };
    render();

    const result = await new Promise<InlineResult>((resolve) => {
      const onKey = (_str: string, key: readline.Key) => {
        if (!active) return;
        const k = normalizeKeypress(_str, key);
        const { state: nextState, done } = applyKey(state, k);
        state = nextState;
        render();
        if (done === "cancel") {
          active = false;
          cleanup();
          resolve({ ok: false, kind: "cancelled" });
        } else if (done === "save") {
          active = false;
          cleanup();
          const composed = composeDraft(state.draft);
          const subject = state.draft.subject.trim();
          if (!subject) {
            resolve({
              ok: false,
              kind: "empty-subject",
              message: "Subject is empty. Add a subject line, then press Ctrl+S to save.",
            });
            return;
          }
          resolve({ ok: true, text: composed });
        }
      };

      const onEnd = () => {
        if (!active) return;
        active = false;
        cleanup();
        resolve({ ok: false, kind: "cancelled" });
      };

      const cleanup = () => {
        stdin.removeListener("keypress", onKey);
        stdin.removeListener("end", onEnd);
        stdin.removeListener("close", onEnd);
        stdout.write(clearScreen());
      };

      stdin.on("keypress", onKey);
      stdin.once("end", onEnd);
      stdin.once("close", onEnd);
    });

    return result;
  } finally {
    // Cleanup order: listeners removed in Promise cleanup, then clear screen, then restore raw mode
    try {
      stdout.write(clearScreen());
    } catch {}
    if (rawEnabled) {
      try {
        setRawMode(false);
      } catch {}
    }
  }
}
