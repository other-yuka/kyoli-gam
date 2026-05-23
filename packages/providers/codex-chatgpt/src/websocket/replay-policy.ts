import type { AccountFailureSignal, GatewayWebSocketMessage } from "@kyoli-gam/core";
import { hasCodexResponseCreate } from "./turn-state";

export interface CodexWebSocketReplayPolicyInput {
  failure?: AccountFailureSignal;
  downstreamVisible: boolean;
  hasCredentialAccount: boolean;
  replayableMessages: GatewayWebSocketMessage[];
  replayAttempts: number;
  maxAccountAttempts: number;
  allowCrossAccountReplay: boolean;
}

export function canReplayCodexWebSocketFailure(input: CodexWebSocketReplayPolicyInput): boolean {
  const { failure } = input;
  if (!failure || failure.retryScope !== "next_account") return false;
  if (failure.phase !== "startup") return false;
  if (input.downstreamVisible) return false;
  if (!input.hasCredentialAccount) return false;
  if (!input.allowCrossAccountReplay) return false;
  if (!hasCodexResponseCreate(input.replayableMessages)) return false;

  return input.replayAttempts < Math.max(1, input.maxAccountAttempts) - 1;
}
