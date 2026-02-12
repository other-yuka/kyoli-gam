import {
  AccountStore,
  setAccountsFilename,
  type DiskCredentials,
} from "opencode-multi-account-core";
import { ACCOUNTS_FILENAME } from "./constants";

setAccountsFilename(ACCOUNTS_FILENAME);

export {
  AccountStore,
  type DiskCredentials,
};
