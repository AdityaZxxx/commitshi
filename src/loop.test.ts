import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { interactLoop, type AskKey, type DraftAttempt, type LoopDeps } from "./loop.ts";

function capture(): {
  stream: Pick<NodeJS.WriteStream, "write">;
  text: () => string;
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
    regenerate: async () => ({ ok: true, draft: "regen", truncated: false }),
    ...extra,
  };
  return { deps, stdout, stderr };
}

const good: DraftAttempt = { ok: true, draft: "feat(a): do the thing", truncated: false };

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

  test("a truncated draft is disclosed above the prompt, on stdout with the frame", async () => {
    const first: DraftAttempt = { ok: true, draft: "feat(a): big", truncated: true };
    const { deps, stdout, stderr } = makeDeps([""]);
    const result = await interactLoop(first, deps);
    expect(result.ok).toBe(true);
    expect(stdout.text()).toContain("truncated digest");
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
      return { ok: true, draft: `feat(a): fresh #${calls}`, truncated: false };
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
      return { ok: true, draft: "feat(a): after edit", truncated: false };
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
});
