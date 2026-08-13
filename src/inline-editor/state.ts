export type Draft = {
  subject: string;
  body: string[];
};

export type Cursor =
  | { area: "subject"; col: number }
  | { area: "body"; row: number; col: number };

export type EditorState = {
  draft: Draft;
  cursor: Cursor;
};

export function parseDraft(text: string): Draft {
  if (!text) return { subject: "", body: [] };
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const subject = lines[0] ?? "";
  if (lines.length <= 1) {
    return { subject, body: [] };
  }
  if (lines[1] === "") {
    return { subject, body: lines.slice(2) };
  }
  return { subject, body: lines.slice(1) };
}

export function composeDraft(draft: Draft): string {
  const { subject, body } = draft;
  if (body.length === 0) return subject;
  return `${subject}\n\n${body.join("\n")}`;
}

export function initialState(draft: Draft): EditorState {
  return {
    draft,
    cursor: { area: "subject", col: draft.subject.length },
  };
}

function clampCol(str: string, col: number): number {
  return Math.max(0, Math.min(col, str.length));
}

export function moveLeft(state: EditorState): EditorState {
  const { draft, cursor } = state;
  if (cursor.area === "subject") {
    if (cursor.col > 0) {
      return { ...state, cursor: { ...cursor, col: cursor.col - 1 } };
    }
    return state;
  }
  const row = cursor.row;
  const col = cursor.col;
  if (col > 0) {
    return { ...state, cursor: { ...cursor, col: col - 1 } };
  }
  if (row > 0) {
    const prevRow = row - 1;
    const prevLine = draft.body[prevRow] ?? "";
    return { ...state, cursor: { area: "body", row: prevRow, col: prevLine.length } };
  }
  // first body line -> subject end
  return {
    ...state,
    cursor: { area: "subject", col: draft.subject.length },
  };
}

export function moveRight(state: EditorState): EditorState {
  const { draft, cursor } = state;
  if (cursor.area === "subject") {
    if (cursor.col < draft.subject.length) {
      return { ...state, cursor: { ...cursor, col: cursor.col + 1 } };
    }
    if (draft.body.length > 0) {
      return { ...state, cursor: { area: "body", row: 0, col: 0 } };
    }
    return state;
  }
  const line = draft.body[cursor.row] ?? "";
  if (cursor.col < line.length) {
    return { ...state, cursor: { ...cursor, col: cursor.col + 1 } };
  }
  if (cursor.row < draft.body.length - 1) {
    return { ...state, cursor: { area: "body", row: cursor.row + 1, col: 0 } };
  }
  return state;
}

export function moveUp(state: EditorState): EditorState {
  const { draft, cursor } = state;
  if (cursor.area === "subject") return state;
  if (cursor.row === 0) {
    const col = clampCol(draft.subject, cursor.col);
    return { ...state, cursor: { area: "subject", col } };
  }
  const newRow = cursor.row - 1;
  const target = draft.body[newRow] ?? "";
  const col = clampCol(target, cursor.col);
  return { ...state, cursor: { area: "body", row: newRow, col } };
}

export function moveDown(state: EditorState): EditorState {
  const { draft, cursor } = state;
  if (cursor.area === "subject") {
    if (draft.body.length === 0) return state;
    const target = draft.body[0] ?? "";
    const col = clampCol(target, cursor.col);
    return { ...state, cursor: { area: "body", row: 0, col } };
  }
  if (cursor.row >= draft.body.length - 1) return state;
  const newRow = cursor.row + 1;
  const target = draft.body[newRow] ?? "";
  const col = clampCol(target, cursor.col);
  return { ...state, cursor: { area: "body", row: newRow, col } };
}

