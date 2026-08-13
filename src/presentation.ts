// The commit-draft presentation layer: how the generated message, its staged
// file context, and the prompt are framed on screen in the interactive loop.
// Pure emission behind one seam — presentDraft writes through the injected
// stdout; color helpers are no-ops when shouldEmitColor resolves false.
//
// Zero runtime deps: color is raw ANSI SGR escapes (24-bit truecolor, with an
// ANSI-256 fallback picked by hand per role). Three roles only: muted (grey)
// for stage direction, accent (green) for the deliverable subject line and
// the (edited) badge, warn (amber) for the (truncated) badge. One color, one
// job — the subject is the thing the user came for, so it carries the hue.

import type { NumstatEntry } from "./compaction.ts";

type Palette = Readonly<{ muted: string; accent: string; warn: string }>;

// 24-bit truecolor, exact oklch→rgb per role. The leading string is the SGR
// opener; "\x1b[0m" always closes a span.
export const TRUECOLOR: Palette = {
  // oklch(0.58 0.01 250) — lifted from 0.5 because muted carries the key
  // prompt affordances (user-facing controls, not decoration); ~4.6:1 on
  // dark terminals, still recedes on light.
  muted: "\x1b[38;2;146;157;161m",
  accent: "\x1b[38;2;38;153;74m", // oklch(0.55 0.13 150)
  warn: "\x1b[38;2;164;116;28m", // oklch(0.6 0.13 70)
};
// ANSI-256 nearest cube matches (245 / 35 / 178→214). Used when the terminal
// reports a color depth below 24-bit.
const ANSI256: Palette = {
  muted: "\x1b[38;5;245m",
  accent: "\x1b[38;5;35m",
  warn: "\x1b[38;5;214m",
};

const RESET = "\x1b[0m";

/**
 * Decides whether to emit color. True only on a real TTY, with NO_COLOR and
 * CI both unset. CLICOLOR_FORCE is deliberately NOT honored — respecting
 * NO_COLOR means refusing to let a force flag poke back through it.
 * Reads env exactly once; every helper downstream takes the resolved flag.
 */
export function shouldEmitColor(
  _stdout: Pick<NodeJS.WriteStream, "write">,
  env: NodeJS.ProcessEnv,
  isTTY: boolean,
): boolean {
  // _stdout is kept in the signature so the loop's color seam matches its
  // shouldEmitColor call site; the TTY check is the caller's job.
  void _stdout;
  if (!isTTY) return false;
  if (env.NO_COLOR !== undefined) return false;
  if (env.CI !== undefined) return false;
  return true;
}

export type ColorGate = Readonly<{ enabled: boolean; palette: Palette }>;

/** Resolves the palette + gate once for a run; pass to the helpers below. */
export function resolveColors(enabled: boolean, getColorDepth?: () => number): ColorGate {
  const depth = enabled ? (getColorDepth?.() ?? 24) : 1;
  return { enabled, palette: depth >= 24 ? TRUECOLOR : ANSI256 };
}

const role = (gate: ColorGate, code: keyof Palette) => (s: string): string =>
  gate.enabled ? `${gate.palette[code]}${s}${RESET}` : s;

/** Grey — section labels ("─── staged changes ───"), the prompt wrapper. */
export const muted = (gate: ColorGate, s: string): string => role(gate, "muted")(s);
/** Green — the draft subject line and the (edited) badge. The deliverable. */
export const accent = (gate: ColorGate, s: string): string => role(gate, "accent")(s);
/** Amber — the (truncated) badge only. */
export const warn = (gate: ColorGate, s: string): string => role(gate, "warn")(s);





/**
 * The prompt wrapper is muted. The PROMPT literal itself owns the visual
 * shape (indent, key letters, separator, caret); we don't post-process it.
 * Stripping the bold pass here means byte-identity between PROMPT and
 * what's rendered, so changing the prompt is a one-line edit in loop.ts.
 */
function mutedPrompt(prompt: string, colors: ColorGate): string {
  if (!colors.enabled) return prompt;
  return muted(colors, prompt);
}

/** Renders the numstat block: two-space indent, right-ish aligned by path
 *  width. When `columns` is given and the block would overflow, paths are
 *  ellipsized at the start — counts are the data, they never truncate. */
