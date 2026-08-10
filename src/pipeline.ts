// The commit-draft pipeline: staged diff → compacted diff → template + prompt
// → provider → strict token fill → commit draft. No git writes, no editor, no
// commit; the model call and the git reads are the only IO, all injectable so
// the whole path is testable without a live model.

import { compact, renderCompacted } from "./compaction.ts";
import { chatCompletions, type ChatDeps, type CompletionResult } from "./provider/openai.ts";
import type { Provider } from "./config.ts";
import { isLocalBaseUrl } from "./config.ts";
import {
  buildFillInstructions,
  DEFAULT_CONVENTIONAL_TEMPLATE,
  parseTemplate,
  strictFill,
  type TemplateParse,
} from "./template.ts";

// Re-exported so the setup wizard and pipeline share one source of truth:
// the URL the wizard offers as default is exactly the one the pipeline
// falls back to, and the local-endpoint check never drifts apart.
export { isLocalBaseUrl };

export type PipelineDeps = Readonly<{
  stagedDiff: () => Promise<string>;
  /**
   * The --style opt-in seam: wired to the git history reader only when the
   * flag is passed, ABSENT otherwise. "Absent means never read" is the
   * no-silent-history guarantee — a code path that cannot read rather than
   * one that promises not to.
   */
  styleHistory?: () => Promise<readonly string[]>;
  /** Resolves a config key: the `makeResolveKey` signature (key, {flags}). */
  resolveKey: (
    key: string,
    opts?: { flags?: Partial<Record<string, string | undefined>> },
  ) => Promise<Readonly<{ value: string; source: string }> | null>;
  /** Resolves the API key for a named provider. */
  resolveApiKey: (provider: Provider) => Promise<Readonly<{ value: string; source: string }> | null>;
  chat?: (deps: ChatDeps, req: Parameters<typeof chatCompletions>[1]) => Promise<CompletionResult>;
  /** One-shot CLI overrides, applied at the top of the precedence chain. None are ever persisted. */
  flags?: Readonly<{
    model?: string;
    template?: string;
    baseUrl?: string;
    provider?: string;
    /** --instructions: one-shot; outranks the template below, never persisted. */
    instructions?: string;
  }>;
}>;

export type DraftResult =
  | Readonly<{ ok: true; message: string; truncated: boolean; templateKind: string; baseUrl: string; model: string }>
  | Readonly<{ ok: false; exitCode: number; message: string }>;

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
// Cheap, fast, right-sized for a ~600-token commit subject. Deliberately
// NOT the `gpt-5.6` alias, which routes to the flagship Sol tier ($5/$30).
export const DEFAULT_MODEL = "gpt-5.6-luna";

/** Builds the system prompt: role + strict contract, tuned to the template's tokens. */
function buildSystemPrompt(templateParse: Extract<TemplateParse, { ok: true }>): string {
  const conventional = templateParse.kind === "conventional";
  return [
    "You write a git commit message for staged changes, shaped to a template.",
    conventional
      ? "Follow the Conventional Commits style: a concise subject, an optional scope in parentheses, and an optional body when the change needs context."
      : "Follow the template's shape exactly; it is the required output format.",
    "Base the message only on the compacted diff and the file names in it; do not invent files or changes.",
    "",
    buildFillInstructions(templateParse.tokens),
  ].join("\n");
}

/**
 * Runs the full tracer-bullet pipeline. A failure at any stage returns a loud
 * message and the exit code to use; success returns the finished commit draft.
 */
