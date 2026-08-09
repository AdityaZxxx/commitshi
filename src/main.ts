import { parseArgs, USAGE } from "./cli.ts";
import { guardStagedChanges, stagedDiff } from "./git.ts";
import { makeResolveApiKey, makeResolveKey } from "./config.ts";
import { generateDraft, type PipelineDeps } from "./pipeline.ts";

export type MainDeps = Readonly<{
  /** Overrides for the model call seam (tests); production uses the real adapter. */
  chat?: PipelineDeps["chat"];
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

  // Tracer bullet: full pipeline end to end. The interactive accept/edit/
  // regenerate loop and commit-via-stdin land in tickets 06/07; this ticket
  // proves the round trip, so we generate the draft and print it. Nothing is
  // ever staged, committed, or sent anywhere but the configured provider.
  const draft = await generateDraft({
    stagedDiff: () => stagedDiff(),
    resolveKey: makeResolveKey(),
    resolveApiKey: makeResolveApiKey(),
    chat: deps.chat,
    flags: { model: flags.model, template: flags.template, provider: flags.provider },
  });

  if (!draft.ok) {
    stderr.write(`${draft.message}\n`);
    return draft.exitCode;
  }

  if (draft.truncated) {
    stderr.write("commitshi: note — the staged diff exceeded the digest budget; the model saw a truncated digest\n");
  }

  stdout.write(`${draft.message}\n`);
  if (flags.noCommit) {
    return 0;
  }
  // The commit itself is ticket 08's job; the tracer bullet stops at the draft.
  stderr.write("commitshi: draft ready (commit via the interactive loop arrives in a later ticket)\n");
  return 0;
}
