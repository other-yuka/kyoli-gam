import type { AccountPool } from "./account-pool";
import type { AccountRecord } from "./accounts";
import type { ProviderId } from "./index";
import {
  listBlockedAccounts,
  listRateLimitedAccounts,
  summarizeAccountStatus,
} from "./account-status";

interface AccountExecutionTraceBase {
  requestId: string;
  route?: string;
  model?: string;
}

export interface SelectedCredential {
  value: string;
  accountId?: string;
}

export type AccountExecutionTraceEvent =
  | (AccountExecutionTraceBase & {
      type: "credential_unavailable";
      provider: ProviderId;
      kind: AccountRecord["kind"];
      sessionKey: string;
      accountId: string;
      message: string;
    })
  | (AccountExecutionTraceBase & {
      type: "selected";
      provider: ProviderId;
      kind: AccountRecord["kind"];
      sessionKey: string;
      accountId?: string;
      attempt: number;
    })
  | (AccountExecutionTraceBase & {
      type: "response";
      provider: ProviderId;
      kind: AccountRecord["kind"];
      sessionKey: string;
      accountId?: string;
      attempt: number;
      status: number;
      retryable: boolean;
    })
  | (AccountExecutionTraceBase & {
      type: "retry";
      provider: ProviderId;
      kind: AccountRecord["kind"];
      sessionKey: string;
      accountId: string;
      attempt: number;
      status: number;
    })
  | (AccountExecutionTraceBase & {
      type: "missing";
      provider: ProviderId;
      kind: AccountRecord["kind"];
      sessionKey: string;
      excludedAccountIds: string[];
      hadRetryableResponse: boolean;
    });

export class CredentialUnavailableError extends Error {
  constructor(
    message: string,
    readonly accountId: string,
  ) {
    super(message);
    this.name = "CredentialUnavailableError";
  }
}

export interface ExecuteWithAccountFailoverInput {
  provider: ProviderId;
  kind: AccountRecord["kind"];
  accounts?: AccountPool;
  configuredCredential?: SelectedCredential;
  sessionKey: string;
  maxAttempts?: number;
  missingCredentialResponse: () => Response;
  selectCredential: (excludeAccountIds: string[]) => Promise<SelectedCredential | undefined>;
  execute: (credential: SelectedCredential) => Promise<Response>;
  failureMessage: (status: number) => string;
  readRateLimitResetAt?: (headers: Headers) => string | undefined;
  onTrace?: (event: AccountExecutionTraceEvent) => void;
  traceRoute?: string;
  traceModel?: string;
}

export async function executeWithAccountFailover(
  input: ExecuteWithAccountFailoverInput,
): Promise<Response> {
  const excludedAccountIds: string[] = [];
  const maxAttempts = Math.max(1, input.maxAttempts ?? 10);
  const requestId = crypto.randomUUID();
  let lastRetryableResponse: Response | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const credential =
      input.configuredCredential ??
      (await input.selectCredential(excludedAccountIds).catch((error) => {
        if (error instanceof CredentialUnavailableError) {
          excludedAccountIds.push(error.accountId);
          input.onTrace?.({
            requestId,
            type: "credential_unavailable",
            provider: input.provider,
            kind: input.kind,
            sessionKey: input.sessionKey,
            accountId: error.accountId,
            message: error.message,
            route: input.traceRoute,
            model: input.traceModel,
          });
          return undefined;
        }
        throw error;
      }));

    if (!credential) {
      if (excludedAccountIds.length > 0 && !input.configuredCredential) {
        continue;
      }

      input.onTrace?.({
        requestId,
        type: "missing",
        provider: input.provider,
        kind: input.kind,
        sessionKey: input.sessionKey,
        excludedAccountIds: [...excludedAccountIds],
        hadRetryableResponse: Boolean(lastRetryableResponse),
        route: input.traceRoute,
        model: input.traceModel,
      });
      return lastRetryableResponse
        ? cloneUpstreamResponse(lastRetryableResponse)
        : unavailableCredentialResponse(input, excludedAccountIds, Boolean(lastRetryableResponse));
    }

    input.onTrace?.({
      requestId,
      type: "selected",
      provider: input.provider,
      kind: input.kind,
      sessionKey: input.sessionKey,
      accountId: credential.accountId,
      attempt: attempt + 1,
      route: input.traceRoute,
      model: input.traceModel,
    });
    const response = await input.execute(credential);
    await recordAccountResult(input, credential.accountId, response);
    const retryable = shouldRetryWithNextAccount(response.status, credential.accountId);
    input.onTrace?.({
      requestId,
      type: "response",
      provider: input.provider,
      kind: input.kind,
      sessionKey: input.sessionKey,
      accountId: credential.accountId,
      attempt: attempt + 1,
      status: response.status,
      retryable,
      route: input.traceRoute,
      model: input.traceModel,
    });

    if (!retryable || !credential.accountId) {
      return cloneUpstreamResponse(response);
    }

    lastRetryableResponse = response;
    excludedAccountIds.push(credential.accountId);
    input.onTrace?.({
      requestId,
      type: "retry",
      provider: input.provider,
      kind: input.kind,
      sessionKey: input.sessionKey,
      accountId: credential.accountId,
      attempt: attempt + 1,
      status: response.status,
      route: input.traceRoute,
      model: input.traceModel,
    });

    if (input.configuredCredential) {
      return cloneUpstreamResponse(response);
    }
  }

  input.onTrace?.({
    requestId,
    type: "missing",
    provider: input.provider,
    kind: input.kind,
    sessionKey: input.sessionKey,
    excludedAccountIds: [...excludedAccountIds],
    hadRetryableResponse: Boolean(lastRetryableResponse),
    route: input.traceRoute,
    model: input.traceModel,
  });
  return lastRetryableResponse
    ? cloneUpstreamResponse(lastRetryableResponse)
    : unavailableCredentialResponse(input, excludedAccountIds, Boolean(lastRetryableResponse));
}

