# opencode-multi-account-core

## 0.2.94

## 0.2.93

## 0.2.92

## 0.2.91

## 0.2.90

## 0.2.89

## 0.2.88

## 0.2.87

## 0.2.86

## 0.2.85

## 0.2.84

### Patch Changes

- [#193](https://github.com/other-yuka/kyoli-gam/pull/193) [`67b3b4e`](https://github.com/other-yuka/kyoli-gam/commit/67b3b4efef3426c56b8212b6256e4d5151375393) Thanks [@other-yuka](https://github.com/other-yuka)! - Hide pre-output Codex quota failures and replay the same request with the next available account. Treat model-capacity failures as bounded same-account retries without putting the account into cooldown.

## 0.2.83

## 0.2.82

## 0.2.81

## 0.2.80

## 0.2.79

## 0.2.78

## 0.2.77

## 0.2.76

### Patch Changes

- [#154](https://github.com/other-yuka/kyoli-gam/pull/154) [`5316308`](https://github.com/other-yuka/kyoli-gam/commit/5316308e39370da3bdf473615c70c5acfa104b04) Thanks [@other-yuka](https://github.com/other-yuka)! - Refresh Claude Code 2.1.198 Fable availability and adaptive-thinking request shape.

## 0.2.75

## 0.2.74

## 0.2.73

## 0.2.72

## 0.2.71

## 0.2.70

## 0.2.69

## 0.2.68

## 0.2.67

## 0.2.66

## 0.2.65

## 0.2.64

### Patch Changes

- [#102](https://github.com/other-yuka/kyoli-gam/pull/102) [`3d7669a`](https://github.com/other-yuka/kyoli-gam/commit/3d7669ad95da945d24a83d90d62fbfd22ac82430) Thanks [@other-yuka](https://github.com/other-yuka)! - Share reset-aware quota pacing for account routing so OpenCode plugins and kyoli core use the same canonical selection heuristic.

## 0.2.63

## 0.2.62

### Patch Changes

- [#93](https://github.com/other-yuka/kyoli-gam/pull/93) [`6af8050`](https://github.com/other-yuka/kyoli-gam/commit/6af80508876d22b5c263ecf08ae60554ee18e49d) Thanks [@other-yuka](https://github.com/other-yuka)! - Refresh Claude Code 2.1.178 fingerprints, repair native OAuth scanning, and add safer Claude Code billing-claim/cch handling.

## 0.2.61

## 0.2.60

## 0.2.59

## 0.2.58

## 0.2.57

## 0.2.56

## 0.2.55

### Patch Changes

- [#70](https://github.com/other-yuka/kyoli-gam/pull/70) [`39c26b5`](https://github.com/other-yuka/kyoli-gam/commit/39c26b5b66ac9e91d18752eb489727fbec5d1284) Thanks [@other-yuka](https://github.com/other-yuka)! - Refresh the bundled Claude Code 2.1.173 fingerprint after human-gated template/wire validation and retry hard effort-capability 400s by caching each model's supported effort set.

## 0.2.54

## 0.2.53

## 0.2.52

## 0.2.51

## 0.2.50

### Patch Changes

- [#57](https://github.com/other-yuka/kyoli-gam/pull/57) [`c7a5cf3`](https://github.com/other-yuka/kyoli-gam/commit/c7a5cf3c6188750a04acbfc7292d14db93bb915d) Thanks [@other-yuka](https://github.com/other-yuka)! - Re-bake the bundled Claude Code 2.1.169 fingerprint from the local CLI capture and align doctor drift scrubbing with the baked-template scrubber.

## 0.2.49

## 0.2.48

## 0.2.47

## 0.2.46

## 0.2.45

## 0.2.44

## 0.2.43

## 0.2.42

## 0.2.41

## 0.2.40

## 0.2.39

## 0.2.38

## 0.2.37

## 0.2.36

## 0.2.35

## 0.2.34

## 0.2.33

### Patch Changes

- Improve OAuth account pool operations and release packaging.

## 0.2.32

## 0.2.31

## 0.2.30

## 0.2.29

## 0.2.28

## 0.2.27

## 0.2.26

## 0.2.25

## 0.2.24

## 0.2.23

### Patch Changes

- [`9abd84b`](https://github.com/other-yuka/kyoli-gam/commit/9abd84bb863e6f159d2e23a1ccb177d281799051) Thanks [@other-yuka](https://github.com/other-yuka)! - Preserve empty tool results, reject dangling tool calls before upstream fetches, and align sticky and beta request handling with the current Anthropic runtime flow.

## 0.2.22

### Patch Changes

- Invalidate stale fingerprint cache entries when bundled or installed Claude versions change, and tighten Anthropic fingerprint/auth maintenance flows.

## 0.2.21

## 0.2.20

## 0.2.19

## 0.2.18

## 0.2.17

## 0.2.16

## 0.2.15

### Patch Changes

- Release the Anthropic OAuth compatibility updates, including the fixed base URL, first-message-seeded tool masking for undocumented flat tools, and outbound tool observation for diagnostics.

## 0.2.14

### Patch Changes

- [`1d23edb`](https://github.com/other-yuka/kyoli-gam/commit/1d23edb8637e9ff63d4f271aa05e67f971a28244) Thanks [@other-yuka](https://github.com/other-yuka)! - Remove shared plugin state that caused load-order collisions across multi-auth providers.

  Provider configs and claims are now isolated by filename, account-manager dependencies are injected per provider, and the Anthropic OAuth flow no longer temporarily overwrites the global fetch handler during login.

## 0.2.13

## 0.2.12

### Patch Changes

- [`4980f98`](https://github.com/other-yuka/kyoli-gam/commit/4980f98dc77ccad41b94c776f9de645fc12f789c) Thanks [@other-yuka](https://github.com/other-yuka)! - fix: eliminate global ACCOUNTS_FILENAME singleton to prevent cross-plugin file collision

  When two plugins shared the same `multi-account-core` module instance (e.g. both installed from npm), the last plugin to load would overwrite the global `ACCOUNTS_FILENAME`, causing one plugin to read the other's account storage file. This resulted in 401 errors because tokens from one provider were sent to the other provider's API.

  `AccountStore` now accepts a `filename` parameter via constructor injection, and each plugin subclass passes its own filename. The global `setAccountsFilename` is deprecated.

## 0.2.11

### Patch Changes

- [`72c4692`](https://github.com/other-yuka/kyoli-gam/commit/72c469275ee402e4e977ee0784a0c222cb8c44b5) Thanks [@other-yuka](https://github.com/other-yuka)! - Replace proper-lockfile with a built-in directory lock to avoid serve and web runtime interop issues.

## 0.2.10

### Patch Changes

- [`f98f557`](https://github.com/other-yuka/kyoli-gam/commit/f98f5577645c6182d028738ce1d0fc62785c6ecb) Thanks [@other-yuka](https://github.com/other-yuka)! - Fix serve and web provider loading by eagerly initializing Anthropic auth state and using ESM-safe proper-lockfile imports.

## 0.2.9

## 0.2.8

### Patch Changes

- ec78b60: fix: switch build toolchain from esbuild to tsup for proper CJS interop

  esbuild was converting `import lockfile from 'proper-lockfile'` to `import * as lockfile` in the published dist, causing `lockfile.lock is not a function` at runtime. tsup handles CJS-to-ESM interop correctly.

## 0.2.7

### Patch Changes

- Revert the anthropic oauth alignment change so the published packages match the restored stable behavior.

## 0.2.6

### Patch Changes

- [`508d0a7`](https://github.com/other-yuka/kyoli-gam/commit/508d0a705efcfbd5d9ec1a930d23edacdead3421) Thanks [@other-yuka](https://github.com/other-yuka)! - Add missing beta flags, move billing header to HTTP transport, add env var overrides for OAuth params, and unify token endpoint source

## 0.2.5

### Patch Changes

- [`49305d2`](https://github.com/other-yuka/kyoli-gam/commit/49305d26a65b27943953d69a2c3bf3efbee03382) Thanks [@other-yuka](https://github.com/other-yuka)! - Fix Anthropic multi-auth token refresh handling by proxying token endpoint requests through an external Node process, preserving token lifecycle updates for permanent failures and refresh token rotation. This works around Bun request header behavior documented in oven-sh/bun#17012.

## 0.2.4

### Patch Changes

- [`b4eff3d`](https://github.com/other-yuka/kyoli-gam/commit/b4eff3d144199995a51764bf2549adbce94fb6b1) Thanks [@other-yuka](https://github.com/other-yuka)! - - Complete pi.ai auth flow internally and clean up revoked accounts
  - Refactor executor retry logic: convert outer loop to bounded `for`, centralize response status dispatch, extract 5xx server retry helper, and fix 401 fresh-retry bug where non-401 responses bypassed normal status handling

## 0.2.3

### Patch Changes

- [`6823b0a`](https://github.com/other-yuka/kyoli-gam/commit/6823b0afb730b210937862665f0bdcf25942dce3) Thanks [@other-yuka](https://github.com/other-yuka)! - Always show usage window reset time in status tool regardless of utilization level, and propagate AbortError instead of misclassifying it as a network error in executor

## 0.2.2

### Patch Changes

- Fix quota status reporting so accounts with refreshed usage (for example, current session back to 0%) are no longer shown as rate-limited from stale reset timestamps.

  Also sync `rateLimitResetAt` with cached usage updates to avoid stale lock state after quota checks.

## 0.2.1

### Patch Changes

- Add Changesets-based release automation with automated versioning, CHANGELOG generation, and npm publishing