export async function generateDraft(deps: PipelineDeps): Promise<DraftResult> {
  const diff = await deps.stagedDiff();
  const compacted = compact(diff);

  // Provider selection: this ticket ships the OpenAI-compatible adapter.
  // Asking for another provider gets a loud, honest refusal, not a silent
  // fallthrough to the wrong wire format.
  const flags = deps.flags ?? {};
  const providerR = await deps.resolveKey("provider", { flags: { provider: flags.provider } });
  if (providerR !== null && providerR.value !== "" && providerR.value.toLowerCase() !== "openai") {
    return {
      ok: false,
      exitCode: 2,
      message: `commitshi: provider "${providerR.value}" is not supported yet — v0 understands "openai" (any OpenAI-compatible baseUrl: OpenAI, Groq, DeepSeek, Ollama); Anthropic lands in the next ticket`,
    };
  }

  // The API key may legitimately be absent for a local OpenAI-compatible
  // endpoint; only a non-local baseUrl demands one.
  const baseUrlR = await deps.resolveKey("baseUrl", { flags: { baseUrl: flags.baseUrl } });
  const modelR = await deps.resolveKey("model", { flags: { model: flags.model } });
  const templateR = await deps.resolveKey("template", { flags: { template: flags.template } });
  // v0 ships the OpenAI-compatible adapter (this ticket); Anthropic is 06.
  const apiKeyR = await deps.resolveApiKey("openai");

  const baseUrl = baseUrlR?.value ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL;
  const model = modelR?.value ?? DEFAULT_MODEL;

  const isLocal = isLocalBaseUrl(baseUrl);
  if (!isLocal && (apiKeyR === null || apiKeyR.value === "")) {
    return {
      ok: false,
      exitCode: 1,
      message: [
        "commitshi: no API key found for a non-local provider",
        "",
        `Serve a local endpoint (e.g. Ollama) and set baseUrl, or provide a key via`,
        `  OPENAI_API_KEY (env) or openai_api_key= in the config file.`,
      ].join("\n"),
    };
  }
  // Never forward a real credential to a local server: local endpoints
  // (Ollama & friends) don't consult it, and a stray OPENAI_API_KEY must not
  // leak to whatever happens to be listening on localhost.
  const apiKey = isLocal ? undefined : apiKeyR?.value;

  const templateRaw = templateR?.value?.trim() ?? "";
  const template = templateRaw === "" ? DEFAULT_CONVENTIONAL_TEMPLATE : templateRaw;
  const parsed = parseTemplate(template);
  if (!parsed.ok) {
    return { ok: false, exitCode: 2, message: `commitshi: template is invalid — ${parsed.error}` };
  }

  // Optional one-shot prompt blocks (tickets 09, 10). Each is appended only
  // when the corresponding flag was passed; with neither flag the prompt is
  // exactly the ticket-05 default, byte for byte.
  const extras: string[] = [];

  if (deps.styleHistory !== undefined) {
    // History must never break the draft: a failed read degrades to no
    // block, exactly like a fresh repo with no commits yet.
    let subjects: readonly string[] = [];
    try {
      subjects = await deps.styleHistory();
    } catch {
      subjects = [];
    }
    if (subjects.length > 0) {
      extras.push(
        [
          "### Style history",
          "",
          "Recent commit subjects from this repository, newest first:",
          ...subjects.map((s) => `- ${s}`),
          "Match their local conventions (type vocabulary, scope style, summary phrasing) where they agree.",
        ].join("\n"),
      );
    }
  }

  const instructions = flags.instructions?.trim() ?? "";
  if (instructions !== "") {
    extras.push(
      [
        "### User instructions",
        "",
        instructions,
        "",
        "These instructions outrank the template and default conventions: they may steer the type/scope choice and reword the summary and body, but they can never break the fill contract — exactly one value per template line, and no text outside those lines.",
      ].join("\n"),
    );
  }

  const system = buildSystemPrompt(parsed);
  const user = [
    "### Compact diff",
    "",
    renderCompacted(compacted),
    ...extras,
    "",
    "Fill every template token from this diff only.",
  ].join("\n");

  const chat = deps.chat ?? chatCompletions;
  const result = await chat(
    { baseUrl, apiKey },
    { model, messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0 },
  );

  if (!result.ok) {
    // Loud, single-shot failure: rate limits and auth get a distinct exit code
    // so scripts and hooks can tell "try again later" from "fix credentials".
    const exitCode = result.kind === "rate_limited" || result.kind === "auth" ? 3 : 1;
    return { ok: false, exitCode, message: result.message };
  }

  const filled = strictFill(template, result.content);
  if (!filled.ok) {
    return {
      ok: false,
      exitCode: 1,
      message: [
        "commitshi: model output did not satisfy the template contract and was rejected — no commit draft was made",
        "",
        `reason: ${filled.error}`,
      ].join("\n"),
    };
  }

  return {
    ok: true,
    message: filled.message,
    truncated: compacted.truncated,
    templateKind: parsed.kind,
    baseUrl,
    model,
  };
}
