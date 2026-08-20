import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AccountStore } from "../src/account-store";
import type { StoredAccount } from "../src/types";
import { setupTestEnv } from "./helpers";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(TEST_DIR, "workers/oauth-refresh-worker.ts");
const TSX_LOADER_PATH = createRequire(import.meta.url).resolve("tsx/esm");
const ACCOUNTS_FILE = "cross-process-refresh.test.json";
const ACCOUNT_UUID = "shared-account";
const WINNER_UUID = "winner-account";

type WorkerResult = { code: number; stdout: string; stderr: string };
type TestEnv = Awaited<ReturnType<typeof setupTestEnv>>;

let server: Server | undefined;
let testEnv: TestEnv | undefined;

function runWorker(endpoint: string, id: number): Promise<WorkerResult> {
  if (!testEnv) throw new Error("Test environment is not initialized");
  const readyPath = join(testEnv.dir, `refresh-worker-${id}.ready`);
  const startPath = join(testEnv.dir, "refresh-workers.start");

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      "--import",
      TSX_LOADER_PATH,
      WORKER_PATH,
      endpoint,
      ACCOUNTS_FILE,
      ACCOUNT_UUID,
      readyPath,
      startPath,
    ], {
      env: { ...process.env, OPENCODE_CONFIG_DIR: testEnv!.dir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill(), 10_000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function waitForWorkers(): Promise<void> {
  if (!testEnv) throw new Error("Test environment is not initialized");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const ready = await Promise.all([0, 1].map(async (id) => {
      try {
        await fs.access(join(testEnv!.dir, `refresh-worker-${id}.ready`));
        return true;
      } catch {
        return false;
      }
    }));
    if (ready.every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("OAuth refresh workers did not become ready");
}

describe("cross-process OAuth refresh", () => {
  beforeEach(async () => {
    testEnv = await setupTestEnv();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
      server = undefined;
    }
    await testEnv?.cleanup();
    testEnv = undefined;
  });

  test("two processes consume one refresh token and both adopt the rotated winner identity", { timeout: 15_000 }, async () => {
    const account: StoredAccount = {
      uuid: ACCOUNT_UUID,
      refreshToken: "refresh-once",
      accessToken: "access-expired",
      expiresAt: 1,
      addedAt: 1,
      lastUsed: 1,
      enabled: true,
      consecutiveAuthFailures: 0,
      isAuthDisabled: false,
    };
    await new AccountStore(ACCOUNTS_FILE).addAccount(account);

    let requestCount = 0;
    let consumed = false;
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { refreshToken?: string };
      requestCount += 1;
      if (body.refreshToken !== "refresh-once" || consumed) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }

      consumed = true;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        accessToken: "access-winner",
        refreshToken: "refresh-winner",
        expiresAt: 4_000_000_000_000,
        uuid: WINNER_UUID,
      }));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("OAuth test server did not bind to TCP");
    const endpoint = `http://127.0.0.1:${address.port}/oauth/token`;

    const workers = [runWorker(endpoint, 0), runWorker(endpoint, 1)];
    await waitForWorkers();
    await fs.writeFile(join(testEnv!.dir, "refresh-workers.start"), "start\n");
    const results = await Promise.all(workers);

    expect(requestCount).toBe(1);
    for (const result of results) {
      expect(result.code, result.stderr).toBe(0);
    }
    const outputs = results.map((result) => JSON.parse(result.stdout));
    const winnerCredentials = {
      accessToken: "access-winner",
      refreshToken: "refresh-winner",
      expiresAt: 4_000_000_000_000,
      uuid: WINNER_UUID,
    };
    for (const output of outputs) {
      expect(output.result).toMatchObject({ ok: true, patch: winnerCredentials });
      expect(output).toMatchObject({
        resolvedUuid: WINNER_UUID,
        credentials: {
          accessToken: winnerCredentials.accessToken,
          refreshToken: winnerCredentials.refreshToken,
          expiresAt: winnerCredentials.expiresAt,
        },
      });
    }
  });
});
