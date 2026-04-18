# opencode-codex-multi-account

## 0.2.20

### Patch Changes

- Updated dependencies []:
  - opencode-multi-account-core@0.2.20

## 0.2.19

### Patch Changes

- Updated dependencies []:
  - opencode-multi-account-core@0.2.19

## 0.2.18

### Patch Changes

- Updated dependencies []:
  - opencode-multi-account-core@0.2.18

## 0.2.17

### Patch Changes

- Updated dependencies []:
  - opencode-multi-account-core@0.2.17

## 0.2.16

### Patch Changes

- Updated dependencies []:
  - opencode-multi-account-core@0.2.16

## 0.2.15

### Patch Changes

- Release the Anthropic OAuth compatibility updates, including the fixed base URL, first-message-seeded tool masking for undocumented flat tools, and outbound tool observation for diagnostics.

- Updated dependencies []:
  - opencode-multi-account-core@0.2.15

## 0.2.14

### Patch Changes

- [`1d23edb`](https://github.com/other-yuka/kyoli-gam/commit/1d23edb8637e9ff63d4f271aa05e67f971a28244) Thanks [@other-yuka](https://github.com/other-yuka)! - Remove shared plugin state that caused load-order collisions across multi-auth providers.

  Provider configs and claims are now isolated by filename, account-manager dependencies are injected per provider, and the Anthropic OAuth flow no longer temporarily overwrites the global fetch handler during login.

- Updated dependencies [[`1d23edb`](https://github.com/other-yuka/kyoli-gam/commit/1d23edb8637e9ff63d4f271aa05e67f971a28244)]:
  - opencode-multi-account-core@0.2.14

## 0.2.13

### Patch Changes

- Updated dependencies []:
  - opencode-multi-account-core@0.2.13

## 0.2.12

### Patch Changes

- [`4980f98`](https://github.com/other-yuka/kyoli-gam/commit/4980f98dc77ccad41b94c776f9de645fc12f789c) Thanks [@other-yuka](https://github.com/other-yuka)! - fix: eliminate global ACCOUNTS_FILENAME singleton to prevent cross-plugin file collision

  When two plugins shared the same `multi-account-core` module instance (e.g. both installed from npm), the last plugin to load would overwrite the global `ACCOUNTS_FILENAME`, causing one plugin to read the other's account storage file. This resulted in 401 errors because tokens from one provider were sent to the other provider's API.

  `AccountStore` now accepts a `filename` parameter via constructor injection, and each plugin subclass passes its own filename. The global `setAccountsFilename` is deprecated.

- Updated dependencies [[`4980f98`](https://github.com/other-yuka/kyoli-gam/commit/4980f98dc77ccad41b94c776f9de645fc12f789c)]:
  - opencode-multi-account-core@0.2.12

## 0.2.11

### Patch Changes

- Updated dependencies [[`72c4692`](https://github.com/other-yuka/kyoli-gam/commit/72c469275ee402e4e977ee0784a0c222cb8c44b5)]:
  - opencode-multi-account-core@0.2.11

## 0.2.10

### Patch Changes

- Updated dependencies [[`f98f557`](https://github.com/other-yuka/kyoli-gam/commit/f98f5577645c6182d028738ce1d0fc62785c6ecb)]:
  - opencode-multi-account-core@0.2.10

## 0.2.9

### Patch Changes

- Updated dependencies []:
  - opencode-multi-account-core@0.2.9

## 0.2.8

### Patch Changes

- ec78b60: fix: switch build toolchain from esbuild to tsup for proper CJS interop

  esbuild was converting `import lockfile from 'proper-lockfile'` to `import * as lockfile` in the published dist, causing `lockfile.lock is not a function` at runtime. tsup handles CJS-to-ESM interop correctly.

- Updated dependencies [ec78b60]
  - opencode-multi-account-core@0.2.8

## 0.2.7

### Patch Changes

- Revert the anthropic oauth alignment change so the published packages match the restored stable behavior.

- Updated dependencies []:
  - opencode-multi-account-core@0.2.7

## 0.2.6

### Patch Changes

- Updated dependencies [[`508d0a7`](https://github.com/other-yuka/kyoli-gam/commit/508d0a705efcfbd5d9ec1a930d23edacdead3421)]:
  - opencode-multi-account-core@0.2.6

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
