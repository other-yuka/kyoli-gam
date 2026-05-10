import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  defaultConfigPath,
  initCliConfig,
  loadCliConfig,
  resolveConfigPath,
} from "../src/config";

const testDir = dirname(fileURLToPath(import.meta.url));

describe("loadCliConfig", () => {
  it("loads config from --config", async () => {
    const path = join(testDir, "tmp", "kyoli-config.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        host: "0.0.0.0",
        port: 3030,
        databasePath: "/tmp/kyoli.db",
        accountSelectionStrategy: "weighted",
        softQuotaThresholdPercent: 88,
        planWeights: { max: 5, pro: 2 },
        usageRefreshIntervalMs: 12345,
        maxConcurrentRequests: 12,
        adminToken: "file-token",
        logLevel: "debug",
      }),
    );

    const config = await loadCliConfig(["kyoli", "serve", "--config", path], {});

    expect(config).toEqual({
      host: "0.0.0.0",
      port: 3030,
      databasePath: "/tmp/kyoli.db",
      accountSelectionStrategy: "weighted",
      softQuotaThresholdPercent: 88,
      planWeights: { max: 5, pro: 2 },
      usageRefreshIntervalMs: 12345,
      maxConcurrentRequests: 12,
      adminToken: "file-token",
      logLevel: "debug",
    });
  });

  it("lets environment and --port override file config", async () => {
    const path = join(testDir, "tmp", "kyoli-config-override.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        host: "0.0.0.0",
        port: 3030,
        accountSelectionStrategy: "sticky",
        planWeights: { max: 3 },
      }),
    );

    const config = await loadCliConfig(
      ["kyoli", "serve", "--config", path, "--port", "4040"],
      {
        KYOLI_HOST: "127.0.0.1",
        KYOLI_ACCOUNT_SELECTION_STRATEGY: "round-robin",
        KYOLI_PLAN_WEIGHTS: "max=9,pro=4",
        KYOLI_MAX_CONCURRENT_REQUESTS: "7",
        KYOLI_ADMIN_TOKEN: "env-token",
        KYOLI_LOG_LEVEL: "silent",
      },
    );

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(4040);
    expect(config.accountSelectionStrategy).toBe("round-robin");
    expect(config.planWeights).toEqual({ max: 9, pro: 4 });
    expect(config.maxConcurrentRequests).toBe(7);
    expect(config.adminToken).toBe("env-token");
    expect(config.logLevel).toBe("silent");
  });

  it("expands tilde paths", async () => {
    const path = join(testDir, "tmp", "kyoli-config-tilde.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ databasePath: "~/.local/share/kyoli-gam/test.db" }));

    const config = await loadCliConfig(["kyoli", "serve", "--config", path], {});

    expect(config.databasePath?.startsWith("/")).toBe(true);
    expect(config.databasePath?.endsWith("/.local/share/kyoli-gam/test.db")).toBe(true);
  });

  it("resolves config path from env or default", () => {
    expect(resolveConfigPath(["kyoli"], { KYOLI_CONFIG_PATH: "/tmp/custom.json" })).toBe(
      "/tmp/custom.json",
    );
    expect(defaultConfigPath({ XDG_CONFIG_HOME: "/tmp/config-home" })).toBe(
      "/tmp/config-home/kyoli-gam/config.json",
    );
  });

  it("uses defaults when no config file exists", async () => {
    const path = join(testDir, "tmp", "missing-config.json");
    await unlink(path).catch(() => undefined);

    const config = await loadCliConfig(["kyoli", "serve", "--config", path], {});

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(2021);
    expect(config.databasePath?.endsWith("/.local/share/kyoli-gam/kyoli.db")).toBe(true);
    expect(config.accountSelectionStrategy).toBe("sticky");
    expect(config.maxConcurrentRequests).toBe(0);
    expect(config.logLevel).toBe("info");
  });

  it("initializes config without overwriting unless forced", async () => {
    const path = join(testDir, "tmp", "kyoli-config-init.json");
    await unlink(path).catch(() => undefined);

    expect(await initCliConfig(path)).toBe("created");
    expect(await initCliConfig(path)).toBe("exists");
    expect(await initCliConfig(path, { force: true })).toBe("overwritten");

    const config = await loadCliConfig(["kyoli", "--config", path], {});
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(2021);
  });
});
