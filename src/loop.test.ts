import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { interactLoop, readLine, type AskKey, type DraftAttempt, type LoopDeps } from "./loop.ts";

/** Strips ANSI SGR escapes so assertions match on visible text, not codes. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function capture() {
  let buf = "";
  return {
    stream: {
      write(chunk: string | Uint8Array): boolean {
        buf += chunk.toString();
        return true;
      },
    },
    text: () => buf,
    /** Visible text with ANSI escapes removed. */
    visible: () => stripAnsi(buf),
  };
}

/** One scripted keypress per prompt call, in order, then EOF. */
function scriptedAsk(answers: readonly (string | null)[]): AskKey {
  let i = 0;
  return async () => (i < answers.length ? answers[i++] : null);
}

function makeDeps(answers: readonly (string | null)[], extra: Partial<LoopDeps> = {}) {
  const stdout = capture();
  const stderr = capture();
  const deps: LoopDeps = {
    stdin: new PassThrough(),
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    ask: scriptedAsk(answers),
    regenerate: async () => ({ ok: true, draft: "regen", truncated: false, numstat: [] }),
    ...extra,
  };
  return { deps, stdout, stderr };
}

const good: DraftAttempt = {
  ok: true,
  draft: "feat(a): do the thing",
  truncated: false,
  numstat: [{ path: "a.ts", added: 2, removed: 0, binary: false }],
};

