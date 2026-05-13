import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installCodexCli, restoreCodexCli } from "../src/codex-install";

describe("installCodexCli", () => {
  it("previews Codex CLI provider config without writing in dry-run mode", async () => {
    const root = join(tmpdir(), `kyoli-codex-install-${Date.now()}-dry`);

    const result = await installCodexCli(
      { host: "127.0.0.1", port: 2021 },
      { configDir: root, dryRun: true },
    );

    expect(result.dryRun).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.providerBaseUrl).toBe("http://127.0.0.1:2021/backend-api/codex");
    expect(result.config).toContain('model_provider = "kyoli"');
    expect(result.config).toContain("[model_providers.kyoli]");
    expect(result.config).toContain('wire_api = "responses"');
    expect(result.config).toContain("supports_websockets = true");
    expect(result.config).toContain("requires_openai_auth = true");
    await expect(stat(join(root, "config.toml"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes Codex CLI config, removes chatgpt_base_url, and backs up existing files", async () => {
    const root = join(tmpdir(), `kyoli-codex-install-${Date.now()}-write`);
    const configPath = join(root, "config.toml");
    await mkdir(root, { recursive: true });
    await writeFile(
      configPath,
      [
        'model = "gpt-5.5"',
        'model_reasoning_effort = "xhigh"',
        'chatgpt_base_url = "http://127.0.0.1:2021/backend-api/"',
        "",
        "[features]",
        "hooks = true",
        "",
        "[mcp_servers.example]",
        'command = "example"',
        "",
      ].join("\n"),
    );

    const result = await installCodexCli(
      { host: "127.0.0.1", port: 2021 },
      { configDir: root },
    );
    const written = await readFile(configPath, "utf8");

    expect(result.backupPath).toBeTruthy();
    expect(result.warnings.some((warning) => warning.includes("chatgpt_base_url"))).toBe(true);
    expect(written).toContain('model = "gpt-5.5"');
    expect(written).toContain('model_provider = "kyoli"');
    expect(written).toContain('model_reasoning_effort = "xhigh"');
    expect(written).not.toContain("chatgpt_base_url");
    expect(written).toContain('[model_providers.kyoli]\nname = "OpenAI"');
    expect(written).toContain('base_url = "http://127.0.0.1:2021/backend-api/codex"');
    expect(written).toContain("supports_websockets = true");
    expect(written).toContain("[features]\nhooks = true");
    expect(written).toContain('[mcp_servers.example]\ncommand = "example"');
  });

  it("replaces an existing kyoli provider section with current WebSocket support", async () => {
    const root = join(tmpdir(), `kyoli-codex-install-${Date.now()}-replace`);
    const configPath = join(root, "config.toml");
    await mkdir(root, { recursive: true });
    await writeFile(
      configPath,
      [
        'model = "gpt-5.3-codex"',
        'model_provider = "other"',
        "",
        "[model_providers.kyoli]",
        'base_url = "http://old.example/backend-api/codex"',
        "supports_websockets = true",
        "",
        "[projects.\"/tmp\"]",
        'trust_level = "trusted"',
        "",
      ].join("\n"),
    );

    await installCodexCli(
      { host: "127.0.0.1", port: 2021 },
      { configDir: root },
    );
    const written = await readFile(configPath, "utf8");

    expect(written).toContain('model_provider = "kyoli"');
    expect(written).toContain("supports_websockets = true");
    expect(written.match(/\[model_providers\.kyoli\]/g)).toHaveLength(1);
    expect(written).toContain('[projects."/tmp"]\ntrust_level = "trusted"');
  });

  it("restores the latest Codex CLI backup", async () => {
    const root = join(tmpdir(), `kyoli-codex-install-${Date.now()}-restore`);
    const configPath = join(root, "config.toml");
    const olderBackup = `${configPath}.bak-20260101T000000Z`;
    const newerBackup = `${configPath}.bak-20260102T000000Z`;
    await mkdir(root, { recursive: true });
    await writeFile(configPath, 'model = "current"\n');
    await writeFile(olderBackup, 'model = "older"\n');
    await writeFile(newerBackup, 'model = "newer"\n');

    const result = await restoreCodexCli({ configDir: root });
    const restored = await readFile(configPath, "utf8");

    expect(result.restored).toBe(true);
    expect(result.backupPath).toBe(newerBackup);
    expect(restored).toBe('model = "newer"\n');
  });
});
