import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installOpenCode, restoreOpenCode } from "../src/opencode-install";

describe("installOpenCode", () => {
  it("previews OpenCode provider config without writing in dry-run mode", async () => {
    const root = join(tmpdir(), `kyoli-opencode-install-${Date.now()}-dry`);
    const configDir = join(root, "opencode");
    const env = createOpenCodeTestEnv(root);
    const fetchImpl = createModelsFetch();

    const result = await installOpenCode(
      { host: "127.0.0.1", port: 2021 },
      { configDir, dryRun: true, fetch: fetchImpl, env },
    );

    expect(result.dryRun).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.modelSource).toBe("gateway");
    expect(result.authChanged).toBe(true);
    expect(result.providers).toEqual([
      {
        id: "openai",
        baseURL: "http://127.0.0.1:2021/v1",
        modelCount: 1,
        modelIds: ["gpt-5.3-codex"],
      },
      {
        id: "anthropic",
        baseURL: "http://127.0.0.1:2021/v1",
        modelCount: 1,
        modelIds: ["claude-sonnet-5"],
      },
    ]);
    expect(result.diagnostics).toMatchObject({
      mode: "unconfigured",
      openAIAuth: "missing",
      selectedModels: ["openai/gpt-5.3-codex", "anthropic/claude-sonnet-5"],
    });
    await expect(stat(join(configDir, "opencode.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes OpenCode config and backs up existing files", async () => {
    const root = join(tmpdir(), `kyoli-opencode-install-${Date.now()}-write`);
    const configDir = join(root, "opencode");
    const env = createOpenCodeTestEnv(root);
    const configPath = join(configDir, "opencode.json");
    const authPath = join(root, "data", "opencode", "auth.json");
    await mkdir(configDir, { recursive: true });
    await mkdir(join(root, "data", "opencode"), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        provider: {
          openai: {
            options: { baseURL: "https://api.openai.com/v1", apiKey: "existing" },
            models: {
              "gpt-5.3-codex": { name: "User custom model" },
            },
          },
        },
      }),
    );
    await writeFile(
      authPath,
      JSON.stringify({
        openai: { type: "oauth", access: "access-test", refresh: "refresh-test" },
        anthropic: { type: "oauth", access: "anthropic-test", refresh: "anthropic-refresh" },
      }),
    );

    const result = await installOpenCode(
      { host: "127.0.0.1", port: 2021 },
      { configDir, fetch: createModelsFetch(), env },
    );
    const written = JSON.parse(await readFile(configPath, "utf8")) as Record<string, any>;
    const writtenAuth = JSON.parse(await readFile(authPath, "utf8")) as Record<string, any>;

    expect(result.backupPath).toBeTruthy();
    expect(result.authBackupPath).toBeTruthy();
    expect(written.provider.openai.options.baseURL).toBe("http://127.0.0.1:2021/v1");
    expect(written.provider.openai.options.apiKey).toBe("existing");
    expect(written.provider.openai.models["gpt-5.3-codex"].name).toBe("User custom model");
    expect(written.provider.anthropic.options.baseURL).toBe("http://127.0.0.1:2021/v1");
    expect(written.provider.anthropic.models["claude-sonnet-5"].name).toContain("via kyoli-gam");
    expect(writtenAuth.openai).toEqual({ type: "api", key: "kyoli-local" });
    expect(writtenAuth.anthropic.type).toBe("oauth");
    expect(result.warnings.some((warning) => warning.includes("preserved existing model config"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("OpenCode auth.openai OAuth"))).toBe(true);
  });


  it("reports existing plugin/server mode diagnostics", async () => {
    const root = join(tmpdir(), `kyoli-opencode-install-${Date.now()}-diagnostics`);
    const configDir = join(root, "opencode");
    const env = createOpenCodeTestEnv(root);
    await mkdir(configDir, { recursive: true });
    await mkdir(join(root, "data", "opencode"), { recursive: true });
    await writeFile(join(configDir, "opencode.json"), JSON.stringify({
      plugin: ["opencode-codex-multi-account"],
      provider: {
        openai: { options: { baseURL: "http://127.0.0.1:2021/v1" } },
      },
    }));
    await writeFile(join(root, "data", "opencode", "auth.json"), JSON.stringify({
      openai: { type: "api", key: "kyoli-local" },
    }));

    const result = await installOpenCode(
      { host: "127.0.0.1", port: 2021 },
      { configDir, dryRun: true, fetch: createModelsFetch(), env },
    );

    expect(result.diagnostics).toMatchObject({
      mode: "mixed",
      pluginPackages: ["opencode-codex-multi-account"],
      serverProviders: ["openai"],
      openAIAuth: "kyoli-local",
    });
  });

  it("can skip model generation", async () => {
    const root = join(tmpdir(), `kyoli-opencode-install-${Date.now()}-nomodels`);
    const configDir = join(root, "opencode");
    const env = createOpenCodeTestEnv(root);

    const result = await installOpenCode(
      { host: "127.0.0.1", port: 2021 },
      { configDir, includeModels: false, env },
    );

    expect(result.modelSource).toBe("none");
    expect(result.providers.map((provider) => provider.modelCount)).toEqual([0, 0]);
    expect((result.config.provider as Record<string, any>).openai.models).toEqual({});
  });

  it("keeps the default OpenCode model list focused unless all models are requested", async () => {
    const root = join(tmpdir(), `kyoli-opencode-install-${Date.now()}-all-models`);
    const configDir = join(root, "opencode");
    const env = createOpenCodeTestEnv(root);

    const defaultResult = await installOpenCode(
      { host: "127.0.0.1", port: 2021 },
      { configDir, dryRun: true, fetch: createModelsFetch({ includeSecondCodex: true }), env },
    );
    const allResult = await installOpenCode(
      { host: "127.0.0.1", port: 2021 },
      { configDir, dryRun: true, allModels: true, fetch: createModelsFetch({ includeSecondCodex: true }), env },
    );

    expect(defaultResult.providers.find((provider) => provider.id === "openai")?.modelCount).toBe(1);
    expect(allResult.providers.find((provider) => provider.id === "openai")?.modelCount).toBe(2);
  });

  it("can preserve an existing OpenAI provider while installing Anthropic", async () => {
    const root = join(tmpdir(), `kyoli-opencode-install-${Date.now()}-preserve`);
    const configDir = join(root, "opencode");
    const env = createOpenCodeTestEnv(root);
    const configPath = join(configDir, "opencode.json");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        provider: {
          openai: {
            options: { baseURL: "https://api.openai.com/v1", apiKey: "existing" },
            models: { "gpt-5.4": { name: "Direct OpenAI" } },
          },
        },
      }),
    );

    const result = await installOpenCode(
      { host: "127.0.0.1", port: 2021 },
      { configDir, preserveOpenAI: true, fetch: createModelsFetch(), env },
    );
    const written = JSON.parse(await readFile(configPath, "utf8")) as Record<string, any>;

    expect(written.provider.openai.options.baseURL).toBe("https://api.openai.com/v1");
    expect(written.provider.anthropic.options.baseURL).toBe("http://127.0.0.1:2021/v1");
    expect(result.authChanged).toBe(false);
    expect(result.warnings.some((warning) => warning.includes("Preserved existing provider.openai"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("Preserved existing OpenCode auth.openai"))).toBe(true);
  });

  it("restores the latest OpenCode backup", async () => {
    const root = join(tmpdir(), `kyoli-opencode-install-${Date.now()}-restore`);
    const configDir = join(root, "opencode");
    const configPath = join(configDir, "opencode.json");
    const authPath = join(root, "data", "opencode", "auth.json");
    const olderBackup = `${configPath}.bak-20260101T000000Z`;
    const newerBackup = `${configPath}.bak-20260102T000000Z`;
    const authBackup = `${authPath}.bak-20260102T000000Z`;
    await mkdir(configDir, { recursive: true });
    await mkdir(join(root, "data", "opencode"), { recursive: true });
    await writeFile(configPath, JSON.stringify({ current: true }));
    await writeFile(authPath, JSON.stringify({ currentAuth: true }));
    await writeFile(olderBackup, JSON.stringify({ older: true }));
    await writeFile(newerBackup, JSON.stringify({ newer: true }));
    await writeFile(authBackup, JSON.stringify({ restoredAuth: true }));

    const result = await restoreOpenCode({ configDir, env: createOpenCodeTestEnv(root) });
    const restored = JSON.parse(await readFile(configPath, "utf8")) as Record<string, any>;
    const restoredAuth = JSON.parse(await readFile(authPath, "utf8")) as Record<string, any>;

    expect(result.restored).toBe(true);
    expect(result.authRestored).toBe(true);
    expect(result.backupPath).toBe(newerBackup);
    expect(result.authBackupPath).toBe(authBackup);
    expect(restored).toEqual({ newer: true });
    expect(restoredAuth).toEqual({ restoredAuth: true });
  });
});

