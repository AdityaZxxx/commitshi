// The setup wizard — the tool's ONE config-write path (ticket 11).
//
// License: config-write seam (ticket 11) — this module is the only shipped
// code allowed to write ~/.config/commitshi/config; the static scan in
// setup.test.ts enforces it (every other file mentioning a config-writing
// call is a finding). The wizard exists to get a fresh user to "stage, run
// commitshi, commit" and is then invisible for the life of the tool.
//
// It writes exactly the lowercase keys resolution already reads — baseurl,
// model, openai_api_key — in the TOML-compatible `key = value` syntax
// readConfigFile parses. Keys never go anywhere near git config. Both entry
// points — `commitshi --setup` (standalone, works outside a git repo) and
// the auto-trigger (main fires it pre-staging on a TTY when the resolved
// bundle is unusable) — run this one body, so behavior can't drift.

import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  defaultConfigFilePath,
  formatConfigFile,
  isLocalBaseUrl,
  readConfigFile,
  updateConfigText,
} from "./config.ts";
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from "./pipeline.ts";

/** One line of wizard input; "" for Enter, null on EOF. */
export type NextLine = () => Promise<string | null>;

export type SetupDeps = Readonly<{
  /** TTY seams so tests drive the wizard without a pty. */
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  /** Environment seam; also selects the default config path. */
  env?: NodeJS.ProcessEnv;
  /** Line source seam; production reads one line at a time off stdin. */
  nextLine?: NextLine;
  /** Prefill/write target; defaults to defaultConfigFilePath(env). */
  configFilePath?: string;
}>;

export type SetupResult = Readonly<{ exitCode: 0 | 1 | 2 }>;

/** The keys the wizard owns, in write order; never persisted provider. */
const OWNED_KEYS: readonly string[] = ["baseurl", "model", "openai_api_key"];

/**
 * Production line source. Blank reads as ""; characters echo normally — the
 * file on disk is plaintext either way, so masking would be ceremony
 * without benefit. Completed lines are queued (never dropped) so paste-ahead
 * input survives across all three questions. Ctrl-C delivers its default
 * interrupt; nothing is written before the final write below.
 */
function makeLineReader(stdin: NodeJS.ReadStream): { nextLine: NextLine; close: () => void } {
  const queue: string[] = [];
  let partial = "";
  let closed = false;
  let waiter: ((line: string | null) => void) | null = null;

  const push = (line: string) => {
    const w = waiter;
    waiter = null;
    if (w !== null) w(line);
    else queue.push(line);
  };

  const onData = (chunk: Buffer | string) => {
    partial += chunk.toString();
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) push(line.replace(/\r$/, ""));
  };
  const onEnd = () => {
    if (partial !== "") push(partial);
    closed = true;
    const w = waiter;
    waiter = null;
    if (w !== null) w(queue.length > 0 ? queue.shift()! : null);
  };

  stdin.resume();
  stdin.on("data", onData);
  stdin.once("end", onEnd);

  const nextLine: NextLine = () => {
    if (queue.length > 0) return Promise.resolve(queue.shift()!);
    if (closed) return Promise.resolve(null);
    return new Promise<string | null>((resolve) => {
      waiter = resolve;
    });
  };
  const close = () => {
    stdin.removeListener("data", onData);
    stdin.removeListener("end", onEnd);
    stdin.pause();
  };

  return { nextLine, close };
}

/** One field: "label [current]: "; blank accepts the shown value; null is EOF. */
async function askField(
  stdout: Pick<NodeJS.WriteStream, "write">,
  nextLine: NextLine,
  label: string,
  current: string,
): Promise<string | null> {
  stdout.write(`  ${label} [${current}]: `);
  const answer = await nextLine();
  if (answer === null) return null;
  const trimmed = answer.trim();
  return trimmed === "" ? current : trimmed;
}

/**
 * Runs the wizard. Three fields, Enter accepts the default/prefill:
 * base URL (must be an http(s) URL — re-prompts otherwise), API key (blank
 * allowed ONLY for a local endpoint; a non-local URL with no key refuses
 * loudly and re-prompts), model. On a re-run over an existing bundle the
 * current values prefill and the write happens only on an explicit y.
 */
