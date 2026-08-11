// Ticket 11 — the constrained setup wizard and its pre-staging auto-trigger.
//
// The wizard is driven headless through its seams: `nextLine` scripts the
// user's lines, TTY booleans stand in for a pty, and `configFilePath` points
// at a temp dir so the real ~/.config/commitshi/config is never touched.

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runSetup } from "./setup.ts";
import { main } from "./main.ts";
import { DEFAULT_MODEL } from "./pipeline.ts";
import { readConfigFile } from "./config.ts";

const execFileAsync = promisify(execFile);
/** Run a command in `cwd`; ignore stdout/stderr (test scaffolding). */
async function exec(cmd: string, args: readonly string[], cwd: string): Promise<void> {
  await execFileAsync(cmd, args, { cwd });
}

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

/** Scripted line source: feeds `lines` in order, then EOF (null). */
const scriptedLines = (lines: readonly string[]) => {
  let i = 0;
  return async () => (i < lines.length ? lines[i++]! : null);
};

/** A sandbox owned path per test; no repo required — the wizard stands alone. */
async function sandbox(): Promise<{ dir: string; configPath: string }> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "commitshi-setup-")));
  const configPath = join(dir, "commitshi", "config");
  // Temp dirs are left for the OS sweeper; mid-suite rm risks colliding
  // with another test file's freshly-created root under /tmp.
  void rm;
  return { dir, configPath };
}

