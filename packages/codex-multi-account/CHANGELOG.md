# opencode-codex-multi-account

## 0.2.5

### Patch Changes

- [`49305d2`](https://github.com/other-yuka/kyoli-gam/commit/49305d26a65b27943953d69a2c3bf3efbee03382) Thanks [@other-yuka](https://github.com/other-yuka)! - Fix Anthropic multi-auth token refresh handling by proxying token endpoint requests through an external Node process, preserving token lifecycle updates for permanent failures and refresh token rotation. This works around Bun request header behavior documented in oven-sh/bun#17012.

- Updated dependencies [[`49305d2`](https://github.com/other-yuka/kyoli-gam/commit/49305d26a65b27943953d69a2c3bf3efbee03382)]:
  - opencode-multi-account-core@0.2.5

## 0.2.4

### Patch Changes

- [`b4eff3d`](https://github.com/other-yuka/kyoli-gam/commit/b4eff3d144199995a51764bf2549adbce94fb6b1) Thanks [@other-yuka](https://github.com/other-yuka)! - - Complete pi.ai auth flow internally and clean up revoked accounts
  - Refactor executor retry logic: convert outer loop to bounded `for`, centralize response status dispatch, extract 5xx server retry helper, and fix 401 fresh-retry bug where non-401 responses bypassed normal status handling
- Updated dependencies [[`b4eff3d`](https://github.com/other-yuka/kyoli-gam/commit/b4eff3d144199995a51764bf2549adbce94fb6b1)]:
  - opencode-multi-account-core@0.2.4

## 0.2.3

### Patch Changes

- [`6823b0a`](https://github.com/other-yuka/kyoli-gam/commit/6823b0afb730b210937862665f0bdcf25942dce3) Thanks [@other-yuka](https://github.com/other-yuka)! - Always show usage window reset time in status tool regardless of utilization level, and propagate AbortError instead of misclassifying it as a network error in executor

- Updated dependencies [[`6823b0a`](https://github.com/other-yuka/kyoli-gam/commit/6823b0afb730b210937862665f0bdcf25942dce3)]:
  - opencode-multi-account-core@0.2.3

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
