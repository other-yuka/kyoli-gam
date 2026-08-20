import { promises as fs } from "node:fs";
import { createAccountManagerForProvider } from "../../src/account-manager";
import { AccountStore } from "../../src/account-store";
import type { PluginClient, TokenRefreshResult } from "../../src/types";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const [endpoint, accountsFilename, accountUuid, readyPath, startPath] = process.argv.slice(2);
  if (!endpoint || !accountsFilename || !accountUuid || !readyPath || !startPath) {
    throw new Error("Missing OAuth refresh worker arguments");
  }

  const client: PluginClient = {
    auth: { set: async () => {} },
    tui: { showToast: async () => {} },
    app: { log: async () => {} },
  };
  const AccountManager = createAccountManagerForProvider({
    providerAuthId: "test",
    isTokenExpired: () => true,
    refreshToken: async (refreshToken): Promise<TokenRefreshResult> => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) {
        return { ok: false, permanent: response.status >= 400 && response.status < 500 };
      }
      return { ok: true, patch: await response.json() } as TokenRefreshResult;
    },
  });
  const store = new AccountStore(accountsFilename);
  const manager = await AccountManager.create(store, {
    type: "oauth",
    refresh: "",
    access: "",
    expires: 0,
  }, client);
  const initialCredentials = await store.readCredentials(accountUuid);
  if (initialCredentials?.refreshToken !== "refresh-once") {
    throw new Error("Worker did not preload the single-use refresh token");
  }

  await fs.writeFile(readyPath, "ready\n");
  while (true) {
    try {
      await fs.access(startPath);
      break;
    } catch {
      await wait(10);
    }
  }

  const result = await manager.ensureValidToken(accountUuid, client);
  const resolvedUuid = result.ok ? result.patch.uuid ?? accountUuid : accountUuid;
  const credentials = await store.readCredentials(resolvedUuid);

  process.stdout.write(JSON.stringify({ result, credentials, resolvedUuid }));
  process.exitCode = result.ok ? 0 : 2;
}

await main();
