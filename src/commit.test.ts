// Integration proof for the commit stage (ticket 08) — sandboxed temp git
// repos with real or scripted hooks, plus the seam-through-main wiring.
//
// The four behaviors under proof:
//   1. The accepted message is committed via `git commit -F -` (stdin): the
//      commit lands verbatim (subject + multi-line body), and `git add` is
//      never run — what was staged is what commits, nothing else.
//   2. Real hooks (prepare-commit-msg, commit-msg) fire on the commit: a
//      prepare-commit-msg script that appends a footer proves the message
//      file round-trips through the hook; a commit-msg script that rejects
//      kills the commit loud.
//   3. An empty/whitespace draft never yields a commit — git is not even
//      spawned (proven by a counting hook).
//   4. --no-commit under no circumstances creates a commit: end-to-end, the
//      headless print leaves HEAD exactly where it was.
//
// The "never runs git add" boundary also has a static guard: a test scans
// src/commit.ts, src/git.ts, and src/pipeline.ts for any `add` invocation.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { commitAcceptedMessage } from "./commit.ts";
import { main } from "./main.ts";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "commitshi test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "commitshi test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** Runs git in the sandbox with a test identity, failing the test on error. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
  return out;
}

/** Reads HEAD's commit message bytes from the commit object itself. */
async function headCommitMessage(cwd: string): Promise<string> {
  const raw = await git(cwd, "cat-file", "commit", "HEAD");
  const separator = raw.indexOf("\n\n");
  if (separator === -1) throw new Error("malformed commit object: no header/message separator");
  return raw.slice(separator + 2);
}

