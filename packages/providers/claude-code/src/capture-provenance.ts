import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

export function createClaudeCodeCaptureNonce(): string {
  return `kyoli-capture-${randomUUID()}`;
}

export function isClaudeCodeCaptureRequest(
  request: Pick<IncomingMessage, "method" | "url">,
  nonce: string,
): boolean {
  if (request.method !== "POST" || !request.url || !nonce) {
    return false;
  }

  return request.url.split("?", 1)[0] === `/${nonce}/v1/messages`;
}
