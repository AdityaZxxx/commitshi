// The shared transport core behind both provider adapters: one POST, one
// CompletionResult. Everything that is the same across wire formats lives
// here — the timeout/abort ceiling, status classification (rate limit,
// auth, server), failure wording, and the JSON guard. An adapter's job is
// the wire shape only: the URL, the headers, the payload, and where the
// assistant text sits in the reply. One request, one response; no retry
// loop, no failover, no invented output. Timeout and rate-limit fail loud.

export type ChatMessage = Readonly<{ role: "system" | "user"; content: string }>;

/**
 * The fetch seam the transport core uses. Named instead of `typeof fetch` so
 * the contract is exactly what the core calls — a URL plus an init object —
 * and test doubles satisfy it without casting to the runtime's fetch type.
 */
export type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

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

export type TransportDeps = Readonly<{
  fetchFn?: FetchFn; // seam for tests
  timeoutMs?: number; // hard abort; see DEFAULT_TIMEOUT_MS for the value and why
}>;

/**
 * A parsed JSON body: the named domain type the transport core hands to an
 * adapter's extract rule. Schema-free by design — provider JSON is
 * hand-parsed at this boundary with type-guard helpers, never `any`.
 */
export interface JsonBody extends Readonly<Record<string, JsonValue>> {}

/** Any JSON value; the recursive half of the JsonBody contract. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonBody;

/**
 * One wire call, described: everything the endpoint receives, plus the rule
 * for finding the assistant text in a successful reply.
 */
export type WireRequest = Readonly<{
  /** The provider root as named in failure messages (already normalized). */
  base: string;
  /** The full endpoint URL to POST to. */
  url: string;
  /** The wire headers, exactly as the endpoint receives them. */
  headers: Readonly<Record<string, string>>;
  /** The wire body; serialized to JSON by the core. */
  body: unknown;
  /** Pulls the assistant text out of a 200 JSON reply; undefined when absent. */
  extract: (json: JsonBody) => string | undefined;
}>;

// Local OpenAI-compatible servers (Ollama) can take tens of seconds on a
// first request; a 30s ceiling made an otherwise-healthy local draft look
// like an outage. 120s is a hard cap, not a target — the abort still fails
// loud. Both adapters share this ceiling.
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Boundary guard for JSON text fields: the schema-free adapters hand-parse
 * provider JSON, and this predicate is the sanctioned home for the typeof
 * check (no-runtime-typeof allows typeof inside type guards only).
 */
export function isString<T>(value: T): value is T & string {
  return typeof value === "string";
}

/** True when a parsed JSON value is an object — the shape every provider reply must have. */
function isJsonBody<T>(json: T): json is T & JsonBody {
  return json !== null && typeof json === "object" && !Array.isArray(json);
}

/**
 * Performs one POST and turns the outcome into a CompletionResult: network
 * refusal, timeout, an HTTP error, a non-JSON body, and a reply without
 * assistant text are all reported, never thrown. The success path hands the
 * parsed JSON to the request's extract rule and fails loud on an empty
 * result.
 */
export async function postCompletion(
  deps: TransportDeps,
  request: WireRequest,
): Promise<CompletionResult> {
  const fetchFn: FetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { base } = request;

  let response: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    try {
      response = await fetchFn(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
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

  // The boundary decode: a provider reply that is not a JSON object carries
  // no assistant text by construction — the extract rules below only ever
  // see a JsonBody.
  if (!isJsonBody(json)) {
    return {
      ok: false,
      kind: "transport",
      message: `commitshi: ${base} returned no message content to parse`,
    };
  }

  const content = request.extract(json);
  if (content === undefined || content.trim() === "") {
    return {
      ok: false,
      kind: "transport",
      message: `commitshi: ${base} returned no message content to parse`,
    };
  }
  return { ok: true, content };
}
