import { parseDraft, composeDraft, initialState } from "./state.ts";
import { normalizeKeypress, applyKey } from "./input.ts";
import { renderToLines, cursorPosition, moveCursor, clearScreen } from "./renderer.ts";
import readline from "node:readline";

export type InlineResult =
  | { ok: true; text: string }
  | { ok: false; kind: "cancelled" }
  | { ok: false; kind: "empty-subject"; message: string };

export async function runInlineEditor(
  initialDraft: string,
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
): Promise<InlineResult> {
  try {
    // setup
    readline.emitKeypressEvents(stdin);
    
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

    return await new Promise<InlineResult>((resolve) => {
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
            resolve({ ok: false, kind: "empty-subject", message: "subject is empty — nothing to commit. Press i to edit again." });
            return;
          }
          resolve({ ok: true, text: composed });
        }
      };

      const cleanup = () => {
        stdin.removeListener("keypress", onKey);
        // Clear the inline editor frame so the loop's draft view renders cleanly
        stdout.write(clearScreen());
      };

      stdin.on("keypress", onKey);
    });
  } finally {
    // no-op
  }
}
