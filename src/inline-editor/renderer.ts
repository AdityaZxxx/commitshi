import type { EditorState, Draft } from "./state.ts";

export type RenderRow = {
  kind: "subject" | "separator" | "body" | "footer";
  logicalRow?: number;
  text: string;
};

export type VisualRow = {
  logicalArea: "subject" | "separator" | "body" | "footer";
  logicalRow?: number;
  text: string;
  startOffset: number;
  endOffset: number;
};

export function buildRenderModel(state: EditorState): RenderRow[] {
  const rows: RenderRow[] = [];
  const { draft, cursor } = state;
  const subjectPrefix = cursor.area === "subject" ? "> " : "  ";
  rows.push({ kind: "subject", text: `${subjectPrefix}${draft.subject}` });
  rows.push({ kind: "separator", text: "" });
  draft.body.forEach((line, i) => {
    const prefix = cursor.area === "body" && cursor.row === i ? "> " : "  ";
    rows.push({ kind: "body", logicalRow: i, text: `${prefix}${line}` });
  });
  rows.push({ kind: "footer", text: "Ctrl+S to save  Esc to cancel" });
  return rows;
}

function truncateLine(text: string, maxContent: number): string {
  if (maxContent <= 0) return "";
  const prefix = text.slice(0, 2);
  const content = text.slice(2);
  if (content.length <= maxContent) return text;
  return prefix + content.slice(0, maxContent);
}

function getGraphemes(str: string): string[] {
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(seg.segment(str), s => s.segment);
  } catch {
    return Array.from(str);
  }
}

function isWide(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  // East Asian Wide / Fullwidth + common emoji ranges – approximate
  if (cp >= 0x1100 && cp <= 0x115F) return true;
  if (cp >= 0x2329) return true;
  if (cp >= 0x2E80 && cp <= 0x303E) return true;
  if (cp >= 0x3040 && cp <= 0x33FF) return true;
  if (cp >= 0x3400 && cp <= 0x4DBF) return true;
  if (cp >= 0x4E00 && cp <= 0x9FFF) return true;
  if (cp >= 0xF900 && cp <= 0xFAFF) return true;
  if (cp >= 0xFE10 && cp <= 0xFE19) return true;
  if (cp >= 0xFE30 && cp <= 0xFE6F) return true;
  if (cp >= 0xFF00 && cp <= 0xFF60) return true;
  if (cp >= 0xFFE0 && cp <= 0xFFE6) return true;
  if (cp >= 0x1F300 && cp <= 0x1FAFF) return true;
  return false;
}

function displayWidth(str: string): number {
  let w = 0;
  for (const g of getGraphemes(str)) {
    w += isWide(g) ? 2 : 1;
  }
  return w;
}

function wrapText(text: string, maxWidth: number): { chunk: string; start: number; end: number }[] {
  if (maxWidth <= 0) return [];
  const graphemes = getGraphemes(text);
  const chunks: { chunk: string; start: number; end: number }[] = [];
  let cur = "";
  let curW = 0;
  let startIdx = 0;
  for (let i = 0; i < graphemes.length; i++) {
    const g = graphemes[i];
    const w = isWide(g) ? 2 : 1;
    if (curW + w > maxWidth && cur !== "") {
      chunks.push({ chunk: cur, start: startIdx, end: i });
      cur = g;
      curW = w;
      startIdx = i;
    } else {
      cur += g;
      curW += w;
    }
  }
  if (cur) {
    chunks.push({ chunk: cur, start: startIdx, end: graphemes.length });
  }
  return chunks;
}

