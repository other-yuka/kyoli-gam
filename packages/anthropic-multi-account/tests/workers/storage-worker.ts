import { AccountStore } from "../../src/account-store";
import type { AccountStorage } from "../../src/types";

async function main(): Promise<void> {
  const configDir = process.env.OPENCODE_CONFIG_DIR;
  const rawData = process.argv[2];

  if (!configDir || !rawData) {
    process.exit(1);
  }

  process.env.OPENCODE_CONFIG_DIR = configDir;
  const data = JSON.parse(rawData) as AccountStorage;
  const accountStore = new AccountStore();
  for (const account of data.accounts || []) {
    await accountStore.addAccount(account);
  }
}

try {
  await main();
  process.exit(0);
} catch {
  process.exit(1);
}
