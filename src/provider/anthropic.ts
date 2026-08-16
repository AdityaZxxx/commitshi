// Anthropic provider adapter: the wire shape for the Messages API, the
// second transport on the same seam as the OpenAI-compatible one. The HTTP
// lifecycle (timeout, status classification, failure wording, JSON guard)
// lives in the transport core; this adapter owns only the wire format: the
// endpoint URL, the headers, the payload (system hoisted out of `messages`,
// max_tokens always present), and where the assistant text sits in the
// reply. Prompt assembly is shared — the pipeline hands both adapters the
// same CompletionRequest.

import {
  isString,
  postCompletion,
  type CompletionRequest,
  type CompletionResult,
  type JsonBody,
  type TransportDeps,
} from "./transport.ts";

export type AnthropicDeps = Readonly<
  TransportDeps & {
    baseUrl: string; // provider root, e.g. https://api.anthropic.com
    apiKey?: string; // absent → no x-api-key header (the pipeline demands one for non-local URLs)
  }
>;

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

/** A Messages-API text block, validated at the boundary. */
function isTextBlock(b: { type?: string; text?: unknown }): b is { type: "text"; text: string } {
  return b.type === "text" && isString(b.text);
}

/** The assistant text in a Messages-API reply; undefined when absent. */
function extractContent(json: JsonBody): string | undefined {
  // SAFETY: the Messages-API reply is parsed block by block below; the
  // assertion only gives the parsed JSON a readable access path.
  const blocks = (json as { content?: Array<{ type?: string; text?: unknown }> }).content;
  return Array.isArray(blocks)
    ? blocks
        .filter(isTextBlock)
        .map((b) => b.text)
        .join("")
    : undefined;
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
  const base = normalizeBaseUrl(deps.baseUrl);

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

  return postCompletion(deps, {
    base,
    url: `${base}/v1/messages`,
    headers,
    body: payload,
    extract: extractContent,
  });
}
