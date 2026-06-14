# @kyoli-gam/provider-claude-code

Claude Code OAuth provider adapter for kyoli Server Mode.

The adapter builds Claude Code-compatible upstream requests from stored OAuth accounts.
Live `/v1/messages` generation is disabled by default; safer count-tokens smoke checks
remain available.

## OAuth

Claude Code OAuth settings resolve in this order:

1. `KYOLI_CLAUDE_OAUTH_*` environment overrides
2. locally installed `claude` binary scan, cached by binary hash
3. bundled fallback values

Useful overrides:

```bash
KYOLI_CLAUDE_CODE_PATH=/path/to/claude
KYOLI_CLAUDE_OAUTH_CLIENT_ID=...
KYOLI_CLAUDE_OAUTH_AUTHORIZE_URL=...
KYOLI_CLAUDE_OAUTH_TOKEN_URL=...
KYOLI_CLAUDE_OAUTH_SCOPES=...
KYOLI_CLAUDE_API_BASE_URL=...
```

Account setup:

```bash
kyoli login claude
kyoli accounts status claude-code
```

## Request fidelity

The provider reconstructs the Claude Code request shape:

- Claude Code-style headers and OAuth beta flags;
- stable session IDs;
- `metadata.user_id` with account/device/session identity;
- Claude Code system/template fields;
- bundled Claude Code tool template when the caller sends no tools;
- tool-name masking and reverse mapping for custom tool names;
- beta rejection retry and long-context fallback retry.

Run the Claude doctor commands below to verify the local Claude Code binary, bundled
template, and outbound wire shape.

## Live controls

```bash
KYOLI_CLAUDE_ALLOW_LIVE_MESSAGES=1
KYOLI_CLAUDE_PACE_MIN_MS=500
KYOLI_CLAUDE_PACE_JITTER_MS=250
KYOLI_CLAUDE_SESSION_IDLE_MS=900000
KYOLI_CLAUDE_SESSION_JITTER_MS=30000
KYOLI_CLAUDE_SESSION_MAX_AGE_MS=3600000
KYOLI_CLAUDE_DRAIN_ON_CANCEL=1
KYOLI_CLAUDE_DRAIN_TIMEOUT_MS=300000
```

Full `/v1/messages` generation is gated by `KYOLI_CLAUDE_ALLOW_LIVE_MESSAGES=1`.
The default smoke check uses `/v1/messages/count_tokens`:

```bash
kyoli doctor claude --smoke
```

## Checks

```bash
kyoli doctor claude --binary
kyoli doctor claude
kyoli doctor claude --template
kyoli doctor claude --wire
kyoli doctor claude --obedience
kyoli doctor claude --smoke
```

## Related

- [Root README](../../../README.md)
- [`@kyoli-gam/gateway`](../../gateway)
- [`opencode-anthropic-multi-account`](../../anthropic-multi-account)
