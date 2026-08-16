import { describe, expect, test } from "bun:test";
import { anthropicMessages, type AnthropicDeps } from "./anthropic.ts";
import type { CompletionResult, FetchFn } from "./openai.ts";

/** A programmable fetch seam. */
function fakeFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn: FetchFn = async (url, init) => {
    const recorded = init ?? {};
    calls.push({ url: String(url), init: recorded });
    return await impl(String(url), recorded);
  };
  return { fn, calls };
}

function jsonResponse<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const REQ = {
  model: "claude-haiku-4-5",
  messages: [
    { role: "system" as const, content: "be brief" },
    { role: "user" as const, content: "hi" },
  ],
};

const OK_BODY = { content: [{ type: "text", text: "ok" }] };

describe("anthropic adapter — request shape", () => {
  test("posts to {baseUrl}/v1/messages with the model and messages", async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse(OK_BODY));
    const r = await anthropicMessages({ baseUrl: "http://x:1", fetchFn: fn }, REQ);
    expect(r).toEqual({ ok: true, content: "ok" });
    expect(calls[0].url).toBe("http://x:1/v1/messages");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe("claude-haiku-4-5");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("the leading system message is hoisted into the top-level system field", async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse(OK_BODY));
    await anthropicMessages({ baseUrl: "http://h", fetchFn: fn }, REQ);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.system).toBe("be brief");
    // The Messages API has no system role inside `messages`.
    expect(body.messages.every((m: { role: string }) => m.role !== "system")).toBe(true);
  });

  test("a request without a system message sends no system field", async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse(OK_BODY));
    await anthropicMessages(
      { baseUrl: "http://h", fetchFn: fn },
      { model: "m", messages: [{ role: "user", content: "hi" }] },
    );
    const body = JSON.parse(String(calls[0].init.body));
    expect("system" in body).toBe(false);
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("sends x-api-key and anthropic-version only as required", async () => {
    const { fn: withKey, calls: c1 } = fakeFetch(() => jsonResponse(OK_BODY));
    await anthropicMessages({ baseUrl: "http://h", apiKey: "sk-ant-test", fetchFn: withKey }, REQ);
    const h1 = new Headers(c1[0].init.headers);
    expect(h1.get("x-api-key")).toBe("sk-ant-test");
    expect(h1.get("anthropic-version")).toBe("2023-06-01");
    expect(h1.get("authorization")).toBeNull(); // never the OpenAI bearer shape

    const { fn: noKey, calls: c2 } = fakeFetch(() => jsonResponse(OK_BODY));
    await anthropicMessages({ baseUrl: "http://h", fetchFn: noKey }, REQ);
    expect(new Headers(c2[0].init.headers).get("x-api-key")).toBeNull();
  });

  test("max_tokens is always present (required by the Messages API); temperature passes through", async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse(OK_BODY));
    await anthropicMessages({ baseUrl: "http://h", fetchFn: fn }, { ...REQ, temperature: 0 });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.max_tokens).toEqual(expect.any(Number));
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.temperature).toBe(0);
  });

  test("an explicit maxTokens wins over the default", async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse(OK_BODY));
    await anthropicMessages({ baseUrl: "http://h", fetchFn: fn }, { ...REQ, maxTokens: 512 });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.max_tokens).toBe(512);
  });

  test("baseUrl is normalized: trailing slashes and a redundant suffix are dropped", async () => {
    const { fn: f1, calls: c1 } = fakeFetch(() => jsonResponse(OK_BODY));
    await anthropicMessages({ baseUrl: "http://h///", fetchFn: f1 }, REQ);
    expect(c1[0].url).toBe("http://h/v1/messages");

    const { fn: f2, calls: c2 } = fakeFetch(() => jsonResponse(OK_BODY));
    await anthropicMessages({ baseUrl: "http://h/v1/messages/", fetchFn: f2 }, REQ);
    expect(c2[0].url).toBe("http://h/v1/messages");
  });

  test("multiple text blocks are concatenated in order", async () => {
    const { fn } = fakeFetch(() =>
      jsonResponse({
        content: [
          { type: "text", text: "line1\n" },
          { type: "text", text: "line2" },
        ],
      }),
    );
    const r = await anthropicMessages({ baseUrl: "http://h", fetchFn: fn }, REQ);
    expect(r).toEqual({ ok: true, content: "line1\nline2" });
  });
});

