import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getConfig,
  initCoreConfig,
  loadConfig,
  resetConfigCache,
  updateConfigField,
} from "../src/config";
import { setupTestEnv } from "./helpers";

const CONFIG_FILENAME = "core-config.test.json";

let cleanup: (() => Promise<void>) | undefined;
let configPath = "";

describe("core/config", () => {
  beforeEach(async () => {
    const env = await setupTestEnv();
    cleanup = env.cleanup;
    configPath = join(env.dir, CONFIG_FILENAME);
    initCoreConfig(CONFIG_FILENAME);
    resetConfigCache();
  });

  afterEach(async () => {
    resetConfigCache();
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  test("returns defaults when config file is missing", async () => {
    const loaded = await loadConfig();
    expect(loaded.account_selection_strategy).toBe("sticky");
    expect(loaded.default_retry_after_ms).toBe(60_000);
    expect(loaded.proactive_refresh).toBe(true);
  });

  test("loads and caches config content", async () => {
    await fs.writeFile(configPath, JSON.stringify({ quiet_mode: true }), "utf-8");

    const first = await loadConfig();
    expect(first.quiet_mode).toBe(true);

    await fs.writeFile(configPath, JSON.stringify({ quiet_mode: false }), "utf-8");
    const cached = await loadConfig();
    expect(cached.quiet_mode).toBe(true);

    resetConfigCache();
    const reloaded = await loadConfig();
    expect(reloaded.quiet_mode).toBe(false);
  });

  test("updates a field and refreshes cache", async () => {
    await updateConfigField("max_consecutive_auth_failures", 5);

    const current = getConfig();
    expect(current.max_consecutive_auth_failures).toBe(5);

    const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as { max_consecutive_auth_failures?: number };
    expect(persisted.max_consecutive_auth_failures).toBe(5);
  });
});
