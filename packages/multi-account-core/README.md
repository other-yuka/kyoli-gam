# multi-account-core

Shared core logic for multi-account OpenCode plugins. This package contains ~70% of the logic used by both [`anthropic-multi-account`](../anthropic-multi-account) and [`codex-multi-account`](../codex-multi-account).

## What's inside

| Module | What it does |
|:-------|:-------------|
| AccountStore | Single write path. Serializes all disk mutations through file locking. |
| AccountManager | In-memory account cache and selection strategies (sticky, round-robin, hybrid). Created via `createAccountManagerForProvider`. |
| Executor | Retry loop with account rotation on auth and rate-limit failures. Created via `createExecutorForProvider`. |
| Claims | Cross-process coordination via claim files with zombie detection. |
| Storage | Atomic file read/write with `proper-lockfile`. |
| RateLimit | Per-account rate-limit tracking with configurable backoff. Created via `createRateLimitTrackerForProvider`. |
| ProactiveRefreshQueue | Background token refresh before expiry. Created via `createProactiveRefreshForProvider`. |
| Config | Plugin configuration loading and validation with valibot. Created via `createConfigLoaderForProvider`. |
| AuthMigration | One-time import of existing single-account OAuth creds from OpenCode's `auth.json`. |
| UI | Terminal UI primitives (ANSI formatting, confirm dialogs, select menus). |
| Utils | Config directory resolution, formatting helpers. |

## Usage

This package is not intended to be used directly. It is a dependency of the provider-specific plugin packages. Each module exposes a factory function that accepts provider-specific config (endpoints, client IDs, plan labels) and returns a ready-to-use instance.

```ts
import { createAccountManagerForProvider } from "opencode-multi-account-core";

export const AccountManager = createAccountManagerForProvider({
  refreshTokenFn: myRefreshToken,
  isTokenExpiredFn: myIsTokenExpired,
});
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│  anthropic-multi-account / codex-multi-account  │
│  (provider-specific: auth, usage, transforms)   │
├─────────────────────────────────────────────────┤
│          multi-account-core  ← you are here     │
│  AccountStore . AccountManager . Executor        │
│  Claims . Storage . RateLimit . ProactiveRefresh │
│  AuthMigration . Config . Utils . UI             │
├─────────────────────────────────────────────────┤
│              oauth-adapters                     │
│  (endpoints, client IDs, plan labels)           │
└─────────────────────────────────────────────────┘
```

## Safety guarantees

- All disk mutations go through AccountStore with file locking
- Atomic writes via temp-file-then-rename
- Concurrent token refresh requests for the same account are deduplicated
- Circuit breaker: an account is only auto-disabled when at least one other remains usable
- Dead process claims are automatically released
