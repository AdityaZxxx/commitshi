// Configuration resolution for commitshi.
//
// Precedence for every named key, first match wins:
//   flag > env > ~/.config/commitshi/config > repo git-config > global git-config
//
// API keys deliberately stop at the config file: keys live in standard
// provider env vars (OPENAI_API_KEY / ANTHROPIC_API_KEY) or the plaintext
// file, never in git config (they would leak into .git/config and backups).

import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type Source = "flag" | "env" | "config file" | "repo git-config" | "global git-config";
export type Resolved = Readonly<{ value: string; source: Source }>;
export type Provider = "openai" | "anthropic";

export function defaultConfigFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_CONFIG_HOME
    ? join(env.XDG_CONFIG_HOME, "commitshi", "config")
    : join(homedir(), ".config", "commitshi", "config");
}

/** Injected seams keep the resolution logic unit-testable; production wires real IO. */
export type Deps = Readonly<{
  env?: NodeJS.ProcessEnv;
  configFilePath?: string;
  gitConfigGet?: GitConfigGet;
}>;

export type GitConfigGet = (key: string) => Promise<Readonly<{ value: string; source: Source }> | null>;

/** Reads one key from git config, repo scope preferred over global. */
export const makeGitConfigGet =
  (dump: (scope: "repo" | "global") => Promise<string>): GitConfigGet =>
  async (key) => {
    const wanted = key.toLowerCase();
    for (const scope of ["repo", "global"] as const) {
      let text: string;
      try {
        text = await dump(scope);
      } catch {
        continue; // e.g. `git config --local` outside a repo -> exit 128
      }
      for (const line of text.split("\n")) {
        const tab = line.indexOf("\t");
        if (tab === -1) continue;
        if (line.slice(0, tab).trim().toLowerCase() === wanted) {
          return { value: line.slice(tab + 1), source: scope === "repo" ? "repo git-config" : "global git-config" };
        }
      }
    }
    return null;
  };

async function dumpGitConfig(scope: "repo" | "global"): Promise<string> {
  const args = scope === "repo" ? ["config", "--local", "--list"] : ["config", "--global", "--list"];
  const { stdout } = await execFileAsync("git", args);
  return stdout;
}

const liveGitConfigGet: GitConfigGet = makeGitConfigGet(dumpGitConfig);

/** Minimal key=value parser; comments (#) and blank lines ignored. */
async function readConfigFile(path: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    return map; // absent or unreadable file is a soft "no value here"
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (!map.has(key)) map.set(key, value);
  }
  return map;
}

/** Resolves a named config key through the full precedence chain. */
export const makeResolveKey =
  (deps: Deps = {}) =>
  async (
    key: string,
    opts: { flags?: Partial<Record<string, string | undefined>> } = {},
  ): Promise<Resolved | null> => {
    const env = deps.env ?? process.env;
    const gitConfigGet = deps.gitConfigGet ?? liveGitConfigGet;

    const fromFlag = opts.flags?.[key];
    if (fromFlag !== undefined && fromFlag !== "") {
      return { value: fromFlag, source: "flag" };
    }

    const envName = `COMMITSHI_${key.toUpperCase().replace(/-/g, "_")}`;
    const fromEnv = env[envName];
    if (fromEnv !== undefined && fromEnv !== "") {
      return { value: fromEnv, source: "env" };
    }

    const file = await readConfigFile(deps.configFilePath ?? defaultConfigFilePath(env));
    const fromFile = file.get(key.toLowerCase());
    if (fromFile !== undefined && fromFile !== "") {
      return { value: fromFile, source: "config file" };
    }

    return gitConfigGet(`commitshi.${key.toLowerCase()}`);
  };

const PROVIDER_ENV: Readonly<Record<Provider, string>> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

/**
 * Resolves the API key for a provider. Intentionally does NOT consult git
 * config — see module docstring.
 */
export const makeResolveApiKey =
  (deps: Deps = {}) =>
  async (provider: Provider): Promise<Resolved | null> => {
    const env = deps.env ?? process.env;
    const envName = PROVIDER_ENV[provider];

    const fromEnv = env[envName];
    if (fromEnv !== undefined && fromEnv !== "") {
      return { value: fromEnv, source: "env" };
    }

    const file = await readConfigFile(deps.configFilePath ?? defaultConfigFilePath(env));
    const fromFile = file.get(`${provider}_api_key`);
    if (fromFile !== undefined && fromFile !== "") {
      return { value: fromFile, source: "config file" };
    }

    return null;
  };

/** The first-run tip shown when no API key can be found anywhere. */
export function missingKeyMessage(provider: Provider): string {
  const envName = PROVIDER_ENV[provider];
  return [
    `commitshi: no API key found for provider "${provider}"`,
    "",
    "Set one of:",
    `  export ${envName}=...            # environment variable`,
    `  ${provider.toLowerCase()}_api_key=... in ~/.config/commitshi/config   # plaintext file`,
    "",
    "Get a key from your provider, then re-run commitshi.",
  ].join("\n");
}
