import { promises as fs } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./utils";
import type { AccountStore } from "./account-store";

const AUTH_JSON_FILENAME = "auth.json";

interface AuthJsonCredential {
  type: string;
  refresh: string;
  access?: string;
  expires?: number;
}

function isValidOAuthCredential(value: unknown): value is AuthJsonCredential {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === "oauth" &&
    typeof candidate.refresh === "string" &&
    candidate.refresh.length > 0
  );
}

function resolveAuthJsonPath(): string {
  return join(getConfigDir(), AUTH_JSON_FILENAME);
}

async function readAuthJson(): Promise<Record<string, unknown> | null> {
  const authPath = resolveAuthJsonPath();

  let content: string;
  try {
    content = await fs.readFile(authPath, "utf-8");
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Imports an existing OAuth credential from OpenCode's auth.json
 * into the multi-account storage on first use.
 *
 * Only runs when storage has zero accounts. Does not modify auth.json.
 *
 * @param providerKey - The key in auth.json ("anthropic" or "openai")
 * @param store - The AccountStore instance to import into
 * @returns true if a credential was imported, false otherwise
 */
export async function migrateFromAuthJson(
  providerKey: string,
  store: AccountStore,
): Promise<boolean> {
  const storage = await store.load();
  const hasExistingAccounts = storage.accounts.length > 0;
  if (hasExistingAccounts) return false;

  const authData = await readAuthJson();
  if (!authData) return false;

  const providerCredential = authData[providerKey];
  if (!isValidOAuthCredential(providerCredential)) return false;

  const now = Date.now();
  const newAccount = {
    uuid: crypto.randomUUID(),
    refreshToken: providerCredential.refresh,
    accessToken: providerCredential.access,
    expiresAt: providerCredential.expires,
    addedAt: now,
    lastUsed: now,
    enabled: true,
    planTier: "",
    consecutiveAuthFailures: 0,
    isAuthDisabled: false,
  };

  await store.addAccount(newAccount);
  await store.setActiveUuid(newAccount.uuid);

  return true;
}
