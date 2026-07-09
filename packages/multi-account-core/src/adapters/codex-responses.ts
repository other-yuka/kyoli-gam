import {
  superviseSseResponseStartup,
  type SupervisedTurnResponse,
  type TurnFailureClass,
  type TurnFailurePhase,
  type TurnFailureSignal,
} from "../turn-supervisor";

export const CODEX_UNKNOWN_RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;
export const CODEX_STARTUP_PROBE_MAX_BYTES = 64 * 1024;

export function superviseCodexResponseStartup(response: Response): Promise<SupervisedTurnResponse> {
  return superviseSseResponseStartup(response, {
    maxBufferedBytes: CODEX_STARTUP_PROBE_MAX_BYTES,
    classifyFailure: classifyCodexSseStartupFailure,
    isCommitFrame: isCodexStartupOutputFrame,
    createBufferLimitFailure: createCodexBufferLimitFailure,
    createFailureResponse: codexFailureResponse,
  });
}

function createCodexBufferLimitFailure(bufferedBytes: number): TurnFailureSignal {
  return {
    class: "transient",
    phase: "startup",
    code: "startup_buffer_limit_exceeded",
    message: `Codex upstream produced ${bufferedBytes} bytes without output; retrying before exposing the stream.`,
    httpStatus: 502,
    retryScope: "same_account",
  };
}

export function isCodexStartupOutputFrame(frame: string): boolean {
  const payload = readSseJsonRecord(frame);
  if (!payload) return false;
  return isCodexStartupOutputEvent(payload, readSseEvent(frame));
}

export function isCodexStartupOutputEvent(value: unknown, event?: string): boolean {
  const payload = readRecord(value);
  if (!payload) return false;
  const type = readString(payload.type) ?? event;
  if (
    type === "response.output_text.delta" ||
    type === "response.refusal.delta" ||
    type === "response.function_call_arguments.delta" ||
    type === "response.function_call_arguments.done" ||
    type === "response.output_item.done" ||
    type === "response.completed" ||
    type === "response.incomplete"
  ) {
    return true;
  }
  if (type === "response.output_item.added") {
    const item = readRecord(payload.item);
    const itemType = readString(item?.type);
    return itemType === "message" || itemType === "function_call";
  }
  return false;
}

export function classifyCodexSseStartupFailure(frame: string): TurnFailureSignal | undefined {
  const event = readSseEvent(frame);
  const payload = readSseJsonRecord(frame);
  if (!payload) return undefined;

  const payloadType = readString(payload.type);
  if (event !== "response.failed" && event !== "error" && payloadType !== "response.failed" && payloadType !== "error") {
    return undefined;
  }

  return classifyCodexFailurePayload(payload, "startup");
}

export function classifyCodexJsonEventFailure(
  value: unknown,
  phase: TurnFailurePhase,
): TurnFailureSignal | undefined {
  const payload = readRecord(value);
  if (!payload) return undefined;
  const payloadType = readString(payload.type);
  if (payloadType !== "response.failed" && payloadType !== "error") return undefined;
  return classifyCodexFailurePayload(payload, phase);
}

export function classifyCodexFailure(
  code: string | undefined,
  message: string,
): TurnFailureClass {
  const normalizedCode = code?.toLowerCase();
  if (normalizedCode === "rate_limit_exceeded" || normalizedCode === "usage_limit_reached") return "rate_limit";
  if (
    normalizedCode === "insufficient_quota" ||
    normalizedCode === "usage_not_included" ||
    normalizedCode === "quota_exceeded"
  ) return "quota";
  if (normalizedCode === "invalid_api_key" || normalizedCode === "invalid_iam_token") return "auth";
  if (
    normalizedCode === "server_is_overloaded" ||
    normalizedCode === "slow_down" ||
    normalizedCode === "model_at_capacity"
  ) return "transient";

  const normalized = `${code ?? ""} ${message}`.toLowerCase();
  if (
    normalized.includes("rate_limit") ||
    normalized.includes("usage_limit") ||
    normalized.includes("usage limit") ||
    normalized.includes("codex/settings/usage") ||
    normalized.includes("upgrade to pro") ||
    normalized.includes("purchase more credits")
  ) return "rate_limit";
  if (
    normalized.includes("quota exceeded") ||
    normalized.includes("insufficient quota") ||
    normalized.includes("usage not included")
  ) return "quota";
  return "transient";
}

