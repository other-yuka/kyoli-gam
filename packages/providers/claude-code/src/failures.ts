import type { AccountFailureClass, AccountFailureSignal } from "@kyoli-gam/core";

export function isClaudeCodeStartupOutputFrame(frame: string): boolean {
  const payload = readSseJsonRecord(frame);
  if (!payload) return false;
  const type = readString(payload.type) ?? readSseEvent(frame);
  return type === "message_start" ||
    type === "content_block_start" ||
    type === "content_block_delta" ||
    type === "content_block_stop" ||
    type === "message_delta" ||
    type === "message_stop";
}

export function classifyClaudeCodeSseStartupFailure(frame: string): AccountFailureSignal | undefined {
  const event = readSseEvent(frame);
  const payload = readSseJsonRecord(frame);
  if (!payload) return undefined;

  const payloadType = readString(payload.type);
  if (event !== "error" && payloadType !== "error") return undefined;

  return classifyClaudeCodeFailurePayload(payload, "startup");
}

function classifyClaudeCodeFailurePayload(
  payload: Record<string, unknown>,
  phase: AccountFailureSignal["phase"],
): AccountFailureSignal {
  const error = readRecord(payload.error) ?? payload;
  const code = readString(error.type) ?? readString(error.code) ?? readString(payload.type);
  const message =
    readString(error.message) ??
    readString(payload.message) ??
    (code ? `Claude Code upstream failed: ${code}` : "Claude Code upstream failed before producing output.");
  const failureClass = classifyClaudeCodeFailure(code, message);

  return {
    class: failureClass,
    phase,
    code: code ?? "upstream_error",
    message,
    httpStatus: httpStatusFromClaudeFailure(failureClass, code),
    retryScope: retryScopeFromClaudeFailure(failureClass),
  };
}

function classifyClaudeCodeFailure(code: string | undefined, message: string): AccountFailureClass {
  const normalizedCode = code?.toLowerCase();
  if (normalizedCode === "rate_limit_error") return "rate_limit";
  if (normalizedCode === "authentication_error" || normalizedCode === "permission_error") return "auth";
  if (normalizedCode === "overloaded_error" || normalizedCode === "api_error") return "transient";
  if (normalizedCode === "invalid_request_error" || normalizedCode === "not_found_error") return "permanent";

  const normalized = `${code ?? ""} ${message}`.toLowerCase();
  if (normalized.includes("rate limit") || normalized.includes("rate_limit") || normalized.includes("try again")) {
    return "rate_limit";
  }
  if (normalized.includes("quota") || normalized.includes("credit balance")) return "quota";
  if (normalized.includes("auth") || normalized.includes("permission") || normalized.includes("unauthorized")) {
    return "auth";
  }
  if (normalized.includes("overloaded") || normalized.includes("temporarily unavailable")) return "transient";
  return "transient";
}

function httpStatusFromClaudeFailure(failureClass: AccountFailureClass, code: string | undefined): number {
  if (failureClass === "rate_limit" || failureClass === "quota") return 429;
  if (failureClass === "auth") return 401;
  if (failureClass === "permanent") return code === "not_found_error" ? 404 : 400;
  return 502;
}

function retryScopeFromClaudeFailure(
  failureClass: AccountFailureClass,
): AccountFailureSignal["retryScope"] {
  if (failureClass === "rate_limit" || failureClass === "quota" || failureClass === "auth") return "next_account";
  if (failureClass === "transient") return "same_account";
  return "none";
}

function readSseEvent(frame: string): string | undefined {
  return frame.split(/\r?\n/)
    .find((line) => line.startsWith("event:"))
    ?.slice("event:".length)
    .trim();
}

function readSseData(frame: string): string | undefined {
  const lines = frame.split(/\r?\n/)
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
