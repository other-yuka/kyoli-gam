# @kyoli-gam/core

Shared Server Mode primitives for kyoli.

This package owns the SQLite-backed account store, sticky-session store, request-log
store, account selection pool, and account status helpers used by the gateway and CLI.

## What lives here

| Area | Purpose |
|---|---|
| Account store | Persist OAuth credentials and provider metadata locally |
| Sticky sessions | Keep prompt-cache-heavy traffic pinned to an account |
| Request logs | Record provider, route, status, and selected account trace data |
| Account pool | Select ready accounts and skip disabled, rate-limited, and auth-cooldown ones |
| Status helpers | Summarize ready, rate-limited, auth-cooldown, disabled, failed, and reauth-required accounts |

## Used by

- [`@kyoli-gam/cli`](../cli)
- [`@kyoli-gam/gateway`](../gateway)
- provider adapters through the gateway execution path

## Related

- [Root README](../../README.md)
- [`@kyoli-gam/cli`](../cli)
- [`@kyoli-gam/gateway`](../gateway)