describe("anthropic adapter — failure handling (same semantics as the OpenAI adapter)", () => {
  test("429 → rate_limited, loud, no retry", async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse({ error: { message: "slow down" } }, 429));
    const r = await anthropicMessages({ baseUrl: "http://h", fetchFn: fn }, REQ);
    expect(r.ok).toBe(false);
    if (!r.ok && "kind" in r) expect(r.kind).toBe("rate_limited");
    expect(calls.length).toBe(1); // single attempt
  });

  test("401 → auth", async () => {
    const { fn } = fakeFetch(() => jsonResponse({ error: { message: "invalid x-api-key" } }, 401));
    const r = await anthropicMessages({ baseUrl: "http://h", fetchFn: fn }, REQ);
    expect(r.ok).toBe(false);
    if (!r.ok && "kind" in r) expect(r.kind).toBe("auth");
    if (!r.ok && "message" in r) expect(r.message).toContain("invalid x-api-key");
  });

  test("500 → server failure, no retry", async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse({ error: { message: "boom" } }, 500));
    const r = await anthropicMessages({ baseUrl: "http://h", fetchFn: fn }, REQ);
    expect(r.ok).toBe(false);
    if (!r.ok && "kind" in r) expect(r.kind).toBe("server");
    expect(calls.length).toBe(1);
  });

  test("network refusal → transport failure, never thrown", async () => {
    const { fn } = fakeFetch(() => Promise.reject(new Error("ECONNREFUSED")));
    const r = await anthropicMessages({ baseUrl: "http://h", fetchFn: fn }, REQ);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // SAFETY: every failure variant of CompletionResult carries a message.
      expect((r as { message: string }).message).toContain("could not reach");
    }
  });

  test("abort → timeout failure", async () => {
    const { fn } = fakeFetch(
      () =>
        new Promise<Response>((_res, rej) =>
          setTimeout(() => rej(Object.assign(new Error("aborted"), { name: "AbortError" })), 20),
        ),
    );
    const r = await anthropicMessages({ baseUrl: "http://h", fetchFn: fn, timeoutMs: 5 }, REQ);
    expect(r.ok).toBe(false);
    if (!r.ok && "kind" in r) expect(r.kind).toBe("timeout");
  });

  test("HTTP 200 but no text content → transport failure", async () => {
    const { fn } = fakeFetch(() => jsonResponse({ content: [] }));
    const r = await anthropicMessages({ baseUrl: "http://h", fetchFn: fn }, REQ);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // SAFETY: every failure variant of CompletionResult carries a message.
      expect((r as { message: string }).message).toContain("no message content");
    }
  });

  test("non-JSON 200 → transport failure", async () => {
    const { fn } = fakeFetch(() => new Response("not json", { status: 200 }));
    const r = await anthropicMessages({ baseUrl: "http://h", fetchFn: fn }, REQ);
    expect(r.ok).toBe(false);
    if (!r.ok && "kind" in r) expect(r.kind).toBe("transport");
  });
});

// Opt-in live round trip against the real Anthropic API. Not part of the
// default suite: set COMMITSHI_LIVE=1 and ANTHROPIC_API_KEY to run it.
const LIVE_BASE = process.env.COMMITSHI_LIVE_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
const LIVE_MODEL = process.env.COMMITSHI_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-4-5";

describe("anthropic adapter — live round trip (opt-in)", () => {
  test("real call returns assistant content", async () => {
    const key = process.env.ANTHROPIC_API_KEY;
    if (process.env.COMMITSHI_LIVE !== "1" || key === undefined || key === "") {
      console.log("skipped: set COMMITSHI_LIVE=1 and ANTHROPIC_API_KEY to run the live round trip");
      return;
    }
    const deps: AnthropicDeps = { baseUrl: LIVE_BASE, apiKey: key, timeoutMs: 60_000 };
    const r: CompletionResult = await anthropicMessages(deps, {
      model: LIVE_MODEL,
      messages: [
        { role: "system", content: "You are concise." },
        { role: "user", content: "Reply with the single word: pong" },
      ],
      temperature: 0,
      maxTokens: 64,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content.toLowerCase()).toContain("pong");
  }, 90_000);
});
