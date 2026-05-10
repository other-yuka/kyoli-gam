import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeCodeIdentity {
  accountUuid?: string;
  deviceId?: string;
}

interface ClaudeIdentityFile {
  accountUuid?: unknown;
  deviceId?: unknown;
  installId?: unknown;
  oauthAccount?: {
    accountUuid?: unknown;
  };
  userID?: unknown;
}

let cachedIdentity: ClaudeCodeIdentity | undefined;
let testIdentity: ClaudeCodeIdentity | undefined;

export function loadClaudeCodeIdentity(): ClaudeCodeIdentity {
  if (testIdentity) return testIdentity;
  if (cachedIdentity) return cachedIdentity;

  cachedIdentity = findClaudeCodeIdentity();
  return cachedIdentity;
}

export function resetClaudeCodeIdentityForTest(): void {
  cachedIdentity = undefined;
  testIdentity = undefined;
}

export function setClaudeCodeIdentityForTest(identity: ClaudeCodeIdentity): void {
  testIdentity = identity;
}

function findClaudeCodeIdentity(): ClaudeCodeIdentity {
  for (const path of getCandidatePaths()) {
    const identity = readIdentityFile(path);
    if (identity.deviceId || identity.accountUuid) return identity;
  }

  return {};
}

function getCandidatePaths(): string[] {
  const home = homedir();
  const paths = [
    join(home, ".claude.json"),
    join(home, ".claude", ".claude.json"),
    join(home, ".claude", "claude.json"),
  ];

  try {
    const backupDir = join(home, ".claude", "backups");
    const backups = readdirSync(backupDir)
      .filter((file) => file.startsWith(".claude.json.backup."))
      .sort()
      .reverse();
    for (const backup of backups) {
      paths.push(join(backupDir, backup));
    }
  } catch {
    // No backup directory is a normal state.
  }

  return paths;
}

function readIdentityFile(path: string): ClaudeCodeIdentity {
  try {
    const payload = JSON.parse(readFileSync(path, "utf-8")) as ClaudeIdentityFile;
    return {
      accountUuid: readString(payload.oauthAccount?.accountUuid) ?? readString(payload.accountUuid),
      deviceId: readString(payload.userID) ?? readString(payload.installId) ?? readString(payload.deviceId),
    };
  } catch {
    return {};
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