export function renderNumstat(entries: readonly NumstatEntry[], columns?: number, colors?: ColorGate): string[] {
  if (entries.length === 0) return [];
  const render = (e: NumstatEntry, width: number) => {
    const p = width < e.path.length
      ? `${e.path.slice(0, Math.max(0, Math.floor((width - 4) / 2)))}…${e.path.slice(-Math.max(0, Math.ceil((width - 4) / 2)))}`
      : e.path;
    return `${p.padEnd(width)}   ${e.binary ? "binary" : `+${e.added} -${e.removed}`}`;
  };
  const pathWidth = Math.max(...entries.map((e) => e.path.length));
  if (columns !== undefined) {
    // Find the widest path column that keeps every line within `columns`;
    // paths narrower than the column print in full, longer ones ellipsize
    // in the middle to preserve leading namespace and basename.
    let width = pathWidth;
    while (width > 8 && entries.some((e) => render(e, width).length > columns)) width--;
    if (width < pathWidth) return entries.map((e) => render(e, width));
  }
  return entries.map((e) => render(e, pathWidth));
}

/**
 * The draft body rows exactly as presentDraft paints them — its one source
 * of truth pulled out so the inline editor can reprint the read-mode rows
 * byte-for-byte on cancel (subject in accent, body indented, no gutter).
 */
export function draftRows(draft: string, colors: ColorGate): string[] {
  const lines = draft.split("\n");
  const subjectIdx = lines.findIndex((l) => l.trim() !== "");
  if (subjectIdx === -1) return lines;
  return lines.map((l, i) => (i === subjectIdx ? `${accent(colors, l)}` : l === "" ? "" : `${l}`));
}

export type PresentOpts = Readonly<{
  draft: string;
  draftNumber: number; // 1-based; edits do not increment it
  edited: boolean; // draft came back from $EDITOR this frame
  revised: boolean; // draft came back from revise this frame
  truncated: boolean; // staged-diff digest was over budget
  numstat: readonly NumstatEntry[];
  prompt: string; // the live prompt string (kept verbatim; 12's territory)
  colors: ColorGate;
  /** Terminal width when known; rules and numstat adapt. Undefined = 50-col fallback. */
  columns?: number;
}>;

/**
 * Emits one framed frame to stdout: staged-changes section (numstat +
 * optional (truncated) badge), then the draft section (numbered, subject in
 * accent, optional (edited) badge), then the prompt on the same line. The
 * prompt is written last so the cursor sits at its end awaiting the key.
 *
 * This is interactive-only output — `--no-commit` never calls it. The frame
 * exists for the accept/edit/regenerate decision, not as a property of the
 * message itself.
 */
export function presentDraft(stdout: Pick<NodeJS.WriteStream, "write">, opts: PresentOpts): void {
  const { colors } = opts;
  const out: string[] = [];

  // (truncated) appears once per run — the badge is part of the label, not a
  // second line — so a re-presentation after a regeneration doesn't re-print it.
  out.push(`\nSTAGED CHANGES${opts.truncated ? " (truncated)" : ""}`);
  const numstatLines = renderNumstat(opts.numstat, opts.columns);
  out.push(...numstatLines.map(l => {
    if (!colors.enabled) return l;
    return l.replace(/(\+\d+)/g, (_, m) => accent(colors, m)).replace(/(-\d+)/g, (_, m) => warn(colors, m));
  }));
  // Resolved-state summary: what target the CLI found
  if (opts.numstat.length > 0) {
    const count = opts.numstat.length;
    out.push(muted(colors, `Files staged  ${count} file${count === 1 ? '' : 's'}`));
  }

  // (edited) / (revised) badge keeps the same draft number — edits and revisions don't increment it;
  // only `r` does.
  const badges: string[] = [];
  if (opts.edited) badges.push("edited");
  if (opts.revised) badges.push("revised");
  const badge = badges.length ? ` (${badges.join(", ")})` : "";
  out.push(`\nDRAFT ${opts.draftNumber}${badge}`);

  // Subject (first non-empty line) takes the accent; body stays default prose.
  out.push(...draftRows(opts.draft, colors));
  // divider removed for UI experiment
  stdout.write(`${out.join("\n")}\n\n${mutedPrompt(opts.prompt, colors)}`);
}
