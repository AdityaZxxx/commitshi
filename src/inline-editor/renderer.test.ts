import { describe, test, expect } from "bun:test";
import { buildRenderModel, cursorPosition } from "./renderer.ts";
import { initialState, type EditorState } from "./state.ts";

function withCursor(state: EditorState, cursor: EditorState["cursor"]): EditorState {
  return { draft: state.draft, cursor };
}

describe("renderer model", () => {
  test("subject only", () => {
    const state = initialState({ subject: "subj", body: [] });
    const rows = buildRenderModel(state);
    expect(rows[0].kind).toBe("subject");
    expect(rows[0].text).toBe("> subj");
    expect(rows[1].kind).toBe("separator");
  });
  test("subject + body active subject", () => {
    const state = initialState({ subject: "subj", body: ["b1", "b2"] });
    const rows = buildRenderModel(state);
    expect(rows[0].text).toBe("> subj");
    expect(rows[2].text).toBe("  b1");
    expect(rows[3].text).toBe("  b2");
  });
  test("cursor position mapping", () => {
    const state = initialState({ subject: "abc", body: ["def"] });
    const pos = cursorPosition(state);
    expect(pos.row).toBe(0);
    expect(pos.col).toBe(2 + 3);
    const bodyState = withCursor(state, { area: "body", row: 0, col: 1 });
    const pos2 = cursorPosition(bodyState);
    expect(pos2.row).toBe(2);
    expect(pos2.col).toBe(2 + 1);
  });
});
