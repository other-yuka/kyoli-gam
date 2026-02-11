import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { PluginClient, AccountStorage } from "../src/types";

export function createTestDir(): string {
  return join(tmpdir(), `codex-multiauth-test-${randomBytes(8).toString("hex")}`);
}

export async function setupTestEnv(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = createTestDir();
  await fs.mkdir(dir, { recursive: true });

  process.env.OPENCODE_CONFIG_DIR = dir;

  return {
    dir,
    cleanup: async () => {
      delete process.env.OPENCODE_CONFIG_DIR;
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

export function createMockClient(): PluginClient & { logs: Array<{ service: string; level: string; message: string }> } {
  const logs: Array<{ service: string; level: string; message: string }> = [];

  return {
    logs,
    auth: {
      set: async () => {},
    },
    tui: {
      showToast: async () => {},
    },
    app: {
      log: async (params) => {
        logs.push({ service: params.body.service, level: params.body.level, message: params.body.message });
      },
    },
  };
}

export function createEmptyStorage(): AccountStorage {
  return { version: 1, accounts: [] };
}

export function createTestStorage(count: number): AccountStorage {
  const accounts = Array.from({ length: count }, (_, i) => ({
    uuid: `test-uuid-${i}`,
    accountId: `account-id-${i}`,
    email: `test${i}@example.com`,
    planTier: "",
    refreshToken: `refresh-token-${i}`,
    addedAt: Date.now() - (count - i) * 1000,
    lastUsed: Date.now() - (count - i) * 1000,
    enabled: true,
    consecutiveAuthFailures: 0,
    isAuthDisabled: false,
  }));

  return {
    version: 1,
    accounts,
    activeAccountUuid: accounts[0]?.uuid,
  };
}

/**
 * Build a minimal JWT with the given payload (no signature verification).
 * Format: base64url(header).base64url(payload).signature
 */
export function buildFakeJwt(payload: Record<string, unknown>): string {
  const header = { alg: "RS256", typ: "JWT" };
  const encode = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64url");
  return `${encode(header)}.${encode(payload)}.fake-signature`;
}

export function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function createTokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}
