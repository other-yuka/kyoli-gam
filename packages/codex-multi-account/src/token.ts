import {
  OPENAI_OAUTH_ADAPTER,
  OPENAI_CLIENT_ID,
  OPENAI_TOKEN_ENDPOINT,
  TOKEN_EXPIRY_BUFFER_MS,
  TOKEN_REFRESH_TIMEOUT_MS,
} from "./constants";
import { extractAccountId } from "./oauth";
import * as v from "valibot";
import {
  TokenResponseSchema,
  type ManagedAccount,
  type PluginClient,
  type CredentialRefreshPatch,
  type TokenRefreshResult,
} from "./types";

const PERMANENT_FAILURE_STATUSES = new Set([400, 401, 403]);
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TOKEN_REFRESH_TIMEOUT_MS);

    try {
      const startTime = Date.now();
      const response = await fetch(OPENAI_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: currentRefreshToken,
          client_id: OPENAI_CLIENT_ID,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const isPermanent = PERMANENT_FAILURE_STATUSES.has(response.status);
        await client.app
          .log({
            body: {
              service: OPENAI_OAUTH_ADAPTER.serviceLogName,
              level: isPermanent ? "error" : "warn",
              message: `Token refresh failed: ${response.status}${isPermanent ? " (permanent)" : ""}`,
              extra: { accountId },
            },
          })
          .catch(() => {});

        return { ok: false, permanent: isPermanent, status: response.status };
      }

      const json = v.parse(TokenResponseSchema, await response.json());

      const patch: CredentialRefreshPatch = {
        accessToken: json.access_token,
        expiresAt: startTime + json.expires_in * 1000,
        refreshToken: json.refresh_token,
        accountId: extractAccountId(json),
      };

      return { ok: true, patch };
    } catch (error) {
      await client.app
        .log({
          body: {
            service: OPENAI_OAUTH_ADAPTER.serviceLogName,
            level: "warn",
            message: `Token refresh network error: ${error instanceof Error ? error.message : String(error)}`,
            extra: { accountId },
          },
        })
        .catch(() => {});
      return { ok: false, permanent: false };
    } finally {
      clearTimeout(timeout);
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
