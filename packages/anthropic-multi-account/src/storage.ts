import { setAccountsFilename } from "@other-yuka/multi-account-core";
import { ACCOUNTS_FILENAME } from "./constants";

setAccountsFilename(ACCOUNTS_FILENAME);

export {
  deduplicateAccounts,
  loadAccounts,
  readStorageFromDisk,
} from "@other-yuka/multi-account-core";
