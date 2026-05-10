import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  __openCodeNativeBootstrapAuthTestUtils,
  syncOpenCodeNativeBootstrapAuth,
  type OpenCodeNativeBootstrapAccount,
} from "../src/native-plugin-bootstrap-auth";
import type { PluginClient } from "../src/types";

class FakeStore {
  accounts: OpenCodeNativeBootstrapAccount[] = [];
  activeAccountUuid?: string;

  async load(): Promise<{ accounts: OpenCodeNativeBootstrapAccount[]; activeAccountUuid?: string }> {
    return {
      accounts: this.accounts,
      activeAccountUuid: this.activeAccountUuid,
    };
  }
}

function createClient(): PluginClient {
  return {
    auth: { set: vi.fn(async () => {}) },
    tui: { showToast: vi.fn(async () => {}) },
    app: { log: vi.fn(async () => {}) },
  };
}

describe("syncOpenCodeNativeBootstrapAuth", () => {
  let configDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(async () => {
    previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
    configDir = await fs.mkdtemp(join(process.cwd(), ".tmp-bootstrap-"));
    process.env.OPENCODE_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    if (previousConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
    }
    await fs.rm(configDir, { recursive: true, force: true });
  });

  test("syncs active stored account when auth.json is missing", async () => {
    const client = createClient();
    const store = new FakeStore();
    store.activeAccountUuid = "active";
    store.accounts.push({
      uuid: "active",
      refreshToken: "refresh",
      accessToken: "access",
      expiresAt: 123,
      enabled: true,
      isAuthDisabled: false,
    });

    const synced = await syncOpenCodeNativeBootstrapAuth({
      client,
      store,
      providerId: "openai",
    });

    expect(synced).toBe(true);
    expect(client.auth.set).toHaveBeenCalledWith({
      path: { id: "openai" },
      body: {
        type: "oauth",
        refresh: "refresh",
        access: "access",
        expires: 123,
      },
    });
  });

  test("does not overwrite newer auth.json credentials", async () => {
    const client = createClient();
    const store = new FakeStore();
    store.accounts.push({
      uuid: "older",
      refreshToken: "refresh-older",
      accessToken: "access-older",
      expiresAt: 123,
    });
    await fs.writeFile(join(configDir, "auth.json"), JSON.stringify({
      openai: {
        type: "oauth",
        refresh: "refresh-newer",
        access: "access-newer",
        expires: 456,
      },
    }), "utf-8");

    const synced = await syncOpenCodeNativeBootstrapAuth({
      client,
      store,
      providerId: "openai",
    });

    expect(synced).toBe(false);
    expect(client.auth.set).not.toHaveBeenCalled();
  });

  test("prefers active complete account", () => {
    const selected = __openCodeNativeBootstrapAuthTestUtils.selectBootstrapAccount([
      {
        uuid: "other",
        refreshToken: "refresh-other",
        accessToken: "access-other",
        expiresAt: 100,
      },
      {
        uuid: "active",
        refreshToken: "refresh-active",
        accessToken: "access-active",
        expiresAt: 200,
      },
    ], "active");

    expect(selected?.uuid).toBe("active");
  });
});
