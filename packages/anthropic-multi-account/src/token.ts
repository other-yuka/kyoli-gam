import {
  ANTHROPIC_OAUTH_ADAPTER,
  TOKEN_EXPIRY_BUFFER_MS,
} from "./constants";
import { refreshWithPiAi } from "./pi-ai-adapter";
import type {
  ManagedAccount,
  PluginClient,
  TokenRefreshResult,
} from "./types";

const PERMANENT_FAILURE_HTTP_STATUSES = new Set([400, 401, 403]);
const refreshMutexByAccountId = new Map<string, Promise<TokenRefreshResult>>();

export function isTokenExpired(account: Pick<ManagedAccount, "accessToken" | "expiresAt">): boolean {
  if (!account.accessToken || !account.expiresAt) return true;
  return account.expiresAt <= Date.now() + TOKEN_EXPIRY_BUFFER_MS;
}

export async function refreshToken(
  currentRefreshToken: string,
  accountId: string,
  client: PluginClient,
): Promise<TokenRefreshResult> {
  if (!currentRefreshToken) return { ok: false, permanent: true };

  const inFlightRefresh = refreshMutexByAccountId.get(accountId);
  if (inFlightRefresh) return inFlightRefresh;

  const refreshPromise = (async (): Promise<TokenRefreshResult> => {
    try {
      const patch = await refreshWithPiAi(currentRefreshToken);
      return { ok: true, patch };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusMatch = message.match(/\b(400|401|403)\b/);
      const isPermanent = statusMatch !== null
        && PERMANENT_FAILURE_HTTP_STATUSES.has(Number(statusMatch[1]));

      await client.app
        .log({
          body: {
            service: ANTHROPIC_OAUTH_ADAPTER.serviceLogName,
            level: isPermanent ? "error" : "warn",
            message: `Token refresh failed: ${message}${isPermanent ? " (permanent)" : ""}`,
            extra: { accountId },
          },
        })
        .catch(() => {});

      return { ok: false, permanent: isPermanent };
    } finally {
      refreshMutexByAccountId.delete(accountId);
    }
  })();

  refreshMutexByAccountId.set(accountId, refreshPromise);
  return refreshPromise;
}

export function clearRefreshMutex(accountId?: string): void {
  if (accountId) {
    refreshMutexByAccountId.delete(accountId);
    return;
  }

  refreshMutexByAccountId.clear();
}
