export class CodexWebSocketResponseOwnerStore {
  private readonly owners = new Map<string, string>();

  constructor(private readonly maxEntries = 4096) {}

  resolve(responseId: string | undefined): string | undefined {
    if (!responseId) return undefined;
    return this.owners.get(responseId);
  }

  remember(responseId: string | undefined, accountId: string | undefined): void {
    if (!responseId || !accountId) return;
    this.owners.delete(responseId);
    this.owners.set(responseId, accountId);
    while (this.owners.size > this.maxEntries) {
      const oldest = this.owners.keys().next().value;
      if (!oldest) break;
      this.owners.delete(oldest);
    }
  }
}
