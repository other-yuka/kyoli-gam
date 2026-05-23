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
  selectionDiagnostics?: Record<string, unknown>;
}

export type AccountFailureClass =
  | "rate_limit"
  | "quota"
  | "auth"
  | "permanent"
  | "transient"
  | "neutral";

export type AccountFailurePhase =
  | "connect"
  | "headers"
  | "startup"
  | "mid_stream"
  | "terminal";

export interface AccountFailureSignal {
  class: AccountFailureClass;
  phase: AccountFailurePhase;
  code?: string;
  message?: string;
  httpStatus?: number;
  metadata?: Record<string, unknown>;
  retryAfterSeconds?: number;
  resetAt?: string;
  retryScope?: "same_account" | "next_account" | "none";
}

export interface AccountExecutionResult {
  response: Response;
  failure?: AccountFailureSignal;
  downstreamVisible?: boolean;
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
      selectionDiagnostics?: Record<string, unknown>;
    })
  | (AccountExecutionTraceBase & {
      type: "metadata";
      provider: ProviderId;
      kind: AccountRecord["kind"];
      sessionKey: string;
      accountId?: string;
      message?: string;
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
      failureClass?: AccountFailureClass;
      failureCode?: string;
      failurePhase?: AccountFailurePhase;
    })
  | (AccountExecutionTraceBase & {
      type: "retry";
      provider: ProviderId;
      kind: AccountRecord["kind"];
      sessionKey: string;
      accountId: string;
      attempt: number;
      status: number;
      failureClass?: AccountFailureClass;
      failureCode?: string;
      failurePhase?: AccountFailurePhase;
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
  sameAccountMaxRetries?: number;
  missingCredentialResponse: () => Response;
  selectCredential: (excludeAccountIds: string[]) => Promise<SelectedCredential | undefined>;
  execute: (credential: SelectedCredential) => Promise<Response | AccountExecutionResult>;
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
      selectionDiagnostics: credential.selectionDiagnostics,
      route: input.traceRoute,
      model: input.traceModel,
    });
    const result = await executeWithSameAccountRetry(input, credential);
    const response = result.response;
    await recordAccountResult(input, credential.accountId, response, result.failure);
    const retryable = shouldRetryWithNextAccount({
      status: response.status,
      accountId: credential.accountId,
      failure: result.failure,
      downstreamVisible: result.downstreamVisible,
    });
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
      failureClass: result.failure?.class,
      failureCode: result.failure?.code,
      failurePhase: result.failure?.phase,
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
      failureClass: result.failure?.class,
      failureCode: result.failure?.code,
      failurePhase: result.failure?.phase,
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

async function executeWithSameAccountRetry(
  input: ExecuteWithAccountFailoverInput,
  credential: SelectedCredential,
): Promise<AccountExecutionResult> {
  const maxRetries = Math.max(0, input.sameAccountMaxRetries ?? 0);
  for (let retry = 0; ; retry += 1) {
    const result = normalizeAccountExecutionResult(await input.execute(credential));
    if (!shouldRetrySameAccount(result) || retry >= maxRetries) return result;
  }
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

  const status = summary.rateLimited > 0 || summary.quotaExceeded > 0 ? 429 : 503;
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
    quota_exceeded: row.quotaExceeded,
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
  if (summary.quotaExceeded > 0) {
    const suffix = summary.nextResetAt ? ` Next reset is ${summary.nextResetAt}.` : "";
    return `All ${provider} ${kind} accounts have exhausted quota.${suffix}`;
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

function normalizeAccountExecutionResult(result: Response | AccountExecutionResult): AccountExecutionResult {
  return result instanceof Response ? { response: result } : result;
}

function shouldRetryWithNextAccount(input: {
  status: number;
  accountId: string | undefined;
  failure?: AccountFailureSignal;
  downstreamVisible?: boolean;
}): boolean {
  if (!input.accountId) return false;
  if (input.failure) {
    if (input.downstreamVisible || input.failure.retryScope === "none") return false;
    if (input.failure.retryScope === "next_account") return true;
    if (input.failure.class === "rate_limit" || input.failure.class === "quota" || input.failure.class === "auth") {
      return true;
    }
    return false;
  }
  return input.status === 401 || input.status === 403 || input.status === 429;
}

function shouldRetrySameAccount(result: AccountExecutionResult): boolean {
  return Boolean(
    result.failure &&
    !result.downstreamVisible &&
    result.failure.retryScope === "same_account",
  );
}

async function recordAccountResult(
  input: ExecuteWithAccountFailoverInput,
  accountId: string | undefined,
  response: Response,
  failure?: AccountFailureSignal,
): Promise<void> {
  if (!input.accounts || !accountId) return;

  if (failure && failure.class !== "neutral") {
    const status = statusFromFailure(failure);
    if (status === undefined) return;
    const cooldownUntil = cooldownUntilFromFailure(failure);
    await input.accounts.recordFailure(accountId, {
      status,
      message: failure.message ?? input.failureMessage(status),
      rateLimitResetAt: status === 429 ? failure.resetAt : undefined,
      rateLimitCooldownUntil: status === 429 ? cooldownUntil : undefined,
      failureClass: failure.class,
      failureCode: failure.code,
      failurePhase: failure.phase,
      metadata: failure.metadata,
    });
    return;
  }

  if (response.ok) {
    await input.accounts.recordSuccess(accountId);
    return;
  }

  if (response.status === 401 || response.status === 403 || response.status === 429) {
    const resetAt = response.status === 429
      ? input.readRateLimitResetAt?.(response.headers) ?? readRateLimitResetAt(response.headers)
      : undefined;
    await input.accounts.recordFailure(accountId, {
      status: response.status,
      message: input.failureMessage(response.status),
      rateLimitResetAt: resetAt,
      rateLimitCooldownUntil: resetAt,
    });
  }
}

function statusFromFailure(failure: AccountFailureSignal): number | undefined {
  if (failure.httpStatus) return failure.httpStatus;
  if (failure.class === "rate_limit" || failure.class === "quota") return 429;
  if (failure.class === "auth") return 401;
  if (failure.class === "permanent") return 403;
  return undefined;
}

function cooldownUntilFromFailure(failure: AccountFailureSignal): string | undefined {
  if (failure.resetAt) return failure.resetAt;
  if (failure.retryAfterSeconds && failure.retryAfterSeconds > 0) {
    return new Date(Date.now() + failure.retryAfterSeconds * 1000).toISOString();
  }
  return undefined;
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
