# opencode-anthropic-multi-account

OpenCode plugin for multi-account Anthropic (Claude) OAuth management with automatic rate limit switching.

## Install

Add to `opencode.json`:

```jsonc
{
  "plugin": ["opencode-anthropic-multi-account@latest"]
}
```

## Features

- Automatic account rotation on 429 responses
- Three selection strategies: sticky, round-robin, and hybrid
- Cross-process coordination for parallel sessions
- Background token refresh before expiry
- Status tool (`claude_multiauth_status`) for mid-session account overview

## Architecture

```
opencode-anthropic-multi-account  ← you are here
        │
opencode-multi-account-core
```

See the [root README](../../README.md) for full documentation.
