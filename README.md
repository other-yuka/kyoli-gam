<!-- prettier-ignore -->
<div align="center">

# kyoli-gam

Multi-account OAuth plugins for [OpenCode](https://github.com/anomalyco/opencode)

[![CI](https://img.shields.io/github/actions/workflow/status/other-yuka/kyoli-gam/ci.yml?style=flat-square&label=CI)](https://github.com/other-yuka/kyoli-gam/actions)
![Node](https://img.shields.io/badge/Node.js->=20-3c873a?style=flat-square)
[![TypeScript](https://img.shields.io/badge/TypeScript-blue?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)

[Features](#features) • [Packages](#packages) • [Getting started](#getting-started) • [Configuration](#configuration) • [Architecture](#architecture)

</div>

Use multiple OAuth accounts in a single OpenCode session. When one account gets rate-limited, the plugin switches to the next available one automatically.

## Features

- Automatic account rotation on 429 responses
- Three selection strategies: sticky, round-robin, and hybrid
- Cross-process coordination for parallel sessions (subagents) via claim files with zombie detection
- Background token refresh before expiry
- Atomic file writes with locking to prevent corruption
- Circuit breaker that auto-disables failing accounts while keeping at least one active
- TUI menu for managing accounts through `opencode auth login`

## Packages

| Package | Description |
|:--------|:------------|
| [`opencode-anthropic-multi-account`](./packages/opencode-anthropic-multi-account) | OpenCode plugin for multi-account Anthropic (Claude) OAuth |
| [`opencode-codex-multi-account`](./packages/opencode-codex-multi-account) | OpenCode plugin for multi-account OpenAI (ChatGPT Codex) OAuth |
| [`multi-account-core`](./packages/multi-account-core) | Shared core logic: account management, storage, claims, rate limiting, executor |
| [`oauth-adapters`](./packages/oauth-adapters) | Provider-specific OAuth adapter definitions (endpoints, client IDs, plan labels) |

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org) >= 20
- [Bun](https://bun.sh) (build toolchain)
- [OpenCode](https://github.com/anomalyco/opencode) CLI

### Install

Add the plugin to `opencode.json`:

```jsonc
{
  "plugin": [
    "opencode-anthropic-multi-account@latest",
    // and/or
    "opencode-codex-multi-account@latest"
  ]
}
```

### Add accounts

Run `opencode auth login` to open the account management menu. Select **Add new account** to start an OAuth flow. Repeat for each account you want in the pool.

## Configuration

Create `~/.config/opencode/claude-multiauth.json` (Anthropic) or the equivalent for Codex:

```json
{
  "account_selection_strategy": "sticky",
  "cross_process_claims": true,
  "quiet_mode": false,
  "debug": false
}
```

All fields are optional. The values above are the defaults.

### Account selection strategies

| Strategy | How it works | Good for |
|:---------|:-------------|:---------|
| `sticky` (default) | Stays on one account until it gets rate-limited | Prompt cache reuse, single-account setups |
| `round-robin` | Rotates to a different account on every request | 4+ accounts, maximizing throughput |
| `hybrid` | Picks accounts by composite score (see below) | 2-3 accounts, balanced load |

The `hybrid` strategy scores each account on three factors:

- **Usage** -- accounts with lower recent usage (5-hour and 7-day windows) score higher, so the plugin naturally gravitates toward accounts with more remaining quota
- **Health** -- accounts with no recent errors, auth failures, or rate limits score higher. An account that just recovered from a 429 gets a lower health score for a while.
- **Freshness** -- accounts that haven't been used recently score higher. This spreads requests across the pool instead of hammering one account until it breaks.

The account with the highest combined score gets selected for each request.

> [!TIP]
> `sticky` works best if you rely on prompt caching, since switching accounts invalidates the cache. `round-robin` gives higher aggregate throughput but loses cache on every switch.

### Status tool

The Anthropic plugin registers a `claude_multiauth_status` tool you can call mid-session. It shows all accounts with their usage percentages, rate-limit state, and reset times.

```
> claude_multiauth_status
```

## Architecture

```
opencode fetch
  └── Plugin (anthropic / codex)
        ├── migrateFromAuthJson ── imports existing single-account OAuth creds on first use
        ├── AccountManager.create
        │     └── AccountStore.load ── file-locked JSON storage
        └── executeWithAccountRotation (executor)
              ├── selectAccount (AccountManager)
              ├── getRuntime (AccountRuntimeFactory)
              │     └── buildRequestHeaders + transformRequestBody
              ├── fetch → Provider API
              └── on 401/403/429 → rotate account and retry
```

### Package layers

```
┌─────────────────────────────────────────────────┐
│  opencode-anthropic-multi-account / opencode-codex-multi-account  │  Plugin entry points
│  (provider-specific: auth, usage, transforms)   │  ← thin shims + provider logic
├─────────────────────────────────────────────────┤
│            multi-account-core                   │  Shared core (~70% of logic)
│  AccountStore · AccountManager · Executor       │
│  Claims · Storage · RateLimit · ProactiveRefresh│
│  AuthMigration · Config · Utils · UI            │
├─────────────────────────────────────────────────┤
│              oauth-adapters                     │  Provider definitions
│  (endpoints, client IDs, plan labels)           │  ← zero runtime deps
└─────────────────────────────────────────────────┘
```

### Core components

| Component | Package | What it does |
|:----------|:--------|:-------------|
| AccountStore | core | Single write path. Serializes all disk mutations through file locking. |
| AccountManager | core | In-memory account cache and selection strategies. Delegates writes to AccountStore. |
| Executor | core | Retry loop with account rotation on auth and rate-limit failures. |
| Claims | core | Cross-process coordination via claim files with zombie detection. |
| ProactiveRefreshQueue | core | Refreshes tokens in the background before they expire. |
| AuthMigration | core | One-time import of existing single-account OAuth creds from `auth.json`. |
| AccountRuntimeFactory | plugin | Creates per-account fetch runtimes with provider-specific auth headers and request transforms. |

## Development

```bash
bun install
bun run typecheck
bun run test
bun run build
```

> [!NOTE]
> The monorepo uses Bun workspaces with [Turborepo](https://turbo.build) for task orchestration. `turbo.json` defines the dependency graph so builds and typechecks run in topological order. Each package uses a `publishConfig` pattern: `main` points to source (`./src/index.ts`) during development so tests and typechecks resolve source directly, and `publishConfig.main` points to compiled output (`./dist/index.js`) for npm consumers.

## Legal

These plugins are for personal and internal development use. Respect provider quotas and data handling policies.

By using these plugins, you acknowledge that this may violate provider Terms of Service, that providers may suspend or ban accounts, that APIs may change without notice, and that you assume all associated risks.

## Disclaimer

Not affiliated with Anthropic or OpenAI. This is an independent open-source project.

"Claude" and "Anthropic" are trademarks of Anthropic PBC. "ChatGPT" and "OpenAI" are trademarks of OpenAI, Inc.

## Credits

[opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth/) by [@NoeFabris](https://github.com/NoeFabris)
