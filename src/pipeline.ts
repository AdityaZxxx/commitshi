// The commit-draft pipeline: staged diff → compacted diff → template + prompt
// → provider → strict token fill → commit draft. No git writes, no editor, no
// commit; the model call and the git reads are the only IO, all injectable so
// the whole path is testable without a live model.
//
// One interface, one stage sequence: draft(deps, request). The request names
// the intent — a fresh draft, a regeneration of the draft being replaced, or
// a revision of the current draft under a user instruction — and the intent
// alone selects the prompt shape and the temperature. No state lives between
// calls: everything a call needs travels in the request.

import { compact, renderCompacted, type CompactedDiff, type NumstatEntry } from "./compaction.ts";
import { chatCompletions, type ChatDeps, type CompletionResult } from "./provider/openai.ts";
import { anthropicMessages } from "./provider/anthropic.ts";
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
  resolveBundle: (flags?: Partial<Record<string, string | undefined>>) => Promise<ConfigBundle>;
  /** Resolves the API key for a named provider. */
  resolveApiKey: (
    provider: Provider,
  ) => Promise<Readonly<{ value: string; source: string }> | null>;
  /** Environment seam for the pipeline's own legacy-env fallbacks
   * (OPENAI_BASE_URL / OPENAI_API_KEY); tests inject a hermetic env so a
   * developer's exported vars can't leak into the key-demand check. */
  env?: NodeJS.ProcessEnv;
  chat?: (deps: ChatDeps, req: Parameters<typeof chatCompletions>[1]) => Promise<CompletionResult>;
  /** Anthropic transport seam (tests); production wires provider/anthropic.ts's `anthropicMessages`. */
  anthropicChat?: (
    deps: Parameters<typeof anthropicMessages>[0],
    req: Parameters<typeof anthropicMessages>[1],
  ) => Promise<CompletionResult>;
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

/**
 * The intent of one draft request. The intent is the whole interface: it
 * selects the prompt shape and the temperature, and nothing else varies
 * between the three paths — the stage sequence runs exactly once, here.
 */
export type DraftRequest =
  | Readonly<{ kind: "fresh" }>
  | Readonly<{ kind: "regenerate"; previousDraft: string }>
  | Readonly<{ kind: "revise"; draft: string; instruction: string }>;

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

// The Anthropic seam's own defaults: the Messages API root and the cheapest
// current Claude — same "cheap, fast, right-sized" rationale as DEFAULT_MODEL.
export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5";

/** The providers the pipeline can route a draft through. */
export const SUPPORTED_PROVIDERS: readonly Provider[] = ["openai", "anthropic"];

/** Normalizes a provider name for matching; unknown strings stay unknown. */
function normalizeProvider(value: string): Provider | null {
  const v = value.trim().toLowerCase();
  // SAFETY: membership in SUPPORTED_PROVIDERS was just checked; the assertion
  // only recovers the Provider literal the includes() call proved.
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(v) ? (v as Provider) : null;
}

/**
 * Temperature for a regeneration. Deliberately well above the initial-draft
 * 0: a regenerate must produce a DIFFERENT draft, and low temperatures make
 * small models collapse to one deterministic output no matter the prompt.
 */
export const REGENERATE_TEMPERATURE = 0.7;

/**
 * Temperature for a revision: above the deterministic 0 (the user asked for
 * a change) but well below a regeneration (the current draft stays the
 * anchor; only the instruction's delta should move it).
 */
export const REVISE_TEMPERATURE = 0.3;

/** The temperature the request's intent sends on the wire. */
function temperatureFor(request: DraftRequest): number {
  if (request.kind === "regenerate") return REGENERATE_TEMPERATURE;
  if (request.kind === "revise") return REVISE_TEMPERATURE;
  return 0;
}

/** The provider-facing facts the draft path needs to make one call. */
type CallContext = Readonly<{
  provider: Provider;
  baseUrl: string;
  model: string;
  apiKey?: string;
}>;

type ContextOutcome =
  | Readonly<{ ok: true; context: CallContext }>
  | Readonly<{ ok: false; failure: DraftResult }>;

