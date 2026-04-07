import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { loadAccounts, readStorageFromDisk } from "./storage";
import { ACCOUNTS_FILENAME } from "./constants";
import { withDirectoryLock } from "./file-lock";
import { AccountStorageSchema } from "./types";
import { getConfigDir, getErrorCode } from "./utils";
import type { AccountStorage, StoredAccount } from "./types";

const FILE_MODE = 0o600;

function resolveStoragePath(filename: string): string {
  return join(getConfigDir(), filename);
}

function createEmptyStorage(): AccountStorage {
  return { version: 1, accounts: [] };
}

function buildTempPath(targetPath: string): string {
  return `${targetPath}.${randomBytes(8).toString("hex")}.tmp`;
}

async function writeAtomicText(targetPath: string, content: string): Promise<void> {
  await fs.mkdir(dirname(targetPath), { recursive: true });
  const tempPath = buildTempPath(targetPath);
  try {
    await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: FILE_MODE });
    await fs.chmod(tempPath, FILE_MODE);
    await fs.rename(tempPath, targetPath);
    await fs.chmod(targetPath, FILE_MODE);
  } catch (error) {
    try {
      await fs.unlink(tempPath);
    } catch {}
    throw error;
  }
}

async function writeStorageAtomic(targetPath: string, storage: AccountStorage): Promise<void> {
  const validation = v.safeParse(AccountStorageSchema, storage);
  if (!validation.success) {
    throw new Error("Invalid account storage payload");
  }
  await writeAtomicText(targetPath, `${JSON.stringify(validation.output, null, 2)}\n`);
}

async function ensureStorageFileExists(targetPath: string): Promise<void> {
  await fs.mkdir(dirname(targetPath), { recursive: true });
  const emptyContent = `${JSON.stringify(createEmptyStorage(), null, 2)}\n`;
  try {
    await fs.writeFile(targetPath, emptyContent, { flag: "wx", mode: FILE_MODE });
  } catch (error) {
    if (getErrorCode(error) !== "EEXIST") throw error;
  }
}

export interface DiskCredentials {
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
  accountId?: string;
}

export class AccountStore {
  private readonly storagePath: string;

  constructor(filename?: string) {
    this.storagePath = resolveStoragePath(filename ?? ACCOUNTS_FILENAME);
  }

  private async withLock<T>(fn: (storagePath: string) => Promise<T>): Promise<T> {
    await ensureStorageFileExists(this.storagePath);
    return await withDirectoryLock(this.storagePath, () => fn(this.storagePath));
  }

  async load(): Promise<AccountStorage> {
    const storage = await loadAccounts(this.storagePath);
    return storage ?? createEmptyStorage();
  }

  async readCredentials(uuid: string): Promise<DiskCredentials | null> {
    const storage = await readStorageFromDisk(this.storagePath, false);
    if (!storage) return null;

    const account = storage.accounts.find((a) => a.uuid === uuid);
    if (!account) return null;

    return {
      refreshToken: account.refreshToken,
      accessToken: account.accessToken,
      expiresAt: account.expiresAt,
      accountId: account.accountId,
    };
  }

  async mutateAccount(
    uuid: string,
    fn: (account: StoredAccount) => void,
  ): Promise<StoredAccount | null> {
    return await this.withLock(async (storagePath) => {
      const current = await readStorageFromDisk(storagePath, false);
      if (!current) return null;

      const account = current.accounts.find((a) => a.uuid === uuid);
      if (!account) return null;

      fn(account);

      await writeStorageAtomic(storagePath, current);
      return { ...account };
    });
  }

  async mutateStorage(
    fn: (storage: AccountStorage) => void,
  ): Promise<void> {
    await this.withLock(async (storagePath) => {
      const current = await readStorageFromDisk(storagePath, false) ?? createEmptyStorage();
      fn(current);
      await writeStorageAtomic(storagePath, current);
    });
  }

  async addAccount(account: StoredAccount): Promise<void> {
    await this.withLock(async (storagePath) => {
      const current = await readStorageFromDisk(storagePath, false) ?? createEmptyStorage();
      const exists = current.accounts.some(
        (a) => a.uuid === account.uuid || a.refreshToken === account.refreshToken,
      );
      if (exists) return;

      current.accounts.push(account);
      await writeStorageAtomic(storagePath, current);
    });
  }

  async removeAccount(uuid: string): Promise<boolean> {
    return await this.withLock(async (storagePath) => {
      const current = await readStorageFromDisk(storagePath, false);
      if (!current) return false;

      const initialLength = current.accounts.length;
      current.accounts = current.accounts.filter((a) => a.uuid !== uuid);
      if (current.accounts.length === initialLength) return false;

      if (current.activeAccountUuid === uuid) {
        current.activeAccountUuid = current.accounts[0]?.uuid;
      }

      await writeStorageAtomic(storagePath, current);
      return true;
    });
  }

  async setActiveUuid(uuid: string | undefined): Promise<void> {
    await this.mutateStorage((storage) => {
      storage.activeAccountUuid = uuid;
    });
  }

  async clear(): Promise<void> {
    await this.withLock(async (storagePath) => {
      await writeStorageAtomic(storagePath, createEmptyStorage());
    });
  }
}
