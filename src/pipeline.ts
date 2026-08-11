// The commit-draft pipeline: staged diff → compacted diff → template + prompt
// → provider → strict token fill → commit draft. No git writes, no editor, no
// commit; the model call and the git reads are the only IO, all injectable so
// the whole path is testable without a live model.

import { compact, renderCompacted, type NumstatEntry } from "./compaction.ts";
import { chatCompletions, type ChatDeps, type CompletionResult } from "./provider/openai.ts";
import type { Provider } from "./config.ts";
import { isLocalBaseUrl, missingKeyMessage, type ConfigBundle } from "./config.ts";
import {
  buildPrompt,
  checkTemplate,
  DEFAULT_CONVENTIONAL_TEMPLATE,
  strictFill,
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
  /** The one config seam: resolves the draft-facing bundle
   * (provider/baseUrl/model/template over the injected flags) in a single
   * pass. Production wires config.ts's `resolveBundle`; tests stub it. */
  resolveBundle: (
    flags?: Partial<Record<string, string | undefined>>,
  ) => Promise<ConfigBundle>;
  /** Resolves the API key for a named provider. */
  resolveApiKey: (provider: Provider) => Promise<Readonly<{ value: string; source: string }> | null>;
  /** Environment seam for the pipeline's own legacy-env fallbacks
   * (OPENAI_BASE_URL / OPENAI_API_KEY); tests inject a hermetic env so a
   * developer's exported vars can't leak into the key-demand check. */
  env?: NodeJS.ProcessEnv;
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
  | Readonly<{
      ok: true;
      message: string;
      truncated: boolean;
      numstat: readonly NumstatEntry[]; // per-file stats for the presentation frame
      baseUrl: string;
      model: string;
    }>
  | Readonly<{
      ok: false;
      exitCode: number;
      message: string;
      /**
       * "missing-key": the resolved bundle cannot make a call (non-local
       * baseUrl, no key anywhere). The discriminant main.ts maps to the
       * setup wizard — key demand lives HERE, at the draft's front door,
       * not mirrored ahead of the staged guard in main.
       */
      kind?: "missing-key";
    }>;

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
// Cheap, fast, right-sized for a ~600-token commit subject. Deliberately
// NOT the `gpt-5.6` alias, which routes to the flagship Sol tier ($5/$30).
export const DEFAULT_MODEL = "gpt-5.6-luna";

let regenerateTemperatureOverride: number | null = null;

/** Sets the temperature used by the next generateDraft() call. Reset on every generateDraft() entry. */
export function setRegenerateTemperatureOverride(value: number | null): void {
  regenerateTemperatureOverride = value;
}
/**
 * Runs the full tracer-bullet pipeline. A failure at any stage returns a loud
 * message and the exit code to use; success returns the finished commit draft.
 */
export async function generateDraft(deps: PipelineDeps): Promise<DraftResult> {
  const temperatureOverride = regenerateTemperatureOverride;
  regenerateTemperatureOverride = null;
  const diff = await deps.stagedDiff();
  const compacted = compact(diff);

  // Provider selection: the OpenAI-compatible adapter ships today; asking
  // for another provider gets a loud, honest refusal, not a silent
  // fallthrough to the wrong wire format.
  const flags = deps.flags ?? {};
  // One bundle read: provider/baseUrl/model/template in a single config-file
  // pass. resolveKey (per key) stays the granular seam for other callers.
  const bundle = await deps.resolveBundle(flags as Partial<Record<string, string | undefined>>);

  const providerR = bundle.provider;
  if (providerR !== undefined && providerR.value !== "" && providerR.value.toLowerCase() !== "openai") {
    return {
      ok: false,
      exitCode: 2,
      message: `commitshi: provider "${providerR.value}" is not supported — commitshi currently understands only the OpenAI-compatible adapter (OpenAI, Groq, DeepSeek, Ollama at any baseUrl).`,
    };
  }

  // The API key may legitimately be absent for a local OpenAI-compatible
  // endpoint; only a non-local baseUrl demands one. It keeps its own seam —
  // keys never consult git config, unlike the bundle above.
  const apiKeyR = await deps.resolveApiKey("openai");

  const pipeEnv = deps.env ?? process.env;
  const baseUrl = bundle.baseUrl?.value ?? pipeEnv.OPENAI_BASE_URL ?? DEFAULT_BASE_URL;
  const model = bundle.model?.value ?? DEFAULT_MODEL;
  const templateRaw = bundle.template?.value?.trim() ?? "";

  const isLocal = isLocalBaseUrl(baseUrl);
  // Key demand, resolved here once — the check main.ts used to mirror before
  // the staged guard.
  const envKey = pipeEnv.OPENAI_API_KEY;
  const hasKey =
    (apiKeyR !== null && apiKeyR.value !== "") || (envKey !== undefined && envKey !== "");
  if (!isLocal && !hasKey) {
    return { ok: false, exitCode: 1, kind: "missing-key", message: missingKeyMessage("openai") };
  }
  // Never forward a real credential to a local server: local endpoints
  // (Ollama & friends) don't consult it, and a stray OPENAI_API_KEY must not
  // leak to whatever happens to be listening on localhost.
  const apiKey = isLocal ? undefined : apiKeyR?.value;

  const template = templateRaw === "" ? DEFAULT_CONVENTIONAL_TEMPLATE : templateRaw;
  // Fail fast on a malformed template before a single token is spent — the
  // model call is the expensive failure to make loud.
  const templateError = checkTemplate(template);
  if (templateError !== null) {
    return { ok: false, exitCode: 2, message: `commitshi: template is invalid — ${templateError}` };
  }
  // buildPrompt and strictFill share one parse inside the template module;
  // buildPrompt turns the tokens into prose, strictFill re-parses and enforces.
  const system = buildPrompt(template);

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
    {
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      ...(temperatureOverride !== null ? { temperature: temperatureOverride } : { temperature: 0 }),
    },
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
    numstat: compacted.numstat,
    baseUrl,
    model,
  };
}
