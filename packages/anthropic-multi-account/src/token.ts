import {
  ANTHROPIC_OAUTH_ADAPTER,
  TOKEN_EXPIRY_BUFFER_MS,
} from "./constants";
import { refreshWithOAuth } from "./anthropic-oauth";
import type {
  ManagedAccount,
  PluginClient,
  TokenRefreshResult,
} from "./types";

const PERMANENT_FAILURE_HTTP_STATUSES = new Set([400, 401, 403]);
const PERMANENT_FAILURE_MESSAGE_PATTERNS = [
  /\binvalid_grant\b/i,
  /\binvalid_scope\b/i,
  /\bunauthorized_client\b/i,
  /\brefresh token\b.*\b(invalid|expired|revoked|no longer valid)\b/i,
  /\bauth(?:entication)?(?:[_\s-]+)?invalid\b/i,
];
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
      const patch = await refreshWithOAuth(currentRefreshToken);
      return { ok: true, patch };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusMatch = message.match(/\b(400|401|403)\b/);
      const hasPermanentStatus = statusMatch !== null
        && PERMANENT_FAILURE_HTTP_STATUSES.has(Number(statusMatch[1]));
      const hasPermanentMessage = PERMANENT_FAILURE_MESSAGE_PATTERNS
        .some((pattern) => pattern.test(message));
      const isPermanent = hasPermanentStatus || hasPermanentMessage;

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
