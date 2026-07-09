<!-- prettier-ignore -->
<div align="center">

# kyoli-gam

<p><strong>Use multiple ChatGPT/Codex and Claude Code OAuth accounts from OpenCode, Codex CLI, and OpenAI/Anthropic-compatible clients.</strong></p>

<p>
  A local OAuth account router for coding agents. Kyoli keeps provider names familiar:
  <code>openai/...</code> for Codex and <code>anthropic/...</code> for Claude.
  When one account hits a limit, requests move to the next usable account.
</p>

[![CI](https://img.shields.io/github/actions/workflow/status/other-yuka/kyoli-gam/ci.yml?style=flat-square&label=CI)](https://github.com/other-yuka/kyoli-gam/actions)
![Node](https://img.shields.io/badge/Node.js->=20-3c873a?style=flat-square)
[![TypeScript](https://img.shields.io/badge/TypeScript-blue?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)

[30 seconds](#30-seconds) · [Modes](#modes) · [What it does](#what-it-does) · [Packages](#packages)

</div>

> Kyoli is OAuth-only. It is built for personal/internal development workflows where you
> already have provider subscription accounts and want one local account pool for agent
> traffic. It is independent, unofficial, and not affiliated with OpenAI, Anthropic, or
> OpenCode.

---

## 30 seconds

### Server Mode

Use this when OpenCode, Codex CLI, SDK clients, or a dashboard should share the same
SQLite-backed account pool.

```bash
# 1. Install dependencies for local development
pnpm install

# 2. Add OAuth accounts
pnpm --dir packages/cli login codex
pnpm --dir packages/cli login claude
# For manual/headless sessions:
pnpm --dir packages/cli login codex --manual

# 3. Start the local gateway
pnpm --dir packages/cli serve

# 4. Point clients at kyoli
pnpm --dir packages/cli install codex --dry-run
pnpm --dir packages/cli install codex
pnpm --dir packages/cli install opencode --dry-run
pnpm --dir packages/cli install opencode

# 5. Check the installed paths
pnpm --dir packages/cli doctor codex --e2e
pnpm --dir packages/cli doctor codex --websocket
pnpm --dir packages/cli doctor opencode --run
```

The gateway listens on `http://127.0.0.1:2021` by default. OpenCode keeps using its
built-in provider names: `openai/<codex-model>` and `anthropic/<claude-model>`.
Codex CLI uses a dedicated `model_provider = "kyoli"` entry instead of a global
`chatgpt_base_url` override and enables Codex Responses WebSocket transport.

### OpenCode Plugin Mode

Use this when you only need OpenCode and do not want a kyoli server or background
process. Add the plugins to `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": [
    "opencode-codex-multi-account@latest",
    "opencode-anthropic-multi-account@latest"
  ]
}
```

Then use OpenCode normally:

```bash
opencode auth login
```

OpenCode plugins run inside OpenCode, store accounts under OpenCode's config directory, and
do not launch `kyoli serve`.

---

## Modes

| Mode | Entry point | Account store | Best for |
|---|---|---|---|
| **Server Mode** | `kyoli serve` + `kyoli install codex/opencode` | SQLite under kyoli config | OpenCode, Codex CLI, SDK clients, dashboard |
| **OpenCode Plugin Mode** | `opencode-*-multi-account` plugins | OpenCode plugin JSON files | OpenCode-only, no server/process |

Do not enable both modes for the same provider unless you are intentionally comparing
them. For example, avoid using the Anthropic OpenCode plugin while also routing Anthropic
through `kyoli install opencode`.

---

## What it does

Kyoli sits between coding tools and provider OAuth sessions.

| Client path | Model/provider shape | Kyoli route | Notes |
|---|---|---|---|
| OpenCode built-in OpenAI provider | `openai/gpt-5.3-codex` | `/v1/responses` | Preferred OpenCode server-mode path for Codex |
| Codex CLI | custom `model_provider` | `/backend-api/codex/responses` | Native HTTP + WebSocket Responses path |
| OpenAI-compatible clients | `/v1/responses`, `/v1/chat/completions` | Codex OAuth pool | Chat Completions is a compatibility bridge |
| Anthropic-compatible clients | `/v1/messages`, `/v1/messages/count_tokens` | Claude Code OAuth pool | Live generation is opt-in in server mode |
| OpenCode plugins | OpenCode auth/fetch hooks | Provider APIs directly | No kyoli HTTP server |

Routing is round-robin by default when a new session key is created, then sticky
within that session so prompt-cache-heavy conversations stay on the same account.
When an account is rate-limited, disabled, or needs re-authentication, kyoli can rotate to
another usable account and records the account state for later inspection.

Model metadata comes from provider-owned catalogs with baked fallbacks, so OpenCode
sees only models kyoli can actually route.

---

## Why use it

- **Keep OpenCode familiar.** Codex still looks like `openai/...`; Claude still looks like
  `anthropic/...`.
- **Pool subscription OAuth accounts.** Add multiple ChatGPT/Codex or Claude Code OAuth
  accounts and let kyoli select the usable one.
- **Avoid a server when you only need OpenCode.** OpenCode Plugin Mode keeps the old plugin
  ergonomics: OpenCode loads the plugin, `opencode auth login` adds accounts, no daemon.
- **Use a shared local gateway when you need more clients.** Server Mode lets OpenCode,
  Codex CLI, SDK clients, and future dashboard surfaces share one account pool.
- **Inspect account health locally.** `accounts status` shows ready, rate-limited,
  disabled, reauth-required, and recently failed accounts.
- **Keep Claude Code wire fidelity explicit.** Claude support uses captured Claude Code
  template/header/body behavior and separates local doctor checks from opt-in live
  generation.

---

## Common commands

```bash
# Server
pnpm --dir packages/cli serve
pnpm --dir packages/cli config init

# Add accounts
pnpm --dir packages/cli login codex
pnpm --dir packages/cli login claude
pnpm --dir packages/cli accounts import opencode --dry-run
pnpm --dir packages/cli accounts import opencode
pnpm --dir packages/cli accounts import opencode --sync

# Inspect and recover account state
pnpm --dir packages/cli accounts list
pnpm --dir packages/cli accounts status codex
pnpm --dir packages/cli accounts status claude-code
pnpm --dir packages/cli accounts reset-expired codex

# OpenCode server-mode integration
pnpm --dir packages/cli install opencode --dry-run
pnpm --dir packages/cli install opencode
pnpm --dir packages/cli restore opencode --dry-run

# Doctors
pnpm --dir packages/cli doctor
pnpm --dir packages/cli doctor pool
pnpm --dir packages/cli doctor codex
pnpm --dir packages/cli doctor codex --file
pnpm --dir packages/cli doctor codex --e2e --opencode
pnpm --dir packages/cli doctor codex --e2e --codex-cli
pnpm --dir packages/cli doctor codex --load --requests 8 --concurrency 2
pnpm --dir packages/cli doctor claude --binary
pnpm --dir packages/cli doctor claude --template
pnpm --dir packages/cli doctor claude --wire
pnpm --dir packages/cli doctor claude --smoke
pnpm --dir packages/cli doctor opencode --run
```

Claude full `/v1/messages` generation is disabled by default in Server Mode. The default
smoke check uses the safer `/v1/messages/count_tokens` path:

```bash
pnpm --dir packages/cli doctor claude --smoke
```

OpenCode plugin Claude live generation has a separate opt-in acceptance gate:

```bash
KYOLI_ENABLE_LIVE_OPENCODE_CLAUDE_NATIVE=1 \
KYOLI_CLAUDE_ALLOW_LIVE_MESSAGES=1 \
pnpm --filter opencode-anthropic-multi-account test:live:opencode-claude-native
```

---

## Server Mode

Server Mode is a local HTTP gateway.

```bash
pnpm --dir packages/cli serve
```

Default config:

```json
{
  "host": "127.0.0.1",
  "port": 2021,
  "databasePath": "~/.local/share/kyoli-gam/kyoli.db",
  "accountSelectionStrategy": "round-robin",
  "softQuotaThresholdPercent": 90,
  "planWeights": {
    "max": 3,
    "pro": 2,
    "free": 1
  },
  "usageRefreshIntervalMs": 300000,
  "maxConcurrentRequests": 0,
  "adminToken": "",
  "logLevel": "info"
}
```

Useful checks:

```bash
curl http://127.0.0.1:2021/health
curl http://127.0.0.1:2021/v1/models
curl http://127.0.0.1:2021/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"openai/gpt-5.3-codex","input":"Say smoke-ok","store":false}'
curl http://127.0.0.1:2021/backend-api/files \
  -H 'content-type: application/json' \
  -d '{"file_name":"prompt.txt","file_size":12,"use_case":"codex"}'
```

If binding outside localhost, set `KYOLI_ADMIN_TOKEN` so `/admin/*` routes require
`Authorization: Bearer <token>`.

---

## OpenCode Plugin Mode

OpenCode Plugin Mode is a pure OpenCode plugin path. Use the published
`opencode-codex-multi-account` and `opencode-anthropic-multi-account` packages directly
from OpenCode.

To move OpenCode plugin accounts into Server Mode:

```bash
pnpm --dir packages/cli accounts import opencode --dry-run
pnpm --dir packages/cli accounts import opencode
pnpm --dir packages/cli accounts import opencode --sync
pnpm --dir packages/cli install opencode
```

---

## Packages

| Package | Description |
|---|---|
| [`@kyoli-gam/cli`](./packages/cli) | CLI for login, serve, account management, OpenCode install/restore, doctors |
| [`@kyoli-gam/gateway`](./packages/gateway) | Local HTTP gateway and provider route surface |
| [`@kyoli-gam/core`](./packages/core) | SQLite account store, sticky sessions, request logs, account pool |
| [`@kyoli-gam/provider-codex-chatgpt`](./packages/providers/codex-chatgpt) | ChatGPT/Codex OAuth provider adapter |
| [`@kyoli-gam/provider-claude-code`](./packages/providers/claude-code) | Claude Code OAuth provider adapter |
| [`opencode-codex-multi-account`](./packages/codex-multi-account) | OpenCode plugin for ChatGPT/Codex OAuth |
| [`opencode-anthropic-multi-account`](./packages/anthropic-multi-account) | OpenCode plugin for Claude OAuth |
| [`opencode-multi-account-core`](./packages/multi-account-core) | Shared OpenCode plugin core |

---

## Development

```bash
pnpm install
pnpm run typecheck
pnpm run test
pnpm run test:contract:native
pnpm run build
```

The OpenCode plugin contract gate is no-live:

```bash
pnpm run test:contract:native
```

It covers shared OpenCode plugin helpers plus Codex and Claude OpenCode plugin entry points
without calling ChatGPT/OpenAI or Anthropic.

---

## Trust and limits

| Area | Kyoli behavior |
|---|---|
| Credentials | Stored locally. Tokens are not logged. |
| Network scope | Server binds to `127.0.0.1` by default. |
| Auth model | OAuth-only. No API-key pooling. |
| Server Mode storage | SQLite under kyoli config/data paths. |
| OpenCode Plugin Mode storage | OpenCode plugin account JSON files. |
| Telemetry | None implemented. |
| Live Claude generation | Disabled by default in Server Mode. |

## Legal

These tools are for personal and internal development use. Respect provider quotas and
data handling policies.

By using kyoli-gam, you acknowledge that OAuth account routing may violate provider Terms
of Service, that providers may suspend or ban accounts, that APIs may change without
notice, and that you assume all associated risks.

Not affiliated with Anthropic, OpenAI, or OpenCode.

"Claude" and "Anthropic" are trademarks of Anthropic PBC. "ChatGPT", "Codex", and
"OpenAI" are trademarks of OpenAI, Inc.

