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

/** Width the section label rules pad out to. Fixed; no $COLUMNS reads. */
const RULE_WIDTH = 50;

type Palette = Readonly<{ muted: string; accent: string; warn: string }>;

// 24-bit truecolor, exact oklch→rgb per role. The leading string is the SGR
// opener; "\x1b[0m" always closes a span.
const TRUECOLOR: Palette = {
  muted: "\x1b[38;2;113;124;128m", // oklch(0.5 0.01 250)
  accent: "\x1b[38;2;38;153;74m", // oklch(0.55 0.13 150)
  warn: "\x1b[38;2;164;116;28m", // oklch(0.6 0.13 70)
};
// ANSI-256 nearest cube matches (240 / 35 / 178→214). Used when the terminal
// reports a color depth below 24-bit.
const ANSI256: Palette = {
  muted: "\x1b[38;5;240m",
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
 * One section header: `─── <label> [badge] ─── ` padded to RULE_WIDTH.
 * The line is muted stage direction; the badge (if any) carries its own role
 * as a separate segment, so no ANSI escapes nest or clobber each other. Pad
 * is computed on the plain string — escape bytes never shorten the rule.
 */
function rule(
  label: string,
  colors: ColorGate,
  badge?: Readonly<{ text: string; paint: (g: ColorGate, s: string) => string }>,
): string {
  const head = `─── ${label} `;
  const visible = head + (badge ? `${badge.text} ` : "");
  const dash = "─".repeat(Math.max(0, RULE_WIDTH - visible.length));
  if (!colors.enabled) return `${visible}${dash}`;
  return `${muted(colors, head)}${badge ? `${badge.paint(colors, badge.text)}${muted(colors, " ")}` : ""}${muted(colors, dash)}`;
}

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

/** Renders the numstat block: two-space indent, right-ish aligned by path width. */
function renderNumstat(entries: readonly NumstatEntry[]): string[] {
  if (entries.length === 0) return [];
  const pathWidth = Math.max(...entries.map((e) => e.path.length));
  return entries.map((e) => {
    const counts = e.binary ? "binary" : `+${e.added} -${e.removed}`;
    return `  ${e.path.padEnd(pathWidth)}   ${counts}`;
  });
}

export type PresentOpts = Readonly<{
  draft: string;
  draftNumber: number; // 1-based; edits do not increment it
  edited: boolean; // draft came back from $EDITOR this frame
  truncated: boolean; // staged-diff digest was over budget
  numstat: readonly NumstatEntry[];
  prompt: string; // the live prompt string (kept verbatim; 12's territory)
  colors: ColorGate;
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
  out.push(
    `\n${rule("staged changes", colors, opts.truncated ? { text: "(truncated)", paint: warn } : undefined)}`,
  );
  out.push(...renderNumstat(opts.numstat));

  // (edited) badge keeps the same draft number — edits don't increment it;
  // only `r` does.
  out.push(
    `\n${rule(`draft ${opts.draftNumber}`, colors, opts.edited ? { text: "(edited)", paint: accent } : undefined)}`,
  );

  // Subject (first non-empty line) takes the accent; body stays default prose.
  const lines = opts.draft.split("\n");
  const subjectIdx = lines.findIndex((l) => l.trim() !== "");
  if (subjectIdx !== -1) {
    lines[subjectIdx] = `  ${accent(colors, lines[subjectIdx])}`;
    for (let i = 0; i < lines.length; i++) {
      if (i !== subjectIdx && lines[i] !== "") lines[i] = `  ${lines[i]}`;
    }
  }
  out.push(...lines);

  stdout.write(`${out.join("\n")}\n\n${mutedPrompt(opts.prompt, colors)}`);
}

/**
 * The "model call in flight" line for a regeneration. On a TTY it overwrites
 * the prompt line in place (`\r`); off-TTY it degrades to a fresh prefixed
 * line so captured output stays linear and greppable. Draft number carries so
 * the user sees which generation is coming.
 */
export function regenerating(draftNumber: number, isTTY: boolean): string {
  return isTTY ? `\r  regenerating — draft ${draftNumber} ›\n` : `commitshi: regenerating — draft ${draftNumber}\n`;
}
