# opencode-codex-multi-account

OpenCode plugin for multi-account OpenAI (ChatGPT Codex) OAuth management with automatic rate limit switching.

## Install

Add to `opencode.json`:

```jsonc
{
  "plugin": ["opencode-codex-multi-account@latest"]
}
```

## Features

- Automatic account rotation on 429 responses
- Three selection strategies: sticky, round-robin, and hybrid
- Cross-process coordination for parallel sessions
- Background token refresh before expiry
- Browser OAuth (PKCE) and Device Code authentication flows

## Architecture

```
opencode-codex-multi-account  ← you are here
        │
opencode-multi-account-core
```

See the [root README](../../README.md) for full documentation.
