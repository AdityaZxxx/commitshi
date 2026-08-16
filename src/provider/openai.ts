// OpenAI-compatible provider adapter: the wire shape for any service
// exposing the chat-completions API — OpenAI itself, Groq, DeepSeek, Ollama —
// at a configurable baseUrl. The HTTP lifecycle (timeout, status
// classification, failure wording, JSON guard) lives in the transport core;
// this adapter owns only the wire format: the endpoint URL, the headers, the
// payload, and where the assistant text sits in the reply.

import {
  isString,
  postCompletion,
  type CompletionRequest,
  type CompletionResult,
  type JsonBody,
  type TransportDeps,
} from "./transport.ts";

// The shared contract types stay exported from here: the pipeline and the
// Anthropic adapter both name the seam through this module.
export type { ChatMessage, CompletionRequest, CompletionResult, FetchFn } from "./transport.ts";

export type ChatDeps = Readonly<
  TransportDeps & {
    baseUrl: string; // provider root, e.g. https://api.openai.com/v1 or http://localhost:11434/v1
    apiKey?: string; // absent → no Authorization header (local endpoints)
  }
>;

/** Strips any trailing slashes and a redundant trailing "/chat/completions". */
function normalizeBaseUrl(baseUrl: string): string {
  let b = baseUrl.trim().replace(/\/+$/, "");
  b = b.replace(/\/chat\/completions$/i, "");
  return b;
}

/** The wire headers the OpenAI-compatible endpoint receives. */
type OpenAiHeaders = {
  "content-type": string;
  authorization?: string;
};

/** The wire body the OpenAI-compatible endpoint receives. */
type OpenAiPayload = {
  model: string;
  messages: CompletionRequest["messages"];
  max_completion_tokens?: number;
  temperature?: number;
};

/** The assistant text in an OpenAI-shaped reply; undefined when absent. */
function extractContent(json: JsonBody): string | undefined {
  // SAFETY: the chat-completions reply is parsed field by field below; the
  // assertion only gives the parsed JSON a readable access path.
  const content = (json as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]
    ?.message?.content;
  return isString(content) ? content : undefined;
}

/**
 * Performs one chat-completion call against the configured baseUrl. The
 * response body is expected to be OpenAI-shaped (`choices[0].message.content`).
 * Network refusal, non-JSON, a missing content field, and an HTTP error are
 * all reported, never thrown.
 */
export async function chatCompletions(
  deps: ChatDeps,
  request: CompletionRequest,
): Promise<CompletionResult> {
  const base = normalizeBaseUrl(deps.baseUrl);

  const headers: OpenAiHeaders = { "content-type": "application/json" };
  if (deps.apiKey !== undefined && deps.apiKey !== "") {
    headers.authorization = `Bearer ${deps.apiKey}`;
  }

  const payload: OpenAiPayload = {
    model: request.model,
    messages: request.messages,
  };
  if (request.maxTokens !== undefined) payload.max_completion_tokens = request.maxTokens;
  if (request.temperature !== undefined) payload.temperature = request.temperature;

  return postCompletion(deps, {
    base,
    url: `${base}/chat/completions`,
    headers,
    body: payload,
    extract: extractContent,
  });
}
