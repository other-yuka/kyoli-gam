import { join } from "node:path";
import { homedir } from "node:os";
import { getConfig } from "./config";
import type { ManagedAccount, PluginClient } from "./types";

// ─── Shared Filesystem Utilities ─────────────────────────────────

export function getConfigDir(): string {
  return process.env.OPENCODE_CONFIG_DIR
    || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
}

export function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

// ─── Formatting & Display ────────────────────────────────────────

export function formatWaitTime(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 && days === 0) parts.push(`${seconds}s`);

  return parts.join(" ") || "0s";
}

export function getAccountLabel(account: ManagedAccount): string {
  if (account.label) return account.label;
  if (account.email) return account.email;
  if (account.uuid) return `Account (${account.uuid.slice(0, 8)})`;
  return `Account ${account.index + 1}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function showToast(
  client: PluginClient,
  message: string,
  variant: "info" | "warning" | "success" | "error",
): Promise<void> {
  if (getConfig().quiet_mode) return;
  try {
    await client.tui.showToast({ body: { message, variant } });
  } catch {
    // TUI may not be available
  }
}

export function debugLog(
  client: PluginClient,
  message: string,
  extra?: Record<string, unknown>,
): void {
  if (!getConfig().debug) return;
  client.app.log({
    body: { service: "claude-multiauth", level: "debug", message, extra },
  }).catch(() => {});
}

export function createMinimalClient(): PluginClient {
  return {
    auth: {
      set: async () => {},
    },
    tui: {
      showToast: async () => {},
    },
    app: {
      log: async () => {},
    },
  };
}
