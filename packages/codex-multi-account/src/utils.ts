export {
  createMinimalClient,
  formatWaitTime,
  getAccountLabel,
  getConfigDir,
  getErrorCode,
  sleep,
} from "opencode-multi-account-core";
import type { PluginClient } from "./types";
import { OPENAI_OAUTH_ADAPTER } from "./constants";
import { getConfig } from "./config";

export async function showToast(
  client: PluginClient,
  message: string,
  variant: "info" | "warning" | "success" | "error",
): Promise<void> {
  if (getConfig().quiet_mode) return;
  try {
    await client.tui.showToast({ body: { message, variant } });
  } catch {
  }
}

export function debugLog(
  client: PluginClient,
  message: string,
  extra?: Record<string, unknown>,
): void {
  if (!getConfig().debug) return;
  client.app.log({
    body: { service: OPENAI_OAUTH_ADAPTER.serviceLogName, level: "debug", message, extra },
  }).catch(() => {});
}
