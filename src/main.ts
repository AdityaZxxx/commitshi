import { parseArgs, USAGE, type CliFlags } from "./cli.ts";
import { guardStagedChanges, recentCommitSubjects, stagedDiff } from "./git.ts";
import { makeResolveApiKey, resolveBundle, type Deps } from "./config.ts";
import { DEFAULT_BASE_URL, generateDraft, reviseDraft, setRegenerateTemperatureOverride, type PipelineDeps } from "./pipeline.ts";
import { interactLoop, type AskKey, type DraftAttempt } from "./loop.ts";
import { commitAcceptedMessage, type CommitResult } from "./commit.ts";
import { runSetup } from "./setup.ts";
import { startLoader } from "./loader.ts";
import { execSync } from "node:child_process";

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
  /** Config seams for tests; production resolves env + the default file path. */
  config?: Deps;
  /** Wizard body seam (tests): replaces the wizard outright, standalone and mid-run. */
  setup?: (out: Pick<typeof process.stdout, "write">, err: Pick<typeof process.stderr, "write">) => Promise<{ exitCode: number }>;
  /** Wizard option seam: replaces the options runSetup receives when the
   *  pipeline reports a missing key mid-run (tests inject nextLine etc.). */
  setupInput?: Parameters<typeof runSetup>[0];
  /** TTY seams for the setup trigger (tests); production reads process.isTTY. */
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
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

  // --setup: force the wizard standalone — no git repo, no staged guard.
  if (flags.setup) {
    if (deps.setup !== undefined) {
      return (await deps.setup(stdout, stderr)).exitCode;
    }
    const result = await runSetup(
      {
        env: deps.config?.env,
        configFilePath: deps.config?.configFilePath,
        stdinIsTTY: deps.stdinIsTTY,
        stdoutIsTTY: deps.stdoutIsTTY,
      },
      stdout,
      stderr,
    );
    return result.exitCode;
  }

  const stdinIsTTY = deps.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  const stdoutIsTTY = deps.stdoutIsTTY ?? Boolean(process.stdout.isTTY);
  const configEnv = deps.config?.env ?? process.env;

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
      ? { ok: true, draft: result.message, truncated: result.truncated, numstat: result.numstat }
      : { ok: false, exitCode: result.exitCode, message: result.message };

  const runPipeline = (): ReturnType<typeof generateDraft> =>
    generateDraft({
      stagedDiff: () => stagedDiff(),
      // Wire the history seam ONLY when the user opted in with --style:
      // flags.style && recentCommitSubjects — without the flag the dep is
      // absent and the no-history guarantee is structural, not a promise.
      styleHistory: flags.style ? () => recentCommitSubjects() : undefined,
      resolveBundle: (f) => resolveBundle(deps.config ?? {}, f),
      resolveApiKey: makeResolveApiKey(deps.config ?? {}),
      env: configEnv,
      chat: deps.chat,
      flags: {
        model: flags.model,
        template: flags.template,
        provider: flags.provider,
        baseUrl: flags.baseUrl,
        instructions: flags.instructions,
      },
    });

  // Generate the first draft. Key demand is the pipeline's call, reported
  // as a draft result; main's only job is mapping the missing-key variant:
  // interactive TTY (and not --no-commit) → run the wizard, draft once more;
  // otherwise the result's message is printed and its exit code used.
  const firstLoader = startLoader('generating draft…', (s) => stdout.write(s), stdoutIsTTY);
  let firstResult: Awaited<ReturnType<typeof runPipeline>>;
  try {
    firstResult = await runPipeline();
  } finally {
    firstLoader.stop();
  }
  if (!firstResult.ok && firstResult.kind === "missing-key" && !flags.noCommit && stdinIsTTY && stdoutIsTTY) {
    const code =
      deps.setup !== undefined
        ? (await deps.setup(stdout, stderr)).exitCode
        : (
            await runSetup(
              deps.setupInput ?? { env: deps.config?.env, configFilePath: deps.config?.configFilePath },
              stdout,
              stderr,
            )
          ).exitCode;
    if (code !== 0) return code;
    firstResult = await runPipeline();
  }
  const first = attemptFrom(firstResult);

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
    stdinIsTTY: loopDeps?.stdinIsTTY ?? stdinIsTTY,
    stdoutIsTTY: loopDeps?.stdoutIsTTY ?? stdoutIsTTY,
    env: loopDeps?.env,
    // The editor must see the real stdio, so tests inject their own spawn.
    spawn: loopDeps?.spawn,
    ask: loopDeps?.ask,
    // Regenerate re-runs the SAME pipeline against the SAME unchanged staged
    // diff: stagedDiff() is read fresh, but the staged set is untouched.
    regenerate: async () => {
      setRegenerateTemperatureOverride(0.3);
      try {
        return attemptFrom(await runPipeline());
      } finally {
        setRegenerateTemperatureOverride(null);
      }
    },
    revise: async (draft: string, instruction: string) => {
      const result = await reviseDraft(
        {
          stagedDiff: () => stagedDiff(),
          styleHistory: flags.style ? () => recentCommitSubjects() : undefined,
          resolveBundle: (f) => resolveBundle(deps.config ?? {}, f),
          resolveApiKey: makeResolveApiKey(deps.config ?? {}),
          env: configEnv,
          chat: deps.chat,
          flags: {
            model: flags.model,
            template: flags.template,
            provider: flags.provider,
            baseUrl: flags.baseUrl,
            instructions: flags.instructions,
          },
        },
        draft,
        instruction,
      );
      return result.ok
        ? { ok: true, draft: result.message, truncated: result.truncated, numstat: result.numstat }
        : { ok: false, exitCode: result.exitCode, message: result.message };
    },
  });

  if (!outcome.ok) {
    stderr.write(`\n${outcome.message}\n`);
    return outcome.exitCode;
  }
  if (outcome.action === "cancel") {
    stderr.write("\n✕ Commit canceled — no changes were committed. Run commitshi again to retry\n");
    return 0;
  }

  // Accepted. The commit stage runs `git commit -F -` with the draft on
  // stdin so the user's hooks and signing fire exactly as on a hand-typed
  // commit. The tool never stages anything, and a failing commit exits
  // non-zero with git's own message — no swallowed draft, no claimed
  // success.
  const committed = await (deps.commit ?? ((message: string) => commitAcceptedMessage(message)))(outcome.draft);
  if (!committed.ok) {
    stderr.write(`\n${committed.message}\n`);
    return committed.exitCode;
  }

  // Get short hash for the just-created commit
  let shortHash = "";
  try {
    shortHash = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    /* ignore */
  }
  const subject = outcome.draft.split("\n").find(l => l.trim() !== "") ?? "";
  stdout.write(`\nCommitted as #${shortHash}\n`);
  if (subject) {
    stdout.write(`${subject}\n`);
  }
  return 0;
}
