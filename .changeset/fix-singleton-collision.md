---
"opencode-multi-account-core": patch
"opencode-anthropic-multi-account": patch
"opencode-codex-multi-account": patch
---

fix: eliminate global ACCOUNTS_FILENAME singleton to prevent cross-plugin file collision

When two plugins shared the same `multi-account-core` module instance (e.g. both installed from npm), the last plugin to load would overwrite the global `ACCOUNTS_FILENAME`, causing one plugin to read the other's account storage file. This resulted in 401 errors because tokens from one provider were sent to the other provider's API.

`AccountStore` now accepts a `filename` parameter via constructor injection, and each plugin subclass passes its own filename. The global `setAccountsFilename` is deprecated.
