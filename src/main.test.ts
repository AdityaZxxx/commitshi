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
    for (const flag of ["--no-commit", "--regenerate", "--instructions", "--template", "--provider", "--model", "--setup", "--base-url"]) {
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

    // Ticket 11: pre-staging trigger. A fresh user (empty config, no
    // OPENAI_API_KEY, nothing staged) on a TTY gets the wizard, NOT the
    // "nothing staged" error — the check runs before guardStagedChanges.
    // The setup seam stands in for the wizard so the assertion is on the
    // main.ts wiring; the same scenario end-to-end through the pipeline's
    // own refusal lives in setup.test.ts.
    test("empty config on a TTY opens the wizard before the staged guard, never 'nothing staged'", async () => {
      const dir = realpathSync(await mkdtemp(join(tmpdir(), "commitshi-setup-")));
      const configPath = join(dir, "commitshi", "config");
      const out = capture();
      const err = capture();
      let opened = 0;
      const code = await main([], out.stream, err.stream, {
        config: { configFilePath: configPath, env: {}, gitConfigGet: async () => null },
        stdinIsTTY: true,
        stdoutIsTTY: true,
        setup: async () => {
          opened++;
          return { exitCode: 1 };
        },
      });
      expect(opened).toBe(1);
      expect(code).toBe(1);
      expect(err.text()).not.toContain("nothing staged");
      expect(err.text()).toContain("no API key");
    });

    test("a fully flag/env-covered one-shot skip: the wizard never opens and the guard runs", async () => {
      const dir = realpathSync(await mkdtemp(join(tmpdir(), "commitshi-setup-")));
      const configPath = join(dir, "commitshi", "config");
      const out = capture();
      const err = capture();
      let opened = 0;
      const code = await main(
        ["--no-commit", "--base-url", "https://api.example.com/v1", "--model", "some-model"],
        out.stream,
        err.stream,
        {
          chat: stubChat,
          config: {
            configFilePath: configPath,
            env: { OPENAI_API_KEY: "sk-flag-run" },
            gitConfigGet: async () => null,
          },
          stdinIsTTY: true,
          stdoutIsTTY: true,
          setup: async () => {
            opened++;
            return { exitCode: 0 };
          },
        },
      );
      expect(opened).toBe(0);
      expect(code).not.toBe(0);
      expect(err.text()).toContain("not a git repository");
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
      expect(out.text()).toContain("feat: add a.txt");
      expect(err.text()).not.toContain("nothing staged");
      expect(err.text()).not.toContain("not a git repository");

      // Ticket 13 regression: the presentation frame is interactive-only. Even
      // with a TTY loop seam wired in, --no-commit never labels or colors.
      const tOut = capture();
      const tCode = await main(["--no-commit"], tOut.stream, capture().stream, {
        chat: stubChat,
        loop: { stdinIsTTY: true, stdoutIsTTY: true },
      });
      expect(tCode).toBe(0);
      expect(tOut.text()).not.toContain("───");
      expect(tOut.text()).not.toContain("\x1b[");
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
      expect(committed).toBe("feat: add a.txt");
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
      expect(committed).toBe("feat: draft 2");
    });

    // Ticket r: the wire request carries temperature 0 on the initial draft
    // and temperature 0.3 on the regeneration — driven through main so the
    // override is set ONLY by the regenerate call site at main.ts:203.
    test("initial draft sends temperature 0; r sends temperature 0.3 (wire-level)", async () => {
      await stageA();
      const temperatures: number[] = [];
      const chat: import("./pipeline.ts").PipelineDeps["chat"] = async (_d, req) => {
        if (typeof req.temperature === "number") temperatures.push(req.temperature);
        return { ok: true as const, content: "type: feat\nscope: -\nsummary: x\nbody: -" };
      };
      const out = capture();
      const err = capture();
      const code = await main([], out.stream, err.stream, {
        chat,
        loop: interactive(["r", "r", ""]),
        commit: async () => ({ ok: true as const }),
      });
      expect(code).toBe(0);
      // initial draft → 0, then two regenerations → 0.3 each.
      expect(temperatures).toEqual([0, 0.3, 0.3]);
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
      expect(out.text()).not.toContain("feat: add a.txt");
    });

    // Ticket 09: --instructions reaches the prompt end to end, with the
    // precedence contract stated to the model.
    test("--instructions appends the block to the prompt (end to end through main)", async () => {
      await stageA();
      const out = capture();
      const err = capture();
      let seenUser = "";
      const chat: import("./pipeline.ts").PipelineDeps["chat"] = async (_d, req) => {
        seenUser = req.messages[1]?.content ?? "";
        return { ok: true as const, content: "type: chore\nscope: -\nsummary: tidy the a.txt file\nbody: -" };
      };
      const code = await main(["--no-commit", "--instructions", "treat this as a chore, not a feature"], out.stream, err.stream, {
        chat,
      });
      expect(code).toBe(0);
      expect(seenUser).toContain("### User instructions");
      expect(seenUser).toContain("treat this as a chore");
      expect(out.text()).toContain("chore: tidy the a.txt file");
    });

    // Ticket 09: --template beats any committed template for one run. The
    // repo has no commitshi.template configured, so the default wins unless
    // the flag overrides it here.
    test("--template overrides the default template for one run only", async () => {
      await stageA();
      const out = capture();
      const err = capture();
      const code = await main(
        ["--no-commit", "--template", "{summary}"],
        out.stream,
        err.stream,
        { chat: async () => ({ ok: true as const, content: "summary: just the summary line" }) },
      );
      expect(code).toBe(0);
      expect(out.text()).toContain("just the summary line");
      expect(out.text()).not.toContain("feat:");
    });

    // Ticket 10: without --style no history is read even when commits exist.
    // The prompt must not contain the style block.
    test("no --style: prompt never carries history even with commits present", async () => {
      await stageA();
      // create one prior commit so history WOULD be non-empty if read
      await git(workdir, "commit", "-q", "-m", "feat: prior history exists");
      await writeFile(join(workdir, "b.txt"), "two\n");
      await git(workdir, "add", "b.txt");

      let seenUser = "";
      const chat: import("./pipeline.ts").PipelineDeps["chat"] = async (_d, req) => {
        seenUser = req.messages[1]?.content ?? "";
        return { ok: true as const, content: "type: feat\nscope: -\nsummary: add b.txt\nbody: -" };
      };
      const out = capture();
      const err = capture();
      const code = await main(["--no-commit"], out.stream, err.stream, { chat });
      expect(code).toBe(0);
      expect(seenUser).not.toContain("### Style history");
      expect(seenUser).not.toContain("feat: prior history exists");
    });

    // Ticket 10: --style reads history once, includes the subject, drafts.
    test("--style includes the recent subjects in the prompt", async () => {
      await stageA();
      await git(workdir, "commit", "-q", "-m", "feat(cli): add the scaffold");
      await git(workdir, "commit", "-q", "--allow-empty", "-m", "fix(cli): quiet the spinner");
      await writeFile(join(workdir, "b.txt"), "two\n");
      await git(workdir, "add", "b.txt");

      let seenUser = "";
      const chat: import("./pipeline.ts").PipelineDeps["chat"] = async (_d, req) => {
        seenUser = req.messages[1]?.content ?? "";
        return { ok: true as const, content: "type: feat\nscope: cli\nsummary: add b.txt\nbody: -" };
      };
      const out = capture();
      const err = capture();
      const code = await main(["--no-commit", "--style"], out.stream, err.stream, { chat });
      expect(code).toBe(0);
      expect(seenUser).toContain("### Style history");
      expect(seenUser).toContain("fix(cli): quiet the spinner");
      expect(seenUser).toContain("feat(cli): add the scaffold");
      expect(out.text()).toContain("feat(cli): add b.txt");
    });

    // Ticket 10: fresh repo + --style degrades gracefully (unborn HEAD).
    test("a fresh repo with --style still drafts, with no style block", async () => {
      await stageA(); // stages a.txt; no commits yet at all
      let seenUser = "";
      const chat: import("./pipeline.ts").PipelineDeps["chat"] = async (_d, req) => {
        seenUser = req.messages[1]?.content ?? "";
        return { ok: true as const, content: "type: feat\nscope: -\nsummary: add a.txt\nbody: -" };
      };
      const out = capture();
      const err = capture();
      const code = await main(["--no-commit", "--style"], out.stream, err.stream, { chat });
      expect(code).toBe(0);
      expect(seenUser).not.toContain("### Style history");
      expect(out.text()).toContain("feat: add a.txt");
    });
  });
});