describe("interactLoop", () => {
  test("non-TTY stdin fails loud, never a silent accept", async () => {
    const stdout = capture();
    const { deps } = makeDeps([], { stdinIsTTY: false, stdoutIsTTY: true });
    const result = await interactLoop(good, { ...deps, stdout: stdout.stream });
    expect(result).toEqual({
      ok: false,
      exitCode: 1,
      message: expect.stringContaining("interactive terminal"),
    });
    expect(stdout.text()).toBe("");
  });

  test("non-TTY stdout fails loud the same way", async () => {
    const { deps } = makeDeps([], { stdinIsTTY: true, stdoutIsTTY: false });
    const result = await interactLoop(good, deps);
    if (result.ok) throw new Error("expected a loud refusal");
    expect(result.message).toContain("interactive terminal");
    expect(result.exitCode).toBe(1);
  });

  test("Enter accepts the draft and proceeds to the next stage", async () => {
    const { deps, stdout } = makeDeps([""]);
    const result = await interactLoop(good, deps);
    expect(result).toEqual({
      ok: true,
      action: "accepted",
      draft: "feat(a): do the thing",
      regenerations: 0,
    });
    expect(stdout.text()).toContain("feat(a): do the thing");
  });

  test("a truncated draft renders the (truncated) badge in the staged-changes label, not a prose note", async () => {
    const first: DraftAttempt = { ok: true, draft: "feat(a): big", truncated: true, numstat: [] };
    const { deps, stdout, stderr } = makeDeps([""]);
    const result = await interactLoop(first, deps);
    expect(result.ok).toBe(true);
    expect(stdout.visible()).toContain("STAGED CHANGES (truncated)");
    // The standalone prose note was lifted into the label; it must not reappear.
    expect(stdout.text()).not.toContain("truncated digest");
    expect(stderr.text()).toBe("");
  });

  test("e opens $EDITOR and the edited message becomes the new draft", async () => {
    const edited = "fix(b): hand-edited subject\n\nbody from the editor";
    const spawn = async (_editor: string, path: string) => {
      await Bun.write(path, `${edited}\n`);
      return 0;
    };
    const { deps } = makeDeps(["e", ""], { spawn, env: { EDITOR: "fake-editor" } });
    const result = await interactLoop(good, deps);
    expect(result).toEqual({ ok: true, action: "accepted", draft: edited, regenerations: 0 });
  });

  test("e with no $EDITOR fails loud, never a silent accept", async () => {
    const { deps } = makeDeps(["e"], { env: { EDITOR: "" } });
    const result = await interactLoop(good, deps);
    expect(result).toEqual({
      ok: false,
      exitCode: 1,
      message: expect.stringContaining("$EDITOR is not set"),
    });
  });

  test("a failing editor aborts loud, draft unchanged and not accepted", async () => {
    const spawn = async () => 1;
    const { deps } = makeDeps(["e"], { spawn, env: { EDITOR: "broken-editor" } });
    const result = await interactLoop(good, deps);
    expect(result).toEqual({
      ok: false,
      exitCode: 1,
      message: expect.stringContaining("exited with code 1"),
    });
  });

  test("an editor that leaves the draft empty fails loud, nothing accepted", async () => {
    const spawn = async (_editor: string, path: string) => {
      await Bun.write(path, "\n\n");
      return 0;
    };
    const { deps } = makeDeps(["e"], { spawn, env: { EDITOR: "wiping-editor" } });
    const result = await interactLoop(good, deps);
    expect(result).toEqual({ ok: false, exitCode: 1, message: expect.stringContaining("empty") });
  });

  test("r regenerates a fresh draft for the same diff; Enter takes the fresh one", async () => {
    let calls = 0;
    const regenerate = async (): Promise<DraftAttempt> => {
      calls++;
      return { ok: true, draft: `feat(a): fresh #${calls}`, truncated: false, numstat: [] };
    };
    const { deps, stdout } = makeDeps(["r", ""], { regenerate });
    const result = await interactLoop(good, deps);
    expect(result).toEqual({
      ok: true,
      action: "accepted",
      draft: "feat(a): fresh #1",
      regenerations: 1,
    });
    expect(calls).toBe(1);
    expect(stdout.text()).toContain("fresh #1");
  });

  test("regenerate receives the draft being replaced", async () => {
    let received: string | undefined;
    const regenerate = async (previousDraft: string): Promise<DraftAttempt> => {
      received = previousDraft;
      return { ok: true, draft: "feat(a): fresh", truncated: false, numstat: [] };
    };
    const { deps } = makeDeps(["r", ""], { regenerate });
    await interactLoop(good, deps);
    expect(received).toBe("feat(a): do the thing");
  });

  test("a failed regeneration ends the loop loud, no draft accepted", async () => {
    const regenerate = async (): Promise<DraftAttempt> => ({
      ok: false,
      exitCode: 3,
      message: "commitshi: rate limited — wait and re-run",
    });
    const { deps } = makeDeps(["r"], { regenerate });
    const result = await interactLoop(good, deps);
    expect(result).toEqual({
      ok: false,
      exitCode: 1,
      message: expect.stringContaining("rate limited"),
    });
  });

  test("q cancels the loop — nothing proceeds, exit 0 at the caller", async () => {
    const { deps } = makeDeps(["q"]);
    const result = await interactLoop(good, deps);
    expect(result).toEqual({
      ok: true,
      action: "cancel",
      draft: "feat(a): do the thing",
      regenerations: 0,
    });
  });

  test("edit then regenerate replaces the edits; accept takes the fresh draft", async () => {
    const spawn = async (_editor: string, path: string) => {
      await Bun.write(path, "docs(c): my edit\n");
      return 0;
    };
    const regenerate = async (): Promise<DraftAttempt> => ({
      ok: true,
      draft: "feat(a): after edit",
      truncated: false,
      numstat: [],
    });
    const { deps } = makeDeps(["e", "r", ""], { spawn, env: { EDITOR: "ed" }, regenerate });
    const result = await interactLoop(good, deps);
    expect(result).toEqual({
      ok: true,
      action: "accepted",
      draft: "feat(a): after edit",
      regenerations: 1,
    });
  });

  test("an unrecognized key gets a quiet named re-prompt, Enter still accepts", async () => {
    const { deps, stdout } = makeDeps(["x", ""]);
    const result = await interactLoop(good, deps);
    expect(result).toEqual({
      ok: true,
      action: "accepted",
      draft: "feat(a): do the thing",
      regenerations: 0,
    });
    expect(stdout.text()).toContain("unknown key");
    expect(stdout.text()).toContain("press Enter to accept");
  });

  test("EOF on the key source aborts loud, no silent accept", async () => {
    const { deps } = makeDeps([null]);
    const result = await interactLoop(good, deps);
    expect(result).toEqual({
      ok: false,
      exitCode: 1,
      message: expect.stringContaining("input closed"),
    });
  });

  // ── Ticket 13: draft presentation ────────────────────────────────────
  // Color is forced off for these seam tests via colorEnabled: false so the
  // assertions hold whether or not the runner's env sets NO_COLOR / CI. The
  // stripAnsi `visible()` view pins visible text, never exact escape codes.

  test("interactive output is framed in ordered sections with the staged numstat", async () => {
    const { deps, stdout } = makeDeps([""], { colorEnabled: false });
    const result = await interactLoop(good, deps);
    expect(result.ok).toBe(true);
    const v = stdout.visible();
    expect(v).toContain("STAGED CHANGES");
    expect(v).toContain("DRAFT 1");
    expect(v).toContain("a.ts");
    expect(v).toContain("+2 -0");
    // Order: staged changes → draft → prompt, each first-appearance ordered.
    expect(v.indexOf("STAGED CHANGES")).toBeLessThan(v.indexOf("DRAFT 1"));
    expect(v.indexOf("DRAFT 1")).toBeLessThan(v.indexOf("[Enter] accept"));
  });

  test("r increments the draft counter; the draft label advances", async () => {
    const fresh: DraftAttempt = {
      ok: true,
      draft: "feat(a): fresh",
      truncated: false,
      numstat: [],
    };
    const regenerate = async (): Promise<DraftAttempt> => fresh;
    const { deps, stdout } = makeDeps(["r", ""], { regenerate, colorEnabled: false });
    const result = await interactLoop(good, deps);
    expect(result.ok).toBe(true);
    const v = stdout.visible();
    expect(v).toContain("DRAFT 1");
    expect(v).toContain("DRAFT 2");
  });

  test("e adds an (edited) badge without incrementing the draft number", async () => {
    const editResult = "fix(b): hand-edited";
    const spawn = async (_e: string, path: string) => {
      await Bun.write(path, `${editResult}\n`);
      return 0;
    };
    const { deps, stdout } = makeDeps(["e", ""], {
      spawn,
      env: { EDITOR: "fake" },
      colorEnabled: false,
    });
    const result = await interactLoop(good, deps);
    expect(result.ok).toBe(true);
    const v = stdout.visible();
    expect(v).toContain("DRAFT 1 (edited)");
    expect(v).not.toContain("DRAFT 2");
  });

  test("color enabled on a TTY frames the subject in accent ANSI escapes", async () => {
    const { deps, stdout } = makeDeps([""], { colorEnabled: true });
    const result = await interactLoop(good, deps);
    expect(result.ok).toBe(true);
    // The subject line is wrapped in an SGR escape; the prompt stays unwrapped.
    expect(stdout.text()).toMatch(/\x1b\[38;[^m]*mfeat\(a\): do the thing\x1b\[0m/);
    // Prompt is muted, not accent — ensure accent color is not applied to the prompt
    expect(stdout.text()).not.toMatch(/\x1b\[38;2;38;153;74m\[Enter\]/);
    expect(stdout.text()).not.toMatch(/\x1b\[38;5;35m\[Enter\]/);
  });

  test("p reads an instruction and revise produces the new draft", async () => {
    let received: { draft: string; instruction: string } | undefined;
    const revise = async (draft: string, instruction: string): Promise<DraftAttempt> => {
      received = { draft, instruction };
      return { ok: true, draft: "feat(a): shorter", truncated: false, numstat: [] };
    };
    const { deps, stdout } = makeDeps(["p", "shorter", "\r", ""], { revise });
    const result = await interactLoop(good, deps);
    expect(result).toEqual({
      ok: true,
      action: "accepted",
      draft: "feat(a): shorter",
      regenerations: 0,
    });
    expect(received).toEqual({ draft: "feat(a): do the thing", instruction: "shorter" });
    expect(stdout.visible()).toContain("Revision instruction: shorter");
  });

  test("p with escape cancels the revision — draft unchanged, no flicker re-render", async () => {
    const revise = async (): Promise<DraftAttempt> => {
      throw new Error("revise must not run on cancel");
    };
    const { deps, stdout } = makeDeps(["p", "par", "\x1b", ""], { revise });
    const result = await interactLoop(good, deps);
    expect(result).toEqual({
      ok: true,
      action: "accepted",
      draft: "feat(a): do the thing",
      regenerations: 0,
    });
    // The echoed partial line is erased, and the frame is NOT re-rendered
    // after cancel (single DRAFT 1 header in the whole transcript).
    const v = stdout.visible();
    expect(v).toContain("Revision instruction: par");
    expect(v.match(/DRAFT 1/g)).toHaveLength(1);
  });

  test("EOF while reading the revision instruction fails loud", async () => {
    const revise = async (): Promise<DraftAttempt> => {
      throw new Error("revise must not run on EOF");
    };
    const { deps } = makeDeps(["p", null], { revise });
    const result = await interactLoop(good, deps);
    expect(result).toEqual({
      ok: false,
      exitCode: 1,
      message: expect.stringContaining("input closed"),
    });
  });
});

describe("readLine", () => {
  test("re-assembles chunked input, echoes, and stops at Enter", async () => {
    const written: string[] = [];
    const ask = scriptedAsk(["sho", "r", "t", "\r"]);
    const result = await readLine(ask, (s) => written.push(s));
    expect(result).toEqual({ kind: "ok", line: "short" });
    expect(written.join("")).toBe("short\n");
  });

  test("backspace deletes the last echoed character; nothing to delete is a no-op", async () => {
    const written: string[] = [];
    const ask = scriptedAsk(["\x7f", "ab", "\b", "\r"]);
    const result = await readLine(ask, (s) => written.push(s));
    expect(result).toEqual({ kind: "ok", line: "a" });
    expect(written.join("")).toBe("ab\b \b\n");
  });

  test("Ctrl-C maps to interrupted, echoed without a trailing newline", async () => {
    // Escape and EOF are covered by the loop-level integration tests; the
    // interrupted mapping is only observable here (the loop self-raises on it).
    const written: string[] = [];
    const result = await readLine(scriptedAsk(["par", "\x03"]), (s) => written.push(s));
    expect(result).toEqual({ kind: "interrupted" });
    expect(written.join("")).toBe("par");
  });
});
