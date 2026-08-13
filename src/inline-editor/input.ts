import type { EditorState } from "./state.ts";
import { moveLeft, moveRight, moveUp, moveDown, insertCharacter, backspace, deleteForward, insertNewline } from "./state.ts";

export type Key =
  | { type: "char"; value: string }
  | { type: "left" }
  | { type: "right" }
  | { type: "up" }
  | { type: "down" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "enter" }
  | { type: "save" }
  | { type: "cancel" }
  | { type: "unknown" };

export function normalizeKeypress(str: string, key: any): Key {
  if (!key) {
    if (str) {
      return { type: "char", value: str };
    }
    return { type: "unknown" };
  }
  const name = key.name;
  const ctrl = key.ctrl;
  const meta = key.meta;
  if (ctrl && name === "c") {
    // treat Ctrl-C as cancel
    return { type: "cancel" };
  }
  if (name === "escape") {
    return { type: "cancel" };
  }
  if (ctrl && name === "s") {
    return { type: "save" };
  }
  if (name === "return" || name === "enter") {
    // Enter creates newline in editor
    return { type: "enter" };
  }
  if (name === "backspace") {
    return { type: "backspace" };
  }
  if (name === "delete") {
    return { type: "delete" };
  }
  if (name === "left") {
    return { type: "left" };
  }
  if (name === "right") {
    return { type: "right" };
  }
  if (name === "up") {
    return { type: "up" };
  }
  if (name === "down") {
    return { type: "down" };
  }
  // printable character
  if (str && str.length === 1 && !ctrl && !meta) {
    return { type: "char", value: str };
  }
  return { type: "unknown" };
}

export function applyKey(state: EditorState, key: Key): { state: EditorState; done?: "save" | "cancel" } {
  switch (key.type) {
    case "left":
      return { state: moveLeft(state) };
    case "right":
      return { state: moveRight(state) };
    case "up":
      return { state: moveUp(state) };
    case "down":
      return { state: moveDown(state) };
    case "backspace":
      return { state: backspace(state) };
    case "delete":
      return { state: deleteForward(state) };
    case "enter":
      return { state: insertNewline(state) };
    case "char":
      return { state: insertCharacter(state, key.value) };
    case "save":
      return { state, done: "save" };
    case "cancel":
      return { state, done: "cancel" };
    default:
      return { state };
  }
}
