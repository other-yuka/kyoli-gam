import { afterEach, describe, expect, test } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { resetClaudeIdentityForTest } from "../../src/claude-code/identity";
import { resetHeartbeatForTest } from "../../src/session-heartbeat";
import { resetConfigCache } from "../../src/shared/config";
import { ACCOUNTS_FILENAME } from "../../src/shared/constants";
import type { AccountStorage, StoredAccount } from "../../src/shared/types";
import { createMockClient } from "../helpers";

/**
 * Opt-in live validation for OpenCode Plugin Mode.
 *
 * This is intentionally excluded from the default test path. Contract tests prove
 * kyoli's intended local wire shape; this file spends a real Claude OAuth account
 * only when the operator explicitly asks for it.
 */

const LIVE_ENABLED = process.env.KYOLI_ENABLE_LIVE_OPENCODE_CLAUDE_NATIVE === "1";
const LIVE_MESSAGES_ENABLED = process.env.KYOLI_CLAUDE_ALLOW_LIVE_MESSAGES === "1";
const LIVE_MODEL = process.env.KYOLI_LIVE_OPENCODE_CLAUDE_MODEL ?? "claude-haiku-4-5";
const SOURCE_CONFIG_DIR = process.env.KYOLI_LIVE_OPENCODE_CONFIG_DIR;
const LIVE_ACCEPTANCE_MARKER = "live-acceptance-ok";

const {
  ClaudeMultiAuthPlugin,
} = await import("../../src/index");

function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }

  return path;
}

function resolveSourceConfigDir(): string {
  return resolve(expandHome(SOURCE_CONFIG_DIR ?? join("~", ".config", "opencode")));
}

function createTempDir(): string {
  return join(tmpdir(), `kyoli-live-native-${randomBytes(8).toString("hex")}`);
}

function isUsableLiveAccount(account: StoredAccount): boolean {
  if (account.enabled === false) return false;
  if (account.isAuthDisabled) return false;
  if (!account.refreshToken) return false;
  if (account.rateLimitResetAt && account.rateLimitResetAt > Date.now()) return false;
  return true;
}

async function readUsableSourceStorage(): Promise<AccountStorage> {
  const sourcePath = join(resolveSourceConfigDir(), ACCOUNTS_FILENAME);
  const parsed = JSON.parse(await readFile(sourcePath, "utf8")) as AccountStorage;
  const accounts = (parsed.accounts ?? []).filter(isUsableLiveAccount);
  if (accounts.length === 0) {
    throw new Error(`No usable Claude native-plugin account found in ${sourcePath}`);
  }

  const activeAccountUuid = accounts.some((account) => account.uuid === parsed.activeAccountUuid)
    ? parsed.activeAccountUuid
    : accounts[0]?.uuid;

  return {
    version: 1,
    accounts: [accounts[0] as StoredAccount],
    activeAccountUuid,
  };
}

async function createIsolatedConfig(storage: AccountStorage): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = createTempDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ACCOUNTS_FILENAME), JSON.stringify(storage, null, 2), "utf8");
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

afterEach(() => {
  resetClaudeIdentityForTest();
  resetHeartbeatForTest();
  resetConfigCache();
});

describe.skipIf(!LIVE_ENABLED)("OpenCode Claude native live acceptance", () => {
  test.skipIf(!LIVE_MESSAGES_ENABLED)(
    "generates one non-stream Claude message through the native plugin fetch hook",
    async () => {
      const previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
      const isolated = await createIsolatedConfig(await readUsableSourceStorage());

      try {
        process.env.OPENCODE_CONFIG_DIR = isolated.dir;
        const plugin = await ClaudeMultiAuthPlugin({ client: createMockClient() } as never);
        const loaded = await plugin.auth!.loader!(
          async () => ({ type: "api", key: "" }),
          { id: "anthropic", name: "Anthropic", env: {}, models: {} } as never,
        );

        expect(loaded.fetch).not.toBe(fetch);

        const response = await loaded.fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: LIVE_MODEL,
            max_tokens: 24,
            stream: false,
            messages: [
              { role: "user", content: `Reply with exactly: ${LIVE_ACCEPTANCE_MARKER}` },
            ],
          }),
        });

        const text = await response.clone().text();
        expect(response.status, text.slice(0, 500)).toBe(200);
        expect(text).toContain(LIVE_ACCEPTANCE_MARKER);
      } finally {
        if (previousConfigDir === undefined) {
          delete process.env.OPENCODE_CONFIG_DIR;
        } else {
          process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
        }
        await isolated.cleanup();
      }
    },
  );
});