export function buildVisualLayout(state: EditorState, columns?: number): VisualRow[] {
  const visual: VisualRow[] = [];
  const { draft, cursor } = state;
  const isTTY = typeof columns === "number" && columns > 0;
  const maxContent = isTTY ? Math.max(0, columns! - 2) : Infinity;

  const pushLine = (area: VisualRow["logicalArea"], logicalRow: number | undefined, text: string, active: boolean) => {
    if (!isTTY) {
      const prefix = active ? "> " : "  ";
      visual.push({ logicalArea: area, logicalRow, text: prefix + text, startOffset: 0, endOffset: text.length });
      return;
    }
    const prefixFirst = active ? "> " : "  ";
    const prefixCont = "  ";
    if (text.length === 0) {
      // Empty logical line still needs a visual row so Enter-created blank lines are visible
      const prefix = prefixFirst;
      visual.push({
        logicalArea: area,
        logicalRow,
        text: prefix,
        startOffset: 0,
        endOffset: 0,
      });
      return;
    }
    const chunks = wrapText(text, maxContent);
    chunks.forEach((c, i) => {
      const prefix = i === 0 ? prefixFirst : prefixCont;
      visual.push({
        logicalArea: area,
        logicalRow,
        text: prefix + c.chunk,
        startOffset: c.start,
        endOffset: c.end,
      });
    });
  };

  // subject
  pushLine("subject", undefined, draft.subject, cursor.area === "subject");
  // separator
  visual.push({ logicalArea: "separator", logicalRow: undefined, text: "", startOffset: 0, endOffset: 0 });
  // body
  draft.body.forEach((line, i) => {
    const active = cursor.area === "body" && cursor.row === i;
    pushLine("body", i, line, active);
  });
  // spacer before footer
  visual.push({ logicalArea: "footer", logicalRow: undefined, text: "", startOffset: 0, endOffset: 0 });
  // footer
  const footerText = "  [Ctrl+S] save  ·  [Esc] cancel ›";
  if (isTTY) {
    const chunks = wrapText(footerText, columns!);
    chunks.forEach((c) => {
      visual.push({ logicalArea: "footer", logicalRow: undefined, text: c.chunk, startOffset: c.start, endOffset: c.end });
    });
  } else {
    visual.push({ logicalArea: "footer", logicalRow: undefined, text: footerText, startOffset: 0, endOffset: footerText.length });
  }
  return visual;
}

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export function renderToLines(state: EditorState, columns?: number): string[] {
  const layout = buildVisualLayout(state, columns);
  return layout.map(v => {
    if (v.logicalArea === "footer") {
      const t = v.text;
      // Empty spacer rows stay empty, footer text is dimmed
      return t ? `${DIM}${t}${RESET}` : "";
    }
    return v.text;
  });
}

function getLogicalLine(state: EditorState, area: "subject"|"body", logicalRow?: number): string {
  if (area === "subject") return state.draft.subject;
  const row = logicalRow ?? 0;
  return state.draft.body[row] ?? "";
}

function substringByGrapheme(str: string, start: number, end: number): string {
  const gs = getGraphemes(str);
  return gs.slice(start, end).join("");
}

export function cursorPosition(state: EditorState, columns?: number): { row: number; col: number } {
  const layout = buildVisualLayout(state, columns);
  const { cursor } = state;
  const targetLogicalArea = cursor.area === "subject" ? "subject" : "body";
  const targetLogicalRow = cursor.area === "subject" ? undefined : cursor.row;
  const isActive = true;
  let finalCol = 0;

  for (let i = 0; i < layout.length; i++) {
    const v = layout[i];
    if (v.logicalArea !== targetLogicalArea) continue;
    if (targetLogicalRow !== undefined && v.logicalRow !== targetLogicalRow) continue;
    // cursor lies in this visual chunk if col is within [startOffset, endOffset]
    if (cursor.col >= v.startOffset && cursor.col <= v.endOffset) {
      const logicalLine = getLogicalLine(state, targetLogicalArea as "subject"|"body", targetLogicalRow);
      const before = substringByGrapheme(logicalLine, v.startOffset, cursor.col);
      const isFirstChunk = v.startOffset === 0;
      const prefixStr = isFirstChunk && isActive ? "> " : "  ";
      let col = displayWidth(prefixStr) + displayWidth(before);
      if (columns) col = Math.min(col, columns - 1);
      return { row: i, col };
    }
    // if cursor is before start of this chunk, it belongs to previous chunk
    if (cursor.col < v.startOffset) {
      // shouldn't happen if layout is ordered, but guard
      continue;
    }
  }
  // cursor beyond last chunk -> place at end of last visual row for this logical line
  for (let i = layout.length - 1; i >= 0; i--) {
    const v = layout[i];
    if (v.logicalArea !== targetLogicalArea) continue;
    if (targetLogicalRow !== undefined && v.logicalRow !== targetLogicalRow) continue;
    const logicalLine = getLogicalLine(state, targetLogicalArea as "subject"|"body", targetLogicalRow);
    const chunkText = substringByGrapheme(logicalLine, v.startOffset, v.endOffset);
    const isFirstChunk = v.startOffset === 0;
    const prefixStr = isFirstChunk && isActive ? "> " : "  ";
    let col = displayWidth(prefixStr) + displayWidth(chunkText);
    if (columns) col = Math.min(col, columns - 1);
    return { row: i, col };
  }
  return { row: 0, col: columns ? Math.min(0, columns - 1) : 0 };
}

export function clearScreen(): string {
  return "\x1b[2J\x1b[H";
}

export function moveCursor(row: number, col: number): string {
  return `\x1b[${row + 1};${col + 1}H`;
}
