import { promises as fs } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { isClaimedByOther, readClaims, releaseClaim, type ClaimsMap, writeClaim } from "../src/claims";
import { setupTestEnv } from "../tests/helpers";

const CLAIMS_FILENAME = "multiauth-claims.json";
const CLAIM_EXPIRY_MS = 60_000;
const ZOMBIE_PID = 99999999;

let cleanup: (() => Promise<void>) | undefined;
let claimsPath = "";

beforeEach(async () => {
  const env = await setupTestEnv();
  cleanup = env.cleanup;
  claimsPath = join(env.dir, CLAIMS_FILENAME);
});

afterEach(async () => {
  if (cleanup) {
    await cleanup();
    cleanup = undefined;
  }
});

async function writeRawClaims(claims: Record<string, { pid: number; at: number }>): Promise<void> {
  await fs.writeFile(claimsPath, JSON.stringify(claims, null, 2), "utf-8");
}

async function readRawClaims(): Promise<ClaimsMap> {
  const raw = await fs.readFile(claimsPath, "utf-8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Claims file has invalid format");
  }
  return parsed as ClaimsMap;
}

function spawnAliveProcess(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  child.unref();
  return child;
}

function stopAliveProcess(child: ChildProcess): void {
  if (child.killed) return;
  try {
    child.kill("SIGKILL");
  } catch {}
}

describe("readClaims", () => {
  test("returns empty object when file does not exist", async () => {
    const claims = await readClaims();
    expect(claims).toEqual({});
  });

  test("returns valid claims from file", async () => {
    const now = Date.now();
    await writeRawClaims({
      accountA: { pid: process.pid, at: now },
      accountB: { pid: process.pid, at: now - 5000 },
    });

    const claims = await readClaims();

    expect(claims.accountA).toBeDefined();
    expect(claims.accountB).toBeDefined();
    expect(claims.accountA?.pid).toBe(process.pid);
  });

  test("filters out expired claims", async () => {
    const now = Date.now();
    await writeRawClaims({
      stale: { pid: process.pid, at: now - CLAIM_EXPIRY_MS - 1 },
      fresh: { pid: process.pid, at: now },
    });

    const claims = await readClaims();

    expect(claims.stale).toBeUndefined();
    expect(claims.fresh).toBeDefined();
  });

  test("filters out zombie claims", async () => {
    const now = Date.now();
    await writeRawClaims({
      zombie: { pid: ZOMBIE_PID, at: now },
      alive: { pid: process.pid, at: now },
    });

    const claims = await readClaims();

    expect(claims.zombie).toBeUndefined();
    expect(claims.alive).toBeDefined();
  });

  test("cleans up file when expired or zombie claims are removed", async () => {
    const now = Date.now();
    await writeRawClaims({
      expired: { pid: process.pid, at: now - CLAIM_EXPIRY_MS - 1 },
      zombie: { pid: ZOMBIE_PID, at: now },
    });

    const cleaned = await readClaims();
    const fileClaims = await readRawClaims();

    expect(cleaned).toEqual({});
    expect(fileClaims).toEqual({});
  });
});

describe("writeClaim", () => {
  test("creates claim with current process PID and timestamp", async () => {
    const startedAt = Date.now();

    await writeClaim("account-1");

    const endedAt = Date.now();
    const claims = await readRawClaims();
    const claim = claims["account-1"];

    expect(claim).toBeDefined();
    expect(claim?.pid).toBe(process.pid);
    expect(claim?.at).toBeGreaterThanOrEqual(startedAt);
    expect(claim?.at).toBeLessThanOrEqual(endedAt);
  });

  test("cleans expired claims during write", async () => {
    const now = Date.now();
    await writeRawClaims({
      old: { pid: process.pid, at: now - CLAIM_EXPIRY_MS - 1 },
      keep: { pid: process.pid, at: now },
    });

    await writeClaim("new-account");

    const claims = await readRawClaims();
    expect(claims.old).toBeUndefined();
    expect(claims.keep).toBeDefined();
    expect(claims["new-account"]).toBeDefined();
  });

  test("overwrites existing claim for same account", async () => {
    const initialAt = Date.now() - 10_000;
    await writeRawClaims({
      "same-account": { pid: process.ppid > 0 ? process.ppid : 1, at: initialAt },
    });

    await writeClaim("same-account");

    const claims = await readRawClaims();
    expect(claims["same-account"]?.pid).toBe(process.pid);
    expect(claims["same-account"]?.at).toBeGreaterThan(initialAt);
  });

  test("writes file with secure permissions when supported", async () => {
    await writeClaim("perm-account");

    if (process.platform === "win32") {
      expect(true).toBe(true);
      return;
    }

    const stat = await fs.stat(claimsPath);
    const mode = stat.mode & 0o777;

    expect(mode).toBe(0o600);
  });
});

