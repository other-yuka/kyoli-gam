# opencode-anthropic-multi-account

## 0.2.24

### Patch Changes

- [`47e4aed`](https://github.com/other-yuka/kyoli-gam/commit/47e4aed8df3662724244070160ec128ec7d62412) Thanks [@other-yuka](https://github.com/other-yuka)! - Align Anthropic outbound request wire shape and tests with the current upstream parity defaults so releases preserve compatibility with the latest request format changes.

- Updated dependencies []:
  - opencode-multi-account-core@0.2.24

## 0.2.23

### Patch Changes

- [`9abd84b`](https://github.com/other-yuka/kyoli-gam/commit/9abd84bb863e6f159d2e23a1ccb177d281799051) Thanks [@other-yuka](https://github.com/other-yuka)! - Preserve empty tool results, reject dangling tool calls before upstream fetches, and align sticky and beta request handling with the current Anthropic runtime flow.

- Updated dependencies [[`9abd84b`](https://github.com/other-yuka/kyoli-gam/commit/9abd84bb863e6f159d2e23a1ccb177d281799051)]:
  - opencode-multi-account-core@0.2.23

## 0.2.22

### Patch Changes

- Invalidate stale fingerprint cache entries when bundled or installed Claude versions change, and tighten Anthropic fingerprint/auth maintenance flows.

- Updated dependencies []:
  - opencode-multi-account-core@0.2.22

## 0.2.21

### Patch Changes

- [`f54e9ec`](https://github.com/other-yuka/kyoli-gam/commit/f54e9ec7c373501264f4a269c834b8948114d571) Thanks [@other-yuka](https://github.com/other-yuka)! - Avoid removing accounts immediately on refresh failures and tighten refresh failure classification.

- Updated dependencies []:
  - opencode-multi-account-core@0.2.21

## 0.2.20

### Patch Changes

- [`8e176f2`](https://github.com/other-yuka/kyoli-gam/commit/8e176f2d2b5c3845ab9fc04cb8178bb993f02c69) Thanks [@other-yuka](https://github.com/other-yuka)! - Remove the leaked provider model observer hook from the runtime package.

- Updated dependencies []:
  - opencode-multi-account-core@0.2.20

## 0.2.19

### Patch Changes

- [`cda2e49`](https://github.com/other-yuka/kyoli-gam/commit/cda2e490645c2a5997d315a4859d5ddb2d5bbb39) Thanks [@other-yuka](https://github.com/other-yuka)! - Use provider model capabilities for Anthropic request shaping and tighten request normalization.

- Updated dependencies []:
  - opencode-multi-account-core@0.2.19

## 0.2.18

### Patch Changes

- [`39e5c2d`](https://github.com/other-yuka/kyoli-gam/commit/39e5c2dd41e081abc583b2c2768bb9ae8623c63c) Thanks [@other-yuka](https://github.com/other-yuka)! - Rebuild the Anthropic tool mapping flow to restore request-scoped custom tool masking and response reverse mapping.

- Updated dependencies []:
  - opencode-multi-account-core@0.2.18

## 0.2.17

### Patch Changes

- [`12dd9ea`](https://github.com/other-yuka/kyoli-gam/commit/12dd9ea577529a73cda1eb7711de35408b7340a3) Thanks [@other-yuka](https://github.com/other-yuka)! - Refactor fingerprint maintenance scripts to share the bundled fallback loader.

- Updated dependencies []:
  - opencode-multi-account-core@0.2.17

## 0.2.16

### Patch Changes

- [`21547a8`](https://github.com/other-yuka/kyoli-gam/commit/21547a8b367fbcb6b2885a2705e5dc062988884b) Thanks [@other-yuka](https://github.com/other-yuka)! - Stabilize Anthropic multi-account request fingerprinting, pacing, and CI coverage.

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

- [`e6417f9`](https://github.com/other-yuka/kyoli-gam/commit/e6417f993f679a7d9824891de526caf99c235cbc) Thanks [@other-yuka](https://github.com/other-yuka)! - Refine Anthropic prompt transformation to preserve core injected identity while relocating non-core system guidance into the first user message.

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

- [`f98f557`](https://github.com/other-yuka/kyoli-gam/commit/f98f5577645c6182d028738ce1d0fc62785c6ecb) Thanks [@other-yuka](https://github.com/other-yuka)! - Fix serve and web provider loading by eagerly initializing Anthropic auth state and using ESM-safe proper-lockfile imports.

- Updated dependencies [[`f98f557`](https://github.com/other-yuka/kyoli-gam/commit/f98f5577645c6182d028738ce1d0fc62785c6ecb)]:
  - opencode-multi-account-core@0.2.10

## 0.2.9

### Patch Changes

- [`c95506b`](https://github.com/other-yuka/kyoli-gam/commit/c95506b7af2ca6b58790d735b9da685a4a96c5dc) Thanks [@other-yuka](https://github.com/other-yuka)! - Add model-aware Anthropic beta handling, including Claude 4.6 effort headers and long-context fallback retries.

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

- [`508d0a7`](https://github.com/other-yuka/kyoli-gam/commit/508d0a705efcfbd5d9ec1a930d23edacdead3421) Thanks [@other-yuka](https://github.com/other-yuka)! - Add missing beta flags, move billing header to HTTP transport, add env var overrides for OAuth params, and unify token endpoint source

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
