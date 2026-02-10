import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getConfig, loadConfig, resetConfigCache } from "../src/config";
import { setupTestEnv } from "./helpers";

const CONFIG_FILENAME = "claude-multiauth.json";

let cleanup: (() => Promise<void>) | undefined;
let configPath = "";

describe("config", () => {
  beforeEach(async () => {
    const env = await setupTestEnv();
    cleanup = env.cleanup;
    configPath = join(env.dir, CONFIG_FILENAME);
    resetConfigCache();
  });

  afterEach(async () => {
    resetConfigCache();
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  test("loadConfig returns schema defaults when file is missing", async () => {
    const loaded = await loadConfig();

    expect(loaded.account_selection_strategy).toBe("sticky");
    expect(loaded.cross_process_claims).toBe(true);
    expect(loaded.default_retry_after_ms).toBe(60_000);
    expect(loaded.quiet_mode).toBe(false);
    expect(loaded.debug).toBe(false);
  });

  test("loadConfig reads and caches valid file", async () => {
    await fs.writeFile(configPath, JSON.stringify({ quiet_mode: true, debug: true }), "utf-8");

    const loaded = await loadConfig();
    expect(loaded.quiet_mode).toBe(true);
    expect(loaded.debug).toBe(true);

    await fs.writeFile(configPath, JSON.stringify({ quiet_mode: false, debug: false }), "utf-8");

    const cached = await loadConfig();
    expect(cached.quiet_mode).toBe(true);
    expect(cached.debug).toBe(true);
  });

  test("getConfig returns defaults before loading", () => {
    const current = getConfig();

    expect(current.account_selection_strategy).toBe("sticky");
    expect(current.cross_process_claims).toBe(true);
    expect(current.default_retry_after_ms).toBe(60_000);
  });

  test("resetConfigCache forces load from latest file", async () => {
    await fs.writeFile(configPath, JSON.stringify({ quiet_mode: true }), "utf-8");
    const first = await loadConfig();
    expect(first.quiet_mode).toBe(true);

    await fs.writeFile(configPath, JSON.stringify({ quiet_mode: false }), "utf-8");
    const stillCached = await loadConfig();
    expect(stillCached.quiet_mode).toBe(true);

    resetConfigCache();
    const reloaded = await loadConfig();
    expect(reloaded.quiet_mode).toBe(false);
  });
});
