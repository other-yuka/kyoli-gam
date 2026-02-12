const DEFAULT_ACCOUNTS_FILENAME = "multiauth-accounts.json";

export let ACCOUNTS_FILENAME = DEFAULT_ACCOUNTS_FILENAME;

export function setAccountsFilename(filename: string): void {
  if (!filename) {
    ACCOUNTS_FILENAME = DEFAULT_ACCOUNTS_FILENAME;
    return;
  }

  ACCOUNTS_FILENAME = filename;
}
