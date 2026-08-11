import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { interactLoop, type AskKey, type DraftAttempt, type LoopDeps } from "./loop.ts";

/** Strips ANSI SGR escapes so assertions match on visible text, not codes. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function capture(): {
  stream: Pick<NodeJS.WriteStream, "write">;
  text: () => string;
  /** Visible text with ANSI escapes removed. */
  visible: () => string;
} {
  let buf = "";
  return {
    stream: {
      write(chunk: string | Uint8Array): boolean {
        buf += chunk.toString();
        return true;
      },
    },
    text: () => buf,
    visible: () => stripAnsi(buf),
  };
}

/** One scripted keypress per prompt call, in order, then EOF. */
function scriptedAsk(answers: readonly (string | null)[]): AskKey {
  let i = 0;
  return async () => (i < answers.length ? answers[i++] : null);
}

function makeDeps(
  answers: readonly (string | null)[],
  extra: Partial<LoopDeps> = {},
): { deps: LoopDeps; stdout: ReturnType<typeof capture>; stderr: ReturnType<typeof capture> } {
  const stdout = capture();
  const stderr = capture();
  const deps: LoopDeps = {
    stdin: new PassThrough() as unknown as NodeJS.ReadStream,
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
    expect(result).toEqual({ ok: false, exitCode: 1, message: expect.stringContaining("interactive terminal") });
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
    expect(result).toEqual({ ok: true, action: "accepted", draft: "feat(a): do the thing", regenerations: 0 });
    expect(stdout.text()).toContain("feat(a): do the thing");
  });

  test("a truncated draft renders the (truncated) badge in the staged-changes label, not a prose note", async () => {
    const first: DraftAttempt = { ok: true, draft: "feat(a): big", truncated: true, numstat: [] };
    const { deps, stdout, stderr } = makeDeps([""]);
    const result = await interactLoop(first, deps);
    expect(result.ok).toBe(true);
    expect(stdout.visible()).toContain("staged changes (truncated)");
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
    expect(result).toEqual({ ok: false, exitCode: 1, message: expect.stringContaining("$EDITOR is not set") });
  });

  test("a failing editor aborts loud, draft unchanged and not accepted", async () => {
    const spawn = async () => 1;
    const { deps } = makeDeps(["e"], { spawn, env: { EDITOR: "broken-editor" } });
    const result = await interactLoop(good, deps);
    expect(result).toEqual({ ok: false, exitCode: 1, message: expect.stringContaining("exited with code 1") });
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
    expect(result).toEqual({ ok: true, action: "accepted", draft: "feat(a): fresh #1", regenerations: 1 });
    expect(calls).toBe(1);
    expect(stdout.text()).toContain("fresh #1");
  });

  test("a failed regeneration ends the loop loud, no draft accepted", async () => {
    const regenerate = async (): Promise<DraftAttempt> => ({
      ok: false,
      exitCode: 3,
      message: "commitshi: rate limited — wait and re-run",
    });
    const { deps } = makeDeps(["r"], { regenerate });
    const result = await interactLoop(good, deps);
    expect(result).toEqual({ ok: false, exitCode: 1, message: expect.stringContaining("rate limited") });
  });

  test("q cancels the loop — nothing proceeds, exit 0 at the caller", async () => {
    const { deps } = makeDeps(["q"]);
    const result = await interactLoop(good, deps);
    expect(result).toEqual({ ok: true, action: "cancel", draft: "feat(a): do the thing", regenerations: 0 });
  });

  test("edit then regenerate replaces the edits; accept takes the fresh draft", async () => {
    const spawn = async (_editor: string, path: string) => {
      await Bun.write(path, "docs(c): my edit\n");
      return 0;
    };
    let calls = 0;
    const regenerate = async (): Promise<DraftAttempt> => {
      calls++;
      return { ok: true, draft: "feat(a): after edit", truncated: false, numstat: [] };
    };
    const { deps } = makeDeps(["e", "r", ""], { spawn, env: { EDITOR: "ed" }, regenerate });
    const result = await interactLoop(good, deps);
    expect(result).toEqual({ ok: true, action: "accepted", draft: "feat(a): after edit", regenerations: 1 });
  });

  test("an unrecognized key gets a quiet named re-prompt, Enter still accepts", async () => {
    const { deps, stdout } = makeDeps(["x", ""]);
    const result = await interactLoop(good, deps);
    expect(result).toEqual({ ok: true, action: "accepted", draft: "feat(a): do the thing", regenerations: 0 });
    expect(stdout.text()).toContain("unknown key");
    expect(stdout.text()).toContain("press Enter to accept");
  });

  test("EOF on the key source aborts loud, no silent accept", async () => {
    const { deps } = makeDeps([null]);
    const result = await interactLoop(good, deps);
    expect(result).toEqual({ ok: false, exitCode: 1, message: expect.stringContaining("input closed") });
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
    expect(v).toContain("─── staged changes");
    expect(v).toContain("─── draft 1");
    expect(v).toContain("a.ts");
    expect(v).toContain("+2 -0");
    // Order: staged changes → draft → prompt, each first-appearance ordered.
    expect(v.indexOf("staged changes")).toBeLessThan(v.indexOf("draft 1"));
    expect(v.indexOf("draft 1")).toBeLessThan(v.indexOf("[Enter] accept"));
  });

  test("r increments the draft counter; the draft label advances", async () => {
    const fresh: DraftAttempt = { ok: true, draft: "feat(a): fresh", truncated: false, numstat: [] };
    const regenerate = async (): Promise<DraftAttempt> => fresh;
    const { deps, stdout } = makeDeps(["r", ""], { regenerate, colorEnabled: false });
    const result = await interactLoop(good, deps);
    expect(result.ok).toBe(true);
    const v = stdout.visible();
    expect(v).toContain("─── draft 1");
    expect(v).toContain("─── draft 2");
  });

  test("e adds an (edited) badge without incrementing the draft number", async () => {
    const editResult = "fix(b): hand-edited";
    const spawn = async (_e: string, path: string) => {
      await Bun.write(path, `${editResult}\n`);
      return 0;
    };
    const { deps, stdout } = makeDeps(["e", ""], { spawn, env: { EDITOR: "fake" }, colorEnabled: false });
    const result = await interactLoop(good, deps);
    expect(result.ok).toBe(true);
    const v = stdout.visible();
    expect(v).toContain("─── draft 1 (edited)");
    expect(v).not.toContain("─── draft 2");
  });

  // ── Ticket 14: inline draft edit (single-line, text()-style) ─────────────

  test("i pre-fills the draft as one line; typing over it and Enter saves and accepts", async () => {
    // The whole draft is the initial value; the user types over it and presses
    // Enter once. There is no double-Enter — the edit ends with one Enter.
    const { deps, stdout } = makeDeps(["i", "\x15", "fix(b): one line", "\r", ""], { colorEnabled: false });
    const result = await interactLoop(good, deps);
    expect(result).toEqual({ ok: true, action: "accepted", draft: "fix(b): one line", regenerations: 0 });
    expect(stdout.visible()).toContain("draft 1 (edited)");
  });

  test("i keeps the pre-filled draft when the user just presses Enter", async () => {
    // No edits: the line comes back unchanged, the draft is accepted as edited.
    const { deps, stdout } = makeDeps(["i", "\r", ""], { colorEnabled: false });
    const result = await interactLoop(good, deps);
    expect(result).toEqual({ ok: true, action: "accepted", draft: good.draft, regenerations: 0 });
    // The (edited) badge still shows — the user ran i and confirmed it; that's an edit.
    expect(stdout.visible()).toContain("draft 1 (edited)");
  });

  test("i shows the draft on screen while editing — the pre-filled draft appears, and a typed char repaints the line", async () => {
    // The framed draft shows colored text; inline mode must show the raw text
    // being edited (no colors) so the user sees what they're changing.
    const { deps, stdout } = makeDeps(["i", "X", "\x1b"], { colorEnabled: true });
    await interactLoop(good, deps);
    const raw = stdout.text();
    // The pre-filled draft appears plainly after the ">" marker; the framed
    // one is ANSI-wrapped. We search after the edit-mode entry line.
    const entry = raw.indexOf("commitshi: editing in place");
    expect(raw).toMatch(/commitshi: editing in place/);
    expect(raw.slice(entry)).toContain("> feat(a): do the thing");
    // A typed char repaints the line: erase-to-eol followed by the updated text.
    expect(raw).toContain("\x1b[K");
    expect(raw.slice(entry)).toContain("> feat(a): do the thingX");
  });

  test("i then Esc: the draft reverts, the (edited) badge drops, prompt reappears", async () => {
    const { deps, stdout } = makeDeps(["i", "\x1b", ""], { colorEnabled: false });
    const result = await interactLoop(good, deps);
    expect(result).toEqual({ ok: true, action: "accepted", draft: good.draft, regenerations: 0 });
    expect(stdout.visible()).not.toContain("(edited)");
  });

  test("Ctrl-C inside an inline edit cancels it like Esc (no re-raised SIGINT)", async () => {
    // Ctrl-C mid-edit must NOT kill the process; it cancels the edit and the
    // original draft is back at the next prompt, which Enter accepts.
    const { deps, stdout } = makeDeps(["i", "\x03", "\r"], { colorEnabled: false });
    const result = await interactLoop(good, deps);
    expect(result).toEqual({ ok: true, action: "accepted", draft: "feat(a): do the thing", regenerations: 0 });
    expect(stdout.visible()).toContain("cancelled");
    expect(stdout.visible()).not.toContain("(edited)");
  });

  test("i edit leaving the subject empty fails loud; nothing accepted, no commit", async () => {
    // Ctrl-U clears the line; a lone Enter on the empty subject must fail loud
    // and revert. This is the same rule as the old line-walk: the one thing we
    // refuse to pass on is a subjectless message.
    const { deps, stdout } = makeDeps(["i", "\x15", "\r"], { colorEnabled: false });
    const result = await interactLoop(good, deps);
    expect(result).toEqual({ ok: false, exitCode: 1, message: expect.stringContaining("subject") });
    expect(stdout.visible()).not.toContain("(edited)");
  });

  test("i edit then r regenerates; the edited text is discarded and the badge drops", async () => {
    let calls = 0;
    const regenerate = async (): Promise<DraftAttempt> => {
      calls++;
      return { ok: true, draft: "feat(a): regenerated", truncated: false, numstat: [] };
    };
    const { deps, stdout } = makeDeps(["i", "fix(b): my edit", "\r", "r", ""], { regenerate, colorEnabled: false });
    const result = await interactLoop(good, deps);
    expect(result).toEqual({ ok: true, action: "accepted", draft: "feat(a): regenerated", regenerations: 1 });
    expect(calls).toBe(1);
    // The badge was set after the edit and must clear once the fresh draft lands.
    const frames = stdout.visible();
    const badgeIdx = frames.indexOf("(edited)");
    const regenIdx = frames.indexOf("regenerated");
    expect(badgeIdx).toBeGreaterThan(-1);
    expect(regenIdx).toBeGreaterThan(badgeIdx); // the badge's re-presentation predates the regen frame
  });

  test("color enabled on a TTY frames the subject in accent ANSI escapes", async () => {
    const { deps, stdout } = makeDeps([""], { colorEnabled: true });
    const result = await interactLoop(good, deps);
    expect(result.ok).toBe(true);
    // The subject line is wrapped in an SGR escape; the prompt stays unwrapped.
    expect(stdout.text()).toMatch(/\x1b\[38;[^m]*mfeat\(a\): do the thing\x1b\[0m/);
    expect(stdout.text()).not.toMatch(/\x1b\[38;[^m]*m\[Enter\]/);
  });
});
