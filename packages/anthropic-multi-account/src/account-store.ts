import {
  AccountStore,
  setAccountsFilename,
  type DiskCredentials,
} from "@other-yuka/multi-account-core";
import { ACCOUNTS_FILENAME } from "./constants";

setAccountsFilename(ACCOUNTS_FILENAME);

export {
  AccountStore,
  type DiskCredentials,
};
