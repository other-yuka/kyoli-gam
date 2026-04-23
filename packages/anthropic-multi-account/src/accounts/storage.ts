import {
  loadAccounts as coreLoadAccounts,
  deduplicateAccounts,
  readStorageFromDisk,
} from "opencode-multi-account-core";
import { ACCOUNTS_FILENAME } from "../shared/constants";
import { getConfigDir } from "../shared/utils";
import { join } from "node:path";
import type { AccountStorage } from "opencode-multi-account-core";

export async function loadAccounts(): Promise<AccountStorage | null> {
  return coreLoadAccounts(join(getConfigDir(), ACCOUNTS_FILENAME));
}

export {
  deduplicateAccounts,
  readStorageFromDisk,
};
