// Template engine for commitshi and the strict token-fill contract.
//
// A **template** is the user-authored shape of the commit message: literal
// text plus fill positions {type}, {scope}, {summary}, {body}. The model
// never emits that shape raw — tiny models echo it back instead — so the
// model speaks a separate, stricter **fill contract**: it replies with one
// `name: value` line per token (value may wrap; a lone `-` means "no
// value"). We parse those fields, then *fill the template* with them so the
// finished commit message is the template shape with exactly one value per
// token, constructed from the template alone — which makes freeform prose
// outside token positions structurally impossible in the output.
//
// Output that breaks the fill contract — a missing token, an unknown one, a
// non-conforming value, or raw model text that is not a `name: value` line —
// is rejected with a reason and never salvaged.

export type TokenName = "type" | "scope" | "summary" | "body";
export type TemplateKind = "conventional" | "custom";

export const KNOWN_TOKENS: readonly TokenName[] = ["type", "scope", "summary", "body"];
/**
 * The default Conventional Commits template used when `commitshi.template` is empty.
 * {scope} carries its own parens ("(cli)" or nothing), and the blank line before
 * {body} is literal — it survives render, per the git subject/body rule.
 */
export const DEFAULT_CONVENTIONAL_TEMPLATE = "{type}{scope}: {summary}\n\n{body}";

export type TemplateParse =
  | Readonly<{ ok: true; kind: TemplateKind; tokens: readonly TokenName[] }>
  | Readonly<{ ok: false; error: string }>;

export type Segment =
  | Readonly<{ kind: "literal"; text: string }>
  | Readonly<{ kind: "token"; name: TokenName }>;

/** Splits a template into literal text and tokens, in order. Throws on a malformed/unknown token (parseTemplate guards first). */
export function segmentTemplate(template: string): readonly Segment[] {
  const out: Segment[] = [];
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf("{", i);
    if (open === -1) {
      out.push({ kind: "literal", text: template.slice(i) });
      break;
    }
    if (open > i) out.push({ kind: "literal", text: template.slice(i, open) });
    const close = template.indexOf("}", open + 1);
    const name = close === -1 ? template.slice(open + 1) : template.slice(open + 1, close);
    out.push({ kind: "token", name: name as TokenName });
    i = close === -1 ? template.length : close + 1;
  }
  return out;
}

/** Validates a template string. Empty is invalid here — the caller substitutes the default before consulting this. */
export function parseTemplate(template: string): TemplateParse {
  if (template.trim() === "") {
    return { ok: false, error: "template is empty; empty means the Conventional Commits default applies instead" };
  }
  const tokens: TokenName[] = [];
  for (let m = /\{(.*?)\}/g, match = m.exec(template); match !== null; match = m.exec(template)) {
    const name = match[1];
    if (!(KNOWN_TOKENS as readonly string[]).includes(name)) {
      return {
        ok: false,
        error: `unknown token {${name}}; known tokens are ${KNOWN_TOKENS.map((t) => `{${t}}`).join(", ")}`,
      };
    }
    tokens.push(name as TokenName);
  }
  if (tokens.length === 0) {
    return { ok: false, error: "template has no tokens; add at least one of {type}, {scope}, {summary}, {body}" };
  }
  const seen = new Set<string>();
  for (const t of tokens) {
    if (seen.has(t)) return { ok: false, error: `token {${t}} appears more than once; each token may appear at most once` };
    seen.add(t);
  }
  return { ok: true, kind: tokens[0] === "type" ? "conventional" : "custom", tokens };
}

// --- fill contract ----------------------------------------------------------

const FIELD_RE = /^(type|scope|summary|body)\s*:\s*(.*)$/;
/** A value line only in the default template carries a fixed single-line slot. */
const SINGLE_LINE: Readonly<Record<TokenName, boolean>> = {
  type: true,
  scope: true,
  summary: true,
  body: false,
};

export type FillValues = Readonly<Partial<Record<TokenName, string>>>;

/**
 * Parses the model's fill-contract reply into per-token values. Only the
 * tokens the template asks for are expected. Multi-line values continue on
 * following lines until the next `name:` line. A lone `-` (or an empty
 * value) means "no value" and is only accepted from a token that sits alone
 * on its template line.
 */
