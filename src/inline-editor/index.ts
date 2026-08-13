import { parseDraft, composeDraft, initialState } from "./state.ts";
import { normalizeKeypress, applyKey } from "./input.ts";
import { renderToLines, cursorPosition, moveCursor, clearScreen } from "./renderer.ts";
import readline from "node:readline";

export type InlineResult =
  | { ok: true; text: string }
  | { ok: false; kind: "cancelled" }
  | { ok: false; kind: "empty-subject"; message: string };

export async function run(
  initialDraft: string,
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
): Promise<InlineResult> {
  readline.emitKeypressEvents(stdin);
  const rawSupported = stdin.isTTY && typeof (stdin as any).setRawMode === "function";
  if (!rawSupported) {
    throw new Error("inline editor requires a TTY with setRawMode");
  }
  let rawEnabled = false;

  try {
    (stdin as any).setRawMode(true);
    rawEnabled = true;
    stdin.resume();

    let state = initialState(parseDraft(initialDraft));
    let active = true;

    const columns = (stdout as any).columns;
    const render = () => {
      const lines = renderToLines(state, columns);
      stdout.write(clearScreen());
      stdout.write(lines.join("\n"));
      const pos = cursorPosition(state, columns);
      stdout.write(moveCursor(pos.row, pos.col));
    };
    render();

    const result = await new Promise<InlineResult>((resolve) => {
      const onKey = (_str: string, key: any) => {
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
            resolve({ ok: false, kind: "empty-subject", message: "Subject is empty. Add a subject line, then press Ctrl+S to save." });
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
    try { stdout.write(clearScreen()); } catch {}
    if (rawEnabled) {
      try { (stdin as any).setRawMode(false); } catch {}
    }
  }
}


