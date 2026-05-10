import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { getConfigDir } from "./utils";

const CLAIMS_FILENAME = "multiauth-claims.json";
const CLAIM_EXPIRY_MS = 60_000;
const CLAIM_LOCK_STALE_MS = 15_000;

export type ClaimsMap = Record<string, { pid: number; at: number }>;

export interface ClaimsManager {
  readClaims(): Promise<ClaimsMap>;
  writeClaim(accountId: string): Promise<void>;
  releaseClaim(accountId: string): Promise<void>;
  isClaimedByOther(claims: ClaimsMap, accountId: string | undefined): boolean;
}

function getClaimsPath(filename: string): string {
  return join(getConfigDir(), filename);
}

function isClaimShape(value: unknown): value is { pid: number; at: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claim = value as Record<string, unknown>;
  return (
    typeof claim.pid === "number"
    && Number.isInteger(claim.pid)
    && claim.pid > 0
    && typeof claim.at === "number"
    && Number.isFinite(claim.at)
  );
}

function parseClaims(raw: string): ClaimsMap {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  const claims: ClaimsMap = {};
  for (const [accountId, claim] of Object.entries(parsed)) {
    if (isClaimShape(claim)) {
      claims[accountId] = claim;
    }
  }

  return claims;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanClaims(
  claims: ClaimsMap,
  now: number,
): { cleaned: ClaimsMap; changed: boolean } {
  const cleaned: ClaimsMap = {};
  let changed = false;

  for (const [accountId, claim] of Object.entries(claims)) {
    const expiredByTime = now - claim.at > CLAIM_EXPIRY_MS;
    const zombieClaim = !isProcessAlive(claim.pid);
    if (expiredByTime || zombieClaim) {
      changed = true;
      continue;
    }

    cleaned[accountId] = claim;
  }

  return { cleaned, changed };
}

async function writeClaimsFile(path: string, claims: ClaimsMap): Promise<void> {
  const tempPath = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.mkdir(dirname(path), { recursive: true });

  try {
    await fs.writeFile(tempPath, JSON.stringify(claims, null, 2), { encoding: "utf-8", mode: 0o600 });
    await fs.rename(tempPath, path);
  } catch (error) {
    try {
      await fs.unlink(tempPath);
    } catch {
      // ignore cleanup failure
    }
    throw error;
  }
}

async function readClaimsFile(path: string): Promise<ClaimsMap> {
  try {
    const data = await fs.readFile(path, "utf-8");
    return parseClaims(data);
  } catch {
    return {};
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireClaimsLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`;

  await fs.mkdir(dirname(path), { recursive: true });

  for (;;) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      return async () => {
        try {
          await fs.rm(lockPath, { recursive: true, force: true });
        } catch {
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > CLAIM_LOCK_STALE_MS) {
          await fs.rm(lockPath, { recursive: true, force: true });
        }
      } catch {
      }

      await sleep(10 + Math.floor(Math.random() * 20));
    }
  }
}

async function withClaimsLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireClaimsLock(path);
  try {
    return await fn();
  } finally {
    await release();
  }
}

export function createClaimsManager(filename: string = CLAIMS_FILENAME): ClaimsManager {
  async function readClaims(): Promise<ClaimsMap> {
    const claimsPath = getClaimsPath(filename);
    try {
      const parsed = await readClaimsFile(claimsPath);
      const now = Date.now();
      const { cleaned, changed } = cleanClaims(parsed, now);

      if (changed) {
        try {
          await withClaimsLock(claimsPath, async () => {
            const current = await readClaimsFile(claimsPath);
            const latest = cleanClaims(current, Date.now());
            if (latest.changed) {
              await writeClaimsFile(claimsPath, latest.cleaned);
            }
          });
        } catch {
        }
      }

      return cleaned;
    } catch {
      return {};
    }
  }

  async function writeClaim(accountId: string): Promise<void> {
    const claimsPath = getClaimsPath(filename);
    try {
      await withClaimsLock(claimsPath, async () => {
        const now = Date.now();
        const claims = await readClaimsFile(claimsPath);
        const { cleaned } = cleanClaims(claims, now);

        cleaned[accountId] = { pid: process.pid, at: now };

        await writeClaimsFile(claimsPath, cleaned);
      });
    } catch {
    }
  }

  async function releaseClaim(accountId: string): Promise<void> {
    const claimsPath = getClaimsPath(filename);
    try {
      await withClaimsLock(claimsPath, async () => {
        const now = Date.now();
        const claims = await readClaimsFile(claimsPath);
        const { cleaned } = cleanClaims(claims, now);

        const currentClaim = cleaned[accountId];
        if (!currentClaim || currentClaim.pid !== process.pid) {
          return;
        }

        delete cleaned[accountId];

        await writeClaimsFile(claimsPath, cleaned);
      });
    } catch {
    }
  }

  function isClaimedByOther(
    claims: ClaimsMap,
    accountId: string | undefined,
  ): boolean {
    if (!accountId) return false;
    const claim = claims[accountId];
    if (!claim) return false;
    if (Date.now() - claim.at > CLAIM_EXPIRY_MS) return false;
    if (!isProcessAlive(claim.pid)) return false;
    return claim.pid !== process.pid;
  }

  return {
    readClaims,
    writeClaim,
    releaseClaim,
    isClaimedByOther,
  };
}

const defaultClaimsManager = createClaimsManager();

export function readClaims(): Promise<ClaimsMap> {
  return defaultClaimsManager.readClaims();
}

export function writeClaim(accountId: string): Promise<void> {
  return defaultClaimsManager.writeClaim(accountId);
}

export function releaseClaim(accountId: string): Promise<void> {
  return defaultClaimsManager.releaseClaim(accountId);
}

export function isClaimedByOther(
  claims: ClaimsMap,
  accountId: string | undefined,
): boolean {
  return defaultClaimsManager.isClaimedByOther(claims, accountId);
}
