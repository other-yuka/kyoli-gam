# @kyoli-gam/cli

CLI for kyoli Server Mode: login, serve, account management, OpenCode install/restore,
and doctor checks.

For the product overview, start at the root [README](../../README.md). For no-server
OpenCode usage, see [OpenCode Plugin Usage](../../docs/opencode-plugin-usage.md).
For end-to-end setup and operation flows, see [Workflows](../../docs/workflows.md).

## 30 seconds

```bash
kyoli login codex [--manual|--headless|--no-browser]
kyoli login claude [--manual|--headless|--no-browser]
kyoli serve
kyoli install opencode --dry-run
kyoli install opencode
kyoli doctor opencode --run
```

The server defaults to `http://127.0.0.1:2021`.

## Modes

| Mode | CLI role |
|---|---|
| Server Mode | `kyoli serve` runs the local gateway and uses the SQLite account store. |
| OpenCode Plugin Mode | No server. Install `opencode-codex-multi-account` / `opencode-anthropic-multi-account` in OpenCode instead. |

`kyoli install opencode` is only for Server Mode. It patches OpenCode's built-in
`openai` and `anthropic` providers to point at the local kyoli gateway. It creates a
backup before writing.

## Commands

### Server

```bash
kyoli serve [--port 2021] [--config ~/.config/kyoli-gam/config.json]
kyoli config path
kyoli config show
kyoli config default
kyoli config init [--force]
```

### Accounts

```bash
kyoli login codex [--manual|--headless|--no-browser]
kyoli login claude [--manual|--headless|--no-browser]

kyoli accounts list [codex|claude-code]
kyoli accounts status [codex|claude-code] [--json]
kyoli accounts show <id>
kyoli accounts enable <id>
kyoli accounts disable <id>
kyoli accounts pause <id>
kyoli accounts reactivate <id>
kyoli accounts delete <id>
kyoli accounts refresh <id>
kyoli accounts reset <id> [--enable]
kyoli accounts reset-expired [codex|claude-code] [--enable]
kyoli accounts import opencode [--dry-run] [--sync] [--provider all|codex|claude-code] [--config-dir ~/.config/opencode]
```

`accounts status` summarizes ready, rate-limited, auth-cooldown, disabled,
reauth-required, expired rate-limit, and failed account state. Use `--json` for
scripts or dashboards.

`accounts import opencode` copies enabled OAuth accounts from OpenCode plugin account
files into the Server Mode SQLite store. Run it with `--dry-run` first.
Use `--sync` to refresh existing imported credentials and metadata from OpenCode.

`login` opens the browser by default and always prints the fallback URL. Use
`--manual`, `--headless`, `--no-browser`, or `KYOLI_OAUTH_BROWSER=manual` when a
browser should not be launched automatically.

### OpenCode Server Mode

```bash
kyoli install opencode [--dry-run] [--force] [--no-models] [--all-models] [--preserve-openai] [--config-dir ~/.config/opencode] [--json]
kyoli restore opencode [--backup <path>] [--dry-run] [--config-dir ~/.config/opencode] [--json]
kyoli doctor opencode [--run] [--config-dir ~/.config/opencode] [--json]
```

`install opencode` keeps familiar provider names:

- Codex models stay under `openai/...`;
- Claude models stay under `anthropic/...`.

Model definitions come from the running kyoli server's `/v1/models` when available, with
a local registry fallback when the server is offline.

### Doctors

```bash
kyoli doctor [--json]
kyoli doctor pool [--json]
kyoli doctor codex [--route /backend-api/codex/responses|/v1/responses|/v1/chat/completions] [--model openai/<model>] [--file|--e2e|--load] [--json]
kyoli doctor claude [--binary|--template|--wire|--smoke] [--json]
kyoli doctor opencode [--run] [--config-dir ~/.config/opencode] [--json]
```

Recommended order before real Codex/OpenCode use:

```bash
kyoli doctor codex
kyoli doctor codex --file
kyoli doctor codex --e2e --opencode
kyoli doctor opencode --run
```

Recommended Claude order:

```bash
kyoli doctor claude --binary
kyoli doctor claude
kyoli doctor claude --template
kyoli doctor claude --wire
kyoli doctor claude --smoke
```

`doctor claude --smoke` uses the safer count-tokens route by default. Live Claude
generation remains opt-in with `KYOLI_CLAUDE_ALLOW_LIVE_MESSAGES=1`.

## Configuration

The CLI reads `~/.config/kyoli-gam/config.json` by default. Override it with
`--config` or `KYOLI_CONFIG_PATH`.

```json
{
  "host": "127.0.0.1",
  "port": 2021,
  "databasePath": "~/.local/share/kyoli-gam/kyoli.db",
  "accountSelectionStrategy": "weighted",
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

Common environment overrides:

```bash
KYOLI_CONFIG_PATH=~/.config/kyoli-gam/config.json
KYOLI_HOST=127.0.0.1
KYOLI_PORT=2021
KYOLI_ACCOUNT_SELECTION_STRATEGY=sticky|round-robin|weighted
KYOLI_SOFT_QUOTA_THRESHOLD_PERCENT=90
KYOLI_PLAN_WEIGHTS=max=3,pro=2,free=1
KYOLI_USAGE_REFRESH_INTERVAL_MS=300000
KYOLI_MAX_CONCURRENT_REQUESTS=0
KYOLI_ADMIN_TOKEN=change-me
KYOLI_LOG_LEVEL=silent|info|debug
KYOLI_CLAUDE_CODE_PATH=/path/to/claude
KYOLI_CLAUDE_ALLOW_LIVE_MESSAGES=0
```

Set `KYOLI_ADMIN_TOKEN` before binding outside localhost so `/admin/*` routes require a
bearer token.

## Docs

- [Workflows](../../docs/workflows.md)
- [Server mode operations](../../docs/server-mode-operations.md)
- [OpenCode Plugin Usage](../../docs/opencode-plugin-usage.md)
- [Codex compatibility matrix](../../docs/codex-compatibility.md)
- [Codex release checklist](../../docs/codex-release-checklist.md)
- [Claude Code compatibility](../../docs/claude-code-compatibility.md)
