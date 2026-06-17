const CODEX_BACKEND_API_BASE = "https://chatgpt.com/backend-api";
const CODEX_USER_AGENT = "codex_cli_rs/0.0.0";

export const CODEX_RATE_LIMIT_RESET_CREDITS_ENDPOINT = `${CODEX_BACKEND_API_BASE}/wham/rate-limit-reset-credits`;
export const CODEX_RATE_LIMIT_RESET_CONSUME_ENDPOINT = `${CODEX_RATE_LIMIT_RESET_CREDITS_ENDPOINT}/consume`;

export interface CodexRateLimitResetCredit {
  id: string;
  status?: string;
  resetType?: string;
  title?: string;
  grantedAt?: string;
  expiresAt?: string;
  redeemedAt?: string;
}

export interface CodexRateLimitResetCreditsStatus {
  availableCount: number;
  credits: CodexRateLimitResetCredit[];
  raw: unknown;
}

export interface CodexRateLimitResetConsumeResult {
  code?: string;
  windowsReset?: number;
  credit?: CodexRateLimitResetCredit;
  raw: unknown;
}

export class CodexRateLimitResetError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "CodexRateLimitResetError";
  }
}

export async function fetchCodexRateLimitResetCredits(input: {
  accessToken: string;
  chatgptAccountId: string;
  fetchImpl?: typeof fetch;
}): Promise<CodexRateLimitResetCreditsStatus> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(CODEX_RATE_LIMIT_RESET_CREDITS_ENDPOINT, {
    method: "GET",
    headers: buildCodexResetHeaders(input.accessToken, input.chatgptAccountId),
  });
  const payload = await readJsonOrText(response);

  if (!response.ok) {
    throw new CodexRateLimitResetError(
      response.status,
      readBackendErrorMessage(payload) ?? `Codex reset credit status failed with ${response.status}`,
      payload,
    );
  }

  return mapResetCreditsStatus(payload);
}

export async function consumeCodexRateLimitResetCredit(input: {
  accessToken: string;
  chatgptAccountId: string;
  creditId: string;
  redeemRequestId?: string;
  fetchImpl?: typeof fetch;
}): Promise<CodexRateLimitResetConsumeResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(CODEX_RATE_LIMIT_RESET_CONSUME_ENDPOINT, {
    method: "POST",
    headers: {
      ...buildCodexResetHeaders(input.accessToken, input.chatgptAccountId),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      credit_id: input.creditId,
      redeem_request_id: input.redeemRequestId ?? crypto.randomUUID(),
    }),
  });
  const payload = await readJsonOrText(response);

  if (!response.ok) {
    throw new CodexRateLimitResetError(
      response.status,
      readBackendErrorMessage(payload) ?? `Codex reset credit consume failed with ${response.status}`,
      payload,
    );
  }

  return mapConsumeResult(payload);
}

function buildCodexResetHeaders(accessToken: string, chatgptAccountId: string): Record<string, string> {
  return {
    accept: "application/json",
    authorization: `Bearer ${accessToken}`,
    "ChatGPT-Account-Id": chatgptAccountId,
    "user-agent": CODEX_USER_AGENT,
  };
}

async function readJsonOrText(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function mapResetCreditsStatus(payload: unknown): CodexRateLimitResetCreditsStatus {
  const record = readRecord(payload);
  return {
    availableCount: readNumber(record?.available_count ?? record?.availableCount) ?? 0,
    credits: Array.isArray(record?.credits)
      ? record.credits.map(mapCredit).filter((credit): credit is CodexRateLimitResetCredit => Boolean(credit))
      : [],
    raw: payload,
  };
}

function mapConsumeResult(payload: unknown): CodexRateLimitResetConsumeResult {
  const record = readRecord(payload);
  return {
    code: readString(record?.code),
    windowsReset: readNumber(record?.windows_reset ?? record?.windowsReset),
    credit: mapCredit(record?.credit),
    raw: payload,
  };
}

function mapCredit(value: unknown): CodexRateLimitResetCredit | undefined {
  const record = readRecord(value);
  if (!record) return undefined;
  const id = readString(record.id);
  if (!id) return undefined;
  return {
    id,
    status: readString(record.status),
    resetType: readString(record.reset_type ?? record.resetType),
    title: readString(record.title),
    grantedAt: readString(record.granted_at ?? record.grantedAt),
    expiresAt: readString(record.expires_at ?? record.expiresAt),
    redeemedAt: readString(record.redeemed_at ?? record.redeemedAt),
  };
}

function readBackendErrorMessage(payload: unknown): string | undefined {
  if (typeof payload === "string") return summarizeText(payload);
  const record = readRecord(payload);
  const error = readRecord(record?.error);
  return readString(error?.message) ?? readString(record?.message);
}

function summarizeText(value: string, limit = 240): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