export function parseFillContract(
  modelOutput: string,
  wanted: readonly TokenName[],
  omissible: Readonly<Set<TokenName>>,
): Readonly<{ ok: true; values: Record<TokenName, string> } | { ok: false; error: string }> {
  const wantedSet = new Set(wanted);
  const values = new Map<TokenName, string>();
  const raw = modelOutput.replace(/\r\n?/g, "\n");

  // Collect (field, valueLines) in order; unknown field lines are prose.
  const lines = raw.split("\n");
  let current: TokenName | null = null;
  const buckets: Array<{ field: TokenName; vals: string[] }> = [];
  const stray: string[] = [];
  for (const line of lines) {
    const m = FIELD_RE.exec(line.trimEnd() === "" ? "" : line);
    if (m !== null) {
      const field = m[1] as TokenName;
      if (!wantedSet.has(field)) {
        stray.push(line);
        current = null;
        continue;
      }
      current = field;
      const existing = buckets.find((b) => b.field === field);
      const vals = [m[2]];
      if (existing) existing.vals.push(...vals);
      else buckets.push({ field, vals });
      continue;
    }
    if (current !== null && line.trim() !== "") {
      buckets[buckets.length - 1].vals.push(line);
      continue;
    }
    if (line.trim() !== "") stray.push(line);
  }

  if (stray.length > 0) {
    return {
      ok: false,
      error: `output contained prose that is not a token line: ${JSON.stringify(stray[0].trim().slice(0, 60))} — the fill contract is exactly one "name: value" line per template token`,
    };
  }

  for (const token of wanted) {
    const bucket = buckets.find((b) => b.field === token);
    if (bucket === undefined) {
      return { ok: false, error: `missing token {${token}}; the model did not fill it` };
    }
    let value = bucket.vals.join("\n").trim();
    if (value === "-") value = "";
    if (/\{[a-z]+\}/.test(value)) {
      return { ok: false, error: `token {${token}}: value still contains a template token (${RegExp["$&"]}); emit values only, never the { } names` };
    }
    // scope is the optional half of Conventional Commits: "no value" means no
    // scope at all (and no parens). Any other token may be empty only when its
    // whole template line is droppable.
    if (value === "" && !omissible.has(token) && token !== "scope") {
      return { ok: false, error: `token {${token}} was given no value, but its position in the template requires one` };
    }
    if (SINGLE_LINE[token] && value !== "" && value.includes("\n")) {
      return { ok: false, error: `token {${token}} must be a single line; got ${JSON.stringify(value.slice(0, 60))}` };
    }
    values.set(token, value);
  }

  // A field the template did not ask for was already caught as stray prose.
  return { ok: true, values: Object.fromEntries(values) as Record<TokenName, string> };
}

/** Value discipline applied after parsing, before render. */
function validateValues(values: FillValues): Readonly<{ ok: true } | { ok: false; error: string }> {
  const type = values.type;
  if (type !== undefined) {
    if (type === "") return { ok: false, error: "token {type} was left empty; the commit needs a one-word type (e.g. feat, fix, chore)" };
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(type)) {
      return { ok: false, error: `token {type} must be one word; got ${JSON.stringify(type)}` };
    }
  }
  const scope = values.scope;
  if (scope !== undefined && scope !== "" && !/^[^\s()]+$/.test(scope)) {
    return { ok: false, error: `token {scope} must be a single word or empty; got ${JSON.stringify(scope)}` };
  }
  return { ok: true };
}

/**
 * Fills the template with validated values. Empty omissible tokens leave no
 * residue: a template line that held only that token (plus whitespace) drops
 * out entirely. Lines that are empty in the *template* — a literal blank line
 * like the one between subject and body — are structure and survive.
 */
function render(template: string, values: FillValues): string {
  // Fill one template line at a time so the line-level drop below can see
  // exactly which template line produced each output line, no matter how many
  // lines a multi-line value (body) expands into.
  const filledLines = template.split("\n").map((tplLine) => {
    let line = "";
    for (const seg of segmentTemplate(tplLine)) {
      line += seg.kind === "literal" ? seg.text : (values[seg.name] ?? "");
    }
    return { tplLine, line };
  });
  return filledLines
    .map(({ tplLine, line }) => {
      if (line.trim() === "" && tplLine.trim() !== "" && hasOnlyWhitespaceAndEmptyTokens(tplLine, values)) return null;
      return line;
    })
    .filter((line): line is string => line !== null)
    .join("\n")
    .trim();
}

/** True when a template line, once filled, is empty solely because every token on it came back empty and the rest was whitespace. */
function hasOnlyWhitespaceAndEmptyTokens(templateLine: string, values: FillValues): boolean {
  const pieces = templateLine.split(/\{[a-z]+\}/);
  if (pieces.some((lit) => lit.trim() !== "")) return false;
  for (const m of templateLine.matchAll(/\{([a-z]+)\}/g)) {
    const v = values[m[1] as TokenName];
    if (v !== undefined && v !== "") return false;
  }
  return true;
}

