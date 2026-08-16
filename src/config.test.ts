import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as config from "./config.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "commitshi-config-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("gitConfigGet", () => {
  test("extracts repo > global from a dump line and lowercases the key", async () => {
    const run = config.makeGitConfigGet(async (scope) =>
      scope === "repo" ? `commitshi.model\tgpt-repo` : `commitshi.model\tgpt-global`,
    );
    expect(await run("commitshi.model")).toEqual({ value: "gpt-repo", source: "repo git-config" });
    const repoless = config.makeGitConfigGet(async (scope) =>
      scope === "global" ? `commitshi.model\tgpt-global` : "",
    );
    expect(await repoless("COMMITSHI.MODEL")).toEqual({
      value: "gpt-global",
      source: "global git-config",
    });
    const missing = config.makeGitConfigGet(async () => "");
    expect(await missing("commitshi.model")).toBeNull();
  });
});

describe("resolveKey", () => {
  test("flag beats env, config file, and git config", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "config");
      await writeFile(file, "provider=openai\nmodel=file-model\n");
      const run = config.makeResolveKey({
        env: { COMMITSHI_MODEL: "env-model" },
        configFilePath: file,
        gitConfigGet: async () => ({ value: "git-model", source: "repo git-config" }),
      });
      expect(await run("model", { flags: { model: "flag-model" } })).toEqual({
        value: "flag-model",
        source: "flag",
      });
      expect(await run("model", {})).toEqual({ value: "env-model", source: "env" });
    });
  });

  test("config file beats repo git-config, which beats global git-config", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "config");
      await writeFile(file, "provider=anthropic\n");
      const run = config.makeResolveKey({
        env: {},
        configFilePath: file,
        gitConfigGet: async () => ({ value: "git-anthropic", source: "repo git-config" }),
      });
      expect(await run("provider", {})).toEqual({ value: "anthropic", source: "config file" });
    });
  });

  test("missing key resolves to null", async () => {
    await withTempDir(async (dir) => {
      const run = config.makeResolveKey({
        env: {},
        configFilePath: join(dir, "absent"),
        gitConfigGet: async () => null,
      });
      expect(await run("model", {})).toBeNull();
    });
  });

  test("missing config file is a soft no, not a crash", async () => {
    const run = config.makeResolveKey({
      env: {},
      configFilePath: "/definitely/not/here/commitshi/config",
      gitConfigGet: async () => null,
    });
    expect(await run("provider", {})).toBeNull();
  });
});

describe("resolveApiKey", () => {
  test("OPENAI_API_KEY wins over the config file for the openai provider", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "config");
      await writeFile(file, "openai_api_key=sk-file\n");
      const run = config.makeResolveApiKey({
        env: { OPENAI_API_KEY: "sk-env" },
        configFilePath: file,
        gitConfigGet: async () => null,
      });
      expect(await run("openai")).toEqual({ value: "sk-env", source: "env" });
    });
  });

  test("ANTHROPIC_API_KEY is read for the anthropic provider", async () => {
    const run = config.makeResolveApiKey({ env: { ANTHROPIC_API_KEY: "sk-ant" } });
    expect(await run("anthropic")).toEqual({ value: "sk-ant", source: "env" });
  });

  test("config file key is the fallback when the env var is absent", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "config");
      await writeFile(file, "anthropic_api_key=sk-ant-file\n");
      const run = config.makeResolveApiKey({ env: {}, configFilePath: file });
      expect(await run("anthropic")).toEqual({ value: "sk-ant-file", source: "config file" });
    });
  });

  test("a config file with only the other provider's key does not leak across providers", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "config");
      await writeFile(file, "openai_api_key=sk-openai\n");
      const run = config.makeResolveApiKey({ env: {}, configFilePath: file });
      expect(await run("anthropic")).toBeNull();
    });
  });

  test("no key anywhere explains the fix and names the env var", async () => {
    const err = config.missingKeyMessage("openai");
    expect(err).toContain("OPENAI_API_KEY");
    expect(err).toContain("~/.config/commitshi/config");
  });
});

describe("resolveBundle", () => {
  test("resolves all four keys in one pass, honoring flag > env > file > git per key", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "config");
      await writeFile(file, "model=file-model\ntemplate={summary}\n");
      const bundle = await config.resolveBundle(
        {
          env: { COMMITSHI_MODEL: "env-model" },
          configFilePath: file,
          gitConfigGet: async () => ({ value: "git-scope", source: "repo git-config" }),
        },
        { model: "flag-model", provider: "flag-provider" },
      );
      // flag wins
      expect(bundle.model).toEqual({ value: "flag-model", source: "flag" });
      expect(bundle.provider).toEqual({ value: "flag-provider", source: "flag" });
      // env wins over file/git when the flag is absent
      expect(bundle.baseUrl).toEqual({ value: "git-scope", source: "repo git-config" });
      // file wins over git when neither flag nor env is set
      expect(bundle.template).toEqual({ value: "{summary}", source: "config file" });
    });
  });

  test("absent keys are simply not present — the caller substitutes defaults", async () => {
    await withTempDir(async (dir) => {
      const bundle = await config.resolveBundle(
        { env: {}, configFilePath: join(dir, "absent"), gitConfigGet: async () => null },
        {},
      );
      expect(bundle.model).toBeUndefined();
      expect(bundle.baseUrl).toBeUndefined();
      expect(bundle.provider).toBeUndefined();
      expect(bundle.template).toBeUndefined();
    });
  });

  test("env precedence per key, not globally — model from env, provider from file", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "config");
      await writeFile(file, "provider=anthropic\nmodel=file-model\n");
      const bundle = await config.resolveBundle(
        {
          env: { COMMITSHI_MODEL: "env-model" },
          configFilePath: file,
          gitConfigGet: async () => null,
        },
        {},
      );
      expect(bundle.provider).toEqual({ value: "anthropic", source: "config file" });
      expect(bundle.model).toEqual({ value: "env-model", source: "env" });
    });
  });
});