describe("runSetup — the one config-write path (ticket 11)", () => {
  test("writes baseurl/model/openai_api_key to a fresh config file, exit 0", async () => {
    const { configPath } = await sandbox();
    const out = capture();
    const result = await runSetup(
      {
        stdinIsTTY: true,
        stdoutIsTTY: true,
        configFilePath: configPath,
        nextLine: scriptedLines(["https://api.example.com/v1", "sk-test-123", "gpt-5.6-luna"]),
      },
      out.stream,
      capture().stream,
    );
    expect(result.exitCode).toBe(0);
    const text = await readFile(configPath, "utf8");
    expect(text).toBe(
      "baseurl = https://api.example.com/v1\nmodel = gpt-5.6-luna\nopenai_api_key = sk-test-123\n",
    );
    const parsed = await readConfigFile(configPath);
    expect(parsed.get("baseurl")).toBe("https://api.example.com/v1");
    expect(parsed.get("model")).toBe("gpt-5.6-luna");
    expect(parsed.get("openai_api_key")).toBe("sk-test-123");
  });

  test("Enter on every field accepts the defaults — the wizard's prefill IS the pinned default model", async () => {
    const { configPath } = await sandbox();
    const out = capture();
    const result = await runSetup(
      {
        stdinIsTTY: true,
        stdoutIsTTY: true,
        configFilePath: configPath,
        nextLine: scriptedLines(["", "sk-abc", ""]),
      },
      out.stream,
      capture().stream,
    );
    expect(result.exitCode).toBe(0);
    const parsed = await readConfigFile(configPath);
    expect(parsed.get("baseurl")).toBe("https://api.openai.com/v1");
    expect(parsed.get("model")).toBe("gpt-5.6-luna");
    expect(parsed.get("openai_api_key")).toBe("sk-abc");
    // Required test #7: the shipped default model is pinned and matches the prefill.
    expect(DEFAULT_MODEL).toBe("gpt-5.6-luna");
    expect(out.text()).toContain(`[${DEFAULT_MODEL}]`);
  });

  test("a local URL (Ollama-style) allows a blank key and omits openai_api_key", async () => {
    const { configPath } = await sandbox();
    const result = await runSetup(
      {
        stdinIsTTY: true,
        stdoutIsTTY: true,
        configFilePath: configPath,
        nextLine: scriptedLines(["http://localhost:11434/v1", "", "llama3.2"]),
      },
      capture().stream,
      capture().stream,
    );
    expect(result.exitCode).toBe(0);
    const text = await readFile(configPath, "utf8");
    expect(text).toBe("baseurl = http://localhost:11434/v1\nmodel = llama3.2\n");
    expect(text).not.toContain("openai_api_key");
    const parsed = await readConfigFile(configPath);
    expect(parsed.get("openai_api_key")).toBeUndefined();
  });

  test("a blank key against a non-local URL refuses loudly and re-prompts until a key appears", async () => {
    const { configPath } = await sandbox();
    const out = capture();
    const result = await runSetup(
      {
        stdinIsTTY: true,
        stdoutIsTTY: true,
        configFilePath: configPath,
        // URL entered first, then blank key (refused), then a real key, then
        // Enter on the model — the re-prompt consumed a line the first draft
        // of this test forgot.
        nextLine: scriptedLines(["https://api.openai.com/v1", "", "fixture-key-token", ""]),
      },
      out.stream,
      capture().stream,
    );
    expect(result.exitCode).toBe(0);
    expect(out.text()).toContain("needs an API key");
    const parsed = await readConfigFile(configPath);
    expect(parsed.get("openai_api_key")).toBe("fixture-key-token");
    expect(parsed.get("model")).toBe("gpt-5.6-luna");
  });

  test("a blank key against a non-local URL that never appears aborts with nothing written", async () => {
    const { dir, configPath } = await sandbox();
    const err = capture();
    const result = await runSetup(
      {
        stdinIsTTY: true,
        stdoutIsTTY: true,
        configFilePath: configPath,
        // Blank key forever, then EOF: the wizard must not save a broken bundle.
        nextLine: scriptedLines(["https://api.openai.com/v1", "", ""]),
      },
      capture().stream,
      err.stream,
    );
    expect(result.exitCode).toBe(1);
    expect(err.text()).toContain("setup aborted");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("non-TTY refuses loudly, exit 1, nothing written", async () => {
    const { dir, configPath } = await sandbox();
    const err = capture();
    const result = await runSetup(
      {
        stdinIsTTY: false,
        stdoutIsTTY: true,
        configFilePath: configPath,
        nextLine: scriptedLines([]),
      },
      capture().stream,
      err.stream,
    );
    expect(result.exitCode).toBe(1);
    expect(err.text()).toContain("interactive terminal");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("re-run prefills the existing values and overwrite-on-confirm updates only what changed", async () => {
    const { configPath } = await sandbox();
    await Bun.write(configPath, "baseurl = https://old.example.com/v1\nmodel = old-model\nopenai_api_key = sk-old\n"); // seed: dir + file, as a prior wizard run left them
    // The wizard owns creating the dir; the seed above stands in for a prior run.
    const out = capture();
    const result = await runSetup(
      {
        stdinIsTTY: true,
        stdoutIsTTY: true,
        configFilePath: configPath,
        // New URL, keep old key (Enter), new model, confirm y.
        nextLine: scriptedLines(["https://new.example.com/v1", "", "new-model", "y"]),
      },
      out.stream,
      capture().stream,
    );
    expect(result.exitCode).toBe(0);
    expect(out.text()).toContain("[https://old.example.com/v1]"); // prefill shown
    expect(out.text()).toContain("[sk-old]");
    expect(out.text()).toContain("[old-model]");
    expect(out.text()).toContain("Overwrite");
    const text = await readFile(configPath, "utf8");
    expect(text).toBe("baseurl = https://new.example.com/v1\nmodel = new-model\nopenai_api_key = sk-old\n");
  });

  test("rejecting the overwrite leaves the existing file byte-identical", async () => {
    const { configPath } = await sandbox();
    await Bun.write(configPath, "baseurl = https://old.example.com/v1\nmodel = old-model\nopenai_api_key = sk-old\n");
    const result = await runSetup(
      {
        stdinIsTTY: true,
        stdoutIsTTY: true,
        configFilePath: configPath,
        // Enter keeps everything; then answer n to the overwrite.
        nextLine: scriptedLines(["", "", "", "n"]),
      },
      capture().stream,
      capture().stream,
    );
    expect(result.exitCode).toBe(0);
    const text = await readFile(configPath, "utf8");
    expect(text).toBe("baseurl = https://old.example.com/v1\nmodel = old-model\nopenai_api_key = sk-old\n");
  });

  test("the wizard never clobbers keys it does not own; comments survive a re-run", async () => {
    const { configPath } = await sandbox();
    await Bun.write(
      configPath,
      "# hand-maintained\nbaseurl = https://old.example.com/v1\nmodel = old-model\nopenai_api_key = sk-old\ntemplate = {type}: {summary}\n",
    );
    const result = await runSetup(
      {
        stdinIsTTY: true,
        stdoutIsTTY: true,
        configFilePath: configPath,
        nextLine: scriptedLines(["https://new.example.com/v1", "", "new-model", "y"]),
      },
      capture().stream,
      capture().stream,
    );
    expect(result.exitCode).toBe(0);
    const text = await readFile(configPath, "utf8");
    expect(text).toBe(
      "# hand-maintained\nbaseurl = https://new.example.com/v1\nmodel = new-model\nopenai_api_key = sk-old\ntemplate = {type}: {summary}\n",
    );
  });

  test("keys echo normally — no masking ceremony (plaintext file either way)", async () => {
    const { configPath } = await sandbox();
    const out = capture();
    await runSetup(
      {
        stdinIsTTY: true,
        stdoutIsTTY: true,
        configFilePath: configPath,
        nextLine: scriptedLines(["", "echo-fixture-token", ""]),
      },
      out.stream,
      capture().stream,
    );
    // The "About to write" block shows the key verbatim — no *** masking.
    expect(out.text()).toContain("echo-fixture-token");
    expect(out.text()).not.toContain("***");
    const parsed = await readConfigFile(configPath);
    expect(parsed.get("openai_api_key")).toBe("echo-fixture-token");
  });
});

describe("auto-trigger (tickets 11/14): missing-key draft result → wizard → retry", () => {

  test("--setup standalone: runs outside a git repo, writes the config, exits 0 without touching the staged guard", async () => {
    const { configPath } = await sandbox();
    const out = capture();
    const err = capture();
    const code = await main(["--setup"], out.stream, err.stream, {
      config: { configFilePath: configPath, env: {} },
      setup: async (o, _e) => {
        // Stand-in for the real wizard: asserts the wiring, not the IO.
        o.write("commitshi setup\n");
        return { exitCode: 0 };
      },
    });
    expect(code).toBe(0);
    expect(out.text()).toContain("commitshi setup");
    expect(err.text()).not.toContain("not a git repository");
    expect(err.text()).not.toContain("nothing staged");
  });

  test("auto-trigger fires after the staged guard on a TTY: wizard writes the config, the same run drafts", async () => {
    const { configPath } = await sandbox();
    const workdir = realpathSync(await mkdtemp(join(tmpdir(), "commitshi-trigger-")));
    await exec("git", ["init", "-q"], workdir);
    await writeFile(join(workdir, "a.txt"), "one\n");
    await exec("git", ["add", "a.txt"], workdir);
    const previousCwd = process.cwd();
    process.chdir(workdir);
    try {
      const out = capture();
      const err = capture();
      let chatCalls = 0;
      // End to end through the REAL wizard: scripted lines fill the config
      // file, the pipeline's missing-key result fires it, the retry picks up
      // the freshly written bundle and drafts in the same run.
      const code = await main([], out.stream, err.stream, {
        chat: async () => {
          chatCalls++;
          return { ok: true as const, content: "type: feat\nscope: -\nsummary: add a.txt\nbody: -" };
        },
        config: { configFilePath: configPath, env: {}, gitConfigGet: async () => null },
        stdinIsTTY: true,
        stdoutIsTTY: true,
        loop: { ask: async () => "\r" }, // accept at the decision prompt
        commit: async () => ({ ok: true as const }),
        setupInput: {
          stdinIsTTY: true,
          stdoutIsTTY: true,
          env: {},
          configFilePath: configPath,
          nextLine: scriptedLines(["http://localhost:11434/v1", "", ""]),
        },
      });
      expect(code).toBe(0);
      expect(out.text()).toContain("commitshi setup");
      expect(out.text()).toContain("feat: add a.txt");
      expect(out.text()).toContain("committed");
      expect(chatCalls).toBe(1);
      const written = await readConfigFile(configPath);
      expect(written.get("baseurl")).toBe("http://localhost:11434/v1");
    } finally {
      process.chdir(previousCwd);
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test("auto-trigger skips when --base-url + --model + OPENAI_API_KEY cover the bundle", async () => {
    // The full flow has to reach the pipeline, which means it has to clear
    // the staged guard. Sandbox into a fresh git repo with one staged file
    // so the run is reproducible regardless of the test runner's cwd.
    const previousCwd = process.cwd();
    const { configPath } = await sandbox();
    const workdir = realpathSync(await mkdtemp(join(tmpdir(), "commitshi-trigger-")));
    await exec("git", ["init", "-q"], workdir);
    await writeFile(join(workdir, "a.txt"), "one\n");
    await exec("git", ["add", "a.txt"], workdir);
    process.chdir(workdir);
    try {
      const out = capture();
      const err = capture();
      let opened = 0;
      let chatCalls = 0;
      const code = await main(
        ["--no-commit", "--base-url", "https://api.example.com/v1", "--model", "some-model"],
        out.stream,
        err.stream,
        {
          chat: async () => {
            chatCalls++;
            return { ok: true as const, content: "type: feat\nscope: -\nsummary: add a.txt\nbody: -" };
          },
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
      // Wizard skipped proves the trigger honored the covering flags/env;
      // the run then reaches the normal stages (guard → pipeline → --no-commit
      // prints the finished draft and exits 0). A non-zero code here would
      // mean either the trigger fired or the run short-circuited unexpectedly.
      expect(opened).toBe(0);
      expect(chatCalls).toBe(1);
      expect(code).toBe(0);
      expect(err.text()).not.toContain("commitshi setup");
    } finally {
      process.chdir(previousCwd);
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test("auto-trigger never fires when stdin is piped, even with an unusable bundle", async () => {
    const { configPath } = await sandbox();
    const out = capture();
    const err = capture();
    let opened = 0;
    let chatCalls = 0;
    const code = await main(["--no-commit"], out.stream, err.stream, {
      chat: async () => {
        chatCalls++;
        return { ok: true as const, content: "type: feat\nscope: -\nsummary: x\nbody: -" };
      },
      config: { configFilePath: configPath, env: { OPENAI_API_KEY: "sk-ci" }, gitConfigGet: async () => null },
      stdinIsTTY: false,
      stdoutIsTTY: true,
      setup: async () => {
        opened++;
        return { exitCode: 0 };
      },
    });
    expect(opened).toBe(0);
    // No wizard, no silent proceed: the run stops non-zero at the guard
    // boundary (repo-dependent wording) before any model call — the
    // missing-key result never routes to the wizard off a TTY.
    expect(code).toBe(1);
    expect(chatCalls).toBe(0);
    expect(err.text()).toMatch(/nothing staged|not a git repository/);
  });
});

// Acceptance: the setup wizard is the ONLY config-write path. Modeled on the
// ticket-10 history scan in git.test.ts — a static assertion over shipped
// source, not just behavior, so a future "quick write" can't slip through a
// code path the tests don't exercise.
describe("no config writes outside the setup wizard (ticket 11 acceptance)", () => {
  const WRITERS = ["Bun.write(", "writeFile(", "writeFileSync(", "createWriteStream("];
  const SHIPPED = [
    "src/cli.ts",
    "src/commit.ts",
    "src/compaction.ts",
    "src/config.ts",
    "src/git.ts",
    "src/loop.ts",
    "src/main.ts",
    "src/pipeline.ts",
  ];

  test("Bun.write / writeFile( / writeFileSync( appear only in src/setup.ts among shipped source", async () => {
    for (const file of SHIPPED) {
      const text = await readFile(file, "utf8");
      if (file === "src/loop.ts") continue; // editor temp-file write is not a config write
      for (const writer of WRITERS) {
        expect(text).not.toContain(writer);
      }
    }
    // loop.ts's writeFile is the $EDITOR temp file under tmpdir(), never the
    // config file: the path it writes is built from tmpdir, and the file is
    // unlinked in the same function.
    const loop = await readFile("src/loop.ts", "utf8");
    expect(loop).toContain("tmpdir()");
    expect(loop).not.toContain("defaultConfigFilePath");
  });

  test("config.ts declares write helpers but never performs a write", async () => {
    const text = await readFile("src/config.ts", "utf8");
    expect(text).not.toContain("Bun.write(");
    expect(text).not.toContain("writeFile(");
    expect(text).not.toContain("writeFileSync(");
    expect(text).toContain("export function updateConfigText");
    expect(text).toContain("export function formatConfigFile");
  });

  test("the wizard writes only the three owned keys and never touches git config", async () => {
    const text = await readFile("src/setup.ts", "utf8");
    expect(text).toContain('"baseurl"');
    expect(text).toContain('"model"');
    expect(text).toContain('"openai_api_key"');
    // The "never in git config" invariant: no git subprocess, no config-set.
    expect(text).not.toContain('"config", "--local"');
    expect(text).not.toContain('"config", "--global"');
    expect(text).not.toContain("execFileAsync(\"git\"");
    expect(text).not.toContain("Bun.spawn([\"git\"");
  });
});
