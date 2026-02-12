import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { getConfigDir } from "./utils";

const CLAIMS_FILENAME = "multiauth-claims.json";
const CLAIM_EXPIRY_MS = 60_000;

export type ClaimsMap = Record<string, { pid: number; at: number }>;

function getClaimsPath(): string {
  return join(getConfigDir(), CLAIMS_FILENAME);
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

async function writeClaimsFile(claims: ClaimsMap): Promise<void> {
  const path = getClaimsPath();
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

export async function readClaims(): Promise<ClaimsMap> {
  try {
    const data = await fs.readFile(getClaimsPath(), "utf-8");
    const parsed = parseClaims(data);
    const now = Date.now();
    const { cleaned, changed } = cleanClaims(parsed, now);

    if (changed) {
      try {
        await writeClaimsFile(cleaned);
      } catch {
        // best-effort cleanup
      }
    }

    return cleaned;
  } catch {
    return {};
  }
}

// Best-effort read-modify-write: not atomic across processes, but acceptable
// because stale/duplicate claims self-expire via CLAIM_EXPIRY_MS and zombie detection.
export async function writeClaim(accountId: string): Promise<void> {
  const now = Date.now();
  const claims = await readClaims();
  const { cleaned } = cleanClaims(claims, now);

  cleaned[accountId] = { pid: process.pid, at: now };

  try {
    await writeClaimsFile(cleaned);
  } catch {
    // best-effort claim update
  }
}

// Best-effort read-modify-write: same rationale as writeClaim above.
export async function releaseClaim(accountId: string): Promise<void> {
  const now = Date.now();
  const claims = await readClaims();
  const { cleaned } = cleanClaims(claims, now);

  const currentClaim = cleaned[accountId];
  if (!currentClaim || currentClaim.pid !== process.pid) {
    return;
  }

  delete cleaned[accountId];

  try {
    await writeClaimsFile(cleaned);
  } catch {
    // best-effort release
  }
}

export function isClaimedByOther(
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
