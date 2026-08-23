import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { withDirectoryLock } from "../src/file-lock";
import { createTestDir } from "./helpers";

const STALE_MS = 60_000;
const LOCK_OPTIONS = { staleMs: STALE_MS, retryDelayMs: 1, retries: 10 };

describe("withDirectoryLock", () => {
  test("a stale owner cannot release its successor's lock", async () => {
    const dir = createTestDir();
    const targetPath = join(dir, "resource");
    const lockPath = `${targetPath}.lock`;
    await fs.mkdir(dir, { recursive: true });

    let releaseFirst!: () => void;
    let signalFirstEntered!: () => void;
    const firstHold = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstEntered = new Promise<void>((resolve) => { signalFirstEntered = resolve; });
    const first = withDirectoryLock(targetPath, async () => {
      signalFirstEntered();
      await firstHold;
    }, LOCK_OPTIONS);

    let releaseSecond!: () => void;
    let signalSecondEntered!: () => void;
    const secondHold = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const secondEntered = new Promise<void>((resolve) => { signalSecondEntered = resolve; });
    let second: Promise<void> | undefined;

    try {
      await firstEntered;
      const staleTime = new Date(Date.now() - STALE_MS * 2);
      for (const entry of await fs.readdir(lockPath)) {
        await fs.utimes(join(lockPath, entry), staleTime, staleTime);
      }
      await fs.utimes(lockPath, staleTime, staleTime);

      second = withDirectoryLock(targetPath, async () => {
        signalSecondEntered();
        await secondHold;
      }, LOCK_OPTIONS);
      await secondEntered;

      releaseFirst();
      await first;

      let thirdEntered = false;
      await expect(withDirectoryLock(targetPath, async () => {
        thirdEntered = true;
      }, { ...LOCK_OPTIONS, retries: 0 })).rejects.toThrow(`Failed to acquire lock for ${targetPath}`);
      expect(thirdEntered).toBe(false);
    } finally {
      releaseFirst();
      releaseSecond();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
