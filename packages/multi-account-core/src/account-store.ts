import { promises as fs } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { loadAccounts, readStorageFromDisk } from "./storage";
import { ACCOUNTS_FILENAME } from "./constants";
import { withDirectoryLock } from "./file-lock";
import { AccountStorageSchema } from "./types";
import { getConfigDir, getErrorCode } from "./utils";
import type {
  AccountStorage,
  CredentialRefreshPatch,
  StoredAccount,
  TokenRefreshResult,
} from "./types";

const FILE_MODE = 0o600;
// Provider refresh calls time out at 30 seconds; keep the local lease above that ceiling.
const REFRESH_LOCK_STALE_MS = 45_000;
const REFRESH_LOCK_RETRY_DELAY_MS = 100;
const REFRESH_LOCK_RETRIES = 31;

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
  credentialOwnerId?: string;
  accountId?: string;
  accountUuid?: string;
  deviceId?: string;
}

export interface AccountCredentialRefreshResult {
  result: TokenRefreshResult;
  account: StoredAccount | null;
}

function sameCredentialSnapshot(account: StoredAccount, expected: DiskCredentials): boolean {
  return account.refreshToken === expected.refreshToken
    && account.accessToken === expected.accessToken
    && account.expiresAt === expected.expiresAt;
}

function findCredentialAccount(
  accounts: StoredAccount[],
  uuid: string,
  expected: DiskCredentials,
): StoredAccount | undefined {
  const exact = accounts.find((account) => account.uuid === uuid);
  if (exact) return exact;

  const ownerId = expected.credentialOwnerId ?? uuid;
  const ownerMatches = accounts.filter((account) => account.credentialOwnerId === ownerId);
  return ownerMatches.length === 1 ? ownerMatches[0] : undefined;
}

function refreshedCredentialPatch(
  account: StoredAccount,
  previous: DiskCredentials,
): CredentialRefreshPatch | null {
  if (!account.accessToken || !account.expiresAt) return null;
  const rotatedGrant = account.refreshToken !== previous.refreshToken;
  const newerExpiry = account.expiresAt > (previous.expiresAt ?? 0);
  const changedAccess = account.accessToken !== previous.accessToken;
  if (account.expiresAt <= Date.now() || (!rotatedGrant && !newerExpiry && !changedAccess)) return null;
  return {
    accessToken: account.accessToken,
    expiresAt: account.expiresAt,
    refreshToken: account.refreshToken,
    uuid: account.uuid,
    accountId: account.accountId,
    accountUuid: account.accountUuid,
    deviceId: account.deviceId,
    email: account.email,
  };
}

function applyCredentialPatch(
  account: StoredAccount,
  patch: CredentialRefreshPatch,
  credentialOwnerId: string,
): void {
  account.accessToken = patch.accessToken;
  account.expiresAt = patch.expiresAt;
  if (patch.refreshToken) account.refreshToken = patch.refreshToken;
  if (patch.uuid && patch.uuid !== account.uuid) {
    account.credentialOwnerId ??= credentialOwnerId;
    account.uuid = patch.uuid;
  }
  if (patch.accountId) account.accountId = patch.accountId;
  if (patch.accountUuid && !account.accountUuid) account.accountUuid = patch.accountUuid;
  if (patch.deviceId && !account.deviceId) account.deviceId = patch.deviceId;
  if (patch.email) account.email = patch.email;
  account.consecutiveAuthFailures = 0;
  account.isAuthDisabled = false;
  account.authDisabledReason = undefined;
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

  private refreshLockPath(uuid: string, credentials: DiskCredentials): string {
    const accountKey = createHash("sha256")
      .update(credentials.credentialOwnerId ?? uuid)
      .digest("hex");
    return `${this.storagePath}.refresh-${accountKey}`;
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
      credentialOwnerId: account.credentialOwnerId,
      accountId: account.accountId,
      accountUuid: account.accountUuid,
      deviceId: account.deviceId,
    };
  }

  async refreshAccountCredentials(
    uuid: string,
    expected: DiskCredentials,
    refresh: (refreshToken: string) => Promise<TokenRefreshResult>,
  ): Promise<AccountCredentialRefreshResult> {
    // ponytail: Plugin Mode shares a local account file; use a distributed lease only if storage moves off-host.
    const credentialOwnerId = expected.credentialOwnerId ?? uuid;
    return await withDirectoryLock(this.refreshLockPath(uuid, expected), async () => {
      const currentStorage = await readStorageFromDisk(this.storagePath, false);
      const current = currentStorage
        ? findCredentialAccount(currentStorage.accounts, uuid, expected)
        : undefined;
      if (!current) {
        return { result: { ok: false, permanent: true }, account: null };
      }

      let refreshSnapshot = expected;
      if (!sameCredentialSnapshot(current, expected)) {
        const patch = refreshedCredentialPatch(current, expected);
        if (patch) return { result: { ok: true, patch }, account: { ...current } };
        refreshSnapshot = current;
      }

      const result = await refresh(current.refreshToken);
      if (!result.ok) return { result, account: { ...current } };

      let persistedResult: TokenRefreshResult = result;
      const updated = await this.mutateAccount(current.uuid ?? uuid, (account) => {
        if (!sameCredentialSnapshot(account, refreshSnapshot)) {
          const patch = refreshedCredentialPatch(account, refreshSnapshot);
          persistedResult = patch ? { ok: true, patch } : { ok: false, permanent: false };
          return;
        }
        applyCredentialPatch(account, result.patch, credentialOwnerId);
      });
      if (!updated) return { result: { ok: false, permanent: false }, account: null };
      return { result: persistedResult, account: updated };
    }, {
      staleMs: REFRESH_LOCK_STALE_MS,
      retryDelayMs: REFRESH_LOCK_RETRY_DELAY_MS,
      retries: REFRESH_LOCK_RETRIES,
    });
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

  async mutateStorageIfCredentialsMatch(
    uuid: string,
    expected: DiskCredentials,
    fn: (account: StoredAccount, storage: AccountStorage) => void,
  ): Promise<boolean> {
    return await this.withLock(async (storagePath) => {
      const current = await readStorageFromDisk(storagePath, false);
      if (!current) return false;

      const account = findCredentialAccount(current.accounts, uuid, expected);
      if (!account || !sameCredentialSnapshot(account, expected)) return false;

      fn(account, current);
      await writeStorageAtomic(storagePath, current);
      return true;
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
