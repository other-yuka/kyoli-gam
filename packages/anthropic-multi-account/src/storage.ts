import { setAccountsFilename } from "opencode-multi-account-core";
import { ACCOUNTS_FILENAME } from "./constants";

setAccountsFilename(ACCOUNTS_FILENAME);

export {
  deduplicateAccounts,
  loadAccounts,
  readStorageFromDisk,
} from "opencode-multi-account-core";
