import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const DEFAULT_STALE_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 50;
const DEFAULT_MAX_RETRIES = 10;
const OWNER_PREFIX = "owner-";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ownerPath(lockPath: string, ownerToken: string): string {
  return join(lockPath, `${OWNER_PREFIX}${ownerToken}`);
}

async function removeIfStale(lockPath: string, staleMs: number): Promise<void> {
  try {
    const entries = await fs.readdir(lockPath);
    const leasePath = entries.length === 1 && entries[0]?.startsWith(OWNER_PREFIX)
      ? join(lockPath, entries[0])
      : lockPath;
    const stat = await fs.stat(leasePath);
    if (Date.now() - stat.mtimeMs > staleMs) {
      if (leasePath !== lockPath) await fs.unlink(leasePath);
      await fs.rmdir(lockPath);
    }
  } catch {}
}

async function releaseIfOwner(lockPath: string, ownerToken: string): Promise<void> {
  try {
    // The exact marker gates non-recursive removal, so an old owner cannot remove its successor.
    await fs.unlink(ownerPath(lockPath, ownerToken));
    await fs.rmdir(lockPath);
  } catch {}
}

export async function withDirectoryLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  options?: {
    staleMs?: number;
    retryDelayMs?: number;
    retries?: number;
  },
): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  const ownerToken = randomUUID();
  const leasePath = ownerPath(lockPath, ownerToken);
  const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
  const retryDelayMs = options?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const retries = options?.retries ?? DEFAULT_MAX_RETRIES;

  await fs.mkdir(dirname(targetPath), { recursive: true });

  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      try {
        await fs.writeFile(leasePath, ownerToken, { flag: "wx", mode: 0o600 });
      } catch (error) {
        await fs.rmdir(lockPath).catch(() => {});
        if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
          if (attempt >= retries) throw new Error(`Failed to acquire lock for ${targetPath}`);
          await sleep(retryDelayMs * (attempt + 1));
          continue;
        }
        throw error;
      }
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EEXIST") {
        throw error;
      }

      await removeIfStale(lockPath, staleMs);
      if (attempt >= retries) {
        throw new Error(`Failed to acquire lock for ${targetPath}`);
      }
      await sleep(retryDelayMs * (attempt + 1));
    }
  }

  const renewal = setInterval(() => {
    const now = new Date();
    void fs.utimes(leasePath, now, now).catch(() => {});
  }, Math.max(1, Math.floor(staleMs / 3)));
  renewal.unref();

  try {
    return await fn();
  } finally {
    clearInterval(renewal);
    await releaseIfOwner(lockPath, ownerToken);
  }
}
