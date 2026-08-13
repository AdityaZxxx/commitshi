import { describe, test, expect } from "bun:test";
import { initialState, type EditorState } from "./state.ts";
import { buildVisualLayout, cursorPosition } from "./renderer.ts";

function withCursor(state: EditorState, cursor: EditorState["cursor"]): EditorState {
  return { draft: state.draft, cursor };
}

describe("visual layout wrapping", () => {
  test("short line fits in one visual row", () => {
    const state = initialState({ subject: "short", body: [] });
    const layout = buildVisualLayout(state, 80);
    const subjectRows = layout.filter(v => v.logicalArea === "subject");
    expect(subjectRows.length).toBe(1);
    expect(subjectRows[0].text).toBe("> short");
  });

  test("long line wraps to two visual rows", () => {
    const long = "a".repeat(100);
    const state = initialState({ subject: long, body: [] });
    const layout = buildVisualLayout(state, 40);
    const subjectRows = layout.filter(v => v.logicalArea === "subject");
    expect(subjectRows.length).toBeGreaterThan(1);
    // first row has >, continuation has two spaces
    expect(subjectRows[0].text.startsWith("> ")).toBe(true);
    expect(subjectRows[1].text.startsWith("  ")).toBe(true);
  });

  test("cursor before wrap boundary", () => {
    const line = "a".repeat(100);
    const state = initialState({ subject: line, body: [] });
    const stateWithCursor = withCursor(state, { area: "subject", col: 35 });
    const pos = cursorPosition(stateWithCursor, 40);
    // should be on first visual row
    expect(pos.row).toBe(0);
  });

  test("cursor exactly at wrap boundary", () => {
    const line = "a".repeat(100);
    const state = initialState({ subject: line, body: [] });
    // width 40 -> prefix 2 -> content 38
    const wrapCol = 38;
    const stateWithCursor = withCursor(state, { area: "subject", col: wrapCol });
    const pos = cursorPosition(stateWithCursor, 40);
    // should be at end of first visual row
    expect(pos.row).toBe(0);
  });

  test("cursor immediately after wrap", () => {
    const line = "a".repeat(100);
    const state = initialState({ subject: line, body: [] });
    const stateWithCursor = withCursor(state, { area: "subject", col: 39 });
    const pos = cursorPosition(stateWithCursor, 40);
    // should be on second visual row
    expect(pos.row).toBe(1);
  });

  test("cursor on second body line after wrapped first line", () => {
    const line0 = "b".repeat(100);
    const state = initialState({ subject: "s", body: [line0, "second"] });
    const stateWithCursor = withCursor(state, { area: "body", row: 1, col: 3 });
    const pos = cursorPosition(stateWithCursor, 40);
    // first body line wraps to multiple rows, second body line should be after them
    const layout = buildVisualLayout(state, 40);
    const firstBodyRows = layout.filter(v => v.logicalArea === "body" && v.logicalRow === 0);
    const expectedRow = 2 + firstBodyRows.length; // subject, separator, then body rows
    expect(pos.row).toBe(expectedRow);
  });

  test("unicode wrapping uses grapheme width", () => {
    const line = "a".repeat(10) + "世界".repeat(10) + "a".repeat(10);
    const state = initialState({ subject: line, body: [] });
    const layout = buildVisualLayout(state, 30);
    // should not throw and should produce rows
    expect(layout.filter(v => v.logicalArea === "subject").length).toBeGreaterThan(0);
  });

  test("narrow terminal", () => {
    const state = initialState({ subject: "short", body: [] });
    const layout = buildVisualLayout(state, 10);
    const subjectRows = layout.filter(v => v.logicalArea === "subject");
    expect(subjectRows[0].text.length).toBeLessThanOrEqual(10);
  });
});
