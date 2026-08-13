export type CliFlags = Readonly<{
  help: boolean;
  setup: boolean;
  noCommit: boolean;
  style: boolean;
  /** One-shot endpoint override (kebab flag --base-url -> camel key). */
  baseUrl?: string;
  instructions?: string;
  template?: string;
  provider?: string;
  model?: string;
}>;

export type ParseResult =
  | Readonly<{ ok: true; flags: CliFlags }>
  | Readonly<{ ok: false; error: string }>;

const FLAG_COL = 24;
const flagLine = (name: string, desc: string): string => `    ${name.padEnd(FLAG_COL)}${desc}`;

export const USAGE = `commitshi — commit messages from staged changes

USAGE:
    commitshi [flags]

FLAGS:
${flagLine("--setup", "Run the setup wizard and exit")}
${flagLine("--no-commit", "Print the draft and exit without committing")}
${flagLine("--base-url <url>", "Override the API endpoint for this run")}
${flagLine("--instructions \"<text>\"", "Steer the model for this run; outranks the template")}
${flagLine("--style", "Add last ~8 commit subjects (opt-in; otherwise history is never read)")}
${flagLine("--template \"<string>\"", "Override the commit template for this run")}
${flagLine("--provider <name>", "Override the provider for this run")}
${flagLine("--model <name>", "Override the model for this run")}
${flagLine("-h, --help", "Show this help")}

Reads only staged changes; never stages anything.
`;

const VALUE_FLAGS: Readonly<Record<string, keyof CliFlags>> = {
  "--base-url": "baseUrl",
  "--instructions": "instructions",
  "--template": "template",
  "--provider": "provider",
  "--model": "model",
};

const BOOLEAN_FLAGS: Readonly<Record<string, keyof CliFlags>> = {
  "--no-commit": "noCommit",
  "--style": "style",
  "--setup": "setup",
  "--help": "help",
  "-h": "help",
};

export function parseArgs(args: readonly string[]): ParseResult {
  const flags: Record<keyof Pick<CliFlags, "help" | "setup" | "noCommit" | "style">, boolean> &
    Partial<Record<"baseUrl" | "instructions" | "template" | "provider" | "model", string>> = {
    help: false,
    setup: false,
    noCommit: false,
    style: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    const valueName = VALUE_FLAGS[arg];
    if (valueName !== undefined) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { ok: false, error: `flag ${arg} requires a value` };
      }
      flags[valueName as "baseUrl"] = value;
      i++;
      continue;
    }

    const boolName = BOOLEAN_FLAGS[arg];
    if (boolName !== undefined) {
      (flags as Record<string, boolean>)[boolName] = true;
      continue;
    }

    return { ok: false, error: `unknown flag: ${arg}` };
  }

  return { ok: true, flags: flags as CliFlags };
}
