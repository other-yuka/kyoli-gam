import type { GatewayWebSocketMessage } from "@kyoli-gam/core";
import { CodexWebSocketResponseOwnerStore } from "./response-owner";
import {
  type CodexWebSocketTurn,
  readCodexWebSocketCompletedResponseId,
  readLatestCodexWebSocketTurn,
} from "./turn-state";

export interface CodexWebSocketRoutePlan {
  turn: CodexWebSocketTurn;
  ownerAccountId?: string;
  preferredAccountId?: string;
  requirePreferredAccount: boolean;
  allowCrossAccountReplay: boolean;
}

export class CodexWebSocketTurnRouter {
  constructor(
    private readonly responseOwners = new CodexWebSocketResponseOwnerStore(),
  ) {}

  plan(messages: GatewayWebSocketMessage[]): CodexWebSocketRoutePlan | undefined {
    const turn = readLatestCodexWebSocketTurn(messages);
    if (!turn) return undefined;

    const ownerAccountId = this.responseOwners.resolve(turn.previousResponseId);
    return {
      turn,
      ownerAccountId,
      preferredAccountId: ownerAccountId,
      requirePreferredAccount: ownerAccountId !== undefined,
      allowCrossAccountReplay: ownerAccountId === undefined,
    };
  }

  rememberCompletedResponse(
    payload: Record<string, unknown> | undefined,
    accountId: string | undefined,
  ): void {
    this.responseOwners.remember(readCodexWebSocketCompletedResponseId(payload), accountId);
  }
}
