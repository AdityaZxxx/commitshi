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

    test("repo with staged changes reaches the pipeline entry without crashing", async () => {
      await git(workdir, "init", "-q");
      await writeFile(join(workdir, "a.txt"), "one\n");
      await git(workdir, "add", "a.txt");

      const out = capture();
      const err = capture();
      const code = await main([], out.stream, err.stream);
      // Generation lands in ticket 05; the scaffold just has to get here gracefully.
      expect(out.text()).toContain("not implemented");
      expect(err.text()).not.toContain("nothing staged");
      expect(err.text()).not.toContain("not a git repository");
    });
  });
});