export function parseCodexRetryAfterSeconds(message: string): number | undefined {
  const match = message.match(/try again in\s*(\d+(?:\.\d+)?)\s*(ms|s|seconds?)/i);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1]!);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return match[2]!.toLowerCase() === "ms" ? value / 1000 : value;
}

function classifyCodexFailurePayload(
  payload: Record<string, unknown>,
  phase: TurnFailurePhase,
): TurnFailureSignal {
  const response = readRecord(payload.response);
  const error = readRecord(response?.error) ?? readRecord(payload.error);
  const code = readString(error?.code) ?? readString(error?.type) ?? readString(payload.code);
  const message =
    readString(error?.message) ??
    readString(payload.message) ??
    (code ? `Codex upstream failed: ${code}` : "Codex upstream failed before producing output.");
  const failureClass = classifyCodexFailure(code, message);
  const retryAfterSeconds = parseCodexRetryAfterSeconds(message);
  const resetAt = parseCodexResetMetadata(error) ??
    parseCodexResetMetadata(payload) ??
    defaultCodexResetAt(failureClass, code, message);

  return {
    class: failureClass,
    phase,
    code: code ?? (failureClass === "rate_limit" ? "rate_limit_exceeded" : "upstream_response_failed"),
    message,
    httpStatus: readNumber(payload.status) ?? httpStatusFromCodexFailure(failureClass),
    retryAfterSeconds: retryAfterSeconds ?? secondsUntilIso(resetAt),
    resetAt,
    retryScope: failureClass === "rate_limit" || failureClass === "quota" || failureClass === "auth"
      ? "next_account"
      : failureClass === "transient"
      ? "same_account"
      : "none",
  };
}

function codexFailureResponse(failure: TurnFailureSignal): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  if (failure.retryAfterSeconds) headers.set("retry-after", String(failure.retryAfterSeconds));
  if (failure.resetAt) headers.set("x-kyoli-account-reset-at", failure.resetAt);
  return new Response(JSON.stringify({
    error: {
      type: failure.code ?? "upstream_response_failed",
      message: failure.message ?? "Codex upstream failed before producing output.",
      upstream_status: "response.failed",
    },
  }), {
    status: failure.httpStatus ?? 502,
    headers,
  });
}

function httpStatusFromCodexFailure(failureClass: TurnFailureClass): number {
  if (failureClass === "rate_limit" || failureClass === "quota") return 429;
  if (failureClass === "auth") return 401;
  if (failureClass === "permanent") return 403;
  return 502;
}

function parseCodexResetMetadata(value: Record<string, unknown> | undefined): string | undefined {
  if (!value) return undefined;
  const resetsAt = readNumeric(value.resets_at);
  if (resetsAt !== undefined && resetsAt > 0) {
    const ms = resetsAt > 1_000_000_000_000 ? resetsAt : resetsAt * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  const resetsInSeconds = readNumeric(value.resets_in_seconds);
  if (resetsInSeconds !== undefined && resetsInSeconds > 0) {
    return new Date(Date.now() + resetsInSeconds * 1000).toISOString();
  }
  return undefined;
}

function defaultCodexResetAt(
  failureClass: TurnFailureClass,
  code: string | undefined,
  message: string,
): string | undefined {
  if (failureClass !== "rate_limit" && failureClass !== "quota") return undefined;
  if (isCodexUsageLimitFailure(code, message)) return undefined;
  return new Date(Date.now() + CODEX_UNKNOWN_RATE_LIMIT_BACKOFF_MS).toISOString();
}

function isCodexUsageLimitFailure(code: string | undefined, message: string): boolean {
  const normalized = `${code ?? ""} ${message}`.toLowerCase();
  return normalized.includes("usage_limit_reached") ||
    normalized.includes("usage limit") ||
    normalized.includes("codex/settings/usage") ||
    normalized.includes("upgrade to plus") ||
    normalized.includes("upgrade to pro") ||
    normalized.includes("purchase more credits");
}

function readSseEvent(frame: string): string | undefined {
  return frame.split(/\r\n|\r|\n/)
    .find((line) => line.startsWith("event:"))
    ?.slice("event:".length)
    .trim();
}

function readSseData(frame: string): string | undefined {
  const lines = frame.split(/\r\n|\r|\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function readSseJsonRecord(frame: string): Record<string, unknown> | undefined {
  const data = readSseData(frame);
  if (!data || data === "[DONE]") return undefined;
  try {
    return readRecord(JSON.parse(data));
  } catch {
    return undefined;
  }
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
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNumeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function secondsUntilIso(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = new Date(iso).getTime() - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 1000) : undefined;
}
