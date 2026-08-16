// Client-side compaction: turn the raw staged diff into the compacted diff
// that is actually sent to the model — per-file numstat plus slim hunks with
// unchanged context collapsed. Lossy on noise, faithful on semantics; over a
// generous hunk cap it stops and marks the digest truncated, never silently.

/** Hard cap on hunks kept. Past this the digest declares itself truncated. */
export const HUNK_CAP = 10_000;
/** Unchanged context lines kept on each side between hunks. Larger runs collapse. */
export const CONTEXT_RADIUS = 1;
/** Added/removed runs longer than this are slimmed to WINDOW + remainder count. */
export const HUNK_RUN_WINDOW = 40;

export type CompactedDiff = Readonly<{
  numstat: readonly NumstatEntry[];
  hunks: string; // slimmed diff body (headers + hunk payloads, numstat stripped)
  truncated: boolean; // true when the hunk cap cut the digest short
}>;

export type NumstatEntry = Readonly<{
  path: string;
  added: number | null; // null => binary
  removed: number | null;
  binary: boolean;
}>;

export type DiffHunk = Readonly<{
  oldStart: number; // old-side start line of this hunk (from @@ header)
  lines: string[];
}>;

export type DiffFile = Readonly<{
  oldPath: string | null; // null => new file
  newPath: string | null; // null => deleted
  hunks: DiffHunk[];
  binary: boolean; // "Binary files a/x and b/y differ" style
}>;

/** Parses a unified diff into per-file hunks. Unfamiliar headers pass through as part of the file header. */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: {
    oldPath: string | null;
    newPath: string | null;
    hunks: DiffHunk[];
    binary: boolean;
  } | null = null;
  let hunk: DiffHunk | null = null;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { oldPath: null, newPath: null, hunks: [], binary: false };
      files.push(current);
      hunk = null;
      continue;
    }
    if (current === null) continue;

    if (line.startsWith("--- ")) {
      current.oldPath = line.slice(4) === "/dev/null" ? null : stripPrefix(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      current.newPath = line.slice(4) === "/dev/null" ? null : stripPrefix(line.slice(4));
      continue;
    }
    if (line.startsWith("GIT binary patch")) {
      current.binary = true;
      continue;
    }
    if (line.startsWith("Binary files ")) {
      // 'Binary files a/x and b/y differ' — binary-only diffs carry paths here,
      // not in ---/+++ headers.
      const match = /^Binary files "?a\/(.*?)"? and "?b\/(.*?)"? differ$/.exec(line);
      if (match) {
        current.oldPath = match[1];
        current.newPath = match[2];
      }
      current.binary = true;
      continue;
    }
    if (line.startsWith("@@ ")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      hunk = { oldStart: match ? Number(match[1]) : 0, lines: [] };
      current.hunks.push(hunk);
      continue;
    }
    if (
      hunk !== null &&
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line === "\\")
    ) {
      hunk.lines.push(line);
    }
    // index/mode/rename headers live between "diff --git" and the first hunk;
    // we drop them — numstat carries the real signal.
  }
  return files;
}

function stripPrefix(path: string): string {
  return path.replace(/^"|"$/g, "").replace(/^[ab]\//, "");
}

/** Collapses unchanged context to slits and slim long add/remove runs, returning a slim hunk body. */
export function slimHunk(hunk: DiffHunk): string {
  const n = hunk.lines.length;
  const isContext = (i: number) => hunk.lines[i]?.startsWith(" ") ?? false;

  // Find indices of changed (+/-) lines; context between neighbours keeps CONTEXT_RADIUS on each side.
  const changed: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!isContext(i) && hunk.lines[i] !== "\\") changed.push(i);
  }
  if (changed.length === 0) return hunk.lines.join("\n"); // degenerate: keep as-is

  const keep = new Set<number>();
  for (const c of changed) {
    keep.add(c);
    // unchanged context around a change is what we keep; never absorb a
    // neighbouring changed line into a run
    for (let j = Math.max(0, c - CONTEXT_RADIUS); j <= Math.min(n - 1, c + CONTEXT_RADIUS); j++) {
      if (isContext(j)) keep.add(j);
    }
  }

  const out: string[] = [];
  let oldLine = hunk.oldStart;
  let i = 0;
  while (i < n) {
    if (!keep.has(i)) {
      // run of dropped context
      let j = i;
      while (j < n && !keep.has(j)) j++;
      const dropped = j - i;
      const skipTo = oldLine + dropped;
      out.push(slits(oldLine, skipTo));
      oldLine = skipTo;
      i = j;
      continue;
    }
    const line = hunk.lines[i];
    if (isContext(i) || line === "\\") {
      out.push(line);
      oldLine++;
      i++;
      continue;
    }
    // changed line: emit, possibly as a slimmed same-sign run
    const sign = line[0];
    const run: string[] = [line];
    if (sign === "+") {
      // only added runs extend (they don't consume old lines; safe to absorb)
      let j = i + 1;
      while (j < n && keep.has(j) && hunk.lines[j][0] === "+" && hunk.lines[j] !== "\\") {
        run.push(hunk.lines[j]);
        j++;
      }
      out.push(...slimRun(sign, run));
      i = j;
    } else {
      out.push(line);
      oldLine++;
      i++;
    }
  }
  return out.join("\n");
}

