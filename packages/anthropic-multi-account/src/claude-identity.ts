import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeIdentity {
  deviceId: string;
  accountUuid: string;
}

interface ClaudeIdentityFile {
  userID?: string;
  accountUuid?: string;
  oauthAccount?: {
    accountUuid?: string;
  };
}

const EMPTY_IDENTITY: ClaudeIdentity = {
  deviceId: "",
  accountUuid: "",
};

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
  }

  return paths;
}

function parseIdentityFile(path: string): ClaudeIdentity | null {
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as ClaudeIdentityFile;

    if (!data.userID) {
      return null;
    }

    return {
      deviceId: data.userID,
      accountUuid: data.oauthAccount?.accountUuid ?? data.accountUuid ?? "",
    };
  } catch {
    return null;
  }
}

export function loadClaudeIdentity(): ClaudeIdentity {
  try {
    for (const path of getCandidatePaths()) {
      const identity = parseIdentityFile(path);
      if (identity) {
        return identity;
      }
    }
  } catch {
  }

  return EMPTY_IDENTITY;
}
