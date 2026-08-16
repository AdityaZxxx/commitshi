// OpenAI-compatible provider adapter: the seam that talks to any service
// exposing the chat-completions API — OpenAI itself, Groq, DeepSeek, Ollama —
// at a configurable baseUrl. One request, one response; no retry loop, no
// failover, no invented output. Timeout and rate-limit fail loud.

export type ChatMessage = Readonly<{ role: "system" | "user"; content: string }>;

/**
 * The fetch seam both adapters share. Named instead of `typeof fetch` so the
 * contract is exactly what the adapters call — a URL plus an init object —
 * and test doubles satisfy it without casting to the runtime's fetch type.
 */
export type FetchFn = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type CompletionRequest = Readonly<{
  model: string;
  messages: readonly ChatMessage[];
  maxTokens?: number;
  temperature?: number;
}>;

/**
 * The discriminated result the pipeline consumes. Union tags let the caller
 * map failures to exit codes and messages without parsing strings.
 */
export type CompletionResult =
  | Readonly<{ ok: true; content: string }>
  | Readonly<{ ok: false; kind: "timeout"; message: string }>
  | Readonly<{
      ok: false;
      kind: "rate_limited" | "auth" | "server";
      status: number;
      message: string;
    }>
  | Readonly<{ ok: false; kind: "transport"; message: string }>;

export type ChatDeps = Readonly<{
  baseUrl: string; // provider root, e.g. https://api.openai.com/v1 or http://localhost:11434/v1
  apiKey?: string; // absent → no Authorization header (local endpoints)
  fetchFn?: FetchFn; // seam for tests
  timeoutMs?: number; // hard abort; see DEFAULT_TIMEOUT_MS for the value and why
}>;

// Local OpenAI-compatible servers (Ollama) can take tens of seconds on a
// first request; a 30s ceiling made an otherwise-healthy local draft look like
// an outage. 120s is a hard cap, not a target — the abort still fails loud.
const DEFAULT_TIMEOUT_MS = 120_000;

/** Strips any trailing slashes and a redundant trailing "/chat/completions". */
function normalizeBaseUrl(baseUrl: string): string {
  let b = baseUrl.trim().replace(/\/+$/, "");
  b = b.replace(/\/chat\/completions$/i, "");
  return b;
}

/**
 * Boundary guard for JSON text fields: the schema-free adapters hand-parse
 * provider JSON, and this predicate is the sanctioned home for the typeof
 * check (no-runtime-typeof allows typeof inside type guards only).
 */
export function isString<T>(value: T): value is T & string {
  return typeof value === "string";
}

/** The wire headers the OpenAI-compatible endpoint receives. */
type OpenAiHeaders = {
  "content-type": string;
  authorization?: string;
};

/** The wire body the OpenAI-compatible endpoint receives. */
type OpenAiPayload = {
  model: string;
  messages: readonly ChatMessage[];
  max_completion_tokens?: number;
  temperature?: number;
};

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
  const fetchFn: FetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = normalizeBaseUrl(deps.baseUrl);
  const url = `${base}/chat/completions`;

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

  // SAFETY: the chat-completions reply is parsed field by field below; the
  // assertion only gives the unknown JSON a readable access path.
  const content = (json as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]
    ?.message?.content;
  if (!isString(content) || content.trim() === "") {
    return {
      ok: false,
      kind: "transport",
      message: `commitshi: ${base} returned no message content to parse`,
    };
  }
  return { ok: true, content };
}
