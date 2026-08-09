import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./main.ts";

function capture(): {
  stream: Pick<typeof process.stdout, "write">;
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

const GIT_ENV = {
  GIT_AUTHOR_NAME: "commitshi test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "commitshi test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
}

describe("main", () => {
  test("--help prints usage with every documented flag, exit 0", async () => {
    const out = capture();
    const err = capture();
    const code = await main(["--help"], out.stream, err.stream);
    expect(code).toBe(0);
    for (const flag of ["--no-commit", "--regenerate", "--instructions", "--template", "--provider", "--model"]) {
      expect(out.text()).toContain(flag);
    }
    expect(err.text()).toBe("");
  });

  test("unknown flag exits non-zero with a clean usage error", async () => {
    const out = capture();
    const err = capture();
    const code = await main(["--bogus"], out.stream, err.stream);
    expect(code).not.toBe(0);
    expect(err.text()).toContain("--bogus");
  });

  describe("sandboxed git repos", () => {
    let workdir: string;
    let previousCwd: string;

    beforeEach(async () => {
      previousCwd = process.cwd();
      workdir = realpathSync(await mkdtemp(join(tmpdir(), "commitshi-")));
      process.chdir(workdir);
    });

    afterEach(async () => {
      process.chdir(previousCwd);
      await rm(workdir, { recursive: true, force: true });
    });

    test("run outside a git repo explains and exits non-zero", async () => {
      const err = capture();
      const code = await main([], capture().stream, err.stream);
      expect(code).not.toBe(0);
      expect(err.text()).toContain("not a git repository");
    });

    test("empty repo run with nothing staged exits gracefully, no crash", async () => {
      await git(workdir, "init", "-q");
      const err = capture();
      const code = await main([], capture().stream, err.stream);
      expect(code).not.toBe(0);
      expect(err.text()).toContain("nothing staged");
    });

    test("repo with only unstaged changes behaves like nothing staged", async () => {
      await git(workdir, "init", "-q");
      await git(workdir, "commit", "-q", "--allow-empty", "-m", "init");
      await writeFile(join(workdir, "a.txt"), "one\n");
      await git(workdir, "add", "a.txt");
      await git(workdir, "commit", "-q", "-m", "add a.txt");
      await writeFile(join(workdir, "a.txt"), "one\ntwo\n");

      const err = capture();
      const code = await main([], capture().stream, err.stream);
      expect(code).not.toBe(0);
      expect(err.text()).toContain("nothing staged");
    });

    // Ticket 05 tracer bullet: a stubbed model stands in for the provider so
    // the end-to-end path (guard → diff → compact → template → fill → print)
    // runs offline. The live round trip is proven separately against Ollama.
    const stubChat = async () => ({
      ok: true as const,
      content: "type: feat\nscope: -\nsummary: add a.txt\nbody: -",
    });

    test("--no-commit prints the drafted message from the staged diff, end to end", async () => {
      await git(workdir, "init", "-q");
      await writeFile(join(workdir, "a.txt"), "one\n");
      await git(workdir, "add", "a.txt");

      const out = capture();
      const err = capture();
      const code = await main(["--no-commit"], out.stream, err.stream, { chat: stubChat });
      expect(code).toBe(0);
      expect(out.text()).toContain("feat(): add a.txt");
      expect(err.text()).not.toContain("nothing staged");
      expect(err.text()).not.toContain("not a git repository");
    });

    test("a strict-fill violation is rejected loud, no draft printed", async () => {
      await git(workdir, "init", "-q");
      await writeFile(join(workdir, "a.txt"), "one\n");
      await git(workdir, "add", "a.txt");

      const out = capture();
      const err = capture();
      // The model emits the token names back — the classic tiny-model echo.
      const code = await main(["--no-commit"], out.stream, err.stream, {
        chat: async () => ({ ok: true as const, content: "{type}: {summary}" }),
      });
      expect(code).toBe(1);
      expect(err.text()).toContain("template contract");
      expect(out.text().trim()).toBe("");
    });

    // Ticket 07: the interactive loop wired through main, driven by a
    // scripted key seam over a real staged repo. The loop seams make the
    // run deterministic — no TTY, no editor, no live model.
    const scriptedAsk = (answers: readonly (string | null)[]) => {
      let i = 0;
      return async () => (i < answers.length ? answers[i++] : null);
    };
    const interactive = (answers: readonly (string | null)[], extra: Record<string, unknown> = {}) => ({
      ask: scriptedAsk(answers),
      stdinIsTTY: true,
      stdoutIsTTY: true,
      ...extra,
    });

    async function stageA(): Promise<void> {
      await git(workdir, "init", "-q");
      await writeFile(join(workdir, "a.txt"), "one\n");
      await git(workdir, "add", "a.txt");
    }

    test("Enter accepts the draft and hands it to the commit seam", async () => {
      await stageA();
      const out = capture();
      const err = capture();
      let committed: string | undefined; // Enter-accept
      const code = await main([], out.stream, err.stream, {
        chat: stubChat,
        loop: interactive([""]),
        commit: async (message: string) => {
          committed = message;
          return { ok: true as const };
        },
      });
      expect(code).toBe(0);
      expect(committed).toBe("feat(): add a.txt");
      expect(out.text()).toContain("committed");
      expect(err.text()).not.toContain("canceled");
    });

    test("e opens $EDITOR; the accepted draft is the edited message", async () => {
      await stageA();
      const out = capture();
      const err = capture();
      const edited = "fix(a): hand-edited in the editor";
      let committed: string | undefined; // edited draft
      const code = await main([], out.stream, err.stream, {
        chat: stubChat,
        loop: interactive(["e", ""], {
          env: { EDITOR: "fake-editor" },
          spawn: async (_editor: string, path: string) => {
            await writeFile(path, `${edited}\n`);
            return 0;
          },
        }),
        commit: async (message: string) => {
          committed = message;
          return { ok: true as const };
        },
      });
      expect(code).toBe(0);
      expect(committed).toBe(edited);
    });

    test("e with no $EDITOR fails loud, never a silent accept", async () => {
      await stageA();
      const out = capture();
      const err = capture();
      const code = await main([], out.stream, err.stream, {
        chat: stubChat,
        loop: interactive(["e"], { env: { EDITOR: "" } }),
      });
      expect(code).toBe(1);
      expect(err.text()).toContain("$EDITOR is not set");
    });

    test("r regenerates a fresh draft for the same unchanged staged diff", async () => {
      await stageA();
      let calls = 0;
      const chat = async () => {
        calls++;
        return { ok: true as const, content: `type: feat\nscope: -\nsummary: draft ${calls}\nbody: -` };
      };
      const out = capture();
      const err = capture();
      let committed: string | undefined; // regenerated draft
      const code = await main([], out.stream, err.stream, {
        chat,
        loop: interactive(["r", ""]),
        commit: async (message: string) => {
          committed = message;
          return { ok: true as const };
        },
      });
      expect(code).toBe(0);
      expect(calls).toBe(2); // first draft + one regeneration
      expect(committed).toBe("feat(): draft 2");
    });

    test("q cancels — no commit, exit 0", async () => {
      await stageA();
      const out = capture();
      const err = capture();
      let commitCalls = 0;
      const code = await main([], out.stream, err.stream, {
        chat: stubChat,
        loop: interactive(["q"]),
        commit: async () => {
          commitCalls++;
          return { ok: true as const };
        },
      });
      expect(code).toBe(0);
      expect(err.text()).toContain("canceled");
      expect(commitCalls).toBe(0); // a canceled draft never reaches the commit stage
    });

    test("no TTY (stdin piped) without --no-commit fails loud, never a silent accept", async () => {
      await stageA();
      const out = capture();
      const err = capture();
      const code = await main([], out.stream, err.stream, {
        chat: stubChat,
        loop: { ask: scriptedAsk([""]), stdinIsTTY: false, stdoutIsTTY: true },
      });
      expect(code).toBe(1);
      expect(err.text()).toContain("interactive terminal");
      expect(out.text()).not.toContain("feat(): add a.txt");
    });
  });
});
