import { AnthropicAuthPlugin } from "opencode-anthropic-auth";
import type { PluginInput } from "@opencode-ai/plugin";
import { AccountStore } from "./account-store";
import type { OriginalAuthHook, PluginClient } from "./types";
import { debugLog } from "./utils";

type BaseFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface AccountRuntime {
  fetch: BaseFetch;
}

type ScopedAnthropicAuthPluginInput = {
  client: PluginClient;
} & Record<string, unknown>;

/** Per-account base plugin instances — delegates all auth mechanics to AnthropicAuthPlugin. */
export class AccountRuntimeFactory {
  private runtimes = new Map<string, AccountRuntime>();
  private initLocks = new Map<string, Promise<AccountRuntime>>();

  constructor(
    private readonly pluginCtx: Record<string, unknown>,
    private readonly store: AccountStore,
    private readonly client: PluginClient,
    private readonly provider: unknown,
  ) {}

  async getRuntime(uuid: string): Promise<AccountRuntime> {
    const cached = this.runtimes.get(uuid);
    if (cached) return cached;

    const existing = this.initLocks.get(uuid);
    if (existing) return existing;

    const initPromise = this.createRuntime(uuid);
    this.initLocks.set(uuid, initPromise);

    try {
      const runtime = await initPromise;
      this.runtimes.set(uuid, runtime);
      return runtime;
    } finally {
      this.initLocks.delete(uuid);
    }
  }

  invalidate(uuid: string): void {
    this.runtimes.delete(uuid);
  }

  invalidateAll(): void {
    this.runtimes.clear();
  }

  private async createRuntime(uuid: string): Promise<AccountRuntime> {
    const scopedClient = this.createScopedClient(uuid);

    const scopedCtx: ScopedAnthropicAuthPluginInput = {
      ...this.pluginCtx,
      client: scopedClient,
    };

    const hooks = await AnthropicAuthPlugin(scopedCtx as unknown as PluginInput);
    const auth = (hooks as Record<string, unknown>).auth as OriginalAuthHook;

    if (!auth?.loader) {
      throw new Error(`Base plugin loader unavailable for account ${uuid}`);
    }

    const scopedGetAuth = this.createScopedGetAuth(uuid);
    const result = await auth.loader(scopedGetAuth, this.provider);

    if (!result?.fetch) {
      throw new Error(`Base plugin returned no fetch for account ${uuid}`);
    }

    debugLog(this.client, `Runtime created for account ${uuid.slice(0, 8)}`);
    return { fetch: result.fetch };
  }

  private createScopedGetAuth(uuid: string): () => Promise<{
    type: "oauth";
    refresh: string;
    access: string;
    expires: number;
  }> {
    const store = this.store;

    return async () => {
      const credentials = await store.readCredentials(uuid);
      if (!credentials) {
        return { type: "oauth" as const, refresh: "", access: "", expires: 0 };
      }

      return {
        type: "oauth" as const,
        refresh: credentials.refreshToken,
        access: credentials.accessToken ?? "",
        expires: credentials.expiresAt ?? 0,
      };
    };
  }

  private createScopedClient(uuid: string): PluginClient {
    const store = this.store;
    const originalClient = this.client;

    return {
      auth: {
        async set(params: {
          path: { id: string };
          body: { type: string; refresh: string; access: string; expires: number };
        }): Promise<void> {
          const { body } = params;

          await store.mutateAccount(uuid, (account) => {
            account.accessToken = body.access;
            account.expiresAt = body.expires;
            if (body.refresh) account.refreshToken = body.refresh;
            account.consecutiveAuthFailures = 0;
            account.isAuthDisabled = false;
            account.authDisabledReason = undefined;
          });

          originalClient.auth.set(params).catch(() => {});
        },
      },
      tui: originalClient.tui,
      app: originalClient.app,
    };
  }
}