describe("releaseClaim", () => {
  test("removes claim owned by current process", async () => {
    await writeClaim("owned-account");

    await releaseClaim("owned-account");

    const claims = await readClaims();
    expect(claims["owned-account"]).toBeUndefined();
  });

  test("does not remove claim owned by different process", async () => {
    const alive = spawnAliveProcess();

    try {
      if (!alive.pid) {
        throw new Error("Unable to start alive process for test");
      }

      await writeRawClaims({
        other: { pid: alive.pid, at: Date.now() },
      });

      await releaseClaim("other");

      const claims = await readClaims();
      expect(claims.other?.pid).toBe(alive.pid);
    } finally {
      stopAliveProcess(alive);
    }
  });

  test("is a no-op when claim does not exist", async () => {
    const now = Date.now();
    await writeRawClaims({
      present: { pid: process.pid, at: now },
    });

    await releaseClaim("missing");

    const claims = await readClaims();
    expect(claims.present).toBeDefined();
  });
});

describe("isClaimedByOther", () => {
  test("returns false for undefined accountId", () => {
    const claims: ClaimsMap = {
      account: { pid: process.pid, at: Date.now() },
    };

    expect(isClaimedByOther(claims, undefined)).toBe(false);
  });

  test("returns false when no claim exists", () => {
    expect(isClaimedByOther({}, "missing")).toBe(false);
  });

  test("returns false when claimed by current process", () => {
    const claims: ClaimsMap = {
      mine: { pid: process.pid, at: Date.now() },
    };

    expect(isClaimedByOther(claims, "mine")).toBe(false);
  });

  test("returns true when claimed by another living process", () => {
    const alive = spawnAliveProcess();

    try {
      if (!alive.pid) {
        throw new Error("Unable to start alive process for test");
      }

      const claims: ClaimsMap = {
        other: { pid: alive.pid, at: Date.now() },
      };

      expect(isClaimedByOther(claims, "other")).toBe(true);
    } finally {
      stopAliveProcess(alive);
    }
  });

  test("returns false when claim is expired", () => {
    const claims: ClaimsMap = {
      stale: { pid: process.pid + 1, at: Date.now() - CLAIM_EXPIRY_MS - 1 },
    };

    expect(isClaimedByOther(claims, "stale")).toBe(false);
  });

  test("returns false when claiming PID is dead", () => {
    const claims: ClaimsMap = {
      dead: { pid: ZOMBIE_PID, at: Date.now() },
    };

    expect(isClaimedByOther(claims, "dead")).toBe(false);
  });
});

describe("concurrent access", () => {
  test("multiple writeClaim calls for different accounts do not lose data", async () => {
    const accountIds = ["a", "b", "c", "d"];

    await Promise.all(
      accountIds.map((accountId, index) => new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          writeClaim(accountId).then(resolve).catch(reject);
        }, index * 30);
      })),
    );

    const claims = await readClaims();
    for (const accountId of accountIds) {
      expect(claims[accountId]).toBeDefined();
    }
  });

  test("read after rapid write/release cycle returns consistent state", async () => {
    const accountId = "rapid-account";

    for (let i = 0; i < 20; i += 1) {
      await writeClaim(accountId);
      await releaseClaim(accountId);
    }

    const claims = await readClaims();
    expect(claims[accountId]).toBeUndefined();
  });
});
