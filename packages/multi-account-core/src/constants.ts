const DEFAULT_ACCOUNTS_FILENAME = "multiauth-accounts.json";

/**
 * @deprecated Use `new AccountStore(filename)` instead.
 * This global is kept only for backward-compatible test helpers.
 * When two plugins share the same core module instance, mutating
 * this global causes one plugin to read the other's account file.
 */
export let ACCOUNTS_FILENAME = DEFAULT_ACCOUNTS_FILENAME;

/**
 * @deprecated Use `new AccountStore(filename)` instead.
 */
export function setAccountsFilename(filename: string): void {
  if (!filename) {
    ACCOUNTS_FILENAME = DEFAULT_ACCOUNTS_FILENAME;
    return;
  }

  ACCOUNTS_FILENAME = filename;
}
