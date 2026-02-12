import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { ACCOUNTS_FILENAME } from "./constants";
import { AccountStorageSchema } from "./types";
import { getConfigDir, getErrorCode } from "./utils";
import type { AccountStorage, StoredAccount } from "./types";

function getStoragePath(): string {
  return join(getConfigDir(), ACCOUNTS_FILENAME);
}

async function backupCorruptFile(targetPath: string, content: string): Promise<void> {
  const backupPath = `${targetPath}.corrupt.${Date.now()}.bak`;
  await fs.mkdir(dirname(backupPath), { recursive: true });
  await fs.writeFile(backupPath, content, "utf-8");
}

export async function readStorageFromDisk(
  targetPath: string,
  backupOnCorrupt: boolean,
): Promise<AccountStorage | null> {
  let content: string;
  try {
    content = await fs.readFile(targetPath, "utf-8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    if (backupOnCorrupt) {
      try {
        await backupCorruptFile(targetPath, content);
      } catch {
        // best-effort backup
      }
    }
    return null;
  }

  const validation = v.safeParse(AccountStorageSchema, parsed);
  if (!validation.success) {
    if (backupOnCorrupt) {
      try {
        await backupCorruptFile(targetPath, content);
      } catch {
        // best-effort backup
      }
    }
    return null;
  }

  return validation.output;
}

export function deduplicateAccounts(accounts: StoredAccount[]): StoredAccount[] {
  const deduplicated: StoredAccount[] = [];
  const indexByUuid = new Map<string, number>();

  for (const account of accounts) {
    if (!account.uuid) {
      deduplicated.push(account);
      continue;
    }

    const existingIndex = indexByUuid.get(account.uuid);
    if (existingIndex === undefined) {
      indexByUuid.set(account.uuid, deduplicated.length);
      deduplicated.push(account);
      continue;
    }

    const existingAccount = deduplicated[existingIndex];
    if (!existingAccount || account.lastUsed >= existingAccount.lastUsed) {
      deduplicated[existingIndex] = account;
    }
  }

  return deduplicated;
}

export async function loadAccounts(): Promise<AccountStorage | null> {
  const storagePath = getStoragePath();
  const storage = await readStorageFromDisk(storagePath, true);
  if (!storage) {
    return null;
  }

  return {
    ...storage,
    accounts: deduplicateAccounts(storage.accounts || []),
  };
}