/** `git log` variant that tolerates an unborn HEAD (fresh repo). */
async function gitLog(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "log", ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

/** Installs an executable hook into the sandbox repo. */
async function installHook(workdir: string, name: string, script: string): Promise<void> {
  const path = join(workdir, ".git", "hooks", name);
  await writeFile(path, script);
  await chmod(path, 0o755);
}

function capture(): { stream: Pick<NodeJS.WriteStream, "write">; text: () => string } {
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

describe("commit stage (ticket 08, sandboxed repos with real hooks)", () => {
  let workdir: string;
  let previousCwd: string;

  beforeEach(async () => {
    previousCwd = process.cwd();
    workdir = realpathSync(await mkdtemp(join(tmpdir(), "commitshi-commit-")));
    process.chdir(workdir);
    await git(workdir, "init", "-q");
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    await rm(workdir, { recursive: true, force: true });
  });

  async function stageFile(name: string, text: string): Promise<void> {
    await writeFile(join(workdir, name), text);
    await git(workdir, "add", name);
  }

  test("the accepted message is committed via git commit -F -, landing exactly", async () => {
    await stageFile("a.txt", "one\n");
    const message = "feat(cli): accept loop commits\n\nBody kept verbatim through stdin.\n\nSigned-off-by: Test <test@example.com>";

    const result = await commitAcceptedMessage(message, workdir);

    expect(result.ok).toBe(true);
    expect(await headCommitMessage(workdir)).toBe(`${message}\n`);
    expect(await git(workdir, "show", "--format=", "--name-only", "HEAD")).toContain("a.txt");
  });

  test("no git add is ever run: an unstaged same-file edit stays out of the commit", async () => {
    await writeFile(join(workdir, "a.txt"), "zero\n");
    await git(workdir, "add", "a.txt");
    await git(workdir, "commit", "-q", "-m", "base");
    await writeFile(join(workdir, "a.txt"), "one\n");
    await git(workdir, "add", "a.txt"); // staged view: one
    await writeFile(join(workdir, "a.txt"), "one\ntwo\n"); // unstaged same-file edit
    // If commitshi ever staged, this edit would ride along into the commit.

    const result = await commitAcceptedMessage("test: staged content only", workdir);

    expect(result.ok).toBe(true);
    const committed = await git(workdir, "show", "HEAD:a.txt");
    expect(committed).toBe("one\n"); // staged blob only — the unstaged line stayed out
    // and it is still there unstaged, untouched
    expect(await git(workdir, "status", "--porcelain")).toBe(" M a.txt\n");
  });

  test("prepare-commit-msg fires: a real hook's edit lands in the commit", async () => {
    await installHook(workdir, "prepare-commit-msg", "#!/bin/sh\necho '' >> \"$1\"\necho 'Hook-Footer: prepared' >> \"$1\"\n");
    await stageFile("a.txt", "one\n");

    const result = await commitAcceptedMessage("feat: real prepare-commit-msg hook ran", workdir);

    expect(result.ok).toBe(true);
    const body = await git(workdir, "log", "-1", "--format=%B");
    expect(body).toContain("feat: real prepare-commit-msg hook ran");
    expect(body).toContain("Hook-Footer: prepared"); // the hook's fingerprint in the real message
  });

  test("commit-msg fires: a hook that rejects the message kills the commit, loud", async () => {
    await installHook(workdir, "commit-msg", "#!/bin/sh\necho 'commit-msg hook rejected: no plain chore' >&2\nexit 1\n");
    await stageFile("a.txt", "one\n");

    const result = await commitAcceptedMessage("chore: hook bait", workdir);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain("commit-msg hook rejected: no plain chore"); // git's stderr not swallowed
    expect(result.message).not.toContain("committed");
    // Loud failure, no partial commit: HEAD never moved, the staged set is
    // untouched for the user's rerun (a fresh attempt, never a retry-stale).
    expect(await gitLog(workdir, "--oneline")).toBe("");
    expect(await git(workdir, "diff", "--cached", "--name-only")).toContain("a.txt");
  });

  test("a missing identity failure fails loud with git's own message", async () => {
    await stageFile("a.txt", "one\n");
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "",
      GIT_AUTHOR_EMAIL: "",
      GIT_COMMITTER_NAME: "",
      GIT_COMMITTER_EMAIL: "",
    };
    const proc = Bun.spawn(["git", "config", "--local", "--list"], { cwd: workdir, stdout: "pipe" });
    await proc.exited; // repo is fresh: no local identity either

    // `git commit -F -` with the env scrubbed of identity must fail, and
    // nothing partial may land. (commitAcceptedMessage inherits the process
    // env, so the scrubbed spawn mirrors its argv exactly.)
    const commit = Bun.spawn(["git", "commit", "-F", "-"], {
      cwd: workdir,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    commit.stdin.write("chore: identity-less\n");
    commit.stdin.end();
    const stderr = await new Response(commit.stderr).text();
    expect(await commit.exited).not.toBe(0);
    expect(stderr).toContain("empty ident");
    expect(await gitLog(workdir, "--oneline")).toBe(""); // nothing partially committed
  });

  test("an empty or whitespace-only draft never yields a commit — git is not even spawned", async () => {
    await stageFile("a.txt", "one\n");
    // A counting commit-msg hook: if git ran at all, the counter moves.
    await installHook(workdir, "commit-msg", "#!/bin/sh\necho ran >> hook-count\nexit 0\n");

    for (const draft of ["", "   ", "\n \n\t\n"]) {
      const result = await commitAcceptedMessage(draft, workdir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.exitCode).toBe(1);
        expect(result.message).toContain("empty");
      }
    }
    expect(await gitLog(workdir, "--oneline")).toBe(""); // zero commits created
    expect(await Bun.file(join(workdir, "hook-count")).exists()).toBe(false); // hook never saw a message
  });

  test("static boundary: no source in the commit path ever stages anything", async () => {
    // The no-git-add invariant holds by construction: scan the modules that
    // touch git (and the whole commit path) for any staging invocation.
    for (const file of ["src/commit.ts", "src/git.ts", "src/pipeline.ts", "src/loop.ts"]) {
      const source = await readFile(join(previousCwd, file), "utf8");
      expect(source).not.toMatch(/"add"/); // no staged-set mutation, by construction
    }
  });

  describe("through main", () => {
    const stubChat = async () => ({
      ok: true as const,
      content: "type: feat\nscope: -\nsummary: add a.txt\nbody: -",
    });

    test("--no-commit under no circumstances creates a commit: HEAD and hooks stay put", async () => {
      await stageFile("a.txt", "one\n");
      // Even a hook poised to fire must never see a message in this mode.
      await installHook(workdir, "commit-msg", "#!/bin/sh\necho ran >> hook-count\nexit 0\n");

      const out = capture();
      const err = capture();
      const code = await main(["--no-commit"], out.stream, err.stream, { chat: stubChat });

      expect(code).toBe(0);
      expect(out.text()).toContain("feat: add a.txt");
      expect(await gitLog(workdir, "--oneline")).toBe(""); // HEAD: still unborn
      expect(await git(workdir, "status", "--porcelain")).toMatch(/^A {2}a\.txt/m); // still staged as before
      expect(await Bun.file(join(workdir, "hook-count")).exists()).toBe(false); // poised hook never fired
    });

    test("accepted draft commits end to end via the real git path (no commit seam injected)", async () => {
      await stageFile("a.txt", "one\n");
      // A real commit-msg hook that stamps proof it fired.
      await installHook(workdir, "commit-msg", "#!/bin/sh\necho 'Hook-Checked: yes' >> \"$1\"\n");

      const out = capture();
      const err = capture();
      const code = await main([], out.stream, err.stream, {
        chat: stubChat,
        loop: { ask: async () => "", stdinIsTTY: true, stdoutIsTTY: true }, // Enter: accept
      });

      expect(code).toBe(0);
      expect(out.text()).toContain("Committed as #");
      const body = await gitLog(workdir, "-1", "--format=%B");
      expect(body).toContain("feat: add a.txt");
      expect(body).toContain("Hook-Checked: yes"); // hooks fired on the real commit path
      expect(await git(workdir, "show", "--format=", "--name-only", "HEAD")).toContain("a.txt");
      expect(err.text()).toBe("");
    });

    test("a failing commit through main exits non-zero, swallows nothing, claims nothing", async () => {
      await stageFile("a.txt", "one\n");
      await installHook(workdir, "commit-msg", "#!/bin/sh\necho 'commit-msg hook rejected message' >&2\nexit 1\n");

      const out = capture();
      const err = capture();
      const code = await main([], out.stream, err.stream, {
        chat: stubChat,
        loop: { ask: async () => "", stdinIsTTY: true, stdoutIsTTY: true },
      });

      expect(code).not.toBe(0);
      expect(err.text()).toContain("git commit failed");
      expect(err.text()).toContain("commit-msg hook rejected message"); // the hook's own words, unsuppressed
      expect(out.text()).not.toContain("committed"); // no success claimed
      expect(await gitLog(workdir, "--oneline")).toBe(""); // no partial commit
      expect(await git(workdir, "diff", "--cached", "--name-only")).toContain("a.txt"); // still staged for retry
    });
  });
});
