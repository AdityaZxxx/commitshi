import { parseArgs, USAGE, type CliFlags } from "./cli.ts";
import { guardStagedChanges, recentCommitSubjects, stagedDiff } from "./git.ts";
import { isLocalBaseUrl, makeResolveApiKey, makeResolveKey, missingKeyMessage, type Deps } from "./config.ts";
import { DEFAULT_BASE_URL, generateDraft, type PipelineDeps } from "./pipeline.ts";
import { interactLoop, type AskKey, type DraftAttempt } from "./loop.ts";
import { commitAcceptedMessage, type CommitResult } from "./commit.ts";
import { runSetup } from "./setup.ts";

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
  /** Setup wizard seam for tests; production runs the real wizard. */
  setup?: (out: Pick<typeof process.stdout, "write">, err: Pick<typeof process.stderr, "write">) => Promise<{ exitCode: number }>;
  /** TTY seams for the setup trigger (tests); production reads process.isTTY. */
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
}>;

/**
 * True unless the flags + env alone make a usable bundle: a non-local URL
 * plus a key-bearing env var, or an explicitly local URL (no key needed),
 * with a model present. Used by the auto-trigger so a fully one-shot
 * invocation never detours into the wizard.
 */
function flagsCoverBundle(env: NodeJS.ProcessEnv, flags: CliFlags): boolean {
  if (flags.baseUrl === undefined) return false;
  if (isLocalBaseUrl(flags.baseUrl)) return true;
  return env.OPENAI_API_KEY !== undefined && env.OPENAI_API_KEY !== "";
}

/**
 * True unless the resolved config is usable as-is: a key via env for a
 * non-local endpoint, or a key in the config file for a non-local baseUrl,
 * or a resolved baseUrl that is itself local. The pipeline's own
 * OPENAI_BASE_URL fallback counts too. Mirrors the pipeline's key demand so
 * the wizard never opens where a draft could have been produced.
 */
async function configBundleUsable(env: NodeJS.ProcessEnv, config: Deps): Promise<boolean> {
  const resolveKey = makeResolveKey(config);
  const baseUrlR = await resolveKey("baseUrl");
  const baseUrl = baseUrlR?.value ?? env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL;
  if (isLocalBaseUrl(baseUrl)) return true;
  if (env.OPENAI_API_KEY !== undefined && env.OPENAI_API_KEY !== "") return true;
  const apiKeyR = await makeResolveApiKey(config)("openai");
  return apiKeyR !== null && apiKeyR.value !== "";
}

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

  const configDeps = deps.config ?? {};
  const configEnv = configDeps.env ?? process.env;

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

  // First-run auto-trigger (ticket 11): open the wizard BEFORE the staged
  // guard when the resolved bundle is unusable, but only on a real terminal.
  // A piped/CI run (the --no-commit contract) keeps the existing loud
  // refusal here, or falls through to the pipeline's own refusal otherwise.
  const stdinIsTTY = deps.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  const stdoutIsTTY = deps.stdoutIsTTY ?? Boolean(process.stdout.isTTY);
  if (stdinIsTTY && stdoutIsTTY && !flags.noCommit) {
    if (!flagsCoverBundle(configEnv, flags) && !(await configBundleUsable(configEnv, configDeps))) {
      if (deps.setup !== undefined) {
        const code = (await deps.setup(stdout, stderr)).exitCode;
        if (code !== 0) stderr.write(`${missingKeyMessage("openai")}\n`);
        return code;
      }
      const result = await runSetup(
        {
          env: deps.config?.env,
          configFilePath: deps.config?.configFilePath,
        },
        stdout,
        stderr,
      );
      if (result.exitCode !== 0) {
        stderr.write(`${missingKeyMessage("openai")}\n`);
        return 1;
      }
    }
  } else if (!flags.noCommit && !flagsCoverBundle(configEnv, flags) && !(await configBundleUsable(configEnv, configDeps))) {
    stderr.write(`${missingKeyMessage("openai")}\n`);
    return 1;
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
      ? { ok: true, draft: result.message, truncated: result.truncated, numstat: result.numstat }
      : { ok: false, exitCode: result.exitCode, message: result.message };

  const generate = (): Promise<Awaited<ReturnType<typeof generateDraft>>> =>
    generateDraft({
      stagedDiff: () => stagedDiff(),
      // Wire the history seam ONLY when the user opted in with --style:
      // flags.style && recentCommitSubjects — without the flag the dep is
      // absent and the no-history guarantee is structural, not a promise.
      styleHistory: flags.style ? () => recentCommitSubjects() : undefined,
      resolveKey: makeResolveKey(deps.config ?? {}),
      resolveApiKey: makeResolveApiKey(deps.config ?? {}),
      chat: deps.chat,
      flags: {
        model: flags.model,
        template: flags.template,
        provider: flags.provider,
        baseUrl: flags.baseUrl,
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
