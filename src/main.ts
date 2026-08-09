import { parseArgs, USAGE } from "./cli.ts";
import { guardStagedChanges, recentCommitSubjects, stagedDiff } from "./git.ts";
import { makeResolveApiKey, makeResolveKey } from "./config.ts";
import { generateDraft, type PipelineDeps } from "./pipeline.ts";
import { interactLoop, type AskKey, type DraftAttempt } from "./loop.ts";
import { commitAcceptedMessage, type CommitResult } from "./commit.ts";

export type MainDeps = Readonly<{
  /** Overrides for the model call seam (tests); production uses the real adapter. */
  chat?: PipelineDeps["chat"];
  /** Loop seams for tests: scripted keys + TTY overrides. */
  loop?: Readonly<{
    ask?: AskKey;
    stdinIsTTY?: boolean;
    stdoutIsTTY?: boolean;
    env?: NodeJS.ProcessEnv;
    spawn?: (editor: string, path: string) => Promise<number>;
  }>;
  /** Commit seam for tests; production runs `git commit -F -` in the cwd. */
  commit?: (message: string) => Promise<CommitResult>;
}>;

/** Runs the CLI. Each stage returns the process exit code; main() applies it. */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  stdout: Pick<typeof process.stdout, "write"> = process.stdout,
  stderr: Pick<typeof process.stderr, "write"> = process.stderr,
  deps: MainDeps = {},
): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    stderr.write(`commitshi: error: ${parsed.error}\n\n${USAGE}`);
    return 2;
  }

  const { flags } = parsed;
  if (flags.help) {
    stdout.write(USAGE);
    return 0;
  }

  let guard;
  try {
    guard = await guardStagedChanges();
  } catch (error) {
    stderr.write(`commitshi: error: ${(error as Error).message}\n`);
    return 1;
  }
  if (!guard.ok) {
    stderr.write(`${guard.reason}\n`);
    return guard.exitCode;
  }

  // Generate the first commit draft. The provider call and git reads are the
  // only IO; the model is the only stage that can fail here.
  const attemptFrom = (
    result: Awaited<ReturnType<typeof generateDraft>>,
  ): DraftAttempt =>
    result.ok
      ? { ok: true, draft: result.message, truncated: result.truncated }
      : { ok: false, exitCode: result.exitCode, message: result.message };

  const generate = (): Promise<Awaited<ReturnType<typeof generateDraft>>> =>
    generateDraft({
      stagedDiff: () => stagedDiff(),
      // Wire the history seam ONLY when the user opted in with --style:
      // flags.style && recentCommitSubjects — without the flag the dep is
      // absent and the no-history guarantee is structural, not a promise.
      styleHistory: flags.style ? () => recentCommitSubjects() : undefined,
      resolveKey: makeResolveKey(),
      resolveApiKey: makeResolveApiKey(),
      chat: deps.chat,
      flags: {
        model: flags.model,
        template: flags.template,
        provider: flags.provider,
        instructions: flags.instructions,
      },
    });

  const first = attemptFrom(await generate());

  // --no-commit stays headless: print the finished message and exit with no
  // interaction, exactly as ticket 05 locked in. A truncated digest is still
  // disclosed; a failed draft fails loud.
  if (flags.noCommit) {
    if (!first.ok) {
      stderr.write(`${first.message}\n`);
      return first.exitCode;
    }
    if (first.truncated) {
      stderr.write("commitshi: note — the staged diff exceeded the digest budget; the model saw a truncated digest\n");
    }
    stdout.write(`${first.draft}\n`);
    return 0;
  }

  // Interactive stage: the accept / edit / regenerate loop. The accepted
  // draft crosses the stage boundary into the commit stage below.
  const loopDeps = deps.loop;
  const outcome = await interactLoop(first, {
    stdin: process.stdin,
    stdout,
    stderr,
    stdinIsTTY: loopDeps?.stdinIsTTY,
    stdoutIsTTY: loopDeps?.stdoutIsTTY,
    env: loopDeps?.env,
    // The editor must see the real stdio, so tests inject their own spawn.
    spawn: loopDeps?.spawn,
    ask: loopDeps?.ask,
    // Regenerate re-runs the SAME pipeline against the SAME unchanged staged
    // diff: stagedDiff() is read fresh, but the staged set is untouched.
    regenerate: async () => attemptFrom(await generate()),
  });

  if (!outcome.ok) {
    stderr.write(`${outcome.message}\n`);
    return outcome.exitCode;
  }
  if (outcome.action === "cancel") {
    stderr.write("commitshi: canceled — no commit was made\n");
    return 0;
  }

  // Accepted. The commit stage runs `git commit -F -` with the draft on
  // stdin so the user's hooks and signing fire exactly as on a hand-typed
  // commit. The tool never stages anything, and a failing commit exits
  // non-zero with git's own message — no swallowed draft, no claimed
  // success.
  const committed = await (deps.commit ?? ((message: string) => commitAcceptedMessage(message)))(outcome.draft);
  if (!committed.ok) {
    stderr.write(`${committed.message}\n`);
    return committed.exitCode;
  }
  stdout.write("commitshi: committed\n");
  return 0;
}
