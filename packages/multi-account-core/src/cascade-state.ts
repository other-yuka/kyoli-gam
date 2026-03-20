import type { CascadeState } from "./pool-types";

function createCascadeState(prompt: string, currentAccountUuid?: string): CascadeState {
  const attemptedAccounts = new Set<string>();
  if (currentAccountUuid) {
    attemptedAccounts.add(currentAccountUuid);
  }

  return {
    prompt,
    attemptedAccounts,
    visitedChainIndexes: new Set<number>(),
  };
}

export class CascadeStateManager {
  public suppressNextStartTurn = false;
  private cascadeState: CascadeState | null = null;

  startTurn(prompt: string, currentAccountUuid?: string): CascadeState {
    if (this.suppressNextStartTurn) {
      this.suppressNextStartTurn = false;
      return this.ensureCascadeState(prompt, currentAccountUuid);
    }

    const shouldReset = !this.cascadeState || this.cascadeState.prompt !== prompt;
    if (shouldReset) {
      this.cascadeState = createCascadeState(prompt, currentAccountUuid);
      return this.cascadeState;
    }

    return this.ensureCascadeState(prompt, currentAccountUuid);
  }

  ensureCascadeState(prompt: string, currentAccountUuid?: string): CascadeState {
    if (!this.cascadeState || this.cascadeState.prompt !== prompt) {
      this.cascadeState = createCascadeState(prompt, currentAccountUuid);
      return this.cascadeState;
    }

    if (currentAccountUuid) {
      this.cascadeState.attemptedAccounts.add(currentAccountUuid);
    }

    return this.cascadeState;
  }

  markAttempted(accountUuid: string): void {
    if (!this.cascadeState) return;
    this.cascadeState.attemptedAccounts.add(accountUuid);
  }

  markVisitedChainIndex(index: number): void {
    if (!this.cascadeState) return;
    this.cascadeState.visitedChainIndexes.add(index);
  }

  clearCascadeState(): void {
    this.cascadeState = null;
    this.suppressNextStartTurn = false;
  }

  getSnapshot(): CascadeState | null {
    if (!this.cascadeState) return null;
    return {
      prompt: this.cascadeState.prompt,
      attemptedAccounts: new Set(this.cascadeState.attemptedAccounts),
      visitedChainIndexes: new Set(this.cascadeState.visitedChainIndexes),
    };
  }
}
