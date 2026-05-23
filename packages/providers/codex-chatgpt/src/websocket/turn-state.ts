import type { GatewayWebSocketMessage } from "@kyoli-gam/core";

export interface CodexWebSocketTurn {
  type: "response.create";
  model?: string;
  previousResponseId?: string;
}

export function readCodexWebSocketTurn(message: GatewayWebSocketMessage): CodexWebSocketTurn | undefined {
  if (message.type !== "text") return undefined;
  const payload = readJsonRecordFromString(message.data);
  if (payload?.type !== "response.create") return undefined;
  return {
    type: "response.create",
    model: readString(payload.model),
    previousResponseId: readString(payload.previous_response_id),
  };
}

export function hasCodexResponseCreate(messages: GatewayWebSocketMessage[]): boolean {
  return messages.some((message) => readCodexWebSocketTurn(message) !== undefined);
}

export function readLatestCodexWebSocketTurn(
  messages: GatewayWebSocketMessage[],
): CodexWebSocketTurn | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const turn = readCodexWebSocketTurn(messages[index]!);
    if (turn) return turn;
  }
  return undefined;
}

export function readCodexWebSocketCompletedResponseId(
  payload: Record<string, unknown> | undefined,
): string | undefined {
  if (readString(payload?.type) !== "response.completed") return undefined;
  const response = readRecord(payload?.response);
  return readString(response?.id);
}

export function readJsonRecordFromString(value: string): Record<string, unknown> | undefined {
  try {
    return readRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
