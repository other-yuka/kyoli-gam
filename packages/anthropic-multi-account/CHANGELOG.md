# opencode-anthropic-multi-account

## 0.2.2

### Patch Changes

- Fix quota status reporting so accounts with refreshed usage (for example, current session back to 0%) are no longer shown as rate-limited from stale reset timestamps.

  Also sync `rateLimitResetAt` with cached usage updates to avoid stale lock state after quota checks.

- Updated dependencies []:
  - opencode-multi-account-core@0.2.2

## 0.2.1

### Patch Changes

- Add Changesets-based release automation with automated versioning, CHANGELOG generation, and npm publishing

- Updated dependencies []:
  - opencode-multi-account-core@0.2.1