export type StrictFillResult =
  | Readonly<{ ok: true; message: string }>
  | Readonly<{ ok: false; error: string }>;

/**
 * Turns a model reply into the finished commit message under the strict
 * token-fill contract, or rejects it with a precise reason. The message is
 * assembled from the template and the parsed values — nothing the model said
 * outside a token value can reach the commit. When {scope} is not already
 * bounded by literal parens in the template (as in the default), the value
 * gains them ("cli" → "(cli)"), so an empty scope leaves no parens behind.
 */
export function strictFill(template: string, modelOutput: string): StrictFillResult {
  const parsed = parseTemplate(template);
  if (!parsed.ok) return { ok: false, error: `template: ${parsed.error}` };

  const omissible = new Set<TokenName>();
  for (const token of parsed.tokens) {
    const needle = `{${token}}`;
    const i = template.indexOf(needle);
    const lineStart = template.lastIndexOf("\n", i) + 1;
    const nl = template.indexOf("\n", i + needle.length);
    const lineEnd = nl === -1 ? template.length : nl;
    const before = template.slice(lineStart, i);
    const after = template.slice(i + needle.length, lineEnd);
    if (/^\s*$/.test(before) && /^\s*$/.test(after)) omissible.add(token);
  }

  const filled = parseFillContract(modelOutput, parsed.tokens, omissible);
  if (!filled.ok) return filled;

  const valid = validateValues(filled.values);
  if (!valid.ok) return valid;

  const values: FillValues =
    parsed.tokens.includes("scope") && !scopeHasLiteralParens(template)
      ? { ...filled.values, scope: withParens(filled.values.scope) }
      : filled.values;

  return { ok: true, message: render(template, values) };
}

/** True when the template already puts a literal "(" before and ")" after {scope} (the legacy shape) — the value is shown bare inside them. */
function scopeHasLiteralParens(template: string): boolean {
  const i = template.indexOf("{scope}");
  return i > 0 && template[i - 1] === "(" && template[i + "{scope}".length] === ")";
}

/** Wraps a non-empty scope in parens ("cli" → "(cli)"); an empty scope stays empty. */
function withParens(scope: string | undefined): string {
  if (scope === undefined || scope === "") return "";
  return `(${scope})`;
}

// --- prompt assembly --------------------------------------------------------

const TYPE_VOCAB = ["feat", "fix", "docs", "chore", "refactor", "test", "perf", "style", "build", "ci", "revert"];

/** Builds the fill-contract instructions the model must follow, for the given template tokens. */
export function buildFillInstructions(tokens: readonly TokenName[]): string {
  const describe: Record<TokenName, string> = {
    type: `one word, one of: ${TYPE_VOCAB.join(" ")}`,
    scope: "one short word naming the area, or - if none fits",
    summary: "one short imperative line, no trailing period",
    body: "one short paragraph of context, or - if nothing more is worth saying",
  };
  const lines = tokens.map((t) => `${t}: <${describe[t]}>`);
  return [
    "Reply with exactly these lines, in this order, and nothing else:",
    ...lines,
    "Fill every line. Use a single - as the value only where the description allows.",
    "No other text, no markdown fences, no preamble.",
  ].join("\n");
}

/**
 * The system prompt the model sees, built from the template alone. Owns the
 * fill contract AND the prose rules it explains, so the two can never drift
 * apart — this is the text whose contract `strictFill` enforces on the reply.
 * Callers pass the template string, not a pre-parsed shape: parse is an
 * internal here. A malformed template yields a generic contract prompt; the
 * strictFill step would have already rejected it with the precise reason.
 */
export function buildPrompt(template: string): string {
  const parsed = parseTemplate(template);
  const conventional = parsed.ok && parsed.kind === "conventional";
  const tokens: readonly TokenName[] = parsed.ok ? parsed.tokens : KNOWN_TOKENS;
  return [
    "You write a git commit message for staged changes, shaped to a template.",
    conventional
      ? "Follow the Conventional Commits style: a concise subject, an optional scope in parentheses, and an optional body when the change needs context."
      : "Follow the template's shape exactly; it is the required output format.",
    "Base the message only on the compacted diff and the file names in it; do not invent files or changes.",
    "",
    buildFillInstructions(tokens),
  ].join("\n");
}

/** Preflight for callers that must fail before a model call: the parse error
 *  when the template is malformed, null when it parses. strictFill remains
 *  the authoritative gate on what the model sends back. */
export function checkTemplate(template: string): string | null {
  const parsed = parseTemplate(template);
  return parsed.ok ? null : parsed.error;
}