function createModelsFetch(options: { includeSecondCodex?: boolean } = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    expect(String(input)).toBe("http://127.0.0.1:2021/v1/models");
    const data = [
      {
        id: "openai/gpt-5.3-codex",
        object: "model",
        owned_by: "codex",
        kyoli: {
          provider: "codex",
          upstream_id: "gpt-5.3-codex",
          display_name: "GPT-5.3 Codex",
          capabilities: ["responses", "tools", "reasoning", "codex"],
        },
      },
      {
        id: "openai/gpt-5.4",
        object: "model",
        owned_by: "codex",
        kyoli: {
          provider: "codex",
          upstream_id: "gpt-5.4",
          display_name: "GPT-5.4",
          capabilities: ["responses", "tools", "reasoning"],
        },
      },
      {
        id: "anthropic/claude-sonnet-5",
        object: "model",
        owned_by: "claude-code",
        kyoli: {
          provider: "claude-code",
          upstream_id: "claude-sonnet-5",
          display_name: "Claude Sonnet 5",
          capabilities: ["messages", "tools", "reasoning"],
        },
      },
    ];
    if (options.includeSecondCodex) {
      data.splice(1, 0, {
        id: "openai/gpt-5.3-codex-spark",
        object: "model",
        owned_by: "codex",
        kyoli: {
          provider: "codex",
          upstream_id: "gpt-5.3-codex-spark",
          display_name: "GPT-5.3 Codex Spark",
          capabilities: ["responses", "tools", "reasoning", "codex"],
        },
      });
    }
    return Response.json({
      object: "list",
      data,
    });
  }) as typeof fetch;
}

function createOpenCodeTestEnv(root: string): NodeJS.ProcessEnv {
  return {
    XDG_DATA_HOME: join(root, "data"),
  };
}
