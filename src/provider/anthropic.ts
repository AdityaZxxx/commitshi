// Anthropic provider adapter: the second transport on the same seam as the
// OpenAI-compatible one (ticket 06). Prompt assembly is shared — the pipeline
// hands both adapters the same CompletionRequest; only the wire format
// differs. One request, one response; no retry loop, no failover, no invented
// output. Timeout and rate-limit fail loud, with the same CompletionResult
// union the OpenAI adapter returns.

import type { CompletionRequest, CompletionResult, FetchFn } from "./openai.ts";
import { isString } from "./openai.ts";

/** A Messages-API text block, validated at the boundary. */
function isTextBlock(b: { type?: string; text?: unknown }): b is { type: "text"; text: string } {
  return b.type === "text" && isString(b.text);
}

export type AnthropicDeps = Readonly<{
  baseUrl: string; // provider root, e.g. https://api.anthropic.com
  apiKey?: string; // absent → no x-api-key header (the pipeline demands one for non-local URLs)
  fetchFn?: FetchFn; // seam for tests
  timeoutMs?: number; // hard abort; see DEFAULT_TIMEOUT_MS for the value and why
}>;

// Same ceiling as the OpenAI-compatible adapter: a hard cap, not a target —
// the abort still fails loud.
const DEFAULT_TIMEOUT_MS = 120_000;

// The Messages API requires max_tokens. The pipeline never sets a cap today;
// 1024 is right-sized for a ~600-token commit subject and bounds the spend.
const DEFAULT_MAX_TOKENS = 1024;

// Pinned to the current API version; Anthropic serves this header verbatim
// and does not silently upgrade a pinned request to a newer shape.
const ANTHROPIC_VERSION = "2023-06-01";

/** Strips any trailing slashes and a redundant trailing "/v1/messages". */
function normalizeBaseUrl(baseUrl: string): string {
  let b = baseUrl.trim().replace(/\/+$/, "");
  b = b.replace(/\/v1\/messages$/i, "");
  return b;
}

/** The wire headers the Messages API receives. */
type AnthropicHeaders = {
  "content-type": string;
  "anthropic-version": string;
  "x-api-key"?: string;
};

/** The wire body the Messages API receives. */
type AnthropicPayload = {
  model: string;
  system?: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens: number;
  temperature?: number;
};

/**
 * Performs one Messages-API call against the configured baseUrl. The request
 * is the same CompletionRequest the OpenAI adapter consumes: the leading
 * system message becomes the top-level `system` field, the rest become
 * `messages`. The response body is expected to be Anthropic-shaped
 * (`content[].text`); network refusal, non-JSON, a missing text block, and an
 * HTTP error are all reported, never thrown.
 */
export async function anthropicMessages(
  deps: AnthropicDeps,
  request: CompletionRequest,
): Promise<CompletionResult> {
  const fetchFn: FetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = normalizeBaseUrl(deps.baseUrl);
  const url = `${base}/v1/messages`;

  const headers: AnthropicHeaders = {
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
  };
  if (deps.apiKey !== undefined && deps.apiKey !== "") {
    headers["x-api-key"] = deps.apiKey;
  }

  // The Messages API has no system role in `messages`: a leading system
  // message is hoisted into the top-level `system` field.
  const system = request.messages[0]?.role === "system" ? request.messages[0].content : undefined;
  const messages = (system !== undefined ? request.messages.slice(1) : request.messages).map(
    (m) => ({
      role: m.role,
      content: m.content,
    }),
  );

  const payload: AnthropicPayload = {
    model: request.model,
    messages,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
  if (system !== undefined) payload.system = system;
  if (request.temperature !== undefined) payload.temperature = request.temperature;

  let response: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    try {
      response = await fetchFn(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (cause) {
    // SAFETY: fetch rejects with an Error; the timeout abort carries the
    // AbortError name or the "timeout" cause set on the controller above.
    const err = cause as Error;
    // SAFETY: the timeout path sets controller.abort(new Error("timeout")).
    if (err.name === "AbortError" || (err.cause as Error | undefined)?.message === "timeout") {
      return {
        ok: false,
        kind: "timeout",
        message: `commitshi: request to ${base} timed out after ${Math.round(timeoutMs / 1000)}s; no draft was made`,
      };
    }
    return {
      ok: false,
      kind: "transport",
      message: `commitshi: could not reach ${base} (${err.message})`,
    };
  }

  if (!response.ok) {
    const status = response.status;
    let detail = "";
    try {
      // SAFETY: provider error bodies are JSON objects; anything else falls to the catch below.
      const errBody = (await response.json()) as { error?: { message?: string } };
      detail = errBody.error?.message ?? "";
    } catch {
      detail = response.statusText ?? "";
    }
    const what =
      status === 429 ? "rate_limited" : status === 401 || status === 403 ? "auth" : "server";
    const label =
      status === 429
        ? "rate limited"
        : status === 401 || status === 403
          ? "authentication rejected"
          : `HTTP ${status}`;
    return {
      ok: false,
      kind: what,
      status,
      message: `commitshi: provider returned ${label}${detail ? `: ${detail}` : ""}`,
    };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return {
      ok: false,
      kind: "transport",
      message: `commitshi: ${base} returned a non-JSON response`,
    };
  }

  // SAFETY: the Messages-API reply is parsed block by block below; the
  // assertion only gives the unknown JSON a readable access path.
  const blocks = (json as { content?: Array<{ type?: string; text?: unknown }> }).content;
  const content = Array.isArray(blocks)
    ? blocks
        .filter(isTextBlock)
        .map((b) => b.text)
        .join("")
    : undefined;
  if (content === undefined || content.trim() === "") {
    return {
      ok: false,
      kind: "transport",
      message: `commitshi: ${base} returned no message content to parse`,
    };
  }
  return { ok: true, content };
}
