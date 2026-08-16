import { describe, test, expect } from "bun:test";
import {
  parseDraft,
  composeDraft,
  initialState,
  moveLeft,
  moveRight,
  moveUp,
  moveDown,
  insertCharacter,
  backspace,
  insertNewline,
  type EditorState,
} from "./state.ts";

function withCursor(state: EditorState, cursor: EditorState["cursor"]): EditorState {
  return { draft: state.draft, cursor };
}

describe("parse/compose", () => {
  test("subject only", () => {
    const d = parseDraft("fix: thing");
    expect(d).toEqual({ subject: "fix: thing", body: [] });
    expect(composeDraft(d)).toBe("fix: thing");
  });
  test("subject + body", () => {
    const d = parseDraft("fix: thing\n\nbody line1\nbody line2");
    expect(d.subject).toBe("fix: thing");
    expect(d.body).toEqual(["body line1", "body line2"]);
    expect(composeDraft(d)).toBe("fix: thing\n\nbody line1\nbody line2");
  });
  test("empty body lines preserved", () => {
    const d = parseDraft("subj\n\nfirst\n\nsecond");
    expect(d.body).toEqual(["first", "", "second"]);
    expect(composeDraft(d)).toBe("subj\n\nfirst\n\nsecond");
  });
});

describe("cursor", () => {
  test("move left within subject", () => {
    const s = initialState({ subject: "abc", body: [] });
    // cursor at end
    const s1 = moveLeft(s);
    expect(s1.cursor).toEqual({ area: "subject", col: 2 });
  });
  test("move left at subject start stays", () => {
    let s = initialState({ subject: "abc", body: [] });
    s = withCursor(s, { area: "subject", col: 0 });
    s = moveLeft(s);
    expect(s.cursor.col).toBe(0);
  });
  test("move left from body start to subject end", () => {
    const s = initialState({ subject: "sub", body: ["b1"] });
    const state = withCursor(s, { area: "body", row: 0, col: 0 });
    const s1 = moveLeft(state);
    expect(s1.cursor).toEqual({ area: "subject", col: 3 });
  });
  test("move right from subject end to body", () => {
    const s = initialState({ subject: "sub", body: ["b1"] });
    const state = withCursor(s, { area: "subject", col: 3 });
    const s1 = moveRight(state);
    expect(s1.cursor).toEqual({ area: "body", row: 0, col: 0 });
  });
  test("move up from body to subject", () => {
    const s = initialState({ subject: "sub", body: ["b1"] });
    const state = withCursor(s, { area: "body", row: 0, col: 2 });
    const s1 = moveUp(state);
    expect(s1.cursor).toEqual({ area: "subject", col: 2 });
  });
  test("move down from subject to body", () => {
    const s = initialState({ subject: "sub", body: ["b1"] });
    const state = withCursor(s, { area: "subject", col: 1 });
    const s1 = moveDown(state);
    expect(s1.cursor).toEqual({ area: "body", row: 0, col: 1 });
  });
});

describe("editing", () => {
  test("insert character", () => {
    let s = initialState({ subject: "ab", body: [] });
    s = withCursor(s, { area: "subject", col: 1 });
    s = insertCharacter(s, "X");
    expect(s.draft.subject).toBe("aXb");
    expect(s.cursor.col).toBe(2);
  });
  test("backspace merges body lines", () => {
    let s = initialState({ subject: "sub", body: ["first", "second"] });
    s = withCursor(s, { area: "body", row: 1, col: 0 });
    s = backspace(s);
    expect(s.draft.body).toEqual(["firstsecond"]);
    expect(s.cursor).toEqual({ area: "body", row: 0, col: 5 });
  });
  test("backspace first body merges into subject", () => {
    let s = initialState({ subject: "sub", body: ["first", "second"] });
    s = withCursor(s, { area: "body", row: 0, col: 0 });
    s = backspace(s);
    expect(s.draft.subject).toBe("subfirst");
    expect(s.draft.body).toEqual(["second"]);
    expect(s.cursor.area).toBe("subject");
  });
  test("insert newline in subject", () => {
    let s = initialState({ subject: "ab cd", body: [] });
    s = withCursor(s, { area: "subject", col: 2 });
    s = insertNewline(s);
    expect(s.draft.subject).toBe("ab");
    expect(s.draft.body).toEqual([" cd"]);
    expect(s.cursor).toEqual({ area: "body", row: 0, col: 0 });
  });
  test("insert newline in body", () => {
    let s = initialState({ subject: "sub", body: ["hello world"] });
    s = withCursor(s, { area: "body", row: 0, col: 5 });
    s = insertNewline(s);
    expect(s.draft.body).toEqual(["hello", " world"]);
  });
  test("enter at end of body line", () => {
    let s = initialState({ subject: "sub", body: ["hello"] });
    s = withCursor(s, { area: "body", row: 0, col: 5 });
    s = insertNewline(s);
    expect(s.draft.body).toEqual(["hello", ""]);
    expect(s.cursor).toEqual({ area: "body", row: 1, col: 0 });
  });
  test("enter in middle of body line", () => {
    let s = initialState({ subject: "sub", body: ["hello world"] });
    s = withCursor(s, { area: "body", row: 0, col: 5 });
    s = insertNewline(s);
    expect(s.draft.body).toEqual(["hello", " world"]);
    expect(s.cursor).toEqual({ area: "body", row: 1, col: 0 });
  });
  test("enter on empty body line", () => {
    let s = initialState({ subject: "sub", body: [""] });
    s = withCursor(s, { area: "body", row: 0, col: 0 });
    s = insertNewline(s);
    expect(s.draft.body).toEqual(["", ""]);
    expect(s.cursor).toEqual({ area: "body", row: 1, col: 0 });
  });
  test("consecutive enters create empty lines", () => {
    let s = initialState({ subject: "sub", body: ["first"] });
    s = withCursor(s, { area: "body", row: 0, col: 5 });
    s = insertNewline(s);
    s = insertNewline(s);
    expect(s.draft.body).toEqual(["first", "", ""]);
    expect(s.cursor).toEqual({ area: "body", row: 2, col: 0 });
  });
  test("backspace after newline merges lines", () => {
    let s = initialState({ subject: "sub", body: ["first", "second"] });
    s = withCursor(s, { area: "body", row: 1, col: 0 });
    s = backspace(s);
    expect(s.draft.body).toEqual(["firstsecond"]);
    expect(s.cursor).toEqual({ area: "body", row: 0, col: 5 });
  });
  test("multiple body lines preserved during serialization", () => {
    const draft = { subject: "fix: example", body: ["first", "", "second"] };
    const serialized = composeDraft(draft);
    expect(serialized).toBe("fix: example\n\nfirst\n\nsecond");
    const parsed = parseDraft(serialized);
    expect(parsed).toEqual(draft);
  });
  test("cursor position after enter moves to new line start", () => {
    let s = initialState({ subject: "sub", body: ["a b c"] });
    s = withCursor(s, { area: "body", row: 0, col: 2 });
    s = insertNewline(s);
    expect(s.cursor).toEqual({ area: "body", row: 1, col: 0 });
    expect(s.draft.body).toEqual(["a ", "b c"]);
  });
});

describe("unicode", () => {
  test("emoji insertion does not split code point", () => {
    let s = initialState({ subject: "a😀b", body: [] });
    // cursor after 'a'
    s = withCursor(s, { area: "subject", col: 1 });
    s = insertCharacter(s, "X");
    // length should increase
    expect(s.draft.subject).toContain("X");
  });
});