export function insertCharacter(state: EditorState, char: string): EditorState {
  const { draft, cursor } = state;
  if (cursor.area === "subject") {
    const before = draft.subject.slice(0, cursor.col);
    const after = draft.subject.slice(cursor.col);
    const subject = before + char + after;
    return {
      ...state,
      draft: { ...draft, subject },
      cursor: { area: "subject", col: cursor.col + char.length },
    };
  }
  const body = [...draft.body];
  const line = body[cursor.row] ?? "";
  const before = line.slice(0, cursor.col);
  const after = line.slice(cursor.col);
  body[cursor.row] = before + char + after;
  return {
    ...state,
    draft: { ...draft, body },
    cursor: { area: "body", row: cursor.row, col: cursor.col + char.length },
  };
}

export function backspace(state: EditorState): EditorState {
  const { draft, cursor } = state;
  if (cursor.area === "subject") {
    if (cursor.col === 0) return state;
    const before = draft.subject.slice(0, cursor.col - 1);
    const after = draft.subject.slice(cursor.col);
    return {
      ...state,
      draft: { ...draft, subject: before + after },
      cursor: { area: "subject", col: cursor.col - 1 },
    };
  }
  const body = [...draft.body];
  const line = body[cursor.row] ?? "";
  if (cursor.col > 0) {
    const before = line.slice(0, cursor.col - 1);
    const after = line.slice(cursor.col);
    body[cursor.row] = before + after;
    return {
      ...state,
      draft: { ...draft, body },
      cursor: { area: "body", row: cursor.row, col: cursor.col - 1 },
    };
  }
  // at column 0
  if (cursor.row > 0) {
    const prev = body[cursor.row - 1] ?? "";
    const curr = body[cursor.row] ?? "";
    const merged = prev + curr;
    body[cursor.row - 1] = merged;
    body.splice(cursor.row, 1);
    return {
      ...state,
      draft: { ...draft, body },
      cursor: { area: "body", row: cursor.row - 1, col: prev.length },
    };
  }
  // first body line merge into subject
  const first = body[0] ?? "";
  const newSubject = draft.subject + first;
  const newBody = body.slice(1);
  return {
    ...state,
    draft: { subject: newSubject, body: newBody },
    cursor: { area: "subject", col: draft.subject.length },
  };
}

export function deleteForward(state: EditorState): EditorState {
  const { draft, cursor } = state;
  if (cursor.area === "subject") {
    if (cursor.col < draft.subject.length) {
      const before = draft.subject.slice(0, cursor.col);
      const after = draft.subject.slice(cursor.col + 1);
      return {
        ...state,
        draft: { ...draft, subject: before + after },
      };
    }
    if (draft.body.length > 0) {
      const first = draft.body[0] ?? "";
      const newSubject = draft.subject + first;
      const newBody = draft.body.slice(1);
      return {
        ...state,
        draft: { subject: newSubject, body: newBody },
        cursor: { area: "subject", col: draft.subject.length },
      };
    }
    return state;
  }
  const body = [...draft.body];
  const line = body[cursor.row] ?? "";
  if (cursor.col < line.length) {
    const before = line.slice(0, cursor.col);
    const after = line.slice(cursor.col + 1);
    body[cursor.row] = before + after;
    return { ...state, draft: { ...draft, body } };
  }
  if (cursor.row < draft.body.length - 1) {
    const next = body[cursor.row + 1] ?? "";
    body[cursor.row] = line + next;
    body.splice(cursor.row + 1, 1);
    return { ...state, draft: { ...draft, body } };
  }
  return state;
}

export function insertNewline(state: EditorState): EditorState {
  const { draft, cursor } = state;
  if (cursor.area === "subject") {
    const before = draft.subject.slice(0, cursor.col);
    const after = draft.subject.slice(cursor.col);
    const newSubject = before;
    const newBody = [after, ...draft.body];
    return {
      ...state,
      draft: { subject: newSubject, body: newBody },
      cursor: { area: "body", row: 0, col: 0 },
    };
  }
  const body = [...draft.body];
  const line = body[cursor.row] ?? "";
  const before = line.slice(0, cursor.col);
  const after = line.slice(cursor.col);
  body[cursor.row] = before;
  body.splice(cursor.row + 1, 0, after);
  return {
    ...state,
    draft: { ...draft, body },
    cursor: { area: "body", row: cursor.row + 1, col: 0 },
  };
}
