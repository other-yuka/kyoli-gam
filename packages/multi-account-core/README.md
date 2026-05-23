# opencode-multi-account-core

Shared core for kyoli OpenCode Plugin Mode.

This package is not a user-facing plugin. It is used by:

- [`opencode-codex-multi-account`](../codex-multi-account)
- [`opencode-anthropic-multi-account`](../anthropic-multi-account)

The npm package name remains `opencode-multi-account-core` for compatibility.

## What lives here

| Module | Purpose |
|---|---|
| `AccountStore` | File-locked account JSON storage |
| `AccountManager` | Account cache, selection, state mutation |
| `Executor` | Retry loop and account rotation |
| `Claims` | Cross-process account claims |
| `ProactiveRefreshQueue` | Background token refresh |
| `NativePluginLifecycle` | OpenCode loader/runtime/refresh wiring |
| `NativePluginAuth` | Shared OAuth method builder |
| `NativePluginLoader` | Shared `getAuth -> lifecycle.load -> hooks` flow |
| `NativePluginBootstrapAuth` | Stored-account to OpenCode `auth.json` sync helper |

Provider wire behavior stays in the provider packages. Server Mode behavior stays in
`@kyoli-gam/core`, `@kyoli-gam/gateway`, and `@kyoli-gam/cli`.

## Safety

- Disk writes go through file locks.
- Writes are atomic temp-file-and-rename operations.
- Concurrent refreshes for the same account are deduplicated.
- Claim-file writes are serialized.
- Accounts are only auto-disabled when another usable account remains.
- Dead process claims are released automatically.

## Checks

```bash
pnpm --filter opencode-multi-account-core test:contract:native
pnpm --filter opencode-multi-account-core typecheck
pnpm --filter opencode-multi-account-core test
```

Root no-live plugin gate:

```bash
pnpm run test:contract:native
```

## Related

- [Root README](../../README.md)
- [`opencode-codex-multi-account`](../codex-multi-account)
- [`opencode-anthropic-multi-account`](../anthropic-multi-account)