function slimRun(sign: string, run: string[]): string[] {
  if (run.length <= HUNK_RUN_WINDOW) return run;
  const kept = run.slice(0, HUNK_RUN_WINDOW);
  return [
    ...kept,
    `${sign}… (${run.length - HUNK_RUN_WINDOW} more ${sign === "+" ? "added" : "removed"} lines)`,
  ];
}

function slits(fromLine: number, toLineExclusive: number): string {
  const start = fromLine + 1;
  const end = toLineExclusive;
  return `⋮ ${start}–${end}`;
}

/** Builds numstat entries from parsed files (binary => null counts). */
export function numstat(files: readonly DiffFile[]): NumstatEntry[] {
  return files.map((file) => {
    const path = file.newPath ?? file.oldPath ?? "unknown";
    if (file.binary) return { path, added: null, removed: null, binary: true };
    let added = 0;
    let removed = 0;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith("+")) added++;
        else if (line.startsWith("-")) removed++;
      }
    }
    return { path, added, removed, binary: false };
  });
}

/** The compacted diff: dense per-file stats + slim hunks; truncated past the hunk cap. */
export function compact(diff: string): CompactedDiff {
  const files = parseDiff(diff);
  const stats = numstat(files);

  let hunksKept = 0;
  let truncated = false;
  const parts: string[] = [];
  for (const file of files) {
    if (truncated) {
      truncated = true;
      break;
    }
    const headerParts: string[] = [];
    const header = fileHeader(file);
    if (header !== null) headerParts.push(header);
    if (file.binary) {
      headerParts.push("(binary file)");
      parts.push(headerParts.join("\n"));
      continue;
    }
    const hunkBodies: string[] = [];
    for (const hunk of file.hunks) {
      if (hunksKept >= HUNK_CAP) {
        truncated = true;
        break;
      }
      hunksKept++;
      hunkBodies.push(slimHunk(hunk));
    }
    if (truncated) {
      // File header is kept so the model still sees every touched path.
      parts.push([...headerParts, "⋮ (hunks omitted — digest truncated)"].join("\n"));
      continue;
    }
    parts.push([...headerParts, ...hunkBodies].join("\n"));
  }

  return { numstat: stats, hunks: parts.join("\n"), truncated };
}

function fileHeader(file: DiffFile): string | null {
  const oldPath = file.oldPath;
  const newPath = file.newPath;
  if (oldPath === null && newPath === null) return null;
  if (oldPath === null) return `new file: ${newPath}`;
  if (newPath === null) return `deleted file: ${oldPath}`;
  if (oldPath === newPath) return `file: ${newPath}`;
  return `renamed: ${oldPath} -> ${newPath}`;
}

/** Renders the compacted diff as the text the model actually sees. */
export function renderCompacted(compacted: CompactedDiff): string {
  const lines: string[] = [
    "### Staged changes (compacted)",
    "",
    "The diff below is a compact representation of the staged changes.",
    "Some unchanged context may be omitted.",
    "Treat the displayed changes as authoritative; do not assume omitted context.",
    "",
  ];
  for (const stat of compacted.numstat) {
    const counts = stat.binary ? "binary" : `+${stat.added} -${stat.removed}`;
    lines.push(`${stat.path}: ${counts}`);
  }
  if (compacted.truncated) {
    lines.push(
      "",
      "⚠ truncated: the staged change is larger than the digest budget; hunks beyond the cap were omitted",
    );
  }
  lines.push("", compacted.hunks);
  return lines.join("\n");
}
