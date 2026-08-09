import { describe, expect, test } from "bun:test";
import { chatCompletions, type CompletionResult } from "./openai.ts";

/** A programmable fetch seam. */
function fakeFetch(
  impl: (url: string, init: RequestInit) => Promise<Response> | Response,
): { fn: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return impl(String(url), init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const REQ = { model: "m", messages: [{ role: "user" as const, content: "hi" }] };

describe("openai adapter — request shape", () => {
  test("posts to {baseUrl}/chat/completions with the model and messages", async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    const r = await chatCompletions({ baseUrl: "http://x:1/v1", fetchFn: fn }, REQ);
    expect(r).toEqual({ ok: true, content: "ok" });
    expect(calls[0].url).toBe("http://x:1/v1/chat/completions");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe("m");
    expect(body.messages[0].content).toBe("hi");
  });

  test("sends Authorization only when a key is configured", async () => {
    const { fn: withKey, calls: c1 } = fakeFetch(() => jsonResponse({ choices: [{ message: { content: "x" } }] }));
    await chatCompletions({ baseUrl: "http://h/v1", apiKey: "sk-test", fetchFn: withKey }, REQ);
    expect(new Headers(c1[0].init.headers).get("authorization")).toBe("Bearer sk-test");

    const { fn: noKey, calls: c2 } = fakeFetch(() => jsonResponse({ choices: [{ message: { content: "x" } }] }));
    await chatCompletions({ baseUrl: "http://h/v1", fetchFn: noKey }, REQ);
    expect(new Headers(c2[0].init.headers).get("authorization")).toBeNull();
  });

  test("baseUrl is normalized: trailing slashes and a redundant suffix are dropped", async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse({ choices: [{ message: { content: "x" } }] }));
    await chatCompletions({ baseUrl: "http://h/v1///", fetchFn: fn }, REQ);
    expect(calls[0].url).toBe("http://h/v1/chat/completions");
  });
});

describe("openai adapter — failure handling", () => {
  test("429 → rate_limited, loud, no retry", async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse({ error: { message: "slow down" } }, 429));
    const r = await chatCompletions({ baseUrl: "http://h/v1", fetchFn: fn }, REQ);
    expect(r.ok).toBe(false);
    if (!r.ok && "kind" in r) expect(r.kind).toBe("rate_limited");
    expect(calls.length).toBe(1); // single attempt
  });

  test("401 → auth", async () => {
    const { fn } = fakeFetch(() => jsonResponse({ error: { message: "bad key" } }, 401));
    const r = await chatCompletions({ baseUrl: "http://h/v1", fetchFn: fn }, REQ);
    expect(r.ok).toBe(false);
    if (!r.ok && "kind" in r) expect(r.kind).toBe("auth");
  });

  test("500 → server failure, no retry", async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse({ error: { message: "boom" } }, 500));
    const r = await chatCompletions({ baseUrl: "http://h/v1", fetchFn: fn }, REQ);
    expect(r.ok).toBe(false);
    if (!r.ok && "kind" in r) expect(r.kind).toBe("server");
    expect(calls.length).toBe(1);
  });

  test("network refusal → transport failure, never thrown", async () => {
    const { fn } = fakeFetch(() => Promise.reject(new Error("ECONNREFUSED")));
    const r = await chatCompletions({ baseUrl: "http://h/v1", fetchFn: fn }, REQ);
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r as any).message).toContain("could not reach");
  });

  test("abort → timeout failure", async () => {
    const { fn } = fakeFetch(
      () => new Promise<Response>((_res, rej) => setTimeout(() => rej(Object.assign(new Error("aborted"), { name: "AbortError" })), 20)),
    );
    const r = await chatCompletions({ baseUrl: "http://h/v1", fetchFn: fn, timeoutMs: 5 }, REQ);
    expect(r.ok).toBe(false);
    if (!r.ok && "kind" in r) expect(r.kind).toBe("timeout");
  });

  test("HTTP 200 but no message content → transport failure", async () => {
    const { fn } = fakeFetch(() => jsonResponse({ choices: [{ message: {} }] }));
    const r = await chatCompletions({ baseUrl: "http://h/v1", fetchFn: fn }, REQ);
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r as any).message).toContain("no message content");
  });
});

// Opt-in live round trip against a local OpenAI-compatible server (Ollama).
// Not part of the default suite: set COMMITSHI_LIVE_BASE_URL (and optionally
// COMMITSHI_LIVE_MODEL) to run it. This is the "real call" proof for the ticket.
const LIVE_BASE = process.env.COMMITSHI_LIVE_BASE_URL ?? "http://localhost:11434/v1";
const LIVE_MODEL = process.env.COMMITSHI_LIVE_MODEL ?? "gemma3:4b";

describe("openai adapter — live round trip (opt-in)", () => {
  test("real call against a configurable baseUrl returns assistant content", async () => {
    if (process.env.COMMITSHI_LIVE !== "1") {
      console.log("skipped: set COMMITSHI_LIVE=1 to run the live round trip");
      return;
    }
    const r: CompletionResult = await chatCompletions(
      { baseUrl: LIVE_BASE, timeoutMs: 60_000 },
      {
        model: LIVE_MODEL,
        messages: [
          { role: "system", content: "You are concise." },
          { role: "user", content: "Reply with the single word: pong" },
        ],
        temperature: 0,
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content.toLowerCase()).toContain("pong");
  }, 90_000);
});