export async function runSetup(
  opts: SetupDeps = {},
  stdout: Pick<typeof process.stdout, "write"> = process.stdout,
  stderr: Pick<typeof process.stderr, "write"> = process.stderr,
): Promise<SetupResult> {
  const stdinIsTTY = opts.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  const stdoutIsTTY = opts.stdoutIsTTY ?? Boolean((stdout as NodeJS.WriteStream).isTTY);
  if (!stdinIsTTY || !stdoutIsTTY) {
    stderr.write(
      "commitshi: setup needs an interactive terminal (stdin and stdout must both be TTYs)\n" +
      "  Set the config non-interactively instead: export OPENAI_API_KEY=..., or edit ~/.config/commitshi/config\n",
    );
    return { exitCode: 1 };
  }

  const env = opts.env ?? process.env;
  const path = opts.configFilePath ?? defaultConfigFilePath(env);
  const existing = await readConfigFile(path);
  const existingText = await readFile(path, "utf8")
    .catch(() => ""); // absent file is a fresh write, not an error

  const currentUrl = existing.get("baseurl") ?? DEFAULT_BASE_URL;
  const currentKey = existing.get("openai_api_key") ?? "";
  const currentModel = existing.get("model") ?? DEFAULT_MODEL;

  const injected = opts.nextLine;
  const reader = injected !== undefined ? { nextLine: injected, close: () => {} } : makeLineReader(process.stdin);
  const { nextLine } = reader;

  const abort = (): SetupResult => {
    reader.close();
    stderr.write("commitshi: input closed — setup aborted; config not written\n");
    return { exitCode: 1 };
  };

  stdout.write(`commitshi setup — writing API config to ${path}\n`);
  stdout.write(
    "Press Enter to accept the default shown in brackets; existing values prefill. Press Ctrl-C to abort.\n\n",
  );

  // 1. Base URL — must be a parseable http(s) URL; refuse + re-prompt otherwise.
  let baseUrl: string;
  for (;;) {
    const answer = await askField(stdout, nextLine, "Base URL", currentUrl);
    if (answer === null) return abort();
    let protocol: string;
    try {
      protocol = new URL(answer).protocol;
    } catch {
      stdout.write("  That doesn't look like a URL — try again (e.g. http://localhost:11434/v1)\n");
      continue;
    }
    if (protocol !== "http:" && protocol !== "https:") {
      stdout.write("  Only http(s) endpoints are supported — try again\n");
      continue;
    }
    baseUrl = answer;
    break;
  }

  // 2. API key — blank is fine ONLY for a local endpoint (Ollama & friends
  // serve without one); a non-local URL with no key can never make a call, so
  // saving one would strand the user exactly where they started.
  let apiKey: string;
  if (isLocalBaseUrl(baseUrl)) {
    const answer = await askField(stdout, nextLine, "API key (blank allowed for local endpoints)", currentKey);
    if (answer === null) return abort();
    if (answer !== "") {
      stdout.write("  note: a key is never sent to local endpoints — it is stored for future non-local use\n");
    }
    apiKey = answer;
  } else {
    for (;;) {
      const answer = await askField(stdout, nextLine, "API key", currentKey);
      if (answer === null) return abort();
      if (answer === "") {
        stdout.write(`  A non-local endpoint (${baseUrl}) needs an API key — enter one, or press Ctrl-C to abort\n`);
        continue;
      }
      apiKey = answer;
      break;
    }
  }

  // 3. Model — the default is pinned, so this can never come back blank.
  const modelAnswer = await askField(stdout, nextLine, "Model", currentModel);
  if (modelAnswer === null) return abort();
  const model = modelAnswer;

  const entries: Array<readonly [string, string]> = [
    ["baseurl", baseUrl],
    ["model", model],
  ];
  if (apiKey !== "") entries.push(["openai_api_key", apiKey]);

  // Re-run over an existing bundle: hand-edit users see what they had, and
  // the overwrite needs an explicit yes — never a silent clobber.
  const hasPriorBundle = OWNED_KEYS.some((key) => existing.get(key) !== undefined);
  if (hasPriorBundle) {
    stdout.write("\nExisting values in the config file:\n");
    const prior: Record<string, string> = {};
    for (const key of OWNED_KEYS) {
      const value = existing.get(key);
      if (value !== undefined) prior[key] = value;
    }
    stdout.write(formatConfigFile(prior));
  }

  stdout.write("\nAbout to write:\n");
  stdout.write(formatConfigFile(Object.fromEntries(entries)));

  if (hasPriorBundle) {
    for (;;) {
      stdout.write("Overwrite with these values? [y/N]: ");
      const answer = await nextLine();
      if (answer === null) return abort();
      const a = answer.trim().toLowerCase();
      if (a === "y" || a === "yes") break;
      if (a === "n" || a === "no" || a === "") {
        reader.close();
        stdout.write("commitshi: setup canceled — existing config left untouched\n");
        return { exitCode: 0 };
      }
      stdout.write('  Answer "y" to overwrite or "n" to keep the file as-is\n');
    }
  }

  const text = existingText === "" ? formatConfigFile(Object.fromEntries(entries)) : updateConfigText(existingText, entries);
  try {
    await mkdir(dirname(path), { recursive: true });
    // The single write: this is the only place in shipped code a config file lands.
    await writeFile(path, text, "utf8");
  } catch (error) {
    reader.close();
    stderr.write(`commitshi: could not write ${path}: ${(error as Error).message} — config not written\n`);
    return { exitCode: 1 };
  }

  reader.close();
  stdout.write(`commitshi: wrote ${path}\n`);
  return { exitCode: 0 };
}
