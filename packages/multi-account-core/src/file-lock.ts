import { promises as fs } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_STALE_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 50;
const DEFAULT_MAX_RETRIES = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeIfStale(lockPath: string, staleMs: number): Promise<void> {
  try {
    const stat = await fs.stat(lockPath);
    if (Date.now() - stat.mtimeMs > staleMs) {
      await fs.rm(lockPath, { recursive: true, force: true });
    }
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
  const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
  const retryDelayMs = options?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const retries = options?.retries ?? DEFAULT_MAX_RETRIES;

  await fs.mkdir(dirname(targetPath), { recursive: true });

  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
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

  try {
    return await fn();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}
