import {
  AccountStore as CoreAccountStore,
  type DiskCredentials,
} from "opencode-multi-account-core";
import { ACCOUNTS_FILENAME } from "../shared/constants";

export class AccountStore extends CoreAccountStore {
  constructor() {
    super(ACCOUNTS_FILENAME);
  }
}

export type { DiskCredentials };