async function unavailableCredentialResponse(
  input: ExecuteWithAccountFailoverInput,
  excludedAccountIds: string[],
  hadRetryableResponse: boolean,
): Promise<Response> {
  const accounts = (await input.accounts?.listByProvider(input.provider))
    ?.filter((account) => account.kind === input.kind);
  if (!accounts || accounts.length === 0) return input.missingCredentialResponse();

  const summary = summarizeAccountStatus(accounts)[0];
  if (!summary) return input.missingCredentialResponse();

  const status = summary.rateLimited > 0 ? 429 : 503;
  const type = status === 429 ? "account_rate_limited" : "account_exhausted";
  const retryAfterSeconds = summary.nextResetAt ? secondsUntil(summary.nextResetAt) : undefined;
  const headers: Record<string, string> = {};
  if (retryAfterSeconds) headers["retry-after"] = String(retryAfterSeconds);

  return jsonErrorResponse(
    {
      error: {
        type,
        message: accountExhaustionMessage(input.provider, input.kind, summary),
        provider: input.provider,
        kind: input.kind,
        summary: toPublicAccountStatusSummary(summary),
        retryable: status === 429,
        next_reset_at: summary.nextResetAt,
        excluded_account_ids: excludedAccountIds,
        had_retryable_response: hadRetryableResponse,
        rate_limited_accounts: listRateLimitedAccounts(accounts),
        blocked_accounts: listBlockedAccounts(accounts),
      },
    },
    { status, headers },
  );
}

function toPublicAccountStatusSummary(row: ReturnType<typeof summarizeAccountStatus>[number]) {
  return {
    provider: row.provider,
    total: row.total,
    ready: row.ready,
    rate_limited: row.rateLimited,
    auth_cooldown: row.authCooldown,
    disabled: row.disabled,
    reauth_required: row.reauthRequired,
    failed: row.failed,
    next_reset_at: row.nextResetAt,
    next_auth_retry_at: row.nextAuthRetryAt,
  };
}

function accountExhaustionMessage(
  provider: ProviderId,
  kind: AccountRecord["kind"],
  summary: NonNullable<ReturnType<typeof summarizeAccountStatus>[number]>,
): string {
  if (summary.rateLimited > 0) {
    const suffix = summary.nextResetAt ? ` Next reset is ${summary.nextResetAt}.` : "";
    return `All ${provider} ${kind} accounts are currently rate-limited.${suffix}`;
  }
  if (summary.authCooldown > 0) {
    const suffix = summary.nextAuthRetryAt ? ` Next auth retry is ${summary.nextAuthRetryAt}.` : "";
    return `All ${provider} ${kind} accounts are in auth-failure cooldown.${suffix}`;
  }

  return `No ready ${provider} ${kind} accounts are available. Check disabled accounts or accounts that require re-authentication.`;
}

function jsonErrorResponse(data: unknown, init: ResponseInit): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });
}

function secondsUntil(iso: string): number | undefined {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.ceil(ms / 1000);
}

function shouldRetryWithNextAccount(status: number, accountId: string | undefined): accountId is string {
  return Boolean(accountId && (status === 401 || status === 403 || status === 429));
}

async function recordAccountResult(
  input: ExecuteWithAccountFailoverInput,
  accountId: string | undefined,
  response: Response,
): Promise<void> {
  if (!input.accounts || !accountId) return;

  if (response.ok) {
    await input.accounts.recordSuccess(accountId);
    return;
  }

  if (response.status === 401 || response.status === 403 || response.status === 429) {
    await input.accounts.recordFailure(accountId, {
      status: response.status,
      message: input.failureMessage(response.status),
      rateLimitResetAt: response.status === 429
        ? input.readRateLimitResetAt?.(response.headers) ?? readRateLimitResetAt(response.headers)
        : undefined,
    });
  }
}

function cloneUpstreamResponse(upstream: Response): Response {
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: filterResponseHeaders(upstream.headers),
  });
}

function filterResponseHeaders(headers: Headers): Headers {
  const filtered = new Headers(headers);
  filtered.delete("content-encoding");
  filtered.delete("content-length");
  filtered.delete("transfer-encoding");
  filtered.delete("connection");
  return filtered;
}

function readRateLimitResetAt(headers: Headers): string | undefined {
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return undefined;

  const seconds = Number.parseInt(retryAfter, 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return new Date(Date.now() + seconds * 1000).toISOString();
  }

  const date = new Date(retryAfter);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