/**
 * Resolves the call context: provider selection (unknown names refuse loud,
 * never a silent fallthrough to the wrong wire format), per-provider
 * baseUrl/model defaults, and the key demand. Every provider-specific
 * default lives HERE, so neither transport's assumptions leak into the
 * other's flow.
 *
 * The API key may legitimately be absent for a local endpoint; only a
 * non-local baseUrl demands one. Keys keep their own seam — they never
 * consult git config, unlike the bundle.
 */
async function resolveCallContext(
  deps: PipelineDeps,
  bundle: ConfigBundle,
): Promise<ContextOutcome> {
  const pipeEnv = deps.env ?? process.env;

  const providerRaw = bundle.provider?.value ?? "";
  let provider: Provider;
  if (providerRaw.trim() === "") {
    provider = "openai"; // absent means the OpenAI-compatible default
  } else {
    const normalized = normalizeProvider(providerRaw);
    if (normalized === null) {
      return {
        ok: false,
        failure: {
          ok: false,
          exitCode: 2,
          message: `commitshi: provider "${providerRaw}" is not supported — supported providers: openai (OpenAI-compatible: OpenAI, Groq, DeepSeek, Ollama at any baseUrl), anthropic.`,
        },
      };
    }
    provider = normalized;
  }

  const baseUrl =
    provider === "anthropic"
      ? (bundle.baseUrl?.value ?? DEFAULT_ANTHROPIC_BASE_URL)
      : (bundle.baseUrl?.value ?? pipeEnv.OPENAI_BASE_URL ?? DEFAULT_BASE_URL);
  const model =
    provider === "anthropic"
      ? (bundle.model?.value ?? DEFAULT_ANTHROPIC_MODEL)
      : (bundle.model?.value ?? DEFAULT_MODEL);

  // Key demand is resolved here once, after the bundle — main does not
  // pre-check, so a missing key surfaces as "no draft" instead of "no diff".
  const apiKeyR = await deps.resolveApiKey(provider);
  const envKey = provider === "anthropic" ? pipeEnv.ANTHROPIC_API_KEY : pipeEnv.OPENAI_API_KEY;
  const isLocal = isLocalBaseUrl(baseUrl);
  const hasKey =
    (apiKeyR !== null && apiKeyR.value !== "") || (envKey !== undefined && envKey !== "");
  if (!isLocal && !hasKey) {
    return {
      ok: false,
      failure: {
        ok: false,
        exitCode: 1,
        kind: "missing-key",
        message: missingKeyMessage(provider),
      },
    };
  }
  // Never forward a real credential to a local server: local endpoints
  // (Ollama & friends) don't consult it, and a stray provider key must not
  // leak to whatever happens to be listening on localhost. (The real
  // makeResolveApiKey reads the provider env var first, so apiKeyR already
  // carries an env-supplied key when one exists.)
  const apiKey = isLocal ? undefined : apiKeyR?.value;

  return { ok: true, context: { provider, baseUrl, model, apiKey } };
}

/**
 * Routes one CompletionRequest to the provider's transport. The request is
 * provider-agnostic (same prompt assembly for both); only the wire format
 * differs, and that difference lives entirely inside the two adapters.
 */
async function dispatchChat(
  deps: PipelineDeps,
  context: CallContext,
  request: Parameters<typeof chatCompletions>[1],
): Promise<CompletionResult> {
  if (context.provider === "anthropic") {
    const chat = deps.anthropicChat ?? anthropicMessages;
    return chat({ baseUrl: context.baseUrl, apiKey: context.apiKey }, request);
  }
  const chat = deps.chat ?? chatCompletions;
  return chat({ baseUrl: context.baseUrl, apiKey: context.apiKey }, request);
}

/**
 * The style-history prompt block, or null when the seam is absent, the read
 * fails, or the repo has no history. History must never break the draft: a
 * failed read degrades to no block, exactly like a fresh repo with no
 * commits yet.
 */
