import { describe, test, expect } from "bun:test";
import { buildRenderModel, cursorPosition, buildVisualLayout } from "./renderer.ts";
import { initialState, type EditorState } from "./state.ts";

function withCursor(state: EditorState, cursor: EditorState["cursor"]): EditorState {
  return { draft: state.draft, cursor };
}

describe("renderer model", () => {
  test("subject only", () => {
    const state = initialState({ subject: "subj", body: [] });
    const rows = buildRenderModel(state);
    expect(rows[0].kind).toBe("subject");
    expect(rows[0].text).toBe("subj");
    expect(rows[1].kind).toBe("separator");
  });
  test("subject + body active subject", () => {
    const state = initialState({ subject: "subj", body: ["b1", "b2"] });
    const rows = buildRenderModel(state);
    expect(rows[0].text).toBe("subj");
    expect(rows[2].text).toBe("b1");
    expect(rows[3].text).toBe("b2");
  });
  test("cursor position mapping", () => {
    const state = initialState({ subject: "abc", body: ["def"] });
    const pos = cursorPosition(state);
    expect(pos.row).toBe(0);
    expect(pos.col).toBe(3);
    const bodyState = withCursor(state, { area: "body", row: 0, col: 1 });
    const pos2 = cursorPosition(bodyState);
    expect(pos2.row).toBe(2);
    expect(pos2.col).toBe(1);
  });
});

describe("visual layout wrapping", () => {
  test("short line fits in one visual row", () => {
    const state = initialState({ subject: "short", body: [] });
    const layout = buildVisualLayout(state, 80);
    const subjectRows = layout.filter(v => v.logicalArea === "subject");
    expect(subjectRows.length).toBe(1);
    expect(subjectRows[0].text).toBe("short");
  });

  test("long line wraps to two visual rows", () => {
    const long = "a".repeat(100);
    const state = initialState({ subject: long, body: [] });
    const layout = buildVisualLayout(state, 40);
    const subjectRows = layout.filter(v => v.logicalArea === "subject");
    expect(subjectRows.length).toBeGreaterThan(1);
  });

  test("cursor before wrap boundary", () => {
    const line = "a".repeat(100);
    const state = initialState({ subject: line, body: [] });
    const stateWithCursor = withCursor(state, { area: "subject", col: 35 });
    const pos = cursorPosition(stateWithCursor, 40);
    expect(pos.row).toBe(0);
  });

  test("cursor exactly at wrap boundary", () => {
    const line = "a".repeat(100);
    const state = initialState({ subject: line, body: [] });
    const wrapCol = 38;
    const stateWithCursor = withCursor(state, { area: "subject", col: wrapCol });
    const pos = cursorPosition(stateWithCursor, 40);
    expect(pos.row).toBe(0);
  });

  test("cursor immediately after wrap", () => {
    const line = "a".repeat(100);
    const state = initialState({ subject: line, body: [] });
    const stateWithCursor = withCursor(state, { area: "subject", col: 39 });
    const pos = cursorPosition(stateWithCursor, 40);
    expect(pos.row).toBe(1);
  });

  test("cursor on second body line after wrapped first line", () => {
    const line0 = "b".repeat(100);
    const state = initialState({ subject: "s", body: [line0, "second"] });
    const stateWithCursor = withCursor(state, { area: "body", row: 1, col: 3 });
    const pos = cursorPosition(stateWithCursor, 40);
    const layout = buildVisualLayout(state, 40);
    const firstBodyRows = layout.filter(v => v.logicalArea === "body" && v.logicalRow === 0);
    const expectedRow = 2 + firstBodyRows.length;
    expect(pos.row).toBe(expectedRow);
  });

  test("unicode wrapping uses grapheme width", () => {
    const line = "a".repeat(10) + "世界".repeat(10) + "a".repeat(10);
    const state = initialState({ subject: line, body: [] });
    const layout = buildVisualLayout(state, 30);
    expect(layout.filter(v => v.logicalArea === "subject").length).toBeGreaterThan(0);
  });

  test("narrow terminal", () => {
    const state = initialState({ subject: "short", body: [] });
    const layout = buildVisualLayout(state, 10);
    const subjectRows = layout.filter(v => v.logicalArea === "subject");
    expect(subjectRows[0].text.length).toBeLessThanOrEqual(10);
  });
});
