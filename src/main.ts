import { parseArgs, USAGE } from "./cli.ts";
import { hasStagedChanges } from "./git.ts";

/** Runs the CLI. Each stage returns the process exit code; main() applies it. */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  stdout: Pick<typeof process.stdout, "write"> = process.stdout,
  stderr: Pick<typeof process.stderr, "write"> = process.stderr,
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

  let staged: boolean;
  try {
    staged = await hasStagedChanges();
  } catch (error) {
    stderr.write(`commitshi: error: ${(error as Error).message}\n`);
    return 1;
  }
  if (!staged) {
    stderr.write("commitshi: nothing staged — stage changes with git add, then run commitshi\n");
    return 1;
  }

  // Downstream pipeline (generation, edit loop, commit) lands in later tickets.
  stdout.write("commitshi: commit message generation is not implemented yet\n");
  return 1;
}