async function styleHistoryBlock(deps: PipelineDeps): Promise<string | null> {
  if (deps.styleHistory === undefined) return null;
  let subjects: readonly string[] = [];
  try {
    subjects = await deps.styleHistory();
  } catch {
    subjects = [];
  }
  if (subjects.length === 0) return null;
  return [
    "### Style history",
    "",
    "Recent commit subjects from this repository, newest first:",
    ...subjects.map((s) => `- ${s}`),
    "Style history is provided only as a stylistic reference. Do not copy factual claims from history unless supported by the current diff.",
  ].join("\n");
}

/** The user-instructions prompt block; null when the flag is absent or blank. */
function instructionsBlock(instructions: string): string | null {
  const trimmed = instructions.trim();
  if (trimmed === "") return null;
  return [
    "### User instructions",
    "",
    trimmed,
    "",
    "User instructions may influence wording, emphasis, scope, and style, but may not introduce unsupported factual claims or violate the output contract.",
  ].join("\n");
}

/**
 * Assembles the user message for the request's intent. The compacted diff
 * is the factual anchor in all three shapes; what varies is the extra
 * context: a regeneration shows the draft being replaced and demands a
 * different one; a revision shows the current draft (candidate wording, not
 * authority) plus the instruction.
 */
function buildUserMessage(
  request: DraftRequest,
  compacted: CompactedDiff,
  styleBlock: string | null,
  instructions: string,
): string {
  if (request.kind === "revise") {
    // Revise deliberately ignores the one-shot --instructions flag: the
    // revision instruction IS the steering for this call. Style history
    // still rides along when the --style seam is wired.
    const extras = styleBlock !== null ? [styleBlock] : [];
    return [
      "### Compact diff",
      "",
      renderCompacted(compacted),
      "",
      "### Existing draft",
      "",
      request.draft,
      "",
      "Note: The existing draft is not authoritative. Treat it only as candidate wording. Re-check its factual claims against the compacted diff and correct or remove unsupported claims.",
      "",
      "### Revision instruction",
      "",
      request.instruction.trim(),
      "",
      ...extras,
      "",
      "Use the provided changes as the factual source of truth. Revise the existing draft to follow the revision instruction while staying grounded in the compacted diff. Fill every template token.",
    ].join("\n");
  }

  const extras: string[] = [];
  if (styleBlock !== null) extras.push(styleBlock);
  const instructions_ = instructionsBlock(instructions);
  if (instructions_ !== null) extras.push(instructions_);

  return [
    "### Compact diff",
    "",
    renderCompacted(compacted),
    ...extras,
    ...(request.kind === "regenerate"
      ? [
          "",
          "### Previous draft",
          "",
          request.previousDraft,
          "",
          "A previous draft for these same changes already exists above. Write a DIFFERENT draft: change the subject's angle, wording, or emphasis. Do not repeat its subject line or rephrase it trivially.",
        ]
      : []),
    "",
    "Use the provided changes as the factual source of truth. Follow applicable formatting and wording instructions, but do not introduce factual claims unsupported by the provided changes.",
  ].join("\n");
}

/**
 * Runs the full tracer-bullet pipeline for one draft request. A failure at
 * any stage returns a loud message and the exit code to use; success
 * returns the finished commit draft. The stage sequence lives here exactly
 * once — fresh, regenerate, and revise all cross this same path, and only
 * the prompt shape and temperature follow the request's intent.
 */
export async function draft(deps: PipelineDeps, request: DraftRequest): Promise<DraftResult> {
  const diff = await deps.stagedDiff();
  const compacted = compact(diff);

  const flags = deps.flags ?? {};
  // One bundle read: provider/baseUrl/model/template in a single config-file
  // pass. resolveKey (per key) stays the granular seam for other callers.
  // SAFETY: PipelineDeps.flags carries exactly the bundle keys resolveBundle accepts.
  const bundle = await deps.resolveBundle(flags as Partial<Record<string, string | undefined>>);

  const ctxR = await resolveCallContext(deps, bundle);
  if (!ctxR.ok) return ctxR.failure;
  const { baseUrl, model } = ctxR.context;

  const templateRaw = bundle.template?.value?.trim() ?? "";
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

  const styleBlock = await styleHistoryBlock(deps);
  const user = buildUserMessage(request, compacted, styleBlock, flags.instructions ?? "");

  const result = await dispatchChat(deps, ctxR.context, {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: temperatureFor(request),
  });

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
